# spw-folia v0.4.10 — 删除「帧率」设置、新增「显示播放条」开关、版本号定版 0.4.10

**本版本未发布，仅本地测试。** 验证等级：**本机构建 + 本机端到端，未装机、未用户验收**。
本版做到了：删除帧率链路、接通「显示播放条」开关、把三处版本号定版到 0.4.10；并在真实宿主 +
真实 WebView2 上跑了新写的验收脚本（15/15 PASS，见 §4.1.3），`plugin` 任务产出了
`plugin-dev.spw.folia-0.4.10.spmod`（`Plugin-Version: 0.4.10`）。
**没有做**的：装机真机点击、`dist/release/` 正式发布包、`verify-layout.mjs` 整体验收——这些在
§4.2 逐项列为「未做」，不填估算值。

> **版本谱系（先读这一段，否则后面每一节都会误读）**
>
> | 版本 | 状态 |
> | --- | --- |
> | **v0.4.6** | **最后发布的版本**（GitHub Releases 可查） |
> | v0.4.6.1 | 未发布，仅本地构建与测试 |
> | v0.4.7 | 未发布，仅本地构建与测试 |
> | v0.4.8 | 未发布，仅本地构建与测试 |
> | v0.4.9 | 未发布，仅本地构建与测试（**没有独立的 notes 文件**，改动散记在 `release-notes-v0.4.8.md` 与代码注释里） |
> | **v0.4.10** | **未发布，仅本地测试（本文件）** |
> | v0.4.11 | 未发布，仅本地测试（**已被其接续**，见 [`docs/release-notes-v0.4.11.md`](release-notes-v0.4.11.md)） |
>
> v0.4.6 之后的所有版本**从未上传 GitHub Releases**，其改动随后续版本一并交付。
> `dist/release/` 与 `spw-folia/build/libs/` 下的 `.spmod` 全部是**本地产物**。

本版只做三件事：把配置页的「帧率」整条链路删掉、新增「显示播放条」开关、把长期停留在 `0.4.7`
的三处版本号定版到 `0.4.10`。播放、样式、协议、设置格式都没有行为变化。

## 一、删除配置页「帧率」设置

位置：SPW → 模组管理 → 配置 → 播放页。v0.4.9 在这里加过一个 `type: "list"` 的「帧率」四档
（`无限制` / `120` / `90` / `60`）。v0.4.10 把它**整条链路移除**——不是隐藏、不是标灰，是代码里
不再有这个设置。

### 1.1 为什么删（口径）

两条理由，缺一条都不足以支撑「删」这个决定：

1. **默认值本来就是正解。** 默认档是 `无限制`，语义就是「不限帧率 = 跟随屏幕刷新率」。既然
   推荐配置就是默认配置，这个设置对绝大多数用户**只有负价值**：它唯一的能力是把画面调差。
2. **选了的档位也不准。** 上游 `src/utils/frameRateLimiter.ts` 的
   `shouldProcessFrameAtRate()` 算的是 `intervalMs = 1000 / frameRate - 1`，那个 `-1ms` 容差让
   所需间隔永远比目标 vsync 略短一点点，于是在某些刷新率上**退化到下一档**。

v0.4.8 已实测记录过的退化表（本版未重测，数据引自 `release-notes-v0.4.8.md` 第四节）：

| 显示器 | 120 档 | 90 档 | 60 档 |
| --- | --- | --- | --- |
| 60Hz | 60 | 60 | 60 |
| 120Hz | 120 | **60** | 60 |
| 144Hz | **72** | **72** | **48** |
| 165Hz | **83** | **83** | **55** |

本机 120Hz 屏的复核（同样引自 v0.4.8）：`off` = 120（限流器**未**安装）、`120` = 120、
`90` = **60**、`60` = 60。

> **决策**：保留一个「选了也不准、选错了还更差」的选项，不如删掉。用户不该为了一个只能把画面
> 调坏的开关去读一张容差表。

### 1.2 移除了什么（逐层）

