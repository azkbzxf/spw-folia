# 注入式设置 UI 实现说明

> 产物：`poc/settings-ui/dist/settings-ui.js`（单文件、CSS 内联）+ `dist/thumbs/*.jpg`
> （15 张真实渲染帧）+ `dist/assets/*`（Folia 侧的 worker chunk，浏览器按需加载）。
> 参考规格：[`folia-spec/settings-ui.md`](folia-spec/settings-ui.md)（1:1 复刻依据）、
> [`protocol.md`](protocol.md) §3–§5 / §7.5（桥 / 配置 / chrome 契约）。
> 上游：Folia 0.7.22（AGPL-3.0）。

## 0. 总体做法

- **不是清洁室重写**：设置窗口直接复用 Folia 自己的 React 组件（`StudioWindow` / kit /
  `VisPlaygroundSettingsPanel` / 13 个样式设置面板 / 背景卡片 / zh-CN 文案），Vite 用别名 `@/`
  指向 Folia 源码，本工程只在外面套一层约 240 行的适配层（store、bridge、publisher、Stage 预览、
  15 个 registry entry 壳）。
- `protocol.md` §7.5 的 chrome 契约已实现：`__SPW_FOLIA__.ui` 三个方法、⚙ 按钮（鼠标静止 2.5 s
  淡出）、覆盖层打开时 capture 阶段吞掉 ESC、关闭时 ESC 交还宿主。
- 与 Folia 原版的差异（§7）集中在两类：**没有 electron/Node 能力（上传类控件降级）** 与
  **预览用静态真实帧代替实时组件渲染**；视觉与文案与 Folia 一致。

## 1. 架构

```text
Folia dist/index.html（真实播放页，OBS 模式）
  ├─ Shim.js            ← 宿主注入：__SPW_FOLIA__ 桥 + 事件 + pushConfig
  └─ settings-ui.js     ← 本 bundle（宿主注入；CSS 已内联进 JS，仅一个 <script>）
        └─ React root → <App/>
              ├─ ⚙ chrome 按钮（overlay 关闭时可见）+ 救生圈「出现问题」按钮
              ├─ PlaybackBar（底部播放条）
              ├─ StudioWindow（Folia 原组件：1240×780 窗口、dim/blur 背板、header）
              │    ├─ Stage（预览帧 + 暂停钮 + 样式 15 PictureGrid）
              │    └─ VisPlaygroundSettingsPanel（Folia 原组件：4 个 tab + 默认重置）
              ├─ zustand store（model/settings.ts）：唯一设置真源
              ├─ bridge.ts：__SPW_FOLIA__ 适配 + settings 往返 + __SPW_FOLIA__.ui
              └─ useConfigPublisher → publisher/config.ts → pushConfig（≤10 Hz、去重）
```

没有 iframe 包设置窗、没有第二个 WebView2、没有 HTTP 请求：bundle 通过宿主虚拟主机
`https://spw-folia-settings.local/` 注入，运行在 Folia 页面自己的 JS 上下文里。
（设置页里那个同源 iframe 是**歌词预览**用的 `preview.html`，见
[`live-preview-iframe.md`](live-preview-iframe.md)，与设置岛本身无关。）

## 2. 构建与注入

```bash
cd poc/settings-ui
pnpm install         # 或 npm install
pnpm build           # = vite build，产物在 dist/
```

- 产物：`dist/settings-ui.js`（单文件，含内联 CSS 与全部 React 组件）、`dist/thumbs/`
  （15 张 jpg，随样式预览帧一起产生）、`dist/assets/cacheUsage.worker-*.js`
  （Folia 侧 worker chunk，浏览器按需加载，可忽略）。具体字节数随依赖与代码变化，不做硬性记录。
- 入口配置（`vite.config.ts`）：`base: './'`、`rollupOptions.input.settings = src/main.tsx`、
  `entryFileNames: 'settings-ui.js'`、`cssCodeSplit: false`、`inlineCssIntoEntry()` 插件把 CSS
  合并后以 `<style data-spw-settings-ui-css>` 注入，保证宿主只加一个 script 标签也能带样式。
