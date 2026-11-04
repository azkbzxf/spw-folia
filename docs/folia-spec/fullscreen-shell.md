# 全屏播放页：图层、chrome 与交互

Folia 模式的窗口里只有**一屏歌词**：Folia 的 OBS 浏览器源页面铺满无边框窗口，插件在它上面注入自己的
chrome（齿轮、返回、播放条、右下菜单、诊断面板）和设置窗口。本文说明这些东西各自在哪一层、谁画、怎么交互。

- 宿主窗口：`poc/webview/host/HostForm.cs`（WinForms + WebView2）
- 页面：Folia 的 `index.html?obs=1`（`ObsBrowserSourceApp` 挂 `VisualizerRenderer`），由 `Shim.js` 驱动
- 插件 chrome 与设置窗口：`poc/settings-ui/src/App.tsx` + `app.css`
- 渲染层内部结构：[`runtime-contracts.md`](runtime-contracts.md) §6；协议：[`protocol.md`](../protocol.md)

## 1. 为什么不是「Folia 播放页」

上游 Folia 的全屏歌词是 `currentView === 'player'` 的播放页：`App.tsx` 里一个 `absolute inset-0 z-0` 的
`div[data-testid="player-visual-surface"]`，外面还有标题栏、底部浮动控制胶囊、右侧 360px 面板、首页墙。

插件**不复刻那个 App**。它加载的是 Folia 的 **OBS 浏览器源页面**（`?obs=1` → `ObsBrowserSourceApp`）：
同一套 `VisualizerRenderer`、同样的 17 种样式与背景，但页面本身没有任何播放器外壳。因此：

- 样式、背景、字幕、转场**全部是 Folia 原始代码**，不是仿制；
- 播放器外壳（齿轮、播放条、菜单）由插件自己画，写法和位置按 SPW 的使用习惯定，不追求与桌面 Folia 逐像素一致。

顺带得到的一个实际差异：OBS 页面按 **1920×1080 基准**排版，再用 `max(1, realWidth / 1920)` 放大并覆写
`devicePixelRatio` / `innerWidth` / `innerHeight`（`ObsBrowserSourceApp.tsx`）。所以窗越大字越大是等比放大，
不存在「横竖两套布局」。

## 2. 层叠顺序

页面（DOM）从下到上：

| 层 | z-index | 说明 |
|---|---|---|
| 点击分区 `.spw-click-zones` | 2147482990 | 全屏三列热区：左=上一首、中=播放/暂停、右=下一首 |
| 播放条 `.spw-playback` / 队列面板 | 2147483000 | 底部居中的播放 HUD（可关） |
| 注入根容器 `#spw-settings-ui-root` | 2147483000 | `position: fixed; inset: 0; pointer-events: none` |
| chrome 按钮（齿轮 / 返回 / 救生圈 / 右下圆钮） | 2147483001 | 每个按钮自己 `pointer-events: auto` |
| 诊断面板 `.spw-problem-report` | 2147483002 | 「出现问题」卡片 |
| 设置窗口（`StudioWindow`） | 遮罩 `z-[140]` | 全屏遮罩 + 1240×780 窗口，见 [`settings-ui.md`](settings-ui.md) |

规则：**点击分区永远在最下**，所以它盖不住任何真实控件；控件覆盖处永远是控件拿到点击。设置窗口或鼠标穿透
打开时，点击分区整体 `pointer-events: none`。

宿主窗口侧：`FormBorderStyle.None` + 全屏、可选置顶；透明模式下用色键（`SetLayeredWindowAttributes` +
近黑键色）把背景挖空，机制见 [`live-transparency.md`](../live-transparency.md)。

## 3. chrome 与自动隐藏

- **齿轮**（右上 24/24，`data-spw-chrome="settings"`）：打开设置窗口。
- **返回**（左上 24/24，`data-spw-chrome="exit"`）：请求关闭窗口。**只在播放页不透明时渲染** —— 透明模式下
  chrome 常驻，退出走自己的入口。
- **救生圈**（右 76/24，`data-spw-chrome="problem-report"`）：打开「出现问题」自检；由配置页开关决定是否渲染
  （默认关）。
- **右下圆钮**（`right: 32px; bottom: 56px`，`data-spw-chrome="player-background"`）：打开播放页菜单（透明背景、
  鼠标穿透、显示播放条）。
- **淡出**：指针/按键静止 2.5s 后 chrome 按 `data-visible` 淡出（`pointermove` / `pointerdown` / `keydown` 都会重置
  计时），窗口级游标隐藏由宿主在 2.5s 空闲后做（`HostForm.CursorIdleMs`）。播放页透明时 chrome **常驻**
  （`chromeAlwaysOn = transparentPlayerBackground`）；右下菜单展开期间它自己的按钮常显，其余 chrome 照常淡出；
  设置窗口打开时 chrome 全部隐藏（`!open`）。
- **键盘与鼠标**（`Shim.js`）：
  - `ESC`：有设置窗口/菜单时先关它（页面在 capture 阶段吞掉），否则交给宿主关窗口；
  - 鼠标侧键「后退」：同上「先关弹层，再关窗口」；
  - `Alt` + 左键拖拽：把无边框窗口拖到别的显示器并重新全屏（宿主走原生 move 循环）；
  - `F1`：开/关设置窗口；
  - `Ctrl+Alt+F`：在窗口内也能关闭（SPW 的快捷键只在 SPW 有焦点时生效，窗口聚焦后按键落到这里）。

## 4. 点击分区与播放条

