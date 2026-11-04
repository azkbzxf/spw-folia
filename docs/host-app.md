# 原生宿主 spw-folia-host.exe

`spw-folia-host.exe` 是 Kotlin 插件在用户打开 Folia 模式时 spawn 的辅助进程：它拥有一个无边框
全屏窗口，用 WebView2 承载 Folia 自己的生产 OBS 产物（`?obs=1`，开屏时另加 `splash=1`），把
插件的 JSON 行注入页面，采集 WASAPI 环回音频推给页面，并把生命周期与错误写回 stdout。

**它不含任何音乐/业务逻辑**，插件是唯一数据源。接口契约见 [`docs/protocol.md`](protocol.md)；
透明窗口机制见 [`docs/live-transparency.md`](live-transparency.md)；音频标定见
[`docs/audio-timeline.md`](audio-timeline.md)；设置岛的页面侧契约见
[`docs/settings-ui-impl.md`](settings-ui-impl.md)。

源码在 `poc/webview/host/`：`Program.cs`（CLI、JSON 工具、stdout 写线程、`Main`）、
`HostForm.cs`（窗口、WebView2、15 ms tick、stdin 循环、截图、注入）、`AudioProvider.cs`
（合成 / stdin / WASAPI 三种 provider 的路由）、`DpiSupport.cs`（DPI 与父进程 PID）、
`MonitorSupport.cs`（多屏）、`SplashBridge.cs`（开屏时序）、`Shim.js`、`Overlay.js`、
`PreviewShim.js`、`build.sh`。音频分析器来自 `poc/audio/native/`，编译期复制进
`poc/webview/host/audio/` 一起编译。

---

## 1. 进程模型与启动时序

一个插件实例最多一个宿主进程，每次打开 Folia 会话 spawn 一次。插件以插件目录为 cwd 启动它，
stdout 是协议流，stderr 只放诊断，`--log-file` 指向插件那边的镜像日志。

启动顺序（`Program.Main` → `HostForm`）：

1. `DpiSupport.Init()` 建立并记录进程 DPI awareness（manifest 是主路径，这里是兜底），
   打一行 `dpi-init result=… awareness=…`。
2. 解析参数 → 校验 `--bundle` 目录里确有 `index.html`（缺失直接退出码 2）→ 若未显式给
   `--settings-dir` 则自动探测 `<bundle>/settings/settings-ui.js`。
3. 构造 `HostForm`：窗口属性、`--demo` 的内嵌配置、`--dev-settings` 的设置树、按持久化设置
   预应用透明模式。
4. `OnHandleCreated`：应用窗口几何、必要时在同一条消息里给窗口上色键、注册透明热键、装开屏计时。
5. `OnShown` / `OnLoad`：再应用一次几何、打 `host-start`（parentPid、DPI、屏幕、音频源），
   起 stdin 读线程，起 tick。
6. `InitializeWebViewAsync`：检查 WebView2 Runtime（缺失 → 退出码 3）、建环境、建
   `CoreWebView2`、注册虚拟主机、清理旧 Service Worker、挂事件、注入脚本、导航。
7. `NavigationCompleted`：打 `nav-done`，随后输出 `ready`，向页面发 `hello` / `settings`，
   并回放导航期间就到达的 `lyrics` / `track` / `queue` / `config`。

tick 周期 15 ms（WinForms 定时器下限约 15.6 ms，即 ~64 Hz），负责推 `state` / `audio`、跟踪
光标、开屏揭幕、截图时机、`--duration` 与 `--open-settings` 的超时兜底。

**发送节奏**（插件侧）：`hello` → `settings` → 收到 `ready` 后补发 `settings` + `lyrics` +
`track` + `config`，此后 `state` 每 100 ms 一条。`ready` 之前发的 `settings` 会被宿主丢弃
（`post-page-skip reason=not-ready`），不重发就等于页面永远收不到开关值。

---

## 2. 命令行参数与退出码

`spw-folia-host.exe [options]`。未列出的参数一律忽略，不报错。

