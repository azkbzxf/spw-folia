# Folia 歌词样式映射表（style-map）

> 来源：上游 Folia **0.7.22**（`folia-major-main`，AGPL-3.0）。本文所有结论都带 `文件:行号` 证据，行号指
> 上游仓库相对路径，随上游版本变化，请以文件内容为准。关联文档：`settings-ui.md`（设置页）、
> `runtime-contracts.md`（渲染输入）、`fullscreen-shell.md`（全屏外壳）、`tunings.md`（默认值）、`assets.md`（素材）。

## 0. 一句话结论

设置窗左侧「样式」是 **15 个实时绘制**的预览格（没有缩略图图片资源），顺序 = 各 `entry.tsx` 的 `order` 升序；
网格末尾另有「随机」一项，所以宽窗时是 **8 列 × 2 行**。第 13 个是 **镜台（diorama）**，不是「铭台」——见 §2。

网格布局常量：`SHELF_COLUMNS = { wide: 7, narrow: 4 }`（`src/components/visualizer/window/VisPlayground.tsx:117`），
指的是**样式本体**每行 7 格；选项数组在末尾追加 `{ label: t('ui.visualizerRandom'), value: RANDOM_VISUALIZER_CHOICE }`
（`VisPlayground.tsx:247-256`），因此「样式」标题旁的计数显示 **16**（`modeOptions.length`，`VisPlayground.tsx:516`）。
`PictureGrid` 在 `VisPlayground.tsx:519`，标题 `t('options.lyricStyles')` =「样式」（`VisPlayground.tsx:514`）。
注册表按 `order` 排序（`src/components/visualizer/registry.tsx:36`、`:91`），成员由
`import.meta.glob('./*/entry.tsx', { eager: true })` 发现（`registry.tsx:15`）。

## 1. 15 样式主表（网格顺序 = order 升序）

