# 日志与「出现问题」自检（v0.4.2，issue #12；v0.4.7 起改为四态）

> **发布状态**：最后**发布**版本是 **v0.4.6**（2026-10-30）。本文描述的**四态判定**
> （`PASS/FAIL/UNKNOWN/ADVISORY`，见 §3.0）与 `windowsBuild` / `webView2Error` 等字段是 **v0.4.7 起**
> 的代码；v0.4.6 及更早版本仍是**二态**（通过 / 未通过），所以只装了 v0.4.6 的用户看到的界面比本文
> 少一档。v0.4.6.1 / v0.4.7 / v0.4.8 / v0.4.9 / v0.4.10 / v0.4.11 均**未发布**，只在本地测试过。

Status: 已实现并通过真实宿主 + 真实 WebView2 验收（2026-10-26，v0.4.2 口径；四态改造于本地 v0.4.7
验证；**v0.4.11 重新对齐全链路并加入每次构建后的复检流程，见 §6**）。
适用范围：用户报告「打不开 / 闪退 / 黑窗 / 卡顿」时的自助排查，以及维护者做支持回复。

---

## 1. 两个入口

> **另有一处纯配置**：自检相关的日志开关在 SPW「模组管理 → 配置 → **诊断与日志** → 详细日志」
> （v0.4.11 起归到该组；v0.4.6–v0.4.10 在「播放页」组）。三个配置组的完整清单见
> [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1。

| 入口 | 位置 | 何时可用 |
| --- | --- | --- |
| SPW 配置页按钮 | SPW「模组管理 → 配置 → 支持与反馈 → 出现问题」（`spw-folia/src/main/resources/preference_config.json` 的 `type:"button"`，`on_click` 指向 `dev.spw.folia.FoliaPlugin.onReportProblem`） | 插件已启用即可用——**包括播放窗口打不开的时候**（这正是它存在的理由） |
| 播放页 chrome 按钮 | 全屏播放页右上角、齿轮左边的救生圈图标 → 面板（`poc/settings-ui/src/chrome/ProblemReportPanel.tsx`） | 播放窗口正常显示**且**「配置 → 播放页 → 显示问题反馈按钮」开着（`showProblemButton`，**v0.4.11 起默认关**）；面板能看到辅助进程的实时环境报告 |

> **v0.4.11**：播放页那个救生圈按钮多了个开关（`showProblemButton`，默认关，因为它会遮挡画面右上角）。
> 关掉时按钮与面板都**不挂载**，也不上报 hit region。**配置页那条入口不受影响**——那才是窗口打不开时
> 的逃生口。细节见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1.2 与
> [`docs/known-inert-settings.md`](known-inert-settings.md)。

两个入口的行为一致（`FoliaDiagnostics.onReportProblem` / `ProblemReportPanel`）：

1. **环境自检**：逐项检查下面第 3 节的硬依赖。缺哪项就逐个 toast / 逐行标红并给出修复链接——
   不是一句「环境不全」。
2. **反馈**（仅当没有缺失项）：用默认浏览器打开**已预填**的 GitHub issue 表单（环境表 + 页面状态 +
   日志尾部），**同时**用资源管理器打开日志目录并选中 `spw-folia.log`，用户把文件拖进 issue 即可。
   自检失败时只打开日志目录（维护者需要日志来判断缺失环境的影响范围）。

## 2. 日志文件

全部在插件安装目录（`%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia-<ver>\`）：

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `spw-folia.log` | 插件（`FoliaPlugin.log`） | 启动/hook/spawn 命令行、**`host process exited code=N`**、`host closed reason=…`、快捷键注册、配置开关变化 |
| `spw-folia-host.stdout.log` | 插件（`FoliaHostBridge` 逐行镜像宿主 stdout） | 宿主协议行：`webview2 runtime=`、`webview-ready`、`page-viewport`、`settings-ui state=`、`page-stall`、`host-exit` |
| `spw-folia-host.stderr.log` | 插件（`ProcessBuilder.redirectError`） | 宿主 stderr，正常应为 0 字节 |
| `%APPDATA%\Salt Player for Windows\logs.txt` | SPW 宿主 | 插件加载失败、权限异常 |

### 2.1 v0.4.2 新增的日志行

| 行 | 出处 | 用途 |
| --- | --- | --- |
| `console.warn: …` / `console.info: …` | `Shim.js` 新增的 console 镜像（此前只有 `console.error`） | Folia 页面/设置岛用 `console.warn` 报样式与调参问题，以前只在 devtools 里可见；info 限 200 条去重，避免刷屏 |
| `console.groupCollapsed: …` | 同上，v0.4.3 | PixiJS 的弃用警告是 `groupCollapsed('%c…%c%s', …)` + `warn(stack)` + `groupEnd()` 三段式；只镜像 `warn` 会得到一条纯 `at bt (…)` 堆栈、没有正文。现在组标签单独成行，组内的堆栈行带 `组标签: ` 前缀，能看出它属于哪条警告；`%c` 样式占位符被丢弃、`%s` 正确插值 |
| `page-stall frames=N worstFrameMs=… fps=…` | 宿主 `WriteFpsSample` + `Shim.js` 的 `stallFrames`/`worstFrameMs` | 用户说的「卡顿/掉帧」变成可检索的一行；`>100 ms` 才算 stall，与普通的 25 ms 抖动分开 |
| `transparency mouse=catcher drag=on/off` | 宿主（v0.4.3 起为 **debug** 级） | 每次在热区内按下/松开都会各写一行；放在 `info` 级时一次点击就是两条，实测一轮会话刷了 104 行，把真正的异常淹掉了 |
| `webview scale=… was=… reason=…` | 宿主 `ApplyRasterizationScale`（v0.4.3） | WebView2 的 `RasterizationScale` 会按显示器 DPI 更新（默认值由初始窗口尺寸推出）；换到不同 DPI 的显示器后若不重设，画面会被拉伸。日志只在值真的变化时打一行 |
| `open-log-folder dir=… selected=…` | 宿主（v0.4.3 修正） | 面板传的是**日志文件路径**（`--log-file`），旧实现把它当目录用，于是 `selected=False` 且资源管理器打不开；现在文件→选中所属目录里的它，目录→选中其中的日志文件 |
| `nav-start uri=… redirect=…` | 宿主（仅 `--verbose-log`） | 导航链路（含设置岛注入后的跳转） |
| `env-check requested -> NB` / `open-log-folder …` / `open-url …` | 宿主 | 自检与反馈动作的留痕，便于确认用户真的点到了按钮 |
| `verbose` 级别行 | 宿主 | 只在 `--verbose-log` 下出现 |

### 2.2 详细日志开关

SPW「模组管理 → 配置 → **诊断与日志** → 详细日志」（`verboseLog`，默认关）。打开后下一次启动 Folia 时宿主带
`--verbose-log`，日志里多出导航与 `verbose` 行。它不影响播放性能：这些行只在事件发生时写，且走的是
宿主原本就有的有界队列（`JsonStdout`，8192 行上限，阻塞时丢弃并计入 `droppedLogLines`）。

> **v0.4.11：这一项从「播放页」移到了新的「诊断与日志」组**，因此存储文件也从 `config.json` 变成了
> `diagnostics.json`。因为 `ConfigManager` 按 config 文件分别存取，插件侧带**旧值回退**：新文件里没有
> 该键时回退读 `config.json` 的旧值，并在首次读到旧值时把它迁进新文件（日志留
> `config migrated verboseLog=… from config.json to diagnostics.json`）。**老用户升级后详细日志设置
> 不会丢**，开关显示与行为都保持原样。实现与理由见
> [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1.1。

## 3. 自检项

### 3.0 v0.4.7：从「二态」改成「四态」，并且每一项都要有依据

> **发布状态提醒**：这一节描述的是 **v0.4.7 起**的代码，而 v0.4.7 **未发布**——线上最新可用版本
> v0.4.6（及其前的 v0.4.2–v0.4.6）仍是下面的**二态**实现，健康机误报在 v0.4.6 上依然存在。

v0.4.2–v0.4.6 的自检是**二态**（`ok: Boolean`），而「读不到」和「确实缺失」都落在 `ok = false`
上。这在真机上产生了一次**必然发生的误报**：Windows 11 build 26300 的健康机器弹出
「缺少运行环境：Windows 10 x64（1809+）（Windows 11 10.0 amd64）→ 需要 64 位 Windows 10 1809
(17763) 或更新版本」。

根因是 HotSpot 在 Windows 上把 `System.getProperty("os.version")` 报成 **`"10.0"`**（两段，没有
构建号，构建号在注册表里）。旧代码用 `Regex("(\\d+)\\.(\\d+)\\.(\\d+)")` 解析它，永远不命中 →
`build = null` → `is64 && build != null && build >= 17763` 为 false → 判失败。**这个检查在任何机器
上都不可能通过。**

v0.4.7 起改为**四态**，判定规则统一为一句话：

> **只有证据能产生「缺失」。拿不到证据只产生「无法判定」，而「无法判定」绝不表述成缺失。**

| 判定 | 含义 | 计入「缺少运行环境」 | 是否阻止打开反馈页 |
| --- | --- | --- | --- |
| `PASS` | 读到值且达标 | 否 | 否 |
| `FAIL` | **明确读到**不达标（或明确不存在） | **是** | 是 |
| `UNKNOWN` | 读不到 / 无法解析 / 无法区分 | 否 | 否（合并成一条 ⚠ 提示） |
| `ADVISORY` | 软依赖（`runtime-requirements.md` S1–S8） | 否 | 否 |

每个检查项都带一条 `evidence`（值 + 来源 + 原始输出 + 失败原因），在 UI、日志和 issue 正文里
都会显示，所以判定是**可复核**的，而不是一个无法追问的结论。

另有两处结构性改进：

* **探测层与判定层分离**：`FoliaEnvironmentProbe` 只负责「读到了什么、从哪读的、为什么没读到」，
  `FoliaDiagnostics` 只负责判定。探测函数**全部不抛异常**，抛出的异常会被捕获并变成带原因的
  `Evidence`。
* **toast 降噪**：缺失项逐个 toast（可操作）；无法判定项合并成一条（不可操作，且绝不能看起来
  像缺少环境）。

### 3.1 插件侧检查表

`FoliaDiagnostics.inspect`；注册表经 `reg.exe` 读取，单次调用 3 s 上限，普通用户权限即可（已用
受限令牌实测全部通过，无一项需要管理员）。

| # | 检查 | 判定依据 | `FAIL` 的文案 | 读不到时 |
| --- | --- | --- | --- | --- |
| 1 | Windows 10 x64 1809+ | 注册表 `CurrentBuildNumber`（回退 `CurrentBuild`，再回退 `os.version` 的三段式）+ `sun.arch.data.model` | 实测 build < 17763 | `UNKNOWN`（不再误报） |
| 2 | .NET Framework 4.8 | `NDP\v4\Full\Release` ≥ 528040；按 `reg.exe` 的类型标记解码（`REG_DWORD` 走十六进制，`REG_SZ` 走十进制） | Release < 528040 | `UNKNOWN` |
| 3 | WebView2 Runtime ≥ 86 | 三个 `EdgeUpdate\Clients\{F3017226-…}` 的 `pv`，回退 `Application\<ver>\msedgewebview2.exe` | `pv = 0.0.0.0`（已注册但不可用）或主版本 < 86 | `UNKNOWN` |
| 4 | 原生文件齐全 | `native/`、`lib/`、`host/`、`native/x64`、`lib/x64` 下 5 个文件 | 列出具体缺哪些 | 插件目录不可读时 `UNKNOWN` |
| 5 | 页面资源 | `web/index.html`（或 `web/dist/index.html`） | 两处都没有 | 同上 |
| 6 | 设置岛资源 | `web/settings/settings-ui.js` 等 | 三处都没有 | 同上 |
| 7 | 插件目录可写 | 写入并删除探针文件 | 写明异常类型与消息 | — |
| 8 | SPW 版本 | `≥ 1.19.0`（`HostTargets.Version.MIN_SUPPORTED`） | 实测版本号 | 版本串无法解析时 `UNKNOWN` |
| 9 | 权限 | `isPermissionGranted` 的返回值 | **永不判 FAIL**（见下） | `false` 与抛异常都是 `UNKNOWN` |
| 10 | 辅助进程会话 | 运行中 helper 的 pid 是否存活 | 永不判 FAIL | `ADVISORY`（窗口没开属正常） |
| 11 | 图形会话 | `SESSIONNAME` 是否 `RDP-*` | 永不判 FAIL | `ADVISORY` |

第 9 项说明：`WorkshopApi.Manager.isPermissionGranted` 在 workshop API jar 里是**接口默认方法，
恒返回 `false`**，只有覆写过它的宿主版本才答得准。所以 `false` 无法区分「用户没给」与「本宿主
不支持查询」，判 `UNKNOWN` 并在证据里写明这条限制，把用户引到插件权限页去核对——比凭空断言
「缺少权限」诚实。插件启动路径本身（`FoliaPlugin.start`）已经对同一个调用做了日志与拦截，功能
上不会漏。

### 3.2 宿主侧检查表

`HostForm.BuildEnvReport`（字段见 `docs/protocol.md` §3.5）补上插件看不到的部分：WebView2 实际
运行版本、.NET Release、exe 同目录 5 个文件的 `present/missing`、bundle/settings 目录、用户数据
目录、DPI/客户区、透明状态、音频源、fps/状态计数、日志路径。

v0.4.7 新增三个字段，专门用来消除「读不到 = 没有」：

| 字段 | 用途 |
| --- | --- |
| `windowsBuild` / `windowsVersion` / `windowsRevision` | 面板判定用的构建号（`Environment.OSVersion.Version.Build`），不再从展示字符串里反推 |
| `webView2Error` | `GetAvailableBrowserVersionString()` 失败的原因；`webView2` 为 null 且有原因 → `UNKNOWN` |
| `dotnetError` | 注册表读取失败的原因（键不存在 / 无 `Release` / 异常）；有原因 → `UNKNOWN` |

### 3.3 播放页面板与插件侧的一致性

两个入口现在是**同一套判定语义**（`poc/settings-ui/src/chrome/ProblemReportPanel.tsx` 的四态
`Verdict` 与 `FoliaDiagnostics.Verdict` 一一对应），并且都遵守同一条底线：**`unknown` 不计入
missing，也不会把界面染成故障色**。

## 4. 与 `runtime-requirements.md` 的关系

那份文档是**依赖矩阵与人工排查手册**（H1–H10 / S1–S8 / 退出码 / 关键字对照），本文件是**自动化实现**：
自检项的判定与文案直接对齐它的表格。退出码翻译也在这里落地——`host process exited code=3` 在自检里就是
「WebView2 Runtime 未安装」，不再需要用户自己去对照表。

## 5. 证据

* 环境报告端到端（真实宿主，`--window 1280x720`，页面侧 `__SPW_FOLIA__.emit('envCheck')`）：
  返回 `webView2=150.0.4078.83`、`dotnet=534296`、`nativeFiles.missing=[]`、`bundleIndex=true`、
  `settingsEntry=true`、`droppedLogLines=0`，宿主日志同时出现 `env-check requested -> 855B`。
* `page-stall` 行在首帧阶段正常出现（`frames=1 worstFrameMs=108`），随后 120 fps 稳定、不再出现。
* 详细日志开关：`--verbose-log` 下日志含 `nav-start`，关闭时没有。

## 6. 自检与版本对齐（v0.4.11）

### 6.1 为什么需要这一节

自检是**唯一面向用户说「你的环境缺了什么」的代码**，它说错话的代价比别的功能都高：v0.4.2–v0.4.6
就因为 `os.version` 解析写错，在健康机器上必然报「缺少运行环境」。而它又极容易与主版本**脱节**——
自检跑在插件进程里、读的是打包后的目录结构（`native/`、`lib/`、`web/`），一旦打包布局或页面资源
路径改了而自检没跟着改，它不会编译失败，只会在用户机器上默默判 FAIL。

所以 v0.4.11 把自检当成**发布产物的一部分**来复检，而不是「写完就不用再看的功能」。

### 6.2 三层职责（改动前先确认自己在改哪一层）

| 层 | 文件 | 只负责 |
| --- | --- | --- |
| 取证层 | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaEnvironmentProbe.kt` | 「读到了什么、从哪读的、为什么没读到」。所有探测函数**不抛异常**，异常都变成带原因的 `Evidence` |
| 判定层 | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaDiagnostics.kt` | 四态判定（§3.0）+ 文案 + 缺失聚合。**只有证据能产生 `FAIL`** |
| 页面半 | `poc/settings-ui/src/chrome/ProblemReportPanel.tsx` | 渲染两个入口共用的报告；`Verdict` 与 Kotlin 侧一一对应，`unknown` 不计入 missing、不染故障色 |

页面里的自检数据来自宿主 `BuildEnvReport`（§3.2）与插件侧报告，两侧字段名必须对得上；
改任一侧时都要把另一侧一起看。

### 6.3 每次构建新版本后都必须跑一次自检

**规则：构建出新的插件包/宿主后、写进发布检查表之前，跑一次自检。** 分两条命令，一条查 Kotlin
判定链路（真机、真注册表），一条查页面侧链路（真宿主 + 真 WebView2）。

#### ① 真机自检（判定层 + 取证层）

```bash
cd "D:/输出目录/spw-folia/spw-folia"
./gradlew runDiagnostics
```

`runDiagnostics` 跑的是 `DiagnosticsMain` → `FoliaDiagnostics.inspect()`，与「出现问题」按钮调用的
是**同一份代码**，只是把结果打到 console。期望输出：

- 先打印 `=== FoliaEnvironmentProbe (raw evidence) ===` 的逐项原始证据（`windows.describe`、
  `registryBuild` / `propertyBuild` / `ubr`、`webview2.version`、`dotnet.release` 等）；
- 再打印 `=== FoliaDiagnostics.inspect ===` 的**每项一行**，形如
  `<VERDICT>  <label>  <detail>`，下一行是 `evidence: …`，`FAIL` 项还会多一行 `fix: …`；
- 最后是 `=== SUMMARY ===` 与 `logLine`；
- **健康机器上不应出现任何 `FAIL`**（`UNKNOWN` 允许出现且属正常，见 §3.0）。

退出码：健康机全绿时 exit 0；只要 `report.missing` 非空，任务会打印
`!!! N FAILED CHECK(S): …` 并以非 0 退出——**这就是本项检查的通过条件**。

#### ② 页面侧链路（页面半 + 宿主 `BuildEnvReport`）

```bash
cd "D:/输出目录/spw-folia"
node packaging/tools/verify-diagnostics.mjs
```

这个脚本用**真实宿主 + 真实 WebView2** 加载打包后的页面与设置岛，跑页面侧的 `envReport` 链路，
断言各个检查项 verdict 合理（该 `PASS` 的不报 `FAIL`，读不到的落 `UNKNOWN` 而不是 `FAIL`），
即**没有假 FAIL**。它是可重复执行的：不依赖人工点按钮，任何一次构建后都可以直接跑。
约定与 `packaging/tools/verify-*.mjs` 其它脚本一致：**exit 0 = PASS，exit 1 = FAIL，
exit 2 = 缺少打包产物**（先跑 `bash packaging/build-package.sh`）。报告写到
`packaging/out/` 下。

> 该脚本随 v0.4.11 引入并已实测通过（15/15）。它和 ① 的分工：① 在**插件进程内**跑判定层，
> ② 在**真实 WebView2** 里跑页面半 + 宿主 `BuildEnvReport`，两边覆盖的不是同一段代码。

### 6.3.1 一条命令跑完整门禁（推荐）

日常复检不用分别记两条命令，用统一门禁：

```bash
cd "D:/输出目录/spw-folia"
node packaging/tools/verify-all.mjs           # 全量：静态契约 + 三个真实宿主套件
node packaging/tools/verify-all.mjs --static  # 只跑静态契约，不开浏览器（快，适合改完就查）
```

它按顺序做三件事：**① 静态契约**（三处版本号一致、配置页声明 ⇄ 代码 `KNOWN_CONFIG_SWITCHES` 双向
对齐、每组一个独立 config 文件、`verboseLog` 迁移链路在位、开关 key 无重复）→ **② 真实宿主套件**
（自检 / 显示问题反馈按钮 / 显示播放条）→ **③ 汇总**，任何一项失败都非 0 退出，报告写
`packaging/out/verify-all.json`。

`--static` 不需要打包产物，因此**改完代码就可以先跑它**；全量模式要求
`packaging/native` 与 `packaging/web` 已暂存（否则 exit 2 并提示先跑 `bash packaging/build-package.sh`）。

#### ③ 期望结果汇总

| 检查 | 通过标准 |
| --- | --- |
| `gradlew runDiagnostics` | exit 0，且 `SUMMARY` 里 `FAIL` 计数为 0；`evidence` 行有真实值（不是「读不到」） |
| `node packaging/tools/verify-diagnostics.mjs` | exit 0，页面侧各检查项无假 `FAIL`；`webView2` / `dotnet` 有实际值 |
| 两个入口一致 | 同一台机器上，配置页按钮与播放页按钮给出**同样的 verdict 集合** |
| `node packaging/tools/verify-all.mjs` | exit 0；`10/10 gate checks`（静态 7 + 真实宿主 3） |

### 6.4 失败时怎么办

按「先证伪再下结论」（`docs/dev-experience.md` §9 铁律 1）的顺序处理，**不要先把 verdict 放宽**：

1. **先确定是真缺失还是读错。** 看该行的 `evidence`：如果证据本身写着「读不到 / 解析失败 / 异常」，
   问题在**取证层**（`FoliaEnvironmentProbe`），不是用户环境缺东西。典型样本：
   `System.getProperty("os.version")` 在 Windows 上只返回 `"10.0"`，构建号必须从注册表
   `CurrentBuildNumber` / `CurrentBuild` 读。
2. **区分「环境真缺」和「判定过严」。** 环境真缺 → 保留 `FAIL` 并核对文案里的修复链接；
   判定过严或证据不足 → 该降级为 `UNKNOWN` 或 `ADVISORY`，**绝不把「读不到」表述成「缺失」**。
3. **检查是不是打包布局变了。** 第 4–7 项（原生文件 / 页面资源 / 设置岛 / 目录可写）判 FAIL 时，
   先对照 `packaging/` 下的暂存目录与 `.spmod` 内部结构；布局改了而自检路径没跟上，是最常见的一类
   假 FAIL。
4. **只在健康机上出现 FAIL 时，把它当发布阻断项。** 这正是 v0.4.2–v0.4.6 的教训：一条在任何机器上
   都不可能通过的检查，发出去就是每次点按钮都报错。
5. **改完必须重跑 6.3 的两条命令**，并把结果作为发布证据记进 release notes（按
   `docs/dev-experience.md` §9 铁律 9 标注验证等级：离线 / 真机 / 用户验收，不许混）。
