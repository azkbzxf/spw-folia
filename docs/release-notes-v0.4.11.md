# spw-folia v0.4.11 — 配置页重新分组、新增「显示问题反馈按钮」开关、自检复检、版本号定版 0.4.11

**本版本未发布，仅本地测试。** 验证等级：**本机构建 + 本机端到端（真实宿主 + 真实 WebView2），未装机、未用户验收**。
本版做到了：把配置页从两组重排成三组（并把「详细日志」搬到新的 `diagnostics.json`，带旧值回退与
一次性迁移）、新增 `showProblemButton` 开关（默认关）、把自检三层与当前版本对齐并补上可重复执行的
复检脚本、把三处版本号定版到 0.4.11；`plugin` 任务产出了
`plugin-dev.spw.folia-0.4.11.spmod`（`Plugin-Version: 0.4.11`），复检门禁 10/10、自检套件 15/15、
两个开关套件 9/9 与 15/15 全通过。
**发布包已本地组装**：`dist/release/spw-folia-0.4.11.spmod` 15,406,708 B / 3,976 项 /
sha256 `e7bd3668…2fa22`，`Plugin-Version: 0.4.11`，并通过 `verify-layout.mjs`（`pass=true`、
`consoleErrors=0`、17/17 样式缩略图）与 `verify-all.mjs`（10/10 门禁）。**未上传 GitHub Releases。**
**没有做**的：装机真机点击、fps 实测——这些在 §5.2 逐项列为「未做」，不填估算值。

> **版本谱系（先读这一段，否则后面每一节都会误读）**
>
> | 版本 | 状态 |
> | --- | --- |
> | **v0.4.6** | **最后发布的版本**（GitHub Releases 可查，2026-10-30） |
> | v0.4.6.1 | 未发布，仅本地构建与测试 |
> | v0.4.7 | 未发布，仅本地构建与测试 |
> | v0.4.8 | 未发布，仅本地构建与测试 |
> | v0.4.9 | 未发布，仅本地构建与测试（**没有独立的 notes 文件**，改动散记在 `release-notes-v0.4.8.md` 与代码注释里） |
> | v0.4.10 | 未发布，仅本地测试（见 [`docs/release-notes-v0.4.10.md`](release-notes-v0.4.10.md)） |
> | **v0.4.11** | **未发布，仅本地测试（本文件）** |
>
> v0.4.6 之后的所有版本**从未上传 GitHub Releases**，其改动随后续版本一并交付。
> `dist/release/` 与 `spw-folia/build/libs/` 下的 `.spmod` 全部是**本地产物**。

本版没有新增播放能力，也没有改协议：改动集中在**设置页的归类**、**一个新增的页面开关**，以及
**自检工具的复检机制**。播放、样式、协议、设置格式本身没有行为变化。

## 一、配置页重新分组（两组 → 三组）

位置：SPW → 模组管理 → 配置。分组依据是**用户什么时候会用到它**，不是按功能相似度：

| 组标题 | config 文件 | 用途 | 条目 |
| --- | --- | --- | --- |
| **播放页** | `config.json` | 用户想调观感 | 打开过渡动画、显示播放条、**显示问题反馈按钮**（本版新增） |
| **诊断与日志**（本版新增组） | **`diagnostics.json`**（新文件） | 出问题时才打开、且只为排查 | 详细日志 |
| **支持与反馈** | `support.json` | 求助入口 | 出现问题（`button`） |

三条分类理由：

1. **播放页 = 用户想调观感。** 这三项都会改变「画面看起来什么样」，用户想调的时候会来找它们。
2. **诊断与日志 = 出问题时才打开、且只为排查。** 「详细日志」原来的位置是错的：**普通用户永远不会用到
   它**，却和画面设置并列在一起，等于把一个给维护者用的开关摆在用户面前。
3. **支持与反馈 = 求助入口。** 「出现问题」是按钮不是开关，它是用户在「坏了」的时候唯一会去点的地方。

