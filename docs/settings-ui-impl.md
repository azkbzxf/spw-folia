# 注入式设置 UI 与实时预览

设置窗口不是清洁室重写：它直接复用 Folia 自己的 React 组件（`StudioWindow` / kit /
`VisPlaygroundSettingsPanel` / 17 个样式设置面板 / 背景卡片 / zh-CN 文案），Vite 用别名 `@/` 指向
Folia 源码，本工程只加一层适配（store、bridge、publisher、Stage 预览、样式 registry 壳）。

本文覆盖两块密不可分的内容：**设置岛本身的构建与契约**（§1–§8）与**左侧大预览的 iframe 机制**
（§9）。两者同属一个 bundle、共用同一条 config 数据流。

上游 Folia **0.7.25**（AGPL-3.0），源码在 `work/folia/folia-major-main`。

## 1. 架构

```text
Folia dist/index.html（真实播放页，OBS 模式）
  ├─ Shim.js            ← 宿主注入：__SPW_FOLIA__ 桥 + 事件 + pushConfig
  └─ settings-ui.js     ← 本 bundle（宿主注入；CSS 已内联进 JS，仅一个 <script>）
        └─ React root → <App/>
              ├─ ⚙ chrome 按钮（overlay 关闭时可见）
              ├─ StudioWindow（Folia 原组件：1240×780 窗口、dim/blur 背板、header）
              │    ├─ Stage（LivePreview iframe + 暂停钮 + 样式货架 17 格）
              │    └─ VisPlaygroundSettingsPanel（Folia 原组件：4 个 tab + 默认重置）
              ├─ zustand store（model/settings.ts）：唯一设置真源
              ├─ bridge.ts：__SPW_FOLIA__ 适配 + settings 往返 + __SPW_FOLIA__.ui
              └─ useConfigPublisher → publisher/config.ts → pushConfig（≤10Hz、去重）
```

没有 HTTP 请求、没有第二个 WebView2：bundle 通过宿主虚拟主机 `https://spw-folia-settings.local/`
注入，运行在 Folia 页面自己的 JS 上下文里。（唯一的子文档是预览 iframe，同源，见 §9。）

## 2. 构建与注入

```bash
cd poc/settings-ui
pnpm install
pnpm thumbs          # 采集 17 张样式帧 -> public/thumbs/*.jpg（首次/换上游后必跑）
pnpm build           # = vite build，产物在 dist/
```

- 产物：`dist/settings-ui.js`（单文件，含内联 CSS 与全部 React 组件）、`dist/thumbs/`（17×jpg）、
  `dist/assets/cacheUsage.worker-*.js`（Folia 侧 worker chunk，浏览器按需加载，可忽略）。
- **`public/thumbs/` 是构建输入，不在版本库里**（`.gitignore` 掉）：干净检出时没有 `public/`，
  `vite build` 仍然成功但产物里一张 thumbs 都没有 → 注入后货架 tile 全是破图图标。
  所以有两道硬闸：`vite.config.ts` 的 `requireStyleThumbs()`（writeBundle 阶段缺图直接 throw）
  与 `packaging/tools/stage-web.mjs`（暂存阶段缺图直接 throw）。
  重新采集用 `node scripts/make-thumbs.mjs`（真实宿主 + 真实 Folia 渲染器，每种样式截一张
  3200×2000 帧，中心裁 16:10 后存 1440×900 JPEG q82）。
- 入口配置（`vite.config.ts`）：`base: './'`、`rollupOptions.input.settings = src/main.tsx`、
  `entryFileNames: 'settings-ui.js'`、`cssCodeSplit: false`、`inlineCssIntoEntry()` 插件把 CSS 合并
  后以 `<style data-spw-settings-ui-css>` 注入，保证宿主只加一个 script 标签也能带样式。
- 宿主注入：
  ```bash
  spw-folia-host.exe --bundle <folia-dist> \
      --settings-dir <poc/settings-ui/dist> \
      --settings-entry settings-ui.js
  ```
  宿主把该目录映射为 `https://spw-folia-settings.local/`，在 Shim.js 之后注入
  `<script type="module" src="…/settings-ui.js">`。
- 开发：`pnpm dev` → `http://localhost:18090/dev.html`（假桥，窗口默认打开，便于截图/调试）；
  `index.html` 是同一 bundle 的注入入口壳。

### DSF / 视口注意

- 生产全屏：3200×2000@DSF1.8 机器的 CSS 视口约 **1778×1111**（>1024），Folia `StudioWindow`
  的 `lg:` 两栏布局成立。
- 1600×1000 窗口 @DSF1.8 的 CSS 视口只有 888×555，会退化成单栏 —— **这是 Folia 自身的响应式行为**，
  不是 bug。调试截屏可用 `--force-dsf 1`（仅 smoke test；生产不要强制）。

## 3. 复用 / 重写 / 桩