- 宿主注入：打包布局下 `<bundle>/settings/settings-ui.js` 会被辅助进程自动探测，插件不必传参；
  设置岛不在该位置时才显式给
  ```bash
  spw-folia-host.exe --bundle <folia-dist> \
      --settings-dir <settings-ui dist 目录> \
      --settings-entry settings-ui.js
  ```
  宿主把该目录映射为 `https://spw-folia-settings.local/`，在 `Shim.js` 之后注入
  `<script type="module" src="…/settings-ui.js?v=<bundleVersion>">`。
- 开发：`pnpm dev` → `http://localhost:18090/dev.html`（假桥，窗口默认打开，便于截图/调试）；
  `index.html` 是同一 bundle 的注入入口壳。
- 脚本：`scripts/shot.mjs`（dev 4 tab + chrome 截图）、`scripts/host-inject.mjs`（真实宿主注入 +
  截图；`--fullscreen` / `--no-open` / `--force-dsf` 可选）、`scripts/host-ui-check.mjs`
  （§7.5 契约实测）、`scripts/check-reset.mjs`（默认重置检查）。

### 构建期源码手术（`foliaSettingsSurgery()`）

注入页缺了好几种 Folia 桌面版默认存在的东西，因此**在构建时**把永远不可能生效的控件从组件里
剃掉，而不是让它们以死开关的形式显示出来。共两类：

- **A 组 · 节拍驱动动画**：`beat_this` / `htdemucs` 模型不在页面里，宿主也不发节拍事件
  → 智能动感模式卡片、动感效果卡片、和声字幕组、罗马音/两者这两个字幕内容模式。
- **B 组 · 上传/自定义媒体**：没有本地文件服务、没有 IndexedDB 资产库
  → tempera 图像图层、monet 自定义人像来源、cappella 自定义头像/表情包来源等上传行。
  （自定义字体是例外，见 §7 第 4 条。）

每一处移除都是**标记校验**的：字符串找不到就让构建失败，而不是静默地又把死控件发出去。
Folia 上游源码一行都不改。

### DSF / 视口注意

- 生产全屏：3200×2000 @ DSF 1.8 的机器 CSS 视口约 **1778×1111**（> 1024），Folia `StudioWindow`
  的 `lg:` 两栏布局成立。
- 1600×1000 窗口 @ DSF 1.8 的 CSS 视口只有 888×555，会退化成单栏——**这是 Folia 自身的响应式
  行为**，不是 bug。调试截屏可用 `--force-dsf 1`（仅冒烟测试；生产不要强制）。
- 页面无 `devicePixelRatio` 特判；视觉器本身按 Folia 的 DPR 逻辑渲染。

## 3. 复用 vs 重写 vs 桩

### 3.1 直接复用（未改一行 Folia 源码）

| 复用项 | 路径（相对 Folia 源码根） |
| --- | --- |
| 窗口骨架 + dim/blur + header + 两栏 grid | `src/components/shared/StudioWindow.tsx`（含 `StudioColumnBody`、`settingsTokens()`） |
| 设置控件 kit（Group/Row/Slider/Toggle/Tabs/Segmented/PictureGrid/Select/Button/Reveal/Value/Tooltip…） | `src/components/modal/settings/kit/*` |
| 设置面板（4 tab、默认重置、样式面板装配） | `src/components/visualizer/window/VisPlaygroundSettingsPanel.tsx` |
| 行组件与格式化 `percent()`/`times()`、SliderRow 拖动提交语义 | `src/components/visualizer/panelRows.tsx` |
| 13 个样式设置面板 | `settingsPanels.tsx`（classic/partita/fume/cappella/tilt/diorama/claddagh）+ `sonnet/`、`tempera/`、`lumiere/`、`hanabi/`、`monet/`、`pendolo/`（cadenza/still 无面板 → 空态「这个样式没有参数」） |
| 背景设置卡片（通用/隐现/莫奈/漫游/空） | `src/components/visualizer/backgrounds/{common,latent,monet,nomand,sora}/*SettingsCard.tsx` |
| 全部默认值（tuning、背景 tuning、阈值） | `src/types.ts` 的 `DEFAULT_*_TUNING` 等 |
| 中文文案 | `src/i18n/locales/zh-CN.ts`（纯数据，直接进 i18next resources） |
| 字体栈/字重/预览文案 | `src/utils/fontStacks.ts`、`panelRows.tsx`、`PreviewPlaceholder` 文案键 |

