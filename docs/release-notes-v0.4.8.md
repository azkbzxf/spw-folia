# spw-folia v0.4.8 — 跟进上游 Folia 0.7.25：两个新样式、原版开屏、帧率设置

> **未发布**：本版本仅本地构建与测试，从未上传 GitHub Releases；其改动随后续版本一并交付。最后发布的版本是 v0.4.6。

本版把内嵌的 Folia 从 **0.7.22 升到 0.7.25**，样式数 **15 → 17**，并把取色幕布换成 Folia 原版开屏，
同时修掉透明模式下的粉色残留、补上帧率设置、按官方建议加固了对混淆名的依赖。
设置页与播放页的观感有明显变化，本文件按「用户能看到什么 → 根因 → 验证」组织。

> 版本号已由 **v0.4.10 定版为 `0.4.10`**（`build.gradle.kts` 的 `version` / `PluginVersion` 与
> `FoliaPlugin.PLUGIN_VERSION` 三处同改）。本文件写作时那三处仍记为 `0.4.7`，是历史状态，现已修正。

## 一、新增两个歌词样式（15 → 17）

上游 0.7.24「Rainy Update」新增两款，本版一并跟进：

| 样式 | 说明 |
| --- | --- |
| **町景**（`machi`，order 27） | three.js 三维微缩街景，歌词写在便利店 LED 屏与招牌上；三套场景（便利店 / 车站 / 城寨）、时间与天气可设、镜头可自由取景 |
| **雾笺**（`nebbia`，order 29） | 雨夜公交车起雾的车窗，按笔顺一笔一笔写出歌词，写过的笔画露出窗外夜景，水珠顺笔画淌下 |

货架顺序插在「花火」与「流光」之间，与 Folia 自己的 `registry.order` 一致。

### 联动改动（漏一处就静默出错）
| 位置 | 改动 |
| --- | --- |
| `model/styles.tsx` | 两个 entry（panel 引用、beatEffects、thumb、fontSize notice） |
| `model/settings.ts` | `StyleMode` 联合类型 + `STYLE_TUNING_DEFAULTS` + `STYLE_TUNING_KEYS` + `STYLE_MODE_SHELF_ORDER` |
| `model/transparencyCompat.ts` | `STYLE_COMPAT` 补两键 → 都判 `unsupported`（整屏自绘，色键下会残留半透明像素；**未 alpha-probe 实测**，按 monet 同档保守处理） |
| `vite.config.ts` | `STYLE_MODES` 15 → 17（`requireStyleThumbs` 硬闸） |
| 缩略图 | 17 张全部用真实渲染器重采 |
| 合规 | 新增 **AnimCJK / Arphic Public License** 条目（见第四节） |

## 二、过渡动画：取色幕布 → Folia 原版开屏

用户要求「将现有的过渡动画替换为原版的过渡动画」。

**旧实现**：`IntroCurtain.cs`，557 行 C# WinForms 逐帧绘制——封面取色渐变 + 极光 + 余烬 + 光扫 +
「Folia」词标 + 副标题，32ms 定时器 `RenderScene()` 常驻。

**新实现**：直接用上游 `index.html` 里自带的 `#app-splash`（深色底 + 居中「F o l i a」辉光词标 +
13 根随机波形竖条），由宿主控制揭幕时机。`IntroCurtain.cs` → `SplashBridge.cs`（只剩 3 个常量）。

### 关键取舍：元素 id 不复用 `app-splash`
上游 `AppSplashGate` 在 React 挂载时会 `hideAppSplash()` —— `getElementById('app-splash')` 后直接
淡出。复用同一个 id 会让**页面自己**把宿主控制的遮罩提前摘掉，最短停留时长失效（实测 React 挂载
远早于 800ms）。所以宿主注入的副本用 `id="spw-folia-splash"`，类名仍沿用 `app-splash-*`。

### 揭幕三条件（`HostForm.TickSplash`，60Hz）
1. `shownForMs >= splashMinMs`（`--splash-duration`，默认 800ms，clamp 0.3–2.0s）
2. `firstPageFrameAt > 0` 且已过 450ms grace —— 保证页面真的画了才揭
3. 兜底 `splashMinMs + 3400ms`（页面永不报帧也不会永远挡着）

透明 / 鼠标穿透会话下，色键先装好再揭幕。