**生产路径（插件会传）**

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--bundle <dir>` | – | 含 `index.html` 的产物目录，映射到 `https://spw-folia.local/`。给了 `--dev-url`/`--url` 时可省。 |
| `--fullscreen` | **开** | 无边框全屏、置顶。 |
| `--window <W>x<h>` / `--windowed [W,H]` | 1280×720 | 窗口模式。`--window` 只认 `WxH`，`--windowed` 接受 `WxH` 或 `W,H`。 |
| `--bundle-version <text>` | `dev` | 设置岛 URL 的缓存戳（`?v=`），同时回显在页面 `hello` 里。 |
| `--settings-dir <dir>` | 自动探测 | 设置岛产物目录；缺省时 `<bundle>/settings/settings-ui.js` 存在就自动采用。 |
| `--settings-entry <file>` | `settings-ui.js` | 设置岛入口文件名。 |
| `--no-curtain` | 开屏开 | 关闭开屏动画（导航 URL 不带 `splash=1`）。 |
| `--splash-duration <s>` | 0.8 | 开屏最短停留，夹紧到 0.3–2.0 s。 |
| `--log-file <path>` | – | 插件把 stdout 镜像到的文件；只用于在自检报告里报路径。 |
| `--verbose-log` | 关 | 导航、页面 console、卡顿采样都进日志。 |

**调试 / 验证**

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--dev-url <url>` | – | 开发服务器 URL（无虚拟主机映射）。页面 `hello.devUrl` 也能在运行时改导航。 |
| `--url <url>` | 由 bundle 推导 | 显式覆盖加载 URL。 |
| `--no-topmost` | 置顶 | 取消 always-on-top。 |
| `--user-data <dir>` / `--user-data-dir <dir>` | `%LOCALAPPDATA%\spw-folia\webview` | WebView2 profile 目录。 |
| `--dev-settings <json\|path>` | – | 启动时的设置树：内联 JSON、`.json` 路径，或 `{"settings":{…}}` 包装。 |
| `--assets <dir>` | – | 额外静态目录，映射到 `https://spw-folia-assets.local/`。 |
| `--mode <name>` | 来自配置 | 强制 demo 配置里的 `visualizerMode`。 |
| `--no-overlay` | 注入 | 跳过占位 HUD（有 `--settings-dir` 时本来就不注入）。 |
| `--no-transparency` | 跟随设置 | 强制不透明窗口。 |
| `--no-colour-key` / `--no-color-key` | 关 | 调试截图用：完全不装色键（等价于 `SPW_FOLIA_COLOUR_KEY=0`）。 |
| `--no-sw-purge` | 清理 | 跳过启动时的 Service Worker / Cache Storage 清理。 |
| `--force-dsf <n>` | 跟随 Windows | 给 WebView2 传 `--force-device-scale-factor=n`。**仅调试**，它覆盖用户的系统缩放。 |
| `--devtools` | 关 | 开启 DevTools 与浏览器快捷键。 |
| `--title <text>` | `spw-folia-host` | 窗口标题。 |
| `--no-esc` | ESC 关窗 | 关闭 ESC 关窗（kiosk / 自动化）。 |
| `--keep-alive` | stdin EOF 即退 | stdin 关闭后不退出。 |
| `--duration <ms>` | 0 = 一直跑 | 到点自动关闭。 |
| `--screenshot <png>` + `--shot-at <ms>` | – / 5000 | 导航完成后 N ms 截一张 PNG。 |
| `--fps-log [path]` | 不写文件 | 追加页面 FPS 采样（字段见 §10）。 |
| `--exit-after-fps <n>` | 0 = 关 | 采样到 ≥ n 就关闭。 |
| `--audio-log` | 关 | 每约 2 s 打一条 `audio-stats`。 |
| `--demo` / `--no-demo` | 关 | 用内嵌合成配置，并把 stdin 的歌词/曲目补成 Folia 形态（脱离插件单跑）。 |
| `--open-settings` | 关 | 收到页面 `bridgeReady` 后自动打开设置覆盖层；2.5 s 无 `bridgeReady` 则超时兜底打开。 |

**兼容占位（接受并忽略）**

| 参数 | 说明 |
| --- | --- |
| `--frame-rate <n>` | 配置页的帧率项已删除（理由见 [`docs/upstream-sync.md`](upstream-sync.md) §10），参数仍被吃掉，只为让带旧参数的插件包照常 spawn。 |
| `--curtain-palette <..>` | 旧版护幕的封面配色；护幕已改为 Folia 自己的页面开屏。 |
| `--port <n>` | 端口已包含在 `--dev-url` 里。 |

**退出码**

| code | 含义 |
| --- | --- |
| `0` | 正常关闭（ESC / 热键 / 页面请求 / 插件 `quit` / 到 `--duration`） |
| `1` | 其它错误：窗口或 WebView2 初始化失败、浏览器进程崩溃（`webview process-failed`）、未处理异常 |
| `2` | 参数错误 / 既没 `--bundle` 也没 `--dev-url` / bundle 目录缺 `index.html` |
| `3` | WebView2 Runtime 未找到（先打一条 `error WebView2 Runtime not found: …`） |

