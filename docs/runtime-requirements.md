# 运行环境与排障

用户的 Folia 打不开、窗口闪一下就没了、画面全黑、卡顿？先按本文对症处理。
维护者做支持回复时也用这张表。

**一句话原理**：插件自己不带浏览器、也不带 .NET。渲染交给系统里的 **WebView2 Runtime**，
窗口交给用 **.NET Framework 4.8** 写的辅助进程。这两样系统组件任一缺失，
表现都是"点了没反应"或"窗口闪一下就消失"。

最省事的第一步：**SPW「模组管理 → 配置 → 支持与反馈 → 出现问题」**。它会逐项检查下面的
硬依赖、把缺的东西直接指出来，并在环境齐全时打开预填好环境信息的反馈页。
详见 [`logging-and-diagnostics.md`](logging-and-diagnostics.md)。

---

## 1. 硬依赖（缺了就用不了）

| # | 依赖 | 要求 | 缺失时用户看到什么 |
| --- | --- | --- | --- |
| H1 | Windows + 架构 | Windows 10 x64 **1809 (17763) 起**（SPW 自身 MSIX 的底线）；建议 1903+ | 装不上 SPW，或辅助进程起不来（exe 是 x64-only） |
| H2 | .NET Framework | **4.8** | 系统弹"此应用需要安装 .NET Framework 4.8"，或进程起不来 = 用户眼里的"闪退" |
| H3 | WebView2 Runtime | **Evergreen ≥ 86.0.616.0**（GA API 下限），建议 120+ | 窗口闪一下消失；辅助进程 **exit code 3** |
| H4 | 随包的 4 个原生文件 | 必须与 `spw-folia-host.exe` **同目录**：两个 WebView2 dll、`WebView2Loader.dll`、`spw-folia-host.exe.config` | 缺托管 dll → `FileNotFoundException` → exit 1；Loader 错位 → WebView2 初始化失败 → exit 1 |
| H5 | WebView2Loader 架构 | **x64**（发布包就是 x64） | 误用 x86/arm64 → `BadImageFormatException` → exit 1 |
| H6 | Salt Player for Windows | **1.19.0 及以上**（菜单 hook 按版本发现） | 不崩：日志 `unsupported SPW version …`，菜单里没有 Folia |
| H7 | Java 运行时 | JVM 25（插件 class 是 Java 25） | 用户不需要另装：SPW 自带。低于 25 的 JVM 加载不了插件 |
| H8 | 插件权限 | `class-transform`（钩子，必需）、`library-read`（封面/歌词，可选）、`key-bindings`（快捷键，可选） | 缺 class-transform：toast 提示 + 菜单无 Folia；缺 library-read：封面取不到；缺 key-bindings：快捷键不注册 |
| H9 | 可写路径 | 插件安装目录可写（`spw-folia.log`）；`%LOCALAPPDATA%\spw-folia\webview` 可建可写 | 安装目录不可写 → `spawn failed` → 退回黑色 Swing 占位窗；用户数据目录不可写 → exit 1 |
| H10 | 页面资源完整 | `.spmod/web/index.html` 存在（解包不完整、被杀软删文件） | `bundle has no index.html` → exit 2 |

参考机占用：插件安装目录约 **27 MB**，WebView2 用户数据目录首次运行后约 **121 MB**。
建议留 ≥ 300 MB 可用空间，且不要把 `%LOCALAPPDATA%` 放在网络盘或同步盘上。

## 2. 软依赖（缺了降级，一般不会崩）

| # | 依赖 | 说明 |
| --- | --- | --- |
| S1 | 可用 GPU / D3D / WebGL | 页面用 WebGL 渲染。辅助进程没有传 `--disable-gpu`，也没有软件渲染兜底。远程桌面（RDP）、虚拟机、很老的显卡驱动下可能黑屏或降级。先更新显卡驱动、退出远程桌面再试 |
| S2 | 音频设备 | WASAPI 回环采集失败会被吞掉并回落合成信号（日志 `wasapi-loopback-failed`），只是画面不再随音频起伏，不崩 |
| S3 | 多显示器 | 全屏窗口默认开在 spawn 出它的那只 SPW 窗口所在显示器（取不到回落主屏）。副屏用户"找不到窗口"通常不是崩溃 |
| S4 | 网络 | **完全不需要**。页面全走本地虚拟主机 `https://spw-folia.local/` |
| S5 | 管理员权限 | **不需要**（辅助进程 manifest 是 asInvoker） |
| S6 | VC++ 运行库 | **不需要单独装**。辅助进程是纯托管；WebView2 Runtime 自带 `msvcp140` / `vcruntime140` |
| S7 | 代码签名 | 辅助进程 exe **未签名**（`WebView2Loader.dll` 有微软签名）。AppLocker / SmartScreen / 杀软可能拦（`spawn failed … error=5`） |
| S8 | 内存 | WebView2 + Folia 渲染吃内存，低内存机可能被系统杀（`OUT_OF_MEMORY`） |

