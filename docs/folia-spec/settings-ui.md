# 歌词样式设置窗口

齿轮打开的就是 Folia 自己的「歌词样式」窗口：插件**复用上游的 React 组件**，用自建的状态树与配置发布器接上，
不是照截图重画。本文说明这个窗口现在长什么样、哪些控件可用、控件与设置树的对应关系，以及维护时要动哪里。

- 入口：`poc/settings-ui/src/App.tsx`（窗口总装）→ `~/model/Stage.tsx`（左栏）+ 上游
  `VisPlaygroundSettingsPanel`（右栏）
- 状态：`poc/settings-ui/src/model/settings.ts`（zustand，唯一设置真源）
- 发布：`poc/settings-ui/src/publisher/config.ts` → `pushConfig`（≤10Hz、去重）
- 桥：`poc/settings-ui/src/bridge.ts`；协议 §3–§4 见 [`protocol.md`](../protocol.md)
- 上游组件：`work/folia/folia-major-main/src/components/{shared/StudioWindow,visualizer/window/*,modal/settings/kit/*}`
- 视觉截图：[设置窗口](../images/settings-ui.jpg)、[17 种样式一览](../images/style-grid.png)

## 1. 窗口骨架

`StudioWindow`（上游原组件）负责框架，参数由本插件传入：

- 遮罩 `fixed inset-0 z-[140]`，背景 `backdrop-blur-xl` + 半透明黑；点遮罩关闭。
- 窗口 `w-[1240px] h-[780px] max-w-full max-h-full`，圆角 16px，`grid-rows-[64px_minmax(0,1fr)]`；
  头部 64px（返回按钮 + 标题「歌词样式」）；主体在 ≥1024px 时两栏 `[minmax(0,1fr)_420px]`，窄于 1024px 时
  上下堆叠、整页滚动。
- 色彩令牌由 `settingsTokens(isDaylight, theme)` 写在窗口根节点的 `style` 上，kit 组件只读 CSS 变量：

| 变量 | 暗色 | 用途 |
|---|---|---|
| `--st-win` / `--st-card` | `#1a1a1d` / `#232327` | 窗口底 / 卡片 |
| `--st-pv` | `#151517` | 预览格底 |
| `--st-ok` / `--st-warn` / `--st-err` | `#56c98d` / `#e3a949` / `#ef6f6f` | 状态色、警示点 |
| `--st-t1` / `--st-t2` / `--st-t3` | `--text-primary` / 62% / 42% | 三级文字 |
| `--st-line` / `--st-line2` | 8% / 16% | 分隔线 / 描边 |
| `--st-fill` / `--st-fill2` / `--st-track` | 7% / 12% / 17% | 填充 / hover / 滑轨 |
| `--st-accent` / `--st-on-accent` | 取自 `theme.accentColor`（缺省暗 `#f4f4f5`） | 选中环、开关、下划线 |

**`--text-primary` 必须由外部定义**（`App.tsx` 在设置遮罩根节点上设成 `PREVIEW_THEME.primaryColor`），
否则 kit 里所有 `color-mix` 都会失效。本窗口固定暗色（`IS_DAYLIGHT = false`）。

## 2. 左栏：大预览 + 样式货架

`~/model/Stage.tsx`：

- **大预览**：`LivePreview`（同源 iframe 跑 Folia 的真实渲染器）优先，4s 内没 ready 就降级成 `StylePreview`
  （构建时采集的真实帧 + Ken Burns 漂移）。右上角 32px 圆形按钮暂停/继续；透明背景开启时左下角有状态角标。
  尺寸与消息契约见 [`live-preview-iframe.md`](../live-preview-iframe.md)。
- **样式货架**：标题「样式」+ 计数 17（`STYLE_COUNT`，不含随机格），`PictureGrid` 宽窗 7 列 / 窄窗 4 列，
  `maxHeight = 250`，最后一个格子是「随机」。每格画面是上游 `LyricStylePicture` 现画（受「歌词样式预览动画」
  开关控制，见 [`style-map.md`](style-map.md) §4）。
- 选「随机」打开随机池；选具体样式会关掉随机池（`randomVisualizerModePerSong`）。

## 3. 右栏四个 tab