### 3.2 本工程重写（适配层，约 240 行）

- `src/model/settings.ts`：zustand store（Folia 持久化层替换为内存 + 桥），字段/默认值镜像 Folia
  与 `packaging/testdata/default-settings.json`。
- `src/model/styles.tsx`：15 个样式 entry 壳（`mode/order/labelKey/labelFallback/thumb/
  renderSettingsPanel/beatEffects/ownFontSizeNoticeKey`），顺序与 `registry.order` 一致
  → 8 列 × 2 行网格（15 样式 + 随机）。
- `src/model/Stage.tsx` / `StylePreview.tsx`：大预览（真实帧 `<img>` + 暂停钮）+ 样式货架
  PictureGrid（16:10 tile、选中环、名称）。
- `src/model/theme.ts` / `assetBase.ts`：预览主题（深色 demo 主题）、`--text-primary`、
  控制卡底色、range thumb class、字体/字号/字重选项数组；`assetBase` 从注入的 `<script>` 标签
  反推 bundle 基址，因此 `thumbs/<mode>.jpg` 在虚拟主机下也能解析。
- `src/bridge.ts`：`__SPW_FOLIA__` 契约适配、假桥、settings 往返（getSettings / `settings` 事件 /
  节流 setSettings）、`__SPW_FOLIA_UI__` 与 `__SPW_FOLIA__.ui`、ESC/键盘动作。
- `src/publisher/config.ts` + `deriveTheme.ts` + `useConfigPublisher.ts`：页面侧构建
  `ObsBrowserSourceConfig` 并 `pushConfig`（见 §6）。
- `src/mount.tsx`：在 `body` 上创建 `#spw-settings-ui-root`
  （`position:fixed; inset:0; z-index:2147483000; pointer-events:none`），React root 挂进去；
  设置 overlay 打开时才接管 `pointer-events`。

### 3.3 桩模块（`src/stubs/`，按 Folia 源码形状实现、只实现被导入的 API）

| 桩 | 被谁导入 | 行为 |
| --- | --- | --- |
| `useVisualizerSettingsStore` | 设置面板 | 转发到本地 store（`smartBeat`、`handleSetSmartBeat`），保证原卡片零改动可用 |
| `modelAvailability` | 节拍相关卡片 | `modelsPresent()` 返回 `{beat_this:false, htdemucs:false, htdemucs_gpu:false}`；订阅为 no-op（webview 里没有模型文件，等价于 Folia 缺模型时的降级表现） |
| `useSmartBeatAvailability` | 节拍相关卡片 | 返回 `'ready'` |
| `usePlayerChromeSettingsStore` | VisPlaygroundSettingsPanel（原生模糊开关） | `{enablePlayerPageNativeBlur:false, playerChromeVisibilityMode:'auto'}` |
| `useVisualizerAssetStore` | monet/cappella 面板、（tempera 图层面板） | 空资产包（上传能力降级） |
| `useStatusMessageStore` | tempera 图层面板 | 无消息 |
| `backgrounds/registry` | 背景 tab | 6 个内置背景 entry 壳（common/monet/nomand/latent/url/sora），`renderSettingsPanel` 直接渲染 Folia 真卡片；`BackgroundPicture` 用 Folia glyph fallback（深色卡片 + 模式字形） |
| `preview/BackgroundPicture` | 背景 tab | 上述占位的绘制函数 |
| `folium{Visualizers,Tunings,Backgrounds,Runtime,MissingEntries}` | 设置面板的 mod 扩展点 | 空 registry（无 Folium mod） |
| `localMetadataWorkerClient`, `lyrics/workerClient`, `lyrics/parserCore`, `services/db`, `localCoverAssetService`, `localMusicService` | tempera/monet 面板的图片上传链路 | no-op（切断 worker/IndexedDB/music-metadata 依赖，避免把 Electron 侧能力带进 bundle） |
| `temperaImageArchive`, `TemperaImageLayerDialog` | tempera 面板 | 面板可渲染；添加图片弹出的是空实现（见 §7） |

> 全部桩都按**被导入的真实导出签名**实现（例如 `modelsPresent` 是真函数而不是对象、
> `temperaImageArchive` 导出同名 class 与函数），否则 React/Three 侧会在运行时炸掉。