退出前 stdout 的最后一条业务消息总是 `{"t":"closed","reason":"user"|"error"|"plugin"}`，随后才是
收尾日志行与进程退出。插件把 1 / 2 / 3 翻译成用户可读的提示（见
[`docs/runtime-requirements.md`](runtime-requirements.md) §3）；`-2146232576`（CLR 激活失败
`0x80131700`）发生在托管代码执行之前，宿主来不及输出任何东西。

---

## 3. 协议要点

字段级契约以 [`docs/protocol.md`](protocol.md) 为准，这里只记宿主侧的落地约定。

**stdin（插件 → 宿主，一行一个 JSON）**：`hello`（记版本，带 `devUrl` 则改导航）、`settings`、
`state`、`lyrics`、`track`、`queue`、`config`、`audio`（调试：从 stdin 灌音频帧）、`audioMode`
（`off` / `stdin` / 其它＝环回）、`quit`、`command`（`close` / `screenshot` /
`settings`｜`open-settings`｜`close-settings` / `eval`）。

健壮性：UTF-8，容忍 CRLF 与空行，`StreamReader` 负责半行缓冲；**单行解析失败或 handler 抛异常
只记 `stdin-line` 并继续**，绝不因一条坏消息关窗。stdin EOF 起 2 s 定时器，到点以
`reason=plugin` 关闭——插件死了不会留僵尸窗口；`--keep-alive` 关掉这条。

**stdout（宿主 → 插件）**：`ready {protocol,pid,webviewVersion,bundle,startedAtMs}`（导航完成、
shim 装好之后）、`closed {reason}`、`settings {settings}`（页面改了设置）、`action {name}`
（`close` / `reload` / `openDevTools`）、`control`（播放条控制：`toggle` / `previous` / `next` /
`seek` / `shuffle` / `queue-play`，白名单外丢弃并记 warn，宿主不解释任何播放语义）、
`log {level,msg}`，以及 `fps` / `eval-result` / `audio-stats` 等诊断行。

**宿主 → 页面**：tick 发 `state {posMs,durationMs,playing,rate,lyricOffsetMs,tsMs}` 与
`audio {power,bass,lowMid,mid,vocal,treble,spectrum[1024],tsMs}`；另有 `hello`、`settings`、
`lyrics`、`track`、`queue`、`config`、`ui {action}`、`envReport`。Shim 把它们翻成 Folia 真实的
SSE 事件形状（`state`→`clock`，节流 250 ms 或播放状态变化时立即发；`audio`→带
`Uint8Array(1024)` 频谱的事件），页面自己在这两个采样之间插值。

**时钟锚定**：最近一条 `state` 在 500 ms 内视为新鲜，此时发
`anchorPosMs + (now - anchorAtTick) * rate`；超过 500 ms 没有 `state`（插件卡住或独立单跑）则
自由运行，画面不会停在原地。

**静音 / 暂停**：暂停或音频帧标记为 silent 时，`power` 与五个频段都发
`(sin(now/2000)+1)*20`、频谱为空数组——这是协议 §5 的「呼吸」形态，也是 Folia 的待机观感。

**早发数据的回放**：协议允许在页面就绪前发 `lyrics` / `track` / `queue` / `config`。宿主缓存
最后一份，在 `NavigationCompleted` 后回放，并在设置岛 `bridgeReady` 时再补一次 `queue`。

---

## 4. 构建

不需要 .NET SDK / MSBuild，系统自带的 .NET Framework 4.8 C# 5 编译器就够：

```bash
cd poc/webview/host && bash build.sh
```

`build.sh` 依次做四件事：

1. 用 `poc/webview/shared/demoData.mjs` 重新生成内嵌的 `DefaultConfig.json`。
2. `export MSYS2_ARG_CONV_EXCL='*'` 并把所有路径过 `cygpath -w`——否则 MSYS 会把 `/out:` 当
   POSIX 路径改写，报 `CS2001`。
3. 编译：`-target:exe -platform:x64 -optimize+ -define:LOOPBACK`，把 `Shim.js` / `Overlay.js` /
   `DefaultConfig.json` 作为**资源**内嵌；引用 `System.Web.Extensions.dll`（`JavaScriptSerializer`
   就是 JSON 解析器）与 `poc/webview/tools/sdk/` 下的 WebView2 SDK dll。