| # | 中文名 | mode id（=目录名） | labelKey / zh 值 | order | entry.tsx:行 | 渲染技术 | tuning 存储键 | 背景 | 额外声明 |
|---|--------|------------------|------------------|-------|--------------|----------|----------------|------|----------|
| 1 | 商籁 | `sonnet` | `ui.visualizerSonnet` 商籁 | 10 | `sonnet/entry.tsx:25` | **pixi.js(WebGL) + @chenglou/pretext** | `sonnet_tuning` | props（默认 latent） | `usesWordSegmentation`、`ownFontSizeNoticeKey`、beatEffect 推镜裂光 |
| 2 | 凝彩 | `tempera` | `ui.visualizerTempera` 凝彩 | 20 | `tempera/entry.tsx:21` | **pixi.js(WebGL) + pretext** | `tempera_tuning` | props | `usesWordSegmentation`、`ownFontSizeNoticeKey`、图片图层池(IndexedDB) |
| 3 | 绘光 | `lumiere` | `ui.visualizerLumiere` 绘光 | 25 | `lumiere/entry.tsx:15` | **pixi.js(WebGL) + pretext** | `lumiere_tuning` | props | `usesWordSegmentation`、`ownFontSizeNoticeKey` |
| 4 | 花火 | `hanabi` | `ui.visualizerHanabi` 花火 | 26 | `hanabi/entry.tsx:18` | **pixi.js(WebGL)** | `hanabi_tuning` | props | `ownFontSizeNoticeKey`、beatEffect 随拍开花 + 整镜脉冲 |
| 5 | 流光 | `classic` | `ui.visualizerClassic` 流光（fallback 写 `Luminous`） | 30 | `classic/entry.tsx:14` | framer-motion（DOM/Canvas） | `classic_tuning` | props | `usesWordSegmentation`；逐词发光共用 `GlowWord.tsx` |
| 6 | 心象 | `cadenza` | `ui.visualizerCadenze` 心象（键名拼写就是 Cadenze） | 40 | `cadenza/entry.tsx:26` | framer-motion + pretext | `cadenza_tuning` | props | 无 |
| 7 | 云阶 | `partita` | `ui.visualizerPartita` 云阶 | 50 | `partita/entry.tsx:14` | framer-motion（DOM/inline SVG） | `partita_tuning` | props | `usesWordSegmentation`；`PartitaChunk.tsx` |
| 8 | 浮名 | `fume` | `ui.visualizerFume` 浮名 | 60 | `fume/entry.tsx:21` | Canvas2D + pretext | `fume_tuning` | **entry 覆盖**：`background: fumeBackgroundConfig`（`entry.tsx:39`，关掉几何图形） | `previewStartOffset: 18.4` |
| 9 | 倾诉 | `tilt` | `ui.visualizerTilt` 倾诉 | 70 | `tilt/entry.tsx:21` | framer-motion + pretext | `tilt_tuning` | props | 无 |
| 10 | 回环 | `claddagh` | `ui.visualizerCladdagh` 回环 | 80 | `claddagh/entry.tsx:14` | framer-motion + pretext | `claddagh_tuning` | props | 无 |
| 11 | 莫奈 | `monet` | `ui.visualizerMonet` 莫奈 | 90 | `monet/entry.tsx:14` | Canvas/Worker + pretext | `monet_tuning` | props | `seeksOnLineClick`、`followsSongHandoff`（唯一画混音交接） |
| 12 | 时计 | `pendolo` | `ui.visualizerPendolo` 时计 | 100 | `pendolo/entry.tsx:22` | WebGL(表盘)+Canvas2D 双实现 + pretext | `pendolo_tuning` | props | `seeksOnLineClick`、beatEffect 仿真鼓面 + 齿轮节拍 |
| 13 | 群唱 | `cappella` | `ui.visualizerCappella` 群唱 | 110 | `cappella/entry.tsx:23` | framer-motion + pretext | `cappella_tuning` | props | 头像/表情图（内置 + 自定义包） |
| 14 | **镜台** | `diorama` | `ui.visualizerDiorama` 镜台 | 120 | `diorama/entry.tsx:16` | **three.js(WebGL)** | `diorama_tuning` | props（场景自带雾带尘埃） | beatEffect 水镜涟漪 |
| 15 | 静止 | `still` | `ui.visualizerStill` 静止 | 130 | `still/entry.tsx:10` | 纯 DOM | 无（无 tuning.ts） | **`background: false`**（`still/entry.tsx:29`） | 无 |

补充事实：

- 15 个 id 的权威清单在 `src/types/visualizerModes.ts:15-31`（`BUILTIN_VISUALIZER_MODES`）；默认样式
  `DEFAULT_VISUALIZER_MODE = 'classic'`（`:42`），默认背景 `DEFAULT_VISUALIZER_BACKGROUND_MODE = 'latent'`（`:43`）。
  该清单在 registry 初始化时与 glob 发现结果逐一断言，对不上直接抛错，不需要人工同步。
- 每个样式必有 `previewSeed`（= 自身 id）与 `previewStartOffset`（除 fume 为 18.4s，其余均为 0）；预览图即用真渲染器画。
- `labelFallback` 只有部分是中文（商籁/绘光/云阶/花火/镜台），其余是英文 id 风格名；**显示名以 zh-CN 的
  `ui.visualizer*` 为准**（`zh-CN.ts:891-905`），不是 fallback。
- 每个样式声明了 `glyph`（24×24 线性图标）与 `command`（命令面板 id `visualizer-<mode>`，keywords 含中文名与
  「切换到可视化：X」）。
- 15 种样式中的 14 种有 `tuning.ts`（只有 `still` 没有）；全部遵循 `defineVisualizerTuning`：`settingsKey`、`settingsSetterKey`、
  `settingsResetterKey`、`storage.key`（`<mode>_tuning`），`defaults` 来自 `DEFAULT_<MODE>_TUNING`。逐键默认值见 `tunings.md`。
- `usesWordSegmentation: true`：`classic/lumiere/partita/sonnet/tempera` 的布局原子来自整行分词（用户保存的分词会影响画面）。
- `ownFontSizeNoticeKey`：`sonnet/tempera/lumiere/hanabi` 自己算字号，设置窗在字号开关处显示提示；通用字号对这些样式（部分）无效。

