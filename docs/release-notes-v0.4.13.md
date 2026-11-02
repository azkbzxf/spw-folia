# spw-folia v0.4.13 — 修复「三个配置开关全部不生效」

**发布日期：2026-11-03。本版本发布到 GitHub Releases。**

本版只做一件事：把 v0.4.12 弄坏的三个配置开关修回来，并补上导致它们全部失效的协议缺陷。
播放、样式、协议字段、设置格式没有其他行为变化。

> **版本谱系（先读这一段，否则会误读后续内容）**
>
> | 版本 | 状态 |
> | --- | --- |
> | **v0.4.6** | 上一个已发布版本（2026-10-30） |
> | v0.4.6.1 / v0.4.7 / v0.4.8 / v0.4.9 | 未发布，仅本地 |
> | v0.4.10 / v0.4.11 | 未发布，仅本地 |
> | v0.4.12 | 未发布，仅本地 —— **本版修复它引入的失效** |
> | **v0.4.13** | **本文件，已发布** |
>
> 因此使用 v0.4.6 的线上用户升级到 v0.4.13 时，会一次性拿到 v0.4.7 以来**全部**改动
> （配置页三组分组、显示问题反馈按钮、实时样式货架等），不只是本文件的修复。

## 一、问题

用户在 SPW → 模组管理 → 配置 → **播放页** 把三个开关全部打开后，三个功能**一个都不生效**：

| 开关 | 期望 | 实际（v0.4.12） |
| --- | --- | --- |
| 打开过渡动画（`transitionAnimation`） | 打开 Folia 时播放开屏动画 | 不播放 |
| 显示播放条（`showPlaybackBar`） | 播放页底部出现播放控制条 | 不出现 |
| 显示问题反馈按钮（`showProblemButton`） | 播放页右上角出现救生圈按钮 | 不出现 |

v0.4.12 之前这些开关是可用的，所以这是一次**回归**，不是新功能没做完。

## 二、根因（两个独立缺陷叠加）

### 1. 行协议被换行截断（主因，导致三个开关全废）

插件与辅助进程之间是**行协议**：

- 插件写：`BufferedWriter.write(line)` 然后 `write("\n")`；
- 辅助进程读：`Console.OpenStandardInput()` + `reader.ReadLine()`。

而 `settings` 消息把设置树**原样内嵌**进一行 JSON：

```
{"t":"settings","settings":<设置树原文>}
```

内置的 `default-settings.json` 是**美化格式**（7188 字节，含 **268 个换行**）。于是这一次推送被
拆成几百条**非法 JSON 片段**，辅助进程全部解析失败并丢弃 —— 页面**从来没有收到**
`showPlaybackBar` / `showProblemButton`，开关看上去就是死的。

实测证据：修复前宿主日志里由插件下发的 `settings` 消息为 **0 条**；页面收到的 49 条 `settings`
全部来自页面自身的回声。

同类隐患也存在于 `lyrics` / `track`（同样是原样内嵌），本版一并约束。

### 2. `ready` 之前的推送被丢弃且从不重发

宿主在 WebView2 就绪前会直接丢弃发往页面的消息（日志 `post-page-skip reason=not-ready`），
而插件的首次推送**必然**落在那个窗口里。v0.4.12 的代码只在启动时发一次，之后不再补发。

于是即使第 1 条修好了，首次打开窗口仍然收不到设置。

