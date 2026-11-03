# 设置页控件与生效情况（更新至 v0.4.13，未发布）

本文档记录设置页中每个控件在**当前开发版本 v0.4.13** 的实际生效情况
（最后**发布**版本是 v0.4.6，所以线上用户看到的是 v0.4.6 的口径；v0.4.6 之后的条目
—— v0.4.6.1/v0.4.7/v0.4.8/v0.4.9/v0.4.10/v0.4.11 —— 都只在本地测试过，尚未发布）。
原则：**无法生效的控件不再展示**，不再保留「有开关但永远不产生效果」的 UI（用户需求 m02706 / m03207）。

本文覆盖两处界面，别混：

- **`歌词样式` 设置页**（Folia 原组件，注入覆盖层内）——Folia 的设置树，受上游能力限制。
- **SPW 配置页**（`spw-folia/src/main/resources/preference_config.json`）——插件自己的**六个**入口
  （v0.4.11 重新分组后，按「播放页 4 项 / 诊断与日志 1 项 / 支持与反馈 1 项」三组摆放；
  v0.4.16 在播放页组新增「歌词样式预览动画」），
  见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1。

v0.4.0 与 v0.1.3 的区别集中在两处：**自定义字体重新回归**（可导入字体包或选择系统字体），
以及**随机歌词样式池**与**花火样式**随 Folia 0.7.22 上游一起接入。

## v0.4.0 恢复的控件

| 位置 | 控件 | 说明 |
| --- | --- | --- |
| 字体 | 自定义字体（磁贴 + 导入字体包 + 系统字体列表） | 用户导入的字体包经 `FontFace` 注册进注入页并持久化到 IndexedDB（单个 ≤ 50 MB，支持 `.ttf/.otf/.woff/.woff2`）；系统字体列表由插件 Kotlin 侧用 AWT 枚举，随设置树以 `systemFonts` 字段下发（不落盘）。选中的字体写入 `theme.fontFamily` / `theme.fontFamilyStack` 与配置的 `lyricsCustomFontFamily` / `lyricsFontFallbackFamilies`。 |
| 字体 | 字重（自定义字体相关项） | 与自定义字体同组恢复，写入 `theme.fontWeight`。 |
| 歌词动画 | 花火（第 15 种歌词样式） | Folia 0.7.22 上游样式：逐字色块、烟花沿字开花、镜头升降旋转、副歌辉光；注册在 绘光(25) 与 流光(30) 之间的 order 26。设置面板复用上游 `HanabiSettingsPanel`。 |
| 歌词动画 | 随机歌词样式（随机池 + 每首一首 + 播放面板重抽） | 勾选的样式组成随机池，每换一首歌抽一种且不与上一首相同；播放面板骰子按钮可对当前歌曲重抽；随机池随导入导出与同步一起走（`SettingsSnapshot` 字段 `randomVisualizerModes` / `randomVisualizerModePerSong`）。 |

## 仍然移除的控件（没有数据来源或没有实现）

| 位置 | 控件 | 移除版本 | 原因 |
| --- | --- | --- | --- |
| SPW 配置页 | 帧率（`key: frameRate`，`type: "list"`，四档 off/120/90/60） | **v0.4.10** | **上游限流算法达不到标称值**：`frameRateLimiter.ts` 的 `-1 ms` 容差让每个档位都退到下一档，120 Hz 屏上选 90 实际只有 60（144 Hz 屏上 120 档只有 72）。默认档 `off` 本来就等于「跟随屏幕刷新率」，不需要这个下拉；留一个「选了也不准」的选项违背本文原则，于是**整条链路删除**（配置项 + Kotlin 读取 + 宿主 cap 注入 + Shim 写 localStorage；旧值由 Shim 主动清除）。技术分析见 [`docs/upstream-sync.md`](upstream-sync.md) §10.2，变更记录见 [`docs/release-notes-v0.4.10.md`](release-notes-v0.4.10.md)。 |
| 歌词动画 | 智能动感模式（开关） | v0.1.2 | Folia 节拍检测模型（beat_this / htdemucs，WebGPU）不在 WebView bundle 中，也没有节拍事件流。**花火的随拍开花 / 推镜依赖它，因此在注入页里保持静默**（样式本身的动画不受影响）。 |
| 歌词动画 | 动感效果：推镜裂光、涟漪（开关 + 强度） | v0.1.3 | 效果由 `beatImpact` / `downbeatImpact` 驱动；无节拍数据时永不触发。 |
| 字幕 | 字幕字体族/字重/系统字体（非跟随歌词分支） | v0.1.3 | 已改为映射：字幕字体跟随歌词时继承歌词字体设置，否则使用字幕自己的字体族/字重（不再提供系统字体选择）。 |
| 字幕 | 罗马音模式（及相关内容模式选项） | v0.1.3 | 插件不提供罗马音数据；内容模式固定为「翻译」。 |
| 字幕 | 显示和声字幕 / 和声字幕背景 | v0.1.3 | 插件不提供 harmony/和声数据。 |
| 背景 | 自定义图片/URL 背景（url 模式） | v0.1.3 | 插件只推送内置背景模式（common/latent/monet/nomand/sora）；自定义背景无上传能力。 |
| 背景 | 自定义背景图源列表 | v0.1.3 | 同上。 |
| 全局 | 预览文本（当前歌词/神文之诗/野芝麻） | v0.4.1 | 预览框改为真实播放页镜像（真实曲目/歌词/背景/透明状态），不再需要示例文本选择；整个选项与 `previewPlaceholderId` 字段一起移除。 |
| 凝彩 | 图层图片（Tempera 图像图层）上传 | v0.1.3 | 无上传通道（页面沙箱无法读取本地文件）。 |
| 莫奈 | 人像来源「自定义」+ 人像图片上传 | v0.1.3 | 同上；保留 封面 来源。 |
| 群唱 | 自定义头像来源、头像上传、表情包上传 | v0.1.3 | 同上；保留 封面/内置头像/色块 与内置表情包。 |