## 4. 设置树 schema（v1，与 `packaging/testdata/default-settings.json` 对齐）

`SettingsSnapshot`（`src/model/settings.ts`）是 UI 与宿主之间持久化的唯一结构，字段名 = Folia 存储键：

```jsonc
{
  "version": 1,
  "styleId": "sonnet",                 // visualizerMode；15 个之一
  "smartBeat": {                       // 必须始终是对象；写成 true 会让面板崩
    "enabled": true,
    "effects": {}                      // { "<effectId>": { "on": true, "strength": 1.0 } }
  },
  "styleTunings": { "<mode>": { /* 该样式 tuning 全量默认值 + 改动 */ } },
  "backgroundMode": "latent",          // common|monet|nomand|latent|url|sora
  "backgroundTunings": { "monet": {}, "nomand": {}, "latent": {}, "sora": {} },
  "commonBackground": { "opacity": 0.75, "useCoverColorBg": false, "disableVignette": false, "disableGeometricBackground": false },
  "appearance": { "fontStyle": "sans", "fontScale": 1, "fontWeight": null, "visualizerOpacity": 1, "customFontFamily": null },
  "subtitle": {
    "hideTranslationSubtitle": false,
    "subtitleContentMode": "translation",   // translation|romanization|both|none
    "subtitleOverlayOpacity": 0.6,
    "subtitleOverlayBackground": true,
    "subtitleUpcomingLyricsBlur": true,
    "showHarmonySubtitle": true,
    "harmonySubtitleBackground": true,
    "subtitleFontInheritsLyrics": true,
    "subtitleFontStyle": "sans",
    "subtitleFontWeight": null,
    "subtitleFontScale": 1
  },
  "lyricMotion": 0.8,                  // 0.5–1.2（树里有字段，本窗口暂无控件）
  "textureResolution": 1.5             // 0.5–4.0，0.25 步进（样式面板内另有 per-style 同名值）
}
```

范围与语义（面板内实际控件）：

| 键 | 范围 / 步进 | 控件位置 |
| --- | --- | --- |
| `textureResolution`（sonnet/tempera/lumiere tuning 内） | 0.5–4.0，step 0.25，`times` 格式 | 渲染质量 → 纹理分辨率 |
| `cameraIntensity` / `textMomentum`（`typographyMotion`/`glyphMotion`） | 0–2，step 0.05，`times` | 动态与构图 |
| `smartBeat.effects[id].strength` | 0–2，step 0.05，`times`，默认 1 | 动感效果 → 强度 |
| `appearance.fontScale` / `subtitle.subtitleFontScale` | 0.85–1.4，step 0.05，`percent` | 字体 / 字幕 tab |
| `appearance.fontWeight` / `subtitle.subtitleFontWeight` | 100–900，step 10（null = 自动） | 字体 / 字幕 tab |
| `appearance.visualizerOpacity` / `subtitleOverlayOpacity` | 0.2–1，step 0.05，`percent` | 字体 / 字幕 tab |
| `lyricMotion` | 0.5–1.2 | 树字段，窗口暂无控件 |

- 未知键透传：`applySnapshot` 只覆盖已知字段（`snapshot.styleTunings` 浅合并），插件侧未来加键
  不会丢。
- 远端写入：`bridge.on('settings')` / `getSettings()` → `applySnapshot`；本地改动 → 节流
  `setSettings(snapshot)`（≤10 Hz，值未变不发）。
- `reset` 语义与 Folia 一致：每个 tab 的「默认」按钮重置该 tab 范围内的一切（样式 tuning →
  `DEFAULT_*_TUNING`；字体/字幕 → Folia 默认值；背景 → 该背景 tuning 默认值），无内容可重置时
  按钮 disabled。

## 5. 元数据（tuning）与样式面板

- 样式面板拿到的 `settings` 是 Folia 的 `VisualizerTuningSettings` 袋：
  `{ sonnetTuning, temperaTuning, …, latentBackgroundTuning, monetBackgroundTuning,
  nomandBackgroundTuning, soraBackgroundTuning, smartBeat }`（由 `selectTuningSettings` 从快照的
  `styleTunings`/`backgroundTunings` 组装）。
