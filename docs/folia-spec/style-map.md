# 歌词样式、背景与素材

插件播放的画面是 **Folia 自己的 17 种歌词样式**，不是按截图重画的：上游 `src/components/visualizer/registry.tsx`
用 `import.meta.glob('./*/entry.tsx')` 发现成员，按每个 `entry.tsx` 的 `order` 升序排成设置页的样式货架。
本文是这张清单的权威对照表，以及样式注册、背景、字体、随包素材的维护要点。

- 上游源码：`work/folia/folia-major-main`（Folia **0.7.26**，AGPL-3.0，只读副本）
- 插件侧清单：`poc/settings-ui/src/model/styles.tsx`（样式壳）与 `src/model/settings.ts` 的 `STYLE_MODE_SHELF_ORDER`
- 同步闸门：`poc/settings-ui/scripts/check-style-sync.mjs`（挂在 `vite build` 上，上游加样式时构建会拦）

## 1. 17 种样式（货架顺序 = `order` 升序）

| # | 中文名 | mode id（= 目录名） | order | 渲染技术 | tuning 存储键 | 额外声明 |
|---|--------|--------------------|-------|----------|---------------|----------|
| 1 | 商籁 | `sonnet` | 10 | pixi.js（WebGL）+ pretext 排版 | `sonnet_tuning` | 分词、自算字号、动感效果（节拍） |
| 2 | 凝彩 | `tempera` | 20 | pixi.js（WebGL）+ pretext | `tempera_tuning` | 分词、自算字号、图片图层（IndexedDB）、动感效果（鼓点） |
| 3 | 绘光 | `lumiere` | 25 | pixi.js（WebGL） | `lumiere_tuning` | 分词、自算字号 |
| 4 | 花火 | `hanabi` | 26 | pixi.js（WebGL） | `hanabi_tuning` | 自算字号、两个动感效果（节拍） |
| 5 | 町景 | `machi` | 27 | three.js | `machi_tuning` | 自算字号、**不画共享背景**、三个动感效果（节拍/鼓点） |
| 6 | 雾笺 | `nebbia` | 29 | 自写 WebGL2 + Canvas2D | `nebbia_tuning` | 分词、**窗外可选共享背景**（0.7.26 起，见 §1 补充）、两个动感效果（人声/鼓 stem、节拍）、着色器预热 |
| 7 | 流光 | `classic` | 30 | DOM + framer-motion | `classic_tuning` | 分词、`GlowWord` 逐词发光 |
| 8 | 心象 | `cadenza` | 40 | DOM + Canvas2D + pretext | `cadenza_tuning` | 只有「渲染」设置面板（0.7.26 新增，分辨率一行，无抗锯齿） |
| 9 | 云阶 | `partita` | 50 | DOM + framer-motion + pretext（列/chunk 布局，字复用 `GlowWord`） | `partita_tuning` | 分词 |
| 10 | 浮名 | `fume` | 60 | Canvas2D + pretext | `fume_tuning` | **覆盖背景**（关掉几何图形）、`previewStartOffset` 18.4 |
| 11 | 倾诉 | `tilt` | 70 | DOM + framer-motion + pretext | `tilt_tuning` | — |
| 12 | 回环 | `claddagh` | 80 | DOM（绝对定位的 glyph span，逐帧写 style）+ framer-motion + pretext | `claddagh_tuning` | — |
| 13 | 莫奈 | `monet` | 90 | Canvas2D + Web Worker + pretext | `monet_tuning` | 点歌词行跳转、唯一画混音交接（`followsSongHandoff`） |
| 14 | 时计 | `pendolo` | 100 | WebGL2 表盘（Canvas2D 回退）+ pretext | `pendolo_tuning` | 点歌词行跳转、动感效果（鼓点；另一个已停用） |
| 15 | 群唱 | `cappella` | 110 | DOM + framer-motion + pretext | `cappella_tuning` | 头像/表情 PNG（内置 + 自定义包头） |
| 16 | 镜台 | `diorama` | 120 | three.js | `diorama_tuning` | 动感效果（节拍） |
| 17 | 静止 | `still` | 130 | 纯 DOM | 无 `tuning.ts` | **`background: false`** |

补充事实：

- 权威 id 清单位于上游 `src/types/visualizerModes.ts` 的 `BUILTIN_VISUALIZER_MODES`；registry 初始化时断言它与
  `import.meta.glob` 发现的目录逐字相等，漏项当场抛错。默认样式 `DEFAULT_VISUALIZER_MODE = 'classic'`。
- 显示名一律取 `zh-CN.ts` 的 `ui.visualizer*`（`visualizerSonnet`…`visualizerStill`）。`labelFallback` 只有
  sonnet / lumiere / partita / diorama / hanabi / machi / nebbia 是中文，其余是英文名，**不能拿 fallback 当中文名**。