## 2. 命名纠错：第 13 个是「镜台」，不是「铭台」

- `src/i18n/locales/zh-CN.ts:900` → `"visualizerDiorama": "镜台"`；命令「切换到可视化：镜台」；`"dioramaReset": "镜台参数已重置"`；
  `"dioramaSettings": "镜台参数"`。
- `diorama/entry.tsx:18` `labelFallback: '镜台'`；全仓库 `grep 铭台` 无命中。
- 结论：早期需求里的「铭台」是 OCR/手误；实现 UI 与命令面板一律写 **镜台**。

## 3. 背景系统（与样式解耦，一次画在样式外）

- 6 个背景 mode（`src/types/visualizerModes.ts:33-40`）：`common` 通用、`latent` 隐现（默认）、`monet` 莫奈、
  `nomand` 漫游、`sora` 空、`url` 嵌入（zh 文案 `zh-CN.ts:2269-2274`）。
- 背景由 `VisualizerBackdrop.tsx` 在所有样式外层画一次，换样式时不重来。样式默认用用户选的背景；
  `entry.background` 可覆盖：`fume` 传 `fumeBackgroundConfig`（隐藏几何图形），`still` 传 `false`。
- 背景目录 `backgrounds/` 内含 6 个 mode 子目录 + `common/ FluidBackground.tsx` 等共享件 +
  `registry.tsx`/`definition.ts`/`useBlendedColors.ts`/`VisualizerBackgroundRenderer.tsx`。
- 背景有自己的 tuning（`backgrounds/<mode>/tuning.ts`）与设置卡；`url` 背景的设置不进 tuning，在
  `backgrounds/url/settings.ts`。`monet` 背景在混音过渡中跟 `songHandoff` 走（`followsSongHandoff` 只有它）。

## 4. 「缩略图」真相：渲染器实时绘制，不是图片资源

- 样式格是**活的**：`LyricStylePicture`（`src/components/visualizer/preview/LyricStylePicture.tsx:59`）按真模式以
  `previewSeed` 画一帧冻结画面；`VisPlayground.tsx` 的 `drawStyle` 就是 `<LyricStylePicture mode={mode} {...state} />`。
- `src/components/visualizer/README.md:83`：「预览图由 `preview/LyricStylePicture.tsx` 用真的样式现画，不用准备图片。」
- 因此复用 registry + `preview/` 组件即可，**不需要**提取任何 style thumbnail 资源。
- 注意区分两种「缩略图」：spw-folia 设置页最终用的是**我们自己截下来的静态 JPG**（`settings/thumbs/<mode>.jpg`，
  15 张，`poc/settings-ui/src/model/assetBase.ts:31` 按 `<mode>.jpg` 取），这与上游 Folia 的实时绘制不是同一件事。
  上游没有可提取的图片资源，我们的 JPG 是本项目自己的产物，见 `settings-ui-impl.md`。

## 5. 共享依赖：托管样式时 harness 必须提供什么

总体判断：**代码可原样托管时，样式本身的移植成本≈0**；成本在 harness（数据层、字体、资产、宿主桥）。

1. **framer-motion `MotionValue`**：所有样式都从 props 拿 `currentTime: MotionValue<number>` 与
   `audioPower: MotionValue<number>`；宿主必须提供同名对象（可直接用 framer-motion 本体，或实现
   `get/set/on('change')` 的等价物）。
2. **pixi.js v8**（sonnet/tempera/lumiere/hanabi）：`pixi/create*PixiRuntime.ts` 假定有 WebGL2 上下文与
   `pixiRuntimeHost.ts` 的单例生命周期；WebView2 默认有 WebGL2，但要确认 GPU 黑名单与 `--disable-gpu` 不生效。
3. **three.js**（diorama）：只走标准 WebGL2，无 Electron/Node API。
4. **pretext 文本测量**（`@chenglou/pretext`）：需要真实字体文件（见 §6），否则测量退化、布局错位。
5. **WebGPU 模型**（智能动感的 beat_this / htdemucs）：`services/analysis/beatThisGpu.ts` 等，**不属于样式**；
   不跑时效果走 `isBeatFxReady()` 的「没就绪」分支，画面与关闭时一致。
