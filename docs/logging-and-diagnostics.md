# 日志与「出现问题」自检

用户报"打不开 / 闪退 / 黑窗 / 卡顿"时，本文说明**两个自检入口怎么用、日志在哪、判定规则是什么、
出了错该怎么办**。面向用户的操作步骤集中在 [`runtime-requirements.md`](runtime-requirements.md) §3–§4，
本文补充实现侧的判定口径与维护者的门禁流程。

---

## 1. 两个入口

| 入口 | 位置 | 何时可用 |
| --- | --- | --- |
| **配置页按钮** | SPW「模组管理 → 配置 → 支持与反馈 → **出现问题**」（`preference_config.json` 里 `type:"button"`，`on_click` → `dev.spw.folia.FoliaPlugin.onReportProblem`） | 插件一启用就能用——**包括播放窗口打不开的时候**。这是逃生口 |
| **播放页救生圈** | 全屏播放页右上角、齿轮左边的图标 → 面板（`poc/settings-ui/src/chrome/ProblemReportPanel.tsx`） | 播放窗口正常运行**且**「配置 → 播放页 → **显示问题反馈按钮**」开着（`showProblemButton`，**默认关**，因为它会遮挡画面右上角） |

关掉 `showProblemButton` 时按钮与面板都**不挂载**，也不上报热区；配置页那条入口不受影响。

两个入口行为一致（`FoliaDiagnostics.onReportProblem` / `ProblemReportPanel`）：

1. **环境自检**：逐项检查硬依赖。缺哪项就逐个标出来并给修复入口，不是一句"环境不全"。
2. **反馈**（仅当没有缺失项）：用默认浏览器打开**预填**好的 GitHub issue 表单
   （环境表 + 页面状态 + 日志尾部），**同时**用资源管理器打开日志目录并选中 `spw-folia.log`。
   自检有问题时只打开日志目录（维护者需要日志判断影响范围）。

日志文件清单与关键字对照见 [`runtime-requirements.md`](runtime-requirements.md) §4——那里是
面向用户的版本，本文不重复。

## 2. 自检项

### 2.1 判定规则：四态

自检的底线是一句话：

> **只有证据能产生「缺失」。拿不到证据只产生「无法判定」，而「无法判定」绝不表述成缺失。**

| 判定 | 含义 | 计入「缺少运行环境」 | 阻止打开反馈页 |
| --- | --- | --- | --- |
| `PASS` | 读到值且达标 | 否 | 否 |
| `FAIL` | **明确读到**不达标（或明确不存在） | **是** | 是 |
| `UNKNOWN` | 读不到 / 无法解析 / 无法区分 | 否 | 否（合并成一条 ⚠ 提示） |
| `ADVISORY` | 软依赖（`runtime-requirements.md` S1–S8） | 否 | 否 |

每个检查项都带一条 `evidence`（值 + 来源 + 原始输出 + 失败原因），在 UI、日志和 issue 正文里
都会显示，所以判定**可被复核**，而不是一个无法追问的结论。

这条规则不是风格偏好，是教训：v0.4.2–v0.4.6 的自检是二态（`ok: Boolean`），"读不到"和"确实缺失"
都落在 `ok = false` 上。它从 `System.getProperty("os.version")` 取构建号，而 HotSpot 在 Windows 上
恒报 `"10.0"`（两段，没有构建号，构建号在注册表里），解析永远不命中 → `build = null` →
`is64 && build != null && build >= 17763` 为 false → **这个检查在任何机器上都不可能通过**。
健康机器每次点按钮都会被告知"你的系统太老"。

另有两条结构性约束：

- **探测层与判定层分离**：`FoliaEnvironmentProbe` 只负责"读到了什么、从哪读的、为什么没读到"，
  `FoliaDiagnostics` 只负责判定。探测函数**全部不抛异常**，抛出的异常捕获后变成带原因的 `Evidence`。
- **toast 降噪**：缺失项逐个 toast（可操作）；无法判定项合并成一条（不可操作，且绝不能看起来像
  缺少环境）。

### 2.2 插件侧检查表

`FoliaDiagnostics.inspect`。注册表经 `reg.exe` 读，单次调用 3 s 上限，普通用户权限即可。