## 仍然生效的控件（已逐项验证）

> **v0.4.13 修复：v0.4.12 曾经三个开关全部失效。** 根因是插件↔辅助进程的协议是**行协议**
> （插件 `write(line + "\n")`，宿主 `ReadLine()`），而设置树被**原样内嵌**进
> `{"t":"settings","settings":<tree>}`。内置的 `default-settings.json` 是美化格式
> （7188 字节 / 268 个换行），一条推送因此被拆成几百条非法片段全部丢弃 —— 页面收不到
> `showPlaybackBar` / `showProblemButton`，看起来就是「三个开关全都不生效」。
> 修复：`Json.singleLine()` 在发送前把树压成单行（字符串字面量内容逐字节保留），并且在
> `ready` 时重发一次（首次推送早于 WebView2 就绪会被宿主丢弃）。
> 回归：`packaging/tools/verify-json-singleline.mjs`、`verify-playback-switches.mjs`、
> `verify-live-settings-payload.mjs`。

| 位置 | 控件 | 说明 |
| --- | --- | --- |
| **SPW 配置页** | **打开过渡动画（`key: transitionAnimation`，`default_value: false`）** | **生效**。插件读 config → `bridge.curtainEnabled` → 宿主的 `--no-curtain`（关闭时）决定导航 URL 的 `splash` 参数；v0.4.13 起该标志在每次开关变更时重新赋值，不再只在启动时读一次。**下一次打开 Folia 生效**（spawn 期参数）。 |
| **SPW 配置页** | **详细日志（`key: verboseLog`，`default_value: false`）** | **生效**。落在 `diagnostics.json`，控制宿主是否带 `--verbose-log`；同样在下一次打开 Folia 生效，v0.4.13 起变更即同步到 bridge。 |
| **SPW 配置页** | **显示播放条（`key: showPlaybackBar`，`default_value: true`，v0.4.10 新增）** | **生效**。链路：插件读 config → `FoliaPlugin.withInjectedMembers()` 以设置树顶层布尔下发 → 页面 `useShowPlaybackBar()`（`src/model/useInjectedSwitch.ts`）读 `getSettings()` 初值并监听 `settings` 事件热更新 → 为 `false` 时底部播放控制条（`chrome/playback/PlaybackBar.tsx`，时间轴/播放暂停/上下首/随机/播放列表）**整个不挂载**，连热区一起消失。关掉后重开窗口仍然生效（配置持久化在 SPW 侧，不是页面临时状态）。v0.4.13 真机验证：改动后 ≤1 s 内插件捕获并推送，无需重开窗口。 |
| **SPW 配置页** | **显示问题反馈按钮（`key: showProblemButton`，`default_value: false`，v0.4.11 新增）** | **生效**。控制播放页**右上角的救生圈按钮**（`data-spw-chrome="problem-report"`，`LifeBuoy` 图标）及其诊断面板，链路与 `showPlaybackBar` 完全同构。**默认关**（它会遮挡画面右上角）。关闭时按钮**不渲染**——React 根本不挂载，不是 CSS 隐藏，因此也不上报 hit region（鼠标穿透下不会留点不到的死区）；同时该按钮的键盘/面板联动一并关掉：按钮不在时不监听它的 ESC，面板若开着也随开关关掉。**逃生口仍在**：配置页「支持与反馈 → 出现问题」按钮不依赖播放窗口，播放窗口打不开时照样能用——这正是它存在的理由。 |
| **SPW 配置页** | **歌词样式预览动画（`key: previewAnimation`，`default_value: true`，v0.4.16 新增）** | **生效**。控制「歌词样式」货架上 17 格小图是实时渲染还是简约图案，链路与 `showPlaybackBar` 完全同构（`usePreviewAnimation()`）。**关**时货架换成 `ShelfStatic`，通过 `React.lazy` 在**模块加载层面**断开渲染器链——真机 resource entries 匹配 `Visualizer`/`ShelfLiveView` 的条目数为 **0**（不是「画了不显示」），大预览/各 tab/滑块不受影响，hover 也不会把渲染器拉回来。开关开着时，第一次画完的小图会缓存到 IndexedDB（`spw-folia-preview`），重启窗口后 **23.0 s → 0.37 s**。热切换双向即时生效。详见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1.3。 |
| 歌词动画 | 纹理分辨率、镜头运动强度、文字动势、背景短线密度、外围边框等样式参数 | 通过 `visualizerTunings` 传给渲染器。 |
| 歌词动画 | 各样式专属参数（商籁/凝彩/绘光/花火/…/静止） | 同上；只保留可渲染的项。 |
| 歌词动画 | 歌词样式磁贴（15 种 + 随机） | 写入 `visualizerMode`；随机磁贴打开随机池，手选样式则关闭随机（与上游 `preserveRandom` 语义一致）。 |
| 字体 | 字体族（无衬线/衬线/等宽/自定义）、字号、自动字重、整体透明度 | 字体族/字重写入 `theme.fontStyle` / `theme.fontWeight`（自定义时另写 `fontFamily` / `fontFamilyStack`），渲染器实际读取。前三档（无衬线/衬线/等宽）的宿主验证见 `docs/archive/verification-v0.1.3.md`；「自定义」这一支是 v0.4.0 新增，目前只有构建验证，真机验收待发布前完成。 |
| 字幕 | 隐藏翻译字幕、字幕内容模式（翻译）、字幕不透明度、字幕背景、即将歌词模糊、字幕字号 | 映射到 `subtitleOverlay*` / `showSubtitleTranslation` / `subtitleContentMode` / `subtitleFontScale`。 |
| 字幕 | 字幕字体跟随歌词、字幕字体族、字幕字重 | 映射到 `subtitleTheme`（跟随歌词时继承歌词主题字体，含自定义字体）。 |
| 背景 | 内置背景模式（隐现/光晕/莫奈/等）与背景参数 | 通过 `background` 配置传给渲染器。 |
| 全局 | 默认/重置 | 重置为 Folia 默认值（v0.4.1 起不再重置预览文本，因为该选项已移除）。 |
| 主题 | 封面取色（自动） | 由封面派生主题/背景/强调色（v0.1.2 修复）。 |