`VisPlaygroundSettingsPanel` 提供 tab 与内容，本插件的 `SettingsSection` 是
`'visualizer' | 'background' | 'common' | 'subtitle'`，默认 `'visualizer'`。上游 0.7.25 还有一个「全局」tab
（智能动感模式），**已被构建期裁剪**，见 §3.1。

tab 顺序与文案（`zh-CN.ts`）：**歌词动画** / **背景** / **字体** / **字幕**；右端是「默认」按钮。

### 3.1 构建期裁剪（`vite.config.ts` 的 `SETTINGS_SURGERY`）

注入页拿不到的东西不显示成死开关：`vite build` 会在 `pre` 阶段对上游面板做定点替换，**每条替换都做标记校验**，
上游改了源码导致标记失配时构建**直接报错并指名**，不会静默留下死控件。

| 被移除 | 原因 |
|---|---|
| 「全局」tab + 智能动感模式卡 + 动感效果组 | 注入页没有节拍分析模型，宿主也不发节拍事件 |
| 和声字幕组 | 插件不提供 TTML 和声数据 |
| 副字幕内容里的「罗马音」「罗马音 + 翻译」 | 插件只发译文 |
| 副字幕行数/内容控件（0.7.25 新增，需要 `subtitleOverlayLayout`） | 本页没有这个设置，且其 `getSubtitleOverlayRows` 无默认值会抛错并白屏 |
| 「预览文本」行（神文之诗 / 野芝麻） | 大预览改成播放页镜像后没有意义 |
| 凝彩图层图片组、莫奈人像上传、群唱自定义头像/表情上传 | 没有本地文件服务与资产存储 |
| 背景类型里的 `url`（嵌入） | 插件不提供自定义背景图 |

字体 tab 的「自定义字体」**保留**（v0.4.0 起是真的可用：导入字体包或选系统字体）。

### 3.2 歌词动画 tab

`key={visualizerMode}` 包裹，顺序：

1. 当前样式的 `renderSettingsPanel(...)`（16 个样式有面板，心象与静止没有）；
2. 都没有时显示「这个样式没有参数」。

面板收到的 props 是 `VisualizerSettingsPanelProps`：`{t, isDaylight, theme, controlCardBg, rangeInputClass,
tuning, onTuningChange, settings, onSliderPointerDown, onSliderCommit}`。拖动滑块时只改草稿，松手才落盘。
各样式字段与默认值见 [`tunings.md`](tunings.md)。

### 3.3 背景 tab

`PictureGrid columns={3}` 列出注册表里的背景（`common` 通用 / `latent` 隐现 / `monet` 莫奈 / `nomand` 漫游 /
`sora` 空；`url` 被过滤），下面是选中背景自己的设置面板。槽位形状与 tuning 见
[`style-map.md`](style-map.md) §5 与 [`tunings.md`](tunings.md) §3。

### 3.4 字体 tab

单卡片，行顺序：

| 行 | 控件 | 默认 | 说明 |
|---|---|---|---|
| 样式字号自动提示 | Row notice | — | 仅当样式声明 `ownFontSizeNoticeKey`（sonnet/tempera/lumiere/hanabi/machi），同时**禁用字号行** |
| 字体 | 四个磁贴（无衬线 / 衬线 / 等宽 / 自定义） | 无衬线 | 选「自定义」打开字体选择器（导入字体包 / 系统字体） |
| 当前字体 | 值 + 按钮 | — | 自定义时才出现 |
| 字号 | 滑块 | 1 | 0.85–1.4，step 0.05，按百分比显示 |
| 自动字重 | 开关 | 开（`fontWeight === null`） | 关掉后出现字重滑块 100–900 / 10 |
| 整体透明度 | 滑块 | 1 | 0.2–1，step 0.05 |

存储字段：`appearance.{fontStyle, fontScale, fontWeight, customFontFamily, customFontSource, customFontStack,
visualizerOpacity}` 与 `uploadedFonts[]`。字体文件本身不进设置树（在 IndexedDB），系统字体列表由插件以只读
注入成员 `systemFonts` 下发。字体栈与 `@font-face` 事实见 [`style-map.md`](style-map.md) §6。

### 3.5 字幕 tab

