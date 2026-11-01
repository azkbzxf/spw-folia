# spw-folia — 架构

**SPW 1.19.0+ 的 Windows 创意工坊插件**：在迷你播放器的「更多」菜单里加一个 **Folia** 条目，
点击后打开**全屏 Folia 歌词模式**，复现 Folia 的 15 种歌词样式、全部效果、设置界面与默认值。
以 **AGPL-3.0**（Folia 衍生作品）发布在 `azkbzxf/spw-folia`（topic `salt-player-plugins`），
产物是 `.spmod`。

相关文档：

- [`protocol.md`](protocol.md) — 插件↔宿主↔页面 的协议 v1，字段级的实现契约。
- [`hook-target.md`](hook-target.md) — 「更多」菜单的 hook 目标、结构发现链、已知版本基线、降级路径。
- [`folia-spec/`](folia-spec/) — 从 Folia 源码提取的行为规格（15 样式、设置、音频尺度、主题、转场）。
- 实现文档：[`host-app.md`](host-app.md)、[`settings-ui-impl.md`](settings-ui-impl.md)、
  [`audio-timeline.md`](audio-timeline.md)。
- 反向工程背景与历史证据：[`archive/`](archive/)。

## 1. 核心决策

1. **不把 Folia 的视觉器移植到 Kotlin。** Folia（React/TS，约 6 万行，AGPL-3.0）本身就提供了
   **OBS 浏览器源**这一入口：`dist` 在 pathname 为 `/obs` 或带 `?obs=1` 时挂载
   `ObsBrowserSourceApp`（普通浏览器页面，不需要 Electron）。所以直接打包 Folia 的真实生产构建，
   得到像素级一致的 15 种样式、背景、辉光字、字幕叠加与转场。
2. **没有 HTTP 服务器、不联网、不用 Electron。** WebView2 宿主把本地目录映射成虚拟主机
   `https://spw-folia.local`；Folia 的 `EventSource` 被注入的 **Shim.js** 替换，
   数据来自 `window.chrome.webview` 消息。插件因此体积小、离线、攻击面低。
3. **原生辅助进程 `spw-folia-host.exe`**：C# .NET Framework 4.8 + WinForms + WebView2
   （系统运行时）——无边框全屏窗口、WASAPI 环回音频分析、与 JVM 插件的 IPC。
   理由：SPW 是 512 MB 堆的 Compose/Skia 应用，把 Chromium/JCEF 塞进 JVM 又重又险；
   而辅助进程是被验证过的模式（spw-island 也带原生 exe）。
4. **插件保持薄**：它持有数据（播放时钟、歌词、曲目/封面、设置持久化）与生命周期，从不负责渲染。
   页面负责设置 UI + 构建 `ObsBrowserSourceConfig` + 渲染。
5. **设置 UI 复用 Folia 真实的 React 组件**（React island 注入到同一个页面），依据
   [`folia-spec/settings-ui.md`](folia-spec/settings-ui.md)；降级控件按同一份规格降级。

## 2. 组件

```
Salt Player for Windows 1.19.x (JVM/Compose)  ── spawn ──▶  spw-folia-host.exe (每次全屏会话一个)
  spw-folia 插件 (.spmod, PF4J, Kotlin)                     C# WinForms + WebView2
  ├─ MenuHook      对 更多 builder 做 hookMethod            ├─ 无边框全屏窗口（DPI、多显示器）
  ├─ PlaybackBridge PlaybackExtensionPoint                  ├─ 加载 web/（虚拟主机 spw-folia.local）
  ├─ Timeline      1 Hz → 60 Hz 位置插值                    ├─ 注入 Shim.js → 设置岛 → 资源
  ├─ ConfigStore   设置 JSON 落在 workshop/data/<id>/       ├─ WASAPI 环回 → 0..255 FFT/五带/power（~30–60 Hz）
  ├─ HelperManager spawn/stdin/stdout/退出监视               └─ stdio JSON 行 ⇄ 插件（protocol v1）
  └─ LibraryBridge 封面/曲目元数据
                                                                    │ chrome.webview 消息
                                                                    ▼
                                              WebView2 页面 = Folia dist (/obs) + 注入脚本
                                              ├─ Shim.js：假 EventSource → clock/audio/config 事件
                                              ├─ 设置岛（React island）：歌词样式窗口、默认、15 格样式
                                              └─ publisher.ts：设置+歌词+曲目+主题 → config → pushConfig()
```

