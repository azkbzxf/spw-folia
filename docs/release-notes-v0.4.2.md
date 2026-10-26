# spw-folia v0.4.2 — 修掉三个已知问题：凝彩透明遮挡、逐字歌词不同步、日志与「出现问题」

v0.4.2 是一次**修 issue + 可观测性**更新，对应仓库里三个 open issue。三个问题的根因都不在渲染器本身，
而在「插件 → 宿主 → 页面」这条数据链的末端：

- **#13 逐字歌词与实际不同步**：插件一直在发 SPW 的真实逐字时轴（`cells`），页面侧的 mapper 把它丢了，
  于是所有逐字样式拿到的是「按字符数均分整行时长」的假时轴。
- **#11 凝彩未完全适配透明窗口**：v0.2.0 的透明覆盖只关了纸雾/网点，而片尾海报、段落擦除块、装饰、
  镜头畸变这几层不读那个开关，在色键窗口下整屏遮住桌面。
- **#12 增加日志功能**：原来只有一份插件日志 + 一份宿主 stdout 镜像，缺环境自检、缺一键反馈、
  页面自己的 `console.warn` 也进不了日志。

## 重点

- **逐字歌词恢复真实时轴**：`cells[]` → Folia `words[]`，长音/长词不再提前或滞后；没有逐字时轴的
  歌词（普通 LRC）仍按原来的均分兜底，行为不变
- **凝彩透明只剩歌词与线框**：装饰、角标、段落转场、镜头畸变、用户图片层在透明期间全部关闭；
  片尾海报（整屏不透明底板）在透明期间不再构建
- **「出现问题」按钮**：SPW「模组管理 → 配置 → 支持与反馈」新增；播放页右上角也加了救生圈入口
- **环境自检**：10 项插件侧检查 + 宿主侧原生环境报告，缺哪项说哪项，并给修复链接
- **一键反馈**：环境齐全时打开已预填环境信息与日志的 GitHub issue 表单，同时打开日志文件夹并选中日志
- **日志更详细**：页面 `console.warn/info` 入日志、卡顿（>100 ms 帧）单独成行、可选「详细日志」开关

## 修复

### #13 部分歌词样式显示的逐字歌词与实际不同步

**根因**：`poc/settings-ui/src/useConfigPublisher.ts` 的 `toPublisherLyrics` 只映射
`startMs/endMs/main/sub/id`，把协议 §1 里的 `cells`（SPW `LyricsLine.Cell`，绝对毫秒）整个丢掉了。
`publisher/config.ts` 的 `buildLine` 因此永远走 `fallbackWords()`——把一行时长按字符数均分。
读 `line.words` 的样式（逐字扫光、关键字着色、凝彩/花火的逐字入场等）于是按伪造时轴动画。

**修复**：`cells` 1:1 映射成 `PublisherWord[]`（空文本 cell 是时间空隙，跳过）；`words` 只在真的有
可用 cells 时才设置，缺失时保持原来的均分兜底。验收见 `docs/archive/verification-v0.4.2.md` §1。

### #11 凝彩样式，未完全适配透明窗口

**根因**：`transparencyCompat.ts` 里 tempera 的覆盖只有 `{showBlocks:false, postProcessGrain:0,
postProcessVignette:0}`。`showBlocks` 关掉的是 35% 纸雾 + 网点 + `blocks` 构图容器；**不读这个开关**的
图层仍在：片尾海报（不透明全幅底 + 不透明圆盘）、段落 `block-wipe` 擦除块（整屏不透明人字块）、
装饰/角标/字影/水印、镜头畸变后处理（整帧重采样，截图里那道大弧线）、用户图片层。

**修复**：

1. 覆盖扩到 8 个键：`showBlocks/showDecor/showCornerMarks/enableTransitions` 全关，
   `postProcessGrain/postProcessVignette/postProcessLensDistortion` 归零，`layerImageFrequency:0`。
2. 片尾海报没有 tuning 开关，唯一杠杆是它的构建输入：`buildConfig` 在「透明 + tempera」时不发布
   `song/songArtist/songAlbum`（`suppressesClosingPoster`），`hasTemperaCreditsMetadata` 返回 false，
   海报不建。

覆盖仍然只写进发布的 config、不写回设置存储，所以关掉透明后用户自己的 tuning 与片尾海报立刻回来。

### #12 增加日志功能

**新增「出现问题」入口**：SPW 配置页按钮（`preference_config.json` 的 `type:"button"`，
`on_click: dev.spw.folia.FoliaPlugin.onReportProblem`）+ 播放页右上角救生圈按钮/面板。

**环境自检**（`FoliaDiagnostics.kt`）：Windows/位数、.NET Framework 4.8（注册表 `Release`）、
WebView2 Runtime ≥86、5 个原生文件、`web/index.html`、`settings-ui.js`、插件目录可写、SPW ≥1.19.0、
`class-transform`/`library-read`/`key-bindings` 三项权限、图形会话。宿主 `BuildEnvReport()` 补上
实际 WebView2 版本、.NET Release、`nativeFiles.present/missing`、用户数据目录、DPI、透明状态、音频源、
fps/状态计数与日志路径。缺失项逐个 toast/标红并给修复链接。

**一键反馈**：环境齐全时打开已预填的 GitHub issue 表单（环境表 + 页面状态 + 日志尾部），同时
`explorer /select` 打开日志目录并选中 `spw-folia.log`。宿主只接受 `http`/`https`。

**日志增强**：

- `Shim.js` 也镜像 `console.warn` / `console.info`（此前只有 `console.error`；info 去重且上限 200 条）
- rAF 表新增 `stallFrames`（>100 ms 帧）与 `worstFrameMs`，宿主写一行 `page-stall`
- 新配置开关「播放页 → 详细日志」→ 宿主 `--verbose-log`（导航行 + verbose 级别）
- 新宿主参数 `--log-file`，让环境报告能指向插件镜像的宿主日志

详见 `docs/logging-and-diagnostics.md`。

## 兼容性

- 协议只**新增**消息，向后兼容：页面 → 宿主 `envCheck` / `openLogFolder` / `openUrl`，宿主 → 页面
  `envReport`（见 `docs/protocol.md` §3.1/§3.2/§3.5）。旧宿主不认这些消息，面板会退化成
  「没有收到辅助进程的环境报告」并只开日志目录。
- 插件版本 0.4.1 → 0.4.2；SPW 仍要求 1.19.0+，权限不变。
- 设置树不变（`verboseLog` 是新键，缺省 false）。

## 升级

覆盖安装 `.spmod` 即可。升级后建议先点一次「模组管理 → 配置 → 支持与反馈 → 出现问题」，
确认环境自检全绿——顺便验证新面板在你的机器上是通的。

## 证据

`docs/archive/verification-v0.4.2.md`：三个修复各自在**真实宿主 + 真实 WebView2** 上的验收输出，
外加 `packaging/tools/verify-layout.mjs` 的 11/11 通过（fps 中位 116、console 错误 0）。
