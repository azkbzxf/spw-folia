# spw-folia 开发经验总集（2026-10-18 → 2026-11-01）

> **这份文档是什么**：`spw-folia` 从 v0.1.0 到 v0.4.6.1 的全部开发历史被压缩成一份可查阅的经验库。
> 数据来源是 `D:\输出目录\dsh2` 工作区里 63 个历史会话的原始记录（含子代理会话）、仓库文档、
> 发布台账与项目记忆，逐条取证后分类汇总。**不是回忆录**：每条坑都写了现象 / 根因 / 解法 /
> 以后怎么避免，能复核的数字（字节数、SHA-256、行号、码点、退出码）全部保留。
>
> **怎么用**：
> - 接手新任务 → 先读 §9「给下一个 agent 的铁律」和 §5「契约」，再查 §4 对应类别的坑。
> - 排障 → 用 §6 的「日志关键字 / 退出码 / 症状对照」直接定位，不要从头读。
> - 发版 → 照 §7 的发布流程与检查表走，特别注意「兼容性发布禁止用 assemble」。
> - 怀疑「文档说的对不对」→ 查 §8「已知不一致」，那里列了文档与现实的偏差。
>
> **可信度标注**：`（不确定）` = 原始会话里没有定论或证据不足；`未解决` = 明确记录为遗留问题。

---

## 目录

| 节 | 内容 |
| --- | --- |
| §1 | 项目是什么：四层架构与数据流 |
| §2 | 版本台账（25 个版本行 + 1 个未升号自称，21 份正式 release notes） |
| §3 | 已完成的任务（按领域归类，含产物与数字） |
| §4 | 踩过的坑（12 类，165 条，**核心章节**） |
| §5 | 已建立的契约与约定（8 组） |
| §6 | 排障速查：日志关键字 / 退出码 / 症状对照 |
| §7 | 构建、打包、验收、发布的标准流程 |
| §8 | 已知限制、未决问题、文档与现实的不一致 |
| §9 | 给下一个 agent 的 12 条铁律 |
| §10 | 关键文件与路径地图 |

---

## §1 项目是什么：四层架构与数据流

