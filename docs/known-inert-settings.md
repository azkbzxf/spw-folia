# 设置页控件与生效情况

设置界面有两处，别混：

- **「歌词样式」设置页** —— Folia 原组件，注入覆盖层内。它用 Folia 自己的设置树，受上游能力限制。
- **SPW 配置页** —— `spw-folia/src/main/resources/preference_config.json` 声明的插件入口，
  分「播放页 / 诊断与日志 / 支持与反馈」三组，见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1。

**原则：无法生效的控件不再展示**，不保留「有开关但永远不产生效果」的 UI。

## 1. 仍然生效的控件

### 1.1 SPW 配置页（插件拥有，`switch` / `button` 两种控件）

| 组 | 控件 | 默认 | 作用 |
|---|---|---|---|
| 播放页 | 打开过渡动画（`transitionAnimation`） | 关 | 插件读 config → 宿主 `--no-curtain` → 页面按 `splash=0` 导航，不装上游开屏。**下一次打开 Folia 生效**（spawn 期参数） |
| 播放页 | 歌词样式预览动画（`previewAnimation`） | **开** | 设置树顶层布尔 → 页面 `usePreviewAnimation()`。关时货架走 `ShelfStatic`，**一个渲染器 chunk 都不加载**；开时走 `ShelfLiveView`（真实渲染器小图 + 磁盘缓存） |
| 播放页 | 显示问题反馈按钮（`showProblemButton`） | **关** | 控制播放页右上角的救生圈按钮及其诊断面板。关闭时 **React 不挂载**（不是 CSS 隐藏），因此也不上报 hit region |
| 诊断与日志 | 详细日志（`verboseLog`） | 关 | 宿主 `--verbose-log`：页面导航 / console / 卡顿采样写进日志。**下一次打开 Folia 生效** |
| 支持与反馈 | 出现问题（`button`） | — | 环境自检 + 预填反馈页 + 打开日志文件夹 |

逃生口：配置页「支持与反馈 → 出现问题」不依赖播放窗口，播放窗口打不开时照样能用 ——
这正是它存在的理由。

### 1.2 「歌词样式」设置页

| 位置 | 控件 | 说明 |
|---|---|---|
| 歌词动画 | 歌词样式磁贴（17 种 + 随机） | 写入 `visualizerMode`；随机磁贴打开随机池，手选样式则关闭随机（与上游 `preserveRandom` 语义一致） |
| 歌词动画 | 纹理分辨率、镜头运动强度、文字动势、背景短线密度、外围边框等样式参数 | 通过 `visualizerTunings` 传给渲染器 |
| 歌词动画 | 各样式专属参数（商籁 / 凝彩 / 绘光 / 花火 / … / 心象 / 静止） | 同上；只保留可渲染的项。0.7.26 起**只有「静止」没有设置面板**，其余 16 个都有 |
| 歌词动画 | 各样式面板的「渲染」组：分辨率、抗锯齿（上游 0.7.26 的 #929） | 写进该样式 tuning 的 `render`，随 `visualizerTunings` 下发；默认「跟随全局」。受影响的是 `cadenza` `diorama` `fume` `hanabi` `lumiere` `monet` `nebbia` `pendolo` `sonnet` `tempera`，其中 2D canvas 那四个（`cadenza` `fume` `monet` `nebbia`）只有分辨率一行。町景用自己的 `quality` 组表达同一件事 |
| 字体 | 字体族（无衬线/衬线/等宽/自定义）、字号、自动字重、整体透明度 | 字体族/字重写入 `theme.fontStyle` / `theme.fontWeight`（自定义时另写 `fontFamily` / `fontFamilyStack`），渲染器实际读取 |
| 字体 | 自定义字体（磁贴 + 导入字体包 + 系统字体列表） | 导入的字体包经 `FontFace` 注册进注入页并持久化到 IndexedDB（单个 ≤ 50 MB，支持 `.ttf/.otf/.woff/.woff2`）；系统字体列表由插件 Kotlin 侧用 AWT 枚举，随设置树以 `systemFonts` 下发（**不落盘**） |
| 字幕 | 隐藏翻译字幕、字幕内容模式（翻译）、字幕不透明度、字幕背景、即将歌词模糊、字幕字号 | 映射到 `subtitleOverlay*` / `showSubtitleTranslation` / `subtitleContentMode` / `subtitleFontScale` |
| 字幕 | **副字幕行数 / 内容**（上游 0.7.25 新增，行组合即 `subtitleOverlayLayout`） | 写进设置树 `subtitle.subtitleOverlayLayout`，随 `ObsBrowserSourceConfig` 下发；播放页按它逐行取文本。可选「1/2/3 行」并逐行选内容，多行布局的第一行固定是当前句。行内容里**没有罗马音**（理由见 §2 的罗马音一行）；从一行切到三行时上游会自动插入罗马音行，所以 store 侧还有一道 `sanitizeSubtitleOverlayLayout` 把它换掉 |
| 字幕 | 字幕字体跟随歌词、字幕字体族、字幕字重 | 映射到 `subtitleTheme`（跟随歌词时继承歌词主题字体，含自定义字体） |
| 背景 | 内置背景模式（隐现 / 光晕 / 莫奈 / 等）与背景参数 | 通过 `background` 配置传给渲染器 |
| 全局 | 默认 / 重置 | 重置为 Folia 默认值 |