- 心象的 labelKey 拼写是 `ui.visualizerCadenze`（少一个 z），id 仍是 `cadenza`；旧版本存过 `cadenze_tuning`，
  该键由 `cadenza/tuning.ts` 的 `olderKeys` 兜底读取。
- 第 16 个中文名是 **镜台**（`diorama`），不是「铭台」：`zh-CN.ts` 的 `visualizerDiorama`、`dioramaReset`、
  `entry.tsx` 的 `labelFallback` 均为镜台，全仓库检索不到「铭台」。
- 每个样式必有 `previewSeed`（= 自身 id）与 `previewStartOffset`（除浮名 18.4 外都是 0），预览画的就是真渲染器。
- 分词样式（`usesWordSegmentation: true`）：sonnet / tempera / lumiere / classic / partita / nebbia。它们把整行分词
  当布局原子，用户保存的分词会影响画面。
- 自算字号的样式（`ownFontSizeNoticeKey`）：sonnet / tempera / lumiere / hanabi / machi。字体页的字号滑块对它们
  禁用，并显示对应提示。

## 2. 注册契约（加样式 / 改样式时看这里）

每个 `entry.tsx` 导出一个 `defineVisualizer({...})`（类型 `VisualizerRegistryEntry`，见上游
`src/components/visualizer/definition.ts`）：

| 字段 | 作用 |
|------|------|
| `mode` `order` `labelKey` `labelFallback` | 货架顺序与显示名 |
| `previewSeed` `previewStartOffset` | 小图/大预览画哪一帧 |
| `glyph` `command` | 24×24 线性图标；命令面板条目（id `visualizer-<mode>`） |
| `render` | **必须** `React.lazy(() => import('./Visualizer'))` 包装。registry 用 eager glob 发现 entry，entry 若静态 import 渲染器，任何碰设置的模块都会连带拉进全部渲染器（含 three.js） |
| `background` | `false` = 不画共享背景（现在只有静止、町景）；**函数** = 按运行时条件覆盖背景配置（雾笺 0.7.26 起走这条路：窗外选「共用背景」或播放页透明时才画共用背景，自己画街景时标成透明；浮名则是关掉几何图形） |
| `renderSettingsPanel` `renderQuickControls` | 设置页的样式面板 / 播放面板的快捷参数；**只有「静止」没有面板**（心象 0.7.26 起有了） |
| `seeksOnLineClick` | 点歌词行跳转（莫奈、时计） |
| `followsSongHandoff` | 画 automix 混音交接（只有莫奈） |
| `ownFontSizeNoticeKey` `usesWordSegmentation` | 见上节 |
| `beatEffects` | 智能动感效果声明，见 §3 |
| `prewarm` `prewarmWhenIdle` | 启动时提前做的活（雾笺的着色器编译） |

货架顺序在插件侧存两份：`styles.tsx` 的 `STYLE_ENTRIES`（mode + order）和 `settings.ts` 的
`STYLE_MODE_SHELF_ORDER`（随机池与归一化用）。两份在模块加载时比对，不一致直接抛错；再往前的上游一致性由
`check-style-sync.mjs` 按上游 `entry.tsx` 与 `tuning.ts` 校验，`--write` 只自动补纯 id 列表（`vite.config.ts`
的 `STYLE_MODES`、`make-thumbs.mjs` 的 `MODES`、`Overlay.js` 的 `MODES`），`styles.tsx` / `settings.ts` /
`transparencyCompat.ts` 需要人判断。

## 3. 动感效果（智能动感模式）

效果声明在样式的 entry 上，由 `src/services/beatFx/beatEffects.ts` 注册。每个效果读一种来源，来源决定该曲目
要跑哪个模型（`beatClockTargets.ts`）：`beats` → beat_this 节拍表，`drums` / `stems` → HTDemucs 鼓声（及人声包络）。

| effect id | 名称 | 来源 | 所属样式 | 状态 |
|-----------|------|------|----------|------|
| `sonnet.lensTear` | 推镜裂光 | beats | 商籁 | 可用 |
| `tempera.inkFlash` | 墨染奥行 | drums | 凝彩 | 可用（0.7.25 新增） |
| `hanabi.beatBursts` | 随拍开花 | beats | 花火 | 可用 |
| `hanabi.beatPulse` | 随拍推镜 | beats | 花火 | 可用 |
| `machi.neonPulse` | 霓虹随拍 | beats | 町景 | 可用 |
| `machi.drumRipple` | 鼓点涟漪 | drums | 町景 | 可用 |
| `machi.screenFlash` | 大屏闪拍 | drums | 町景 | 可用 |
| `nebbia.drizzleRide` | 疏雨轻车 | stems | 雾笺 | 可用（两段强度：雨点 / 颠簸） |
| `nebbia.aquaBeat` | 舞潮踏拍 | beats | 雾笺 | 可用（0.7.26 新增，四段：水母 / 水草 / 气泡 / 聚光灯；只在窗外选水族箱时计数） |
| `pendolo.drumhead` | 仿真鼓面 | drums | 时计 | 可用 |
| `diorama.ripple` | 水镜涟漪 | beats | 镜台 | 可用 |
| `pendolo.gearBeats` | 齿轮随拍 | beats | 时计 | 已停用（`retired`，代码保留，界面不显示） |
| `latent.pulse` | 潮汐脉动 | beats | 隐现背景 | 已停用 |