**一句话**：把 [Folia](https://github.com/chthollyphile/folia-major)（Electron 歌词可视化应用）的
**生产级 OBS 浏览器源产物**内嵌进 **Salt Player for Windows（SPW）**，让 SPW 正在播放的音乐驱动
Folia 的 15 种歌词样式，全屏叠加在桌面；插件本身不渲染任何东西。

### 1.1 四层与职责边界

```
Salt Player for Windows 1.19.x（JVM / Compose Desktop，R8 混淆）
   │  PF4J 插件 · class-transform 权限 · hookMethod 注入「更多」菜单
   ▼
① spw-folia 插件（Kotlin / .spmod）          ← 只做数据与生命周期，从不渲染
   · MenuHook        hook 宿主「更多」弹层的 item-adder
   · TrayHook        hook compose-native-tray 的 RecordingComposableScope.snapshot()
   · PlaybackBridge  PlaybackExtensionPoint（1 Hz 位置回调）
   · Timeline        1 Hz → 60 Hz 位置插值
   · ConfigStore     设置树 JSON（workshop/data/dev.spw.folia/）
   · HelperManager   spawn / stdin / stdout / exit-watch
   ▼ stdin/stdout JSON-lines（protocol v1）
② spw-folia-host.exe（C# .NET Framework 4.8 + WinForms + WebView2）
   · 无边框全屏窗口（DPI、多显示器、色键透明、shaped region 穿透）
   · 本地虚拟主机 https://spw-folia.local 加载 web/（**零网络、零 HTTP 服务**）
   · 注入 Shim.js → 设置岛 bundle → Folia 资源
   · WASAPI 环回音频分析（0..255 FFT/bands/power，~30–60 Hz）
   ▼ chrome.webview 消息
③ WebView2 页面 = Folia OBS bundle（/obs）+ 注入脚本
   · Shim.js：伪造 EventSource → 时钟 / 音频 / 配置事件
   · 设置岛（React 19 + Vite）：复用 Folia **自己的** React 组件（1:1 视觉）
   · publisher.ts：在页面内构建完整 ObsBrowserSourceConfig → pushConfig()
   ▼
④ 上游 Folia 0.7.22（只读，AGPL-3.0）—— 15 种样式、转场、辉光、逐字时间轴全部原样
```

**四条硬决策（v0.1.0 定下，全程未变）**：
1. **不把 Folia 的可视化移植到 Kotlin**。Folia 自带 OBS 浏览器源表面（`pathname=/obs` 或 `?obs=1`），
   直接打包它的生产 dist → 像素级一致、15 种样式零维护。
2. **无 HTTP 服务、无网络、无 Electron**。WebView2 把本地目录映射成虚拟主机 `https://spw-folia.local`，
   Folia 的 `EventSource` 由注入的 Shim.js 用 `chrome.webview` 消息喂。
3. **原生辅助进程**而非 JCEF。SPW 是 512 MB 堆的 Compose/Skia 应用，把 Chromium 塞进 JVM 又重又险；
   辅助进程崩溃不拖垮 SPW。
4. **插件保持薄**：只拥有数据（播放时钟、歌词、曲目/封面、设置持久化）与生命周期，**从不渲染**。

### 1.2 协议 v1 的消息面（`docs/protocol.md`，冻结，只允许追加）

| 方向 | 消息 |
| --- | --- |
| 插件 → 宿主 | `hello`、`settings`、`state`（posMs/durationMs/playing/rate/tsMs ~100 ms）、`lyrics`、`track`、`queue`、`config`、`quit` |
| 宿主 → 插件 | `ready`、`closed`、`settings`（UI 改动回写）、`control`、`action`、`log` |
| 宿主 → 页面 | `hello`、`settings`、`state→clock`、`lyrics`、`track`、`audio`、`queue`、`config`、`beat` |
| 页面 → 宿主 | `ready`、`settings`、`action`(close/reset/openDevTools)、`control`、`hitbox`、`log` |

页面全局 `window.__SPW_FOLIA__`：`on/emit/getSettings/setSettings/pushConfig/requestClose/inputs/ui`。

**关键所有权**：`ObsBrowserSourceConfig` 由**页面**构建（设置岛 publisher，节流 ≤10 Hz）后 `pushConfig`；
宿主在 v1 里**从不**构建 config。音频完全留在宿主进程（与 WebView2 同进程，无 IPC 跳）。

### 1.3 三个进程/组件的版本耦合

| 组件 | 版本锚点 | 换版时的连带工作 |
| --- | --- | --- |
| SPW 宿主 | 1.19.0 / 1.19.2 / 1.19.3 已验收 | 每次发版重跑 R8 混淆 → 必须审计全部反射目标（见 §4.1） |
| 上游 Folia | **0.7.25**（开发版内嵌；**已发布 v0.4.6 内嵌 0.7.22**，tag `v0.7.22`，commit `1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe`） | web bundle 换新 → 样式数/缩略图/合规文档/包体预算全部连带 |
| WebView2 Runtime | ≥ 86（GA 下限），实测 150.0.4078.83 | 用户机器缺就 exit 3 |
| .NET Framework | 4.8（`supportedRuntime sku=net48`） | 缺就 CLR 激活失败 / 进程秒退 |

---

## §2 版本台账（30 个版本行，25 份 release notes）

> **一句话：v0.4.6 是最后发布的版本。** v0.4.6 之后的 **v0.4.6.1 / v0.4.7 / v0.4.8 / v0.4.9 / v0.4.10
> / v0.4.11 全部只在本地构建与测试，从未上传 GitHub Releases，也**没有 tag**。**v0.4.6.1 同样未发布**——
> 「v0.4.6 之后的都不算发布」。判断发布状态只看两处：`gh release list` 与
> `git ls-remote --tags origin`，别信代码里的版本号和本地 `dist/release/*.spmod`。

下表 **30 个版本行**（v0.1.0–v0.4.6.1，加上 v0.4.7–v0.4.11 五个未发布版本行）。
**25 份 release notes**（`docs/release-notes-*.md` 11 份 + `docs/archive/release-notes-*.md` 14 份；
其中 11 份那一边含 v0.4.11 的 notes，若该文件尚未落盘则实际只有 10 份），
其中 `release-notes-v0.4.6.1.md` / `v0.4.7.md` / `v0.4.8.md` / `v0.4.10.md` / `v0.4.11.md` 五份自己也标注了「未发布」。
`v0.1.5`、`v0.1.11` 从未发布；`v0.4.2`、`v0.4.4`、`v0.4.9` 无 notes 文件（v0.4.2 只有
`verification-v0.4.2.md`；v0.4.9 的改动散记在 `release-notes-v0.4.8.md` 与代码注释里）；
`v0.4.7` 曾是代码注释里的自称、版本号未升，**这一批版本到 v0.4.10 才统一到 `0.4.10`，v0.4.11 起为 `0.4.11`**。

| 版本 | 日期 | 主题 | 关键改动 | `.spmod` 字节 |
| --- | --- | --- | --- | --- |
| v0.1.0 | 2026-10-18 | 首个发布：Folia 0.7.21 的 **14 种**样式进 SPW 全屏歌词 | `FoliaPlugin.kt`、`FoliaHostBridge.kt`、`poc/webview/host/*`、`packaging/*` | 12,443,495 |
| v0.1.1 | 2026-10-19 | 菜单项对齐宿主度量、光标 2.5 s 自动隐藏、设置覆盖层回显环 | `FoliaMenuItem.kt`、`HostForm.cs`、`App.tsx` | 12,450,886 |
| v0.1.2 | 2026-10-19 | 封面取色修复（`coverDataUrl` 兼容）+ 删智能动感开关 | `Shim.js`、`publisher/*`、`vite.config.ts`（surgery） | 12,450,848 |
| v0.1.3 | 2026-10-19 | 作者名改 `azkbzxf`；批量剥离无效控件；修字体/字幕映射 | `build.gradle.kts`、`vite.config.ts`、`settings.ts` | 12,405,289 |
| v0.1.4 | 2026-10-19 | 歌词样式预览随所选样式实时切换（交叉淡入） | `StylePreview.tsx`、`app.css` | 12,405,269 |
| v0.1.5 | 未发布 | 静态样式帧 + Ken Burns 推拉（后被 iframe 方案取代） | `StylePreview.tsx` | 12,574,908（local） |
| v0.1.6 | 2026-10-19 | 设置页大预览换成**真实 Folia 渲染器**（可播放/暂停） | `LivePreview.tsx`、`preview.html`、`PreviewShim.js` | 13,136,350 |
| v0.1.7 | 2026-10-19 | 播放页透明背景（色键窗口）+ `Ctrl+Alt+B` 逃生热键 | `HostForm.cs`、`Program.cs`、`PlayerBackgroundControl.tsx` | 12,970,892 |
| v0.1.8 | 未发布 | 切歌/封面/歌词链路修复 + 透明窗口可点击（输入捕获窗） | `FoliaHostBridge.kt`、`HostForm.cs`、`Shim.js` | 12,976,142（local） |
| v0.1.9 | 2026-10-19 | 「鼠标穿透（操作桌面）」开关 + 删左下 chip + 热区转发 | `HostForm.cs`、`Shim.js`、`settings.ts` | 12,975,396 |
| v0.1.10 | 2026-10-19 | 修透明模式滚轮下滚 `OverflowException` + 未处理异常入日志 | `HostForm.cs`（`unchecked((int)ToInt64())`）、`Program.cs` | 13,145,163 |
| v0.1.11 | 未发布 | PR #3：stdin 泵跨线程访问 WebView2 必崩 | `HostForm.cs`、`Program.cs` | —（并入 v0.2.0） |
| v0.2.0 | 2026-10-20 | 透明窗口样式兼容（native/tuned/unsupported）+ 4 条崩溃/卡死修复 | `transparencyCompat.ts`、`HostForm.cs`、`FoliaHostBridge.kt` | 13,149,053 |
| v0.2.1 | 2026-10-20 | 浅色主题菜单项配色 + 商店 MSIX 渠道 CLR 激活修复 | `FoliaMenuItem.kt`、`FoliaPlugin.kt`（`physicalFile()`） | 13,152,604 |
| v0.2.2 | 2026-10-21 | 鼠标穿透重写为系统级 shaped region（借鉴 SPW-island） | `HostForm.cs`（`CreateRectRgn`/`CombineRgn`） | 13,153,013 |
| v0.3.0 | 2026-10-21 | 开源链接 + 按钮统一 + 透明字体随系统明暗 + **底部播放控制条** + 侧键退出 | `FoliaPlaybackControls.kt`、`chrome/playback/*`、`docs/playback-controls.md` | 13,178,430 |
| v0.3.1 | 2026-10-23 | **纯兼容性**：宿主混淆名运行时解析（不再硬编码） | `HostTargets.kt`（`PROFILES` + 反射校验）、`FoliaPlugin.kt` | splice 产物 |
| v0.4.0 | 2026-10-24 | 内容+体验大版：Folia **0.7.22**、第 15 样式「花火」、随机池、自定义字体、托盘入口、透明快捷键、取色过渡动画 | `poc/webview/dist/dist` 换新、`FoliaTrayMenu.kt`、`FontPickerModal.tsx`、`FoliaSystemFonts.kt` | preview.1 20,029,633 → preview.2 12,193,169 |
| v0.4.1 | 2026-10-24 | **真实预览**：预览框逐帧镜像播放页，移除「预览文本」；修包体回归 | `LivePreview.tsx`、`config.ts`、`assemble-release.py` | 12,191,035 |
| v0.4.2 | 2026-10-26 | 修 issue #11/#12/#13：逐字歌词真实时轴、凝彩透明遮挡、「出现问题」自检 | `publisher/*`（`cells[]`→`words[]`）、`FoliaDiagnostics.kt`、`ProblemReportPanel.tsx` | 12,221,858 |
| v0.4.3 | 2026-10-26 | 上版收口 + 发布后日志复查 4 项（`console.warn` 正文、日志文件夹、`catcher drag` 刷屏、`RasterizationScale`） | `HostForm.cs`、`Program.cs`、`ProblemReportPanel.tsx` | 12,224,037 |
| v0.4.4 | （无 notes） | 结构发现雏形；已知问题：raw 描述符当类名传 `Class.forName` 全失败 | `HostMenuDiscovery.kt`、`HostTargets.kt` | — |
| v0.4.5 | 2026-10-30 | 适配 SPW **1.19.3**：新增 profile `ɦ`/`ל`/`त` + 修扫描路径潜伏 bug | `HostTargets.kt` | 12,227,007 |
| v0.4.6 | 2026-10-30 | **结构发现**：解析宿主字节码按形状唯一发现，宿主再改名无需发版 | 新增 `HostBytecodeIndex.kt`、`HostMenuDiscovery.kt`；`FoliaMenuItem.kt`、`FoliaPlugin.kt` | 12,476,192 |
| **v0.4.6.1** | 2026-11-01 | 修**诊断工具本身**：二态 → 四态（`PASS/FAIL/UNKNOWN/ADVISORY`），健康机不再误报 | 新增 `FoliaEnvironmentProbe.kt` + `src/test/`；重写 `FoliaDiagnostics.kt`；`ProblemReportPanel.tsx`、`HostForm.cs` | **10,948,881**（3907 条目，sha256 `a3f1b915…862117c`）· 未发布 |
| v0.4.7 | 未发布（本地测试） | 设置页两处「看起来坏了」：旧 Service Worker 劫持 `/preview.html`、15 张样式缩略图从未进过发布包 | `HostForm.PurgeStaleServiceWorkersAsync`、`LivePreview.tsx`、`scripts/make-thumbs.mjs`、`requireStyleThumbs()` | 12,513,618（3922 条目）· local only |
| v0.4.8 | 未发布（本地测试） | 跟进上游 Folia **0.7.25**：样式 15→17、取色幕布换成原版开屏、色键换近黑、帧率设置（后被 v0.4.10 删除） | `poc/webview/dist/dist` 换新、`styles.tsx`/`settings.ts`、`HostForm.TickSplash`、`Shim.js` | —（无独立发布包） |
| v0.4.9 | 未发布（本地测试） | 帧率设置实现（`list` 类型 + 宿主 `--frame-rate` + Shim 写 localStorage）+ 开屏首帧信号修复（少留 907 ms） | `FoliaPlugin.readFrameRate()`、`Program.cs`、`HostForm.WriteFpsSample()`、`Shim.js` | —（同上） |
| **v0.4.10** | 未发布（本地测试） | **删「帧率」整条链路** + 新增「显示播放条」开关（默认开）+ 三处版本号定版 `0.4.10` | `preference_config.json`、`FoliaPlugin.kt`（`showPlaybackBar`）、`useInjectedSwitch.ts`、`PlaybackBar.tsx`、`HostForm.cs`/`Program.cs`/`Shim.js`（删帧率） | 仅**插件包** `spw-folia/build/libs/plugin-dev.spw.folia-0.4.10.spmod` 334,174 B（`Plugin-Version: 0.4.10`，97 条目 / 92 文件）；**尚未**组装可分发的完整 `.spmod`（`dist/release/` 无 0.4.10 产物） |
| **v0.4.11** | 未发布（本地测试） | **配置页重新分组**（播放页 / 诊断与日志 / 支持与反馈，各组独立 config 文件）+ 新增「显示问题反馈按钮」开关（默认关）+ 自检与版本对齐、纳入每次构建后复检 | `preference_config.json`（三组）、新增 `FoliaConfigGroups.kt`（旧值回退 + 一次性迁移）、`FoliaPlugin.kt`（`showProblemButton`）、`useInjectedSwitch.ts`、`App.tsx`、`packaging/tools/verify-diagnostics.mjs`、`build.gradle.kts`/`PLUGIN_VERSION`（定版 `0.4.11`） | **待测**（尚未组装完整 `.spmod`，无 bytes/entries/sha256 可记） |

**发布状态口径（别再搞错）**：表中 `未发布（本地测试）` / `local only` 的行**从未上传**，也**没有 tag**。
`v0.4.6` 是**最后发布**版本；`v0.4.6.1` 也在未发布之列。只有 `gh release list` 里能查到的 tag
才算发布（v0.1.5 / v0.1.8 / v0.1.11 也从未发布过，见对应行的备注）。
**体积趋势**：v0.1.x ~12.4–13.1 MB → v0.2.x ~13.15 MB → v0.3.0 13.18 MB →
v0.4.0-preview.1 **虚高 20.03 MB**（设置岛把 Folia 可视化注册表拉进模块图）→ preview.2 12.19 MB（瘦身）→
v0.4.3 12.22 MB → v0.4.5 12.23 MB（splice，payload 逐字节沿用 v0.4.3 的 `web/`+`native/`，只有
`classes/` 变了）→ **v0.4.6 12.48 MB（最后发布）** → v0.4.6.1 10.95 MB（web 侧再精简，未发布）→
v0.4.7 12.51 MB（上游 Folia 0.7.25 换新，未发布）。

**三个容易混的数字**：`docs/release.md` 附录里 v0.4.6 的 **3,912 文件 / 26.59 MiB** 是
**zip 内未压缩**口径（`web/` 3,820 + `native/` 5 + `licenses/` 7 + `classes/` 80）；
`12,476,192` 是 v0.4.6（最后发布）的 zip；`10,948,881` 是本地 v0.4.6.1 的 zip（未发布）。
staging 目录口径（`packaging/size-report.json`，未压缩、含未打包进 zip 的中间文件）数字更大，
不要和 zip 大小混用。

---

## §3 已完成的任务（按领域归类）

### 3.1 宿主注入（最难的一块，跨 6 个宿主版本）

- **「更多」菜单注入**：`hookMethod` 打在宿主 R8 混淆后的 item-adder
  （1.19.3 实测签名 `ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)Unit`），
  从 `MethodHookParam.args` 取 `MenuFlyoutScope` 反射调 `scope.item(onClick, content)`。
  **`appendContent` 方案在该 R8 构建上不可能**（宿主无 `MethodParameters` 属性，按参数名解析必失败）。
- **托盘右键入口（v0.4.0）**：hook `compose-native-tray` 的
  `RecordingComposableScope#snapshot()`（返回 `java.util.List<MenuOp>`，实现是 `ops.toList()`），
  插在末尾「连续 checkable ops 段」之后（= 「桌面歌词」那一栏）。
  实测顺序 `[显示主窗口, Divider, 桌面歌词, 锁定桌面歌词, **Folia**, Divider, 播放/暂停, 上一首, 下一首, Divider, 退出]`。
- **混淆名从「代码」变「数据」（v0.3.1）**：`HostTargets.PROFILES` 表 + `host-targets.json` 缓存 +
  一条「按形状扫描」兜底 → 用户不用每版换插件（但维护者仍需人工反编译）。
- **结构发现（v0.4.6，参考 SPW-Lyrics）**：用 JDK 25 `java.lang.classfile` API 解析宿主 jar
  （`app/ffmpeg-x64.dll`，伪装成 dll 的 **111 MB polyglot ZIP / 42,147 class**），
  建「方法体 → 调用点/字段访问」调用图，按 **6 个锚点**（Track / PiscesMediaItem / Navigator / State /
  scope / popupState）唯一发现目标。实测 `bodies=28058`、索引 **1.3–1.5 s**（每版本一次，结果缓存）、
  发现本身 70–92 ms、`quickLoad` 53–57 ms。
  **双路径交叉校验 8/8 完全一致**，6 个码点断言全 PASS（U+0266 / U+037F / U+0924 / U+037F / U+05DC / U+0529）。
  一句话：**宿主下次 R8 改名不再需要发插件版本**。
- **1.19.3 全量审计结论**：除「更多」菜单注入被改名破坏外，`PlaybackController` 7 个成员、
  `PlaybackQueueState` 5 个 getter、`PlaybackQueue$Mode` 4 个常量、queue item 类、
  `PiscesMediaItem` getters、`StateFlow.getValue`、palette accessor/colour、托盘 6 个目标 **全部 unchanged**。

### 3.2 播放数据与时钟

- **位置插值**：Workshop API 的 `onPositionUpdated` 只有 1 Hz，`PlaybackTimeline` 插值到 60 Hz，
  并从观测到的位置差学习实际播放速率（`PlaybackTimeline.kt` 有 rate 学习）。
- **切歌链路（v0.1.8 根因修复）**：两个门控叠在一起——歌词只在「曲目数据变了」时推，而曲目数据要等
  封面加载完才变 → 自动切歌后页面停在上一首。修法：歌词独立推送（每 100 ms 比对）、曲目探询 1 s → 200 ms、
  切歌瞬间发起封面加载（0.4 s 节流、按曲目去重）、大封面先缩到 512 px、页面侧封面未到时保留上一首配色。
  真机量化：`track(158B, cover=false)` → 2 ms 后 `lyrics(20875B)` → 0.18 s `cover ready 1085681→56553 B` →
  0.2 s `track(75608B, cover=true)`；大封面 998 KB → 39 KB。
- **逐字歌词（v0.4.2，issue #13）**：协议一直在发 `lines[].cells[]`，但页面 `toPublisherLyrics` 只映射
  `startMs/endMs/main/sub/id`，把 `cells` 整个丢了 → `buildLine` 永远走 `fallbackWords()`（整行按字符数均分）。
  修复：`useConfigPublisher.ts` 把 `cells` 1:1 映射成 `words[]`，无 cells 的行保留均分兜底。
- **播放控制通道（v0.3.0）**：`FoliaPlaybackControls.kt`（567 行 / 26 个反射句柄）映射宿主
  `PlaybackController` 的 `play/pause/playOrPause/previous/next/seekTo/changePlaybackMode/playMusicAt`；
  协议新增 `control`（页面→宿主→插件，白名单 5 个 action）与 `queue`（插件→宿主→页面）。
  mode 映射 `Circle→circle / CircleEnd→circle-end / RepeatOne→repeat-one / Random→random`。
- **队列**：`PlaybackQueueState` 混淆 getter `mode=\u037F()`、`normalQueue=\u0528()`、`normalIndex=\u0529()`、
  `randomQueue=\u052A()`、`randomIndex=\u052B()`、`readyToSave=\u052C()`；队列元素类是**顶层单字符类**
  `com.xuncorp.spc.core.queue.\u037F`（**不存在** `PlaybackQueueItem`）。

### 3.3 透明窗口与鼠标穿透（连踩三轮才收敛）

| 版本 | 做法 | 用户感受 |
| --- | --- | --- |
| v0.1.7 | WinForms `TransparencyKey` 色键 + `DefaultBackgroundColor=Transparent` | 真透明了，但**整窗鼠标穿透**，页面控件全点不到 → 加 `Ctrl+Alt+B` 逃生热键 |
| v0.1.8 | 加**不可见输入捕获窗**（alpha=1/255）跟随主窗、消息换算坐标后转发给 WebView2 输入子窗 | 控件能点了，但**整窗吃鼠标**，想点桌面得先退出透明 |
| v0.1.9 | 「鼠标穿透（操作桌面）」开关 + 页面上报热区 + 热区外「隐藏自己→合成一次真实左键→220 ms 后恢复」 | 能操作桌面了，但**合成输入只回放左键**，右键/滚轮/悬停被吞、拖拽必断、会被提权窗口/反作弊拦 |
| **v0.2.2** | **重写为 OS 级 shaped region**（借鉴 SPW-island）：捕获窗 `SetWindowRgn` = 页面热区并集（±4 CSS px 容差），区域外由 OS 原生穿透；窗口数减半；拖拽期间临时整窗 + `GetAsyncKeyState` 自愈；**fail-open**（热区缺失时宁可整窗可点） | 真穿透、零合成输入；`mouse_event` 回放 / 220 ms 恢复 / 逐点命中**全部删除** |

- **透明样式兼容（v0.2.0）**：三级分类 `native`(11) / `tuned`(tempera、lumiere、pendolo、still) /
  `unsupported`(monet、浅色主题的 lumiere)。不可适配 → 选该样式时**自动关闭透明+穿透**（产品侧降级，
  不是勉强适配）。色键是洋红 `rgb(255,0,255)`：**任何半透明底板都会与键色混合成粉红污染**，
  所以目标是「把大面积半透明底板去掉」而不是「调淡」。
- **凝彩透明遮挡（v0.4.2，issue #11）**：v0.2.0 的透明覆盖只关 `showBlocks`，但**不读该开关的图层**
  仍整屏遮桌面：片尾海报、段落擦除块、装饰/角标、镜头畸变、用户图片层。修复扩到 8 个键；
  片尾海报无 tuning 开关 → 在「透明 + tempera」时不发布 `song/songArtist/songAlbum`，海报不再构建。
- **透明背景快捷键（v0.4.0）**：SPW「快捷键管理」新增两条可重绑动作
  （`播放页透明背景：开/关` 默认 `Ctrl+Alt+G`；`+鼠标穿透` 默认 `Ctrl+Alt+Shift+G`），需 `key-bindings` 权限。

### 3.4 设置岛（注入式 React UI）

- **1:1 复用 Folia 自己的 React 组件**（不是仿制）：`vite.config.ts` 的 `foliaSettingsSurgery` 在构建期
  从 Folia 上游组件里**剥离无法生效的控件**（找不到标记就构建失败），**不改上游源码**。
- **真实预览（v0.1.6 → v0.4.1）**：v0.1.6 把静态样式帧换成真实渲染器；v0.4.1 进一步让预览框
  **逐帧镜像播放页**——同一个同源 iframe 渲染器、同一份播放页 config、同一条真实时钟，
  连「播放页透明背景」的透明效果都真实呈现；「预览文本」选项整个移除（连 `previewPlaceholderId` 字段）。
- **自定义字体（v0.4.0）**：导入字体包（`.ttf/.otf/.woff/.woff2`，单个 ≤ 50 MB）经 `FontFace` 注册进
  注入页并持久化到独立 IndexedDB `spw-folia-fonts`（**不用** `stubs/db.ts`）；系统字体列表由 Kotlin 侧
  用 AWT 枚举，随设置树下发 `systemFonts`（**不落盘**）。
- **随机样式池（v0.4.0）**：勾选的样式组成随机池，每换一首歌抽一种且不与上一首相同；播放面板骰子按钮
  当场重抽；随机池随导入导出与同步一起走（`randomVisualizerModes` / `randomVisualizerModePerSong`）。
- **播放条（v0.3.0）**：收起 pill（时间 + 细进度条 + 总时长）→ hover 150 ms 展开控制条；
  亚克力质感、2.6 s 闲置下滑隐藏；透明/穿透/设置打开时不渲染；按钮全部可点（v0.3.0 接上 control 通道后）。

### 3.5 诊断与可观测性

- **v0.4.2**：SPW 配置页新增「支持与反馈 → 出现问题」按钮 + 播放页右上角救生圈面板；
  `FoliaDiagnostics.kt` 检查 10 项；宿主 `BuildEnvReport()` 补原生进程侧信息。
- **v0.4.3**：`console.warn` group 三件套镜像、`open-log-folder` 路径语义修复、`catcher drag` 降 debug、
  新增 `ApplyRasterizationScale`（拖到不同 DPI 显示器时更新光栅化缩放）。
- **v0.4.6.1（诊断重写）**：核心规则一句话——
  > **只有证据能产生「缺失」；拿不到证据只产生「无法判定」，而「无法判定」绝不表述成缺失。**
  - 新增 `FoliaEnvironmentProbe.kt`（纯探测层）：每个事实返回 `Evidence(value, source, raw, error)`，
    **全部不抛异常**，子进程 3 s 上限；`Source` 枚举 `SYSTEM_PROPERTY/REGISTRY/CHILD_PROCESS/FILE_SYSTEM/RUNTIME_API/ENVIRONMENT/UNAVAILABLE`。
  - 重写 `FoliaDiagnostics.kt`（判定层）：`Verdict = PASS/FAIL/UNKNOWN/ADVISORY`；`missing` 只收 FAIL、
    `unverified` 只收 UNKNOWN、`healthy` 要求两者都为 0。
  - 修掉 6 类旧缺陷（详见 §4.10）。
  - 新增 `describeExitCode`：退出码翻译成用户能读懂的句子并 toast。
  - 新增 18 个单测（**用本机真实样本**：`os.version="10.0"`、`Release REG_DWORD 0x82718`、CRLF 行），
    其中一条专门钉死「`os.version="10.0"` → UNKNOWN 且**不是** FAIL」。
  - 真机 `gradlew runDiagnostics`：OS 检查从**必然 FAIL 变 PASS**，输出
    `Windows 11 (26H2, build 26300.9711), amd64`。

### 3.6 构建与打包

- **完整链路**（本机已跑通，见 §7）：
  `vite build`（Folia dist）→ `settings-ui` build → `host/build.sh`（csc）→ `gradlew plugin` →
  `build-package.sh`（stage web/native/licenses）→ `assemble-release.py`（合并成 .spmod）→
  `verify-layout.mjs`（干净解包 + 真实宿主 + 真实 WebView2 验收）。
- **兼容性发布 splice**：只改 `classes/` 时**禁止**用 `assemble-release.py`（staging 可能比已发布版本旧，
  会静默回退 web/helper）；必须用 `splice-compat-release.py` 以已发布产物为基线，逐字节保留非 classes 条目
  （3832 项 CRC 全一致断言），只替换 `classes/`（v0.4.5 实测 62 旧 → 67 新）。
- **包体瘦身**：`stage-web.mjs` 做 **settings-asset dedupe**（29 个文件 / 4.00 MB 与 `web/assets/` 逐字节相同
  → 改成 `/assets/…` 引用）+ **image-overrides**（4.67 MB → 1.39 MB 调色板 PNG / q88 JPEG）；
  `assetsInlineLimit: 0` + 默认代码分割会把资源数量放大一个量级（v0.4.0-preview.1 的 `settings/assets/`
  **1950 个文件 / 8.08 MB** 就是这么来的）。
- **WebView2 SDK 补齐**（v0.4.6.1 从零复现）：`https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2`
  → 9,818,548 B nupkg，版本 1.0.4314.35，解出 Core.dll(698,208) / WinForms.dll(38,752) /
  `runtimes/win-x64/native/WebView2Loader.dll`(**194,912**，与文档记录一致)。

### 3.7 合规、文档、站点

- **AGPL-3.0-or-later**（衍生自 AGPL 的 Folia），`packaging/licenses/` 固定 7 项：
  `AGPL-3.0.txt`、`AUDIO-MIT.txt`、`NOTICE.md`、`SOURCE-OFFER.md`、`THIRD-PARTY.md`、
  `WebView2-SDK-LICENSE.txt`、`WebView2-SDK-NOTICE.txt`。
- **`packaging/licenses/` 是生成目录**（`build-package.sh` 从 `licenses-src/` cp 覆盖）——
  改错地方下次打包被冲掉，必须改真源再 `cmp` 验字节一致。
- **文档体系**：每版本一份 `docs/archive/release-notes-vX.Y.Z.md`；`docs/release.md` 只作产物台账；
  新增 `packaging/tools/check-doc-links.py` 扫全部 markdown 本地链接（103 文件全通）。
- **宣传站** `site/index.html`（GitHub Pages）：14 张样式图必须来自真实 Folia 渲染器、按歌词相位
  确定性截图（2.2 / 6.2 / 10.2 / 14.2 s 各拍一张取最佳）；自绘背景的样式（tempera/monet）走不透明模式拍摄。
---

## §4 踩过的坑（12 类，165 条，**核心章节**）

> 每条格式：**现象 → 根因 → 解法 → 以后怎么避免**。
> 标 `未解决` 的表示当时没有定论；标 `（不确定）` 表示证据不足。

### 4.1 宿主反射与字节码解析（最高风险区，错了整个通道全灭）

**P1-1｜混淆类名写错不会编译报错，但运行时整个通道全灭**
- 现象：代码里 `Class.forName("com.xuncorp.spc.core.queue.PlaybackQueueItem")` 编译毫无问题
  （只是字符串），运行时必 `ClassNotFoundException` → resolve 永久 unavailable → **整个播放控制通道
  在真实宿主里全灭**。
- 根因：**不存在** `PlaybackQueueItem` 这个类；真实运行时类名是 `com.xuncorp.spc.core.queue.\u037F`
  （单字符 U+037F 的**顶层类**）。`PlaybackQueue$\u037F` 只是嵌套 lambda 类。
- 解法：`QUEUE_ITEM_CLASS = "com.xuncorp.spc.core.queue.\u037F"`；源码里用 `\u` 转义字面量写。
- **以后**：所有反射目标类名/方法名必须先在真实字节码上 `javap` 验证，禁止从设计文档或旧记忆抄；
  字符串常量要有静态校验（期望符号清单 + grep 陈旧引用）。

**P1-2｜「内部名 / 描述符」当「点分二进制名」用 —— 这个错误犯了两次**
- 第一次（v0.3.1 → v0.4.5 潜伏）：`menuCandidates()` 把 `ParsedClass.name`（`this_class` 的**内部形式**，
  `/` 分隔，如 `androidx/compose/ui/ɦ`）直接塞进 `MenuTarget.menuClass`。下游 `validateMenu()` 调
  `Class.forName()` 抛 `ClassNotFoundException` 被吞成 false → 日志自相矛盾：
  `host scan found no flyout helper (1206ms) (classes=42147 parsed=788 menuHits=1 paletteHits=3)`
  —— `menuHits=1` 明明找到了。**每版都有内置 profile，这条兜底路径从没真跑过**，1.19.3 改了三个类名才暴露。
  解法：`cls.name.replace('/', '.')`。
- 第二次（v0.4.6）：`discoverMenu` 里 `popupStateClass = dotted(popupStateType)`，而 `popupStateType` 是
  **描述符**形式 `Landroidx/compose/ui/ל;`，`dotted()` 只把 `/` 换成 `.` → `Class.forName("Landroidx.compose.ui.ל;")`
  必抛 CNFE，`dismissPopup` 永远拿不到 dismiss 方法，**且坏值写进 `host-targets.json` 缓存**（下次启动读回来同样失败）。
  解法：`popupStateClass = internalName(popupStateType)?.let(::dotted)`（先剥 `L`/`;` 再点分化）。
- **以后**：凡是从 descriptor / internal name 派生的类名，一律过「剥壳 → 点分化」两个**显式**步骤，
  并在验证脚本里断言「类名里不含 `/`、不以 `L` 开头、不以 `;` 结尾」。

**P1-3｜宿主 jar 的 zip 条目名不可信**
- 现象：`app/ffmpeg-x64.dll` 是伪装成 dll 的 polyglot ZIP（111 MB / 42,147 class），多个 entry name
  与其中 class 的 `this_class` 不符（如 `androidx/compose/ui/Ϡ.class` 里装的是 `…/ϡ`）。
- 解法：一律按解析出的 `this_class` 识别类；审计时逐条比对 entry-name 与 this_class
  （实测 0 处不匹配才敢说「全量可信」）。
- **以后**：任何字节码扫描脚本第一件事是读 `this_class` 而非 entry name。

**P1-4｜用「读 release 文件」判断 `java.lang.classfile` 可用性会误判**
- 现象：宿主自带 JRE 25.0.4.1，`release` 的 MODULES 列表**没列** `java.compiler`，但 jimage 里确有
  238 个 `java/lang/classfile/*.class`。
- 根因：`release` 的 MODULES ≠ 可解析模块集。
- 解法：直接引用 API 编译（插件 jvmTarget 25）验证。
- **以后**：模块可用性只认「编译通过 + 运行期能 new 出对象」，不认 release 文件清单。

**P1-5｜结构发现的候选不唯一 —— 参考实现照抄必失败**
- 现象：SPW-Lyrics 原版 builder 规则在 1.19.3 上给出 **15 个候选**（它只针对一个宿主版本，那里只有 1 个）。
- 解法：加 Track / PiscesMediaItem / Navigator / State / scope / popupState **六个锚点**才唯一；
  候选 != 1 就**抛 `IllegalStateException`（带角色名 + 每角色候选数）**，绝不做 best-effort。
- 为什么宁可抛：不对称后果 —— 挑错方法会**静默污染弹层**（用户看不到任何报错）；抛错只是一版缺项 +
  可读日志，且异常被捕获后退回 scan 层，不会让插件启动失败。
- **以后**：参考实现的结构规则必须在你自己的目标版本上重跑候选计数。

**P1-6｜1.4 s 索引不能进 `start()` 同步路径**
- 事实：真实宿主全量索引 1.3–1.5 s（实测 1313 / 1440 / 1506 ms，`bodies=28058`）。
- 解法：只在**后台线程**跑，且只在「未知版本匹配不到 profile」时跑；结果写 `host-targets.json`，
  之后 `quickLoad()` 53–57 ms 零字节码成本。`start()` 只跑缓存 + profile 两层。
- **以后**：性能红线写进文档，评审按这条卡。

**P1-7｜`Json.rawField` 不区分层级导致缓存键撞车**
- 现象：`host-targets.json` 里调色板键若叫 `palette`，会读到 `structural.candidateCounts.palette` 的
  数字而不是对象 → 缓存命中时**静默丢调色板**，回退成 profile 值。
- 根因：项目自带 `Json.rawField` 只取**第一个文本匹配**，不看层级。
- 解法：调色板缓存键改名 `paletteTarget`；读时兼容旧键，且要求值以 `{` 开头才当对象。
- **以后**：自研 JSON 取值器一律假定「扁平、首个匹配」，新键名必须全局唯一，不能与候选计数字段重名。

**P1-8｜`by lazy` 缓存「后台才就绪」的结果 = 时序 bug**
- 现象：`FoliaMenuItem` 的 `paletteAccessorMethod` / `paletteColorMethod` 用 `by lazy`；新流程下 palette
  要 1.4 s 后才解析，若首次组合发生在结构发现完成前（未知版本下**必然**），lazy 会把 `null` 永久缓存 →
  注入项颜色**永远**是兜底常量。
- 解法：改成 `PaletteCache(target, value)`，按 `HostTargets.palette` **实例**失效（同实例直接返回，
  实例变了重新反射；失败也缓存，避免每次重组重试）。
- **以后**：任何依赖异步解析结果的缓存，key 必须是「解析结果本身」，不是 lazy 的一次性初始化。

**P1-9｜hook 取参写死下标**
- 现象：`args[5]` / `args[2]` 硬编码，宿主参数表一变就取错。
- 事实：`addItemsMethod` 被 builder 规则强制为 **static**（`flags & 0x0008`），所以 `args` 与参数
  **1:1 对应、不需要减 1**（实测 `args[5].getClass().getName() == scopeClass`、
  `args[2].getClass().getName() == popupStateClass`）。
- 解法：改用目标里的 `scopeParameter` / `popupParameter`（1.19.3 实测 **5 / 2**），由 `validateMenu()`
  校验下标在界内且 `params[i] == scopeClass`；仍保留越界/null 防御。
- **以后**：hook 取参前先确认目标是 static 还是实例方法，再决定偏移，别凭经验减 1。

**P1-10｜R8 压缩后「同名」不代表「同一个方法」**
- 现象：`menuClass.getDeclaredMethod(labelMethod, …)` 抛 `NoSuchMethodException`。
- 根因：1.19.3 上 `labelMethod=Ϳ` 其实是 `com/xuncorp/voxzen/ui/component/‹U+052C›.Ϳ` 这个
  **BlurPopupMenu 内部 composable** 的名字，只是 R8 把整个文件的方法都压成同一个短名。
- 解法：当作可选字段降级 null，不当 facade 方法反射调用。
- **以后**：跨类同名是常态，必须按 owner + descriptor 双重锚定。

**P1-11｜混淆枚举的静态字段名不可用**
- 现象：`PlaybackQueue$Mode` 的静态字段名被混淆成 `Ϳ/Ԩ/ԩ/Ԫ`（`javap` 显示 `?`），按字段名取值必挂。
- 解法：只用 `Enum.name` + `enumConstants`（即 `values()` 顺序 Circle/CircleEnd/RepeatOne/Random = ordinal 0..3），
  绝不按字段名取值。

**P1-12｜自写 class-file 解析器的偏移写错**
- 现象：常量池计数在 **byte 8** 不是 byte 6；后续还有「属性计数偏移错误」，导致字节码扫描不可靠。
- 解法：重写成正确可复用的解析器并完整重跑语义分析。
- **以后**：解析 class 文件优先用 `javap` 做权威交叉验证（把类导出到目录再 `javap -v -p`），
  自写解析器只用于批量扫描，且必须与 `javap` 对同一类输出逐字节一致。

**P1-13｜从 polyglot jar 导出 class 的编码坑**
- 现象：同一批偏移在导出编码不对时对不上；用 UTF-8 重新导出后，正好在 PR #4 引用的偏移位置
  （343/349/352）得到完全一致的字节码。
- **以后**：导出 class 统一 UTF-8 并记录导出参数，否则偏移/字符串比对全部失真。

**P1-14｜用「非混淆类」当 code source 锚点会触发 native 库初始化**
- 现象：拿 `Track` 作 code source 锚点时触发 native 库初始化并失败。
- 根因：`HostTargets` 从不初始化宿主类，只需要一个 code source。
- 解法：换一个**纯 UI 类**作锚点。**以后**：只要 code source 就不要碰业务数据类。

**P1-15｜混淆名（含非 ASCII 码点）不要走命令行**
- 现象：用中文类名当命令行参数失败。**以后**：写进文件或代码里，不走 shell 参数。

**P1-16｜hook 前必须确认返回类型，不能假设**
- 实例：`RecordingComposableScope.snapshot()` 声明 `public final java.util.List<MenuOp>`，实现是
  `return ops.toList()`（`SnapshotStateList.toList`），**不是** `SnapshotStateList`。
- 做法：从真实宿主 jar 提取 class 后 `javap -p`，逐项确认可达性、构造器描述符参数顺序、类是否存在。
- **以后**：hook/反射契约的每条签名都附「javap 实测」证据；未证实的写「未验证」而不是当结论。

**P1-17｜反射不能在独立 JVM 里跑探针**
- 约束：宿主类依赖原生库（BASS），起独立 JVM 做反射探测会初始化失败。
- 替代：写小型 Java harness 挂到真实宿主 jar，在真实字节码上加载类并执行解析/合并逻辑
  （托盘注入就是这样 headless 验证的，`RESULT: PASS`）。
- **以后**：要么在真实宿主 JVM 内跑，要么只做静态字节码核对。

**P1-18｜宿主发版要审计**全部**反射目标，别只盯菜单**
- 1.19.3 审计结论：菜单三个类全改名（`घ/Ը/ะ` → `ɦ`/`ל`/`त`），**其余全部 unchanged**
  （`PlaybackController` 7 成员、`PlaybackQueueState` 5 getter、`PlaybackQueue$Mode` 4 常量、queue item 类、
  `PiscesMediaItem` getters、`StateFlow.getValue`、palette accessor `U+02B0.U+0528(Composer)→U+0374` 静态、
  palette colour `U+0374.U+0528()J` 11 个 MutableState 字段、托盘 6 目标）。
- **以后**：发版先跑「42,147 class 按 this_class 全量解析 + descriptor 逐项比对」的审计脚本。

**P1-19｜宿主 jar 的 `java.class.path` 只有一个条目**
- 事实：`app.classpath=$APPDIR\ffmpeg-x64.dll`，`java.class.path` 就是这一个 polyglot jar。
  结构发现优先用宿主类自己的 `codeSource`（`HostBytecodeIndex.read(hostClass)`），
  只在读不到时才退回 `java.class.path`。

**P1-20｜`validateMenu` 的扩展不能省**
- 加了两项：`scopeParameter`/`popupParameter` 在界内且类型匹配（防缓存被篡改的下标进 hook）；
  结构发现成功后与**仍能通过校验的 PROFILES** 逐字段比对，不一致打
  `WARNING ... trusting structural`（把「发现逻辑是否回归」变成一行日志）。

### 4.2 宿主进程与 stdin / 线程生命周期（错了表现为「第二次打开静默失效」）

**P2-1｜stdin 泵跨线程访问 WebView2 必崩（PR #3 / v0.1.11）**
- 现象：SPW 卡死/崩溃，日志有跨线程异常。
- 根因：Kotlin 侧在非 UI / 非 WebView2 线程直接调用；`sendLine` 同步写管道会阻塞。
- 解法：stdin 写线程 + 有界队列（容量 256）+ 逐行 catch + `stdinBroken` 标志 + `stdoutLogLock`。

**P2-2｜`cleanup()` 不中断停在 `pendingLines.take()` 的旧 writer = 确定性 blocking**
- 现象：Folia 窗口「关闭后重开」，第二次起 state/lyrics **全部静默丢弃**（页面无歌词、无状态）。
- 根因：桥实例被复用（`open()` 可在窗口关闭后再次调用，`stop()` 只在插件 disable/delete），
  旧 T1 永停在 `take()`；再 `open()` 时**共享队列**按 FIFO 唤醒旧 T1，hello 被它取走写进**已死管道**，
  其 `finally` 置共享 `stdinBroken=true` 并 clear 队列。
- 解法：每会话**独立队列** + `stopStdinWriter()` 身份守卫 + interrupt。
- **以后**：任何「长生命周期对象 + 短生命周期线程」的组合，队列和线程都必须按会话隔离。

**P2-3｜`cleanup()` 无 session/process 身份 → 旧 exit watcher 污染新会话**
- 现象：旧 helper 关窗后滞留、用户重开 → 旧 exit watcher 迟到触发，interrupt **新** writer / 清空
  **新** process → 新窗口静默冻结。
- 解法：`cleanup(reason, expected: Process?): Boolean`，在 `@Synchronized` 内先判
  `process !== expected` → 打 `"ignored: stale session"`、`return false`、**零状态触碰**；
  `if (cleanup(reason, source)) onClosed?.invoke(reason)`。
- **以后**：任何异步回调（exit watcher / stdout reader）都要带来源身份，不能闭眼改全局状态。

**P2-4｜`cleanup()` 非 `@Synchronized` 可与 `open()` 并发**
- 解法：`cleanup` 与 `open`/`stop` 共用生命周期 monitor，`process` 声明 `@Volatile`，身份比较在锁内。
- 复核结论：**无死锁** —— `@Synchronized` 从 `stop()` 调用是 JVM monitor 重入；
  锁序只有 `cleanup(monitor) → stopStdinWriter.join(500)` 与 `→ stdoutLogLock`，反向不存在；
  writer 线程 catch/finally 与 log 回调都不取桥 monitor。
- **以后**：任何「锁内 join/interrupt」都列出全部反向往返路径再放行。

**P2-5｜stdout 洪泛时宿主假死**
- 现象：暂停时 stdout 刷屏，旧 0.1.10 exe 11.2 s 只消费 **69 行**（冻结）；新 exe 6.0 s 消费 **194 行**
  （`floodMs=6013 sent=194 evals=97`），resume 后存活。
- 根因：同步读取/同步 eval 堵塞消息循环。解法：异步 stdout 读取 + 有界消费。

**P2-6｜「开窗→关→再开」循环验收是发布门禁**
- 0.2.0 发布时唯一硬性遗留：≥5 轮循环验收未做（已写入文档 §6）。这一条正是 P2-2/P2-3 的暴露场景。

**P2-7｜托盘菜单 hook 的 Compose 重组时机**
- 现象：SPW 的 `AppTray` 把菜单 lambda 记在 `remember` 里，插件晚加载后 Compose 跳过重组，
  改写的 `snapshot` 列表进不了原生菜单（日志 `build() items=9` 无 Folia 行）。
- 解法：hook `WindowsTrayMenuBuilderImpl.build()` 每次构建都补行 + 对已存在的 `WindowsTrayManager`
  强制 `update` 一次。
- **以后**：Compose 侧「改数据」≠「UI 会刷新」，必须有确定性原生补丁，不依赖重组时机。

**P2-8｜托盘点了不能关闭**
- 根因：只调 `openFolia()`（只开不关），再点等于又请求打开。
- 解法：改 `toggleFoliaWindow()`（`bridge.isRunning()` 真则关）；回调仍在自有 daemon 线程执行
  （`spw-folia-tray-click`）以免卡托盘消息循环。
- **以后**：托盘/快捷键这类入口默认做 toggle，不要做单向下发。

**P2-9｜去重扫描范围写小了会漏插一条**
- 现象：托盘注入后的去重只扫描「checkable op 所在的连续区段」，漏掉已位于该区段之后的同一条 → 重复项。
- 解法：去重范围改成扫描**整个** op 列表；用「同一 snapshot 注入 N 次后长度不变」作断言。

**P2-10｜批量写文件会静默 no-op**
- 现象：MANIFEST 还是 0.4.2、安装「看起来没生效」。根因：早先的批量写**静默没落盘**，`ls` 缓存掩盖。
- 解法：改成**逐文件写入 + 逐文件校验**。**以后**：批量覆盖安装目录后必须逐文件比对 hash/大小。

**P2-11｜原地替换 `plugin/classes` 而不换 `plugin.spmod` → 日志里扩展实例从 1 变 4**
- 中途误判：先怀疑自己多写了一层 `classes/classes/`；清理后**仍是 4 次**。
- 最终结论：宿主每次调用 `getPlaybackExtensions()` 都**新建实例**（PF4J 不缓存），与本次改动无关。
- 教训：只换 `classes/` 会让本地安装与 `plugin.spmod` 版本不一致；正确做法是重打完整包整体替换。
- **以后**：日志里「实例 N 次」先查宿主是否缓存，别急着归因自己的目录。

### 4.3 透明窗口与鼠标穿透（连踩三轮，用户每轮都真实踩到）

**P3-1｜色键透明窗口 = 鼠标穿透，页面控件全点不到（v0.1.7）**
- 根因：`TransparencyKey` + `DefaultBackgroundColor=Transparent` 的色键窗口天然穿透。
- 解法：常驻提示 + 逃生热键 `Ctrl+Alt+B`（备用 `Ctrl+Alt+Y` / `Ctrl+Alt+P` / `Ctrl+Alt+Shift+B`）
  恢复不透明，并把页面开关同步回「关」+ 持久化。

**P3-2｜「开了关不掉」—— 退出透明后宿主 `transparencyTarget` 未同步**
- 现象：热键/浮标退出透明后，再次开启无效。解法：退出时同步页面开关 + 持久化
  （`verify-transparent13.py` 9/9 PASS）。

**P3-3｜色键合成会丢 `backdrop-filter`**
- 现象：透明时面板/圆钮视觉变样。解法：用 `data-flat` 样式修掉依赖 backdrop-filter 的绘制。

**P3-4｜不可见输入捕获窗方案自带行为变更（v0.1.8）**
- 现象：透明窗口开始**接住**鼠标，不再点穿到桌面 → 用户无法操作桌面。
- 解法（v0.1.9）：加穿透开关；热区外「隐藏自己 → 合成一次真实左键 → 220 ms 后恢复」。
- **以后**：改输入路由一定要同时想「用户怎么回到桌面」，否则每版都要补逃生通道。

**P3-5｜合成点击回放的四个硬伤（v0.2.2 重写的动机）**
- 只回放左键，右键/滚轮/悬停被整吞；拖拽必断；合成输入会被提权窗口与反作弊拦截；
  `mouse_event` 在部分安全软件下被拦。
- 解法：OS 级 shaped region（`SetWindowRgn` = 页面热区并集，±4 CSS px 容差），区域外原生穿透，
  窗口数减半；拖拽期间临时整窗 + `GetAsyncKeyState` 自愈丢失的抬起事件；**fail-open**。

**P3-6｜WinForms `TransparencyKey` 会闪一帧洋红**
- 根因：设置色键会重建窗口句柄，重建期间有一帧未抠色的品红底。
- 解法：改 Win32 layered window（`WS_EX_LAYERED` + `LWA_COLORKEY`），并在设置品红背景**之前**装好色键。
- **以后**：透明/色键窗口不要用 WinForms 属性，直接用 `SetLayeredWindowAttributes` / 分层窗口 API。

**P3-7｜遮罩被主窗口盖住，动画「只在某些模式可见」**
- 现象：透明模式能看到动画、不透明模式看不到。根因：遮罩与 Folia 主窗都是 `TopMost`，
  主窗后显示就盖上去（透明模式中心被抠掉才漏出）。
- 解法：`SetWindowPos(HWND_TOPMOST)` 在 `OnHandleCreated` / `OnShown` / `OnActivated` 三处重新置顶。
- **以后**：多窗口 TopMost 叠层必须显式抬升，不能靠创建顺序。

**P3-8｜hitbox `rects` 是 stale 而非 empty（穿透失效的真根因，未解决）**
- 现象：鼠标穿透时好时坏；真机 **51 次运行里 46 次 `rects=0`**。
- 根因：120 ms settle < 180 ms CSS transition，且没有 `transitionend` / `ResizeObserver` 重报。
- 关键：`HostForm.cs:793` 零 rects 是 **fail-open = 整窗可点** —— 所以「穿透失效」的表现其实是
  「整窗吃鼠标」，不是「没上报」。
- 状态：审计给了根因与证据，但**当时未落地修复**（另一个更早的线索是 0.4.3 host 日志完全没有
  `transparency mode=on`，指向 host/settings ingress 路径）。
- **以后**：热区上报必须挂 `transitionend` + `ResizeObserver`，且 settle 时间要大于最长 transition。

**P3-9｜热区 `rects` 数量不是常量**
- 实测：3200×2000 窗口下 `bounds={0,0,3200,2000}`；`rects` 随面板开合变化（3 → 4 → 退出后 2）。
- **以后**：别在宿主侧写死数量。

**P3-10｜半透明在色键下变成粉红污染**
- 事实：真实透明窗用洋红 `rgb(255,0,255)` 作键色，任何半透明底板都会与键色混合。
- 结论：适配目标是「把大面积半透明底板**去掉**」，不是「调淡」。**色键方案下不要指望半透明。**

**P3-11｜lumiere 浅色主题被硬编码 alpha 地板卡死（怎么调都不变）**
- 现象：`{darkField:0,...}` 后 cov8 仍是 **100.0%**，与无补丁对照差 **0.0pp**。
- 根因：dist 里 `createLumierePixiRuntime` 用主题背景亮度 `Se(theme.backgroundColor) > 0.18` 判断，
  浅色 `#e8e4dc` 亮度 0.8952 → alpha 被 clamp 到下限 **0.94（实测 239–240/255，逐字节吻合）**，
  `darkField` 参数被吃掉。
- 解法：接受「浅色主题不可适配」，改用「使用该样式时关闭透明」的功能开关。
- **以后**：遇到「怎么调都不变」先怀疑代码里的 clamp / 地板，而不是参数没生效。

**P3-12｜tempera 真机透明仍有整屏不透明灰底板（未解决）**
- 现象：headless 透明变体下 cov8 只剩 3.8%，但**真机**透明模式下页面背景是
  `rgb(178,178,179)` 均匀不透明灰（std 仅 **0.5**，非桌面色；桌面本身深色均值 **28**）。
- 已确认：`showBlocks=false` + `postProcessVignette=0` 不足以去掉它；batch 内定位未完成。
- **以后**：headless 覆盖率只能当**必要**条件，样式底板类问题必须真机复验。

**P3-13｜调参下发被「整体替换」吃掉（与另一处记录冲突，需实测）**
- 一说：Folia `tuningRegistry` 的 `apply` 是**整体替换不合并** → 只传 `{showBlocks:false}` 会把其它
  tuning 字段清空 → 必须给完整字段对象。
- 另一说（Lead）：`*/tuning.ts` 都是 `switchOr(values.x, base.x)` 风格，部分对象即可。
- **结论：两处记录自相矛盾，未复核**。**以后**：下发 tuning 前用一次实测确认
  （下发 `{showBlocks:false}` 看其它字段是否被清空），别信文档描述。

**P3-14｜不可适配样式的产品侧降级清单**
- `monet` 不可适配；`lumiere` 在**浅色主题**下不可适配（深色可）；`tempera` 需 `showBlocks:false` +
  `postProcessVignette:0`（grain 可留 0.2）；`still` 需隐藏 `[class*="bg-[radial-gradient"]` 暗角；
  `pendolo` 需 `showCenterGradient:false`。

### 4.4 构建与打包流水线（错了装进去的是旧宿主 / 少了 18 KB）

**P4-1｜`packaging/native` 陈旧循环：装进去的是旧宿主**
- 现象：本地安装的宿主反复出现旧大小（152,576 / 160,768 / 161,280 / 164,864 B 之间来回）。
- 根因：安装脚本从 `packaging/native` 复制；`packagedNativeDir` 存在时构建优先用它，
  但 `plugin` 任务先跑，而 `packaging/native` 要到打包阶段才刷新 → 陈旧循环。
  另有 `spw-folia/build/plugin-root/host/` 由 Gradle `syncDevAssets` 生成，也需重建插件才更新。
- 解法：**先刷新 `packaging/native`，再构建插件**。
- **以后**：改宿主后核对**四处同源大小**：`poc/webview/host/build/*.exe`、`packaging/native/*.exe`、
  `spw-folia/build/plugin-root/host/*.exe`、安装目录 native。大小不一致就是流水线顺序问题。

**P4-2｜兼容性发布不能用 `assemble-release.py`（会静默回退）**
- 现象：只改 `classes/` 的版本，直接 `assemble-release.py` 拼出的包 **12,205,323 B**，
  比已发布 v0.4.3 的 **12,224,037 B** **少了 18,714 B**。
- 根因：仓库 `packaging/` 的 staging 可能比已发布版本旧 → web/settings/helper 被**静默回退**
  （`docs/release.md` 明确警告）。
- 解法：走 **splice** 流程 —— 以已发布产物为基线，逐字节保留 `web/native/licenses`
  （3832 项 CRC 逐一断言全同），只替换 `classes/`（62 旧 → 67 新），再 `verify-layout.mjs` 全 true，
  最后下载回验 sha256。
- **以后**：判断标准 = 本次是否只改 classes；是就走 splice，**禁止**用 assemble。

**P4-3｜splice 脚本把版本硬编码**
- 现象：`splice-compat-release.py` 把 `0.3.0 → 0.3.1` 写死在常量里，之后无法复用。
- 解法：改 CLI 参数 + 补 manifest 版本断言、权限断言、`.sha256`/`.json` 输出（提交 `7e6c2c0`）。
- **以后**：任何脚本里的版本号都从 `build.gradle.kts`/`MANIFEST` 读，不写字面量。

**P4-4｜`build.sh` 会改写 **tracked** 的 `DefaultConfig.json` 的 `updatedAt`**
- 现象：每次构建都产生脏 diff。解法：构建后还原该文件；Lead 集成构建时把它当预期 churn。
- **以后**：把这类「构建产物写回 tracked 文件」的副作用记进构建脚本文档，或提交前用 `git diff` 白名单过滤。

**P4-5｜发布前必须重跑构建并逐字节比对**
- 做法（v0.1.6）：用当前提交源码重跑 `stage-web.mjs` + `assemble-release.py`，产物与验证产物
  **逐字节一致**（同 sha `aacd02af…`）才发布。这条是「仓库源码可复现该 Release 资产」的证明。
- **v0.4.11 更正**：该条只在**宿主 exe 不变**时成立。`csc.exe`（.NET Framework 4.8 自带）不是确定性
  编译器，同一源码两次产出的 exe 有 51 字节差异（时间戳 + MVID + PDB GUID，长度相同）。装配本身确定
  （同一输入两次装配 sha 相同）。**结论：把「可复现」的判定口径从「整个 .spmod」改成「装配 + 插件包 +
  暂存树可复现，宿主 exe 不可复现」**，并在 release notes 里如实写明。

**P4-6｜`.spmod.json` 泄漏本机构建路径**
- 现象：`sourceSpmod` 含 `D:\输出目录\dsh2\...`（v0.2.2 起即存在）。结论：纯信息性、不影响完整性。
- 建议下个版本组装时剥离或相对化 —— **未修**。

**P4-7｜entry 数会随内容变化**
- 事实：v0.1.6–v0.2.0 是 **1941** entries，v0.3.0 起 **1943**，v0.4.3 **3894**，v0.4.6.1 **3907**。
- **以后**：文档/断言不要写死 1941。

**P4-8｜包体暴涨 54% 的原因链（v0.4.0-preview.1）**
- 数字：20,029,633 B vs v0.3.1 13,042,082 B（**+6.99 MB**）；解压 23.7 MB → 33.7 MB，文件数
  **1952 → 3925**；`web/` 22.37 MB(1898) → 32.16 MB(3854)；其中 `web/settings` **2.21 MB(15) → 11.53 MB(1966)**。
- 主因只有一个：v0.4.0 设置页要渲染样式图与「当前歌词预览」，把 Folia 的样式图/可视化注册表
  （连带 pixi/three 按样式懒加载）拉进设置页模块图，而 `vite.config.ts` 是 `assetsInlineLimit: 0` +
  默认代码分割 → `settings-ui.js` 1.04 → 2.14 MB，另产出 `web/settings/assets/` **1950 个文件 / 8.08 MB**。
  另有 29 张头像/图片与 `web/assets` **逐字节完全相同**（4.00 MB 白拷）。
- **以后**：设置页 bundle 里引入上游渲染器/样式图前先算体积账。

**P4-9｜瘦身时「改扩展名」的诱惑**
- 试过 WebP 能再省一点，但上游 JS 里有按扩展名探测的动态引用，改 URL 风险大于收益 → 放弃。
- **以后**：上游产物不要改文件名/扩展名，只能在 staging 阶段做「同哈希去重 + 引用改写 + 原位重压缩」。

**P4-10｜体积预算拿错口径 → 健康包也报 OVER（已修）**
- 现象：`size-report.mjs` 报 `26.19 MB vs 25 MB: OVER`，但用户下载的 `.spmod` 只有 11.9 MB —— 差一倍。
- 根因：预算卡在**解压后的暂存目录**上，而那是 zip 的 2.2 倍；25 MB 还是设置岛去重（P4-8）
  之前的阈值，之后从没同步过。
- 解法：拆成两个门限，各守各的。
  - `size-report.mjs` `budgetMB = 32`：暂存膨胀**警戒线**，只报告不中断（当前 26.19 MB + ~22% 余量，
    刚好能抓一次 P4-8 式回归 +54%/+7 MB）。
  - `assemble-release.py` `SHIPPED_BUDGET_MB = 16`：**用户下载体积**，超限 `exit 1` 中断（当前 11.93 MB）。
- **以后**：体积预算必须绑在**用户实际下载的那个文件**上；报告里写清口径（哪个目录、压缩与否），
  否则下一个人还会拿暂存量和 zip 比。数字对不上先看 `size-report.json` 的 `biggest`，别急着调大。

**P4-15｜插件原地重载后 `FoliaSettingsStore` 抛 `RejectedExecutionException`，且设置静默不再持久化**
- 现象：SPW 插件管理会 `stop()` 旧实例再 `start()` 新实例。重载瞬间 stdout reader 仍可能把最后
  一条 `settings` 投给**旧实例**，日志出现
  `stdout reader error: java.util.concurrent.RejectedExecutionException ... [Terminated, pool size = 0]`。
- 根因两层，第二层更隐蔽：
  1. `persist()` 在 `shutdownNow()` 之后仍向已终止的 executor 提交 `scheduleAtFixedRate`
     → 异常从 reader 循环里抛出来。
  2. `flusherArmed` 写在 **`companion object`** 里 = 全实例共享。旧实例置 `true` 后，新实例以为
     「已经排过 flusher」**永不再排**，本次会话剩下的设置**全部静默丢弃**（不报错、不写盘）。
- 解法：`flusherArmed` 改成实例字段；加 `@Volatile closed` 由 `shutdown()` 置位，`persist()` 里
  `if (closed || flusherArmed) return`；`scheduleAtFixedRate` 包 `try/catch RejectedExecutionException`
  并复位 `flusherArmed`。
- **以后**：任何带「排一次就够」状态位的懒启动逻辑，都别放 `companion object`/`static` ——
  宿主会原地重载插件，静态状态跨实例泄漏，表现为「功能不报错但就是不生效」。这是 §4.2
  「第二次打开静默失效」家族的一个新成员。

**P4-11｜`install-local.sh` 把版本号写死 `0.1.0`**
- 现象：安装目录名与产物版本不符。解法：改成版本可覆盖（参数/环境变量）。

**P4-12｜`research/` 是 gitignored，验收脚本与截图不入库**
- 影响：`v030-playback-controls-verify.mjs`、`v030-controls-*.png` 都不在仓库，后续会话无法复跑。
- **以后**：长期要复跑的验收脚本应放受控目录，或在文档里记录复现步骤。

**P4-13｜离线构建参数**
- `cd spw-folia && JAVA_HOME="C:/Program Files/Java/jdk-21.0.10" ./gradlew build -q --console=plain --offline`；
  `GRADLE_USER_HOME=/d/输出目录/dsh2/.gradle-home`；
  `--rerun-tasks` 用于证明「新文件可从零编译」。
- 版本环境：**Gradle 9.8 + JDK 25.0.2**（宿主 JRE 25.0.4.1）。

**P4-14｜Folia 源码树缺 `postcss.config.js` / `tailwind.config.js` → 全部 Tailwind 工具类静默丢失，预览塌成 270 px**
- 现象：设置页「预览」子帧只铺顶部一条 —— 渲染器高度 **270 px**，而 iframe 视口高 **1080 px**
  （1/4），用户描述为「预览框显示不全」。控制台无报错，`npx vite build` **exit code 0**。- 根因：Folia 的 `src/index.css` 第一行是 `@import "tailwindcss"`，它只在那两个构建输入存在时
  才会被 PostCSS 编译。上游源码树（AGPL，不随仓库分发）在本机重新落盘时丢了这两个文件，于是：
  产物 CSS 保留**字面量** `@layer utilities{@tailwind utilities;}`，`.h-full` / `.relative` / `.flex`
  等工具类**一条都不生成**。`h-full` 缺失让预览 iframe 的 100% 高度链断掉 → 子帧取默认/内容高度。
  实测（2026-11-01，同一份源码 tree，只差这两个文件）：

  | 条件 | 产物 CSS | 字节数 | `@tailwind` | `.h-full` |
  | --- | --- | --- | --- | --- |
  | 移走两个配置后重建 | `dist/assets/src-CqDxMIl7.css` | 29,630 B | 1 处 | 0 条 |
  | 恢复两个配置后重建 | `dist/assets/src-4dsYYV3J.css` | 214,737 B | 0 处 | 1 条（`.h-full{height:100%}`） |

  两次构建都 exit 0、都不告警 —— **这是静默失败**，所以必须由闸门兜底而不是靠人眼。
- 解法：
  1. 从上游 `chthollyphile/folia-major` tag **v0.7.22** 取回两个文件（逐字节核对 sha256 一致）：
     `postcss.config.js` = `fe78f76e…632e67f`、`tailwind.config.js` = `25074683…4e2614d2`；
     `gh api repos/chthollyphile/folia-major/contents/postcss.config.js?ref=v0.7.22 --jq '.content' | base64 -d`。
  2. `npx vite build` 重建，确认产物 CSS **> 200 KB**、含 `.h-full{height:100%}`、不含 `@tailwind`。
  3. `packaging/tools/stage-web.mjs` 新增硬闸（本次修复）：staging 后若 `web/assets/*.css` 里
     仍含字面量 `@tailwind`，或找不到 `.h-full{height:100%}`，直接 `throw` 并打印上面的修复步骤。
     已做三向验证：坏 dist → 抛错；只删字面量但工具类仍缺 → 抛错；正确 dist → 通过。
- **以后**：判断任何「预览框尺寸/布局不对」报障，**先量产物 CSS**，不要先怀疑 iframe 的
  `height` 或 WebView2 缩放。一条命令定位：
  `grep -c '@tailwind' packaging/web/assets/*.css && grep -o '.h-full{height:100%}' packaging/web/assets/*.css`。
  期望 `0` + 命中。
- 回归范围（2026-11-01 实测，逐个解包量过）：

  | 产物 | 包内 CSS | 字节数 | `@tailwind` | `.h-full` | 结论 |
  | --- | --- | --- | --- | --- | --- |
  | GitHub Release **v0.4.6**（已发布，sha256 `fc06fd07…`） | `src-CJUkOCnx.css` | 215,147 B | 0 | 有 | 正常 |
  | 本地 `dist/release/spw-folia-0.4.6.1.spmod`（未发布） | `src-CqDxMIl7.css` | 29,630 B | 1 | 缺 | **坏** |
  | 本地 `dist/release/spw-folia-0.4.7.spmod`（未发布） | `src-CqDxMIl7.css` | 29,630 B | 1 | 缺 | **坏** |

  即：**上游 v0.7.22 的正确构建是 215,147 B**，回归是我方本机重建时丢构建输入导致的，
  已发布的 v0.4.6 用户手里是好的；但 v0.4.6.1 与 v0.4.7 两个本地未发布包都带着坏 CSS，
  按本项目「未发布包不外发」的既有约束，**不要基于这两个包做 splice**，必须重建。

### 4.5 前端 / 设置岛 / 协议

**P5-1｜`Shim.js` 的 `state` 是 RAW 形状，不是秒制**
- 事实：`case 'state'` → `inputs.state = msg`（RAW `{posMs,durationMs,playing,rate,tsMs,lyricOffsetMs}`）；
  **只有** `clock` 被 `toClock()` 转成 `{currentTime, duration, playerState, sentAtMs, playbackRate, lyricOffsetMs/1000}`，
  且节流 ≥250 ms。注入 UI 若按秒制读会全错，必须从 `tsMs + rate` 自行插值。
- **以后**：消费 bridge 事件前先读 `Shim.js` 源码确认形状，不要按事件名猜单位。

**P5-2｜`openUrl` 的 payload 被 Shim 包了一层，宿主读不到平铺字段**
- 根因：Shim 把消息包在 `payload` 字段下（与 `control` 不一致）。
- 解法：在 Shim 里扁平化（与 `control` 一致）。
- **以后**：同一类「动作消息」的信封形状要统一，加新消息时先对照既有 `control` 的扁平化实现。

**P5-3｜`open-log-folder` 把「文件路径」当「目录」用**
- 现象：日志 `open-log-folder dir=…\spw-folia-host.stdout.log selected=False`，打开错误位置。
- 根因：面板传的是 `--log-file` 给的**文件**路径，宿主当目录用。
- 解法：传文件 → 选中它所属目录里的它；传目录 → 选中其中的 `spw-folia.log`；缺失路径报警告。
- **以后**：凡「打开/选中」类接口，先判断入参是文件还是目录，并打 `selected=True/False` 便于复核。

**P5-4｜只镜像 `console.warn` 会丢 PixiJS 弃用警告的正文**
- 现象：日志里只有 `console.warn: at bt (…createSonnetPixiRuntime…)` 堆栈，没有正文。
- 根因：PixiJS 弃用警告是三段式 `groupCollapsed('%c…%c%s', …)` + `warn(stack)` + `groupEnd()`。
- 解法：镜像 group 三件套，实现 `%s`/`%c` 占位符；标签单独成行，组内堆栈带「标签: 」前缀。
- **以后**：console 镜像必须覆盖 `log/info/warn/error/group/groupCollapsed/groupEnd` 全套并处理格式串。

**P5-5｜高频事件用 `info` 级会刷屏**
- 现象：透明模式下 `catcher drag=on/off` 刷了 **104 行**。解法：降 `debug`。
- **以后**：高频事件（指针/帧/热区变化）一律 `debug`；`info` 只留状态跃迁。

**P5-6｜协议信封只有 `name` 时，UI 按钮只能做禁用态**
- 事实：v0.3.0 的 action 信封只带 `name`，插件侧仅打日志，没有播放控制通道 →
  （实为 5 个）控制按钮走「禁用态 + 缺口报告」，**不硬造协议**。
- **以后**：先查「命令通道是否存在」再设计按钮；缺通道就明说缺口，不要伪造能力。

**P5-7｜iframe 是独立文档，主文档注册的字体不生效**
- 现象：改字体后预览框不跟随。
- 根因：字体只在播放器主文档 `document.fonts.add(new FontFace(...))` 注册。
- 解法：在 iframe 子文档也注册同一批字体，且**必须在首次下发 config 之前**
  （Folia 渲染歌词时会 `document.fonts.load(family)`，之后加进去不会重排）；新导入字体再注入 + 重发 config。
- **以后**：任何「子文档渲染同样内容」的功能都要单独注入字体/样式，并注意注入时机早于首次渲染。

**P5-8｜本地安装用裸 dist → 预览框永远「正在连接 Folia」**
- 根因两条：① 裸 `dist` 带 PWA `sw.js`，其 `NavigationRoute` 把 `/preview.html` 导航
  **重定向回 `index.html`**（iframe 跑的是 OBS 页面，无子帧垫片、无 token，EventSource 永远连不上）；
  ② 裸 `dist` 里没有生成的 `preview.html`、`_host/preview-shim.js` 和 `preview/` 占位封面。
- 解法：`build.gradle.kts` 新增 `stageDevWeb` 任务，本地安装也走生产同款 `stage-web.mjs`；
  `stage-web.mjs` 支持 `--report` 避免覆盖发布报告；清宿主 profile 里残留的旧 Service Worker。
- **以后**：**本地安装与发布包必须走同一条 staging 流程**，绝不直接拷上游 dist。

**P5-9｜缩略图缺失导致「样式图片乱码 / 预览黑框」（2026-11-01 用户反馈，未修复交付）**
- 现象：设置界面样式图片显示错误（用户描述为「乱码」）、预览框显示不全或不显示。
- 根因（已确证）：`poc/settings-ui/public/thumbs/` 被 gitignore 且**磁盘不存在** → 15 张样式缩略图 **404**，
  预览 fallback 也是同一批 404 → 黑框。
- 状态：会话中途截断，**未生成图片、未改构建**。待办：按 `site/assets/styles` + 真实截帧生成 15 张
  1440×900 q82 thumbs（含 `hanabi`），把生成步骤并入构建脚本；给 `StylePreview` / 样式卡加 `onError` glyph 兜底。
- **以后**：gitignore 掉的资源目录必须在构建期生成，不能假设磁盘上有。

**P5-10｜随机池「已有模型但没接线」**
- 现象：`settings.ts` 已实现整套池模型 + 快照往返，但 UI 点了会**抛异常**。
- 根因：stub 把 `useVisualizerStore` 别名到本项目 store，但 Folia `useRandomPool.ts` /
  `lyricStyleChoices.tsx` 调的是 `handleSetVisualizerMode` / `handleSetRandomVisualizerModes` /
  `handleToggleRandomVisualizerModePerSong`，本项目 store **没有**这三个名字。
- 解法：补 3 个 store 方法别名。
- **以后**：适配上游组件时先 grep 它调用的 store 方法名，逐个核对存在性。

**P5-11｜多代理同改一个文件必然冲突**
- 现象：`app.css` 在读取后被另一个代理改过，追加失败；`Stage.tsx` 被 Lead 中途收走。
  另一例：`previewSong.ts` 被子代理持有期间被队友加了两个 hook 但**漏了 import** → 类型检查失败。
- 解法：重读文件尾确认目标段落未被改动后再重试；Lead 用 SCOPE CHANGE 消息把文件移出任务范围。
- **以后**：跨代理共享文件按「谁拥有」明确划分；追加型编辑前重读文件尾；收尾必须核对
  「文件里有没有不是我的改动」。

**P5-12｜`edit` 工具把 `\\` 当字面量，导致 Kotlin 转义写重**
- 现象：插入的混淆名转义出现双反斜杠。根因：`edit` 不做转义解释。
- 解法：改回文件既有约定（30 个正确转义序列）；用 Python 直接数「0 个双反斜杠」确认。
- **以后**：改含 `\uXXXX` 的 Kotlin 文件，改完必须用脚本统计反斜杠数量；**不要**在含
  `\uXXXX`/反斜杠转义的源码上做 `sed -i`（`sed` 会吃掉反斜杠）。

### 4.6 上游 Folia 适配（v0.4.0 坑最密）

**P6-1｜新样式要同时改 4 处，漏一处就静默出错**
- 清单：① `styles.tsx` 加 entry（order/thumb/label/beat 效果）② `transparencyCompat.ts` 分类
  ③ 缩略图（`public/thumbs` + `dist/thumbs` 两份必须字节相同）④ i18n key。
- 漏掉的后果：`getStyleEntry('hanabi')` 会**静默返回 sonnet 的缩略图**，`PictureGrid` 选中环消失
  （`chosenAt = -1`）。
- 解法：`styles.tsx:219-241` 加**模块加载期不变量断言**（mode 集合或顺序与 `STYLE_MODE_SHELF_ORDER`
  不一致就 throw；从 `./settings` import **值**，无循环依赖）。
- **以后**：样式清单必须有「单一事实源 + 启动断言」。

**P6-2｜`server.mjs` 的 `MODES` 白名单硬编码会静默 coerce**
- 现象：`mode=hanabi` 静默回落 `sonnet`（`server.mjs:198`），缩略图生成器渲染出错误样式。
- 解法：`server.mjs:24` 加 `'hanabi'`（一行 diff）；并在脚本里**断言实际加载的 chunk**
  （如 `VisualizerHanabi-BIVczGX5.js`）而非只看页面是否 200。

**P6-3｜页面 URL 上的 `mode`/`transparent` 到不了服务端（SSE 只带 token、无 Referer）**
- 现象：无论传什么 mode 都渲染 `VisualizerSonnet`（或 stageBg 恒 `rgba(0,0,0,0)`）。
- 根因：SSE 客户端 `new URL('/obs/events')` 只 `set('token')`，**不转发 mode，也不带 Referer**
  （headless Edge 无 Referer）。
- 解法：在 Playwright 网络层 `page.route('**/obs/events*')` 重写 SSE URL 注入参数，不改 dist。
- **后果**：若不先验证参数是否到达服务端，**整批 14 样式探针数据都会作废**；
  连带发现：Oct-18 的 `out/styles/*.png` 批量帧很可能每个 mode 都是 sonnet fallback。
- **以后**：任何「URL 参数驱动」的探针，先 `page.evaluate` 验证参数真的到达服务端，再下结论。

**P6-4｜字体字段不在 `ObsBrowserSourceConfig` 里**
- 事实：`ObsBrowserSourceConfig` 只有 `lyricsFontScale` 与 `subtitleFontScale?`；
  `lyricsFontStyle`/`lyricsCustomFontFamily`/`lyricsFontFallbackFamilies`/`lyricsFontWeight`
  **不在**该类型，也不在 SSE publisher —— 它们只存在于 OBS URL 的 `cfg` blob。
- **以后**：想加字体能力先确认走哪条 surface（SSE vs cfg-shortcode），两条通道字段完全不同。

**P6-5｜cfg overlay 上 `theme.fontFamily` 会被抹成 undefined**
- 事实：`buildVisualizerTheme` 在 cfg overlay 路径把 theme 的 `fontFamily` 覆盖为 `undefined`
  → 只设 `config.theme.fontFamily` 永远不渲染；SSE overlay 的 theme 原样透传，那边才有效。

**P6-6｜`'custom'` 不是合法的 `Theme['fontStyle']`**
- 事实：`Theme.fontStyle` 只接受 `'sans' | 'serif' | 'mono'`；`'custom'` 是 UI-only 的
  `PresetOption` 值，选中它**不持久化**（只打开字体选择器），store 会把它折回 `'sans'`。
- 真正的解析器 `resolveThemeFontStack` 不是 `custom ? fallbacks : builtin` 三元，
  而是**按 family 是否存在**把 `fontFamily`/`fontFamilyStack` 前置到内置栈。

**P6-7｜OBS 页面从不加载字体二进制**
- 事实：`restoreUploadedLyricsFont` 只从 `useAppPreferences` 调用，没有任何 OBS root 挂载它；
  bootstrap 里**零** `FontFace`/`document.fonts` 代码；生产者故意丢弃上传字体族。
- 结论：它假定已有 `@font-face` 或系统已装字体，只负责输出 CSS `font-family`。
- **以后**：自定义字体要么走系统字体，要么自己注入 `@font-face`。

**P6-8｜预览文本不是「一段示例字符串」**
- 事实：上游「预览文本」是 `Segmented` 选择哪个**占位歌曲**（title + cover + 歌词行 + loop 时长）；
  上游只有 `'default' | 'reserved'`，**没有**「当前歌词」这个 i18n key。
- 解法：在 **settings-ui 自己的** `PreviewPlaceholderId` 联合类型里加 `'current'`
  （面板 import 的是上游类型，用 `as never` 强转保持 `work/folia` 不被改），新增 `model/liveLyric.ts`
  （`useCurrentLyric` = `bridgeOn('lyrics')` + `usePlaybackClock` + 250 ms 活动行选择 + `- lyricOffsetMs`），
  把捕获的行重定基准到 `startMs:0` 短循环。
- **以后**：上游只读时，扩展点在自有类型层做类型扩宽 + 断言，不改上游。

**P6-9｜Folia 的 i18n 会二次初始化，丢弃我们的 overlay 资源**
- 现象：本地 i18n overlay 键渲染成**原始键**（如 `options.randomVisualizerReroll`）。
- 根因：Folia 自带的 `i18n/config.ts` 也被打包进来（0.7.22 的可视化模块会 import 它），
  它在我们的 `init()` **之后**重新初始化 i18next，丢掉我们的资源。
- 状态：本批只到「先修这个问题」的叙述，**无最终 diff 证据**（不确定）。

**P6-10｜`styles.mjs` 的 hanabi 帧其实全是 sonnet**
- 证据：meanAbsDiff 38.1 vs sonnet、67.1 vs 真 hanabi。根因同 P6-3。

**P6-11｜透明探针的单帧结论不可靠**
- 现象：同一样式不同次采样 meanAlpha 145.9 vs 234.9；tempera-c 第 1 帧 cov8 11.4% 误判不合格。
- 根因：抓在 intro transition 上。
- 解法：每 case 跑 **8 帧**、用中位数判定，并记录波动（实测 8.9pp）。
- **以后**：任何动画型 UI 的度量都取多帧中位，不要用首帧。

**P6-12｜`cov8` 数字被误读为「很脏」**
- 现象：tempera cov8 3.8% 看似比 classic 3.5% 差。
- 根因：cov8 把 alpha 1–32 的淡雾也算进去了，而色键能吃掉 1–32、只有 >64 才是肉眼实体。
- 解法：改看强度分带（1-8/9-32/33-64/65-128/129-192/193-254/255），tempera 的 >64 实体只有 2.0–2.6%。
- **以后**：覆盖率必须配强度分带，否则结论会反。

**P6-13｜`still` 的 CSS 隐藏把整屏都藏了**
- 现象：`.visualizer-still > div:first-child` 命中的是 `display:contents` 包装层，隐藏后连歌词文字一起消失。
- 解法：先 `page.evaluate` 导出 `.visualizer-still` 完整子元素列表（index/tagName/className/rect/
  childElementCount/textContent 前 40 字）再选选择器；最终用
  `.visualizer-still div[class*="bg-[radial-gradient"]`（实测命中 1 个元素，cov8 99.8%→0.6% 且文字保留）。
- **以后**：改 CSS 前先 dump DOM，不要凭类名猜层级。

**P6-14｜单层消融会误判「多层叠加绘制」与伪元素**
- 现象：pendolo/monet 消融反常、monet 无单层覆盖 ≥25%。
- 解法：改**累进式消融** + 伪元素检测，并允许 `distribution` 分支把 culprit 记为「分散覆盖」。
- **以后**：先做层清单（tag/class/rect/计算样式 background），再决定消融顺序。

**P6-15｜「整屏半透明」判定口径不一致**
- 现象：monet 覆盖率只有 22.9% 却曾被描述成 "full-screen fill"。
- 解法：把「分散覆盖」与「全屏 canvas 稀疏绘制」分开表述。**以后**：结论必须带数字，不写形容词。

**P6-16｜改探针返回结构必须同步搜全部消费点**
- 现象：消融返回结构从 `{layers}` 改为 `{baseline, steps}` 后 `classify()` 仍读 `ab.layers` → 崩溃。

**P6-17｜`--demo` 的 config 被 settings-ui 的 `pushConfig` 覆盖**
- 现象：真机单独跑 host 时页面没收到 `lyrics` 事件，`still` 真机截图看不到歌词，误以为样式坏了。
- 解法：验证脚本里显式注入 `lyrics` 事件后重跑 6 个用例。
- **以后**：验证只有文字的样式必须显式注入歌词，别信「画面是空的 = 样式问题」。

**P6-18｜`poc/hook` 硬编码 1.19.0 商店版路径**
- 宿主换版即失效。**以后**：逆向脚本的宿主路径走参数/探测，不写死。

### 4.7 诊断与自检（v0.4.6.1 的中心战场）

**P7-1｜`System.getProperty("os.version")` 在 Windows 上只返回 `"10.0"`（**无构建号**）**
- 现象：在完全正常的 Windows 11（build 26300）上点「出现问题」弹红色 toast：
  `缺少运行环境：Windows 10 x64（1809+）（Windows 11 10.0 amd64）→ 需要 64 位 Windows 10 1809 (17763) 或更新版本`
  —— **这个检查在任何机器上都不可能通过**。
- 根因：`FoliaDiagnostics.osCheck()` 从 `os.version` 取构建号，用 `Regex("(\\d+)\\.(\\d+)\\.(\\d+)")` 解析；
  但 **HotSpot 在 Windows 上把 `os.version` 报成 `"10.0"`**（两段、没有构建号；构建号在注册表
  `CurrentVersion\CurrentBuildNumber`）。正则永不命中 → `build = null` → `is64 && build != null && build >= 17763` 恒 false。
- 本机实测（取证 1059 行报告）：`os.version="10.0"`（长度 4）、`CurrentBuildNumber=26300`、`UBR=9711`（0x25ef）、
  `ProductName="Windows 10 Pro for Workstations"`（Win11 上仍写 10）、`DisplayVersion=26H2`、
  CIM `Caption="Microsoft Windows 11 专业工作站版"`（唯一明写 11 的官方来源）、
  `[Environment]::OSVersion.Version.Revision` **恒为 0，不是 UBR**。
- 解法：Windows build 必须读注册表 `CurrentBuildNumber`（UBR 读 `UBR`）。
- **以后**：**绝不用 `os.version` 判断 Windows 版本/构建号**；这是本机 JDK 25 的实测事实。

**P7-2｜「读不到」和「版本太低」被压进同一个 `false` —— 这是所有误报的母体**
- 现象：用户机器没有任何问题，却被表述成「你的系统太老，去升级」。
- 根因：判定式把「读不到」与「不达标」合并成一个布尔。
- 解法：判定从二态（`ok: Boolean`）改成**四态**（`PASS/FAIL/UNKNOWN/ADVISORY`），并把规则收敛成一句话：
  > **只有证据能产生「缺失」。拿不到证据只产生「无法判定」，而「无法判定」绝不表述成缺失。**
- **以后**：任何「检查/自检/健康度」类判定，一律先问「读不到时算失败吗？」，若答案是「算」就是 bug。

**P7-3｜同源的 4 处错误（都在同一批代码里）**

| # | 旧实现 | 后果 |
| --- | --- | --- |
| 1 | `.NET Release` 无条件剥掉 `0x` 再按十六进制解析 | 十进制 `528040` 被算成 `0x528040`（5406784），反之亦然 |
| 2 | `reg.exe` 失败与被查询值不存在都返回 `null` | 「未安装」被套在「读不到」上 |
| 3 | 注册表名匹配用 `line.contains(name)` | `Release` 会匹配到更长的值名 |
| 4 | `isPermissionGranted` 是接口默认方法、恒返回 `false` | 「宿主不支持查询」被报成「缺少权限」 |
| 5 | 5 个缺失项连发 5 条错误 toast | 真正的错误被淹掉，用户学会忽略它 |

- **`reg.exe` 的 DWORD 打 `0x82718` 才是 hex**：实测 `Release` 行原始 35 字符
  `    Release    REG_DWORD    0x82718`，分隔符是**恰好 4 个半角空格 0x20、无 TAB**，行尾 CRLF。
  `line.trim().split(Regex("\\s{2,}"))` → `["Release","REG_DWORD","0x82718"]`，size=3。
  解析实测：`Long.parseLong` 抛 NFE；`Integer.parseInt(v,16)` 抛 NFE（radix16 不吃 `0x`）；
  `Integer.parseInt(v.substring(2),16)` → **534296** ✅；`Integer.decode(v)` → 534296 ✅。
- 两个边界（实测）：① **空行 split 得 `[""]` size=1，不是空数组**；② 若只剥前导空格、行尾残留 `\r`，
  最后字段变 `"0x82718\r"`（末字符 codepoint 13）→ **所有十六进制解析全部 NFE**。
- **以后**：注册表值必须按 `REG_SZ` / `REG_DWORD` 类型标记解码，不能「统一剥 0x 按 hex 读」。

**P7-4｜前端同源缺陷：`Number(report.dotnet)` 把 `null` 变 `0` → 必然 fail**
- 位置：`ProblemReportPanel.tsx`。`'0.0.0.0'`（WebView2 的「未安装」回答）也需判 fail。
- 解法：四态重写，每条规则拆成独立纯函数 `judgeWebView2 / judgeDotNet / judgeNative / judgeAsset /
  judgeOs / judgeAudio / judgeLogging`，`buildChecks` 只做组装；`data-verdict` 供样式表用，
  `data-ok` 保留但只有真 fail 才是 `false`。

**P7-5｜C# 侧 `null` 不带原因，面板无法报「无法判定」**
- 解法：`HostForm.cs` 的 `BuildEnvReport` 新增 `windowsBuild` / `windowsRevision` / `windowsVersion` /
  `webView2Error` / `dotnetError`；`ReadDotNetRelease(out error)` 与 WebView2 版本读取都带失败原因
  （`ex.GetType().Name + ": " + ex.Message`）。

**P7-6｜权限检查在非插件运行态恒 UNKNOWN**
- 真机现象：3 项权限检查 UNKNOWN，原因是
  `UninitializedPropertyAccessException: lateinit property instance has not been initialized`
  —— 这是「非插件运行态」的正确表现，**不是 bug**。

**P7-7｜C# 保持 C# 5 语法**
- 约束：in-box `csc.exe` v4.0.319 只支持 C# 5 → 不用字符串插值、不用 `?.`、不用 `out var`。
- **以后**：动 `poc/webview/host/*.cs` 前先确认编译器版本。

**P7-8｜自检入口签名是契约**
- `preference_config.json` 的 `on_click` 指向 `dev.spw.folia.FoliaPlugin.onReportProblem`
  （`@JvmStatic @JvmName`，无参）；重写只加参数（`hostPid`），**不改名字**。

**P7-9｜软依赖一律 ADVISORY**
- 远端会话 / 音频采集 / 日志管道 / 无运行中的 Folia 窗口 —— 永不进 `missing`，也不阻止打开反馈页。

**P7-10｜测试必须用本机真实样本**
- `FoliaDiagnosticsTest` 的样本取自本机真实输出（`os.version="10.0"`、
  `Release REG_DWORD 0x82718`、CRLF 行），不构造理想值；并有断言
  「`os.version="10.0"` → UNKNOWN 且**不是** FAIL」专门钉死这个回归。

**P7-11｜测试源码集缺依赖的三个连锁坑**
- ① `kotlin-stdlib` 主源用 `compileOnly`，测试需要真实依赖；
- ② Compose 编译器插件也作用于测试源集，需把 Compose runtime 加进测试类路径；
- ③ `PluginPermission` / SPW API 只在 compileOnly 里，测试运行时需要 → 最后改成纯函数式渲染逻辑，
  使测试不依赖宿主 API。
- 附带：16 个测试首跑 3 个失败，**全是测试自己写错了**（4.7.2 的十六进制值写成 461808=0x70BF0，
  实际是 0x70C30）；断言 `missing=webview2,` 后面跟 ` unknown=` 属正常分隔。

### 4.8 验证方法论（假阳性 / 误判 / 结论反了）

**P8-1｜ctypes 不设 `argtypes` 会符号扩展 → 「旧版居然通过」的假阳性**
- 现象：写探针投递 `wparam=0xFF880000` 给旧二进制，旧版「通过」，与已确认的必崩事实矛盾。
- 根因：`ctypes.PostMessageW` 不设 `argtypes` 时按有符号 32 位 int 封送 `0xFF880000`，
  再符号扩展成 `0xFFFFFFFFFF880000` —— 这正是**不抛异常**的形状；真实滚轮消息是零扩展的
  `0x00000000FF880000`。
- 解法：探针显式声明 `argtypes` / 用 64 位无符号值，先打印到达的 `wparam64` 形状再断言。
- **以后**：任何「用 ctypes 复现 Win32 消息」的验证，第一步先打日志证明「到达的参数形状」与真实一致；
  A/B 里旧版不崩 ≈ 探针错了，不是结论错了。

**P8-2｜滚轮下滚必崩：`IntPtr.ToInt32()` 在 x64 上是受检窄化转换**
- 现象：透明 + 穿透时向下滚轮触发 `System.OverflowException: 算术运算导致溢出`，
  WinForms 弹 `Microsoft .NET Framework` 对话框后进程退出；**上滚从不崩**。
- 根因：`TransparencyInputCatcher.Forward()` 用 `m.WParam.ToInt32()`；x64 .NET Framework 上
  `IntPtr.ToInt32()` 是**带溢出检查**的窄化转换（与 `/checked` 无关），而 Win32 投递的消息参数是零扩展的：
  `WM_MOUSEWHEEL` 下滚 delta=-120 ⇒ `0xFF88xxxx`，bit31 置位 ⇒ 超 int 正数范围。
- 解法：所有消息参数改 `unchecked((int)x.ToInt64())`；`Program.Main` 注册
  `Application.ThreadException` + `AppDomain.UnhandledException`，崩溃改为写 `level=error` 日志。
- A/B 对照：旧版 `THREW OverflowException`，新版 `RESULT: PASS` 15/15；旧版必弹顶层对话框
  标题 `Microsoft .NET Framework`、尺寸 438×287；新版 0 新窗口、0 error。
- **以后**：宿主 WndProc 里读任何 `WPARAM/LPARAM` 一律走 `unchecked((int)x.ToInt64())`，**不要**用 `ToInt32()`。

**P8-3｜「dpr=1 画面被拉伸模糊」是误判 —— 先证伪再下结论**
- 现象：日志 `page-viewport w=1776 h=1110 dpr=1 canvases=1 client=3200x2000`、`winDpi=173`，
  看起来 CSS 视口被拉伸到 3200×2000 导致模糊。
- 实测排除：`RasterizationScale` 本来就是 **1.802**（与 173 DPI 匹配）；`3200/1.802≈1776`、
  `2000/1.802≈1110` —— CSS 视口正是按 1.8 倍光栅化的结果；默认 vs `--force-dsf 1`
  （CSS 1920×1200、dpr=1.667）两组**逐像素梯度能量 3.183 vs 3.049**，基本相同。
- 结论：`dpr=1` 是 WebView2 用 RasterizationScale 在合成层缩放的正常表现，**不是缺陷，没有「修」它**；
  但新增 `ApplyRasterizationScale` 有意义 —— 拖到不同 DPI 显示器后原代码只更新 `Bounds` 不更新 scale，
  那才真会模糊。
- **以后**：DPI/清晰度类怀疑先做「逐像素梯度能量」对照实验再下结论；
  `RasterizationScale` 与 `devicePixelRatio` 是两个独立量，不要混为一谈。

**P8-4｜「dpr=1」与 `RasterizationScale` 的关系要写进契约**
- `docs/protocol.md` §8 已记录该要求，避免下一轮又被当成 bug 重查。

**P8-5｜截图抓到的是 DSH GUI 而不是 SPW**
- 现象：截屏内容不对（SPW 不在前台）。解法：先 focus 目标窗口；若 SPW 窗口消失则查进程状态。
- **以后**：截图前断言前台窗口标题/进程。

**P8-6｜自动化点击会改掉用户设置（不是 bug 但会误报）**
- 现象：两次出现歌词样式被切到「流光」（0.1.9）或别处（0.1.7）。
- 根因：自动化点击落在设置项上，真实改了持久化设置。
- **以后**：自动化脚本点 UI 前先记录设置快照，跑完回滚；验收报告要提示「设置可能被自动化改动」。

**P8-7｜验证脚本自身拿「尾字符」和「完整点分名」比较，误报 4 个 MISMATCH**
- 根因是脚本 bug 不是代码 bug。**以后**：期望值的形态必须与实测值的形态显式对齐，
  先用一个已知正确的样例（如 lumiere）自检脚本。

**P8-8｜`verify-layout.mjs` 是发布门禁，数字要记档**
- 门禁：`pass=true`（10/10 或 11/11）+ `consoleErrors=0` + fps 中位 ~116 + spawn→ready ~850 ms，
  **真实宿主 + 真实 WebView2**，不用模拟。
- 0.4.6.1 实测：`consoleErrors: 0`、`hasUi/hasBridge/uiApi: true`、`canvases: 3`、
  `settingsScripts: 1`、`avatarAssetStatus: 200`、截图 85,128 / 848,274 B。

**P8-9｜验证分级必须写进文档**
- 三级：离线验证（编译 + 单测 + 字节码双路径）/ 真机验证（装进 SPW 打开）/ 用户验收。
- 事实：0.4.6 的 release notes 第一句就是「离线验证，未做真机端到端」，全文无「用户已确认」。
- **以后**：未做真机的必须在第一句声明，不能包装成「已验证」。

### 4.9 环境与工具链（Windows / ACL / 编码 / tsc）

**P9-1｜工作区 ACL 不属于当前用户 → DSH 连 `pwd` 都起不来**
- 现象：bash 与 PowerShell 都被同一个问题挡住 —— DSH 在**准备环境**阶段就拒绝，
  报「工作区的 Windows 文件权限不对 / 工作区不属于当前用户」；连未受限命令也不执行。
- 诊断证据（`spw-folia-acl-recovery/acl-report-*.jsonl`）：owner 是 `S-1-5-32-544`（Administrators 组），
  调用者 token 是 High 完整性，路径 ACE 里**没有 package allow**、且 WRITE_DAC/WRITE_OWNER 都可用
  → 分类结论 `NOT_THIS_CLASS` / `repair skipped`（**不需要 ACL 修复**）。
- 解法：用户手动改成完全权限后 shell 恢复。
- **以后**：遇到「连 `echo` 都跑不了」立刻判断是环境准备层而非命令层，走 `diagnose-windows-sandbox-acl`，
  不要在 bash/pwsh 之间来回换。

**P9-2｜中文路径让 `ReflectionOnlyLoadFrom` 失败**
- 现象：在 `D:\输出目录\dsh2` 下用 PowerShell 5.1 反射读程序集元数据失败。
- 根因：中文路径在 GBK 误解码下损坏。
- 解法：先把 DLL 复制到纯 ASCII 临时路径 `%TEMP%\spw-native-ascii\` 再加载。
- **以后**：Windows 上任何反射/PE 解析/老工具链，一律先在 `%TEMP%\<ascii>` 下工作。

**P9-3｜终端乱码被误判成「写坏了」**
- 现象：`host-targets.json` 里中文显示成 `�˵� facade ��`。
- 根因：harness 的 **GBK stdout** 显示问题，文件本身是干净 UTF-8
  （`菜单` 的 UTF-8 字节存在、无 U+FFFD、无 BOM）。
- 解法：做二进制校验（字节 / 替换字符 / BOM 三项）而不是看终端。
- **以后**：中文乱码先怀疑终端编码，用字节级校验定案。

**P9-4｜`UnicodeEncodeError: 'gbk' codec can't encode character '\u1001'`**
- 现象：Python 打印混淆名（U+1001 等）时崩。解法：显式 UTF-8 输出 / 写文件。

**P9-5｜`re.PatternError: bad escape \u`**
- 现象：Python 正则里写 `\u` 被当转义。解法：用 `\\u` 或原始字符串。

**P9-6｜TS 7.0.2 移除 `baseUrl` 导致 `tsc` 直接退出（TS5102）**
- 现象：`tsc` 无输出地失败，看起来像「0 诊断」；`pnpm build` 却通过。
- 解法：用临时 tsconfig（只删 `baseUrl` 行）单独跑类型检查；或用固定版本
  `npx -p typescript@5.9.2 tsc --noEmit`。
- 临时配置的坑：被自己的 bash 删掉后再复用会失败 → **一次性临时配置文件用带序号的唯一名**。
- **以后**：`tsc` 无输出 ≠ 通过，要确认它真的跑了；sanctioned gate 是 `vite build`。

**P9-7｜既有类型噪声 vs 自己引入的错误**
- 事实：`tsc` 范围内 9 个错误看着像回归，实际全在改动 hunk 之外（用 `git diff` 逐行核对）；
  `Stage.tsx:54` 是 `PublisherInputs` 缺 `lyricOffsetMs`/`playerState` 的既有问题。
- 基线数字：settings-ui 范围内 **9** 个既有错误，全量 **799**（后降到 47，全部来自缺失的 gitignored `work/`）。
- **以后**：报告类型错误前先用 `git diff` 判定归属；把「既有错误基线数量」记档，新增错误数才是判定标准。

**P9-8｜`struct.py` 这个文件名遮蔽了标准库模块 `struct`**
- 现象：脚本 import 失败。**以后**：脚本文件名不要与 Python 标准库模块同名
  （`struct`/`json`/`types`/`token` 都是高危）。

**P9-9｜Python 文件里写了 `/* */` 注释**
- 现象：语法错误。**以后**：跨语言写脚本前先确认注释语法。

**P9-10｜脚本重写文件会引入 CRLF**
- 现象：用 Python 重写 `docs/architecture.md` 后整文件变 CRLF → 全文件虚假 diff。
- 解法：归一化回 LF（仓库约定 LF + 末尾一个换行，写在 `.editorconfig`）。
- **以后**：脚本改文档必须显式 `newline='\n'`；批量重排后跑一次行尾检查。

**P9-11｜`path.join` 返回反斜杠而站点常量用正斜杠 → 静态服务器 404**
- 解法：路径比较前统一分隔符。

**P9-12｜Playwright 模块解析以脚本所在位置为基准 → 找不到 `node_modules`**
- 解法：给脚本目录建 `node_modules` 链接（注意**本机 `ln -s` 会降级成拷贝，真链接要用 `pwsh New-Item`**）。

**P9-13｜Playwright 自带 ffmpeg 不能编码 VP9 / 无音频 / 不能出 MP4**
- 现象：`recordVideo` 需要 VP9。解法：从 npmmirror 下完整 ffmpeg 6.0（29 MB、6.6 MB/s，
  支持 libx264/libvpx-vp9/aac/gif/mp4）。
- 首次尝试从官网下只有 ~15 KB/s（预计 2 小时）→ **大文件先试国内镜像**。

**P9-14｜`gh` 必须在仓库目录内执行**
- 现象：在别处跑 `gh release download` 失败。**以后**：`gh` 命令一律 `cd` 到仓库根再跑。

**P9-15｜`find /` 后台任务白跑**
- 为找「其它宿主 dll 副本」跑了 `find /`，最后被用户取消（exit 1）；结论是本机只有一份。
- **以后**：找同名文件先用定向 glob，不要全盘 `find /`。

**P9-16｜Kotlin CLI 不可用**
- 现象：无法用 kotlinc 跑合成测试。解法：改用 Java 重写合成测试（Java 互操作可用）。
- **以后**：需要「脱离 gradle 跑一段 Kotlin 逻辑」时，优先写 Java 等价验证 harness。

**P9-17｜`glob` 参数必须是数组；要改的文件必须先用 `read` 打开**
- 现象：`glob` 传字符串报错；用 `ops_inspect` 看过文件后直接 `edit` 被要求先 read。
- **以后**：`pattern`/`glob` 一律传 `["**/*.ts"]`；要改的文件一律先 `read`（哪怕已用 grep/inspect 看过）；
  遇 `FS_STALE_VERSION` 重读后重放。

### 4.10 发布与合规

**P10-1｜发布门禁：用户说「发布」才动 GitHub**
- 内容：本地迭代 → 装本机给用户验收 → 用户说「发布」→ 才 push + 打 tag + Release + 更新 README 中英。
  Workshop 上架**默认不做**。
- 证据：0.1.7/0.1.8/0.1.9、0.2.0、0.4.5 全部遵守（原文「按项目约定等你说上架再动 GitHub/README」）。

**P10-2｜每次发布三件资产 + 双校验**
- `<ver>.spmod` + `.spmod.json` + `SHA256SUMS.txt`；发布后必须 `gh release download` **回读复算 sha**，
  与本地逐字节一致才算闭环。0.3.0 实测：`13,178,430 B` / sha `7f79d9dc…d80744` / **1943** entries；
  json 488 B；SUMS 88 B（恰好一行 `7f79d9dc…d80744 *spw-folia-0.3.0.spmod`，`*` = binary 模式）。

**P10-3｜`packaging/licenses/` 是生成目录**
- 现象：直接改 `packaging/licenses/` 的合规文件，下次打包被 `build-package.sh` 从 `licenses-src/` 覆盖冲掉。
- 解法：改 `licenses-src/` 真源，再 `cmp` 验字节一致。
- **以后**：见到「生成目录」标记的目录一律不改，只改真源。

**P10-4｜文档里的 sha256 写成了中间产物哈希**
- 现象：release notes 的 sha256 与最终 spmod 不符。
- 解法：发布后重新取 splice 产物的哈希再回填（`fc06fd07…9805`）。
- **以后**：哈希只能从「最终发布物」取，不能从 `build/libs` 的中间产物取。

**P10-5｜class 总数误用 17,661**
- 现象：文档用 17,661 描述「从多少个类里认出三个」。
- 根因：17,661 是「**带 SMAP 源名映射的类**」数量，不是总类数 → 应为 **42,147**。
- **以后**：数字必须写清「这个数是什么的计数」，否则会被误用。

**P10-6｜`docs/release.md` 与 `THIRD-PARTY.md` 仍写 `lib\spw-folia-host.exe`**
- 实际产物是 `native\spw-folia-host.exe`。不影响运行（`resolveHelper()` 两个路径都接受），
  但排障文档会指错地方。**未修**。
- **以后**：写排障/许可文档前先 `sha256sum` 列出产物 `native/` 真实文件清单。

**P10-7｜版本号散落在多处，一次升级要改全**
- 清单：`README.md` / `README.en.md` / `site/index.html` / `docs/licensing.md` / `docs/release.md` /
  `docs/runtime-requirements.md` / `docs/settings-ui-impl.md` / `docs/architecture.md` +
  `build.gradle.kts` 的 `version`、`PluginVersion`、`FoliaPlugin.PLUGIN_VERSION`。
- **以后**：发布前 grep 旧版本号（含 `0.2.2`、`0.3.1`）逐个判定「该改 / 该留」（历史提及要**故意保留**）。

**P10-8｜`0.4.2a` 不是合法 semver**
- 解法：改 `0.4.3`。**以后**：补丁版本一律 `X.Y.(Z+1)`。

**P10-9｜release 正文与仓库 notes 文件的字节差**
- 事实：API body 11,039 B vs `docs/archive/release-notes-v0.3.0.md` 11,038 B，
  差**恰好一个尾部空行**；去掉尾空白后同 sha。**以后**：正文比对要说明「modulo final newline」。

**P10-10｜tag 类型要说明**
- 事实：v0.3.0 是**轻量 tag**（直接指 commit `16112ff`，无 peeled `^{}` ref）。

**P10-11｜JAR MANIFEST 72 字节折行会被误判为损坏**
- 现象：`Plugin-Description` 出现 `…Salt Player for Wind` + 下一行 ` ows`。
- 结论：JAR 规范折行，**不是损坏**。**以后**：校验 MANIFEST 先按 72 字节折行还原再比对。

**P10-12｜文档链接失效（历史文档搬动后）**
- 解法：新增 `packaging/tools/check-doc-links.py`，扫全部 markdown 本地链接，失效即非零退出
  （103 文件全通）。**以后**：任何文档搬动后必跑链接检查。

**P10-13｜文档写作的常见自造错误**
- 事实：①段落顺序弄反（第 6 项落在第 1–5 项前）②误删表格右侧一列 ③Python 重写引入 CRLF。
- **以后**：改文档后跑链接检查 + 看 `git diff` 是否「小而精准」。

### 4.11 多代理协作

**P11-1｜子代理声称写完但文件不在磁盘**
- 现象：Lead 检查时 `uploadedFonts.ts`、`useSystemFonts.ts`、`FontPickerModal.tsx` 全部缺失
  （`themeFonts.ts` 已重写但用的是 Lead 的版本）。
- 解法：Lead 重新下达「DELIVER NOW，exactly 3 new files」并给精确签名要求 → 3 个文件落盘、构建绿。
- **以后**：验收要 `ls` / `wc -l` 落盘证据，**不能只看 subagent 的文字汇报**。

**P11-2｜子代理「代码完成 + 构建通过」但把验证留在待办就结束了，且之后已不可寻址**
- 解法：新派一个 `subagent_fork`（fork 能看到全部上下文）接手验证。
- **以后**：任务书里把「验证 + 汇报」写成不可选的交付项，并明确「未完成验证不算完成」。

**P11-3｜子代理失败会静默**
- 事实：`95a74b81`、`8be77073`、`7f0ca9a0` 三个 background subagent
  「failed before it finished / left no closing message」。
- **以后**：并行分发时对失败项要有显式重试/接管路径，不能只看「已完成」的回报。

**P11-4｜任务板状态与口头验收不同步，阻塞下游**
- 现象：docs-writer 的 `claim` 被拒，原因 `task-3 is not ready to claim` ——
  task-2 在板上仍 `in_progress`（Lead 已口头验收）。
- 解法：Lead 代标 completed（导致 integrator 后来看到 completed/revision 3 而困惑，未重复 complete）。
- **以后**：口头验收后立刻在板上 complete，别让状态和事实脱节。

**P11-5｜并行写作用域摩擦（版本号 / 构建文件）**
- 现象：`build.gradle.kts` 被某个成员改成 0.4.6，但实现者的写作用域不含它 → 只能改代码常量兜底。
- **以后**：版本号这类全局常量指定单一 owner。

**P11-6｜进度核对靠 mtime 会误判**
- 现象：Lead 用 `HostTargets.kt` mtime 仍是 18:47（未改动）判断实现者卡住，实际对方在准备期读代码。
- **以后**：长任务要求显式 ETA + 短状态回执，不要靠文件 mtime 推断。

**P11-7｜任务描述里的估计值会被当成事实**
- 事实：任务描述写 `bodies=26800`（历史估计），实际 **28058**；文档统一写 28058 /「约 2.8 万」。
- **以后**：任务描述里的估计值要被实测值覆盖并显式标注。

**P11-8｜文档写手不编数字的纪律**
- 做法：docs-writer 提前索取 6 项实测数据，声明「拿不到就写 `TODO(实测)` 占位、绝不写假数字」；
  release notes 验证段第一句即硬声明「离线验证，未做真机端到端」，全文无「用户已确认」。

**P11-9｜PR 复审「验证假设成立」比直接改代码更值钱**
- 事实：Lead 的假设（`cleanup()` 不中断旧 writer → 第二次打开静默丢弃）经复审**完全成立**，
  且是确定性故障，被列为 PR blocking。
- **以后**：并发/生命周期问题先写「时序 t0–t5 + 行号」再动手改。

**P11-10｜squash 合并约定**
- 按仓库既有做法 squash 成单亲提交（PR #3 即如此）。

### 4.12 其他（安装 / 托盘 / 站点 / 中断）

**P12-1｜SPW 只认一个版本目录**
- 事实：`%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia-<ver>`；装新版要把旧目录移出备份
  （不是并存）。

**P12-2｜重启 SPW 是验证 hook 的必要步骤**
- 事实：hook 只在启动期安装；日志验证链
  `host menu profile:1.19.3` → `hookMethod installed (profile:1.19.3)` → `Folia item appended`。
- 附带：`web/settings/`（前端）热替换后宿主每次新建 Folia 窗口即加载，**不用重启 SPW**；
  但 Kotlin/插件代码改动**必须**重启 SPW。

**P12-3｜「修好代码 ≠ 修好安装态」：手工补丁目录会留成「半新半旧」**
- 现象：发布 v0.1.10 后本机安装目录仍是 `spw-folia-0.1.9`（classes 是 0.1.9、host exe 是手打补丁版）。
- 根因：为「让用户立刻验证滚轮不崩」，直接把修好的 exe 覆盖进已安装的 0.1.9 目录；
  发布流程随后没有替换整个目录。
- 解法：从发布产物解包出干净目录替换；用 SPW 日志 `start: id=dev.spw.folia version=0.1.10` 确认。
- **以后**：真机验收可用临时替换，但发布收尾必须核对「安装目录版本 = 发布产物版本」，
  并把「手工补丁目录」列为收尾检查项。

**P12-4｜库类也能 hook，但有精确边界**
- 事实（`reg_javap.txt`）：registrar 的类解析做 `Class.forName(name, false, <host loader>)`，
  **只**拒绝 `cls.getClassLoader() instanceof org.pf4j.PluginClassLoader`
  （日志 `"Hook target must be visible to the host loader: "`），且只拒绝前缀
  `com.xuncorp.voxzen.workshop.hooks.WorkshopHook` 与 `com.xuncorp.spw.workshop.api.hook.`。
- 结论：插件 jar 里的类被拒；**app jar 里的类**（宿主本体 + 打包进来的库如 compose-native-tray，
  都是 app loader）**可以**。
- 残余护栏：`Instrumentation.isModifiableClass`；`RecordingComposableScope` 是普通 final Kotlin 类 → 可改。

**P12-5｜SPW 是 MSIX 安装时宿主二进制不可 grep**
- 现象：`C:\Program Files\WindowsApps` 下是 AI stub 符号链接，无法直接读。
- 解法：用 gradle 插件常量池 + 两个已装第三方模组的 `MANIFEST.MF` 作为字段名证据。
- **以后**：查 SPW 字段名走「gradle 插件常量池 → 已装模组 MANIFEST」三级证据，不要试图反编译宿主。

**P12-6｜SPW 1.19.2 的 `app\ffmpeg-x64.dll` 其实是 fat JAR**
- 现象：按 .NET/Avalonia 找托管程序集会找不到。
- 根因：jpackage 把 classpath 指到 `$APPDIR\ffmpeg-x64.dll`（`PK` 魔数、42,721 条目、根 `MainKt.class`），
  真实技术栈是 Kotlin/Compose Desktop + 捆绑 JRE。
- **以后**：jpackage 应用的 `.cfg` / `.jpackage.xml` 是权威入口，别按文件名判断类型。

**P12-7｜SPW `ConfigHelper.get(key, defaultValue)` 的类型陷阱**
- 约定：键不存在**或值类型不匹配**都返回 defaultValue。
- 现象：seekbar 存进 `config.json` 的是浮点（`transitionDurationMs: 2000.0`），插件却用
  `get(key, 800)`（Int）读 → 永远判「不存在」→ 静默回落 800 ms，表现为「时长调节无效」。
- 先修法：哨兵值探测 double/int/long，第一个非负值为准并 clamp 300–2000；
  最终解法：**删掉该设置**，固定 800 ms。
- **以后**：读 SPW 配置一律按「double 优先 + 多类型哨兵」读数值，并在日志打印探测结果
  （`probe(double=300.0,int=-1,long=-1)`）。

**P12-8｜动画时长感知被 WebView2 冷启动掩盖**
- 事实：整体露出时间受冷启动约 1.5–2 s 主导，300 ms 与 2000 ms 的差异**不可感知**。
- 这是最终删掉时长设置的直接理由。**以后**：给用户可调项前先量「可感知窗口」，否则等于给了个假开关。

**P12-9｜首版部署后固定导航盖住锚点标题**
- 解法：`scroll-margin-top: 88px`（提交 `bb03e04`）。**以后**：固定 header 的站点必须给章节加 scroll-margin。

**P12-10｜线上视频加载慢被误判为站点问题**
- 现象：从本机访问 `github.io` 只有 **10–25 KB/s**（同期 npmmirror 从 6.6 MB/s 掉到 **321 B/s**，
  说明是本机网络整体拥塞）。
- 解法：用 curl 逐个核对 200 + 字节数、本地服务器起站点验证四个视频全部 `readyState: 4` 即时播放，
  如实记录为网络问题。**以后**：线上慢先测同机到其它站的带宽，再怀疑站点。

**P12-11｜逐字动画样式随机截图经常拿到空屏**
- 根因：demo 曲 16 秒循环，行边界处几乎空。
- 解法：**按歌词相位确定性截图** —— 从 SSE `clock` 反推
  `currentTime = ((Date.now()-epoch)/1000) % 16`，瞄准四行歌词中点（**2.2 / 6.2 / 10.2 / 14.2 s**）
  各拍一张再取最佳（多帧评分选最丰富）。
- **以后**：动画 UI 截图要按时间轴确定性定位，不要随机采样。

**P12-12｜缩略图 1280×720 被灯箱放大到 1600×900 而糊**
- 解法：以 1920×1080 重新渲染扫描图，画廊与灯箱直接用原图。**以后**：按最大展示尺寸采集素材。

**P12-13｜iframe 嵌入 Folia 时 `transparent=1` 传不进去**
- 现象：跨端口丢失查询字符串；加 `referrerpolicy="unsafe-url"` 仍被剥离；同源下完整 URL 会作为
  referrer 发送，但 **EventSource 从不发送 Referer** → 实时嵌入无法参数化。
- 解法：改预录视频素材（对宣传站反而更好：任何托管环境都能播）。
- **以后**：靠 Referer 传参的方案必须验证 EventSource/WebSocket 场景，它们不带 referrer。

**P12-14｜QUOTA 中断**
- 事实：`session-b1249bf2` 在 U31（快捷键需求）后被「自动续跑按规则停止（额度耗尽：QUOTA）」中断，
  之后 `[model changed]` 换模型继续。
- 影响：U31「通过 Workshop 的 `keyBindingManager` 注册快捷键控制透明背景 / 透明+穿透」当时**无实现证据**
  （不确定）；但 0.4.6 的 `Plugin-Permissions` 已含 `key-bindings`，说明该方向后来落地过。

**P12-15｜`research/` 与 `work/` 等大目录遗留**
- 事实：`work/` 1.6 GB、`dist/` 226 MB、`poc/webview/host/out` 679 MB、
  `poc/settings-ui/node_modules` 423 MB 等 ~2.3 GB 未清理（等用户决定）。
- **注意**：`dist/local/spw-folia-0.1.5.spmod`（12,574,908 B）是 v0.1.5 **唯一副本**，
  该版本从未发 GitHub Releases，**删除即永久丢失**（已写进项目记忆）。
---

## §5 已建立的契约与约定

> 这些是「不需要重新讨论、直接照做」的规则。违反它们的代价已在 §4 里用坑的形式记录过。

### 5.1 协议与数据形状

1. **协议 v1 已冻结，只允许追加**。新增消息（`queue`/`control`/`openUrl`/`diagnostics`/`hitbox`）必须写进
   `docs/protocol.md`，不破坏既有字段；同一类「动作消息」的信封形状统一为**扁平化**（与 `control` 一致）。
2. **`state` 是 RAW 形状**（`{posMs,durationMs,playing,rate,tsMs,lyricOffsetMs}`）；
   **`clock` 才是秒制**且节流 ≥250 ms。注入 UI 自行按 `tsMs + rate` 插值。
3. **`control` 白名单只有 5 个**：`toggle/previous/next/seek/shuffle/queue-play`；
   非法 action 丢弃 + `control-drop` warn 日志；`positionMs`/`index` 负数夹 0；`random` 缺省 false。
4. **`queue` payload**：`{"type":"queue","mode","random","index","items"}`；
   mode 白名单 `circle/circle-end/repeat-one/random`（非法 → `circle`）；`items` 原样透传
   （缺失 / 非 `'['` → `[]`）；`index` 夹 ≥0。
5. **宿主→插件通道复用 `log.WriteLine`（插件 stdin）**，不另开 Console 通道。
   理由：现有通道已验证，新开通道等于新增故障面。
6. **宿主不做本地播放语义处理，只搬运**。
7. **`queue` 反射失败时 `queueJson()` 返回 null → bridge 不发送 → 页面保留上一快照**（不是清空）。
8. **`hitbox` 协议**：页面 `{"type":"hitbox","vw","vh","rects":[{x,y,w,h}]}`；`rects` 数量动态，
   宿主不得写死；`rects=0` 时 fail-open = 整窗可点。

### 5.2 反射与 hook 纪律

9. **`Class.forName(name, false, loader)` 禁初始化**；loader 顺序
   `WorkshopApi 的 classloader → contextClassLoader → 自身`；句柄 `@Volatile` 双检缓存。
10. **失败语义**：`CNFE` / `NoClassDefFoundError` / `ExceptionInInitializerError` → **永久 unavailable**；
    其余每 **5 s** 重试；失败日志前 3 次全文、之后每 100 次；**绝不抛出到桥线程**。
11. **类名对外形态必须是点分二进制名**（`androidx.compose.ui.ɦ`），不是内部名
    （`androidx/compose/ui/ɦ`）—— 下游会直接塞给 `Class.forName`。
12. **hook 注入纪律**：`after()` 整体 `try/catch(Throwable)`，失败 log-only、宿主原列表不动；
    无静态可变状态持有 op；回调每次新建；幂等靠**全列表扫描**去重。
13. **hook 参数下标来自发现结果**（`scopeParameter` / `popupParameter`，1.19.3 实测 5 / 2），
    不写死；但仍保留越界/null 防御。
14. **混淆名单字符码点一律用 `\uXXXX` 转义字面量**写进源码，不用肉眼粘贴的字符
    （易被编辑器/编码破坏）。
15. **反射枚举一律走 `Enum.name` / `values()`**，绝不按字段名取值。
16. **`WPARAM/LPARAM` 一律 `unchecked((int)x.ToInt64())`**，不用 `ToInt32()`。

### 5.3 结构发现（v0.4.6+）

17. **解析链四层**：`host-targets.json` 缓存 → 内置 profile（**回归基准 + 零成本快路径**，53–57 ms，
    **不再是适配机制**）→ **结构发现（主路径，仅后台线程，1.3–1.5 s 索引，每版本一次）** →
    旧 classpath `scan()`（第二意见）→ **反射校验护栏**（作用于每一层）。
    `quickLoad()` 只跑前两层，`start()` 永不付索引成本。
18. **发现规则不可放宽**：builder 必须同时要求 Track / PiscesMediaItem / Navigator / State / scope /
    popupState **六个锚点**；`unique(...)` 候选 != 1 就抛 `IllegalStateException`（带角色名 + 候选数），
    **不做 best-effort**。
19. **`candidateCounts` 使用禁忌**：键名固定
    `owner, popup, entry, popupState, itemBridge, builder, scopeParameter, popupParameter, dismiss, label, palette`；
    palette 降级时值是 0（不是缺失）；未走到的角色不会出现在 map 里 →
    **禁用 `getValue`**，用 `getOrDefault` / `?.`。
20. **可选角色降级**：`palette` / `label` 失败 → 返回 null、不整体失败（`discover` 仍返回 menu）；
    只有 menu 六个必需角色不唯一/缺失才抛。
21. **缓存键名全局唯一**：调色板用 `paletteTarget`（不能用 `palette`，会与 `candidateCounts.palette` 撞车）；
    缓存命中仍要过 `validateMenu` + `validatePalette`；`origin` 用 `copy(origin="structural")` 保留。
22. **索引层实现约定**：owner 一律取 `this_class`（zip 条目名不可信）；
    用 ISO_8859_1 原始字节预筛四个 Compose 标记；单个 class parse 失败**绝不抛**（`runCatching` 跳过）；
    跳过 `META-INF/versions/` 与 `module-info.class`；每 entry 检查 `isCancelled`；
    `source.exists()` 前置检查；**零第三方依赖**（`java.lang.classfile` 是 JDK 25 自带）；
    注释全英文、日志消息中文。
23. **两条硬边界**：结构发现能适应**重命名**；**不能**适应**页面结构重构**（宿主不再用 `BlurPopupMenu`
    这类弹层，或 flyout 不再从 `Track`/`PiscesMediaItem` 取数 → 抛错 → 退回 scan → 仍失败则记
    `could not locate the 更多 flyout`，Folia 项缺失但其余功能不受影响）。

### 5.4 透明 / 穿透 / 输入

24. **鼠标穿透 = OS 命中测试层，不做合成输入**：捕获窗 `SetWindowRgn` = 页面热区并集（±4 CSS px 容差）；
    **禁止**再用 `mouse_event` 回放 / 220 ms 恢复捕获窗 / 逐点命中。
    理由：合成输入只回放左键，右键/滚轮/悬停被吞、拖拽断、会被提权窗口与反作弊拦截。
25. **fail-open**：热区数据缺失时宁可整窗可点，也不吞用户点击。
26. **拖拽连续性**：按住键期间区域临时整窗，并用 `GetAsyncKeyState` 自愈丢失的抬起事件。
27. **逃生通道必须常驻**：任何会限制输入的 UI 状态（透明/穿透）都必须有「热键 + 可见控件」双通道恢复。
28. **透明窗口不要用 WinForms 属性**，直接用 `SetLayeredWindowAttributes` / 分层窗口 API。
29. **多窗口 TopMost 叠层必须显式抬升**，不能靠创建顺序。
30. **色键方案下不要指望半透明**：目标是把大面积半透明底板**去掉**，不是调淡。
31. **透明兼容必须逐样式枚举键**：`STYLE_COMPAT` 是 `Record<StyleMode, …>`（新增样式不写就编译失败）；
    透明开关不止 `showBlocks`，要按「不读该开关的图层」逐个覆盖。
32. **不可适配 → 自动关闭该功能**：`monet`；浅色主题的 `lumiere`。用户偏好「功能降级而非勉强适配」。
33. **调参下发要完整**（因为 `tuningRegistry.apply` 可能是整体替换）—— **但这条有冲突记录，先实测确认**
    （见 §4 P3-13）。

### 5.5 设置树与 UI

34. **设置树键**：`transparentPlayerBackground`(bool)、`mousePassthrough`(bool)、
    `transparent`（页面侧 `config.background.transparent`）、`systemFonts`（派生数据，**不持久化**）。
    页面→宿主写回时 strip `systemFonts`；只有 outbound copy 带它。
    **plugin-owned 注入布尔**（v0.4.10/v0.4.11 起）：`showPlaybackBar`（默认开）、`showProblemButton`
    （默认关）—— 与 `systemFonts` 同一条路：插件读配置页 → 塞进设置树顶层 → 页面只读不写，
    `onSettingsFromPage` 落盘前统一剥离，**否则就是双写方 + 启动竞态覆盖**（照抄这条即可新增同类开关）。
35. **UI 选择器契约（集成验收脚本依赖）**：面板根 `.spw-queue-panel`；行 `data-queue-index="<index>"`、
    当前项 `data-current="true"`；播放条按钮 `.spw-playback-play` / `.spw-playback-step` /
    `.spw-playback-icon`；随机按钮 `aria-label="随机播放"`、列表按钮 `aria-label="播放列表"`；
    seek 区域 `.spw-playback-bar .spw-playback-track`，须同时响应 `pointerdown+pointerup` 与 `click`；
    测试记录 `window.__SPW_FOLIA_TEST_CONTROLS__`。
36. **样式注册不变量**：`styles.tsx` 在模块加载时断言其 mode 集合与顺序 == `STYLE_MODE_SHELF_ORDER`
    （从 `./settings` import **值**；无循环依赖）。
37. **上游样式清单单一事实源**：`styles.tsx` 条目数与 `settings.ts` 的 `STYLE_MODE_SHELF_ORDER` 必须一致。
38. **上游只读**：`work/folia/**` 与 `poc/webview/dist/dist` 是只读产物，定制逻辑集中在注入的
    `overlay.js` / `shim.js` 与 `poc/settings-ui`；扩展上游类型用「自有类型扩宽 + `as never`」，不改上游。
39. **字体上传契约**：50 MB 上限；扩展名 `.woff2/.woff/.ttf/.otf`；自定义 family **前置**到内置栈；
    `FontFace` + `document.fonts.add`；独立 IndexedDB `spw-folia-fonts` / store `fonts`（**不用** `stubs/db.ts`）；
    `open===false` 时模态 `return null`；验收靠 `data-spw-font-picker` / `data-spw-font-picker-row` 属性。
40. **缩略图规格契约**：1282×801、progressive JPEG、4:2:0、luma quant `[5,4,3,5,8,13,16,20]`
    （quality 84）、aspect 1.6005；`public/thumbs` 与 `dist/thumbs` 两份必须**字节相同**。
41. **零插件改动优先**：能靠设置树 + 页面 + 宿主实现的功能，尽量不动 Kotlin 插件。

### 5.6 诊断（v0.4.6.1）

42. **四态判定契约（Kotlin 与 TS 两侧共用，字段名不许改）**：`Verdict = pass | fail | unknown | advisory`；
    只有 `fail` 计入 `missing`，`unknown` 计入 `unverified`，`advisory` 只展示不影响结论；
    `Check = { id, label, verdict, detail, evidence?, fix? }`，删掉 `ok: boolean`。
43. **只有证据能产生 FAIL**；拿不到证据只产生 UNKNOWN；UNKNOWN 绝不表述成缺失。
44. **每个判定必须携带 evidence**：`Evidence(value, source, raw, error)` 四元组；
    evidence 在 UI、日志、issue 正文三处都显示，让判定可被反驳而不是只能被相信。
45. **探测层零依赖、零抛异常、零写文件**：不 import SPW API，可独立跑；外部进程统一 3 s 超时 +
    `destroyForcibly()`；子进程 stderr 只用于防死锁，不参与判定。
46. **退出码语义**：`0` 正常关闭（不弹）、`1` WebView2 初始化/崩溃/未处理异常、`2` 参数错误或 bundle 缺失、
    `3` WebView2 Runtime 未安装、`-2146232576` CLR `0x80131700`（.NET 未加载）；
    **未识别的码不造句子**，只记日志。
47. **软依赖一律 ADVISORY**：远端会话 / 音频采集 / 日志管道 / 无运行中的 Folia 窗口 ——
    永不进 `missing`，也不阻止打开反馈页。
48. **自检永不抛异常**：`onReportProblem` 外层 `runCatching`，失败也只 toast
    「环境自检自身出错：<异常类名>…请把 spw-folia.log 发给作者」。
49. **测试必须用本机真实样本**，不构造理想值。
50. **C# 保持 C# 5 语法**（in-box `csc.exe` v4.0.319：无字符串插值、无 `?.`、无 `out var`）。

### 5.7 发布与文档

51. **发布门禁：用户说「发布」才动 GitHub**；Workshop 上架默认不做。
52. **三件资产 + 双校验**：`.spmod` + `.spmod.json` + `SHA256SUMS.txt`；发布后 `gh release download`
    回读复算 sha，与本地逐字节一致才算闭环。
53. **`.spmod` payload 固定 4 个顶层目录**：`classes/ licenses/ native/ web/`；`licenses/` 固定 7 个文件。
54. **MANIFEST 元数据契约**：`Plugin-Class: dev.spw.folia.FoliaPlugin`、`Plugin-Id: dev.spw.folia`、
    `Plugin-Version`、`Plugin-Provider: azkbzxf`、`Plugin-Permissions`、`Plugin-Open-Source-Url`
    （DSL 属性名 `PluginOpenSourceUrl`，大小写与连字符必须精确）。
55. **权限**：`class-transform` + `library-read`（早期）；v0.4.6 起加 `key-bindings`。
    安装时必须授予 `class-transform`、`library-read`。
56. **发版纪律**：兼容性发布（只改 `classes/`）**必须**用 `splice-compat-release.py`，
    先核对基线 sha256 == GitHub asset digest，splice 断言「非 classes 条目 CRC 全一致」，
    `verify-layout.mjs` 全 true，最后下载回验 sha256。**禁止**用 `assemble-release.py`。
57. **发布门**：`verify-layout.mjs` `pass=true`（10/10 或 11/11）+ `consoleErrors=0` + fps 中位 ~116 +
    spawn→ready ~850 ms；**真实宿主 + 真实 WebView2**，不用模拟。
    **v0.4.11 起再加一道自检门**：`./gradlew runDiagnostics` exit 0 且健康机无 `FAIL`、
    `verify-diagnostics.mjs` exit 0 且页面侧无假 `FAIL`——自检本身也要跟得上版本，它出错不会编译失败，
    只会在用户机器上默默误报（v0.4.2–v0.4.6 就发过一次这种包）。
58. **文档纪律**：中文文档、英文代码注释、中文日志消息；每版本一个
    `docs/archive/release-notes-vX.Y.Z.md`；`docs/release.md` 只作产物台账；
    数字必须来自实测回执；验证边界写在第一句；文档搬动后跑 `check-doc-links.py`；行尾 LF。
59. **哈希只能从「最终发布物」取**，不能从 `build/libs` 的中间产物取。
60. **记忆卫生**：被回滚的方案要把记忆加「已撤回」横幅（保留调查结论作档案），
    避免后续会话误以为代码还在。

### 5.8 工作方式（用户偏好）

61. **先本地验收再上架**：不自动打 tag、不自动发 GitHub Release。
62. **「精简验收流程不需要每次都截图验收」**：不必每轮都截图；但关键 UI 变更（布局/样式）仍要真机实拍。
63. **要求如实记录限制**：无法复现的修复要写进 release notes「已知限制」，不许包装成「已验证」。
64. **要求给出三级证据**（如字段名：gradle 插件常量池 + 已装模组 MANIFEST + 宿主侧互证），
    不接受「看着对」。
65. **反复要求「继续」推进多任务**：习惯把大需求拆成并行子任务，Lead 汇总后做全量构建 + diff 审查。
66. **真机验收是最后一道关**：用户会自己打开 SPW → 更多 → Folia 实测再反馈。
67. **UI 风格取向**：拒绝橙色色环（要与右上角齿轮同款）；透明窗口字体色跟随系统深/浅色
    而不是封面色深；播放条要有亚克力质感、闲置时自动隐藏以免遮挡字幕。
68. **要求减少上下文消耗**：偏好单份权威 README + 归档目录。
69. **宣传材料要「唯美、流畅」**，接受自截效果图、省略大段更新日志。
70. **遇到架构问题先找同类项目的成熟做法**（SPW-island、SPW-Lyrics），不自创方案。
71. **代码约束**：`work/folia/`（上游）只读；不允许改 Folia 源码。
72. **子代理工作约定**：只读调查不改被跟踪文件（临时文件写 `tmp-deps/`、`tmp-diag/`、`/tmp`）；
    写作用域严格限定，越界前先告知。

---

## §6 排障速查

### 6.1 用户症状 → 第一嫌疑

| 用户说 | 第一嫌疑 | 判据 |
| --- | --- | --- |
| 「点了没反应 / 窗口闪一下消失」 | 缺 WebView2 Runtime（**exit 3**）或 .NET 4.8 | `spw-folia.log` 里的 `host process exited code=3` / CLR 对话框 / `-2146232576` |
| 「更多菜单里没有 Folia」 | 宿主 R8 改名（hook 目标失效）或版本门禁拒绝 | `host menu profile:…` / `hookMethod installed` / `Folia item appended` 三条链缺哪条；`unsupported SPW version …` |
| 「第二次打开就没有歌词」 | stdin writer 会话隔离（P2-2/P2-3） | `ignored: stale session` 有没有出现；`stdinBroken` |
| 「透明背景打开后点不到按钮」 | 色键窗口天然穿透 | 是否 v0.1.7 之前版本；`Ctrl+Alt+B` 是否有效 |
| 「鼠标穿透时好时坏」 | hitbox `rects` stale（P3-8） | 日志 `transparency passthrough=on rects=N`，N=0 就是 fail-open 整窗 |
| 「样式图片是乱码 / 预览黑框」 | 缩略图 404（P5-9） | 请求 `thumbs/*.jpg` 是否 200 |
| 「诊断面板报缺 Windows」 | 旧版 `os.version` 解析（P7-1） | 版本是否 ≥ v0.4.6.1 |
| 「字体改了没效果」 | 字体注册在 iframe 之外 / cfg overlay 抹掉 fontFamily | 见 P5-7、P6-5、P6-6 |
| 「动画时长调了没反应」 | `ConfigHelper.get` 类型不匹配（P12-7） | 该设置已在 v0.4.1 删除 |

### 6.2 辅助进程退出码

| code | 含义 | 用户可见现象 |
| --- | --- | --- |
| 0 | 正常关闭（ESC / 热键 / 插件关窗） | 无 |
| 1 | 窗口/WebView2 初始化失败、浏览器进程崩溃、未处理异常 | 窗口闪退 |
| 2 | 参数错误 / bundle 目录不存在 / 没有 `index.html` | 窗口闪退，日志 `bundle has no index.html` |
| 3 | **WebView2 Runtime 未安装或无法启动** | 窗口一闪而空 |
| **-2146232576** | CLR 激活失败 `0x80131700`（CLR_E_SHIM_RUNTIMELOAD）；托管代码一行都没跑（stdout/stderr 全空） | 系统弹「This application could not be started」；**不是 .NET 没装**，Store/MSIX 渠道下是 `.config` 路径虚拟化 |

### 6.3 日志位置与关键字

| 文件 | 内容 |
| --- | --- |
| `spw-folia.log` | 插件侧：启动、hook、spawn 命令行、`host process exited code=N`、`host closed reason=…` |
| `spw-folia-host.stdout.log` | 宿主协议日志：`webview-ready`、`webview2 runtime=…`、`webview process-failed kind=…`、`fps` |
| `spw-folia-host.stderr.log` | 宿主 stderr（**正常应为 0 字节**） |
| `%APPDATA%\Salt Player for Windows\logs.txt` | SPW 宿主侧（插件加载失败、权限异常） |

目录：`%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia-<ver>\`。

**可直接 grep 的关键行**：

```
transparency mode=on|off
transparency passthrough=on|off rects=N
transparency mouse=catcher shown|hidden bounds={...}
transparency passthrough=click at=X,Y
transparency exit source=hotkey|user
host menu profile:<ver>: <class>.<method>(<params>)
hookMethod installed (profile:<ver>)
Folia item appended (scope=<class>, bridge=<name>)
host structural index: <class>: <N> method bodies (<ms>ms)
host menu structural: <class>.<method>(<params>) scope=<class>.<m> (<ms>ms, <N> bodies)
host palette structural: <class>.<m>() via <class>.<m>
host build <ver> matched no known profile; indexing the host bytecode in the background
host scan found no flyout helper (<ms>ms) (classes=N parsed=N menuHits=N paletteHits=N)
ignored: stale session
unsupported SPW version <ver>; hook not installed
KEY_BINDINGS not granted
```

### 6.4 判定用数字基线

| 指标 | 基线 |
| --- | --- |
| 全屏 3200×2000 / 视口 1776×1110 | fps 中位 **119.2**、最高 120.0（= 120 Hz vsync 上限） |
| spawn → ready | ~850 ms |
| 页面 console 错误 | **0** |
| `verify-layout.mjs` | `pass=true` 10/10 或 11/11 |
| 结构发现索引 | 1.3–1.5 s / 28058 bodies（每版本一次，缓存后 53–57 ms） |
| 宿主 exe 大小 | v0.4.3 **164,864 B**；v0.4.6.1 **165,888 B** |
| settings island | v0.4.3 **2,249,780 B**；v0.4.6.1 **2,253.78 kB / 2,249,780 B**（gzip 717.18 kB） |
| 当前 `.spmod` | v0.4.6.1 **10,948,881 B / 3907 条目** |

### 6.5 「先证伪再下结论」的四个样板

1. **`dpr=1` 模糊**：逐像素梯度能量对照（3.183 vs 3.049）→ 结论「不是 bug」（P8-3）。
2. **ctypes 假通过**：先打印到达的 `wparam64` 形状（`0x00000000FF880000`）才做 A/B（P8-1）。
3. **headless vs 真机**：tempera 头测 cov8 3.8% 但真机有整屏灰底 → 头测只是必要条件（P3-12）。
4. **线上慢**：先测同机到 npmmirror 的带宽（6.6 MB/s → 321 B/s）才判定是本机网络（P12-10）。

---

## §7 构建、打包、验收、发布的标准流程

### 7.1 完整构建链（本机已跑通，v0.4.6.1 从零复现）

```bash
# 0) 前置：WebView2 SDK（只需一次）
#    https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2  → 9,818,548 B nupkg (1.0.4314.35)
#    解出到 poc/webview/tools/sdk/：Core.dll(698,208) / WinForms.dll(38,752) /
#    runtimes/win-x64/native/WebView2Loader.dll(194,912)

# 0) 前置：上游 Folia 源码（AGPL，不随仓库分发）
#    tag v0.7.22 = commit 1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe
#    需要 src/(2302) + dev/(212) + public/ assets/ img/ build/ deploy/ electron/ api/ api-ts/
#    shared/ test/manual/stage-client/ + 根级 *.html（实测 total=2519 ok=2514 skip=5 miss=0）

# 1) 构建 Folia OBS bundle → 复制到 poc/webview/dist/dist（约 23 MB）
#    ⚠ 前置必查（P4-14）：源码目录根级必须有 postcss.config.js + tailwind.config.js 两个文件。
#      缺了它们 vite build 仍 exit 0，但产物 CSS 只剩 ~29.6 KB、所有 Tailwind 工具类全部缺失
#      （预览子帧塌成 270 px）。正确产物 web/assets/src-*.css 应 ≈214.7 KB 且含 `.h-full{height:100%}`。
#      校验：grep -c '@tailwind' dist/assets/src-*.css  # 必须为 0
npx vite build            # 在 Folia 源码目录

# 2) 构建设置岛
cd poc/settings-ui && npx vite build     # → dist/settings-ui.js ~2,253.78 kB

# 3) 编译 C# 宿主
bash poc/webview/host/build.sh           # → build/spw-folia-host.exe 165,888 B（5 文件齐全）

# 4) 构建插件（注意顺序：先刷新 packaging/native 再构建插件，见 P4-1）
cd spw-folia && ./gradlew plugin         # → build/libs/plugin-dev.spw.folia-<ver>.spmod

# 5) 重新 stage web/native/licenses
cd .. && bash packaging/build-package.sh # staging ~24.5 MB / 3816 文件（预算 25 MB）

# 6) 合并成发布产物
python packaging/tools/assemble-release.py \
  --spmod spw-folia/build/libs/plugin-dev.spw.folia-<ver>.spmod \
  --staging packaging --out dist/release --name spw-folia-<ver>.spmod

# 7) 验收（干净解包 + 真实宿主 + 真实 WebView2）
node packaging/tools/verify-layout.mjs   # 期望 consoleErrors=0, canvases=3, pass=true

# 8) 自检门禁（v0.4.11 起每次构建后必跑，见 §7.4）
node packaging/tools/verify-all.mjs      # 一条命令：静态契约 + 自检 + 两个开关套件，期望 10/10
# 想分开看：
#   cd spw-folia && ./gradlew runDiagnostics        # 期望 exit 0、健康机无 FAIL（UNKNOWN/ADVISORY 正常）
#   cd .. && node packaging/tools/verify-diagnostics.mjs   # 期望 exit 0、页面侧无假 FAIL
```

**编译环境**：Gradle 9.8 + JDK 25.0.2（宿主 JRE 25.0.4.1）；插件 class 为 Java 25 / major 69。
离线构建：`JAVA_HOME="C:/Program Files/Java/jdk-25.0.2" ./gradlew build -q --console=plain --offline`。

### 7.2 兼容性发布（只改 `classes/`）—— **必须走 splice**

```bash
# 1) 以已发布版本为基线
gh release download v0.4.3 -p spw-folia-0.4.3.spmod -O dist/release/spw-folia-0.4.3-ref.spmod
#    核对基线 sha256 == GitHub asset digest

# 2) 只替换 classes/
python packaging/tools/splice-compat-release.py    # → dist/release/spw-folia-<new>.spmod + .json
#    断言：非 classes 条目 CRC 全一致（v0.4.5 实测 3832 项全同，classes 62 旧 → 67 新）

# 3) 验收 + 回验
node packaging/tools/verify-layout.mjs
sha256sum dist/release/spw-folia-<new>.spmod      # 与回填文档的哈希一致
```

**禁止**用 `assemble-release.py`：staging 可能比已发布版本旧，会静默回退 web/helper（实测少 18,714 B）。

### 7.3 本地安装（给用户验收）

```bash
bash packaging/install-local.sh <version>     # 版本可覆盖，不要写死
# 或：解包 .spmod 到 %APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia-<ver>\
#    并预写 permissions.json：{"dev.spw.folia":{"reviewed":["class-transform"],"granted":["class-transform"]}}
#    enabled.txt 追加 dev.spw.folia（CRLF 或 LF 均可）
```

**必须**：① 用**发布产物**解包，不要手工补丁（P12-3）；② 旧版本目录移出备份，不要并存（P12-1）；
③ 改 Kotlin/插件代码必须重启 SPW；只改前端可热替换（P12-2）。

### 7.4 发布检查表

- [ ] 用户明确说「发布」
- [ ] 版本号改全：`build.gradle.kts` 的 `version` + `PluginVersion` + `FoliaPlugin.PLUGIN_VERSION`（+ 注释）
- [ ] README 中英、`site/index.html`、`docs/licensing.md`、`docs/architecture.md`、
      `docs/settings-ui-impl.md` 的版本号/样式数同步（历史提及**故意保留**）
- [ ] `docs/release-notes-v<ver>.md` 写好（验证段第一句声明验证等级）
- [ ] 重跑构建，产物与验证产物**逐字节一致**
  - ⚠️ **v0.4.11 实测：这一条目前对 `.spmod` 不成立，原因在宿主 exe。** `.NET Framework` 的
    `csc.exe` 不支持 `-deterministic`，同一源码两次编译出的 `spw-folia-host.exe` 有 51 字节差异
    （PE 时间戳 / 字符串时间戳 / MVID GUID / PDB GUID，**不含源码内容**，长度恒为 178,688 B）。
    `assemble-release.py` 本身是确定性的（同一输入两次装配 sha 相同），所以**不可复现的是 exe，
    不是装配**。发版时以本机装配的那一份 sha 为准并如实记录；要真正修需换 Roslyn `csc` 或 .NET SDK。
- [ ] **跑自检（v0.4.11 起必做）**：
      `cd spw-folia && ./gradlew runDiagnostics` → exit 0、健康机 `SUMMARY` 里 `FAIL` 计数为 0
      （`UNKNOWN` 允许）；再 `node packaging/tools/verify-diagnostics.mjs` → exit 0、页面侧无假 FAIL。
      这一步查的是「自检本身有没有跟版本脱节」——自检错了不会编译失败，只会在用户机器上默默误报
      （v0.4.2–v0.4.6 的教训）。任一条失败即**阻断发布**，处理流程见
      `docs/logging-and-diagnostics.md` §6.4
- [ ] `verify-layout.mjs` pass=true、consoleErrors=0
- [ ] `check-doc-links.py` exit 0
- [ ] `git status --short` 逐项归因，非本次意图的噪音（`DefaultConfig.json` 等）回退
- [ ] 三件资产上传；`gh release download` 回读复算 sha
- [ ] `docs/release.md` ledger 追加一行（字节数 / entries / sha256 / released 日期）
- [ ] 记忆/文档里被回滚的旧方案加「已撤回」横幅

---

## §8 已知限制、未决问题、文档与现实的不一致

### 8.1 已知限制（应写进 release notes）

| 限制 | 原因 |
| --- | --- |
| **智能动感模式（smart beat）不可用** | Folia 节拍检测模型（beat_this / htdemucs，WebGPU）不在 WebView bundle 中，也没有节拍事件流 → 花火随拍开花/推镜、sonnet 推镜、diorama 涟漪**保持静止**（样式本身动画不受影响） |
| 动感效果（推镜裂光、涟漪）不可用 | 由 `beatImpact` / `downbeatImpact` 驱动，无节拍数据时永不触发 |
| 罗马音 / 和声字幕不可用 | 插件不提供该数据 |
| 自定义图片/URL 背景、图片上传类控件不可用 | 页面沙箱无上传通道、插件只推内置背景模式 |
| **仅主屏全屏** | `Screen.PrimaryScreen` 固定；副屏用户会觉得「窗口没出现」（不是崩溃） |
| 透明仅支持色键 | **已发布 v0.4.6 用的是纯洋红 `rgb(255,0,255)`** → 半透明像素必然被染成粉雾（用户报障「粉色的背景」）。**未发布的 v0.4.9 起改成近黑 `rgb(1,0,1)`**，同一批半透明像素只被压暗成中性灰；详见 `docs/live-transparency.md` §4.9。判断线上版本时别把这条当成已修复 |
| monet、浅色 lumiere 不支持透明 | 见 P3-14 |
| **无 GPU / RDP / 虚拟机可能黑屏** | 未传 `--disable-gpu`，无软件渲染兜底开关（未见因此崩溃） |
| 辅助进程未签名 | AppLocker / SmartScreen / 杀软可能拦（`CreateProcess error=5`） |
| 低内存机可能被系统杀 | WebView2 `OUT_OF_MEMORY` |
| `systemFonts` 每次启动重算、不持久化 | 避免 10–20 KB 派生数据变脏 |
| 结构发现不能适应**页面结构重构** | 只能适应重命名 |
| 未知宿主版本首启多花 1.3–1.5 s | 后台索引，结果缓存，用户可感知但非阻塞 |

### 8.2 明确未解决 / 遗留

1. **tempera 真机透明仍有整屏不透明灰底板**（`rgb(178,178,179)`、std 0.5）—— 头测 cov8 3.8% 与真机不一致，
   定位中断。需要查 tempera 场景里除 `showBlocks` / `postProcessVignette` 之外还画了什么整屏填充。
2. **鼠标穿透 stale rects 未修** —— 根因（120 ms settle < 180 ms transition、无 `transitionend`/`ResizeObserver`）
   与证据（46/51 次 `rects=0` + fail-open）都有，但未落地。
3. **设置界面两条症状未修复交付**（2026-11-01 会话截断）：
   - 缩略图缺失根因已确证（`public/thumbs/` 被 gitignore 且磁盘不存在 → 404），但**未生成图片、未改构建**；
   - 预览框空白未收敛（候选：`preview.html` 无 cache-buster 吃旧缓存 / 旧 profile 的 PWA Service Worker
     拦截导航 / 4 s 超时偏紧）。
4. **「显示不全」布局问题未处理** —— `StudioWindow` 固定 1240×780；按宿主日志 `scale=1.8` 推算用户截图
   CSS 视口 ≈1241×781（几乎顶满，**未经截图自身 DPI 核实**，不确定）；探针在 987×617 视口下
   `window 987×617`、stage 被压到 888×160。是否给窗口加缩放/滚动未定。
5. **v0.4.6 未做真机端到端** —— 只做到「真实宿主 dll + 编译后代码 + 双路径一致」的离线验证，
   **没有**装进真实 SPW 打开菜单确认 Folia 项出现（文档已如实标注）。
6. **`BrowserProcessExited` 未修**；复审提出的 F3/F4/F10、孤儿 helper watchdog 留给后续。
7. **MSIX 路径虚拟化修复（PR #5）无法在开发机复现触发条件** —— `physicalFile()` 在非虚拟化环境是
   恒等变换、零副作用；修复效果只能靠受影响的 Store 用户实际回归确认。Release notes 已写进「已知限制」。
8. **`labelMethod` 在 1.19.3 上不可反射调用**（是 `BlurPopupMenu` 内部 composable 名）→ 是否永久放弃 label **未定**。
9. **`.spmod.json` 泄漏本机构建路径**（`sourceSpmod` 含 `D:\输出目录\dsh2\...`）—— 未修。
10. **`docs/release.md` 与 `THIRD-PARTY.md` 仍写 `lib\spw-folia-host.exe`**（实际 `native\`）—— 未修。
11. **`README.en.md` 曾落后一个版本**（0.2.1 时停在 0.2.0）—— 是否有机制保证双语同步 **未定**。
12. **TS 存量错误基线未修**：settings-ui 范围内 9 个既有错误（`bridge.ts:284`、`i18n.ts:7`、
    `settings.ts:258`、`Stage.tsx:54`、`useConfigPublisher.ts:34-35`、`vite.config.ts`×3）。
13. **`dist/local/spw-folia-0.1.5.spmod`（12,574,908 B）是 v0.1.5 唯一副本**，删除即永久丢失。
14. **遗留 ~2.3 GB 大目录未清理**：`work/` 1.6 GB、`dist/` 226 MB、`poc/webview/host/out` 679 MB、
    `poc/settings-ui/node_modules` 423 MB。
15. **打包构建的边界**：`vite build` 需 `work/folia/folia-major-main`（AGPL，不随仓库分发）；
    宿主完整编译需 WebView2 SDK dll。依赖仍是本机临时目录，新人复现需按 §7.1 六步重做。

### 8.3 文档与现实的不一致（接手前必须知道）

| # | 不一致 | 现实 |
| --- | --- | --- |
| 1 | **版本号已统一（v0.4.10 起）** | `build.gradle.kts` 的 `version`、`FoliaPlugin.PLUGIN_VERSION`、各类注释**三处已全部定版 `0.4.10`**；此前长期停在 `0.4.7`（`FoliaDiagnostics.kt` / `FoliaEnvironmentProbe.kt` / `build.gradle.kts` 注释把好几批改动都自称 v0.4.7），更早 README 中英还写过「当前 v0.4.3」。**注意：版本号统一不等于发布** —— v0.4.6.1 及其后所有版本都未发布，最后发布版本仍是 v0.4.6 |
| 2 | **`docs/release.md` 数字口径分裂（已修）** | 原文正文的 3,832 文件 / 25.99 MB 是 **staging（未压缩目录）**，且已过时。2026-11-02 起改为按**实际下载的 v0.4.6 产物**重算：zip 内未压缩 3,912 文件 / 26.59 MiB，zip 12,476,192 B；v0.4.5 12,227,007 B；「当前」描述全部改成 v0.4.6 口径 |
| 3 | **ledger 缺行（已修）** | `docs/release.md` 附录 ledger 原缺 v0.4.4–v0.4.10；现已补齐 v0.4.5/v0.4.6（已发布，带实测 bytes/entries/sha256）与 v0.4.6.1/v0.4.7（本地产物）及 v0.4.4/v0.4.8/v0.4.9/v0.4.10（无发布记录，写 `—`） |
| 4 | **`libs.versions.toml` 是孤儿文件** | 无任何 `.kts` 引用（`grep 'libs\.'` 零命中），且 api 写 `dev22` 而实际是 `dev23` |
| 5 | **`poc/hook` 硬编码 1.19.0 商店版路径** | 宿主换版即失效 |
| 6 | **工作树不干净** | baseline commit `e11fe14` 误提交了 `spw-folia/.gradle/` 与 `build/`（**422 个 `D` + 15 个 `M` + 13 个 `??`**，其中 `?? docs/dev-experience.md` 就是本文件）；**baseline ≠ 已发布内容**，判断现状必须看工作树 |
| 7 | **`docs/runtime-requirements.md` 曾以 `os.version` 为前提** | v0.4.6.1 已修正并登记这起真实误报 |
| 8 | **`docs/hook-target.md` 的 Known profiles 表** | 保留不删，但定位已改为「回归基准 + 首启动加速」，**不再是适配机制** |

---

## §9 给下一个 agent 的 12 条铁律

1. **先证伪，再下结论。** 任何「这看起来像 bug」的判断，先设计一个能证伪它的对照实验。
   样板：`dpr=1` 模糊（梯度能量对照）、ctypes 假通过（先打印参数形状）、headless vs 真机、线上慢（先测带宽）。

2. **混淆名只在真实字节码上认。** `javap -v -p` 是唯一权威；文档、旧记忆、设计稿都不能当证据。
   单字符码点用 `\uXXXX` 转义写进源码；类名一律「先剥壳（`L…;`/内部名）→ 再点分化」。

3. **「读不到」≠「缺失」。** 所有检查/诊断/健康度判定一律四态（`PASS/FAIL/UNKNOWN/ADVISORY`），
   并且**只有证据能产生 FAIL**。这条是 v0.4.6.1 的中心教训。

4. **长生命周期对象 + 短生命周期线程 = 必须按会话隔离。** 队列、writer、exit watcher 全部带身份，
   `cleanup(reason, expected)` 在锁内先判身份。

5. **改输入路由必须同时设计「怎么回来」。** 透明/穿透/全屏这类状态必须常驻「热键 + 可见控件」双通道。

6. **构建顺序就是正确性。** 改宿主后核对四处同源大小；改版本号要改全（gradle + 常量 + MANIFEST + 文档）；
   `packaging/native` 与 `packaging/licenses` 都是**生成目录**。

7. **兼容性发布禁止用 assemble。** 只改 `classes/` 就走 splice，逐字节保留非 classes 条目并断言 CRC。

8. **本地安装与发布包必须走同一条 staging 流程。** 绝不直接拷上游 dist；手工补丁目录必须收尾替换。

9. **验证分级要写进文档第一句。** 离线 / 真机 / 用户验收三级别混；未做真机的必须明说，
   不许写「用户已确认」。

10. **落地证据优先于文字汇报。** 验收要 `ls` / `wc -l` / `git status` / 逐文件 hash，
    不能只看 subagent 或自己的「已完成」。

11. **数字必须带单位与口径。** 42,147 class / 17,661 带 SMAP 名的类 / 28058 method bodies /
    1943 entries / 25.99 MB staging vs 10.95 MB zip —— 混用会得出完全错误的结论。

12. **Windows 本机三个高频陷阱**：中文路径会让反射/老工具链失败（先复制到 `%TEMP%\<ascii>`）；
    终端 GBK 乱码不是文件坏了（用字节级校验）；`ln -s` 会降级成拷贝（真链接用 `pwsh New-Item`）。

---

## §10 关键文件与路径地图

### 10.1 仓库内（`D:\输出目录\spw-folia`，2026-11-01 从 `D:\输出目录\dsh2` 迁出）

| 路径 | 作用 |
| --- | --- |
| `spw-folia/build.gradle.kts` | 版本号（`version` + `PluginVersion`）+ `spmod { }` 元数据（**唯一改元数据的地方**） |
| `spw-folia/settings.gradle.kts` | pluginManagement；Kotlin 2.4.20 **真正生效**的版本声明 |
| `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` | 插件入口：`start()`、`installHook()`、`openFolia()`、toast 策略、版本门禁 |
| `.../FoliaHostBridge.kt` | 宿主进程桥：stdin 写线程、有界队列 256、`cleanup(reason, expected)`、`stdinBroken`、`stdoutLogLock`、`describeExitCode` |
| `.../FoliaSettingsStore.kt` | 设置树持久化 |
| `.../HostTargets.kt` | `PROFILES` / `quickLoad` / `deepResolve` / `scan` / `Version.MIN_SUPPORTED` / `palette` |
| `.../HostBytecodeIndex.kt` | JDK 25 `java.lang.classfile` 索引器（v0.4.6 新增） |
| `.../HostMenuDiscovery.kt` | 结构发现（发现链、六锚点、`unique()`、`candidateCounts`） |
| `.../FoliaMenuItem.kt` | 菜单项（`PaletteCache`、`scopeParameter`/`popupParameter` 取参） |
| `.../FoliaTrayMenu.kt` | 托盘 `RecordingComposableScope.snapshot()` hook |
| `.../FoliaPlaybackControls.kt` | 播放控制反射层（567 行 / 26 句柄） |
| `.../FoliaPlaybackExtension.kt` | `PlaybackExtensionPoint` 实现 |
| `.../PlaybackTimeline.kt` | 1 Hz → 60 Hz 插值 + rate 学习 |
| `.../FoliaDiagnostics.kt` | 判定层（四态、`Check`/`Report`、`describeExitCode` 配套） |
| `.../FoliaEnvironmentProbe.kt` | 探测层（`Evidence(value, source, raw, error)`，零抛异常） |
| `.../FoliaConfigGroups.kt` | 配置页分组读取 + **开关换组时的旧值回退与一次性迁移**（v0.4.11 新增） |
| `.../FoliaSystemFonts.kt` | 系统字体枚举 + JSON merge/strip |
| `.../FoliaCoverPalette.kt` / `FoliaTransparency.kt` / `FoliaTrayNative.kt` | 取色 / 透明 / 托盘原生 |
| `.../Json.kt` | 手写 JSON（`Json.str()` 转义、`Json.rawField` **扁平首匹配**） |
| `spw-folia/src/test/kotlin/dev/spw/folia/` | `FoliaDiagnosticsTest.kt`（18 测试）、`DiagnosticsMain.kt`（`gradlew runDiagnostics`） |
| `poc/webview/host/HostForm.cs` | WebView2 宿主主窗体：崩溃点、shaped region 引擎、`BuildEnvReport()`、`ApplyRasterizationScale`、stdin 分发 |
| `poc/webview/host/Program.cs` | `Main` 注册全局异常处理器；异步 stdout 读取 |
| `poc/webview/host/Shim.js` | 协议 shim；`emitLocal`、`window.__SPW_FOLIA__`、console 镜像、`page-stall` |
| `poc/webview/host/build.sh` | `csc.exe` 编译宿主（会改写 tracked 的 `DefaultConfig.json`） |
| `poc/webview/server/` | 开发用 Node 服务（`server.mjs`、`styles.mjs`、`transparency.mjs`、`compat-regression.mjs`）；`node_modules` 内有 `playwright-core` 1.64.1 |
| `poc/settings-ui/src/bridge.ts` | `bridgeOn`、事件类型、`postHostMessage`、`HitRegion`、`reportHitRegions` |
| `poc/settings-ui/src/App.tsx` | chrome 挂载与 hit region 收集（`[data-spw-chrome=…]`） |
| `poc/settings-ui/src/app.css` | chrome 样式（新增段落一律**末尾追加**） |
| `poc/settings-ui/src/chrome/playback/` | `PlaybackBar.tsx`、`playbackClock.ts`、`PlaybackQueuePanel.tsx` |
| `poc/settings-ui/src/chrome/ProblemReportPanel.tsx` | 播放页诊断面板（四态重写） |
| `poc/settings-ui/src/model/styles.tsx` | 15 个样式条目 + 加载期不变量断言（:219-241） |
| `poc/settings-ui/src/model/settings.ts` | `StyleMode`、`STYLE_MODE_SHELF_ORDER`、随机池 store、`setVisualizerMode` |
| `poc/settings-ui/src/model/transparencyCompat.ts` | `STYLE_COMPAT: Record<StyleMode,…>` |
| `poc/settings-ui/src/model/useRandomSongMode.ts` | 按曲抽样式 hook（纯函数 `isTrackChange`） |
| `poc/settings-ui/src/useConfigPublisher.ts` | `toPublisherLyrics`（#13 的 `cells→words` 修复点） |
| `poc/settings-ui/src/publisher/config.ts` | `buildConfig`；透明+tempera 时不发布 `song/…`（#11 修复点） |
| `poc/settings-ui/vite.config.ts` | `foliaSettingsSurgery`（构建期剥离无效控件，找不到标记就失败） |
| `poc/settings-ui/public/thumbs/` + `dist/thumbs/` | 15 张样式缩略图（1282×801；**两份必须字节相同**；当前磁盘缺失 → P5-9） |
| `packaging/build-package.sh` | stage web/native/licenses + checksums（**覆盖 `packaging/licenses/`**） |
| `packaging/licenses-src/` | 合规文件**真源** |
| `packaging/tools/assemble-release.py` | 合并成 `.spmod`（**兼容性发布禁用**） |
| `packaging/tools/splice-compat-release.py` | 兼容性发布 splice（**唯一正确路径**） |
| `packaging/tools/verify-layout.mjs` | 打包产物端到端验收（发布门禁） |
| `packaging/tools/verify-diagnostics.mjs` | 自检复检：真实宿主 + 真实 WebView2 跑页面侧 `envReport`，断言无假 FAIL（v0.4.11 新增，发布门禁） |
| `packaging/tools/stage-web.mjs` | 完整 dist staging + settings-asset dedupe + `preview.html` 生成 |
| `packaging/tools/check-doc-links.py` | 全仓 markdown 本地链接检查 |
| `packaging/native/` | 宿主 exe + 3 DLL + `.exe.config` 暂存（**陈旧循环源头**） |
| `docs/hook-target.md` | 宿主 hook 全史（537 行）：四层解析链、profiles 表、托盘 hook、已知边界 |
| `docs/protocol.md` | 协议契约（§1 queue、§2 control、§3.1/3.2/3.4、§7.5 冻结、§8 DPI） |
| `docs/architecture.md` | 架构与决策记录 |
| `docs/release.md` | 发布流水线 + 产物 ledger |
| `docs/live-transparency.md` | 透明/穿透设计（§4.6b、§4.7） |
| `docs/live-preview-iframe.md` | 预览 iframe 机制 |
| `docs/playback-controls.md` | 播放控制完整契约 |
| `docs/audio-timeline.md` | 音频分析与时间线 |
| `docs/settings-ui-impl.md` | 设置岛实现（含 surgery 清单） |
| `docs/known-inert-settings.md` | 每个控件的生效情况（**改设置页前必读**） |
| `docs/runtime-requirements.md` | 依赖矩阵 + 闪退排查 |
| `docs/logging-and-diagnostics.md` | 日志与环境自检 |
| `docs/folia-spec/` | 从 Folia 源码提取的行为规格（15 样式、设置、音频、主题、转场） |
| `docs/archive/` | 历史 release notes + verification 报告 |
| `site/index.html` + `site/tools/` | GitHub Pages 落地页与素材生成脚本 |
| `README.md` / `README.en.md` | 中英 README（功能、更新节、验证表、安装/构建） |

### 10.2 本机外部路径

| 路径 | 说明 |
| --- | --- |
| `D:\app\steam\steamapps\common\Salt Player for Windows\app\ffmpeg-x64.dll` | Steam 版宿主：伪装成 dll 的 fat JAR（111 MB / 42,147 class；`java.class.path` 只有这一条） |
| `%APPDATA%\Salt Player for Windows\workshop\plugins\` | 插件安装目录（一个版本一个目录）+ `enabled.txt` + `permissions.json` |
| `%APPDATA%\Salt Player for Windows\workshop\data\dev.spw.folia\` | 插件数据（设置树 JSON） |
| `%APPDATA%\Salt Player for Windows\logs.txt` | SPW 宿主日志 |
| `%LOCALAPPDATA%\spw-folia\webview\` | WebView2 用户数据目录（首次运行后 121 MB） |
| `C:\Users\24037\.gradle\caches` | Gradle 插件缓存（`spw-workshop-gradle-plugin-0.1.0-dev23.jar`） |
| `C:\Program Files\Java\jdk-25.0.2` | 编译用 JDK 25（`javap` 不在 PATH，用全路径） |
| `C:\Users\24037\Downloads\gradle-9.8.0\bin\gradle.bat` | Gradle 9.8（无 `gradle` 在 PATH） |
| `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` | in-box C# 5 编译器（宿主构建） |
| `D:\输出目录\spw-folia-before-revert-20261029-143136.bundle` | 回滚前备份（17 MB，被移出历史的 4 个提交） |
| `D:\输出目录\spw-folia-acl-recovery\` | ACL 诊断报告（结论：无需 ACL 修复） |

### 10.3 本次考古的中间产物（可删）

| 路径 | 内容 |
| --- | --- |
| `D:\输出目录\dsh2\_scratch\narr\` | 63 个会话的叙事摘要（1.1 MB） |
| `D:\输出目录\dsh2\_scratch\batches\` | 按时间分批的会话全文（6 批，约 790 KB） |
| `D:\输出目录\dsh2\_scratch\findings\` | 7 份结构化事实提取（3,072 行，约 470 KB） |
| `D:\输出目录\dsh2\_scratch\dumps\` / `fails\` | 早期压缩转储与失败证据（4.4 MB + 1,237 行） |
| `D:\输出目录\dsh2\_scratch\*.py` | 会话解压/索引/提取脚本 |

> 这些不是交付物，只用于「怎么得出这份文档」的可复核链路。想复核任何一条结论，
> 在 `findings/` 里按批次号找原始出处，再顺着 `narr/` 回到会话原文。

---

## 附录：本次考古的取证方法（供下次复用）

1. **会话存储位置**：`C:\Users\24037\.dsh\sessions\<workspace-hash>\<session-id>\session.v4.jsonl.zstd`。
   workspace-hash 是路径的转义形式（`D:\输出目录\dsh2` → `--D-~8F93~51FA~76EE~5F55-dsh2--`）。
2. **解压**：Python `zstandard`（`pip install zstandard`）；注意 `stream_reader(f).read()` 而非迭代
   （迭代会 `io.UnsupportedOperation`）。
3. **事件类型**：`session`（头）/ `user/message` / `assistant/message` / `tool/call` / `tool/result` /
   `step/start` / `step/end` / `session/title` / `team/task`。用户消息正文在
   `data.content[0].text`（**不是** `data.text`）。
4. **规模**：dsh2 工作区 **63 个会话**（含 30+ 子代理会话），解压后约 **98 MB**；
   另 spw-folia 新工作区 5 个会话（2026-11-01）。
5. **有效叙事量**：过滤掉 system-reminder / runtime-context 后，用户需求 + 助手回复约 **72 万字符**；
   按时间分批后每批 130–160 KB，适合分派。
6. **分派策略**：6 个批次 + 1 个仓库事实卡，共 7 个并行子代理，各自只写自己的 `findings/<batch>.md`
   （写作用域不重叠）。每个子代理的产出被要求「现象 → 根因 → 解法 → 以后怎么避免」四段式。
7. **本机无 `zstd` CLI**，也没有预装 Python `zstandard` —— 需要 `pip install zstandard`。