### 3.1 直接复用（未改一行 Folia 源码）

| 复用项 | 路径（相对 `work/folia/folia-major-main/`） |
|---|---|
| 窗口骨架 + dim/blur + header + 两栏 grid | `src/components/shared/StudioWindow.tsx`（含 `StudioColumnBody`、`settingsTokens()`） |
| 设置控件 kit（Group/Row/Slider/Toggle/Tabs/Segmented/PictureGrid/Select/Button/Reveal/Value/Tooltip…） | `src/components/modal/settings/kit/*` |
| 设置面板（4 tab、默认重置、样式面板装配） | `src/components/visualizer/window/VisPlaygroundSettingsPanel.tsx` |
| 行组件与格式化 `percent()`/`times()`、SliderRow 拖动提交语义 | `src/components/visualizer/panelRows.tsx` |
| 智能动感模式卡片 | `src/components/visualizer/SmartBeatSettingsCard.tsx` |
| 动感效果组 | `src/components/visualizer/BeatEffectsGroup.tsx` + `src/services/beatFx/beatEffects.ts` |
| 样式设置面板 | `settings.tsx` 内各 entry 的 `renderSettingsPanel` + `sonnet/`、`tempera/`、`lumiere/`、`hanabi/`、`machi/`、`nebbia/`、`monet/`、`pendolo/`（cadenza/still 无面板 → 空态「这个样式没有参数」）。**现行 17 样式里 15 个带面板** |
| 背景设置卡片 | `src/components/visualizer/backgrounds/{common,latent,monet,nomand,sora}/*SettingsCard.tsx` |
| 全部默认值（tuning、smartBeat、背景 tuning、阈值） | `src/types.ts` 的 `DEFAULT_*_TUNING` / `DEFAULT_SMART_BEAT_SETTINGS` 等 |
| 中文文案 | `src/i18n/locales/zh-CN.ts`（纯数据，直接进 i18next resources） |
| 字体栈/字重/预览文案 | `src/utils/fontStacks.ts`、`panelRows.tsx`、`PreviewPlaceholder` 文案键 |

### 3.2 本工程重写的适配层

- `src/model/settings.ts`：zustand store（Folia 持久化层换成内存 + 桥），字段/默认值镜像 Folia
  与 `packaging/testdata/default-settings.json`。
- `src/model/styles.tsx`：17 个样式 entry 壳（`mode/order/labelKey/labelFallback/thumb/
  renderSettingsPanel/beatEffects/ownFontSizeNoticeKey`），顺序与 `registry.order` 一致 →
  网格（17 样式 + 随机）。模块加载时断言其 mode 集合与顺序 == `STYLE_MODE_SHELF_ORDER`。
- `src/model/Stage.tsx` / `LivePreview.tsx`：左侧大预览（同源 iframe，见 §9）。
- `src/model/ShelfLive.tsx` / `ShelfLiveView.tsx` / `ShelfStatic.tsx`：样式货架三态（实时 / 静态 / 缓存）。
- `src/model/theme.ts` / `assetBase.ts`：预览主题、`--text-primary`、控制卡底色、range thumb class、
  字体/字号/字重选项数组。
- `src/bridge.ts`：`__SPW_FOLIA__` 契约适配、假桥、settings 往返（`getSettings()` / `settings` 事件 /
  节流 `setSettings`）、`__SPW_FOLIA__.ui`、ESC/键盘动作。
- `src/publisher/config.ts` + `deriveTheme.ts` + `useConfigPublisher.ts`：页面侧构建
  `ObsBrowserSourceConfig` 并 `pushConfig`（见 §6）。
- `src/mount.tsx`：在 `body` 上创建 `#spw-settings-ui-root`
  （`position:fixed; inset:0; z-index:2147483000; pointer-events:none`），React root 挂进去；
  设置 overlay 打开时才接管 `pointer-events`。

### 3.3 桩模块（`src/stubs/`，按 Folia 源码形状实现、只实现被导入的 API）