## 3. 症状与退出码 → 该做什么

按用户最容易描述的几类症状组织（§3.1–§3.8），最后是辅助进程的退出码对照（§3.9）。
日志怎么拿、怎么读见 §4。

### 3.1 点菜单里的 Folia 完全没反应 / 菜单里没有 Folia

1. 确认是 **SPW 1.19.0 或更新**（H6）。日志出现 `unsupported SPW version …; hook not installed` 就是这条。
2. 确认插件已启用、且 **`class-transform` 权限已授予**（H8）。SPW 的插件权限页里补授后**重启 SPW**。
3. 看 `%APPDATA%\Salt Player for Windows\logs.txt`（宿主侧）有没有插件加载失败 / 权限异常。
4. 仍没有：把 §4 的日志一并反馈。

### 3.2 窗口闪一下就消失

这是**最常见**的一类，绝大多数是环境缺失：

1. **装 WebView2 Runtime**：<https://developer.microsoft.com/microsoft-edge/webview2/consumer/>
   （Win11 自带，一般不用装；Win10、精简系统、企业离线机是重灾区）。注意 **Edge 浏览器不能代替
   WebView2 Runtime**。
2. **装 .NET Framework 4.8**：<https://dotnet.microsoft.com/download/dotnet-framework/net48>
   （Win10 1903+ 已内置）。
3. 看日志里有没有 `host process exited code=3`（→ 第 1 步）或 `-2146232576`（→ §3.3）。
4. 仍然闪退：收集 §4 的日志反馈。

### 3.3 系统弹「This application could not be started」，手动双击 exe 却正常

只在 **Microsoft Store / MSIX 渠道**的 SPW 上出现。日志特征：
`host process exited code=-2146232576`、`spw-folia-host.stdout.log` 为 0 字节。

**重装 .NET Framework 无效**——不是缺运行库。原因是 Store 版 SPW 的插件目录是 MSIX 虚拟路径，
.NET 加载器用原生路径找 `<exe>.config` 找不到（`0x80131700`）。已修复：从 v0.2.1 起插件在
spawn 前把路径解析成物理路径。**升级插件即可**。

不想升级时的临时绕过（建目录联接让虚拟路径在真实磁盘上可见）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:APPDATA\Salt Player for Windows" `
  -Target "$env:LOCALAPPDATA\Packages\Sakawish.SaltPlayerforWindows_q65q631pyh094\LocalCache\Roaming\Salt Player for Windows"
