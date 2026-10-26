# 日志与「出现问题」自检（v0.4.2，issue #12）

Status: 已实现并通过真实宿主 + 真实 WebView2 验收（2026-10-26）。
适用范围：用户报告「打不开 / 闪退 / 黑窗 / 卡顿」时的自助排查，以及维护者做支持回复。

---

## 1. 两个入口

| 入口 | 位置 | 何时可用 |
| --- | --- | --- |
| SPW 配置页按钮 | SPW「模组管理 → 配置 → 支持与反馈 → 出现问题」（`spw-folia/src/main/resources/preference_config.json` 的 `type:"button"`，`on_click` 指向 `dev.spw.folia.FoliaPlugin.onReportProblem`） | 插件已启用即可用——**包括播放窗口打不开的时候**（这正是它存在的理由） |
| 播放页 chrome 按钮 | 全屏播放页右上角、齿轮左边的救生圈图标 → 面板（`poc/settings-ui/src/chrome/ProblemReportPanel.tsx`） | 播放窗口正常显示时；面板能看到辅助进程的实时环境报告 |

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
| `page-stall frames=N worstFrameMs=… fps=…` | 宿主 `WriteFpsSample` + `Shim.js` 的 `stallFrames`/`worstFrameMs` | 用户说的「卡顿/掉帧」变成可检索的一行；`>100 ms` 才算 stall，与普通的 25 ms 抖动分开 |
| `nav-start uri=… redirect=…` | 宿主（仅 `--verbose-log`） | 导航链路（含设置岛注入后的跳转） |
| `env-check requested -> NB` / `open-log-folder …` / `open-url …` | 宿主 | 自检与反馈动作的留痕，便于确认用户真的点到了按钮 |
| `verbose` 级别行 | 宿主 | 只在 `--verbose-log` 下出现 |

### 2.2 详细日志开关

SPW「模组管理 → 配置 → 播放页 → 详细日志」（`verboseLog`，默认关）。打开后下一次启动 Folia 时宿主带
`--verbose-log`，日志里多出导航与 `verbose` 行。它不影响播放性能：这些行只在事件发生时写，且走的是
宿主原本就有的有界队列（`JsonStdout`，8192 行上限，阻塞时丢弃并计入 `droppedLogLines`）。

## 3. 自检项

插件侧（`FoliaDiagnostics.inspect`，`reg.exe` 读注册表，2 s 超时）：

| # | 检查 | 判定 | 缺失时提示 |
| --- | --- | --- | --- |
| 1 | Windows 10 x64 1809+ | `os.version` 的 build ≥ 17763 且架构 64 位 | 需要 64 位 Win10 1809+ |
| 2 | .NET Framework 4.8 | `NDP\v4\Full\Release` ≥ 528040 | 装 4.8 的官方链接 |
| 3 | WebView2 Runtime ≥ 86 | `EdgeUpdate\Clients\{F3017226-…}` 的 `pv`（HKLM 或 HKCU）主版本 ≥ 86 | 装 WebView2 的官方链接 |
| 4 | 原生文件齐全 | `native/` 或 `lib/` 或 `host/` 下 5 个文件全在 | 重装插件 |
| 5 | 页面资源 | `web/index.html`（或 `web/dist/index.html`）存在 | 重装插件 |
| 6 | 设置岛资源 | `web/settings/settings-ui.js` 等存在 | 重装插件 |
| 7 | 插件目录可写 | 写入并删除探针文件 | 检查目录权限 |
| 8 | SPW 版本 | `≥ 1.19.0`（`HostTargets.Version.MIN_SUPPORTED`） | 升级 SPW |
| 9 | 权限 | `class-transform` / `library-read` / `key-bindings` 各自是否授予 | 到插件权限页补授后重启 |
| 10 | 图形会话 | `SESSIONNAME` 是 `RDP-*` 时提示 WebGL 可能降级（软依赖，不计入「缺失」） | — |

宿主侧（`HostForm.BuildEnvReport`，字段见 `docs/protocol.md` §3.5）补上插件看不到的部分：
WebView2 实际运行版本、.NET Release、exe 同目录 5 个文件的 `present/missing`、bundle/settings 目录、
用户数据目录、DPI/客户区、透明状态、音频源、fps/状态计数、日志路径。

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
