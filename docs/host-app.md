# spw-folia-host — 原生全屏宿主（protocol v1 实现）

`spw-folia-host.exe` 是 `spw-folia` Kotlin 插件在用户打开 Folia 模式时 spawn 的原生辅助进程。
它持有一个无边框全屏窗口，在 WebView2 里承载 Folia 的生产 OBS 视觉器 bundle，把插件的协议 v1
JSON 行经由注入的 shim 转发进页面，采集 WASAPI 环回音频并推给页面，再把生命周期与错误回报给插件。
它**不含任何音乐/业务逻辑**——插件是唯一真源。契约见 [`protocol.md`](protocol.md)。

源码：`poc/webview/host/` — `Program.cs`（CLI、JSON 辅助、stdout 写出、main）、
`HostForm.cs`（窗口、WebView2、定时器 tick、stdin 循环、截图）、`AudioProvider.cs`
（synthetic / stdin / WASAPI 环回的接缝）、`Shim.js`（注入：EventSource 桥 + `window.__SPW_FOLIA__`）、
`Overlay.js`（注入的占位 HUD）、`PreviewShim.js`（设置页预览 iframe 用）、`IntroCurtain.cs`
（v0.4.0 开屏转场）、`MonitorSupport.cs` / `DpiSupport.cs`（多显示器与 DPI）、`build.sh`、
`driver.mjs`（协议 v1 测试驱动）、`app.manifest`。音频实现来自 `poc/audio/native/*.cs`
（本项目原创，MIT），构建时拷到 `poc/webview/host/audio/` 一起编译。

---

## 1. 构建

不需要 .NET SDK，也不需要 MSBuild：Windows 自带的 C# 5 编译器（in-box `csc.exe`）就够。

```bash
cd poc/webview/host
bash build.sh
```

`build.sh` 做这些事：