### 字体跳变修复
初版照搬上游的「字体轮盘」（每 380ms 随机换 fontFamily / weight / italic / scale，候选含
`cursive` / `fantasy`）。本机这些字族回退后五字母大小粗细各异，词标看起来是坏的而不是设计的。
改为统一 Inter / 600 / normal / 无 transform，**只保留上游「用 canvas 量最宽字形写死 em 盒宽」**
那一步保证排版不抖。波形竖条的全部随机跳动保留。

## 三、两个用户可见的观感问题

### A. 透明模式下的粉色残留 —— 色键换色
**根因不是「窗口底色是品红」那么简单**。`LWA_COLORKEY` 只抠**精确等于键色**的像素：
- alpha=0 → 变 `BackColor` → 精确匹配 → 抠掉 → 透出桌面 ✅
- **0 < alpha < 1** → `alpha*页面 + (1-alpha)*键色` → **不再精确匹配** → 留在屏幕上被染色 ❌

所以粉色恰恰出现在**有内容的地方**：50% 白的字形边缘会变成 `rgb(255,128,255)`。

**改法**：`TransparencyKeyColor` 从 `rgb(255,0,255)` 换成 **`rgb(1,0,1)`**。色键唯一要求是「页面
永不绘制该色」，换色不影响抠像。选它因为：不是纯黑（`Color.Black` 同时是不透明会话底色与页面
基色）、Folia 最深调色板 `#09090b=(9,9,11)` 混不出「1-unit 红蓝 + 零绿」、万一未抠掉也近乎不可见。

实测（真实宿主 + WebView2 + **GDI 全屏截图**）：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| magenta 族占比 | **99.96%** | **0%** |
| 50%-alpha 像素 | `(255,128,255)` 粉 | `(128,128,128)` 中性灰 |
| 窗口底色 | 满屏洋红 | `(1,0,1)` 近黑 |

> 为什么要用 GDI：`CapturePreviewAsync`（宿主 `--screenshot` 用的）只抓 WebView2 表面，**永远看不到
> 窗口 BackColor** —— 这正是既有截图检查一直没抓到这个 bug 的原因。新脚本
> `verify-colour-key.mjs` 走 GDI。

**新增 `--no-colour-key`**（兼容 `--no-color-key`，环境变量 `SPW_FOLIA_COLOUR_KEY=0`）：调试时不装
色键，窗口是普通不透明黑，页面侧透明也一并降级。所有会产出截图的调试脚本统一带上。

### B. 开屏停留过久 —— 首帧信号错误（少留 907ms）
`firstPageFrameAt` 原本用 `type=="fps"` 消息来置，而 fps 只在**首个 1 秒窗口结束时**才发一次 →
它比真首帧晚约 850ms（实测 863 / 853 / 858ms 三组）。splash 揭幕闸门依赖它，于是多留 ~500ms，
`--splash-duration` 配小时最坏多留 ~1.1s。

改法：Shim 在**第一个 rAF 回调**里额外 `post({type:'first-frame'})`，宿主认这个类型（保留 fps 分支
给旧 bundle 兜底，日志标 `source=fps-window`）。

| | firstPageFrameAt | splash `shownForMs` | 超出 minMs |
| --- | --- | --- | --- |
| 改前 | 1505ms | 1907ms | +1107ms |
| 改后 | 586ms | **1000ms** | **+200ms** |

> 连带修正：`verify-splash.mjs` run 3 原来在 1500ms 断言「splash 仍在屏上」—— 那条断言恰好把旧的
> 错误时序钉死了。现在改为用 `splash shown` 日志证明「曾经显示过」+ `reveal` 行证明时序正确。
> **这是断言跟随正确行为，不是为了让测试通过而放宽标准。**

## 四、配置页新增帧率设置

> **v0.4.10 已删除该设置**（整条链路移除，理由见 [`docs/release-notes-v0.4.10.md`](release-notes-v0.4.10.md)）。以下内容仅作历史记录。

位置：SPW → 模组管理 → 配置 → 播放页，现有三项：打开过渡动画 / 详细日志 / **帧率**。

`type: "list"`，四档：`无限制`（`off`，默认）/ `120` / `90` / `60`。**冷生效**（下次打开 Folia 生效）。

### 类型依据
`list` 不是猜的：`spw-island` 的 `preference_config.json` 里有 5 个 `list`，结构为
`entries`（显示文本）/ `entry_values`（值）/ `default_value`（字符串）平行数组。
已核对的三种插件类型全集：`button` / `switch` / `edittext` / **`list`** / **`seekbar`**。