| 层 | 位置 | 删除内容 |
| --- | --- | --- |
| 配置声明 | `spw-folia/src/main/resources/preference_config.json` | `type: "list"` 的 `frameRate` 项整条（四档 `entries` / `entry_values` / `default_value` 一并消失）。播放页现在只剩三项，全部是 `switch`：打开过渡动画 / 详细日志 / **显示播放条**（新增，见第二节） |
| 插件读取 | `FoliaPlugin.kt` | `readFrameRate()`、`normaliseFrameRate()`、`FRAME_RATE_KEY`、`FRAME_RATE_ALLOWED`、`FRAME_RATE_OFF`、字段 `frameRateValue`；配置监听器的回调列表与注册日志里的该键 |
| 桥接拼参 | `FoliaHostBridge.kt` | 字段 `frameRate`、spawn 命令行里 `--frame-rate` 那一对参数 |
| C# 宿主参数 | `Program.cs` | `CliArgs.FrameRate` 字段、`NormaliseFrameRate()`、`FrameRateScript()`、`--frame-rate` 的值解析 |
| C# 宿主注入 | `HostForm.cs` | 注入 `__SPW_FOLIA_FRAME_RATE__` 的那次 `AddScriptToExecuteOnDocumentCreatedAsync`（连带不再有「先写一个全局变量、再由 Shim 读」的两段式）、`frame-rate applied` 日志 |
| 页面侧写入 | `Shim.js` | `visualizer_frame_rate` 的**写入**逻辑（`setItem` + `normaliseFrameRate` + `frameRateApplied`）；`fps` 采样里的 `frameRate` 字段 |
| 页面侧清理 | `Shim.js` | **新增**：主动 `localStorage.removeItem('visualizer_frame_rate')`，见 1.3 |

### 1.3 ⚠️ 删除的关键收尾：清掉老用户残留的旧 cap

**只删设置是不够的。** 上游 `installGlobalVisualizerFrameRateLimiter()`（`src/index.tsx` 启动时调用）
读的是 `localStorage['visualizer_frame_rate']`，而 WebView2 的 profile 是**固定目录**
（`%LOCALAPPDATA%\spw-folia\webview`），与插件版本无关。所以老用户上一次在配置页选过 `60` / `90` /
`120` 的值**会一直留在那里**，升级到 v0.4.10 后仍然被限流——而且界面上已经没有任何入口能改回来。
这类「设置没了、效果还在」的残留是最难排查的一种。

v0.4.10 的处理：`Shim.js` 在 **document-created 阶段**（早于任何页面脚本、早于 bundle 启动）执行

```js
var before = localStorage.getItem('visualizer_frame_rate');
if (before === null) return;
localStorage.removeItem('visualizer_frame_rate');   // 清掉，不写回
```

配上上游的语义，`parseVisualizerFrameRate(null)` 得到 `'off'`，于是
`installGlobalVisualizerFrameRateLimiter()` 走 `restoreGlobalVisualizerFrameRateLimiter()`——**不装限流器**。

两处可观测证据：

| 证据 | 位置 | 含义 |
| --- | --- | --- |
| `ready` 消息新增 `frameRateCleared` | `Shim.js` → `HostForm.cs` | 本次启动清掉的旧 cap 值；没清到就是 `null`。只有 `off` / 空串不报告（那是无副作用的残留） |
| 宿主日志 `legacy frame-rate cap cleared <值>` | `HostForm.cs` | 上面那个字段的可读版本，写进 `spw-folia-host.stdout.log`，升级后能直接证明「旧 cap 真的被摘掉了」 |

### 1.4 保留的诊断：`capped`

`--fps-log` 每秒采样的 `capped` 字段**保留**。它是上游自己的指纹——
`window.__foliaNativeRequestAnimationFrame` **只在限流器安装时存在**，所以：

- `capped: false` = 没有任何东西在限流这个页面（v0.4.10 的预期常态）；
- `capped: true` = 上游限流器仍在（说明旧 cap 没清干净，或上游改了行为）。