4. 写出 `build/spw-folia-host.exe.config`（`supportedRuntime v4.8` + PerMonitorV2 +
   `EnableWindowsFormsHighDpiAutoResizing`），并把三个 WebView2 dll 拷到 exe 旁边。

WebView2 SDK dll 的获取：下载 `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2`，
取 `lib/net462/Microsoft.Web.WebView2.{Core,WinForms}.dll` 与
`runtimes/win-x64/native/WebView2Loader.dll` 放进 `poc/webview/tools/sdk/`。

> `Shim.js` / `Overlay.js` 是**编译进 exe 的资源**，不是运行时读的 URL。改了它们必须重跑
> `build.sh`，否则跑的是旧 exe——表现为「代码明明改了但页面行为不变」。`.cs` 同理，而插件的
> `.json` 资源改完要重新 `./gradlew build` 才进 `.spmod`。

---

## 5. WebView2 虚拟主机与注入

| 虚拟主机 | 来源 | 何时注册 |
| --- | --- | --- |
| `https://spw-folia.local/` | `--bundle` | 给了 `--bundle` 就注册 |
| `https://spw-folia-assets.local/` | `--assets` | 可选 |
| `https://spw-folia-settings.local/` | `--settings-dir` | 给了该目录且目录存在就注册；但设置岛在 bundle 内时入口 URL 走 bundle 主机，见下 |

默认加载 URL 是 `https://spw-folia.local/index.html?obs=1&token=spike`。`obs=1` 必需——它决定
上游挂的是 OBS React 根；去掉会挂主应用窗口，那个窗口要完整的播放器 UI 与 Electron 桥，在
WebView2 里直接崩。开屏动画由 `splash=1` 驱动，`--no-curtain` 时不带该参数（页面因此不装开屏）。

**注入顺序**（`AddScriptToExecuteOnDocumentCreatedAsync`，每个 frame 都会跑）：

1. `Shim.js`（事件源桥 + `window.__SPW_FOLIA__`）。
2. 占位 HUD `Overlay.js`——仅在既没 `--settings-dir` 又没给 `--no-overlay` 时注入。
3. 设置岛：一个动态 `<script type="module">`，URL 带 `?v=<bundleVersion>` 缓存戳。设置岛在
   bundle 内时走 bundle 主机（与页面同源，便于 staging 去重样式图），在 bundle 外时才用
   settings 主机。注入脚本自身带 `window.top !== window` 守卫，否则它会在预览 iframe 里再挂一次。

> 缓存戳不是可选优化。设置岛从固定虚拟主机加载，WebView2 的 HTTP 磁盘缓存会在插件升级后继续
> 供旧 `settings-ui.js`。`Shim.js` / `Overlay.js` 是 exe 内嵌字符串，不存在这个问题。

**首次导航前先清 Service Worker**：v0.1–v0.3 的安装包把 Folia 原始 dist（含 `sw.js`）拷进
`web/`，而 WebView2 profile 目录与插件版本无关。旧注册会继续控制 `https://spw-folia.local/`，
把预览 iframe 的 `/preview.html` 导航劫回 `index.html`（现象是预览框空白）。清理按 origin 精确
进行，必须在**第一次导航之前**完成（页面里的清理只对后续加载有效）；清不掉只记 warn，不阻断导航。

浏览器参数固定为 `--autoplay-policy=no-user-gesture-required`
`--disable-background-timer-throttling --disable-renderer-backgrounding
--disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion`；
上下文菜单、状态栏、缩放、滑动导航关闭。

---

## 6. 窗口、DPI 与多屏

**几何**由 `ApplyWindowGeometry(reason)` 统一下发，**幂等**，在这些点重跑：`handle-created`、
`shown`、`load`、`dpi-changed`、`tiny-viewport-recover`。每次调用打一行
`geometry reason=… mode=… bounds=… client=… screen=… workarea=… dpi=… winDpi=… awareness=…`，
几何回归从日志就能直接看出来。

**目标屏不是主屏**：默认取 spawn 出宿主的那只 SPW 窗口所在显示器
（`MonitorSupport.ScreenForProcess(parentPid)`，按「该 PID 下最大、可见、无 owner、非
tool-window 的顶层窗口」判定，取不到才回落主屏）。用户 Alt+左键拖过一次之后 `anchor=dragged`，
后续几何变更留在拖过去的屏上，不再把窗口拽回 SPW。