| # | 检查 | 判定依据 | `FAIL` 的条件 | 读不到时 |
| --- | --- | --- | --- | --- |
| 1 | Windows 10 x64 1809+ | 注册表 `CurrentBuildNumber`（回退 `CurrentBuild`，再回退 `os.version`）+ `sun.arch.data.model` | 实测 build < 17763 | `UNKNOWN` |
| 2 | .NET Framework 4.8 | `NDP\v4\Full\Release` ≥ 528040；按 `reg.exe` 类型标记解码（`REG_DWORD` 走十六进制，`REG_SZ` 走十进制） | Release < 528040 | `UNKNOWN` |
| 3 | WebView2 Runtime ≥ 86 | 三个 `EdgeUpdate\Clients\{F3017226-…}` 的 `pv`，回退 `Application\<ver>\msedgewebview2.exe` | `pv = 0.0.0.0`（已注册但不可用）或主版本 < 86 | `UNKNOWN` |
| 4 | 原生文件齐全 | `native/`、`lib/`、`host/`、`native/x64`、`lib/x64` 下那 5 个文件 | 列出具体缺哪些 | 插件目录不可读时 `UNKNOWN` |
| 5 | 页面资源 | `web/index.html`（或 `web/dist/index.html`） | 两处都没有 | 同上 |
| 6 | 设置岛资源 | `web/settings/settings-ui.js` 等三处 | 三处都没有 | 同上 |
| 7 | 插件目录可写 | 写入并删除探针文件 | 写明异常类型与消息 | — |
| 8 | SPW 版本 | ≥ 1.19.0（`HostTargets.Version.MIN_SUPPORTED`） | 实测版本号 | 版本串无法解析时 `UNKNOWN` |
| 9 | 权限 | `isPermissionGranted` 的返回值 | **永不判 FAIL** | `false` 与抛异常都是 `UNKNOWN` |
| 10 | 辅助进程会话 | 运行中 helper 的 pid 是否存活 | 永不判 FAIL | `ADVISORY`（窗口没开属正常） |
| 11 | 图形会话 | `SESSIONNAME` 是否 `RDP-*` | 永不判 FAIL | `ADVISORY` |

第 9 项为什么永不 FAIL：`WorkshopApi.Manager.isPermissionGranted` 在 workshop API jar 里是**接口默认
方法，恒返回 `false`**，只有覆写过它的宿主版本才答得准。所以 `false` 无法区分"用户没给"与"本宿主
不支持查询"，判 `UNKNOWN` 并在证据里写明这条限制，把用户引到插件权限页去核对——比凭空断言
"缺少权限"诚实。插件启动路径（`FoliaPlugin.start`）已经对同一个调用做了日志与拦截，功能上不漏。

### 2.3 宿主侧检查表

`HostForm.BuildEnvReport`（字段定义见 [`protocol.md`](protocol.md) §3.5）补上插件看不到的部分：
WebView2 实际运行版本、.NET Release、exe 同目录 5 个文件的 `present/missing`、bundle/settings 目录、
用户数据目录、DPI/客户区、透明状态、音频源、fps/状态计数、日志路径。

三个字段专门用来消除"读不到 = 没有"：

| 字段 | 用途 |
| --- | --- |
| `windowsBuild` / `windowsVersion` / `windowsRevision` | 判定用的构建号（`Environment.OSVersion.Version.Build`），不再从展示字符串反推 |
| `webView2Error` | `GetAvailableBrowserVersionString()` 失败的原因；`webView2` 为 null 且有原因 → `UNKNOWN` |
| `dotnetError` | 注册表读取失败的原因（键不存在 / 无 `Release` / 异常）；有原因 → `UNKNOWN` |

播放页面板与插件侧现在是**同一套判定语义**（页面侧 `Verdict` 与 Kotlin 侧 `FoliaDiagnostics.Verdict`
一一对应），都遵守同一条底线：`unknown` 不计入 `missing`，也不把界面染成故障色。

## 3. 改自检时的三层职责

改动前先确认自己在改哪一层——三层混改是这类 bug 的主要来源。

| 层 | 文件 | 只负责 |
| --- | --- | --- |
| 取证层 | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaEnvironmentProbe.kt` | "读到了什么、从哪读的、为什么没读到"。探测函数不抛异常，异常变成带原因的 `Evidence` |
| 判定层 | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaDiagnostics.kt` | 四态判定 + 文案 + 缺失聚合。**只有证据能产生 `FAIL`** |
| 页面半 | `poc/settings-ui/src/chrome/ProblemReportPanel.tsx` | 渲染两个入口共用的报告；`Verdict` 与 Kotlin 侧一一对应 |

页面里的自检数据来自宿主 `BuildEnvReport` 与插件侧报告，两侧字段名必须对得上；**改任一侧都要把
另一侧一起看**。

自检跑在插件进程里、读的是**打包后的目录结构**（`native/`、`web/`），所以打包布局或页面资源路径
一改，自检不会编译失败，只会在用户机器上默默判 FAIL。这是它必须进发布门禁的原因。

## 4. 门禁：每次构建后跑一次

**规则：构建出新的插件包 / 宿主之后、写进发布检查表之前，跑一次自检。**

一条命令跑完整门禁：

```bash
cd "D:/输出目录/spw-folia"
node packaging/tools/verify-all.mjs           # 全量：静态契约 + 真实宿主套件 + JVM 单测
node packaging/tools/verify-all.mjs --static  # 只跑不需要打包产物的部分（快，改完就查）
```

全量按顺序做：**① 静态契约**（三处版本号一致、配置页声明 ⇄ `KNOWN_CONFIG_SWITCHES` 双向对齐、
每组一个独立 config 文件、`verboseLog` 迁移链路在位、开关 key 无重复）→ **② 反递归守卫**
（v0.4.13 卡死事故的四条）→ **③ JVM 单测**（唯一真正执行配置失败分支的套件）→
**④ 真实宿主 + 真实 WebView2 套件** → **⑤ 汇总**。任何一项失败都非 0 退出，报告写
`packaging/out/verify-all.json`。当前基线 **24/24**，其中 JVM 单测 57 个。