### 实现链路
Kotlin 读配置（与 UI 类型**完全解耦**，只认 `off/60/90/120` 字符串，非法值回落 `off`，**永不抛异常**）
→ `--frame-rate`（**无条件传**，否则上次的 cap 会残留在 localStorage 继续限流）→ 宿主
`Program.NormaliseFrameRate()` 第二层容错 → Shim 在 document-created 阶段写
`localStorage['visualizer_frame_rate']` → 上游 `visualizerSettingsPersistence` 启动时读取并应用。

### ⚠️ 上游限流算法缺陷：档位达不到标称值
`frameRateLimiter.ts` 的 `intervalMs = 1000 / frameRate - 1`，那 `-1ms` 容差让所需间隔永远比目标
vsync **略短一点**，于是在某些刷新率上退化到下一档：

| 显示器 | 120 档 | 90 档 | 60 档 |
| --- | --- | --- | --- |
| 60Hz | 60 | 60 | 60 |
| 120Hz | 120 | **60** | 60 |
| 144Hz | **72** | **72** | **48** |
| 165Hz | **83** | **83** | **55** |

本机 120Hz 实测复核：`off`=120（限流器**未**安装）、`120`=120、`90`=**60**、`60`=60。

**决策：保留 90，不删档**。删掉会掩盖「120 档在 144Hz 屏上只有 72」的事实；保留全部四档 + UI
文案说明更诚实，且上游修好后这边零改动。配置页 summary 已写明这一点。

> **该决策已被 v0.4.10 推翻**：v0.4.10 把四档整条链路删除。理由是「默认档就是推荐档」，一个只能把
> 画面调差的选项不值得保留；2025-11 的本轮判断是「删」优于「保留并解释」。见
> [`docs/release-notes-v0.4.10.md`](release-notes-v0.4.10.md) 第一节。

> 判定「限流器是否安装」用的是上游自己的 `window.__foliaNativeRequestAnimationFrame` 指纹 ——
> 本机 120Hz 屏下 `off` 和 `120` 的 fps 都是 120，**光看数字永远分不出**。该指纹已写进 `--fps-log`。

## 五、按官方建议加固对混淆名的依赖

依据：Salt Player 官方开发者 **GaodaGG** 在 Steam 创意工坊的《关于插件调用 Hook API 时的反混淆》
（2025-10-20）。要点：别写死混淆名（每次构建重生成、Win/Linux 还不同），靠 `@Metadata` / 参数类型 /
返回值 / 接口等**编译后不变的特征**检索，定位后缓存。

### 审查结果
| 项 | 结论 |
| --- | --- |
| `HostTargets` / `HostMenuDiscovery` / `HostBytecodeIndex` | **本来已达标**（结构化发现，注释写着 `never by an obfuscated name`） |
| 反射结果缓存 | 已达标（三处都有缓存） |
| **`FoliaPlaybackControls`** | **有 4 个写死的混淆名** → 已改为三层解析 |

### 改法
三层：① 元数据顺序 + 字段表配对 → ② `listIntPairs` → ③ **写死名兜底**（原有行为，保证不更脆）。

宿主 **100% 保留了 Kotlin `@Metadata`**（原始属性名 `mode/normalQueue/normalIndex/randomQueue/randomIndex`
与原名 `PlaybackQueueItem` 全在）。

### 两个踩过的坑（都会静默出错）
1. **`getDeclaredMethods()` 顺序 ≠ 声明顺序**，而 `getDeclaredFields()` **是**声明顺序。第一版「按类型
   分桶后 zip」把 **normal / random 静默互换** —— 真实世界表现是「随机播放显示成顺序队列」。正确做法
   是用**字段表做顺序权威**，按 `field.name == getter.name` 配对。
2. 元数据里的 `getNormalQueue()` **不能直接 `findMethod`** —— R8 把方法名也改了。元数据只提供
   **属性名的顺序**，成员本身要靠字段表按名字 + 类型对上。

> 另修正了一处错误注释：原注释说「宿主里不存在叫 `PlaybackQueueItem` 的类」—— 它确实存在，只是源名
> 被混淆成单字符。

### 失败策略：去掉单向闩锁
原来的 `permanentlyUnavailable` 在 `ClassNotFoundException` / `NoClassDefFoundError` /
`ExceptionInInitializerError` 时**永久关闭播放控制、不再重试**。但在活宿主里这不是可靠的永久条件
（类可能只是还没被那个 loader 加载）。

改为：连续失败 4 次（`MAX_RESOLVE_FAILURES`）后进入 **每 2 分钟慢探**（`EXHAUSTED_RETRY_MS`），
到点自动恢复。**原则：绝不用单向闩锁锁死功能。**

## 六、上游更新跟进机制（减少下次跟进成本）