改动前后（配置页在包内的实际声明，逐条核对过）：

| | v0.4.10 | v0.4.11 |
| --- | --- | --- |
| 组数 | 2 | **3** |
| 播放页 `config.json` | 打开过渡动画、**详细日志**、显示播放条 | 打开过渡动画、显示播放条、**显示问题反馈按钮** |
| 诊断与日志 `diagnostics.json` | —（不存在） | **详细日志** |
| 支持与反馈 `support.json` | 出现问题 | 出现问题（不变） |
| `switch` 总数 | 3 | **4** |

### 1.1 ⚠️ 换组 = 换存储文件，所以必须做旧值回退

**这是本版最容易出错、也是最容易被忽略的一处。** SPW 的 `ConfigManager.getConfig(name)` 是
**按 `preference_config.json` 里每个 config 的 `config` 文件名分别存取**的（每组一个 `ConfigHelper`）。

所以「详细日志」从「播放页」挪到「诊断与日志」，对用户只是同一页面上换了个位置，对存储却是
**换了一个文件**（`config.json` → `diagnostics.json`）。新文件里当然没有 `verboseLog`，
直接 `get(key, false)` 会拿到默认值 `false`——于是：

- 用户明明开着详细日志，升级后**静默变回关闭**；
- 界面上开关显示为关，看起来像「设置被重置了」；
- 而且没有任何报错，用户只会觉得「这破插件的开关自己会跳」。

Kotlin 侧为此新增 `FoliaConfigGroups`（`spw-folia/src/main/kotlin/dev/spw/folia/FoliaConfigGroups.kt`），
`readBoolean()` 按三步走：

1. 新文件（`diagnostics.json`）里有这个键 → **以它为准**；
2. 新文件里没有 → **回退读旧文件**（`config.json`）里的同名键；
3. 真读到了旧值 → **立刻写进新文件并落盘**，迁移只发生一次，之后只认新文件。

**第 3 步是关键，不是可选项。** 只回退不迁移的话，旧文件仍然是真源——用户在旧位置改值还会继续生效，
两处都能改就永远说不清哪个算数。写一次之后旧键彻底不再被读取，两份文件不可能再互相矛盾。

迁移会留下可检索的日志行：

```
config migrated verboseLog=true from config.json to diagnostics.json
```

写失败时带后缀 `(write failed; will retry next read)`，下次读再试——**不会因为一次写失败就把值丢掉**。

### 1.2 「键是否存在」怎么判定（`get(key, default)` 做不到）

`ConfigHelper.get(key, default)` **无法区分**「键不存在」和「键存在且等于默认值」，而 API 也没有
`has` / `getRaw`。所以 `FoliaConfigGroups` 用一个**不可能和真实键冲突的 String 哨兵**做类型探测：
`get(key, SENTINEL)` 返回的类型若不是 String，说明键存在（返回值来自存储）；返回哨兵本身说明键不存在。

这不是猜的：SPW 的默认值只在键缺失时使用，读取路径不会把一个真实布尔变成字符串。此外读取还做了两层容错：

- 值是 `"true"` / `"false"` 字符串（JSON 往返或手改文件产生）时按布尔认；**其它任何字符串一律当作「没有值」**，
  免得一个手写的乱码被当成「开」；
- `getConfig` / `get` / `set` / `save` 全部包在 `runCatching` 里，配置层不可用时**保留调用方当前值**，绝不抛。

**用户可见结论：升级到 v0.4.11 后，之前保存的详细日志设置不会丢，开关显示与实际行为都保持原样。**

## 二、新增「显示问题反馈按钮」开关（默认关）

位置：SPW → 模组管理 → 配置 → 播放页，第三项。

它控制播放页**右上角的救生圈按钮**（`LifeBuoy` 图标，`data-spw-chrome="problem-report"`）以及它背后的
诊断面板（`ProblemReportPanel`）。