| 桩 | 被谁导入 | 行为 |
|---|---|---|
| `useVisualizerSettingsStore` | SmartBeatSettingsCard / BeatEffectsGroup | 转发到本地 store（`smartBeat`、`handleSetSmartBeat`），两个原卡片零改动可用 |
| `modelAvailability` | BeatEffectsGroup | `modelsPresent()` 返回全 false；订阅 no-op（webview 里没有模型文件，等价于 Folia 缺模型时的降级表现） |
| `useSmartBeatAvailability` | SmartBeatSettingsCard | 返回 `'ready'`（与 Folia 桌面版开着模型的形态一致；网页内实际不跑模型，见 §7） |
| `usePlayerChromeSettingsStore` | VisPlaygroundSettingsPanel | `{enablePlayerPageNativeBlur:false, playerChromeVisibilityMode:'auto'}` |
| `useVisualizerAssetStore` / `useStatusMessageStore` | monet / cappella / tempera 面板 | 空资产包、无消息（上传能力降级） |
| `backgrounds/registry` | 背景 tab | 6 个内置背景 entry 壳，`renderSettingsPanel` 直接渲染 Folia 真卡片 |
| `preview/BackgroundPicture` | 背景 tab | Folia glyph fallback（深色卡片 + 模式字形） |
| `folium{Visualizers,Tunings,Backgrounds,Runtime,MissingEntries}` | 设置面板的 mod 扩展点 | 空 registry（无 Folium mod） |
| `localMetadataWorkerClient` / `lyrics/workerClient` / `lyrics/parserCore` / `services/db` / `localCoverAssetService` / `localMusicService` | tempera/monet 面板的图片上传链路 | no-op（切断 worker/IndexedDB/music-metadata 依赖，避免把 Electron 侧能力带进 bundle） |
| `temperaImageArchive` / `TemperaImageLayerDialog` | tempera 面板 | 面板可渲染；添加图片是空实现 |

> 全部桩都按**被导入的真实导出签名**实现（例如 `modelsPresent` 是真函数而不是对象、
> `temperaImageArchive` 导出同名 class 与函数），否则 React/Three 侧会在运行时炸掉。

## 4. 设置树 schema

> **注入成员（不属于本快照）**：设置树顶层还有几个**由插件写入、页面只读**的成员，本页面的 zustand
> store 不持有、不回写、不持久化 —— `systemFonts`（AWT 枚举的系统字体）、`transitionAnimation`、
> `verboseLog`、`previewAnimation`、`showProblemButton`、`showPlaybackBarLegacy`（迁移来源）。
> 所有权在插件侧的配置页（三个 config 文件），页面只是读者。契约见
> [`docs/protocol.md`](protocol.md) §4。

`SettingsSnapshot`（`src/model/settings.ts`）是 UI 与宿主之间持久化的唯一结构，字段名 = Folia 存储键：

```jsonc
{
  "version": 1,
  "styleId": "sonnet",                 // visualizerMode；17 个之一
  "smartBeat": {                       // 必须始终是对象；写成 true 会让面板崩（smartBeat.effects[...]）
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
  "lyricMotion": 0.8,                  // 0.5–1.2（树里已有；本窗口暂无控件）
  "textureResolution": 1.5,            // 0.5–4.0，0.25 步进（样式面板内另有 per-style 同名值）
  "showPlaybackBar": true              // v0.4.17：页面拥有的字段，见 §4.1.3
}
```

范围与语义（面板内实际控件）：

| 键 | 范围 / 步进 | 控件位置 |
|---|---|---|
| `textureResolution`（sonnet/tempera/lumiere tuning 内） | 0.5–4.0，step 0.25，`times` 格式 | 渲染质量 → 纹理分辨率 |
| `cameraIntensity` / `textMomentum` | 0–2，step 0.05，`times` | 动态与构图 |
| `smartBeat.effects[id].strength` | 0–2，step 0.05，`times`，默认 1 | 动感效果 → 强度 |
| `appearance.fontScale` / `subtitle.subtitleFontScale` | 0.85–1.4，step 0.05，`percent` | 字体/字幕 tab |
| `appearance.fontWeight` / `subtitle.subtitleFontWeight` | 100–900，step 10（null = 自动） | 字体/字幕 tab |
| `appearance.visualizerOpacity` / `subtitleOverlayOpacity` | 0.2–1，step 0.05，`percent` | 字体/字幕 tab |
| `lyricMotion` | 0.5–1.2 | 树里字段，窗口暂无控件 |

- 未知键透传：`applySnapshot` 只覆盖已知字段（`styleTunings` 浅合并），插件侧未来加键不会丢。
- 远端写入：`bridge.on('settings')` / `getSettings()` → `applySnapshot`；本地改动 → 节流
  `setSettings(snapshot)`（≤10Hz，值未变不发）。
- `reset` 语义与 Folia 一致：每个 tab 的「默认」按钮重置该 tab 范围内的一切（样式 tuning →
  `DEFAULT_*_TUNING`；字体/字幕 → Folia 默认值；背景 → 该背景 tuning 默认值），无内容可重置时
  disabled。

### 4.1 SPW 配置页入口清单（`preference_config.json`）

SPW「模组管理 → 配置」里的这一页由 `spw-folia/src/main/resources/preference_config.json` 声明，
**三个组，每组一个 config 文件**（按「调观感 / 排查问题 / 求助」三个用途分开）：

| 组标题 | config 文件 | 用途 | 条目 |
|---|---|---|---|
| 播放页 | `config.json` | 调观感 | 打开过渡动画、歌词样式预览动画、显示问题反馈按钮 |
| 诊断与日志 | `diagnostics.json` | 排查问题 | 详细日志 |
| 支持与反馈 | `support.json` | 求助 | 出现问题 |