这次 0.7.22 → 0.7.25 的痛点：样式清单散落 13 处靠人肉同步。已建两道机制：

1. **`poc/settings-ui/scripts/check-style-sync.mjs`** —— 以**上游源码为唯一事实源**
   （`BUILTIN_VISUALIZER_MODES` + 各 `entry.tsx` + 各 `tuning.ts` 的 `settingsKey`），交叉核对 13 处本地清单。
   - `--check` 有差异就 exit ≠ 0 并指名道姓（缺哪个样式 / order 变了 / beatEffects 对不上）
   - `--write` 只自动补**纯 id 列表**（6 处）；`styles.tsx` / `settings.ts` / `transparencyCompat.ts`
     **一律只报告不改** —— 用哪个 panel、透明分类、默认值从哪 import 需要人判断
   - 已接进 `vite build`（`spw-style-manifest-sync` 插件），不一致直接让构建失败
2. **`docs/upstream-sync.md`** —— 升级 checklist，把这次踩的坑全写进去

### 这次踩到、已写进文档的坑
- **`NODE_OPTIONS="--use-system-ca"`**：本机 Node 的 `fetch` 无法验证系统代理证书，不加会**静默丢失**
  `nebbia-strokes.json`（4.28 MB 雾笺笔顺数据），构建仍 exit 0。
- **CSS 三查**（P4-14 静默失败）：主 CSS 必须 > 200 KB、含 `.h-full{height:100%}`、无字面量 `@tailwind`。
  取文件要用 `ls -S` 取最大的 `src-*.css`，`ls | head -1` 会拿到 89 KB 的 `BravaisStage-*.css`，看起来
  像构建坏了。
- **上游新增必填 prop → 设置页白屏**：0.7.25 给 `VisPlaygroundSettingsPanel` 加了**必填**的
  `subtitleOverlayLayout`，`App.tsx` 传不了，组件内 `getSubtitleOverlayRows(undefined)` 会
  `layout.split('+')` → TypeError，而**设置岛没有 ErrorBoundary** → 点「字幕」tab 整页白屏。
  已加 6 条 surgery 摘掉该控件；`docs/upstream-sync.md` 里加了「构建后点一遍所有 tab」这条 checklist。
  > 功能影响：副字幕多行布局**未实现**（只是把控件摘掉）。播放页走默认值 `'translation'`，与现有
  > `subtitleContentMode` 语义一致，**不是 bug**。
- **`Shim.js` 是嵌入 exe 的资源**：改了必须重新 `build.sh`，否则跑的是旧 exe。
- **`./gradlew build` 不生成 `.spmod`**：只编译不打包，要跑 `plugin` 任务。只看 `EXIT=0` 会以为好了，
  用户拿到的还是旧包。

## 七、缩略图与文档资源

- **17 张样式缩略图全部重采**（用户要求「把旧的样式预览小图标都更新一遍」）。旧图有个长期存在的问题：
  大部分样式拍出来是「灰雾一片 + 看不清歌词」，因为截图时机落在开场标题卡上。
- **`--shot-at` 是错的**：它走宿主 tick 时钟，宿主收不到 `{t:"state"}` 就走 free-running（实测 6500 和
  13000 拍的是同一张标题卡）。现改为用 stdin 每 100ms 发 `{t:"state",posMs}` 钉住播放位置。
  > 注意**超过 500ms 会失效，必须持续重发**。
- **判据**：朴素亮像素会被五线谱骗（`classic` / `partita` / `pendolo` / `cappella` / `diorama` /
  `monet` 都画谱线 + 音符头，亮度跟真歌词一样高）。改为「中间竖带（宽 28–72%）→ 相对本帧中位数取亮
  → 9×9 腐蚀 → 计数」：1–2px 谱线被腐蚀掉，粗笔画留存。实测真歌词帧是纯谱线帧的 **5–8 倍**。
- 顺带修掉一个真 bug：CSS 只隐藏 `.spw-playback-bar`（内层），根元素其实是 `.spw-playback`，
  导致播放条被拍进图里。
- 同步派生 **17 格网格图**（`docs/images/style-grid.png`）与 **34 张站点图**
  （`site/assets/styles/{,large/}`，960×540 / 1600×900）。

### 已知限制：6 个样式的缩略图歌词偏弱
`classic` / `cadenza` / `claddagh` / `cappella` / `pendolo` / `monet` 的定稿图里歌词仍然偏淡。
**机制性证据**：同一样式、同一钉住位置，两次独立会话结果不同（一次有清晰歌词，一次只有五线谱）——
所以这不是「时机没选对」。判断是渲染路径差异（先画谱线、歌词层更晚）。
真解方向是**改 demo 歌词时间轴让内容一直在**，尚未验证。

