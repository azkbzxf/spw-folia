# 播放页透明窗口（色键机制）

> 插件 v0.4.17。本文说明「播放页透明背景」在宿主窗口里**怎么实现、怎么用、会失效在哪**。
> 页面侧控件与设置链路见 [`docs/settings-ui-impl.md`](settings-ui-impl.md)；宿主整体见
> [`docs/host-app.md`](host-app.md)。

透明由**两层**组成：页面侧 `config.background.transparent=true`（Folia 渲染器不再画背景，文档底色本来就是
透明），宿主侧把 WinForms 窗口做成**色键透明**（`BackColor` = 键色 + `LWA_COLORKEY` +
`WebView2.DefaultBackgroundColor = Color.Transparent`）。色键是 Windows 上 windowed WebView2 唯一不需要改写为
composition hosting 的真实桌面透出方案。

---

## 1. 开启方式

| 入口 | 位置 | 说明 |
|---|---|---|
| 页面开关 | 播放页右下角圆钮 → 面板「播放页透明背景」 | 同面板还有「鼠标穿透（操作桌面）」与「显示播放条」；透明关闭时穿透行不出现 |
| SPW 快捷键 | 「快捷键管理」两条动作：`播放页透明背景：开 / 关`（默认 **Ctrl+Alt+G**）、`播放页透明背景 + 鼠标穿透：开 / 关`（默认 **Ctrl+Alt+Shift+G**） | 只在改设置树 + 推 `{"t":"settings"}`，真正套色键的是宿主；要在 Folia 窗口聚焦时也生效，需在 SPW 里打开该动作的「全局」开关 |
| 宿主全局热键 | **Ctrl+Alt+B**（备选 Ctrl+Alt+Y → Ctrl+Alt+P → Ctrl+Alt+Shift+B） | **双向切换**透明，是色键窗口吞掉鼠标后的键盘逃生口 |

- 圆钮 `.spw-chrome-btn--player` 在 `right:32px; bottom:56px`（40×40，避开全屏时自动隐藏的任务栏触发条）；
  面板 `.spw-player-bg-panel` 在 `right:32px; bottom:108px`（宽 300）。透明时两个 chrome（圆钮 + 右上角齿轮）
  **常驻**，不参与 2.5 s 闲置淡出。
- 设置链路：开关 → `setTransparentPlayerBackground()` → `SettingsSnapshot.transparentPlayerBackground` →
  `ConfigPublisher` 推给宿主 → 宿主立刻套色键（**不必等插件回环**），同时转发插件持久化；页面从同一份设置
  树重建 `background.transparent`。宿主在构造函数（`--dev-settings` 之后）、stdin `settings`、页面
  `{"type":"settings"}` 三处调 `ApplyTransparencyFromSettings()`，所以上次开着透明的话窗口**第一帧就是透明的**。
- 退出：两条通道最终都走 `ExitTransparentMode(source)` → `SetTransparency(false)` →
  `ExecuteScriptAsync("window.__spwFoliaSetTransparent(false)")`，把页面开关与持久化一起拉回 `false`，并把
  `mousePassthrough` 复位为 `false`（避免下次进透明还停在穿透态）。

---

## 2. 宿主实现（`poc/webview/host/HostForm.cs`）

```csharp
static readonly Color TransparencyKeyColor = Color.FromArgb(1, 0, 1);   // 近黑，不是纯黑也不是洋红

// on
SetWindowLongPtr(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED);
SetLayeredWindowAttributes(hwnd, ColorTranslator.ToWin32(TransparencyKeyColor), 255, LWA_COLORKEY);
BackColor = TransparencyKeyColor;
webView.DefaultBackgroundColor = Color.Transparent;
// off
BackColor = Color.Black;
SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
webView.DefaultBackgroundColor = Color.Black;
```

- 键色**直接走分层窗口 API**（不是 WinForms 的 `TransparencyKey` 属性）：后者切一次会 `UpdateStyles()`、可能重建
  窗口句柄，新句柄在第一帧会先把 `BackColor` 画出来——那就是用户见过的「开窗粉色一闪」。开的时候先装键再
  设 `BackColor`，关的时候先刷黑再撤键，任何一帧都不会把键色当不透明表面呈现。