**DPI**：进程是 PerMonitorV2（manifest 的 `dpiAwareness` + `.config` 的
`System.Windows.Forms.ApplicationConfigurationSection`，`DpiSupport.Init()` 兜底并记录结果）。
缩放判断一律用 `GetDpiForWindow`，**不要用 `Form.DeviceDpi`**——后者在 180 % 缩放下仍报 96。
WebView2 的 `RasterizationScale` 被显式钉到窗口所在屏的缩放系数（WinForms 包装器不暴露该属性，
走反射取 controller；任何一步失败只保持上一档，不致命）。页面 CSS 视口因此等于
**客户区物理像素 / DSF**（3200×2000 @180 % → 1776×1110 CSS px），而不是「按 1.0 渲染后拉满全屏」
那种发虚。

`--force-dsf` 只用于小窗冒烟（让 Folia 的 `lg:` 断点生效），生产绝不默认开。

**极小视口自动恢复**：页面第一次报 `fps` 时若 CSS 视口 < 64 px，宿主记 `page-viewport-tiny`，
重跑一次几何并 `Reload()` 让页面重新测量。

---

## 7. 透明窗口与输入（摘要）

`settings.transparentPlayerBackground` 为真时，窗口变成色键分层窗口：`BackColor` = 色键 =
`TransparencyKey` = **`rgb(1,0,1)`**，`WebView2.DefaultBackgroundColor` = `Color.Transparent`；
关掉时恢复黑底。键色不是纯洋红——`LWA_COLORKEY` 只抠完全等于键色的像素，而 `0 < alpha < 1` 的
像素会被合成到键色上；洋红会把半透明字形边缘染成粉雾（用户报的「粉色背景」），近黑则读作暗阴影。
`rgb(1,0,1)` 既不是页面会画的纯黑底色，也落在 Folia 调色板够不到的区间内。

标志从三条路径读：构造（`--dev-settings`）、stdin `settings`、页面 `{"type":"settings"}`，所以
UI 一切换窗口就跟着变。色键窗口**整窗点击穿透**，因此透明期间注册全局热键 **Ctrl+Alt+B**
（回退 Ctrl+Alt+Y / Ctrl+Alt+P / Ctrl+Alt+Shift+B）切回不透明，并同步调用页面的
`__spwFoliaSetTransparent(false)`，让页面开关与持久化树保持一致。`backdrop-filter` 在色键合成下
不生效，chrome 与其面板通过 `data-flat='true'` 换成实底色。

鼠标穿透 / hitbox 的实现见 [`docs/live-transparency.md`](live-transparency.md)。

---

## 8. 光标与设置覆盖层协作

全屏窗口不永久隐藏光标：tick 跟踪 `Cursor.Position`，静默 2.5 s 后 `Cursor.Hide()`，一动就恢复；
设置覆盖层打开期间强制可见。只在状态变化时记一行 `cursor show|hide overlay=… idleMs=…`，
窗口关闭 / 进程退出时恢复。

覆盖层开合由页面经 `{"type":"settingsUI","state":"open"|"close"}` 报给宿主。ESC 的优先级由此
决定：F1 或 `command open-settings` 打开面板；ESC #1 关面板（窗口留着），ESC #2 关窗口
（`closed{reason:"user"}`，退出码 0）。`--no-esc` 对每条关闭路径都生效。页面侧另有 Ctrl+Alt+F
与鼠标侧键「后退」两条退出通道，实现见 `Shim.js`。

---

## 9. 由插件 spawn 时的健壮性

症状：父进程是**无控制台的 `javaw.exe`**（插件 JVM）时，宿主窗口可能以隐藏 / 零尺寸被创建，
WebView2 就按那个极小的客户区布局，Folia 画进一张邮票；同样的 exe 从控制台启动却正常。失败是
静默的——`ready` 与 `fps` 都照常打，只有几何是错的。

现在的防线（都在 `poc/webview/host/`）：

- `DpiSupport.Init()` 显式设定并回报进程 awareness；已由 manifest 设定时记
  `already-set(<…>)`，而不是误导性地回落到 `system`。
- `ApplyWindowGeometry` 在 §6 列的五个点重复下发 bounds / `TopMost` / `ShowInTaskbar`，所以
  「父进程给的 STARTUPINFO 不对」不再能固定住错误尺寸。