- `styleDraft = { tuning: styleTunings[styleId], change: setStyleTuning, reset: resetStyleTuning }`，
  与 Folia `useTuningDrafts` 的 `StyleDraft` 接口一致；拖动滑杆时
  `onSliderPointerDown/Commit` 交给面板自己的提交逻辑（`panelRows.SliderRow` 只在 release 时提交）。
- 每个样式的默认值全部来自 Folia `src/types.ts`，见 [`folia-spec/tunings.md`](folia-spec/tunings.md)；
  本工程 `model/settings.ts:STYLE_TUNING_DEFAULTS` 直接引用同一批常量。

## 6. 配置发布器（publisher）

文件：`src/publisher/config.ts`、`src/publisher/deriveTheme.ts`、`src/useConfigPublisher.ts`。

- 输入：本地 store 快照、`__SPW_FOLIA__.inputs.track/lyrics/state`（事件增量也在
  `bridge.on('track'|'lyrics'|'state')` 里收）、`state` 的播放状态用于时钟换算、主题（封面派生，
  见下）。
- 输出：`ObsBrowserSourceConfig`（Folia `src/types/obsBrowserSource.ts`），经
  `__SPW_FOLIA__.pushConfig(config)` → 宿主直接派发 Folia 的 `config` 事件，视觉器即时更新，
  不重载页面。**页面侧构建、宿主只转发**（[`protocol.md`](protocol.md) §4）。
- 字段映射（`publisher/config.ts:buildConfig`）：
  - `activePlaybackContext:'main'`、`stageSource:null`、`hasTrack`、`song{id,name}|null`、
    `songArtist/songAlbum/coverUrl`、`lyrics`（Folia `LyricData`）、`theme`/`subtitleTheme`、
    `isDaylight`、`seed`（曲目 id 兜底）。
  - `visualizerMode` ← `styleId`；`visualizerTunings` ← 除 `still` 外全部 `styleTunings`
    （渲染器按 `visualizerTunings[mode]` 应用）。
  - `background` ← `backgroundMode` + `commonBackground` + 各背景 tuning 合并默认值
    （结构同 Folia `VisualizerBackgroundConfig`）。
  - 外观：`lyricsFontScale`/`subtitleFontScale`（clamp 0.85–1.4）、
    `visualizerOpacity`/`subtitleOverlayOpacity`（clamp 0.2–1）、`staticMode:false`、
    `hideTranslationSubtitle`、`showSubtitleTranslation = !hide && contentMode!=='none'`、
    `subtitleContentMode`、`subtitleOverlayBackground` 等。
  - `updatedAt`：每次推送加时间戳；**去重签名**用去掉 `updatedAt` 的 JSON，签名不变不推。
- 歌词：插件给的每行 `{startMs,endMs,main,sub?,romanization?,id?,words?}` → Folia
  `Line{words,startTime,endTime,fullText,translation}`；没有逐字时间时按字符均分回退
  （逐字样式依赖 `words`）。
- 节流：`CONFIG_MIN_INTERVAL_MS=100`（≤10 Hz），拖动过程中合并，释放后由 `flush()` 立即推一次；
  窗口/曲目变化 0.35 s 跳变阈值与 Folia `useObsBrowserSourcePublisher` 一致（时钟插值仍由
  Shim/宿主负责）。
- 主题派生（`deriveTheme.ts`）：封面 URL → `48×48` canvas 采样 → 像素均值做
  `backgroundColor`/`primaryColor`、最饱和桶做 `accentColor`，亮度阈值（`luminance`）决定
  `isDaylight` 与文字色；无封面/加载失败回退深色 demo 主题 `#09090b / #f4f4f5 / #71717a`。
  这是「页面内派生」，与 Folia 桌面版的取色链路同职责（宿主只给 bytes）。
- 兼容：下游仍兼容宿主直推 `config`（`--demo` 路径），本 publisher 只负责 settings 驱动的路径；
  两者产出同一 `ObsBrowserSourceConfig` 形状。

## 7. 与 Folia 原版的差异（使用与验收时需知晓）