- 键色选 `rgb(1,0,1)`：`LWA_COLORKEY` 只抠**精确等于**键色的像素，而 `0 < alpha < 1` 的页面像素会被合成到
  `BackColor` 上、不再是精确匹配，于是留在屏幕上并被键色染色。键色唯一的要求是「页面永不绘制它」，所以换成
  近黑之后同样这些半透明像素只是被压暗成中性灰，而不是粉雾（早期洋红 `rgb(255,0,255)` 会把 50% 白字形边缘
  变成 `rgb(255,128,255)`）。不选纯黑是因为 `Color.Black` 同时是不透明会话的 `BackColor` 与页面基色；
  `rgb(1,0,1)` 绿通道为 0、明度极低，Folia 调色板混不出来。
- 状态机：`transparencyActive`（窗口实际状态）与 `transparencyTarget`（页面开关的意图）**必须分开**且都由
  `SetTransparency()` 收尾时对齐；`ApplyTransparencyFromSettings()` 只在 `on != transparencyActive` 时才真正切
  窗口。用 `on == transparencyTarget` 提前 return 会导致「热键退出后页面开关还亮着，再点开关无效」。
- 窗口仍是 borderless topmost 全屏 Form，几何/DPI/鼠标 idle 逻辑不变；ESC 仍可关窗。

### 2.1 鼠标：`TransparencyInputCatcher` + 窗口区域

色键窗口**整块不可点**——WebView2 内容走独立合成面，宿主窗口自身整片是键色，点击会落到下面的窗口（连金色
圆钮的不透明像素也一样）。补回来的办法是一个不可见的输入捕获窗口：