1. `csc.exe` = `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（v4.0.319，C# 5 语言级别；
   没有字符串插值 / `?.` / 表达式体——async/await 可用）。
2. `export MSYS2_ARG_CONV_EXCL='*'` 并把每个路径过 `cygpath -w`（否则 MSYS 会把 `/out:` 当
   POSIX 路径处理，报 `error CS2001`）。
3. 从 `poc/webview/shared/demoData.mjs` 重新生成 `DefaultConfig.json`（内嵌的演示配置）。
4. 编译：`-target:exe -platform:x64 -optimize+ -define:LOOPBACK -win32manifest:app.manifest`，
   把 `Shim.js`/`Overlay.js`/`DefaultConfig.json` 作为资源嵌入，引用
   `System.dll System.Core.dll System.Windows.Forms.dll System.Drawing.dll
   System.Web.Extensions.dll`（JavaScriptSerializer 就是 JSON 解析器）以及
   `poc/webview/tools/sdk/` 里的 WebView2 SDK dll；源码 = `Program.cs DpiSupport.cs MonitorSupport.cs
   HostForm.cs IntroCurtain.cs AudioProvider.cs
   audio/{AudioInterop,SpectrumAnalyzer,FoliaAudioMapper,SharedAudioRing,LoopbackAnalyzer}.cs`。
5. 写出 `build/spw-folia-host.exe.config`（`supportedRuntime v4.8`、PerMonitorV2 DPI 感知、
   `EnableWindowsFormsHighDpiAutoResizing`），并把 `Microsoft.Web.WebView2.Core.dll`、
   `Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll` 拷到 exe 旁边。

产物：`build/spw-folia-host.exe` + `.config` + 3 个 WebView2 dll，合计约 **1.04 MB** 解压后
（Core 约 700 KB / WinForms 约 39 KB / Loader 约 195 KB）。重建约 1 s。

WebView2 SDK dll 的获取：从 NuGet 包 `Microsoft.Web.WebView2` 里取
`lib/net462/Microsoft.Web.WebView2.{Core,WinForms}.dll` 与
`runtimes/win-x64/native/WebView2Loader.dll`，放进 `poc/webview/tools/sdk/`
（`packaging/build-package.sh` 用的 nupkg 在 `poc/webview/tools/webview2.nupkg`）。

---

## 2. CLI 参考

```
spw-folia-host.exe [options]
```

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `--bundle <dir>` | – | 生产 bundle 目录（含 `index.html`），以 `https://spw-folia.local/` 提供。除非给了 `--dev-url`/`--url`，否则必需。 |
| `--dev-url <url>` | – | 开发服务器 URL（protocol §7），例如 `http://127.0.0.1:18080/?obs=1&token=dev`；不做虚拟主机映射。 |
| `--url <url>` | 派生 | 显式加载 URL 覆盖（调试；正常由 bundle + `?obs=1&token=…` 派生）。 |
| `--fullscreen` | **开** | 无边框全屏、置顶（协议默认）。开在 SPW 窗口所在的那块屏幕上。 |
| `--window <w>x<h>` | 1280×720 | 窗口化模式（`--window 1600x900`，也接受 `1600,900`）。 |
| `--windowed [w,h]` | – | 窗口化模式的 flag 形式，尺寸可选。 |
| `--width`, `--height` | 1280, 720 | 窗口尺寸分量。 |
| `--no-topmost` | 置顶开 | 取消总是置顶。 |
| `--user-data <dir>` / `--user-data-dir <dir>` | `%LOCALAPPDATA%\spw-folia\webview` | WebView2 配置目录。 |
| `--fps-log [path]` | 无文件 | 追加页面 FPS 采样（`atMs,fps,heapMB,canvases,dpr,w,h`）。 |
| `--screenshot <png>` `--shot-at <ms>` | – / 5000 | 在启动后 N ms 抓一次页面内容（PNG，`CapturePreviewAsync`）。 |
| `--duration <ms>` | 0 = 跑到关窗 | N ms 后自动关闭（诊断）。 |
| `--devtools` | 关 | 启用 WebView2 devtools。 |
| `--title <text>` | `spw-folia-host` | 窗口标题。 |
| `--no-esc` | ESC 可关 | 禁用 ESC 关窗（kiosk 测试）。 |
| `--keep-alive` / `--exit-on-stdin-close` | stdin EOF 就退出 | `--keep-alive` 让辅助进程在 stdin EOF 后继续活着。 |
| `--demo` / `--no-demo` | 关 | 内嵌合成演示配置，并自动把 stdin 的 lyrics/track 补成 Folia 形状（独立运行用）。 |
| `--mode <name>` | 来自配置 | 强制内嵌演示配置里的 `visualizerMode`。 |
| `--dev-settings <json-or-path>` | – | 初始设置树：内联 JSON 或 `.json` 文件路径；启动时喂给设置 UI。 |
| `--assets <dir>` | – | 额外的静态目录，映射到 `https://spw-folia-assets.local/`。 |
| `--no-overlay` | 注入 overlay | 跳过占位 HUD 脚本（自动化测试）。 |
| `--settings-dir <dir>` | 自动探测 | 设置 UI 产物目录 → 映射到 `https://spw-folia-settings.local/`，其入口 module script 在 `Shim.js` **之后**注入。不给时若 `<bundle>/settings/settings-ui.js` 存在则自动采用。 |
| `--settings-entry <file>` | `settings-ui.js` | `--settings-dir` 里的入口文件名。 |
| `--no-transparency` | 关 | 即使持久化设置要求透明背景也强制不透明窗口（诊断 / 回归）。 |
| `--force-dsf <n>` | 跟随 Windows | 给 WebView2 传 `--force-device-scale-factor=n`（DSF=1 时 CSS px = 设备 px；**仅调试**）。 |
| `--bundle-version <text>` | – | 回显在页面的 `hello` 消息里，并作为设置岛注入 URL 的 cache-buster（`?v=`）。 |
| `--exit-after-fps <n>` | 0 = 关 | 诊断：页面 FPS 采样 ≥ n 时关闭。 |
| `--audio-log` | 关 | 每 ~2 s 打印一行 `{"t":"audio-stats",…}`（环回验证）。 |
| `--no-curtain` | 开屏动画开 | 关闭开屏转场动画。 |
| `--curtain-duration <s>` | 0.8（夹 0.3–2.0） | 开屏淡入时长。 |
| `--curtain-palette <#hex,…>` | – | 开屏动画的封面派生配色。 |
| `--verbose-log` | 关 | 额外诊断（环境报告、各级页面 console、逐窗口卡顿）。 |
| `--log-file <path>` | – | 插件的宿主日志路径，会写进「出现问题」的环境报告。 |
| `--open-settings` | 关 | 设置岛发出 `bridgeReady` 后自动展开一次设置面板（导航完成后 2.5 s 兜底定时器）。**插件不传这个参数**——真实用户首次运行不会自动弹设置；只有 `verify-layout.mjs` 这类验收脚本会传。 |