这是**唯一**能区分「没限流」和「限流到与屏幕同速」的信号——光看 fps 数字分不出来，因为面板刷新率
就是硬上限。

| 诊断字段 | v0.4.10 现状 |
| --- | --- |
| `capped`（fps 每秒采样） | **保留**，是「限流器是否安装」的正向证据 |
| `frameRate`（fps 每秒采样） | **随设置一起删除**：这个字段的唯一来源就是 `--frame-rate`，没有配置值之后它只会恒为 `null`，留着是噪声 |
| `frameRateCleared`（`ready` 消息） | **新增**，见 1.3 |
| `legacy frame-rate cap cleared …`（宿主日志行） | **新增**，见 1.3 |

### 1.5 兼容：`--frame-rate` 仍然被接受

`Program.cs` 里 `case "--frame-rate": Next(argv, ref i); break;` **保留**，只是忽略取值。
理由与 v0.4.8 留下的 `--curtain-duration` / `--curtain-palette` 相同：**旧版插件**（v0.4.9 及更早）
仍会无条件传这个参数，宿主若把它当未知参数报错，一次「插件与宿主版本不同步」就会变成「窗口起不来」。
参数被吞掉、行为回到「不限帧率」，正是本版想要的降级。

## 二、新增「显示播放条」开关（默认开）

位置：SPW → 模组管理 → 配置 → 播放页，播放页的第三项（前两项是「打开过渡动画」「详细日志」）。

关闭后，播放页**不再显示底部播放控制条**——时间轴、播放/暂停、上一首/下一首、随机、播放列表
全部消失，只剩歌词画面。适合把 Folia 当纯壁纸／纯歌词层用的人。

### 2.1 配置声明

`spw-folia/src/main/resources/preference_config.json`（播放页 configs 的第三项）：

```json
{
  "type": "switch",
  "key": "showPlaybackBar",
  "title": "显示播放条",
  "summary": "播放页底部的播放控制条（时间轴、播放/暂停、上一首/下一首、随机、播放列表）。关闭后只剩歌词画面，切换即时生效。",
  "default_value": true
}
```

**默认 `true`。** 这与 v0.4.10 之前每一版的既有行为完全一致：升级上来的用户不会看到任何变化，
关闭必须是**主动**选择。

### 2.2 链路（四段，每段都只做一件事）

| # | 环节 | 做什么 |
| --- | --- | --- |
| 1 | `FoliaPlugin.readShowPlaybackBar()` | 从 SPW 的 `ConfigManager` 读布尔（读不到 / 非布尔 / 抛异常 **一律回落 `true`**），启动时读一次，之后挂在 `addConfigChangeListener` 上 |
| 2 | `withInjectedMembers()` | 用 `Json.withBoolMember(tree, "showPlaybackBar", …)` 把布尔**写进设置树顶层**，与 `systemFonts` 共用同一个注入点（四个发布点都走它：启动、开窗、快捷键改树、页面回显） |
| 3 | `FoliaHostBridge.sendSettings()` | 走既有的 `{"t":"settings"}` 通道下发；`readShowPlaybackBar` 里检测到变化且 `bridge.isRunning()` 时**立即重发一次**，所以是**热生效**，不用重开窗口 |
| 4 | `usePlaybackBarVisible.ts` → `PlaybackBar.tsx` | 页面订阅 `settings` 事件（先挂监听再读初始快照，避免两次读之间的竞态），`PlaybackBar` 在 `if (!showPlaybackBar || …) return null` 直接不渲染 |

`return null` 是**不挂载**，不是 `display: none`：DOM 里没有节点，也就**不留 hit region**——
鼠标穿透与点击判定都不会撞上一个看不见的控件。

### 2.3 为什么不吃进页面自己的设置树

页面侧的 `model/settings.ts` 那棵 zustand 树是**页面自己的持久化状态**（页面改 → emit → 插件写盘）。
这个开关的所有权在插件侧（`preference_config.json` → `config.json`），页面只是读者。放进快照会带来
两个问题：