## 3. 数据流（protocol v1，字段级细节见 [`protocol.md`](protocol.md)）

- 插件 → 宿主：`hello`、`settings`（持久化设置种子）、`state`（posMs/durationMs/playing/rate/tsMs，~100 ms）、
  `lyrics`（行+cells+offset）、`track`（元数据 + coverDataUrl）、可选 `config`、`quit`。
- 宿主 → 插件：`ready`、`closed`、`settings`（UI 改动 → 持久化）、`action`、`log`。
- 宿主 → 页面：`hello`、`settings`、`state→clock`、`lyrics`、`track`、`audio`（0..255 gamma 尺度、
  1024 bin 原始频谱、暂停时呼吸量 0..40）、可选 `config`/`beat`。
- 页面 → 宿主：`ready`、`settings`、`action`（close/reset/openDevTools）、`log`。
- 页面全局 `window.__SPW_FOLIA__`：`on/emit/getSettings/setSettings/pushConfig/requestClose/inputs`。
- **配置归属**：设置岛 / publisher 在页面内构建完整的 Folia `ObsBrowserSourceConfig`（节流 ≤10 Hz）
  并调 `pushConfig`；Shim 把它派发成 config 事件。宿主从不构建配置。
- 音频完全在宿主内（与 WebView2 同进程）：没有 IPC 跳数，不需要额外 exe。

## 4. 入口 / 退出体验

- 「更多」菜单 → **Folia** 条目（钟形/图形图标）→ 启动辅助进程，约 1 s 内进入全屏。
- 全屏 = 只有 Folia 视觉器（像 Folia 的播放页），外加我们自己的一层最小 chrome：
  右上角**设置齿轮**（打开歌词样式面板）、左上角**返回/关闭**按钮、右下角**播放页背景按钮**
  （金色滑杆图标 → 面板里的「播放页透明背景」开关，透明开启时 chrome 保持可见）；
  鼠标静止后隐藏光标，chrome 自动淡出；ESC = 设置面板开着就先关它，否则关窗口。
- **首屏不自动弹设置**：设置面板只在用户点 ⚙ 或按 F1 时打开。每次打开 Folia 模式都以覆盖层关闭
  的状态开始（页面不持久化面板开关）；同一次会话里组件不卸载，所以再次打开是即时的、预览帧不闪。
  再次点菜单项时若会话已打开，不产生第二个窗口（置前）。
- 关闭 → 宿主发 `closed`，插件停止状态推送、等待退出（2 s 后强杀），下次可干净重开。
- 崩溃隔离：宿主崩溃不会拖垮 SPW；插件记日志并允许重开。插件禁用/卸载 → 发 `quit` + 优雅终止；
  宿主不阻塞文件删除（用户数据在 `%LOCALAPPDATA%\spw-folia`）。

## 5. 打包

- 插件工程 `spw-folia/`（Gradle 9.8、JDK 25、Kotlin 2.4.20、Compose 编译器插件、
  JitPack 上的官方 `com.xuncorp.spw.workshop` 0.1.0-dev23、`spmod {}` 元数据）。
- 权限三项：`class-transform`、`library-read`、`key-bindings`
  （`spw-folia/build.gradle.kts`）。缺 `class-transform` 就没有菜单项，缺 `library-read` 就没有
  歌词/封面，缺 `key-bindings` 只是没有快捷键。