| 组 | 类型 | key | 标题 | 默认 | 作用点 |
|---|---|---|---|---|---|
| 播放页 | `switch` | `transitionAnimation` | 打开过渡动画 | 关 | 宿主 **`--no-curtain`**（关闭时才传）：页面按 `splash=0` 导航，不装上游开屏 |
| 播放页 | `switch` | `previewAnimation` | 歌词样式预览动画 | **开** | 设置树顶层 `previewAnimation` → 页面 `usePreviewAnimation()` → 为假时货架走 `ShelfStatic`（只画简约字形，**一个渲染器 chunk 都不加载**）；为真时走 `ShelfLiveView`（真实渲染器小图 + 磁盘缓存）。见 §4.1.4 |
| 播放页 | `switch` | `showProblemButton` | 显示问题反馈按钮 | **关** | 设置树顶层 `showProblemButton` → 页面 `useShowProblemButton()` → 为假时右上角救生圈按钮与其面板**都不挂载** |
| 诊断与日志 | `switch` | `verboseLog` | 详细日志 | 关 | 宿主 `--verbose-log`：页面导航 / console / 卡顿采样写进日志 |
| 支持与反馈 | `button` | `on_click: FoliaPlugin.onReportProblem` | 出现问题 | — | 环境自检 + 预填反馈 |

配置页只使用 `switch` / `button` 两种控件。

**已删除：「帧率」**（`key: frameRate`，`type: "list"`）。默认不限帧率 = 跟随屏幕刷新率，而上游
`frameRateLimiter.ts` 的 `-1 ms` 容差让每个档位都达不到标称值（120 Hz 屏上 90 档实际只有 60）。
留一个「选了也不准」的选项不如删掉，于是整条链路删除（配置项 + Kotlin 读取 + 宿主 cap 注入 +
Shim 写 localStorage）。宿主仍**接受并忽略**旧的 `--frame-rate` 参数，只是为了让带旧参数的插件包
还能正常 spawn。

#### 4.1.1 「详细日志」换组 = 换存储文件，所以要带旧值回退

SPW 的 `ConfigManager.getConfig(name)` 是**按 config 文件名分别存取**的，每组一个 `ConfigHelper`。
所以把「详细日志」从「播放页」移到「诊断与日志」，对用户只是换了个位置，对存储却是**换了一个文件**
（`config.json` → `diagnostics.json`）：新文件里当然没有该键，直接 `get(key, false)` 会拿到默认值 ——
用户明明开着详细日志，升级后静默变回关闭。

`FoliaConfigGroups.readBoolean()` 做**旧值回退 + 一次性迁移**：

1. 新文件里有这个键 → 以它为准；
2. 没有 → 回退读旧文件里的同名键；
3. 真读到旧值 → **立刻写进新文件**并落盘，迁移只发生一次，之后只认新文件。

第 3 步是关键：只回退不迁移的话，两处都能改值就永远说不清谁是真源。迁移留日志
`config migrated verboseLog=… from config.json to diagnostics.json`（写失败带
`(write failed; will retry next read)`）。

> 「键是否存在」不能用 `get(key, default)` 判定（区分不出「不存在」和「存在且等于默认值」），
> 实现用一个不可能与真实键冲突的 String 哨兵做类型探测。

#### 4.1.2 「显示问题反馈按钮」的口径

- 控制播放页**右上角的救生圈按钮**（`data-spw-chrome="problem-report"`，`LifeBuoy` 图标）及其诊断面板。
- 关闭时按钮**不渲染** —— React 根本不挂载，不是 CSS 隐藏，因此也不上报 hit region
  （鼠标穿透模式下不会留一个点不到的死区）。
- 同时关掉该按钮的键盘/面板联动：按钮不在时不监听它的 ESC，面板若开着也随开关一起关掉。
- **为什么默认关**：它会遮挡画面右上角。而「播放窗口打不开」这种最需要求助的场景，配置页
  「支持与反馈 → 出现问题」按钮仍然可用 —— 那正是那个按钮存在的理由。

#### 4.1.3 「显示播放条」已迁移到播放页（v0.4.17）

它现在是**页面自己 settings 树**里的字段（`model/settings.ts` 的 `showPlaybackBar` /
`setShowPlaybackBar`），持久化走页面既有的「改动 → emit → 插件写盘」链路。

- 入口：播放画面右下角按钮（`data-spw-chrome="player-background"`）点开的面板里的一行 switch
  （`data-spw-chrome="playback-bar-row"`，`role="switch"` + `aria-checked`），与「播放页透明背景」
  同一面板、**无条件常显**（不随透明开关显隐）。
- 为 `false` 时底部播放控制条（`chrome/playback/PlaybackBar.tsx`）**整个不挂载**，连热区一起消失；
  **但菜单按钮本身无条件挂载** —— 它是唯一的回去路径，关掉播放条后仍可点开再打开。