### 2.1 配置声明

```json
{
  "type": "switch",
  "key": "showProblemButton",
  "title": "显示问题反馈按钮",
  "summary": "播放页右上角的救生圈按钮，点开可检查运行环境并打开反馈页面。默认关闭以免遮挡画面；播放窗口打不开时，仍可在本配置页最下方「支持与反馈 → 出现问题」使用同一功能。",
  "default_value": false
}
```

**默认 `false`（关）。** 这与「新功能默认不打扰用户」的既有约定一致，也与另一个方向相反：
v0.4.10 的「显示播放条」默认**开**，因为开才是升级前的既有行为；本开关是全新入口，没有历史行为要对齐，
所以按「不打扰」取关。

### 2.2 为什么默认关

两条理由，缺一条都不足以说明「为什么不是默认开」：

1. **它会遮挡画面右上角。** 播放页是一整块歌词/画面，右上角是这个按钮唯一的落脚点；对绝大多数用户来说
   它连着几十次播放也用不上一次，却每次都占着一块像素。
2. **最需要它的场景，本来就不靠它。** 「播放窗口打不开」正是最需要求助的时候——而那时候**播放页根本不存在**，
   页面上的按钮自然也点不到。真正能用的是配置页的「支持与反馈 → 出现问题」
   （`preference_config.json` 的 `button` → `FoliaPlugin.onReportProblem`），它不依赖播放窗口。
   **那正是它存在的理由**，所以页面按钮默认关不会让任何人失去求助路径。

### 2.3 关闭 = 不挂载，不是 CSS 隐藏

页面侧是条件渲染（`poc/settings-ui/src/App.tsx`）：

```tsx
{showProblemButton ? (
    <>
        <button data-spw-chrome="problem-report" …><LifeBuoy size={20} strokeWidth={1.75} /></button>
        <ProblemReportPanel open={problemPanelOpen} onClose={…} />
    </>
) : null}
```

这个区别有三条实际后果，都不是「看起来一样」：

| 影响 | CSS 隐藏 | 本版：不挂载 |
| --- | --- | --- |
| 鼠标穿透下的 hit region | 元素仍在 DOM 里，仍会算出 rect 并上报 | `querySelector` 取不到节点，`push()` 直接跳过，**不留区域** |
| ESC 归属 | 面板仍挂着，仍会拦 ESC | 面板没挂载，`problemPanelOpen` 为假，**监听器不存在** |
| 点击判定 | 需要额外 `pointer-events` 保证不吞点击 | 节点不存在，无所谓吞不吞 |

另外补了一条联动：**开关在面板打开时被关掉，面板会跟着收起**（`useEffect` 里
`if (!showProblemButton && problemPanelOpen) setProblemPanelOpen(false)`），不会留下一个没有入口的浮层。

### 2.4 链路与 v0.4.10 的 `showPlaybackBar` 同构

| # | 环节 | 做什么 |
| --- | --- | --- |
| 1 | `FoliaPlugin.readShowProblemButton()` | 从 `ConfigManager` 读布尔（读不到 / 非布尔 / 抛异常 **一律回落 `false`**），挂在 `addConfigChangeListener` 上 |
| 2 | `withInjectedMembers()` | 用 `Json.withBoolMember(tree, "showProblemButton", …)` 把布尔**写进设置树顶层**，与 `showPlaybackBar` / `systemFonts` 共用同一个注入点（四个发布点都走它：启动、开窗、快捷键改树、页面回显） |
| 3 | `FoliaHostBridge.sendSettings()` | 走既有的 `{"t":"settings"}` 通道下发；`readShowProblemButton` 里检测到变化且 `bridge.isRunning()` 时**立即重发一次**，所以是**热生效**，不用重开窗口 |
| 4 | `useInjectedSwitch.ts` → `App.tsx` | `useShowProblemButton()` 先读快照、再订阅 `settings` 事件（先挂监听再读初始快照，避免两次读之间的竞态）；本版把 v0.4.10 的单键 hook 收敛成 `useInjectedSwitch(key, fallback)`，两个开关共用一份读取逻辑 |

