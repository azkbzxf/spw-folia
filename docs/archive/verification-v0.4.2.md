# v0.4.2 / v0.4.3 验收记录（issue #11 / #12 / #13）

日期：2026-10-26 · 机器：Windows 11 x64 build 26300 · WebView2 150.0.4078.83 · .NET Framework 4.8.1 (Release 534296)
产物：`spw-folia/build/libs/plugin-dev.spw.folia-0.4.2.spmod`（229,792 B）、`spw-folia-host.exe` 160,768 B、
`settings-ui.js` 2,249.78 kB（gzip 716.02 kB）。

所有证据都是**真实宿主 + 真实 WebView2**，不是模拟器：脚本用 `spw-folia-host.exe` 加载真实
`poc/webview/dist/dist` 与 `poc/settings-ui/dist`，通过宿主自带的 `command eval` 读回页面里的
`__SPW_FOLIA__.lastConfig()`。

---

## 1. issue #13 —— 逐字歌词与实际不同步

**根因**：插件按协议 §1 发了真实逐字时轴（`lines[].cells[]`，SPW `LyricsLine.Cell` 的绝对毫秒），
但页面侧 `useConfigPublisher.toPublisherLyrics` 只映射 `startMs/endMs/main/sub/id`，把 `cells` 丢了。
于是 `publisher/config.ts` 的 `buildLine` 走 `fallbackWords()`，把整行时长**按字符数均分**——一个伪造的
时轴，长音和长词上必然肉眼可见地漂移。只有逐字样式（读 `line.words` 的那些）受影响，所以是「部分样式」。

**修复**：`toPublisherLyrics` 把 `cells` 映射成 `PublisherWord[]`（`{text,startMs,endMs}`，空文本 cell
= 时间空隙，跳过）；没有可用 cells 的行保持不设 `words`，仍然走均分兜底。

**验收**：喂两行歌词——第一行带真实 cells（`城` 1000–3000、`府` 3000–5000），第二行 `cells: []`：

```json
{"fullText":"城府","words":[{"text":"城","startTime":1,"endTime":3},{"text":"府","startTime":3,"endTime":5}]}
{"fullText":"许嵩","words":[{"text":"许","startTime":5,"endTime":6},{"text":"嵩","startTime":6,"endTime":7}]}
```

第一行是**真实时轴**（1s→3s→5s，不是均分的 1→3→5→7 那种按字等宽）；第二行无 cells，仍走均分兜底
（5–7s 两字各 1s），行为与修复前一致。时间单位是秒（Folia `Word.startTime`），毫秒→秒在 `toWord` 里完成。

## 2. issue #11 —— 凝彩样式未完全适配透明窗口

**根因**：v0.2.0 的 tempera 覆盖只有 `{showBlocks:false, postProcessGrain:0, postProcessVignette:0}`。
`showBlocks` 关掉的只是纸雾/网点/`blocks` 构图容器；**不读这个开关**的几层仍然整屏遮住桌面：
片尾海报（不透明全幅底 + 不透明圆盘）、段落转场擦除块（整屏不透明人字块）、装饰/角标、镜头畸变后处理
（整帧重采样，截图里那道大弧线）、用户图片层。

**修复**：
1. `transparentStyleTuning('tempera')` 扩到 8 个键：`showBlocks/showDecor/showCornerMarks/enableTransitions`
   全关，`postProcessGrain/postProcessVignette/postProcessLensDistortion` 归零，`layerImageFrequency:0`。
2. 片尾海报没有 tuning 开关，唯一杠杆是它的构建输入（歌曲元数据）——`buildConfig` 在「透明 + tempera」时
   不发布 `song/songArtist/songAlbum`（`suppressesClosingPoster`），`hasTemperaCreditsMetadata` 因此返回 false，
   `drawCredits` 根本不建海报。

**验收**（真实宿主，`--window 1280x720`，页面 store 切透明）：

透明开启：
```json
{"transparent":true,"song":null,"songArtist":null,
 "tuning":{"showBlocks":false,"showDecor":false,"showCornerMarks":false,"enableTransitions":false,
           "lens":0,"grain":0,"vignette":0,"layerFreq":0}}
```
透明关闭后同一份配置回到默认值并恢复元数据：
```json
{"transparent":false,"song":{"id":"t1","name":"城府"},"songArtist":"许嵩",
 "tuning":{"showBlocks":true,"showDecor":true,"showCornerMarks":true,"enableTransitions":true,
           "lens":0.3,"grain":0.2,"vignette":0.85,"layerFreq":0.6}}
```
即覆盖是**渲染期**的、不写回设置：关掉透明后用户自己的 tuning 与片尾海报立刻回来。

## 3. issue #12 —— 日志功能 / 「出现问题」自检与反馈

**实现**（详见 `docs/logging-and-diagnostics.md`）：
* SPW 配置页新增「支持与反馈 → 出现问题」按钮（`preference_config.json` 的 `type:"button"`，
  `on_click: dev.spw.folia.FoliaPlugin.onReportProblem`，`@JvmStatic @JvmName` 与 workshop API 示例一致）；
  播放页右上角齿轮左边加了同效的救生圈按钮 + 面板。
* 环境自检：插件侧 10 项（Windows/位数、.NET 4.8、WebView2 ≥86、5 个原生文件、web bundle、settings island、
  目录可写、SPW 版本、三项权限、图形会话），宿主侧 `BuildEnvReport()` 补上只有原生进程才看得到的部分
  （实际 WebView2 版本、.NET Release、`nativeFiles.present/missing`、用户数据目录、DPI、透明状态、音频源、
  fps/状态计数、日志路径）。缺哪项就逐个提示并给修复链接。