1. **预览是真实宿主渲染帧**（`poc/webview/host` 全屏运行 Folia dist 截屏，按 16:10 裁切
   1440×900 JPEG q82），不是 Folia 的实时 `preview/LyricStylePicture` 小渲染；换样式/调参时大图与
   15 格货架不会跟着实时重绘（Folia 会）。这是性能与依赖取舍，视觉上等价。
   （**例外**：设置页里那块「歌词预览」是同源 iframe `preview.html`，那一条是活的，见
   [`live-preview-iframe.md`](live-preview-iframe.md)。）
2. **智能动感模式默认 ON**：与 `packaging/testdata/default-settings.json` 一致；Folia 应用自身的
   stored default 是 `false`（`types.ts`），本工程按 v1 树取 ON。
3. **模型/播放能力降级**：`useSmartBeatAvailability()` 桩返回 `'ready'`（为了不显示「仅桌面版可用」
   提示）；实际 webview 内没有 `beat_this`/`htdemucs` 模型，节拍效果不会真正驱动动画
   （视觉器在 `isBeatFxReady()` 为假时像素不变）。相关控件已在构建期移除（§2）。
4. **上传类控件降级**：自定义字体已可用——「自定义」磁贴可导入字体包
   （`.ttf/.otf/.woff/.woff2`，单个 ≤ 50 MB，存 IndexedDB 并用 `FontFace` 注册）或从插件下发的
   `systemFonts`（AWT 枚举，最多 400 个家族，不持久化）里选。仍然降级的有 tempera 画布图片、
   monet 封面/肖像、cappella 自定义表情/头像——按钮存在但为 no-op（对应桩）；
   文案与布局保持 Folia 原样。
5. **Folium mod 扩展卡片**不渲染（无 mod）；`嵌入/空` 背景的动态图片列表为空。
6. **背景缩略图**是 Folia 无图时的 glyph fallback（深色卡片 + 模式字形，沿
   `backgrounds/<mode>/entry.tsx` 的 `PictureFrame` 语义重绘；Folia 在有背景数据时画实时小画布）；
   `背景` tab 设置项行为完全一致。
7. **返回按钮**关闭注入覆盖层（不是回播放页）；顶部 header 的 `←` 与 §7.5 一致。
8. **纹理分辨率显示 1.50x**（Folia 默认 1.5）。
9. 注入层全局 CSS（kit.css/Tailwind）会作用到整个页面，但每次打开前只在 head 注入一次
   `<style data-spw-settings-ui-css>`，与 Folia 页面自身的 Tailwind 共存
   （选择器均为 kit 前缀 `st-` / CSS 变量，实测无冲突）。
10. 眼镜/英文字体：`Folia Noto Serif SC` 仍由 Folia 页面自己的 `@font-face` 提供；本 bundle 不额外
    拉字体，离线时回退系统衬线栈。

## 8. §7.5 chrome 契约实现

- `__SPW_FOLIA__.ui = { isSettingsOpen(), openSettings(), closeSettings() }`：
  `bridge.ts:registerSettingsUiController()` 在 Shim 建好的对象上**增补** `ui` 字段（不替换对象），
  同时保留 `__SPW_FOLIA_UI__` / `__SPW_FOLIA_SETTINGS_UI__` 兼容名。
- ⚙ 按钮：`.spw-chrome-btn`（`src/app.css`）固定右上 24/24，40×40 圆钮，
  `rgba(0,0,0,.28)` + `backdrop-filter:blur(12px)` + 1px 白 16% 描边 + 白色 lucide `Settings` 20px，
  hover 提亮；`pointermove/pointerdown/keydown` 重置 2.5 s 空闲计时，超时与光标一起淡出
  （opacity/translate 过渡），关闭覆盖层后重新出现。旁边的救生圈按钮是「出现问题」入口。
- **指针事件（必须显式开启）**：注入挂载根 `#spw-settings-ui-root`（`src/mount.tsx`）是
  `pointer-events:none` 的点击穿透层，好让关闭状态下的点击落到下面的 Folia 视觉器；所以 ⚙ 必须
  在 CSS 里显式 `pointer-events:auto`，否则 `document.elementFromPoint()` 与真实鼠标命中都会被
  Folia 页面元素截走——合成 `.click()` 能过、真实点击会失效。按钮隐藏态
  `[data-visible='false']` 恢复 `pointer-events:none`，保证空闲时点穿透。覆盖层打开时其容器自身
  `pointer-events:auto` 接管整屏。