与 v0.4.10 相同的两条纪律，本版继续遵守：

- **页面只读、不回显、不持久化。** 所有权在插件侧（`preference_config.json` → `config.json`），
  页面只是读者；放进页面的 zustand 树会产生两个写入方，并可能被启动竞态里的旧快照覆盖回去。
- **回写时剥掉。** `FoliaPlugin.onSettingsFromPage` 里对 `showPlaybackBar` 与 `showProblemButton`
  各做一次 `Json.withoutMember`，页面回传的树里即使带了这两个键也不会落盘。
  一条**不带**该键的 payload 不会把已有值改回默认——页面自己发出的回显里没有这些键，
  那不代表「用户把它们关掉了」。

## 三、自检复查与「每次构建后复检」

### 3.1 复查了什么

自检（「出现问题」）是**唯一一个会向用户断言「你的机器缺东西」的功能**，它说谎的代价最高；
它同时也是**最容易随版本漂移**的部分：它断言的很多是「*这一个*构建的事实」（配置页声明了哪些开关、
页面半能读到什么、某个 FAIL 是不是真的）。本版把三层逐层对了一遍：

| 层 | 文件 | 职责 | 本版改动 |
| --- | --- | --- | --- |
| **判定层** | `FoliaDiagnostics.kt` | 决定每个检查项的 verdict | 新增 `configContractCheck`：比对「`preference_config.json` 声明的 switch」与「代码 `KNOWN_CONFIG_SWITCHES` 实际读取的键」，**双向**——声明了没读、或读了没声明，都报 `FAIL` 并点名是哪个键 |
| **判定层** | 同上 | 同上 | 新增 `isDevCheckout()`：`gradlew runDiagnostics` / IDE 运行时插件目录是**源码检出**，本来就没有暂存的原生文件与 web 产物；以前这会被判成 3 个 `FAIL`（native / bundle / settings-ui），现在判 `UNKNOWN` 并注明「开发检出目录，未暂存原生文件（不是安装缺失）」 |
| **取证层** | `FoliaEnvironmentProbe.kt` | 采集证据（值 + 来源 + 失败原因） | 不变（v0.4.7 起的四态契约照旧）：`PASS/FAIL` 必须来自正面证据，读不到只能是 `UNKNOWN` |
| **页面半** | `ProblemReportPanel.tsx` | 渲染 verdict、组装反馈正文 | 判定收敛到与 Kotlin 侧同一套四态（`pass/fail/unknown/advisory`）；WebView2 / .NET / Windows build 三项各自有纯判定函数，**空值与非数字一律 `unknown`**，只有明确证据才 `FAIL` |

宿主侧配套加了 `windowsBuild`（`HostForm.BuildEnvReport`），让页面半和 Kotlin 侧对「这是哪台 Windows」
用同一个数字判断，而不是一边读注册表、一边读 `Environment.OSVersion` 各说各话。

本机实测（`cd spw-folia && ./gradlew runDiagnostics`，exit 0）：

| 结果 | 数量 | 说明 |
| --- | --- | --- |
| `PASS` | 6 | Windows 11 build 26300.9711 / .NET Release=534296 / WebView2 150.0.4078.83 / 插件目录可写 / SPW 1.19.3 / **配置页声明与代码一致（4 个开关）** |
| `UNKNOWN` | 6 | native、bundle、settings-ui（源码检出，未暂存产物）+ 3 个权限（没有运行中的插件实例） |
| `ADVISORY` | 2 | 辅助进程会话、远程图形会话（WebGL） |
| **`FAIL`** | **0** | 健康机器上没有假 FAIL——这正是本次复查要守住的性质 |

### 3.2 新增可重复执行的复检脚本