Track 消息里的专辑封面是 base64 data URL（`coverDataUrl`）。宿主把同一个值以
**`coverDataUrl` 与 `coverUrl` 双写**转发给页面，因为设置岛的主题派生读 `coverUrl`；
没有这个镜像，派生主题会静默停在默认调色板。

**退出码**：`0` 正常关闭；`2` 参数错误 / bundle 目录缺失或没有 `index.html`；
`3` 找不到 WebView2 Runtime（辅助进程会先打一行
`{"t":"log","level":"error","msg":"webview2-runtime…"}`，插件应当提示「安装 WebView2 Runtime」
而不是给一个黑窗口）；`1` 其他错误（窗口/WebView2 初始化失败、未捕获异常）。
stdout 上的最后一条消息永远是 `{"t":"closed","reason":"user"|"error"|"plugin"}` 之后才退出。

---

## 3. 协议 v1 行为（逐项对应 [`protocol.md`](protocol.md)）

### stdin → 宿主（按 `t` 字段）
`hello`（记录版本；可选 `devUrl` 会导航页面）、`settings`（存下并转发给页面为
`{"type":"settings"}`；页面 `ready` 时重发）、`state`（时钟插值的锚点，见下）、
`lyrics`（转发为 `{"type":"lyrics"}`；`--demo` 时先把协议行转成 Folia `LyricData` 形状）、
`track`（转发为 `{"type":"track"}`；`--demo` 时补齐演示配置）、
`config`（替换基础配置，并在下一次 page-ready/补丁时转发）、
`audioMode`（`off`/`stdin`/`loopback` 路由）、`quit`（以 reason `plugin` 关闭）、
以及 `command`（`close`、`screenshot {path}`、`settings`/`open-settings`/`close-settings` → 转成页面的
`ui` 消息、`eval {script}` 调试）。

健壮性：UTF-8、容忍 CRLF、跳过空行、半行由 `StreamReader` 缓冲；无法解析的行转成 `log` 行，
辅助进程继续跑。stdin EOF → 2 s 定时器 → 以 reason `plugin` 关闭（插件已经死了也不会留下僵尸窗口）；
`--keep-alive` 关掉这条。

### stdout → 插件（按 `t` 字段）
`ready` `{protocol:1,pid,webviewVersion,bundle,startedAtMs}`，在页面导航完成且 shim 装好后立刻发；
`closed` `{reason}`；`settings` `{settings}`（页面推了设置改动）；`action`
`{name:"reset"|"openDevTools"|"reload"}`；`log` `{level,msg}` 用于诊断
（另有 `fps`、`screenshot`、`eval-result`、`audio-stats` 等诊断行）。

### host → page
15 ms（约 64 Hz）的定时器发 `{"type":"state",posMs,durationMs,playing,rate,lyricOffsetMs,tsMs}`
与 `{"type":"audio",power,bass,lowMid,mid,vocal,treble,spectrum[…],tsMs}`。注入的 shim 把它们
变成 Folia 真实的 SSE 事件形状：`state` → `clock`
`{currentTime:posMs/1000,duration,playerState:'PLAYING'|'PAUSED',sentAtMs:Date.now(),
playbackRate:rate,lyricOffsetMs:offset/1000}`（节流 250 ms 或播放状态变化时立即发；Folia 页面自己
在采样之间插值）；`audio` → `{audioPower,bands:{bass,lowMid,mid,vocal,treble},
spectrum:Uint8Array(1024),sentAtMs}`。`config`/`lyrics`/`track` 被派发成同名 SSE 事件；
未知/调试消息通过 `window.__SPW_FOLIA__.on(...)` 暴露，页面→宿主的
`action`/`log`/`settings`/`beatDebug` 通道也用同样方式接好。

暂停/播放结束（或环回帧静音/缺失）时发协议 §5 的呼吸载荷：
`power` 与五个带全为 `(sin(now/2000)+1)*20`，`spectrum` 为空——Folia 的「呼吸」待机观感。

时钟锚定：`state` 还新鲜（≤ 500 ms）时宿主发 `anchorPosMs + (now - anchorAtTick) * rate`；
插件停止推送（state 变陈旧）后宿主自由外推，窗口不会因插件打嗝而卡住。

### page → host（经 `window.chrome.webview.postMessage`）
`ready`（页面挂载完成 → 宿主重发 `hello`/`settings`）、`settings`、`action`（close/reset/
openDevTools → 转发到 stdout 并执行）、`log`、`fps`（rAF 采样：fps/longFrames/heapMB/canvases/
dpr/w/h）、`key`（ESC 由宿主处理，F1 发出 `ui` 的 toggle-settings 动作）、
`bridgeReady`（设置岛初始化完成）。