- 覆盖层：打开时 `data-spw-settings-overlay='true'`、容器 `pointer-events:auto` 且
  `display:block`；**组件不卸载**（隐藏时 `display:none`），再次打开不重挂载、预览帧不闪。
- ESC：打开时在 `window` **capture** 阶段监听，命中后
  `preventDefault()+stopPropagation()+close()`；关闭时不注册该监听，ESC 直接落到宿主
  （宿主负责关窗）。
- 宿主命令 `command open-settings` / `close-settings` 由 Shim 转成 `ui` / `settingsUI` 事件触达
  本页（`bridge.ts` 同时监听两种事件名），也可直接
  `ExecuteScriptAsync("__SPW_FOLIA__.ui.openSettings()")`。

`scripts/host-ui-check.mjs` 在真实宿主里跑这套契约（无 `--force-dsf`），输出要点：

```text
初始：uiApi=function, isOpen=false, gear=true
指针命中（⚙ 中心 elementFromPoint）：可见态 pointerEvents=auto，命中 gear
空闲 2.5s 后：visible=false, pointerEvents=none，命中 HEADER（点击穿透视觉器，符合预期）
⚙ 点击 → isOpen=true, chrome 隐藏
ESC（打开时）→ isOpen=false（事件被 preventDefault）
ui.openSettings() → true；ui.closeSettings() → false
ESC（关闭时）→ 未 preventDefault（交还宿主）
重新打开 → 立即打开，.st-window 数量始终为 1（未重挂载）
host/page errors = 0
```

## 9. 截图与素材

公开文档用的图在 `docs/images/`：`settings-ui.jpg`（真实宿主全屏、覆盖层打开）、
`fullscreen-chrome.jpg`（视觉器 + 右上 ⚙）、`transparent-background.jpg`、
`menu-folia.png`、`style-grid.png`。

> `docs/images/style-grid.png` 目前是 v0.3.x 时期拍的 **14 格**截图（缺「花火」），
> 需要重拍一张 15 格版本替换。

## 10. 验收清单

- [x] `pnpm build` 通过，产物单文件 `dist/settings-ui.js`（CSS 内联），无运行期网络请求。
- [x] 标题「歌词样式」、右上「默认」、4 tab `歌词动画/背景/字体/字幕`、15 样式 + 随机
      → 8 列 2 行。
- [x] 大预览 + 暂停钮 + 样式货架与 Folia 一致；尺寸/间距来自 Folia 原组件
      （1240×780、右栏 420、tile 16:10）。
- [x] 渲染质量 / 动态与构图两组的值与范围来自 `DEFAULT_SONNET_TUNING`
      （纹理 1.5x、镜头 1.00x、文字动势 1.00x）。
- [x] 13 个样式面板全部可渲染（cadenza/still 为空态）。
- [x] 控件改动 → store → `setSettings`（≤10 Hz）→ 宿主持久化；`pushConfig` 带
      `visualizerTunings` 与 `visualizerMode`。
- [x] 真实宿主注入：0 页面错误，全屏两栏，⚙/ESC 契约通过。
- [ ] `嵌入/空` 背景与上传类控件（§7 第 4/5 条）留待后续——功能降级不影响视觉与设置树。

## 11. 风险与后续

- **DSF 视口**：生产在 1080p 屏全屏（CSS 1920×1080）仍两栏；窗口化到窄尺寸时 Folia 会变单栏
  （接受）。
- **覆盖层遮住视觉器交互**：打开时 `pointer-events:auto` 覆盖全屏，播放器点击被挡住
  （Folia 自身设置窗口也如此），关闭即恢复。
- **模型缺失**：§7 第 3 条；后续若节拍注入链路落地，可把 `useSmartBeatAvailability` 桩换成真实
  探测，并把 §2 里移除的卡片加回来。
- **上传能力**：待宿主/插件提供文件选择与 asset 通道后，替换对应桩即可（接口已按 Folia 形状保留）。
- **AGPL-3.0**：本 bundle 编译了 Folia 的 React 组件（AGPL 代码），分发时必须随附相应源码/构建
  脚本与许可证声明（见 [`licensing.md`](licensing.md)、`THIRD_PARTY_NOTICES.md`），且不得以
  专有条款再授权。
