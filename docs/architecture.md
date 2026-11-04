# 架构

把 [Folia](https://github.com/chthollyphile/folia-major) 的生产级 OBS 浏览器源产物内嵌进
**Salt Player for Windows（SPW）**：迷你播放器「更多」菜单里的 **Folia** 条目打开一个无边框全屏
窗口，直接运行 Folia 自己的渲染代码渲染 17 种歌词样式，由 SPW 正在播放的音乐驱动。
插件自身不渲染任何内容。

当前插件版本 **v0.4.18**；内嵌上游 Folia **0.7.25**；支持 SPW **1.19.0 及以上**。

## 1. 核心决策

1. **不把 Folia 的视觉器移植到 Kotlin。** Folia（React/TS，AGPL-3.0）已经带一个一等公民的 OBS
   浏览器源入口：`dist` 在 pathname 为 `/obs` 或带 `?obs=1` 时挂载 `ObsBrowserSourceApp`（纯浏览器，
   不需要 Electron）。直接内嵌 Folia 真实的 production dist，于是 17 种样式、背景、辉光词、字幕
   叠加、转场都是原样代码。
2. **没有 HTTP 服务、没有网络、没有 Electron。** WebView2 宿主把本地目录映射成虚拟主机
   `https://spw-folia.local`；Folia 的 `EventSource` 由注入的 **Shim.js** 顶替，数据来自
   `window.chrome.webview` 消息。插件因此体积小、离线可用、攻击面小。
3. **原生辅助进程** `spw-folia-host.exe`：C# .NET Framework 4.8 + WinForms + WebView2，
   负责无边框全屏窗口、WASAPI 环回音频分析与和 JVM 插件之间的 IPC。SPW 本身是 Compose/Skia
   应用，把 Chromium/JCEF 塞进同一个 JVM 又重又险；辅助进程是已被验证的模式，也让宿主崩溃不至于
   拖垮播放器。
4. **插件保持薄**：它只拥有数据（播放时钟、歌词、曲目/封面、设置持久化）与生命周期，从不渲染。
   页面负责设置界面、构建 `ObsBrowserSourceConfig` 与渲染。
5. **设置界面复用 Folia 真实的 React 组件**（同一个页面里注入的 React island），
   见 [`docs/settings-ui-impl.md`](settings-ui-impl.md)。

## 2. 组件

```
Salt Player for Windows 1.19.x (JVM/Compose)  ── spawn ──▶  spw-folia-host.exe（每次全屏会话一个）
  spw-folia 插件（.spmod，PF4J，Kotlin）                     C# WinForms + WebView2
  ├─ MenuHook        更多 弹层的 item-adder hook             ├─ 无边框全屏窗口（DPI、多显示器、色键透明）
  ├─ TrayMenu        托盘右键菜单 hook                       ├─ 加载 web/（虚拟主机 spw-folia.local）
  ├─ PlaybackBridge  PlaybackExtensionPoint                  ├─ 注入 Shim.js → 设置岛 bundle → Folia 资源
  ├─ Timeline        1Hz → 60Hz 位置插值                     ├─ WASAPI 环回 → 0..255 FFT/bands/power（30–60Hz）
  ├─ ConfigSync      配置页开关读取与推送                    └─ stdio JSON-lines ⇄ 插件（协议 v1）
  ├─ HelperManager   spawn/stdin/stdout/exit-watch
  └─ LibraryBridge   封面/曲目元数据
                                                                   │ chrome.webview 消息
                                                                   ▼
                                             WebView2 页面 = Folia dist（/obs）+ 注入脚本
                                             ├─ Shim.js：假 EventSource → clock/audio/config 事件
                                             ├─ 设置岛（React）：歌词样式窗口、默认、17 格样式货架
                                             └─ publisher.ts：settings+lyrics+track+theme → config → pushConfig
```

## 3. 数据流

字段级契约见 [`docs/protocol.md`](protocol.md)，这里只列通道。

- **插件 → 宿主**：`hello`、`settings`（持久化设置种子）、`state`（posMs/durationMs/playing/rate/tsMs
  ≈10Hz）、`lyrics`、`track`、`queue`、可选 `config`、`quit`。
- **宿主 → 插件**：`ready`、`closed`、`settings`（页面改了设置 → 持久化）、`action`、`control`、`log`。
- **宿主 → 页面**：`hello`、`settings`、`state→clock`、`lyrics`、`track`、`queue`、
  `audio`（0..255 gamma 尺度 + 1024 bin 原始频谱，暂停时 0..40 呼吸值）、可选 `config`、`envReport`。
- **页面 → 宿主**：`ready`、`settings`、`control`、`hitbox`、`action`、`ui`、`log`、
  `envCheck`、`openLogFolder`、`openUrl`。
- **页面全局** `window.__SPW_FOLIA__`：`on/emit/getSettings/setSettings/pushConfig/requestClose/inputs/ui`。
- **config 所有权**：设置岛/publisher 在页面内构建完整的 `ObsBrowserSourceConfig`（≤10Hz 节流）
  并调用 `pushConfig`；Shim 把它当 `config` 事件分发。宿主从不构建 config。
- **音频留在宿主内**（与 WebView2 同进程）：没有 IPC 跳数，不需要额外 exe。

## 4. 入口 / 出口

- 更多 菜单 → **Folia** 条目 → 启动辅助进程 → 约 1 秒内进入全屏。
- 全屏内容 = Folia 视觉器本身（等同 Folia 的播放页视图），外加我们自己的最小 chrome：
  右上角 **设置齿轮**（打开「歌词样式」面板）、左上角 **返回/关闭**、右下角 **播放页设置按钮**
  （点开一个面板，包含「播放页透明背景」「鼠标穿透」「显示播放条」）。
  鼠标静止后光标与 chrome 一起淡出，**ESC** 先关设置面板、没有面板时关窗口。
- 首次运行（没有保存过设置）直接打开设置面板，让样式界面立刻可见；之后记住上次的面板状态。
  会话已存在时再点菜单项 → 不开第二个窗口，把已有窗口置前。
- 关闭 → 宿主发 `closed`，插件停止 state 喂送，等进程退出（2s 后强杀），下次可干净重开。
- 崩溃隔离：宿主崩溃不会带崩 SPW；插件记日志并允许重新打开。插件被禁用/卸载 → `quit` + 优雅
  终止；宿主不阻塞文件删除（用户数据在 `%LOCALAPPDATA%\spw-folia`）。

## 5. 打包

- 插件工程 `spw-folia/`（Gradle 9.8、JDK 25、Kotlin 2.4.20、Compose 编译器插件、官方
  `com.xuncorp.spw.workshop` 0.1.0-dev23、`spmod {}` 元数据、权限 `CLASS_TRANSFORM`）。
- `.spmod` = zip payload `classes/`（插件 jar）、`lib/`（运行时依赖）、
  `web/`（Folia dist 子集 + Shim.js + 设置岛 dist + 字体）、
  `native/`（`spw-folia-host.exe`、WebView2Loader.dll）、`licenses/`（Folia AGPL-3.0 + NOTICE + 第三方许可）。
- 宿主**原地**运行（不解包；`%APPDATA%` 可写）；WebView2 用户数据在 `%LOCALAPPDATA%\spw-folia\webview`。
- 完整打包流水线与发布检查表见 [`docs/release.md`](release.md)。
- 本地测试循环：解包 `.spmod` → `%APPDATA%\Salt Player for Windows\workshop\plugins\` 下的版本目录，
  `enabled.txt` 追加 `dev.spw.folia`，`permissions.json` 预授权，重启 SPW，看 `spw-folia.log`。
- 版本守卫：hook 目标在运行时由 `HostTargets` 解析 —— 缓存 → 已知 profile（回归基准/快速路径）→
  宿主字节码结构发现 → 旧 classpath 扫描，每一层结果都要过反射校验
  （[`docs/hook-target.md`](hook-target.md)）。低于 `HostTargets.Version.MIN_SUPPORTED`（1.19.0）
  直接拒绝注入并记日志；更新的未知版本在后台线程解析，而不是拒绝。

## 6. 保真度要求

- 17 种样式与顺序：商籁 sonnet、凝彩 tempera、绘光 lumiere、花火 hanabi、町景 machi、
  雾笺 nebbia、流光 classic、心象 cadenza、云阶 partita、浮名 fume、倾诉 tilt、回环 claddagh、
  莫奈 monet、时计 pendolo、群唱 cappella、镜台 diorama、静止 still。
  样式清单的单一事实源是 `poc/settings-ui/src/model/settings.ts` 的 `STYLE_MODE_SHELF_ORDER`。
- 设置窗口与 Folia 1:1：tab 歌词动画/背景/字体/字幕、默认重置、智能动感模式、动感效果、
  渲染质量、动态与构图、样式货架，以及各样式的 tuning 面板。
- 音频尺度 **0..255 + gamma**，暂停时呼吸值；`beatImpact`/`downbeatImpact` 只在能注入时才驱动动画，
  否则滑杆存值但动画保持静止（已记录，见 [`docs/known-inert-settings.md`](known-inert-settings.md)）。
- 默认值取 Folia 的存储默认（如代码里智能动感为关、纹理分辨率 1.5）。
- 样式切换走 Folia 自己的 softFocus/layer 过渡；背景 6 种模式（默认 latent）。

## 7. 风险与已知边界

- **菜单 hook 稳定性**：`hookMethod` 按 JVM 名 + 参数类型匹配，能扛住 Kotlin 层改名；被混淆的名字
  在运行时解析（缓存 → 已知 profile → 字节码结构发现），每个结果用前都要反射校验。
  页面结构被重构（不再有 `BlurPopupMenu` 形状的弹层，或 flyout 不再吃 `Track`/`PiscesMediaItem`）
  仍会打断发现 —— 那时它会明确失败、Folia 条目直接缺失，绝不错误注入。详见
  [`docs/hook-target.md`](hook-target.md)。
- **dist 自包含**：Folia dist 若引用 CDN 字体/资源，必须本地打包并离线验证。
- **WebView2 可用性**：依赖系统 runtime；loader dll 随包分发；缺失时给明确提示（exit 3）。
- **节拍特效**：需要模型或注入的模块 MV；不可用时优雅降级。
- **音频环回**：独占模式/ASIO 输出可能采到静音 → 宿主回落到静态/呼吸值。
- **混淆漂移**：R8 改名不再打断 hook（结构发现）；真正会打断的是页面**结构**重写。
  字节码索引在 1.19.3 上耗时约 1.3–1.5 s，所以只在后台线程跑，并按宿主 build 缓存。