- 老用户迁移：插件仍读旧 `config.json` 的 `showPlaybackBar`，以设置树顶层成员
  **`showPlaybackBarLegacy`** 下发，页面只在「树里还没有该键」时用它播种一次，之后永远以树为准。

#### 4.1.4 「歌词样式预览动画」+ 小图缓存

货架那 17 格小图（`data-spw-shelf` 里每个 `[data-value]`）默认是**真实渲染器**画的：上游
`LyricStylePicture` → `LivePicture` 逐格串行把样式画到一张窗口大小的舞台上，冻结成静态图，
指针停留 280ms 才让那一格跑起来。这条路很贵（1920×1200、DSF 1、宽 7 列实测）：

| 场景 | 出图耗时 | 峰值造图并发 | 新增样式渲染器 chunk |
|---|---|---|---|
| 冷启第一次打开设置 | 24.3 s（17 格串行，均 1.37 s/格，最慢 nebbia 3.9 s） | 1 | 19 |
| 同页关掉再打开 | 0.05 s | 0 | 0（上游 `pictureImages` 的页内 Map） |
| 重启进程后再打开 | 23.0 s | 1 | 19 |
| **有磁盘缓存后重启再打开** | **0.37 s** | **0** | **0** |

> 两个口径别混：`19` 是**样式渲染器** chunk（`assets/Visualizer*`，验收按 resource entry 求差集）；
> 基线测量另报过「81 个 chunk」，那是 `settings/assets/` 下**全部**新加载资源（含 three/pixi 等共享库
> 与 shell）。缓存命中后两组都是 0 + 1（`ShelfLiveView` 这个 lazy 壳本身），所以验收把「渲染器」与
> 「壳」分开断言。

**① 磁盘缓存（`src/model/previewImageCache.ts`）**。上游 `preview/pictureImages.ts` 那只 Map 只活在
页面生命周期里，重启进程就没了。这一层把已经冻结好的静态图（canvas 全部编码成 `<img>`）写进
IndexedDB，下次开窗口直接贴出来 —— 贴进的是**上游那只 Map**（`keepImage`），于是 `LivePicture`
一上来就认为「这张图已经有了」：不排队造图、不拉渲染器 chunk、不起 rAF；指针停留时照旧走上游既有的
`image → live` 路径挂真渲染器。**没有改一行上游代码。**

- 库/表/键：`spw-folia-preview` / `pictures` / keyPath `key`（这三个名字是验收脚本的取证口径）。
- 键 = `v1|` + 上游 `stylePictureKey(...)` 原始串。**复用上游那个函数而不是自己拼字段清单**
  （它已经把 mode/stage/theme/isDaylight/sample/fontScale/tuning/mod 全写进 JSON），但**不传三个
  上传图参数**：上游会把上传图对象编码成 WeakMap 序号，每次重启都不一样，拿它做磁盘键永远不命中。
  上传图在场时整条缓存直接关掉（`uploadsBlockCaching`）。
- canvas 用 **WebP q0.85**（不支持则回落 PNG）。PNG 下 hanabi 575 KB / machi 618 KB / pendolo 563 KB
  会撞单条上限被静默跳过，而它们恰好是最慢的三格；WebP 后 17 格合计 1.47 MB → 298 KB。
- 上限 32 条 / 8 MB / 单条 512 KB，按 `savedAt` 淘汰最旧。读写失败一律静默回落现场造图。
- 开局 `making=false` 等磁盘查完（另有 1.2 s 兜底）：否则上游 `FIRST_IMAGE_REST_MS`（450 ms）之后
  第一格就开造了，缓存命中成空话。

**② `previewAnimation` 开关（默认开）**。关掉时货架换成 `src/model/ShelfStatic.tsx`：每格只画
`modeGlyphs` 的 24×24 线性字形（与随机格 Shuffle 图标同一手法），**没有 hover 动画**。

关键实现点在**模块加载层面断链**，不是「渲染了但不显示」：

- `ShelfLive.tsx` 是极轻的路由，实时版用 `React.lazy(() => import('./ShelfLiveView'))` 拉。
  开关关时那个工厂函数一次都不跑 → 那块 chunk 不下载 → `LyricStylePicture → LivePicture → registry
  → entry.render` 整条链不存在。入口 `settings-ui.js` 因此从 917 KB 降到 697 KB。
- 硬证据（真机 resource entries，匹配 `/Visualizer|ShelfLiveView/`）：**关 = 0 条，开 > 0 条**。
- `shelfShared.tsx` / `shelfDiskState.ts` 的拆分也是为这个：静态路径不能碰到实时版的 import 链。
- 热切换双向都成立（关→开才第一次调用 lazy 工厂；开→关实时版卸载，渲染器/rAF/WebGL context 按上游
  自己的 cleanup 释放），不需要重开窗口。