### 光标与设置覆盖层状态

全屏窗口**不会**永久隐藏光标。`HostForm.OnTick` 里的 15 ms tick 跟踪 `Cursor.Position`；
2.5 s 无移动就 `Cursor.Hide()`，下一次移动重新显示，设置覆盖层打开期间强制可见。
只记录状态变化（`cursor hide overlay=closed idleMs=…`、`cursor show …`），关窗/进程退出时恢复显示。

覆盖层状态经正常桥从页面过来：设置 UI 每次开/关都
`chrome.webview.postMessage({"type":"ui","settingsOpen":bool})`；Shim 截获自己的
`settingsUI` 特殊消息，因此不会被本地再派发一次。同一个 `settingsOpen` 标志决定 ESC 的优先级：
F1 / `command open-settings` 打开面板，第 1 次 ESC 关面板（窗口还在），第 2 次 ESC 关窗口
（`closed{reason:user}`，exit 0）。

### 窗口 / 生命周期
无边框 `Form`，黑底。全屏时的显示器选择：

```csharp
Screen monitor = userMoved
    ? Screen.FromRectangle(Bounds)
    : MonitorSupport.ScreenForProcess(DpiSupport.ParentProcessId());
if (monitor == null) monitor = Screen.PrimaryScreen;
```

即窗口开在 **SPW 窗口所在的那块屏**（按父进程 PID 定位），**不是**系统主屏；用户用 Alt+左键拖过
窗口之后（`userMoved`），后续的几何修正（DPI 变化、极小视口恢复）保持在拖到的屏幕上，不会拉回。
请求到的全屏矩形如果不合常理地小（插件 spawn 时出现过的 8×6 视口），退回到该屏的工作区居中窗口，
而不是显示一条细缝。

`TopMost`、`ShowInTaskbar=false`；ESC（宿主的 `ProcessCmdKey` 或页面 keydown）与 Alt+F4 关闭，
reason `user`，exit 0。WebView2 配置为允许自动播放、关闭节流与遮挡检测
（`--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling
--disable-renderer-backgrounding --disable-backgrounding-occluded-windows
--disable-features=CalculateNativeWinOcclusion`），右键菜单/状态栏/滑动/缩放关闭。

### 播放页透明背景

`settings.transparentPlayerBackground`（由注入 chrome 的右下角滑杆按钮切换）把宿主窗口变成色键
分层窗口：`BackColor` 与 `TransparencyKey` 都设为 `rgb(255,0,255)`，`WebView2.DefaultBackgroundColor`
设为 `Color.Transparent`；关掉时恢复 `BackColor=Black` / 无 key / 不透明 `DefaultBackgroundColor`。
这个标志从三条路径读取——构造时（`--dev-settings`）、stdin 的 `settings`、页面的
`{"type":"settings"}`——因此窗口立即跟随 UI 开关，插件只负责持久化整棵树。页面侧设置模型发出
`background.transparent`，让 Folia 跳过背景渲染；OBS 模式下文档背景本来就是透明的。

色键合成的两个副作用都有补偿：(1) 带 key 的窗口完全点击穿透，所以透明生效期间注册一个全局热键
—— **Ctrl+Alt+B**，失败时依次退到 Ctrl+Alt+Y / Ctrl+Alt+P / Ctrl+Alt+Shift+B —— 把透明关掉并调用
`window.__spwFoliaSetTransparent(false)`，让页面开关与持久化的树保持同步；(2) `backdrop-filter`
图层不会被色键合成绘制，因此 chrome 与其面板通过 `data-flat='true'` 切到纯色背景。
日志：`transparency mode=on|off`、
`transparency hotkey=registered|off|unregistered|failed`。细节与限制见
[`live-transparency.md`](live-transparency.md)。

---

## 4. Kotlin 插件如何 spawn 它

打包布局：

```
pluginDir/
  classes/…                 # 插件 jar
  web/…                     # Folia bundle（index.html + assets + settings/）
  native/spw-folia-host.exe # + exe.config + 3 个 WebView2 dll
```

实际的 spawn 命令行（工作目录 = 插件目录，传的全是绝对路径；`cwd` 只是兜底）：