页面上**没有**开这些效果的路径：插件裁剪掉了上游的「智能动感模式」卡和「动感效果」组（见
[`settings-ui.md`](settings-ui.md) §3.1），`config` 里也不带节拍数据，所以效果不会触发；样式本身的动画
（逐字、镜头、转场）不受影响。这属于当前实现的选择，不是上游能力缺失。

## 4. 样式货架与大预览

- 货架 = 17 个样式 + 最后一个「随机」格，共 18 格；宽窗 `SHELF_COLUMNS.wide = 7` 列（7/7/4 三行），窄窗 4 列。
  标题「样式」右侧的计数在本插件里是 `STYLE_COUNT = 17`（不含随机格）；上游那版用 `modeOptions.length`，
  含随机格。
- 选「随机」等于打开随机池（`randomVisualizerModePerSong`）；随机池默认包含全部 17 种，每首歌抽一种且不与当前
  样式重复，播放条上的骰子按钮可对当前歌曲重抽（`pickRandomMode` / `normalizeRandomModes`）。
- 每格小图是**真渲染器现画**：`preview/LyricStylePicture.tsx` 用该样式的 renderer 画一帧冻结画面，没有静态图片
  资源。插件把它挂在「歌词样式预览动画」开关上：开 = 上游那套「造图 → 静态 → hover 才跑」；关 =
  `modeGlyphs` 的线性图案，且**不加载任何样式渲染器 chunk**（`ShelfLive.tsx` 用 `React.lazy` 做模块级断链）。
- 小图有二级磁盘缓存（`model/previewImageCache.ts`，IndexedDB），键复用上游 `stylePictureKey` 的纯数据部分；
  上传图在场时缓存整体关闭。命中后把静态片段塞回上游的页内 Map，`LivePicture` 便不造图、不拉 chunk。
- 左侧大预览是**播放页的逐帧镜像**：同源 iframe（`preview.html`）跑 Folia 自己的 OBS 页面 + 预览垫片，父页把
  宿主真实 clock/audio 和播放页实际收到的 `config` 转发进去，按 1920×1080 排版再以 1.15 缩放裁切。契约见
  [`live-preview-iframe.md`](../live-preview-iframe.md)。
- 降级路径：iframe 4s 内没 ready → `StylePreview`，用构建时采集的 17 张真实渲染帧（`thumbs/<mode>.jpg`，16:10）
  做 Ken Burns 漂移。**这批 jpg 只是降级素材，不是货架图**；它们是构建输入 `poc/settings-ui/public/thumbs/`
  （gitignore），由 `node scripts/make-thumbs.mjs` 驱动真实宿主逐样式截图生成，缺图时 `vite build` 与
  `packaging/tools/stage-web.mjs` 都会直接报错。

## 5. 背景系统（与样式解耦）

背景由 `VisualizerBackdrop` 在所有样式**外层**画一次，切样式时不重画。6 个 mode：

| mode | 中文名 | 说明 |
|------|--------|------|
| `common` | 通用 | 纯色/几何；`{opacity, useCoverColorBg, disableVignette, disableGeometricBackground}` |
| `latent` | 隐现 | **默认**（`DEFAULT_VISUALIZER_BACKGROUND_MODE`）；封面抖动/网格，有 tuning |
| `monet` | 莫奈 | 封面 → 印象派色块，有 tuning |
| `nomand` | 漫游 | 抖动/毛玻璃/纸纹/半调等效果，有 tuning |
| `sora` | 空 | 空白项，有 tuning（`blank`） |
| `url` | 嵌入 | 用户图列表（`{items, selectedId}`），**本插件不提供**（设置页过滤掉该模式，config 里为空列表） |

- `config.background` 形状：`{mode, transparent?, common?, url?, <每个背景 tuning 槽>}`；`transparent: true` 表示
  播放页透明（宿主色键），Folia 的背景渲染器见到它直接返回 null。
- 背景 tuning 存在 `backgrounds/<mode>/tuning.ts`，以 `{ tuning }` 槽随 config 下发；`url` 模式没有 tuning，
  它的设置在 `backgrounds/url/settings.ts`。