**探针契约**（`window.__SPW_SHELF_STATE__()`，验收脚本按它取证，改字段名会让门禁 FAIL）：

| 字段 | 含义 |
|---|---|
| `tiles` / `pictures` / `images` / `making` / `running` | 沿用上游 `data-picture` 标记的计数 |
| `chosen` / `glyphs` / `runningValue` / `runningPicture` | 同上 |
| `animated` | 货架是实时版（= `[data-spw-shelf-mode] === "live"`） |
| `cached` | 当前显示「磁盘恢复图」的格子数；**static 模式恒 0** |
| `pending` | 还没有图、也还没在造图的**样式格**数（随机格不计）；**static 模式恒 0** |

验收：`node site/tools/check-site.mjs` 里的货架断言 + 手工观察；原独立门禁
`verify-preview-animation-switch.mjs` 已于 v0.4.18 删除（该开关自 v0.4.16 起未变动，
门禁只留本次改动相关的范围，见 `packaging/tools/verify-all.mjs` 头部）。

### 4.2 tuning 合并：默认值打底，持久化覆盖

`src/model/mergeTuning.ts`。**必须打底，不能整体替换。**

Folia 的 `defineVisualizerTuning(...).apply` 是 `(props, tuning) => ({...props, xxxTuning: tuning})`
—— 它把拿到的 bag **原样存起来**，从不跑样式自己的 `resolve()`。样式渲染器若乘上一个 bag 里没有的
键，结果就是 `undefined` → `NaN`，而 `NaN` 的 `position`/`alpha`/`scale` 不抛异常：它静默丢掉整个
composition。Folia 0.7.25 给 `TemperaTuning` 新增 `depthOfField` / `depthPan` / `glyphDepth` 时，
所有早于该版本持久化的设置树都缺这三个键，凝彩就这样退化成了「只剩背景颗粒」。

所以持久化层按样式做「默认值在下、持久化值在上」的合并：

- **浅合并是正确的粒度**：tuning 值是扁平标量或数组（`layerImages`）；数组出现在树里时整块替换默认值，
  **绝不逐元素展开**，否则用户的图片会被默认的 `[]` 补齐。
- 树里没有的键回落到 `defaults` —— 这就是整个修复：早于某个上游 tuning 键存在的树，合并后仍是完整 bag。
- 树里没有某个样式的条目时才参考当前内存值（`current`），所以「载荷漏了一个样式」不会把用户对该样式
  的实时编辑重置回默认。
- 树里有、本 build 的默认值里没有的样式，原样带过 —— 更新版本的页面或改过的 build 不能因为本 build
  不认识那个键就丢数据。

该文件**刻意做成纯函数**（无 import、无副作用），好让 Node 侧工具与门禁直接加载它、驱动真实的
合并逻辑（`verify-tuning-merge.mjs` 已删，纯函数这一约束仍然有效：它让合并逻辑可被任意脚本驱动）。

## 5. 元数据（tuning）与样式面板

- 样式面板拿到的 `settings` 是 Folia 的 `VisualizerTuningSettings` 袋
  （`{sonnetTuning, temperaTuning, …, latentBackgroundTuning, …, smartBeat}`，由
  `selectTuningSettings` 从快照的 `styleTunings`/`backgroundTunings` 组装）。
- `styleDraft = { tuning: styleTunings[styleId], change: setStyleTuning, reset: resetStyleTuning }`，
  与 Folia `useTuningDrafts` 的 `StyleDraft` 接口一致；拖动滑杆时 `onSliderPointerDown/Commit` 交给
  面板自己的提交逻辑（`panelRows.SliderRow` 只在 release 时提交）。
- 每个样式的默认值全部来自 Folia `src/types.ts`，见 [`docs/folia-spec/tunings.md`](folia-spec/tunings.md)；
  `model/settings.ts:STYLE_TUNING_DEFAULTS` 直接引用同一批常量。

## 6. 配置发布器（publisher）

文件：`src/publisher/config.ts`、`src/publisher/deriveTheme.ts`、`src/useConfigPublisher.ts`。

- 输入：本地 store 快照、`__SPW_FOLIA__.inputs.track/lyrics/state`（事件增量也在
  `bridge.on('track'|'lyrics'|'state')` 里收）、`state` 的播放状态用于时钟换算、主题。
- 输出：`ObsBrowserSourceConfig`（Folia `src/types/obsBrowserSource.ts`），经
  `__SPW_FOLIA__.pushConfig(config)` → 宿主直接派发 Folia 的 `config` 事件，视觉器即时更新，
  不重载页面。**页面侧构建、宿主只转发**。