新增 `packaging/tools/verify-diagnostics.mjs`：**真实宿主 + 真实 WebView2**，跑的是打包后的
helper + 设置岛（`packaging/native` + `packaging/web/settings`），不依赖插件、不依赖 SPW。
它覆盖四组共 15 个断言：

| 组 | 断言数 | 证明什么 |
| --- | --- | --- |
| A | 5 | 页面半真的通了：面板向宿主发 `envReport` 请求、宿主回答、面板渲染出逐项 verdict（不是卡在「正在检查」） |
| B | 2 | 健康机器上**没有假 FAIL**；判不了的项报 `unknown` 而不是 `fail` |
| C | 4 | 配置页声明与代码 `KNOWN_CONFIG_SWITCHES` **双向**一致；`showProblemButton` 默认确实是关 |
| D | 4 | 「详细日志」走的是**带迁移的读取路径**、旧文件仍在被回退读取、新组文件确实是 `diagnostics.json` |

同一目录下还有统一门禁 `packaging/tools/verify-all.mjs`（本版新增），一条命令跑完
**静态契约 7 项 + 三个真实宿主套件**：

```bash
cd "D:/输出目录/spw-folia"
node packaging/tools/verify-all.mjs           # 全量：期望 10/10 gate checks
node packaging/tools/verify-all.mjs --static  # 只跑静态契约，不开浏览器（改完就能查）
```

静态 7 项专治本版这类改动的沉默失效：三处版本号一致、配置页声明 ⇄ 代码读取键**双向**对齐、
每组一个独立 config 文件、`verboseLog` 迁移链路在位、开关 key 无重复等。这 7 项**不需要浏览器**，
所以改完代码就能先跑一遍 `--static`，不必等打包。

### 3.3 写进发版检查表：每次构建后都跑一次

**「每次构建新版本后都要跑一次自检」** 已经固定进 `docs/release.md` 的发版检查表（第 3 项，
由另一位同事在同一轮里改那份文档；本节只记录口径）。检查表里的写法是：自检报告属于**产物的一部分**，
所以按产物验收——任一项在健康机器上出 `FAIL` 就**阻断发版**，这正是 v0.4.2–v0.4.6 那次「健康机器报缺环境」
的 bug 类型。`UNKNOWN` 不算失败。

## 四、版本号定版 0.4.11（三处）

v0.4.6.1 / v0.4.7 / v0.4.8 / v0.4.9 一路开发下来，这三处长期写着旧值，从未跟上实际改动。本版一起定版：

| # | 位置 | 值 |
| --- | --- | --- |
| 1 | `spw-folia/build.gradle.kts` → `version = "0.4.11"` | 决定 `.spmod` 文件名与打包元数据 |
| 2 | `spw-folia/build.gradle.kts` → `spmod { PluginVersion = "0.4.11" }` | 决定 manifest 的 `Plugin-Version`（用户在 mod 管理器里看到的版本） |
| 3 | `FoliaPlugin.kt` → `const val PLUGIN_VERSION = "0.4.11"` | 决定日志 `start: … version=…` 与握手时上报给宿主的版本 |

> ⚠️ **三处必须一起改。** 只改 1 会出现「文件名 0.4.11、管理器里显示 0.4.10」；只改 3 会让日志与
> 实际包对不上——排查「用户装的是哪一版」时这是最容易被误导的一处。本版把这项一致性做成了
> `verify-all.mjs` 的**静态断言**（`version stamps agree in all three places`），以后再漏一处会直接非 0 退出，
> 而不是靠人肉比对。

本版完成后三处的实际取值（写作时静态核对，行号会随改动漂移，值不会）：

```
spw-folia/build.gradle.kts                                  version = "0.4.11"
spw-folia/build.gradle.kts（spmod {} 块内）                  PluginVersion = "0.4.11"
spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt      const val PLUGIN_VERSION = "0.4.11"
```