- `.spmod` 的 zip 载荷：`classes/`（插件 jar）、`lib/`（运行时依赖，通常为空）、
  `web/`（Folia dist + Shim.js + 设置岛 + 缩略图）、`native/`（`spw-folia-host.exe`、
  `exe.config`、3 个 WebView2 dll）、`licenses/`（Folia AGPL-3.0 + NOTICE + 第三方许可）。
  官方 gradle 插件只产 `classes/` + `lib/`，其余由 `packaging/tools/assemble-release.py` 合并进来
  （见 [`release.md`](release.md)）。
- 插件从安装目录**原地**运行辅助进程（不解压；`%APPDATA%` 可写）；WebView2 用户数据在
  `%LOCALAPPDATA%\spw-folia\webview`。
- 本地测试循环：解包 `.spmod` →
  `%APPDATA%\Salt Player for Windows\workshop\plugins\dev.spw.folia-<ver>-LOCAL-ONLY\`，
  在 `enabled.txt` 里追加 `dev.spw.folia`，在 `permissions.json` 预授权
  `{"dev.spw.folia":{"reviewed":["class-transform","library-read","key-bindings"],
  "granted":["class-transform","library-read","key-bindings"]}}`，重启 SPW，看 `spw-folia.log`。
- 版本守卫：hook 目标在运行时由 `HostTargets` 解析——缓存 → 内置 profile（回归基准 / 快路径）→
  宿主字节码的结构发现 → 旧的 classpath 扫描，每一层的结果都要过反射校验
  （见 [`hook-target.md`](hook-target.md)）。低于 `HostTargets.Version.MIN_SUPPORTED`（1.19.0）
  直接拒绝并记一行日志；未知的新版本在后台线程解析，而不是拒绝。

## 6. 保真要求（来自 Folia spec）

- 15 种样式与顺序/名称：商籁 sonnet、凝彩 tempera、绘光 lumiere、花火 hanabi（order 26）、
  流光 classic、心象 cadenza、云阶 partita、浮名 fume、倾诉 tilt、回环 claddagh、莫奈 monet、
  时计 pendolo、群唱 cappella、镜台 diorama、静止 still。
- 设置窗口与 Folia 一致：标签页 歌词动画/背景/字体/字幕、默认重置、
  渲染质量（纹理分辨率 + GPU 提示）、动态与构图（镜头运动强度 / 文字动势）、
  15 格样式的样式栏、每种样式自己的参数面板。
- 音频尺度 **0..255 带 gamma**，暂停时呼吸；`beatImpact`/`downbeatImpact` 在拿不到节拍事件时
  不驱动动画（滑杆值照常存进设置树）。
- 默认值 = Folia 的存储默认值（例如纹理分辨率 1.5；截图里的 1.00x 是用户改过的状态）。
- 样式切换走 Folia 的 softFocus / 图层过渡；背景 6 种模式（默认 latent）。

## 7. 风险

- **菜单 hook 稳定性**：`hookMethod` 匹配 JVM 名称 + 参数类型，因此能扛住 Kotlin 改名；
  *混淆后* 的名字在运行时解析（缓存 → 内置 profile → 宿主字节码的结构发现），每个结果在被使用前
  都过反射校验。但**页面结构重构**（不再有 `BlurPopupMenu` 形状的弹层，或弹层不再接收
  `Track` / `PiscesMediaItem`）仍会打断发现——这时它会响亮失败，Folia 条目直接缺失，绝不会错误注入。
  降级路径：旧 classpath 扫描，再不行是 `replaceComposable` / 用快捷键开窗。
  详见 [`hook-target.md`](hook-target.md)。
- **dist 自包含**：Folia dist 可能引用 CDN 字体/资源——必须本地打包并验证离线可用。
- **WebView2 可用性**：系统运行时缺失时给出可读的失败信息（而不是黑窗口）。
- **节拍特效**：需要节拍检测模型或注入的模块，当前不提供。
- **音频环回**：独占模式 / ASIO 输出可能抓不到声音 → 宿主降级为静态/呼吸值。
- **混淆漂移**：R8 改名不再打断 hook（结构发现）；真正会打断的是页面结构重构。
  在 1.19.3 上字节码索引耗时约 1.3–1.5 s，因此只在后台线程跑，并按宿主版本缓存。