## 说明

- 被移除的项目在构建期从 Folia 上游组件中剥离（`poc/settings-ui/vite.config.ts` 的
  `foliaSettingsSurgery`，找不到对应标记会构建失败），不会修改 Folia 仓库源码。
  自定义字体那一行在 v0.4.0 起**不再剥离**——它现在是打开字体选择器的入口。
  **SPW 配置页的「帧率」是另一种情形**：它不在 Folia 上游组件里，而是本仓库
  `preference_config.json` + Kotlin/宿主/Shim 自己的链路，所以 v0.4.10 是直接删代码，不涉及构建期剥离。
- 已持久化的旧设置会被自动归一化：字幕内容 `romanization|both`→`translation`、背景 `url`→`latent`。
  v0.4.0 起字体族 `custom` **不再**被改写成 `sans`。v0.4.1 起快照里的 `previewPlaceholderId` 被忽略。
- v0.4.10 删除帧率项后，**旧会话残留的限流值会被主动清掉**：插件不再读 `frameRate` 键，宿主不再注入
  任何 cap，而 `Shim.js` 会在每次文档创建时删除上游读的那个 localStorage 键
  `visualizer_frame_rate`（否则旧值会让升级后的页面被永久静默限流，且用户看不见原因）。清掉的原值
  随 `ready` 消息的 `frameRateCleared` 上报，便于验证。宿主仍**接受并忽略**旧的 `--frame-rate`
  参数，只是为了让带旧参数的插件包还能正常 spawn。
- **v0.4.11 重新分组不影响用户已保存的设置**：配置页从两大组改成三组（播放页 / 诊断与日志 / 支持与
  反馈），「详细日志」随组从 `config.json` 移到新文件 `diagnostics.json`。因为 `ConfigManager` 按
  config 文件分别存取，插件侧加了**旧值回退 + 一次性迁移**：新文件没有该键时回退读 `config.json`
  的旧值，读到就立刻写进新文件（日志留 `config migrated verboseLog=…`）。**升级后详细日志设置不会丢**，
  详见 [`docs/settings-ui-impl.md`](settings-ui-impl.md) §4.1.1。