## 2. 已移除的控件

| 位置 | 控件 | 原因 |
|---|---|---|
| SPW 配置页 | 帧率（`key: frameRate`，`type: "list"`，四档 off/120/90/60） | **上游限流算法达不到标称值**：`frameRateLimiter.ts` 的 `-1 ms` 容差让每个档位都退到下一档（120 Hz 屏上选 90 实际只有 60）。默认档 `off` 本来就等于「跟随屏幕刷新率」，留一个「选了也不准」的选项违背本页原则，于是**整条链路删除**：配置项 + Kotlin 读取 + 宿主 cap 注入 + Shim 写 localStorage。宿主仍**接受并忽略**旧的 `--frame-rate` 参数，只为让带旧参数的插件包还能正常 spawn |
| 歌词动画 | 智能动感模式（开关） | Folia 节拍检测模型（beat_this / htdemucs，WebGPU）不在 WebView bundle 中，也没有节拍事件流。**花火的随拍开花 / 推镜依赖它，因此在注入页里保持静默**（样式本身的动画不受影响） |
| 歌词动画 | 动感效果：推镜裂光、涟漪（开关 + 强度） | 由 `beatImpact` / `downbeatImpact` 驱动；无节拍数据时永不触发 |
| 字幕 | 字幕字体族/字重/系统字体（非跟随歌词分支） | 已改为映射：跟随歌词时继承歌词字体设置，否则用字幕自己的字体族/字重（不再提供系统字体选择） |
| 字幕 | 副字幕「内容模式」里的「罗马音」「罗马音 + 翻译」两个选项 | **插件不发罗马音数据**：`FoliaPlaybackExtension.lyricsJson()` 每行只写 `main` / `sub` / `cells`（主文本、译文、逐字），没有 `romanization`，所以 `Line.romanization` 永远缺省，`resolveLyricAlternateText` 取到的罗马音行必然为空。留着等于「选了看不见东西」，故只保留「翻译」与「不显示」 |
| 字幕 | 副字幕行数控件里每行的**「罗马音」选项** | 同一个原因（不发罗马音），两条选项列表里把它滤掉；store 侧 `sanitizeSubtitleOverlayLayout` 兜住另一半——上游 `withSubtitleOverlayRowCount` 在从一行加到三行时会**自动插入** `romanization` 行，只藏选项不够。老树里已经存着罗马音行组合的，读入时一并换成 `translation` / `next` |
| 字幕 | 显示和声字幕 / 和声字幕背景 | 插件不提供 harmony / 和声数据 |
| 背景 | 自定义图片/URL 背景（url 模式） | 插件只推内置背景模式（common/latent/monet/nomand/sora），自定义背景无上传能力 |
| 背景 | 自定义背景图源列表 | 同上 |
| 全局 | 预览文本（当前歌词/神文之诗/野芝麻） | 预览框改为真实播放页镜像（真实曲目/歌词/背景/透明状态），不再需要示例文本选择；整个选项与 `previewPlaceholderId` 字段一起移除 |
| 凝彩 | 图层图片（Tempera 图像图层）上传 | 无上传通道（页面沙箱无法读取本地文件） |
| 莫奈 | 人像来源「自定义」+ 人像图片上传 | 同上；保留「封面」来源 |
| 群唱 | 自定义头像来源、头像上传、表情包上传 | 同上；保留 封面/内置头像/色块 与内置表情包 |