## 三、修复

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | 新增 `Json.singleLine()`：发送前把设置树压成单行，**只**去掉 token 之间的空白，字符串字面量内的空格/转义/Unicode 逐字节保留 | `Json.kt` |
| 2 | `sendSettings()` 统一在出口处压行（所有下发路径共用同一个出口） | `FoliaHostBridge.kt` |
| 3 | 收到宿主 `ready` 后重发一次设置树 | `FoliaHostBridge.kt` |
| 4 | 内置默认树也归一为单行，消除「美化/紧凑」两种拼写交替 | `FoliaSettingsStore.kt` |
| 5 | `transitionAnimation` / `verboseLog` 变更后重新赋值给 bridge（v0.4.12 只在启动时读一次，改完下次开窗不生效） | `FoliaPlugin.kt` |
| 6 | 配置文件被抓到半写（空文件）时重试一次，不再跳过整次同步 | `FoliaConfigSync.kt` |
| 7 | 恢复 v0.4.12 丢失的「详细日志」旧值迁移（老用户升级后该开关不再被重置） | `FoliaConfigSync.kt` |

## 四、验证

本机端到端（真实宿主 `spw-folia-host.exe` + 真实 WebView2 150.0.4078.83 + 真实 SPW 1.19.3）：

- **发布门禁 `verify-all.mjs`：10/10 全通过**（7 项静态契约 + 自检 15/15 + 问题按钮套件 9/9 +
  播放条套件 15/15）。
- **真机复现与确认**：改配置后插件在 **≤1 s** 内捕获并推送（日志
  `config showPlaybackBar=false (playback bar hidden)` → `config sync (listener(config.json)): pushing settings tree`），
  双向切换（开→关→开）均即时生效，无需重开窗口。
- **真机启动确认**：`settings loaded (6641 bytes, persisted)` —— 此前 8 次启动全部是
  `default`，即持久化本身也曾被这条链路带坏。
- 新增三个回归脚本，均已纳入仓库：
  - `packaging/tools/verify-json-singleline.mjs`（10 项单元：字符串内空白、转义引号、反斜杠、
    `\n` 转义、CJK、emoji、自定义字体栈、内置树等价性）
  - `packaging/tools/verify-playback-switches.mjs`（美化树被丢弃 vs 单行树生效，双向可切）
  - `packaging/tools/verify-live-settings-payload.mjs`（用真实持久化树构造载荷，端到端）

**未做**：装机后的人工点击验收（用户已在本机验收通过，但未另做一次独立的装机点击）。
`verify-layout.mjs` 的 `exitedZero` / `closedUser` / `escClosedSettingsOnly` 三项在**快速
开→关→重开→ESC** 的极端时序下会失败，原因是上游 `StudioWindow` 卸载动效与 React 协调器的竞态
（宿主机日志可见 `NotFoundError: insertBefore/removeChild`）。**真实单次「打开→关闭」实测 0 报错、
ESC 正常关闭面板**，故不阻塞发布，但如实记录在此。

## 五、升级须知

- 直接从 v0.4.6 升级的用户会同时拿到 v0.4.7–v0.4.12 的全部改动。
- 配置文件位置不变：`%APPDATA%\Salt Player for Windows\workshop\data\dev.spw.folia\config.json`。
- 「详细日志」开关所在的 `diagnostics.json` 是 v0.4.11 新增的；本版恢复了从 `config.json`
  读取旧值并迁移过来的一次性逻辑，因此老用户原来的设置不会丢。
- `打开过渡动画` 与 `详细日志` 是**下次打开 Folia 时生效**（spawn 期参数）；`显示播放条` 与
  `显示问题反馈按钮` 是**即时生效**。

## 六、产物

| 项 | 值 |
| --- | --- |
| 文件 | `spw-folia-0.4.13.spmod` |
| 大小 | 15,438,647 B（14.72 MiB，预算 16 MB 内） |
| 条目 | 3982 |
| sha256 | `5cb1cdafacdea46559e4b57ad1934522e6b20874d2531aabad2b46cac948f308` |
| `Plugin-Version` | `0.4.13` |
| 权限 | class-transform, library-read, key-bindings |
| 宿主 exe | `spw-folia-host.exe` 164,864 B（未改动） |
| WebView2 Runtime | 实测 150.0.4078.83 |

校验：

```bash
sha256sum spw-folia-0.4.13.spmod
```