`--static` 不需要打包产物，因此改完代码就能先跑；全量模式要求 `packaging/native` 与
`packaging/web` 已暂存（否则 exit 2 并提示先跑 `bash packaging/build-package.sh`）。

也可以分开跑两条：

```bash
cd spw-folia && ./gradlew runDiagnostics    # ① 判定层 + 取证层，直接打 console
cd .. && node packaging/tools/verify-diagnostics.mjs   # ② 页面半 + 宿主 BuildEnvReport
```

`runDiagnostics` 跑的是 `FoliaDiagnostics.inspect()`，与「出现问题」按钮**同一份代码**，只是把结果
打到 console：先逐项打原始证据，再打 `VERDICT  label  detail` 与 `evidence:`（`FAIL` 项多一行 `fix:`），
最后 `SUMMARY`。**健康机上不应出现任何 `FAIL`**，`UNKNOWN` 属正常。退出码：健康机全绿 exit 0；
只要 `report.missing` 非空就以非 0 退出。

`verify-diagnostics.mjs` 用真实宿主 + 真实 WebView2 加载打包后的页面与设置岛，断言各项 verdict
合理（该 `PASS` 的不报 `FAIL`，读不到的落 `UNKNOWN` 而非 `FAIL`），即**没有假 FAIL**。
约定与其它 `verify-*.mjs` 一致：exit 0 = PASS，exit 1 = FAIL，exit 2 = 缺打包产物。

两者覆盖的不是同一段代码：前者在**插件进程内**跑判定层，后者在**真实 WebView2** 里跑页面半 +
宿主报告。两条都要。

### 4.1 期望结果

| 检查 | 通过标准 |
| --- | --- |
| `gradlew runDiagnostics` | exit 0，`SUMMARY` 里 `FAIL` 计数为 0；`evidence` 有真实值 |
| `verify-diagnostics.mjs` | exit 0，页面侧无假 `FAIL`；`webView2` / `dotnet` 有实际值 |
| 两个入口一致 | 同一台机器上，配置页按钮与播放页按钮给出**同样的 verdict 集合** |
| `verify-all.mjs` | exit 0，`24/24 gate checks` |

## 5. 自检失败时怎么办

按"先证伪再下结论"的顺序处理，**不要先把 verdict 放宽**：

1. **先分清是真缺失还是读错。** 看该行的 `evidence`：如果证据本身写着"读不到 / 解析失败 / 异常"，
   问题在**取证层**，不是用户环境缺东西。典型样本：`os.version` 在 Windows 上只返回 `"10.0"`，
   构建号必须从注册表 `CurrentBuildNumber` / `CurrentBuild` 读。
2. **区分"环境真缺"和"判定过严"。** 环境真缺 → 保留 `FAIL` 并核对文案里的修复入口；
   判定过严或证据不足 → 降级为 `UNKNOWN` 或 `ADVISORY`，**绝不把"读不到"表述成"缺失"**。
3. **检查是不是打包布局变了。** 第 4–7 项（原生文件 / 页面资源 / 设置岛 / 目录可写）判 FAIL 时，
   先对照 `packaging/` 暂存目录与 `.spmod` 内部结构——布局改了而自检路径没跟上，是最常见的假 FAIL。
4. **健康机上出现 FAIL，就当发布阻断项。** 这正是 v0.4.2–v0.4.6 的教训。
5. **改完重跑 §4 的命令**，结果连同验证等级（离线 / 真机 / 用户验收）记进 release notes，不许混写。

## 6. 日志与设置项的取值链路

- **详细日志开关**：「配置 → **诊断与日志** → 详细日志」（`verboseLog`，默认关）。打开后下一次启动
  Folia 时宿主带 `--verbose-log`，日志里多出导航与 `verbose` 级别的行。它不影响播放性能：这些行只在
  事件发生时写，走宿主既有的有界队列（`JsonStdout`，8192 行上限，阻塞时丢弃并计入 `droppedLogLines`）。
- 该开关存在 `diagnostics.json`。`ConfigManager` 按 config 文件分别存取，所以插件侧带**旧值回退**：
  新文件没有该键时回退读 `config.json` 的旧值，并在首次读到时迁进新文件（日志
  `config migrated verboseLog=… from config.json to diagnostics.json`）。老用户升级后设置不会丢。
- **配置页开关的读取通道**：不要依赖宿主的 `ConfigManager` 变更回调（真机实测回调不一定来、
  `getConfig()` 返回缓存、一次编辑触发多次回调）。`FoliaConfigSync` 把**磁盘文件**当唯一事实来源：
  先 `reload()` 强制重读，再读全部开关，只有值真的变了才推送；触发有两条——宿主回调（快路径）
  加一个低频守护线程（兜底）。

开关的完整清单与每个开关的实际生效情况见 [`known-inert-settings.md`](known-inert-settings.md) 与
[`settings-ui-impl.md`](settings-ui-impl.md) §4.1。