## 八、验证

### 端到端（真实宿主 + 真实 WebView2 加载打包产物）
```
node packaging/tools/verify-layout.mjs  →  pass = true, consoleErrors = 0
  styleThumbs:  { total: 17, loaded: 17 }
  preview:      { ready: "true", staticFallback: false, childShim: true, childSplash: false }
  canvases: 3
```

### 各专项
| 项 | 结果 |
| --- | --- |
| `check-style-sync.mjs --check` | exit 0，17 项与上游一致 |
| `verify-splash.mjs` | 23/23 PASS（默认开屏 / 词标稳定性 / 揭幕后无黑屏粉屏 / `--no-curtain` / 透明+穿透） |
| `verify-colour-key.mjs` | 9/9 PASS（键生效 / 无色键 / 页面不撞色；含 GDI 像素统计） |
| `verify-frame-rate.mjs` | 13 项主断言 + 16 项负向断言全绿（含 stale-value 陷阱） |
| `verify-splash-gates.mjs` | 11/11（三向：正常通过 / 删掉 splash 抛错 / preview 带 splash 抛错） |
| `verify-splash-browser.mjs` | 9/9（真 Edge：index 首帧 13 根波形已随机化、preview 全程无 splash 且不闪白） |
| `Verification v0.4.8` M1 反射层 | 真实宿主 bytecode **10/10**（含「写死名与元数据解析指向同一批成员」） |
| `RenameSim` | PASS（模拟宿主改名：写死名失效、resolver 拒绝猜、无静默错配） |
| `gradlew build` / `plugin` / `test` | 通过 |
| `build.sh`（C# 宿主） | 0 error（3 条既有 warning） |

> **验证边界（勿误读）**：M1 的反射/解析层有真实宿主 bytecode 级验证，**但队列 UI 渲染层无覆盖**。
> 队列 JSON 由插件侧产出（`bridge.queueProvider`），宿主只转发，`driver.mjs` 不发送 queue 消息 ——
> 真机那步只证明「没把宿主跑跑挂」（`fpsMedian 120, canvases 3, stderr 空`）。

## 九、产物

> **本地产物，未发布。** 下面这个 `.spmod` 只在本机 `dist/release/` 里，**从未上传 GitHub Releases**；
> 同目录的 `spw-folia-0.4.6.1.spmod`、`spw-folia-0.4.7.spmod` 同理。最后发布的版本是 v0.4.6。

```
dist/release/spw-folia-0.4.7-dev.spmod
  sizeBytes: 15,395,759 (14.68 MB / 16 MB 预算 → withinBudget: true)
  entries:   3973
  sha256:    7578cc0945dd190a706effb3d1f67029dbafb7a8a9113cf3b725a284aa3e07e9
  Plugin-Id: dev.spw.folia · Plugin-Version: 0.4.7
  permissions: class-transform, library-read, key-bindings
```

> `packaging/size-report.json` 的 `withinBudget` 仍是 `false`（33.42 MB vs 32 MB **staging tripwire**）。
> 这是**告警而非用户预算** —— 用户实际下载的 `.spmod` 是 14.68 MB，在 16 MB 预算内。
> staging 涨的主要来源是 `web/nebbia-strokes.json`（4.28 MB，gzip 后 1.55 MB）。

## 十、未做 / 已知限制

| 项 | 说明 |
| --- | --- |
| 副字幕多行布局 | 控件被 surgery 摘除，**功能未实现**（播放页走默认单行，不是 bug） |
| 智能动感模式 | 节拍模型不在 WebView bundle，`machi` / `nebbia` 的随拍效果不会触发（样式本身动画不受影响） |
| 90 档达不到 90 | 上游限流算法缺陷，见第四节（**该设置已由 v0.4.10 删除**） |
| 6 个样式缩略图歌词偏弱 | 见第七节 |
| 帧率热切换 | **未做**（冷生效）。reload 会让开屏重播、播放中断，体验差（随 v0.4.10 删除设置一并作废） |
| `S1` rAF 循环降频 | **未做**。帧率功能已改变该循环语义（60 档时自身也降频），与上游限流器交互变复杂，留给独立性能任务 |
| 透明会话截图 | `CapturePreviewAsync` 偶发拿不到文件，该路径靠 DOM + 日志断言而非像素证据（`verify-colour-key.mjs` 用 GDI 补上了） |