1. 页面把值回显给插件、插件再落盘 → 同一件事实有两个写入方；
2. 用户在 SPW 配置页关掉后，页面里那份旧快照可能在启动竞态里把它覆盖回去。

所以它沿用 `systemFonts` 的同一条路（`useSystemFonts.ts`）：**只读注入成员，不回显、不持久化**。
一条**不带**该键的 payload 不会把已有值改回默认——页面自己发出的设置回显里没有这个键，那不代表
「用户把它打开了」。

### 2.4 与既有交互的关系（三条卸载规则并存，互不覆盖）

| 触发者 | 生命周期 | 语义 |
| --- | --- | --- |
| `mousePassthrough`（鼠标穿透） | 仅穿透会话期间 | 穿透时播放条本来就会被卸载（否则会挡住鼠标事件） |
| `settingsOpen`（设置覆盖层打开） | 仅覆盖层打开期间 | 设置页占满舞台，播放条让位 |
| **`showPlaybackBar`（本版新增）** | **用户级永久选择** | 用户主动关掉，就一直关着 |

四者是**或**关系（`!showPlaybackBar || mousePassthrough || settingsOpen || !visible` 任一成立就不渲染），
所以不会互相「恢复」：关掉开关后，即使退出穿透、关掉设置页，播放条也**不会**自己回来。

## 三、版本号定版 0.4.10（三处）

v0.4.6.1 / v0.4.7 / v0.4.8 / v0.4.9 一路开发下来，这三处长期写着 `0.4.7`，从未跟上实际改动。本版一起定版：

| # | 位置 | 值 |
| --- | --- | --- |
| 1 | `spw-folia/build.gradle.kts` → `version = "0.4.10"` | 决定 `.spmod` 文件名与打包元数据 |
| 2 | `spw-folia/build.gradle.kts` → `spmod { PluginVersion = "0.4.10" }` | 决定 manifest 的 `Plugin-Version`（用户在 mod 管理器里看到的版本） |
| 3 | `FoliaPlugin.kt` → `const val PLUGIN_VERSION = "0.4.10"` | 决定日志 `start: … version=…` 与握手时上报给宿主的版本 |

> ⚠️ **三处必须一起改。** 只改 1 会出现「文件名 0.4.10、管理器里显示 0.4.7」；只改 3 会让日志与
> 实际包对不上——排查「用户装的是哪一版」时这是最容易被误导的一处。`0.4.7` 这个值之所以能长期存在，
> 正是因为改一处不影响构建成功，没有任何自动化闸门会报错。

本版完成后三处的实际取值（写作时静态核对，行号会随改动漂移，值不会）：

```
spw-folia/build.gradle.kts                                  version = "0.4.10"
spw-folia/build.gradle.kts（spmod {} 块内）                  PluginVersion = "0.4.10"
spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt      const val PLUGIN_VERSION = "0.4.10"
```

## 四、验证与遗留

### 4.1 本轮做了什么

证据分两层：**静态核对**（读源码数命中）与**真实验证**（构建产物 + 真实宿主 + 真实 WebView2）。
验证等级：**离线构建 + 本机端到端，未装机、未用户验收**。

#### 4.1.1 静态核对（读源码数命中）

| 项 | 期望 | 实测 |
| --- | --- | --- |
| `preference_config.json` 里 `type: "list"` 项 | 0 | **0**（剩 3 个 `switch` + 1 个「出现问题」`button`） |
| Kotlin 侧 `frameRate` / `FRAME_RATE` | 0 | **0** |
| `FoliaHostBridge.kt` 里 `--frame-rate` | 0 | **0** |
| `Program.cs` 里 `CliArgs.FrameRate` / `NormaliseFrameRate` / `FrameRateScript` | 0 | **0**（`--frame-rate` 仍被解析但**丢弃**，见 §1.5） |
| `HostForm.cs` 里 `FrameRateScript` / `frame-rate applied` | 0 | **0** |
| `Shim.js` 里对 `visualizer_frame_rate` 的写入 | 0 | **0** |
| `Shim.js` 里对 `visualizer_frame_rate` 的 `removeItem` | 1 | **1** |
| `fps` 采样里的 `frameRate` 字段 | 0 | **0**（`capped` 保留） |
| `--frame-rate` 仍出现在 `Program.cs` | 1（兼容旧插件） | **1**（`case "--frame-rate": Next(...)`，值被丢弃） |