```text
native\spw-folia-host.exe --bundle <web 绝对路径> --fullscreen --bundle-version <插件版本>
    [--no-curtain | --curtain-palette #RRGGBB,…]
    [--settings-dir <dir> --settings-entry settings-ui.js]      # 仅当设置岛不在 <bundle>/settings/
    --log-file <插件目录>\spw-folia-host.stdout.log
    [--verbose-log]
```

要点：

- `resolveHelper()` 依次找 `host/`、`host/x64/`、`lib/`、`lib/x64/`、`native/`、`native/x64/`
  （外加开发检出的兜底），所以 `native/` 与 `lib/` 两种发布布局都能启动。
- `resolveSettingsDir()` 在 `<bundle>/settings/settings-ui.js` 存在时返回 null，**不传**
  `--settings-dir`——辅助进程会自己探测。
- 三个 flag 由 SPW 配置页驱动：`--no-curtain`/`--curtain-palette`（开屏动画）、
  `--verbose-log`（详细日志）。
- `--log-file` 指到插件目录下的 `spw-folia-host.stdout.log`，插件把宿主 stdout 也镜像进去，
  「出现问题」报告会引用这个路径。

发送节奏：`hello` → `settings` →（收到 `ready` 后）`lyrics` + `track` + `config`，之后每 100 ms
一条 `state`。收到 `closed` 后停止发 `state`；用户改设置时按 ≤10 Hz 更新 `config`。
不要在 `ready` 之前发 `state`（辅助进程能容忍，但页面还没在听）。

---

## 5. 已知限制

- **节拍特效不可用** —— 节拍检测模型不在 webview 里，宿主也不发节拍事件。
- 环回是 **post-volume** 采样：调低系统音量会降低视觉反应强度（这是 Folia 的预期行为）。
- AGC 默认关闭。
- 播放页透明是色键分层窗口，因此**鼠标输入会穿透**，且透明期间 `backdrop-filter` 被丢弃。
- 多显示器：窗口开在 SPW 窗口所在的屏幕上，可用 Alt+左键拖到别的屏幕；没有显示器选择器。
- 一个 user data 目录一个 WebView2 配置。
- 页面必须 100% 离线（已验证无外部网络请求）。

---

## 6. 独立运行与测试驱动

```bash
# 构建
cd poc/webview/host && bash build.sh

# 协议 v1 端到端：spawn 宿主、发 hello/settings/lyrics/track、按 100 ms 流式发 state
# + 60 Hz audio、在不同时钟位置截图、模拟 ESC、写报告
node driver.mjs --window 1600x900
node driver.mjs --fullscreen --out out/fullscreen

# 15 种样式在宿主窗口里轮播（走实时 config 通道）
node driver.mjs --window 1280x720 --out out/host-styles-run \
  --modes sonnet,tempera,lumiere,diorama,pendolo,monet,fume,cappella,partita,claddagh,cadenza,tilt,still,window,classic

# 开发服务器变体（protocol §7），插件开发构建用
cd poc/webview/server && node server.mjs 18080 &
./build/spw-folia-host.exe --dev-url "http://127.0.0.1:18080/?obs=1&token=dev" --window 1600x900 --demo
```

产物：`out/driver-report.json`（ready/closed/exit/fps/screenshots/stderr/stdout）、
`out/smoke/driver-report.json`、`out/fullscreen/`、`out/host-styles-run/`（15 张宿主截图）、
`out/loopback-test.jsonl`（`--audio-log` 轨迹）。

注意：独立运行需要 `--demo` 或一次 config 推送（插件本来就会推）。没有配置时页面正确地显示
「等待 Folia 播放」的待机态，这不是 bug。

---

## 7. 踩过的坑（维护者需要知道的）

### 7.1 被 GUI 父进程 spawn 时的几何塌缩

插件 JVM 以 `javaw.exe`（无 console）启动时，第一次集成的页面 CSS 视口是 **8×6**：窗口被 spawner
的 `STARTUPINFO` 建成隐藏/零尺寸（或 WebView2 初始化期间窗口一直没有明确几何），WebView2 于是把
合成器尺寸设成 8×6 的客户区，Folia 舞台被排进邮票大小的框里。同一个 exe 从 console
（`java.exe` 或手动）启动则正常——所以这是 spawn 上下文的问题，不是渲染问题。
失败是静默的：宿主照常打 `ready` 和 FPS，页面也画出 3 个 canvas，只有几何是错的。

修复（都在 `poc/webview/host/`）：