- 字段映射（`publisher/config.ts:buildConfig`）：
  - `activePlaybackContext:'main'`、`stageSource:null`、`hasTrack`、`song{id,name}|null`、
    `songArtist/songAlbum/coverUrl`、`lyrics`（Folia `LyricData`）、`theme`/`subtitleTheme`、
    `isDaylight`、`seed`（曲目 id 兜底）。
  - `visualizerMode` ← `styleId`；`visualizerTunings` ← 除 `still` 外全部 `styleTunings`
    （渲染器按 `visualizerTunings[mode]` 应用）。
  - `background` ← `backgroundMode` + `commonBackground` + 各背景 tuning 合并默认值。
  - 外观：`lyricsFontScale`/`subtitleFontScale`（clamp 0.85–1.4）、`visualizerOpacity`/
    `subtitleOverlayOpacity`（clamp 0.2–1）、`staticMode:false`、`hideTranslationSubtitle`、
    `showSubtitleTranslation = !hide && contentMode!=='none'`、`subtitleContentMode`、
    `subtitleOverlayBackground` 等。
  - `updatedAt`：每次推送加时间戳；**去重签名**用去掉 `updatedAt` 的 JSON，签名不变不推。
- 歌词：插件给的每行 `{startMs,endMs,main,sub?,cells?}` → Folia
  `Line{words,startTime,endTime,fullText,translation}`；没有逐字时间时按字符均分回退
  （视觉器逐字样式依赖 `words`）。
- 节流：`CONFIG_MIN_INTERVAL_MS=100`（≤10Hz），拖动过程中合并，释放后 `flush()` 立即推一次；
  窗口/曲目变化 0.35s 跳变阈值与 Folia `useObsBrowserSourcePublisher` 一致。
- 主题派生（`deriveTheme.ts`）：封面 URL → `48×48` canvas 采样 → 像素均值做
  `backgroundColor`/`primaryColor`、最饱和桶做 `accentColor`，亮度阈值决定 `isDaylight` 与文字色；
  无封面/加载失败回退深色主题 `#09090b / #f4f4f5 / #71717a`。

## 7. 与 Folia 原版的差异（维护时须知）

1. **智能动感模式默认 ON**：与 `packaging/testdata/default-settings.json` 一致；Folia 应用自身的
   stored default 是 `false`（`types.ts`），本工程按设置树取 ON。
2. **模型/播放能力降级**：`useSmartBeatAvailability()` 桩返回 `'ready'`（为了不显示「仅桌面版可用」
   提示）；实际 webview 内没有 `beat_this`/`htdemucs` 模型，节拍效果不会真正驱动动画
   （视觉器在 `isBeatFxReady()` 为假时像素不变）。开关/强度照常保存进设置树。
3. **上传类控件降级**：自定义字体**已可用** ——「自定义」磁贴可导入字体包
   （`.ttf/.otf/.woff/.woff2`，单个 ≤ 50 MB，存 IndexedDB 并用 `FontFace` 注册）或从插件下发的
   `systemFonts`（AWT 枚举，最多 400 个家族，不持久化）里选，不走 no-op 桩。仍然降级的是 tempera
   画布图片、monet 封面/肖像、cappella 自定义表情/头像 —— 按钮存在但为 no-op。
4. **Folium mod 扩展卡片**不渲染（无 mod）；`背景类型 → 嵌入/空` 的动态图片列表为空。
5. **背景缩略图**是 Folia 无图时的 glyph fallback。
6. **纹理分辨率默认显示 1.50x**（Folia 默认 1.5）。
7. 注入层全局 CSS（kit.css/Tailwind）会作用到整个页面，但每次打开前只在 head 注入一次
   `<style data-spw-settings-ui-css>`，与 Folia 页面自身的 Tailwind 共存（选择器均为 kit 前缀
   `st-` / CSS 变量，实测无冲突）。
8. 字体：`Folia Noto Serif SC` 仍由 Folia 页面自己的 `@font-face` 提供；本 bundle 不额外拉字体，
   离线时回退系统衬线栈。
9. **AGPL-3.0**：本 bundle 编译了 Folia 的 React 组件（AGPL 代码），分发时必须随附相应源码/构建脚本
   与许可证声明（见 [`docs/licensing.md`](licensing.md)），且不得以专有条款再授权。

## 8. chrome 契约（⚙ / ESC / 指针）

- `__SPW_FOLIA__.ui = { isSettingsOpen(), openSettings(), closeSettings() }`：
  `bridge.ts:registerSettingsUiController()` 在 Shim 建好的对象上**增补** `ui` 字段（不替换对象），
  同时保留 `__SPW_FOLIA_UI__` / `__SPW_FOLIA_SETTINGS_UI__` 兼容名。
- ⚙ 按钮：`.spw-chrome-btn`（`src/app.css`）固定右上 24/24，40×40 圆钮，
  `rgba(0,0,0,.28)` + `backdrop-filter:blur(12px)` + 1px 白 16% 描边 + 白色 lucide `Settings` 20px；
  `pointermove/pointerdown/keydown` 重置 2.5s 空闲计时，超时与光标一起淡出，关闭覆盖层后重新出现。