#### 4.1.2 构建（本机实测）

| 产物 | 结果 |
| --- | --- |
| `node poc/settings-ui` → `npx tsc --noEmit` | **297** 个 error，与改动前基线**完全一致**（全部是 `@/` 别名解析的既有噪声，无新增） |
| `npx vite build`（设置岛） | ✅ `dist/settings-ui.js` **911,870 B**（原 911,139 B，+731 B） |
| `bash poc/webview/host/build.sh`（C# 宿主） | ✅ `spw-folia-host.exe` **178,688 B**，仅 3 条既有 `CS0414/CS0169` 警告 |
| `./gradlew --offline compileKotlin` | ✅ exit 0 |
| `./gradlew --offline plugin` | ✅ `build/libs/plugin-dev.spw.folia-0.4.10.spmod` **334,174 B / 92 files**（zip 共 97 条，含 5 个目录项） |
| 包内 `classes/META-INF/MANIFEST.MF` | ✅ `Plugin-Version: 0.4.10` |
| 包内 `classes/preference_config.json` | ✅ 三项 switch（过渡动画 / 详细日志 / **显示播放条**，后者 `default_value=true`）+「出现问题」button；**无帧率项** |

#### 4.1.3 真实宿主端到端（`packaging/tools/verify-playback-bar-switch.mjs`，15/15 PASS）

跑的是**打包后的** helper + 设置岛（`packaging/native` + `packaging/web/settings`），真实 WebView2
150.0.4078.83，无插件、无 SPW：

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| A 默认 | 设置树里**没有** `showPlaybackBar` 时 `.spw-playback` 存在 | ✅ `present: true` |
| B 关闭 | 注入 `showPlaybackBar: false` 后 `.spw-playback` **整个不存在**（非隐藏）、`.spw-playback-bar` 也没有 | ✅ `present: false, bar: false` |
| B 关闭 | 页面从桥里读到的值确实是 `false` | ✅ `injected: false` |
| C 升级 | 先用上一轮 session 往 profile 写入 `visualizer_frame_rate="90"`，**真实重启**后再读 | ✅ `storage: null` |
| C 升级 | 上游限流器未安装 | ✅ `capped: false` |
| C 升级 | 宿主日志出现 `legacy frame-rate cap cleared 90` | ✅ 命中 |
| D 声明 | `preference_config.json` 无 `frameRate`、无 `list`、有 `showPlaybackBar`(switch, default true) | ✅ 5/5 |

> 「B 关闭」用的是 DOM 里**根本没有这个节点**，不是 `display:none`：这同时证明了没有 hit region
> （透明窗口下 hitbox 靠节点 rect 上报，节点不在就没有区域）。

#### 4.1.4 设置树注入的单元级验证（真实编译产物）

`Json.withBoolMember` 是这次唯一动到**持久化格式**的地方（其余都是删代码），所以单独压了它：
用 `.scratch` 里的临时 harness 直接调用 `build/classes/kotlin/main` 里**真实的 `Json.class` /
`FoliaSystemFonts.class`**（Kotlin `object` 走 `.INSTANCE`），17/17 通过：

- 注入后成员可回读；**原有成员逐字节保持**（顺序、空白都不变，仅新成员插在 `}` 前）
- 重复注入同值是幂等 no-op；`false → true` 只改字面量，不产生重复成员
- **回环**：`mergeSystemFontsJson` → `withoutSystemFontsJson` → 再注入，`showPlaybackBar` 仍在，
  且不出现 `,,` 双逗号