- **`DpiSupport.cs`**：DPI 感知在初始化时被**报告**出来。先 `SetProcessDpiAwarenessContext(PMv2)`；
  若因「manifest 已设」而失败于 `ERROR_ACCESS_DENIED`（正常情形），报告
  `already-set(<DescribeAwareness>)`，而不是给出误导性的 `system`。日志行
  `dpi-init result=… awareness=…` 让状态可审计。
- **`HostForm.CreateParams`**：句柄创建时强制 `WS_VISIBLE`，即使父进程传 `SW_HIDE` 窗口也是可见的。
- **`ApplyWindowGeometry(reason)`** 幂等，并在**句柄创建、OnLoad、Navigate 之后、首帧之后、
  以及 3.5 s 后**各调一次；它重新断言边界（全屏用 `monitor.Bounds`，`--window` 用 `ClientSize`）、
  `TopMost`、`ShowInTaskbar=false`，并在父进程把我们 spawn 成隐藏时
  `ShowWindow(SW_SHOW/SW_RESTORE)+SetForegroundWindow`。每次调用都记
  `geometry reason=… mode=… bounds=… client=… screen=… workarea=… dpi=… winDpi=… awareness=…`。
- **`DpiSupport.PageViewport`**：`fps`/页面视口日志带上 `{w,h,dpr,canvases,client}`，
  几何回归在任何一次运行里都能看出来：页面 CSS 视口必须等于 `client px / DSF`
  （例如 3200×2000 物理 → 1776×1110 CSS @180 %），不能是极小的值。
- `--no-esc` 对所有关闭路径生效；诊断只走 stderr 与 stdout 的 `log` 行，绝不往协议流里写非 JSON。

参照：`winDpi=173`（180 % 缩放）时 .NET Framework 的 `Form.DeviceDpi` 仍报 96，因此任何缩放决策
都用 `GetDpiForWindow`（并记日志），绝不用 `DeviceDpi`。

### 7.2 设置岛注入的缓存陈旧

注入的设置岛从一个固定的虚拟主机 URL 加载，WebView2 的 HTTP 磁盘缓存（user data 目录
`%LOCALAPPDATA%\spw-folia\webview`）可能在插件升级后继续供**旧的** `settings-ui.js`。因此 module
URL 是带版本的：`https://spw-folia-settings.local/<entry>?v=<bundleVersion>`，`bundleVersion`
来自插件（`--bundle-version <插件版本>`，protocol 的 `hello.bundleVersion`，兜底 `dev`）。
日志行：`settings-inject url=…`。`Shim.js` / `Overlay.js` 作为脚本字符串编译进 exe（不是 URL），
因此不会陈旧。

诊断这类问题必须**每次运行都解一份新的载荷**并给一个**新的 `--user-data-dir`**：曾经有个诊断脚本
复用了 `%TEMP%` 下的旧解包树，于是评估的是修复前的 `settings-ui.js`，得出了误导性的根因
（齿轮 `data-visible=true` 但 computed `pointer-events:none`）。

### 7.3 早期 stdin 的 post 失败

插件按协议在 spawn 后**立刻**发 `hello`/`settings`，此时 WebView2 控制器可能还没创建。
`PostToPage` 在 `webviewReady == false` 或 `CoreWebView2 == null` 时记一行
`debug post-page-skip reason=not-ready bytes=N` 后返回，不再抛 NRE；
`settings`/`config` 在 `NavigationCompleted` 重发，`lyrics`/`track` 缓存最后一份 payload 并在导航
完成时回放（否则设置页的输入区 / 歌词预览可能是空的）。

---

## 8. 调试与排障入口

- 日志：插件目录下的 `spw-folia.log` 与 `spw-folia-host.stdout.log`；
  加 `--verbose-log`（或 SPW 配置页的详细日志开关）会追加导航行、各级页面 console 与逐窗口卡顿。
- 几何问题：先看 `geometry …`、`dpi-init …`、`fps`(含页面视口) 三类行。
- 页面/桥问题：看 `page-ready source=…`、`bridgeReady`、`settings-inject url=…`、
  `post-page-skip …`。
- 透明/热键：`transparency …`、`transparency hotkey=…`。
- 用户侧环境自检：SPW「模组管理 → 配置 → 支持与反馈 → 出现问题」会逐项检查 .NET / WebView2 /
  插件文件 / 权限 / 可写目录，见 [`logging-and-diagnostics.md`](logging-and-diagnostics.md)。

打包布局的端到端验证（首次运行设置、ui 命令往返、ESC 两级关闭、exit 0、0 console error、截图）
用 `node packaging/tools/verify-layout.mjs`，详见 [`release.md`](release.md)。