| 行 | 控件 | 默认 |
|---|---|---|
| 隐藏底部字幕层 | 开关 | false |
| 副字幕内容 | 选择（翻译 / 不显示） | 翻译 |
| 字幕透明度 | 滑块 0.2–1 | 0.6 |
| 字幕背景 | 开关 | true |
| 非翻译歌词添加模糊效果 | 开关 | true |
| 字幕继承歌词字体 | 开关 | true |
| 字幕字体 / 自动字重 / 字重 | 选择 + 滑块 | 继承时隐藏；字重默认自动（`null`） |
| 字幕缩放 | 滑块 0.85–1.4 | 1 |

字幕渲染侧的契约（字号公式、次级行 0.88、字号唯一来源）见 [`runtime-contracts.md`](runtime-contracts.md) §8。

## 4. 「默认」按钮

窗口头部只有一个「默认」按钮，**只作用于当前 tab**；当前 tab 没有可重置项时按钮置灰（`disabled={!resetOpenTab}`）：

| tab | 何时可点 | 行为 |
|---|---|---|
| 歌词动画（随机池关闭） | 当前样式有设置面板 | 写回该样式的 `DEFAULT_*_TUNING` 并丢弃该样式的草稿 |
| 歌词动画（随机池打开） | 还有样式没被勾上 | 全选 17 种样式 |
| 背景 | 当前背景声明了 `resetSettings` | 重置背景 tuning |
| 字体 | 恒可 | 字号→1、字重→自动、整体透明度→1、字体→无衬线、清掉自定义字体 |
| 字幕 | 恒可 | 字幕透明度→0.6、缩放→1、隐藏→false、内容→翻译、行组合→默认、背景→true、模糊→true、继承字体→true |

重置前会先丢弃该 tab 上正在拖动的草稿（`gate.forget(...)` / `withoutDraft`），否则松手后的提交会把刚写回的默认值
再覆盖掉一次。

## 5. 状态、持久化与下发

- **唯一真源是页面里的 zustand store**（`model/settings.ts`）：字段名与默认值对齐 Folia 自己的设置 store，
  这样复用的面板拿到期望的形状。快照类型是 `SettingsSnapshot`（`version: 1` + `styleId` / `randomVisualizerModePerSong` /
  `randomVisualizerModes` / `smartBeat` / `styleTunings` / `backgroundMode` / `backgroundTunings` /
  `commonBackground` / `appearance` / `uploadedFonts` / `subtitle` / `lyricMotion` / `textureResolution` /
  `transparentPlayerBackground` / `mousePassthrough` / `showPlaybackBar`）。
- 改动 → 页面 emit → 插件持久化整棵树（插件**不解释** JSON，原样存 `settingsJson`）；启动时插件把树发回来，
  `applySnapshot` 做 defaults-first 合并。
- 页面同时把设置编译成 Folia 的 `ObsBrowserSourceConfig` 并 `pushConfig`（`publisher/config.ts`），
  节流 100ms、内容签名不变就不发。播放页收到 config 才换样式/背景/字体。
- **插件拥有的开关不属于这棵树**：`showProblemButton`、`previewAnimation`、`systemFonts` 由插件写、页面只读，
  不回写不持久化（`model/useInjectedSwitch.ts`、`model/useSystemFonts.ts`）。
- 兼容旧树：`applySnapshot` 对缺失键保留默认；`showPlaybackBar` 缺失时从插件的旧注入成员
  `showPlaybackBarLegacy` 播种一次。

## 6. 加控件 / 改控件时

- 改样式专属参数 → 改上游面板并确认 `tunings.md` 的默认值还对不对；插件的 `STYLE_TUNING_DEFAULTS` 是 import 的，
  不需要同步，但 `model/settings.ts` 的 `StyleMode` 联合、`STYLE_TUNING_KEYS`、`STYLE_MODE_SHELF_ORDER` 要跟着上游。
- 改通用设置 → 三个地方一起看：`model/settings.ts`（`SettingsSnapshot` 字段）、`publisher/config.ts`
  （编译成 config 字段）、`docs/protocol.md`（如果跨进程形状变了）。
- 加/删上游控件 → 若注入页无法提供它的数据源，加一条 `SETTINGS_SURGERY` 并把原因写进 §3.1 的表；
  **不要**用 `display:none` 藏控件（它仍占位、仍拿点击、仍报命中区）。
- 上游换版本时的完整清单见 [`upstream-sync.md`](../upstream-sync.md)。