## 五、验证与遗留

### 5.1 已做（本机实测，可复现）

证据分两层：**静态核对**（读源码/产物数命中）与**真实验证**（构建产物 + 真实宿主 + 真实 WebView2）。
验证等级：**离线构建 + 本机端到端，未装机、未用户验收**。

| 项 | 命令 / 位置 | 结果 |
| --- | --- | --- |
| 三处版本号一致 | `verify-all.mjs` 静态 1a | ✅ `0.4.11` / `0.4.11` / `0.4.11` |
| 配置页声明 ⇄ 代码读取键双向对齐 | `verify-all.mjs` 静态 1b | ✅ 4 个 switch 全部有读取实现，无多余项 |
| 每组一个独立 config 文件 | `verify-all.mjs` 静态 1c | ✅ `config.json`(3) / `diagnostics.json`(1) / `support.json`(1) |
| 「详细日志」迁移链路在位 | `verify-all.mjs` 静态 1d | ✅ 新组文件 = `diagnostics.json`，旧 `config.json` 回退仍在 |
| 开关 key 无重复 | `verify-all.mjs` 静态 1e | ✅ |
| 设置岛类型检查（`npx tsc --noEmit`） | `poc/settings-ui` | ✅ **297** 个 error，与 v0.4.10 记录的基线**完全一致**（全部是 `@/` 别名与上游 `work/folia` 源码的既有噪声）；**改动命中的行内 error 为 0** |
| Kotlin 单元测试 | `./gradlew --offline test` | ✅ `BUILD SUCCESSFUL`，`FoliaDiagnosticsTest` **18 个测试 / 0 失败** |
| 自检（本机真机） | `./gradlew --offline runDiagnostics` | ✅ exit 0，**0 个 FAIL**（6 PASS / 6 UNKNOWN / 2 ADVISORY，见 §3.1） |
| 自检页面半（真实 WebView2） | `node packaging/tools/verify-diagnostics.mjs` | ✅ **15/15 PASS**（连跑 5 次均通过，见 §5.3 第 1 条） |
| 「显示问题反馈按钮」开关 | `node packaging/tools/verify-problem-button-switch.mjs` | ✅ **9/9 PASS** |
| 「显示播放条」开关（防回归） | `node packaging/tools/verify-playback-bar-switch.mjs` | ✅ **15/15 PASS** |
| 统一门禁 | `node packaging/tools/verify-all.mjs` | ✅ **10/10 gate checks**（静态 7 + 真实宿主 3） |
| 插件包构建 | `./gradlew --offline plugin` | ✅ `build/libs/plugin-dev.spw.folia-0.4.11.spmod` **346,078 B / 96 files** |
| 包内 manifest | `classes/META-INF/MANIFEST.MF` | ✅ `Plugin-Version: 0.4.11`、`Plugin-Id: dev.spw.folia` |
| 包内配置声明 | `classes/preference_config.json` | ✅ 三组：播放页 3 个 switch（含 `showProblemButton`，`default_value=false`）/ 诊断与日志 1 个 / 支持与反馈 1 个 button |

#### 5.1.1 开关套件的具体断言（真实宿主 + 真实 WebView2）

`verify-problem-button-switch.mjs`（9/9）——默认路径是「**按钮不存在**」，所以「消失」是主用例：

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| A 默认 | 设置树里**没有** `showProblemButton` 时救生圈按钮不存在（`v0.4.11` 默认已翻成关） | ✅ `problemButton: false` |
| A 默认 | 面板也一并**不挂载** | ✅ `problemPanel: false` |
| A 默认 | 齿轮与右下角播放背景按钮**不受影响** | ✅ `gear: true, playerPanel: true` |
| B 打开 | 注入 `showProblemButton: true` 后按钮存在且可点 | ✅ `problemButton: true` |
| B 打开 | 页面从桥里读到的值确实是 `true` | ✅ `injected: true` |
| C 关闭 | 注入 `false` 后按钮再次消失 | ✅ `problemButton: false` |
| C 关闭 | 页面读到的值确实是 `false` | ✅ `injected: false` |
| C 关闭 | 其它 chrome 两个都还在（开关不会连带吃掉别的控件） | ✅ `{gear: true, playerPanel: true}` |