**「显示播放条」不在上表里**：它仍然生效，但入口已经从 SPW 配置页**搬到播放页右下角菜单**
（与「播放页透明背景」「鼠标穿透」同一面板）。见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1.3。

## 3. 实现方式

被移除的项目在**构建期**从 Folia 上游组件中剥离：`poc/settings-ui/vite.config.ts` 的
`SETTINGS_SURGERY`（由 `foliaSettingsSurgery()` 插件执行）逐条标记替换，**标记找不到就构建失败**
—— 这是一道闸，上游改版后不会静默留下失效控件。Folia 仓库源码本身不被修改。

两处特殊情形：

- **自定义字体**的行在早期的 surgery 列表里被剥离，后来**不再剥离** —— 它现在是打开字体选择器的入口。
- **副字幕行数/内容**（0.7.25 起）曾经也是这么剥掉的（本页当时没有 `subtitleOverlayLayout` 这个设置，
  而面板把它当必填 prop，缺了会白屏）。**v0.4.19 起不再剥离**：状态补进了设置树，
  `App.tsx` 把 `subtitleOverlayLayout` 与 `onSubtitleOverlayLayoutChange` 一起传给面板，
  还随 config 下发到播放页。这是标准流程——**能补数据源的控件补回来，补不了的才剥**。
- **SPW 配置页的「帧率」**不在 Folia 上游组件里，而是本仓库 `preference_config.json` +
  Kotlin/宿主/Shim 自己的链路，所以是直接删代码，不涉及构建期剥离。

`verify-all.mjs` 的静态契约会断言「声明的开关都有读取方」「没有读取方处理页面上不存在的开关」
「每组指向独立 config 文件」「被移动的开关仍保留旧值迁移路径」—— 改配置页后跑它。

## 4. 旧设置值的归一化

- 已持久化的旧设置会被自动归一化：字幕内容 `romanization|both` → `translation`、背景 `url` → `latent`。
- **旧设置树的字幕行组合会从内容模式推导**：v0.4.18 及更早的树里没有 `subtitle.subtitleOverlayLayout`。
  首次读取时只对旧内容模式 `none` 做换算（`'current+next'` —— 那一版 `none` 的副字幕确实在预览下一句），
  其余一律取默认单行译文。**不从 `romanization` / `both` 推导**：这两个模式在加载时本来就被归一化成
  「翻译」，照它们推导反而会把已经删掉的罗马音行复活。换算函数是 `model/settings.ts` 的
  `resolveSubtitleOverlayLayout`，可被门禁脚本直接驱动。
- 字体族 `custom` **不再**被改写成 `sans`（自定义字体已真正可用）。
- 快照里的 `previewPlaceholderId` 被忽略（对应控件已移除）。
- **旧会话残留的限流值会被主动清掉**：插件不再读 `frameRate` 键，宿主不再注入任何 cap，而
  `Shim.js` 在每次文档创建时**删除**上游读的 localStorage 键 `visualizer_frame_rate`
  —— 否则旧值会让升级后的页面被永久静默限流，且用户看不见原因。清掉的原值随 `ready` 的
  `frameRateCleared` 上报，便于验证。
- **「详细日志」换组不丢值**：它从 `config.json` 移到 `diagnostics.json`，插件侧做旧值回退 +
  一次性迁移（详见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1.1）。
- **「显示播放条」迁移**：插件仍读旧的 `config.json` 值，但只以设置树顶层成员
  `showPlaybackBarLegacy` 下发，页面仅在树里还没有该键时用它播种一次，之后永远以树为准。