- **点击分区**（`chrome/PlaybackClickZones.tsx`）：左/中/右三列，分别发 `previous` / `toggle` / `next`。
  位移超过 `DRAG_SLOP_PX = 10` 视为拖拽不发命令；`Alt` 按下（窗口拖动）不发命令；手势后浏览器补发的
  `click` 用 `CLICK_AFTER_GESTURE_MS = 800` 抑制，保证一次手势只动作一次。分区**不因「显示播放条」关闭而失效**
  —— 暂停画面是画面级功能。
- **播放条**（`chrome/playback/PlaybackBar.tsx`）：收起态是时间 / 细进度 / 总时长；指针停留 `EXPAND_DELAY_MS = 150`
  展开成完整控制条（播放/暂停、上一首、标题、下一首、进度、随机、队列）。可用底栏 `「显示播放条」`整条关闭，
  关掉后组件**不挂载**（不是 `display:none`），连点击热区一起消失。
- 进度条同时支持 `pointerdown → pointerup` 拖动与普通 `click`（含合成事件）；队列面板从播放条上方弹出。
- 所有传输控制都走协议 `control` 通道（页面只发请求，插件执行并回 `state` / `queue`），见
  [`playback-controls.md`](../playback-controls.md)。
- 鼠标穿透开启时播放条整体卸载、点击分区禁用 —— 点击必须落到桌面。

## 5. 鼠标穿透的热区上报

透明 + 穿透时，宿主只能让**页面报告的矩形**接收点击（其余转发到桌面）。页面在 `App.tsx` 里收集这些元素的
`getBoundingClientRect()`，通过 `{type:'hitbox', vw, vh, rects}` 发给宿主：

- 齿轮、返回、右下圆钮、右下菜单（展开时）、救生圈及其面板（展开时）、设置窗口（打开时）。

宿主把 CSS px 换算成窗口像素（`±4 CSS px` 容差）后用 `SetWindowRgn` 做成输入捕捉窗口的区域 —— 区域外的一切
输入在 OS 层交给下面的窗口。**新增浮动控件必须同时加进这份上报列表**，否则穿透模式下它点不到。

## 6. 设置窗口（在同一页面里）

设置窗口是注入到**同一个 document** 的 React 岛，不是第二个窗口或 iframe：

- 遮罩 `fixed inset-0 z-[140]`；窗口 1240×780、右栏 420px，布局与控件见 [`settings-ui.md`](settings-ui.md)。
- 打开时：指针分区禁用、播放条卸载（`PlaybackBar` 见到 `settingsOpen` 直接返回 null）、右下菜单收起，
  `Shim` 报告的命中区加上整个遮罩。
- `ESC` 在 capture 阶段被吃掉并关闭窗口，不会冒到宿主那里把整窗关掉；关闭时 `ESC` 交还宿主。
- 窗口里的「大预览」是播放页的逐帧镜像（同源 iframe + 真实 clock/audio/config），不是另造一份模拟数据，
  见 [`live-preview-iframe.md`](../live-preview-iframe.md)。

## 7. 开屏与透明

- **开屏**：宿主在 URL 上加 `splash=1`，`Shim.js` 在页面解析期装一份与上游 `#app-splash` 等价的遮罩
  （深色底 + `F o l i a` 辉光词标 + 声波），宿主等首帧 + 最短 0.8s 后淡出（`SplashFallbackMs = 3400` 兜底，
  `--splash-duration` 限 300–2000ms）。元素 id 用 `spw-folia-splash` 而非 `app-splash`，因为上游
  `AppSplashGate` 挂载时会自己摘掉同名元素。`--no-curtain` / 配置页开关关掉它。
- **透明**：页面侧 `config.background.transparent = true` 让 Folia 的背景渲染器直接返回 null；
  宿主侧用色键挖空窗口。两层都在才真的透出桌面，见 [`live-transparency.md`](../live-transparency.md)。

## 8. 与「1:1 复刻 Folia 播放页」的取舍

插件**不打算**复刻桌面 Folia 播放页的外壳，下面这些上游能力因此不在范围里：

| 上游能力 | 状态 |
|---|---|
| 底部浮动控制胶囊（`FloatingPlayerControls`）、右侧 360px 面板（`PanelShell`）、`PanelHandle` | 不复刻；用插件自己的播放条与右下菜单 |
| chrome 三档可见性（`player_chrome_visibility_mode`）、`KeyH` 循环 | 不复刻；固定「2.5s 淡出 + 菜单/设置时常驻」 |
| 样式壳的左上 120×120 返回热区、右下 120×120 面板引导热区 | 上游代码在，但插件不传 `onBack`/`alwaysShowBackButton`，所以不出现 |
| 视频层（`VideoLayer`）、`FoliumStageLayerSlot` 舞台层 | 只在主界面生效（`isMainAppSurface`），OBS surface 下不画 |
| 首页墙/Lattice、窗口原生模糊、播放页透明以外的 Electron 窗口行为 | 不在范围 |
| automix 歌曲交接（`songHandoff`） | 不实现，切歌直接换，见 [`runtime-contracts.md`](runtime-contracts.md) §9.3 |

保留并确实生效的：17 种样式与背景、逐字动画与词级辉光、翻译字幕（底部 z-20）、`visualizerOpacity`、静止模式、
`isDaylight`、封面取色主题。

**和声层（顶部 76px 起，z-30）不显示**：插件只提供逐字歌词与翻译，没有 TTML 和声数据，`config` 里
`showHarmonySubtitle` 与 `harmonySubtitleBackground` 恒为 `false`。