- 敌意输入：非对象原样返回、`{}` / `{ }` 正常注入、**嵌套同名的 `showPlaybackBar` 不会被误改**、
  前缀相同的键（`showPlaybackBarFoo`）不误匹配

### 4.2 仍未做（不编造数字）

| 项 | 状态 |
| --- | --- |
| `dist/release/spw-folia-0.4.10.spmod`（正式发布包） | **未构建**——`assemble-release.py` 会重新 stage `packaging/`，需连 `stage-web.mjs` 一起跑 |
| `node packaging/tools/verify-layout.mjs`（打包布局整体验收） | **未跑** |
| 真机 SPW：配置页只剩三个开关、帧率项消失 | **未装机**（宿主 exe 不在本机） |
| 真机 SPW：关闭「显示播放条」后控制条消失 | **未装机**（同上；页面侧已在 4.1.3 用真实 WebView2 验证） |
| fps 实测值 | **不适用**——本版已无档位，只验 `capped: false`（已验） |

### 4.3 遗留问题

1. **`poc/settings-ui/scripts/verify-frame-rate.mjs` 已归档。** 它断言的 `--frame-rate` 装限流器
   在 v0.4.10 后不成立，已移到 `docs/archive/verify-frame-rate-v0.4.9.mjs` 并在文件头标注废弃；
   替代脚本是 `packaging/tools/verify-playback-bar-switch.mjs`。
2. **v0.4.9 没有独立的 notes 文件。** 它的改动（色键换色、首帧信号修正、帧率设置、混淆名加固）
   散记在 `release-notes-v0.4.8.md` 与代码注释里；若要补齐，应另开文件而不是改写 v0.4.8。
3. **其余文档的版本口径由另一项工作统一修正**（`docs/release.md`、`docs/dev-experience.md`、
   `docs/known-inert-settings.md` 等），本文件不改它们。

### 4.3 遗留问题

1. **`poc/settings-ui/scripts/verify-frame-rate.mjs` 已与现状不符。** 它是 v0.4.9 的验收脚本，断言的
   是「`--frame-rate <60/90/120>` 能装上限流器（`capped=true`）」。v0.4.10 之后这个前提不成立，
   脚本必然失败。需要重写（改成断言「旧 cap 被清掉 → `capped=false`」）或归档——**本版未处理**，
   因为它不在发布说明的写作用域内。
2. **v0.4.9 没有独立的 notes 文件。** 它的改动（色键换色、首帧信号修正、帧率设置、混淆名加固）
   现在散记在 `release-notes-v0.4.8.md` 与代码注释里；若要补齐，应另开文件而不是改写 v0.4.8。
3. **其余文档的版本口径由另一项工作统一修正**（`docs/release.md`、`docs/dev-experience.md`、
   `docs/known-inert-settings.md` 等），本文件不改它们。

## 五、产物

```
# 本机会话构建（plugin 任务），未发布
spw-folia/build/libs/plugin-dev.spw.folia-0.4.10.spmod
  sizeBytes:      334,174
  entries:        92          # files; the 5 directory entries are excluded (ledger convention)
  sha256:         0a31ef162d628ab01d397c42bd6e0ceff5005cfd8ccc4cab6fb941aee1a6842e
  Plugin-Version: 0.4.10
  Plugin-Id:      dev.spw.folia

# 宿主与设置岛（已同步进 packaging/ 暂存区）
packaging/native/spw-folia-host.exe          178,688 B
                                             sha256 9502c62419681b92d3326b23b77af693e117de225ec64f50a048268c5a103b5b
packaging/web/settings/settings-ui.js        911,870 B

# 正式发布包
dist/release/spw-folia-0.4.10.spmod          未构建（见 §4.2）
```

> `dist/release/` 下现有的 `spw-folia-0.4.6.1.spmod`、`spw-folia-0.4.7.spmod`、
> `spw-folia-0.4.7-dev.spmod` **全部是本地产物，从未发布**。