```

### 3.4 窗口能开，但画面全黑

1. 先排除 GPU：更新显卡驱动、退出远程桌面 / 虚拟机再试（S1）。
2. 检查是不是**掉进 Swing 占位窗**：日志出现 `helper unavailable, opening Swing fallback window`
   说明辅助进程没起来，那是个黑色占位窗，不是真 Folia——回到 §3.2。
3. 首页都打不开时，日志里找 `bundle has no index.html`（→ 重装插件）或
   `webview process-failed`（→ 关掉重开一次）。

### 3.5 用着用着窗口自己消失

`webview process-failed kind=… reason=Unexpected` + `closed reason=error` + exit 1：
WebView2 浏览器进程意外退出。当前没有自动重试，**重新打开一次**即可。
反复出现请附日志（这属于需要排查的真问题）。

### 3.6 打开设置里的「歌词样式」预览空白 / 设置面板自己关掉

- **预览空白**：旧安装包里的 Service Worker 劫持了 `/preview.html`。当前版本在启动时会按
  origin 清理旧 SW，升级到 v0.3.0+ 即可。
- **设置面板打开几秒后自动退出**：v0.4.14 的缺陷（设置岛被加载两次、第二实例卸载了第一棵树），
  v0.4.15 已修。升级即可。

### 3.7 画面卡顿 / 掉帧

1. 先在「配置 → 播放页 → **歌词样式预览动画**」关掉动画：货架小图改为简约图案，
   设置窗口明显更顺（播放页不受影响）。
2. 日志里搜 `page-stall`：`>100 ms` 才算 stall，普通 25 ms 抖动不算。
3. 弱显卡 / 高分屏 + 大窗口时，Folia 的 WebGL 渲染确实吃力（S1、S8）。

### 3.8 反馈按钮挡住了画面

「配置 → 播放页 → **显示问题反馈按钮**」默认**关**。打开它才会有播放页右上角的救生圈按钮。
窗口打不开时用配置页那条入口，它不依赖播放窗口。

### 3.9 辅助进程退出码

完整定义见 [`host-app.md`](host-app.md) §2。用户侧只会遇到这四个：

| code | 含义 |
| --- | --- |
| 0 | 正常关闭（ESC / 热键 / 插件关窗） |
| 1 | 其它错误：窗口或 WebView2 初始化失败、浏览器进程崩溃、未处理异常 |
| 2 | 参数错误 / bundle 目录缺失 / 没有 `index.html` |
| 3 | **WebView2 Runtime 未安装或无法启动** |
| -2146232576 | CLR 激活失败 `0x80131700`，见 §3.3 |

插件以退出码判断要不要弹提示：1 / 2 / 3 / -2146232576 都有对应的中文原因（实现见
`FoliaHostBridge.describeExitCode`），其余码只写日志。

## 4. 拿日志（反馈时请附上）

日志都在插件安装目录，从 SPW「模组管理 → 配置 → 支持与反馈 → 出现问题」点进去会自动打开
该目录并**选中** `spw-folia.log`。也可以手动到
`%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia-<版本>\` 找：

| 文件 | 内容 |
| --- | --- |
| `spw-folia.log` | 插件侧：启动、hook、spawn 命令行、**`host process exited code=N`**、`host closed reason=…`、开关变化 |
| `spw-folia-host.stdout.log` | 辅助进程协议日志：`webview-ready`、`webview2 runtime=…`、`webview process-failed`、`fps` |
| `spw-folia-host.stderr.log` | 辅助进程 stderr，正常应为 0 字节 |
| `%APPDATA%\Salt Player for Windows\logs.txt` | SPW 宿主侧：插件加载失败、权限异常 |

需要更多细节时，先在「配置 → **诊断与日志** → 详细日志」打开开关，下次打开 Folia 会多出导航与
`verbose` 级别的行。开关状态在 `diagnostics.json` 里。

### 4.1 日志关键字对照

| 日志 / 现象 | 结论与操作 |
| --- | --- |
| `WebView2 Runtime not found:` + `exited code=3` | 装 WebView2 Runtime |
| 系统弹 .NET 安装提示 / 辅助进程完全没有日志 | 装 .NET Framework 4.8 |
| `exited code=-2146232576` + 弹「This application could not be started」+ stdout 空 | MSIX 虚拟路径（§3.3），重装 .NET 无效 |
| `spawn failed: … CreateProcess error=…` | 杀软拦截 / 文件缺失 / 目录不可写 |
| `host helper not found` / `web bundle not found` | 安装不完整（`native/` 或 `web/` 缺文件），重装 |
| `bundle has no index.html` + `exited code=2` | `web/` 损坏，重装插件 |
| `unsupported SPW version …; hook not installed` | SPW 版本过低（H6） |
| `CLASS_TRANSFORM not granted; hook not installed` | 未授予 class-transform 权限（H8） |
| `webview process-failed kind=…` + `exited code=1` | WebView2 浏览器进程意外退出（§3.5） |
| `helper unavailable, opening Swing fallback window` | 打开的是黑色占位窗，不是真 Folia |
| `cover load failed: … PluginPermissionDeniedException … 'library-read'` | 缺 library-read 权限（非致命） |
| `KEY_BINDINGS not granted; transparency shortcuts not registered` | 缺 key-bindings 权限：快捷键不注册，其余正常 |

插件会把退出码翻译成中文原因写进日志，所以先搜 `host process exited` 通常就够定位了；
完整对照见 §3.9。

## 5. 手工自检（插件打不开时用）

「出现问题」按钮需要插件能加载。如果连它都用不了，用一段 PowerShell 自己查：

```powershell
# 1) WebView2 Runtime（下面三个位置的 pv 任一非空/非 0.0.0.0 即可）
Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -EA SilentlyContinue
Get-ItemProperty 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -EA SilentlyContinue

# 2) .NET Framework（>= 528040 即 4.8；533320/533325/533509 是 4.8.1）
(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full').Release

# 3) 架构、构建号、UBR
[Environment]::Is64BitOperatingSystem
(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR
```

> **Windows 构建号只能读注册表。** JVM 的 `System.getProperty("os.version")` 在 Windows 上恒为
> `"10.0"`（没有构建号），拿它判 1809+ 必然误判——v0.4.6 及更早的自检就栽在这里，见
> [`logging-and-diagnostics.md`](logging-and-diagnostics.md) §3。

## 6. 明确不需要的东西

.NET SDK / JDK / Node / pnpm / Python（只有源码构建才要）、VC++ 运行库、管理员权限、网络连接、
单独安装的浏览器（Edge Stable **不能**代替 WebView2 Runtime）、Android 模拟器、Folia 桌面版
（网页产物已内置）。

## 7. 相关文档

- 自检四态判定、日志字段、门禁怎么跑：[`logging-and-diagnostics.md`](logging-and-diagnostics.md)
- 宿主的命令行参数、退出码与窗口行为：[`host-app.md`](host-app.md)
- 打包内容与体积：[`release.md`](release.md)
- 许可与不随包分发的组件：[`licensing.md`](licensing.md)、[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