- 样式可以覆盖背景：浮名传 `fumeBackgroundConfig`（关几何图形），静止传 `false`，町景/雾笺自绘场景不画背景。
- 背景渲染的输入是 `VisualizerBackgroundRenderProps`：`{config, theme, isDaylight, coverUrl, audioPower,
  audioBands, seed, staticMode, paused, blendMs?, blendProgress?}`。

## 6. 主题与字体

`Theme`（`src/types.ts`）是渲染器拿到的唯一主题对象：

```ts
interface Theme {
  name: string; backgroundColor: string; primaryColor: string; accentColor: string; secondaryColor: string;
  fontStyle: 'sans' | 'serif' | 'mono'; fontFamily?: string; fontFamilyStack?: string[];
  fontWeight?: number; animationIntensity: 'calm' | 'normal' | 'chaotic';
  wordColors?: { word: string; color: string }[]; lyricsIcons?: string[]; provider?: string; description?: string;
}
```

- 主题由**封面取色**得来（`publisher/deriveTheme.ts`）：canvas 采样的平均色 + 最饱和色块，按亮度/饱和度归一出
  `backgroundColor` / `primaryColor` / `accentColor` / `secondaryColor`；取不到封面时用暗/亮两套 fallback。播放页
  透明时跟随系统深浅色（`prefers-color-scheme`），不看封面明暗。
- 字体解析统一在 `src/utils/fontStacks.ts`：`resolveThemeFontStack(theme)`（自定义族 → 内置 sans/serif/mono 栈）、
  `resolveThemeTranslationFontStack(theme)`（字幕独立栈）、`resolveThemeFontWeight(theme, fallback)`
  （clamp 100–900，step 10）。内置 serif 首选「獅尾四季春加糖SC」，sans 首选 Inter。
- **没有随包字体文件**。`#app` 侧唯一的 `@font-face` 是 `Folia Noto Serif SC` 400/500，源在 CDN
  （`cdn.jsdmirror.cn` 的 @fontsource/noto-serif-sc 5.2.9）；离线时回退系统字体，观感差异可接受。插件的设置岛
  用同一份声明（`poc/settings-ui/src/app.css`）。
- 用户可选的字体来源有两条，都由插件侧提供：
  - **系统字体**：插件用 AWT 枚举本机字体族，以只读注入成员 `systemFonts` 随设置树下发；
  - **导入字体包**：`.woff2` / `.woff` / `.ttf` / `.otf`，单个 ≤ 50 MB，字节存 IndexedDB（库名
    `spw-folia-fonts`），描述符（id/label/family）进设置树，重启后按 id 重新 `document.fonts.add`。
  设置树里存的是选择结果（`fontStyle` / `customFontFamily` / `customFontStack` / `fontWeight`），经 config 的
  `lyricsFontStyle` / `lyricsCustomFontFamily` / `lyricsFontFallbackFamilies` 交给播放页。
- 字号：歌词倍率 `lyricsFontScale` clamp 0.85–1.4；字幕倍率同范围，字幕字号公式见
  [`runtime-contracts.md`](runtime-contracts.md) §8。

## 7. 随包素材

- **样式本身没有位图素材**：噪点、颗粒、网点、几何都是着色器/程序化生成。样式小图与大预览都不需要图片资源。
- 随 dist 打包的位图只有三类（都在上游 `src/components/visualizer/` 与仓库根 `assets/`）：
  - 群唱头像 15 张（`cappella/avatar/*.png`，编号 2–6、8–17，没有 7）与表情 9 张（`cappella/emo/*.png`：
    happy1 / love1 / normal1 / sleepy1-3 / vibe1-3），都由 `import.meta.glob` 打包；用户自定义包头走 IndexedDB，
    不进安装包；
  - 无封面歌曲的占位封面 2 张（`assets/placeholder_cover{,-2}.jpg`）；
  - 雾笺的雨点贴图（`nebbia/nebbiaRaindrop.png`，另有其 `LICENSE.txt`）。
- 凝彩的图层图片、莫奈的人像是**用户自己上传的**，没有内置素材；本插件的设置页裁掉了这两处的上传控件。
- 上游 `dist` 必须**整棵**发布：样式渲染器是 `import()` 懒加载 chunk，只拷冷启动路径会让非默认样式黑屏。
  暂存由 `packaging/tools/stage-web.mjs` 完成（只排除 PWA/service worker 与 `*.bak`），并校验 CSS 真的编译过、
  per-style chunk 存在、开屏遮罩未被剥掉。
- Folia 代码与素材是 **AGPL-3.0**，插件的许可与第三方声明见 [`licensing.md`](../licensing.md) 与
  [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)。雾笺的笔顺数据（`nebbia-strokes.json`）来自
  AnimCJK，是 Arphic Public License，随包附许可文本。