- `TransparencyInputCatcher : Form`，`WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，
  `SetLayeredWindowAttributes(alpha = 1/255)`（肉眼不可见但仍参与命中测试）。几何跟随主窗口
  （`ApplyInputCatcherBounds()` + 每个 tick `SyncInputCatcherBounds()`）。
- **命中测试就是窗口区域**：页面把自己的交互矩形报给宿主（`{"type":"hitbox", vw, vh, rects:[{x,y,w,h}]}`，
  CSS 像素），宿主按 `ClientSize / hitViewport` 换算成窗口像素、四周放大 ±4 CSS px 容差，`CreateRectRgn` +
  `CombineRgn(RGN_OR)` 后 `SetWindowRgn`。区域之外的输入在 OS 命中测试层**直接穿给下层窗口**——点击、右键、
  滚轮、悬停、拖拽全部真实穿透，没有合成输入（提权窗口/反作弊场景同样可用）。
- 区域内到达的消息由 `WndProc` 无条件转发：把客户坐标换屏幕坐标后 `ScreenToClient(WebView2 输入子窗口)`，
  `SendMessage` 投给 `Chrome_WidgetWin_1`（退路 `Chrome_RenderWidgetHostHWND`）。滚轮例外：
  `WM_MOUSEWHEEL` 的 `lParam` 已是屏幕坐标、delta 在 `WPARAM` 里，原样投递。
- **fail-open**：`mousePassthrough` 关闭、页面未上报矩形或 viewport 非法时区域置空（整窗可点）——
  宁可多点到页面，也不吞掉用户的点击。
- **拖拽连续性**：热区内按下任一鼠标键即把区域临时扩展为整窗（`catcherDragActive`），全部按键抬起后恢复；
  若 button-up 被 WebView2 吃掉，下一次移动用 `GetAsyncKeyState` 自愈，区域不会永久保持整窗。
- 区域重建时机：hitbox 更新、bounds 变化、穿透开关、句柄重建（`OnHandleCreated`）。
- **参数窄化陷阱**：x64 .NET Framework 上 `IntPtr.ToInt32()` 是**带溢出检查**的窄化转换，而 Win32 把消息参数
  零扩展投递——`WM_MOUSEWHEEL` 滚轮向下时低 dword 的 bit31 为 1，`ToInt32()` 会抛 `OverflowException` 直接弹
  「应用程序中发生了未经处理的异常」。参数一律走 `unchecked((int)m.WParam.ToInt64())` /
  `unchecked((int)m.LParam.ToInt64())`，`MakeLParam` 两个半字都 `& 0xFFFF`。

### 2.2 chrome 在透明时仍可用的原因

两条独立的补救叠在一起，缺一不可：

1. **输入**：捕获窗口的窗口区域把热区内的鼠标重新送回 WebView2（§2.1）。
2. **绘制**：`backdrop-filter` 图层在色键合成下**不绘制**（页面表面有、屏幕上没有）。透明时给 chrome 与面板加
   `data-flat='true'`，CSS 里 `backdrop-filter: none`（`.spw-chrome-btn[data-flat='true']`、
   `.spw-player-bg[data-flat='true'] …`、播放条同类规则）。视觉上少一层模糊，可读性不受影响。

页面侧上报的热区（`App.tsx` 的 `reportHitRegions()`）覆盖：齿轮 `[data-spw-chrome="settings"]`、金色圆钮
`[data-spw-chrome="player-background"]`、打开的面板 `[data-spw-chrome="player-background-panel"][data-open="true"]`、
「出现问题」按钮及其面板、以及整页设置覆盖层 `[data-spw-settings-overlay="true"]`。上报时机是立即一次 +
120 ms 后一次 + `resize` 监听 + 状态变化时重发。

---

## 3. 样式兼容层（`poc/settings-ui/src/model/transparencyCompat.ts`）

色键的物理限制是：页面画出的每个 alpha < 1 的像素都会被混上键色。Folia 的 17 种样式里，有的去掉背景层后只剩
不透明字形/线稿（可直接用），有的自带大面积半透明底板（必须临时精简）。分类与处置：

| 分类 | 样式 | 处置 |
|---|---|---|
| `native` | sonnet、classic、cadenza、partita、fume、tilt、claddagh、cappella、diorama | 原样可用 |
| `tuned` | tempera、lumiere（暗色）、pendolo、still、hanabi | 透明期间给**发布的** `visualizerTunings` 合并覆盖，见下表 |
| `unsupported` | monet（人像底板就是样式本体）、lumiere（**浅色主题**，暗场有 94% alpha 下限）、machi、nebbia（整屏 three.js / WebGL 场景，无 tuning 可拆） | 选中即自动关闭透明背景并回写设置、面板提示；透明状态下热键也拒绝开启 |

| 样式 | 透明期间的 tuning 覆盖 |
|---|---|
| `tempera` | `showBlocks:false`、`showDecor:false`、`showCornerMarks:false`、`enableTransitions:false`、`postProcessGrain:0`、`postProcessVignette:0`、`postProcessLensDistortion:0`、`layerImageFrequency:0`；**且不发布** `song/songArtist/songAlbum`（`suppressesClosingPoster`：片尾海报由歌曲元数据构建，元数据不发布海报就不建） |
| `lumiere`（暗色） | `{ darkField: 0, textOnly: true }` |
| `pendolo` | `{ showCenterGradient: false }` |
| `hanabi` | `{ sky: 0, collage: 0 }`（两个全幅图层各自的 tuning 开关；不设 `textOnly`，因为那会连烟花与氛围尘一起关掉） |
| `still` | 无 tuning 开关，用作用域 CSS 隐藏其 radial-gradient 底板：`html[data-spw-transparent='true'] .visualizer-still div[class*='bg-[radial-gradient']`（页面在透明时给根节点写 `data-spw-transparent`） |

覆盖只写进发布的配置（`buildTuningBundle(settings, { transparent })`），**从不写回设置存储**，所以关掉透明后
用户原来的 tuning 立刻回来。`tempera` 的覆盖由 `temperaSceneFrame.ts` 的 `requiresSceneRebuild` 当成真正的
场景参数变化处理，切换透明时立刻重建、关掉后立刻还原。

---

## 4. 调试与验证

宿主开关（都是诊断/回归用）：

- `--no-transparency`：强制不透明，忽略设置里的透明位（连同 `mousePassthrough` 一起关）。
- `--no-colour-key`（`--no-color-key` 亦可，环境变量 `SPW_FOLIA_COLOUR_KEY=0`）：窗口保持普通不透明黑色表面，
  不装键、不设 `BackColor`、不切 `DefaultBackgroundColor`，**并把页面侧透明也降级为不透明**（否则页面会在纯黑
  上开洞）。热键与 `EnterTransparentMode` 在该模式下直接跳过。**任何截图/缩略图/布局校验都必须带它**：色键
  活着时每个半透明页面像素都被键色染色，抓出来的图不是页面真正画的东西。
- 日志：`transparency mode=on|off`（键被调试开关关掉时追加 `colour-key=off reason=debug-flag`）、
  `transparency hotkey=registered|failed`、`transparency enter|exit source=…`、
  `transparency passthrough=on|off rects=N`、`transparency mouse=catcher shown|raised bounds=…`、
  `window-drag start bounds=…`。

验证脚本：

```bash
node poc/settings-ui/scripts/verify-colour-key.mjs   # 真实宿主 + GDI 全屏截图，三段
```

> v0.4.18：`verify-transparent-hud.mjs` 与 `verify-mouse-back.mjs` 已删除。透明窗口下的播放条
> hover 与侧键返回自 v0.3.0 起未再改动，而 `verify-layout.mjs`（打包件真机）与
> `verify-click-zones.mjs`（窗口级指针行为）覆盖了同一批风险。需要回看时从 Git 历史取回。

`verify-colour-key.mjs` 三个 run：**run 1** 键生效（透明会话里 50%-alpha 像素应是 ~128 中性灰、整帧 magenta 族
占比 0、窗口底色是近黑键值）；**run 2** `--no-colour-key`（日志报 `colour-key=off`、窗口底色纯黑、无粉色）；
**run 3** 页面本身永不绘制键色（六种真实样式 3200×2000 全屏，用 `CapturePreviewAsync` 取页面表面，避开窗口
底色干扰）。**截图不能用 `CapturePreviewAsync` 查窗口底色**——它只抓 WebView2 表面，这正是早期截图检查漏掉
键色染色 bug 的原因，必须用 GDI 全屏截图。

---

## 5. 已知限制

- **键色是近黑 `rgb(1,0,1)`**：页面若恰好绘制该像素会被挖空。六种真实样式（sonnet/tempera/lumiere/classic/
  monet/claddagh，3200×2000 全屏）实测精确命中 0 像素，属可接受风险；新增样式要复核就跑
  `verify-colour-key.mjs` 的 run 3。
- **不是 OBS 的 alpha 源**：透明就是「透到桌面/其它窗口」；OBS 场景请直接用 Folia 的浏览器源，或用窗口捕获。
- **全屏**：窗口跟随承载 SPW 的显示器（不是系统主屏），Alt+左键可拖到别的显示器并在松开时重新全屏。
- **默认会吞鼠标**：透明模式靠捕获窗口转发鼠标；要操作下层窗口需打开面板里的「鼠标穿透（操作桌面）」，或按
  Ctrl+Alt+B / ESC 退出透明。打开穿透后只有热区（右下角圆钮、右上角齿轮及其面板/设置页）可点，其余位置的
  点击/右键/滚轮/悬停/拖拽由系统直接落向下层窗口。
- **热区来自页面上报**：上报缺失或解析失败时退化为整窗可点（fail-open）；按住拖拽期间热区临时扩展为整窗，
  松开即恢复。
- **`backdrop-filter` 退化**：透明时 chrome/面板/播放条改用平面底色（§2.2），控件仍可点。
- **样式限制**：`monet`、浅色主题的 `lumiere`、`machi`、`nebbia` 不可用（§3）；`tempera`/`lumiere`(暗色)/
  `pendolo`/`still`/`hanabi` 在透明期间会自动精简，画面与不透明时略有差异——`tempera` 只剩逐字歌词与线框，
  不再有整屏纸面与片尾海报。