6. **`new Worker`**（monet）：WebView2/浏览器都支持；用 Vite 打包即可解决加载路径。
7. **IndexedDB / localStorage**：样式读 tuning 走 store（`src/stores/visualizerSettings*`）；tempera 图片池、
   cappella 自定义包、monet 立绘用 IndexedDB。可用内存实现顶替。
8. **Electron/Node API**：visualizer 目录内**没有任何** `electron`/`fs`/`node:` import（样式层是纯浏览器代码）；
   所有 Electron 依赖都在 `electron/*.cjs`、`src/services/*` 层。→ webview 托管天然可行。

## 6. 字体与主题（样式画字依赖）

- 字族解析统一在 `src/utils/fontStacks.ts`：内置三档 `BUILTIN_FONT_STACKS.sans/serif/mono`；`serif` 的显示字体首选
  **`"獅尾四季春加糖SC"`**（`fontStacks.ts:19`），`sans` 首选 `"Inter"`。译文（字幕）另有 `TRANSLATION_FONT_STACKS`，
  serif 档额外含 `"Folia Noto Serif SC"`。
- `src/index.css:19-33` 用 `@font-face` 从 **CDN**（`cdn.jsdmirror.cn`，@fontsource/noto-serif-sc 5.2.9，400/500）加载
  `Folia Noto Serif SC`；离线环境会退回系统字体 → WebView 中需自带该 woff2 或接受回退。
- 用户可在设置里上传自定义字体（`.woff2/.woff/.ttf/.otf`，`src/services/customLyricsFont.ts`、`window/FontPicker.tsx`），
  主题里存 `fontFamily`/`fontFamilyStack`，并可选回退族（`FontFallbackStackControl.tsx`）。
- 字重范围 `MIN_FONT_WEIGHT=100 / MAX=900 / STEP=10`（`fontStacks.ts:3-5`），`Theme.fontWeight` 经
  `normalizeFontWeight` 归一。
- 字号：样式普遍用 `lyricsFontScale`（0.85–1.4，`VisPlayground.tsx` `clampFontScale`）；字幕字号由
  `subtitleFontSizes.ts` 的 `resolveSubtitleFontSizes(lyricsFontScale)` 单点决定（见 `runtime-contracts.md` §6）。
- 主题对象 `Theme` 提供 `fontStyle`、`fontFamily`、`fontFamilyStack`、`fontWeight` 等；颜色走 CSS 变量/theme 色板
  （`colorMix.ts`），背景与样式的明暗由 `isDaylight` 参与。

## 7. 证据索引

| 事实 | 证据 |
|------|------|
| 15 个 id 清单、默认 classic/latent | `src/types/visualizerModes.ts:15-43` |
| 注册表 glob 发现 + 按 order 排序 | `src/components/visualizer/registry.tsx:15,36,91` |
| 15 个中文显示名 | `src/i18n/locales/zh-CN.ts:891-905` |
| 样式格 7 列 + 末尾「随机」 | `window/VisPlayground.tsx:117`(`SHELF_COLUMNS`), `:247-256`, `:514-520` |
| 预览格是实时渲染 | `preview/LyricStylePicture.tsx:59`, `VisPlayground.tsx` `drawStyle`, `README.md:83` |
| 各样式 order/label/tuning/背景 | `<mode>/entry.tsx` 同名行（见 §1 表） |
| 14 个 tuning 存储键 | `<mode>/tuning.ts` 的 `storage.key` |
| 智能动感效果登记 | `sonnet/entry.tsx:44`、`hanabi/entry.tsx:37`、`diorama/entry.tsx:35`、`pendolo/entry.tsx:45`；id 在 `services/beatFx/beatEffects.ts:38-46` |
| 背景 6 mode | `src/types/visualizerModes.ts:33-40`、`backgrounds/*/entry.tsx` |
| 样式层无 Electron/Node API | `grep -rn "electron\|node:" src/components/visualizer/` 无命中（仅 browser API） |