- `fps` 日志带 `{w,h,dpr,canvases,client}`，几何回归在任何一次运行里都可见。
- 视口 < 64 px 自动重下发几何 + reload（§6）。
- 诊断只走 stderr 与 `log` 行，绝不在协议流里塞非 JSON。

复现插件 spawn 形态的 harness 是 `poc/webview/host/repro/JavaSpawner.java`：它按
`FoliaHostBridge` 的参数原样启动打包产物，从 stdin 发 `hello` / `settings` / `config` 与 100 ms
`state`，然后读 stdout。用 `java.exe` 与 `javaw.exe` 各跑一遍是这条链路的回归方式：

```bash
cd poc/webview/host/repro && javac -encoding UTF-8 JavaSpawner.java
cd /d/输出目录/spw-folia
"C:/Program Files/Java/jdk-25.0.2/bin/javaw.exe" -cp poc/webview/host/repro JavaSpawner packaging/native/spw-folia-host.exe packaging/web packaging/out/repro-javaw.log --settings --duration-ms 9000
```

---

## 10. 诊断

- `--verbose-log`：导航、页面 console、逐窗口卡顿行。默认关，只在有人要看日志时开。
- `--log-file <path>`：让自检报告能把「日志在哪」告诉用户。
- 页面侧「出现问题」发 `{"type":"envCheck"}`，宿主用 `BuildEnvReport()` 回 `envReport`——
  WebView2 版本、.NET、原生文件清单、bundle、可写 user-data 目录、GPU、DPI、音频源、运行期
  计数。字段与四态判定见 [`docs/protocol.md`](protocol.md) §3.5 与
  [`docs/logging-and-diagnostics.md`](logging-and-diagnostics.md)。
- `--fps-log` 是**白名单**：`atMs,fps,longFrames,stallFrames,worstFrameMs,heapMB,canvases,dpr,
  w,h,capped`。给页面新增的任何字段都必须同步加进 `HostForm.WriteFpsSample()`，否则永远不出现在
  日志里。`capped` 是上游「限流器已安装」的标记，`false` 才是「没有限流」的正面证据——只看 fps
  数字看不出这件事（显示器刷新率是硬天花板）。
- 卡顿（`stallFrames > 0`）额外打一行 `page-stall frames=… worstFrameMs=… fps=…`，用户报「卡顿」
  时不必翻整条 fps 流。

---

## 11. 已知限制

- 多屏按「SPW 窗口所在屏」自动选，Alt+拖可以换屏；没有显式的 `--monitor <index>` 选择器。
- 环回采集的是 **post-volume** 信号：系统音量调小，画面反应也变小（上游行为，非缺陷）；AGC
  默认关。
- 上游的节拍检测（`beat_this` / `htdemucs`，WebGPU）不在本 bundle 里，也没有节拍事件流，所以
  「智能动感模式」与随拍特效恒静默；样式自身的动画不受影响。逐项清单见
  [`docs/known-inert-settings.md`](known-inert-settings.md)。
- 透明模式是色键分层窗口：整窗穿透、`backdrop-filter` 失效（见 §7）。
- 一个 user-data 目录对应一个 WebView2 profile；并发跑多个实例必须给不同的 `--user-data-dir`。
- 页面必须完全离线（无外部网络请求）。找不到 WebView2 Runtime 只能退 3，宿主无法代装。

---

## 12. 验证工具

| 入口 | 用途 |
| --- | --- |
| `node packaging/tools/verify-layout.mjs` | 打包产物冒烟：设置岛首开、`open-settings` / `close-settings` 往返、ESC 一次关面板 / 两次关窗、退出码 0、0 console error、截图。 |
| `node packaging/tools/verify-all.mjs` | 发布前总门禁（静态契约 + 真宿主套件）。 |
| `node poc/webview/host/driver.mjs` | 协议 v1 驱动：spawn、发 `hello`/`settings`/`lyrics`/`track`、100 ms `state`、多位置截图、模拟 ESC、写报告。`--modes a,b,c` 可轮播 17 种样式。 |
| `node poc/webview/host/run-demo.mjs` | 单跑宿主 + 桌面截图，确认真窗口存在。 |
| `poc/webview/host/repro/JavaSpawner.java` | 复现插件的 spawn 形态（`java.exe` / `javaw.exe`）。 |

打包布局、体积预算与 `native/` `web/` 在 `.spmod` 里的映射见 [`docs/release.md`](release.md)；
宿主与 dll 的许可说明见 [`docs/licensing.md`](licensing.md)。