`verify-playback-bar-switch.mjs`（15/15，v0.4.10 写的脚本，本版重跑确认**没被新 hook 改动打破**）：
默认树播放条在、注入 `false` 后整条不挂载、旧帧率 cap 的清场仍然有效（`storage: null` / `capped: false`）。

> 「关闭」用的是 DOM 里**根本没有这个节点**，不是 `display:none`：这同时证明了没有 hit region
> （透明窗口下 hitbox 靠节点 rect 上报，节点不在就没有区域）。

### 5.2 仍未做（不编造数字）

| 项 | 状态 |
| --- | --- |
| `dist/release/spw-folia-0.4.11.spmod`（正式发布包） | ✅ **已组装**（2026-11-02 18:12 本地）：15,406,708 B / 3,976 项 / sha256 `e7bd3668…2fa22`；`withinBudget: true`（16 MB 预算内，14.69 MB） |
| `node packaging/tools/verify-layout.mjs`（打包布局整体验收） | ✅ **已为本版跑**：`pass=true`、`consoleErrors=0`、`styleThumbs 17/17`、`settingsScripts=1`、`preview.ready=true` |
| 真机 SPW：配置页显示三组、详细日志在「诊断与日志」下 | **未装机**。本版的自检是以 `gradlew runDiagnostics` 方式跑的（没有运行中的插件实例，所以 3 个权限项报 `UNKNOWN`），没有在 SPW 的模组管理界面里逐项点过 |
| 真机 SPW：升级后详细日志的真实迁移 | **未装机**、**未用真实旧版 `config.json` 验过一次迁移**。迁移逻辑目前只有代码层核对 + 静态断言，**没有实机证据** |
| 真机 SPW：打开「显示问题反馈按钮」后点开面板 | **未装机**（页面侧已在 §5.1.1 用真实 WebView2 验证，但没在 SPW 的播放窗口里点过） |
| fps 实测值 | **不适用**——本版不动渲染与限流链路，没有可比的性能数字；若要记录须另跑 `--fps-log` |

### 5.3 遗留问题

1. **`verify-diagnostics.mjs` 的间歇性失败已定位并修复（固定等待 → 轮询）。** 复检阶段有一轮报
   `12/15`，失败的是 A3/A4/A5（点了按钮但面板没开 / 面板没渲染出行 / 宿主没在等待窗口内回答
   `envReport`）；单跑 5 次又全过 —— 典型的时序 flake。
   **根因**：脚本靠固定 `sleep(2500)` 等设置岛挂载、`sleep(3500)` 等面板拿到宿主 `envReport`
   （宿主侧 4 s 超时）。机器有负载时（本机同时跑 WebView2 + Gradle）这个时长不够，于是读到的是
   「还没挂载 / 还没出结果」的中间态。
   **修法**：新增 `waitFor()`，对「设置岛就绪」「面板出现检查行」两个条件**轮询到成立或预算耗尽**
   （分别 12 s / 20 s），并留最后一次读数取稳态；外层看门狗相应放宽到 75 s。
   **断言一条没放宽**：条件不变，只是不再假设它多久成立。
   **验证**：修后连跑 4 次全 15/15；再用 4 个 `yes` 占满 CPU 制造负载，仍然 15/15。
   「失败就重跑一次」的临时规定**已撤销**——套件现在失败即真失败。
2. **「详细日志」的迁移只有代码层证据。** 本版没有装一台带旧 `config.json`（`verboseLog=true`）的机器做真机升级，
   所以「升级不丢设置」这条结论目前建立在代码核对 + 静态断言上。发版前应补一次真机升级验证。