- **指针事件必须显式开启**：注入挂载根 `#spw-settings-ui-root` 是 `pointer-events:none` 的点击穿透层，
  好让关闭状态下的点击落到下面的 Folia 视觉器；所以 ⚙ 必须在 CSS 里显式 `pointer-events:auto`，
  否则 `document.elementFromPoint()` 与真实鼠标命中都会被 Folia 页面元素截走 —— 合成 `.click()` 能过、
  真实点击失效。按钮隐藏态 `[data-visible='false']` 恢复 `pointer-events:none`，保证空闲时点穿透。
  覆盖层打开时其容器自身 `pointer-events:auto` 接管整屏。
- 覆盖层：打开时 `data-spw-settings-ui` 容器 `pointer-events:auto` 且 `display:block`；
  **组件不卸载**（隐藏时 `display:none`），再次打开不重挂载、预览帧不闪。
- ESC：打开时在 `window` **capture** 阶段监听，命中后 `preventDefault()+stopPropagation()+close()`；
  关闭时不注册该监听，ESC 直接落到宿主（宿主负责关窗）。
- 宿主命令 `command open-settings` / `close-settings` 由 Shim 转成 `ui` / `settingsUI` 事件触达本页
  （`bridge.ts` 同时监听两种事件名），也可直接
  `ExecuteScriptAsync("__SPW_FOLIA__.ui.openSettings()")`。
- 回归脚本：`scripts/host-ui-check.mjs`（真实宿主 + 注入 bundle，断言 ⚙ 指针命中、ESC 归属、
  重开不重挂载、`host/page errors = 0`）。


## 9. 左侧大预览

左侧大预览是**同源 iframe 里的真实 Folia 渲染器**，逐帧镜像播放页此刻收到的 config 与真实时钟。
机制、消息契约、子帧垫片 `PreviewShim.js`、旧 Service Worker 残留、开屏遮罩处理、组装步骤与
17 项真机断言全部见 [`docs/live-preview-iframe.md`](live-preview-iframe.md)。

与本节相关的两条约定在那边也必须记住：

- `Shim.js` 的 `deliver('config', data)` 是播放页收到 config 的**唯一入口**，它同时维护
  `lastConfig` 并通过 `bridge.lastConfig()` 暴露；**不要**在设置页用 `buildConfig()` 自己构造
  预览 config。
- 预览框的尺寸靠「iframe 固定 1920×1080 + CSS transform 缩放」保证与全屏播放同构，
  不要改成按容器尺寸排布。

## 10. Bundle 组装与验收

`web/` 的组装（`packaging/tools/stage-web.mjs`：preview.html 生成、剥开屏、preview-shim 注入、
本地安装同样走这条流程）见 [`docs/live-preview-iframe.md`](live-preview-iframe.md) §9。

设置岛自己的验收入口：

- `packaging/tools/verify-all.mjs` —— 按改动范围跑门禁（`--all` 跑全部；未选中的项显示为 SKIP 并给出原因）。
- `packaging/tools/verify-click-zones.mjs` —— 点击分区 / 幽灵层（DOM 契约、命中、拖动、控件不被抢）。
- `packaging/tools/verify-layout.mjs` —— 打包产物端到端（`consoleErrors=0`、canvases、货架格数）。
- `packaging/tools/verify-live-settings-payload.mjs` —— 设置树单行载荷。
- `packaging/tools/verify-playback-bar-switch.mjs` —— 「显示播放条」开关。
- `poc/settings-ui/scripts/host-ui-check.mjs` —— chrome/ESC/指针命中契约。
- `poc/settings-ui/scripts/diag-real-preview.mjs` —— 真机预览断言（清单见
  [`docs/live-preview-iframe.md`](live-preview-iframe.md) §10）。

## 11. 已知限制

- **上传类控件降级**：tempera 画布图片、monet 封面取色/肖像、cappella 自定义表情/头像 —— 控件在、
  点击 no-op（`src/stubs/` 桩）。需要宿主/插件提供文件选择与 asset 通道后才能替换对应桩
  （接口已按 Folia 形状保留）。
- **节拍效果只有 UI**：`beat_this` / `htdemucs` 模型不在 webview 内，开关与强度照常写进设置树，
  但视觉器不会真正随拍动画。
- **全局动感强度 `lyricMotion`（0.5–1.2）** 已在设置树透传，但本窗口暂无对应控件。
- **覆盖层遮住视觉器交互**：打开时 `pointer-events:auto` 覆盖全屏，播放器点击被挡住
  （Folia 自身设置窗口也如此），关闭即恢复。
- **DSF/视口**：生产全屏两栏成立；窗口化到窄尺寸时 Folia 自身响应式会变单栏，属预期行为，不做特判。