* 反馈：环境齐全时打开**已预填**的 GitHub issue 表单（环境表 + 页面状态 + 日志尾部），同时用资源管理器
  打开日志目录并选中 `spw-folia.log`；自检失败时只打开日志目录。
* 日志更详细：`Shim.js` 现在也镜像 `console.warn` / `console.info`（此前只有 `console.error`）；
  rAF 表新增 `stallFrames`（>100 ms）与 `worstFrameMs`，宿主据此写一行 `page-stall`；
  新增「播放页 → 详细日志」开关（`verboseLog`）→ 宿主 `--verbose-log`（导航行 + verbose 级别）；
  新增 `--log-file` 让环境报告能指向插件镜像的宿主日志。

**验收**：
* 环境报告端到端（页面 `emit('envCheck')` → 宿主 → `envReport` 事件）返回 855 B 的完整对象：
  `webView2=150.0.4078.83`、`dotnet=534296`、`os64=true`、`process64=true`、`bundleIndex=true`、
  `settingsEntry=true`、`nativeFiles.missing=[]`、`droppedLogLines=0`；宿主日志同时有
  `env-check requested -> 855B`。
* `page-stall` 行在首帧阶段正常出现一次（`frames=1 worstFrameMs=117`），随后 120 fps 稳定、不再出现。
* 插件产物里 `preference_config.json` 含按钮，`javap` 确认
  `public static final void onReportProblem()` 存在（静态方法，SPW 才能按 `on_click` 调用）。

## 4. 回归

* `packaging/tools/verify-layout.mjs`（打包布局端到端）：**pass=true**，11/11 项（`exitedZero`、
  `closedUser`、`bridgePresent`、`settingsInjected`、`settingsAutoOpened`、`closeSettingsCommand`、
  `openSettingsCommand`、`escClosedSettingsOnly`、`visualizerCanvases`、`noConsoleErrors`），
  spawn→ready 789 ms，fps 中位 116（min 73 / max 119），console 错误 0。
* 设置 UI `vite build` 通过（2,249.78 kB / gzip 716.02 kB）。
* 宿主 `build.sh` 通过（160,768 B，只有既有的 3 个 CS0169/CS0414 警告）。
* 插件 `./gradlew.bat plugin` 通过；本地安装脚本装到
  `dev.spw.folia-0.4.2-LOCAL-ONLY`，`host/spw-folia-host.exe` 为新的 160,768 B。

## 5. 未做 / 已知限制

* 未在真机上点过 SPW 配置页的按钮（需要启动 SPW 并手动点击）；按钮的**调用链**已用 `javap` + 同构的
  workshop API 示例确认，环境自检与反馈动作本身已在真实宿主里跑通。
* 片尾海报在透明模式下被**隐藏**而不是重绘成透明版本：凝彩的片尾是「平涂底板 + 不透明圆盘」构成的，
  去掉底板后标题的可读性没有保障，因此选择不显示（与 `monet`/浅色 `lumiere` 归为不可用的思路一致）。
* `page-stall` 的阈值（100 ms）与 fps 窗口（1 s）是经验值，若要更细的卡顿画像需要接 `PerformanceObserver`。
* 详细日志只影响**下一次**打开 Folia（开关在 spawn 时读取），页面上没有即时切换入口。

## 6. v0.4.3 日志复查（发布后）

用户贴回真实会话日志（SPW 1.19.2、3200×2000 @ 173 DPI、透明 + 鼠标穿透开启），逐行核对后发现 4 个
问题，均已修复：

| 日志现象 | 根因 | 修复 |
| --- | --- | --- |
| `console.warn:     at bt (…createSonnetPixiRuntime…)`（只有堆栈、没有正文） | PixiJS 的弃用警告是 `groupCollapsed('%c…%c%s', …)` + `warn(stack)` + `groupEnd()` 三段式；`Shim.js` 只镜像了 `warn`，于是正文（第一条）丢失、只剩第二条的堆栈 | 也镜像 `groupCollapsed`/`group`/`groupEnd`，并实现 `%s`/`%c` 占位符：标签单独成行，组内堆栈带 `标签: ` 前缀 |
| `open-log-folder dir=…\spw-folia-host.stdout.log selected=False` | 面板传的是 `logPath`（**文件**，来自 `--log-file`），宿主把它当目录 | 文件 → 选中所属目录里的该文件；目录 → 选中其中的 `spw-folia.log` |
| `transparency mouse=catcher drag=on/off` 刷了 104 行 | 每次在热区内按下/松开各写一行，级别是 `info` | 降为 `debug` |
| `webview scale` 从未出现（`dpr=1` 而 `winDpi=173`） | `docs/protocol.md` §8 要求「按目标屏 DPI 设置 `RasterizationScale`」，但代码只设了 `Bounds`。实测该值默认已由初始窗口尺寸推出并**恰好等于 1.802**（3200/1.802≈1776、2000/1.802≈1110），所以本次画面并不模糊；但换到不同 DPI 显示器后不会更新 | 新增 `ApplyRasterizationScale`：反射取 `CoreWebView2Controller.RasterizationScale`，在 `nav-done` 与每次几何变化后对齐 `DpiForWindow`，值不变时不打日志 |

**DPI 的实测结论**（避免误判）：默认与 `--force-dsf 1` 两组的逐像素梯度能量为 3.183 vs 3.049（基本相同），
capture 尺寸都是 3200×2000 级别——画面是原生分辨率渲染，`dpr=1` 只是 WebView2 用 `RasterizationScale`
在合成层缩放的正常表现。因此**不把 `dpr=1` 当 bug 处理**，只补上换屏后的 scale 同步。

复查用的探针脚本留在 `.tmp-issues/`（`probe-console2.mjs`、`probe-fixes.mjs`、`probe-cmp.mjs`），
均为真实宿主 + 真实 WebView2。