3. **`v0.4.9` 仍然没有独立的 notes 文件。** 它的改动（色键换色、首帧信号修正、帧率设置、混淆名加固）
   散记在 `release-notes-v0.4.8.md` 与代码注释里；若要补齐，应另开文件而不是改写 v0.4.8。
4. **其余文档的版本口径由另一项工作统一修正**（`docs/release.md`、`docs/dev-experience.md`、
   `docs/known-inert-settings.md`、`docs/settings-ui-impl.md`、`docs/logging-and-diagnostics.md` 等），
   本文件不改它们。

## 六、产物

```
# 本机会话构建（plugin 任务），未发布
spw-folia/build/libs/plugin-dev.spw.folia-0.4.11.spmod
  sizeBytes:      346,078
  entries:        96          # files; the 5 directory entries are excluded (ledger convention)
  sha256:         e7b0bced530496b480708cc4b98f100a3588834d19c072dd1056f34f9b3f4d8e
  Plugin-Version: 0.4.11
  Plugin-Id:      dev.spw.folia

# 宿主与设置岛（已同步进 packaging/ 暂存区）
packaging/native/spw-folia-host.exe          178,688 B
packaging/web/settings/settings-ui.js        912,050 B
                                             sha256 19346360b684e10e8e519392cd50d1c5b37ef93114420261030bbca611903313

# 正式发布包（本机装配，未上传）
dist/release/spw-folia-0.4.11.spmod
  sizeBytes:      15,406,708   (14.69 MB, 预算 16 MB → withinBudget)
  entries:        3,976
  sha256:         e7bd36687e9499c6882bfb2b549610b63e5a3dae85732b69127b1bf0f012fa22
  Plugin-Version: 0.4.11
  Plugin-Id:      dev.spw.folia
  Plugin-Permissions: class-transform,library-read,key-bindings
```

### 6.1 ⚠️ 可复现性：装配确定，但宿主 exe 不是

`assemble-release.py` **是确定性的**：同一份 `plugin-dev…spmod` + 同一份 `packaging/` 暂存树，
连跑两次装配得到**完全相同的 sha256**（实测两次均为 `e7bd3668…`）。

但 `.NET Framework` 的 `csc.exe` **不支持 `-deterministic`**（那是 Roslyn / .NET SDK 的能力）。
同一份源码连续编译两次，`spw-folia-host.exe` 的 sha256 **不同**：实测 51 个字节有差异，全部是编译器
自动生成的标识符——PE 时间戳（偏移 `0x88`）、字符串形式的时间戳、**MVID GUID**、**PDB GUID**，
**不含任何源码内容**。文件长度恒定 178,688 B。

因此：**`.spmod` 的 sha256 只能以本机装配的那一份为准**，无法通过「重跑构建」逐字节复现。
这与 `docs/dev-experience.md` §7.4「重跑构建产物逐字节一致」的期望有出入，原因是该条写于
v0.1.6（当时宿主改动少、且未逐字节比对过 exe）。**这是既有构建链的限制，不是本版引入的**；
要修需换 Roslyn `csc` 或改用 .NET SDK 构建，属独立任务。

与 v0.4.10 的包对比（同一 `plugin` 任务，判包内文件清单）：`92 → 96` 个文件，**新增 4 个、删除 0 个**。
新增的全部是本版的类文件：`FoliaConfigGroups.class` 与 `FoliaConfigGroups$Migrated.class`（迁移读取）、
`FoliaPlugin$readVerboseLog$read$1.class`（迁移读取的 lambda）、
`FoliaDiagnostics$configContractCheck$$inlined$sortedBy$1.class`（配置契约检查）。

> `dist/release/` 下现有的 `spw-folia-0.4.6.1.spmod`、`spw-folia-0.4.7.spmod`、
> `spw-folia-0.4.7-dev.spmod` **全部是本地产物，从未发布**。
