# 注入式设置 UI 实现说明（task-5 交付）

> 状态：v1 完成并可注入真实 Folia 页面运行（WebView2 宿主实测）。
> 当前开发版本 **v0.4.11（未发布）**；**最后发布版本是 v0.4.6**。本文里带「v0.4.7/v0.4.8/v0.4.9/v0.4.10」
> 字样的段落描述的是**代码现状与改动批次**，不代表这些版本发布过。
> 产物：`poc/settings-ui/dist/settings-ui.js`（单文件、CSS 内联）+ `dist/thumbs/*.jpg`（17 张真实渲染帧）。
> 参考规格：`docs/folia-spec/settings-ui.md`（1:1 复刻依据）、`docs/protocol.md` §3–§5/§7.5（桥/配置/chrome 契约）。
> 上游：Folia v0.7.25（AGPL-3.0），`work/folia/folia-major-main`。

## 0. 结论

- **不是清洁室重写**：设置窗口直接复用 Folia 自己的 React 组件（`StudioWindow` / kit / `VisPlaygroundSettingsPanel` / 15 个样式设置面板 / 背景卡片 / zh-CN 文案），Vite 用别名 `@/` 指向 Folia 源码，只有一个 ~240 行的适配层（store、bridge、publisher、Stage 预览、17 个 registry entry 壳——其中 15 个带面板，`cadenza`/`still` 无面板走空态）。
- 在真实宿主里验证通过：注入后 0 页面错误，3320×2000 @DSF1.8 全屏下窗口为两栏布局（见 §8 证据）。
- §7.5 chrome 契约已实现并实测：`__SPW_FOLIA__.ui` 三个方法、⚙ 按钮（鼠标静止 2.5s 淡出）、覆盖层打开时 capture 阶段吞掉 ESC、关闭时 ESC 交还宿主。
- 差异（§7）集中在两类：**没有 electron/Node 能力（上传类控件降级）** 与 **预览用静态真实帧代替实时组件渲染**；视觉与文案与 Folia 一致。

## 1. 架构

```text
Folia dist/index.html（真实播放页，OBS 模式）
  ├─ Shim.js            ← webview-spike 提供：__SPW_FOLIA__ 桥 + 事件 + pushConfig
  └─ settings-ui.js     ← 本 bundle（宿主注入；CSS 已内联进 JS，仅一个 <script>）
        └─ React root → <App/>
              ├─ ⚙ chrome 按钮（overlay 关闭时可见）
              ├─ StudioWindow（Folia 原组件：1240×780 窗口、dim/blur 背板、header）
              │    ├─ Stage（预览帧 + 暂停钮 + 样式 17 PictureGrid）
              │    └─ VisPlaygroundSettingsPanel（Folia 原组件：4 个 tab + 默认重置）
              ├─ zustand store（model/settings.ts）：唯一设置真源
              ├─ bridge.ts：__SPW_FOLIA__ 适配 + settings 往返 + __SPW_FOLIA__.ui
              └─ useConfigPublisher → publisher/config.ts → pushConfig（≤10Hz、去重）
```

没有 iframe、没有第二个 WebView2、没有 HTTP 请求：bundle 通过宿主虚拟主机 `https://spw-folia-settings.local/` 注入，运行在 Folia 页面自己的 JS 上下文里。

## 2. 构建与注入

```bash
cd poc/settings-ui
npm install          # 或 pnpm install
npm run thumbs       # 采集 17 张样式帧 -> public/thumbs/*.jpg（首次/换上游后必跑）
npm run build        # = vite build，产物在 dist/
```

- 产物：`dist/settings-ui.js`（单文件，含内联 CSS 与全部 React 组件；v0.4.1 时期构建 2,237,591 字节 / gzip 705,576 字节，**现随 17 样式与上游 0.7.25 变化，未重新登记**）、`dist/thumbs/`（17×jpg，由 `public/thumbs` 原样拷贝）、`dist/assets/cacheUsage.worker-*.js`（Folia 侧 worker chunk，浏览器按需加载，可忽略）。
- **`public/thumbs/` 是构建输入，不在版本库里**（`.gitignore` 掉）：干净检出时没有 `public/`，`vite build` 仍然成功但产物里一张 thumbs 都没有 → 注入后货架 tile 全是浏览器破图图标（当前 17 个）。所以 v0.4.7 起加了两道硬闸：`vite.config.ts` 的 `requireStyleThumbs()`（writeBundle 阶段缺图直接 throw）与 `packaging/tools/stage-web.mjs`（暂存阶段缺图直接 throw）。重新采集用 `node scripts/make-thumbs.mjs`（真实宿主 + 真实 Folia 渲染器，每种样式截一张 3200×2000 帧，中心裁 16:10 后存 1440×900 JPEG q82）。
- 入口配置（`vite.config.ts`）：`base: './'`、`rollupOptions.input.settings = src/main.tsx`、`entryFileNames: 'settings-ui.js'`、`cssCodeSplit: false`、`inlineCssIntoEntry()` 插件把 CSS 合并后以 `<style data-spw-settings-ui-css>` 注入，保证宿主只加一个 script 标签也能带样式。
- 宿主注入（webview-spike 的实现）：
  ```bash
  spw-folia-host.exe --bundle <folia-dist> \
      --settings-dir D:\输出目录\dsh2\poc\settings-ui\dist \
      --settings-entry settings-ui.js
  ```
  宿主把该目录映射为 `https://spw-folia-settings.local/`，在 Shim.js 之后注入 `<script type="module" src="…/settings-ui.js">`。
- 开发：`npm run dev` → `http://localhost:18090/dev.html`（假桥，窗口默认打开，便于截图/调试）；`index.html` 是同一 bundle 的注入入口壳。
- 脚本：`scripts/shot.mjs`（dev 4 tab + chrome 截图）、`scripts/host-inject.mjs`（真实宿主注入 + 截图；`--fullscreen` / `--no-open` / `--force-dsf` 可选）、`scripts/host-ui-check.mjs`（§7.5 契约实测）、`scripts/check-reset.mjs`（默认重置检查）。

### DSF / 视口注意

- 生产全屏：3200×2000@DSF1.8 机器的 CSS 视口约 **1778×1111**（>1024），Folia `StudioWindow` 的 `lg:` 两栏布局成立，与截图 1 一致。
- 1600×1000 窗口 @DSF1.8 的 CSS 视口只有 888×555，会退化成单栏——**这是 Folia 自身的响应式行为**，不是 bug。调试截屏可用 `--force-dsf 1`（仅 smoke test；生产不要强制）。
- 页面无 `devicePixelRatio` 特判；视觉器本身按 Folia 的 DPR 逻辑渲染。

## 3. 复用 vs 重写 vs 桩（Lead 要求的清单）

### 3.1 直接复用（未改一行 Folia 源码）

| 复用项 | 路径（相对 `work/folia/folia-major-main/`） |
| --- | --- |
| 窗口骨架 + dim/blur + header + 两栏 grid | `src/components/shared/StudioWindow.tsx`（含 `StudioColumnBody`、`settingsTokens()`） |
| 设置控件 kit（Group/Row/Slider/Toggle/Tabs/Segmented/PictureGrid/Select/Button/Reveal/Value/Tooltip…） | `src/components/modal/settings/kit/*` |
| 设置面板（4 tab、默认重置、样式面板装配） | `src/components/visualizer/window/VisPlaygroundSettingsPanel.tsx` |
| 行组件与格式化 `percent()`/`times()`、SliderRow 拖动提交语义 | `src/components/visualizer/panelRows.tsx` |
| 智能动感模式卡片 | `src/components/visualizer/SmartBeatSettingsCard.tsx` |
| 动感效果组（推镜裂光/水镜涟漪/仿真鼓面） | `src/components/visualizer/BeatEffectsGroup.tsx` + `src/services/beatFx/beatEffects.ts` |
| 样式设置面板 | `settings.tsx` 内各 entry 的 `renderSettingsPanel`（classic/partita/fume/cappella/tilt/diorama/claddagh）+ `sonnet/`、`tempera/`、`lumiere/`、`hanabi/`、`machi/`、`nebbia/`、`monet/`、`pendolo/`（cadenza/still 无面板 → 空态“这个样式没有参数”）。**现行 17 样式里 15 个带面板** |
| 背景设置卡片（通用/隐现/莫奈/漫游/空） | `src/components/visualizer/backgrounds/{common,latent,monet,nomand,sora}/*SettingsCard.tsx` |
| 全部默认值（tuning、smartBeat、背景 tuning、阈值） | `src/types.ts` 的 `DEFAULT_*_TUNING` / `DEFAULT_SMART_BEAT_SETTINGS` 等 |
| 中文文案 | `src/i18n/locales/zh-CN.ts`（纯数据，直接进 i18next resources） |
| 字体栈/字重/预览文案 | `src/utils/fontStacks.ts`、`panelRows.tsx`、`PreviewPlaceholder` 文案键 |

### 3.2 本工程重写（适配层，~240 行）

- `src/model/settings.ts`：zustand store（Folia 持久化层替换为内存 + 桥），字段/默认值镜像 Folia 与 `packaging/testdata/default-settings.json`。
- `src/model/styles.tsx`：17 个样式 entry 壳（`mode/order/labelKey/labelFallback/thumb/renderSettingsPanel/beatEffects/ownFontSizeNoticeKey`），顺序与 `registry.order` 一致 → 网格（17 样式 + 随机）。
- `src/model/Stage.tsx` / `StylePreview.tsx`：大预览（真实帧 `<img>` + 暂停钮）+ 样式货架 PictureGrid（16:10 tile、选中环、名称）。
- `src/model/theme.ts` / `assetBase.ts`：预览主题（深色 demo 主题）、`--text-primary`、控制卡底色、range thumb class、字体/字号/字重选项数组。
- `src/bridge.ts`：`__SPW_FOLIA__` 契约适配、假桥、settings 往返（getSettings/`settings` 事件/节流 setSettings）、`__SPW_FOLIA_UI__` 与 `__SPW_FOLIA__.ui`、ESC/键盘动作。
- `src/publisher/config.ts` + `deriveTheme.ts` + `useConfigPublisher.ts`：页面侧构建 `ObsBrowserSourceConfig` 并 `pushConfig`（见 §6）。
- `src/mount.tsx`：在 `body` 上创建 `#spw-settings-ui-root`（`position:fixed; inset:0; z-index:2147483000; pointer-events:none`），React root 挂进去；设置 overlay 打开时才接管 `pointer-events`。

### 3.3 桩模块（`src/stubs/`，按 Folia 源码形状实现、只实现被导入的 API）

| 桩 | 被谁导入 | 行为 |
| --- | --- | --- |
| `useVisualizerSettingsStore` | SmartBeatSettingsCard / BeatEffectsGroup | 转发到本地 store（`smartBeat`、`handleSetSmartBeat`），保证两个原卡片零改动可用 |
| `modelAvailability` | BeatEffectsGroup | `modelsPresent()` 返回 `{beat_this:false, htdemucs:false, htdemucs_gpu:false}`；订阅为 no-op（webview 里没有模型文件，等价于 Folia 缺模型时的降级表现） |
| `useSmartBeatAvailability` | SmartBeatSettingsCard | 返回 `'ready'`（截图 1 是桌面版开着模型的形态；注：网页内实际不跑模型，见 §7） |
| `usePlayerChromeSettingsStore` | VisPlaygroundSettingsPanel（原生模糊开关） | `{enablePlayerPageNativeBlur:false, playerChromeVisibilityMode:'auto'}` |
| `useVisualizerAssetStore` | monet/cappella 面板、（tempera 图层面板） | 空资产包（上传能力降级） |
| `useStatusMessageStore` | tempera 图层面板 | 无消息 |
| `backgrounds/registry` | 背景 tab | 6 个内置背景 entry 壳（common/monet/nomand/latent/url/sora），`renderSettingsPanel` 直接渲染 Folia 真卡片；`BackgroundPicture` 用 Folia glyph fallback（深色卡片 + 模式字形） |
| `preview/BackgroundPicture` | 背景 tab | 上述占位的绘制函数 |
| `folium{Visualizers,Tunings,Backgrounds,Runtime,MissingEntries}` | 设置面板的 mod 扩展点 | 空 registry（无 Folium mod） |
| `localMetadataWorkerClient`, `lyrics/workerClient`, `lyrics/parserCore`, `services/db`, `localCoverAssetService`, `localMusicService` | tempera/monet 面板的图片上传链路 | no-op（切断 worker/IndexedDB/music-metadata 依赖，避免把 Electron 侧能力带进 bundle） |
| `temperaImageArchive`, `TemperaImageLayerDialog` | tempera 面板 | 面板可渲染；添加图片弹出的是空实现（见 §7） |

> 说明：全部桩都按**被导入的真实导出签名**实现（例如 `modelsPresent` 是真函数而不是对象、`temperaImageArchive` 导出同名 class 与函数），否则 React/Three 侧会在运行时炸掉。

## 4. 设置树 schema（v1，与 `packaging/testdata/default-settings.json` 对齐）

> **注入成员（不属于本快照）**：设置树顶层还有几个**由插件写入、页面只读**的布尔/数组，本页面的
> zustand store 不持有、不回写、不持久化——`systemFonts`（AWT 枚举的系统字体）、
> `transitionAnimation`、`verboseLog`、**v0.4.10 新增的 `showPlaybackBar`**，以及
> **v0.4.11 新增的 `showProblemButton`**（见 §4.1）。
> 它们的所有权在插件侧的 `preference_config.json`（v0.4.11 起分三个 config 文件），页面只是读者。

`SettingsSnapshot`（`src/model/settings.ts:283`）是 UI 与宿主之间持久化的唯一结构，字段名 = Folia 存储键：

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
  "lyricMotion": 0.8,                  // 0.5–1.2（v1 树已有；本窗口暂无控件，见 §7）
  "textureResolution": 1.5             // 0.5–4.0，0.25 步进（样式面板内另有 per-style 同名值）
}
```

范围与语义（面板内实际控件）：

| 键 | 范围 / 步进 | 控件位置 |
| --- | --- | --- |
| `textureResolution`（sonnet/tempera/lumiere tuning 内） | 0.5–4.0，step 0.25，`times` 格式 | 渲染质量 → 纹理分辨率 |
| `cameraIntensity` / `textMomentum`（`typographyMotion`/`glyphMotion`） | 0–2，step 0.05，`times` | 动态与构图 |
| `smartBeat.effects[id].strength` | 0–2，step 0.05，`times`，默认 1 | 动感效果 → 强度 |
| `appearance.fontScale` / `subtitle.subtitleFontScale` | 0.85–1.4，step 0.05，`percent` | 字体/字幕 tab |
| `appearance.fontWeight` / `subtitle.subtitleFontWeight` | 100–900，step 10（null = 自动） | 字体/字幕 tab |
| `appearance.visualizerOpacity` / `subtitleOverlayOpacity` | 0.2–1，step 0.05，`percent` | 字体/字幕 tab |
| `lyricMotion` | 0.5–1.2 | v1 树字段，窗口暂无控件（后续接入全局动感滑杆） |

- 未知键透传：`applySnapshot` 只覆盖已知字段（`snapshot.styleTunings` 浅合并），插件侧未来加键不会丢。
- 远端写入：`bridge.on('settings')`/`getSettings()` → `applySnapshot`；本地改动 → 节流 `setSettings(snapshot)`（≤10Hz，值未变不发）。
- `reset` 语义与 Folia 一致：每个 tab 的“默认”按钮重置该 tab 范围内的一切（样式 tuning → `DEFAULT_*_TUNING`；字体/字幕 → Folia 默认值；背景 → 该背景 tuning 默认值），无内容可重置时按钮 disabled。

### 4.1 SPW 配置页入口清单（`preference_config.json`）

SPW「模组管理 → 配置」里的这一页由 `spw-folia/src/main/resources/preference_config.json`
声明。**v0.4.11 起重新分组**：从「播放页 + 支持与反馈」两大组改成**三组**，按
「用户调节观感 / 排查问题 / 求助」三个用途分开，每组各自一个 config 文件：

| 组标题 | config 文件 | 用途 | 条目 |
| --- | --- | --- | --- |
| 播放页 | `config.json` | 用户调节观感 | 打开过渡动画、显示播放条、**歌词样式预览动画**（v0.4.16 新增）、显示问题反馈按钮 |
| **诊断与日志**（v0.4.11 新增组） | **`diagnostics.json`**（新文件） | 排查问题 | 详细日志 |
| 支持与反馈 | `support.json` | 求助 | 出现问题 |

逐条清单：

| 组 | 顺序 | 类型 | key | 标题 | 默认值 | 作用点 |
| --- | --- | --- | --- | --- | --- | --- |
| 播放页 | 1 | `switch` | `transitionAnimation` | 打开过渡动画 | 关 | 宿主 **`--no-curtain`**（开关关闭时才传）：页面按 `splash=0` 导航，不装上游开屏 |
| 播放页 | 2 | `switch` | `showPlaybackBar` | 显示播放条 | **开**（v0.4.10 新增） | 设置树顶层 `showPlaybackBar` 布尔 → 页面 `useShowPlaybackBar()` → 为假时 `<PlaybackBar/>` 整体不挂载 |
| 播放页 | 3 | `switch` | `previewAnimation` | 歌词样式预览动画 | **开**（v0.4.16 新增） | 设置树顶层 `previewAnimation` 布尔 → 页面 `usePreviewAnimation()` → 为假时货架走 `ShelfStatic`（只画简约字形，**一个渲染器 chunk 都不加载**）；为真时走 `ShelfLiveView`（真实渲染器小图 + 磁盘缓存） |
| 播放页 | 4 | `switch` | `showProblemButton` | 显示问题反馈按钮 | **关**（v0.4.11 新增） | 设置树顶层 `showProblemButton` 布尔 → 页面 `useShowProblemButton()` → 为假时右上角救生圈按钮与其面板**都不挂载** |
| 诊断与日志 | 1 | `switch` | `verboseLog` | 详细日志 | 关 | 宿主 `--verbose-log`：页面导航 / console / 卡顿采样写进日志（v0.4.11 从「播放页」移入本组，见下） |
| 支持与反馈 | — | `button` | （`on_click: FoliaPlugin.onReportProblem`） | 出现问题 | — | 环境自检 + 预填反馈 |

配置页只使用 `switch` / `button` 两种控件。`list` 曾由 v0.4.9 的帧率项用过一次，现已随该项删除
（见 [`docs/upstream-sync.md`](upstream-sync.md) §10）。

**已删除**：「帧率」（`key: frameRate`，`type: "list"`，v0.4.9 引入、**v0.4.10 整条删除**）。
理由：默认就不限帧率 = 跟随屏幕刷新率，而上游 `frameRateLimiter.ts` 的 `-1 ms` 容差让每个档位都
达不到标称值（120 Hz 屏上 90 档实际只有 60），留一个「选了也不准」的选项不如删掉。技术分析保留在
[`docs/upstream-sync.md`](upstream-sync.md) §10.2（结论仍然有效），删除记录见
[`docs/release-notes-v0.4.10.md`](release-notes-v0.4.10.md)。

#### 4.1.1 「详细日志」换组 = 换存储文件，所以要带旧值回退

SPW 的 `ConfigManager.getConfig(name)` 是**按 `preference_config.json` 里每个 config 的
`config` 文件名分别存取**的，每组一个 `ConfigHelper`。所以把「详细日志」从「播放页」移到
「诊断与日志」，对用户只是同一页面上换了个位置，对存储却是**换了一个文件**
（`config.json` → `diagnostics.json`）：新文件里当然没有 `verboseLog`，直接 `get(key, false)`
会拿到默认值——用户明明开着详细日志，升级后静默变回关闭，界面上还显示为关，看起来像「设置被重置」。

因此 Kotlin 侧在 `FoliaConfigGroups.readBoolean()` 里做了**旧值回退 + 一次性迁移**：

1. 新文件（`diagnostics.json`）里有这个键 → 以它为准；
2. 新文件里没有 → 回退读旧文件（`config.json`）里的同名键；
3. 真读到了旧值 → **立刻写进新文件**并落盘，迁移只发生一次，之后只认新文件。

第 3 步是关键：只回退不迁移的话，两处都能改值就永远说不清谁是真源。写一次之后旧键彻底不再被读。
迁移会在 `spw-folia.log` 留下 `config migrated verboseLog=… from config.json to diagnostics.json`
（写失败时带 `(write failed; will retry next read)`，下次读再试）。

> 「键是否存在」的判定不能用 `get(key, default)`（区分不出「不存在」和「存在且等于默认值」），
> 实现用一个不可能与真实键冲突的 String 哨兵做类型探测，详见 `FoliaConfigGroups` 的类注释。

**用户可见结论：升级到 v0.4.11 后，之前保存的详细日志设置不会丢，开关显示与实际行为都保持原样。**

#### 4.1.2 新增开关的链路（`showPlaybackBar` / `showProblemButton` 同构）

Kotlin 在 `registerTransitionAnimationConfig()` 里读 config →
`FoliaPlugin.withInjectedMembers()` 把布尔塞进**设置树顶层**（与 `systemFonts` 同一路，键常量
`SHOW_PLAYBACK_BAR_KEY` / `SHOW_PROBLEM_BUTTON_KEY`）→ 页面 `src/model/useInjectedSwitch.ts` 里的
`useShowPlaybackBar()` / `useShowProblemButton()` 监 `getSettings()` 初值 + `settings` 事件热更新 →
组件按它决定挂不挂载。
**页面不回写、不持久化这两个键**（所有权在插件，回写会造成双写方与启动竞态覆盖），
`FoliaPlugin.onSettingsFromPage` 里会先把它们从页面回传的树里剥掉再落盘。

「显示问题反馈按钮」（`showProblemButton`，默认**关**）的具体口径：

- 控制播放页**右上角的救生圈按钮**（`data-spw-chrome="problem-report"`，`LifeBuoy` 图标）及其诊断面板。
- 关闭时按钮**不渲染**——React 根本不挂载，不是 CSS 隐藏，因此也不上报 hit region（鼠标穿透模式下
  不会留一个点不到的死区）。
- 同时**关掉该按钮的键盘/面板联动**：按钮不在时不监听它的 ESC，面板若开着也会随开关一起关掉。
- **为什么默认关**：它会遮挡画面右上角。而「播放窗口打不开」这种最需要求助的场景，配置页
  「支持与反馈 → 出现问题」按钮仍然可用——那正是那个按钮存在的理由。

#### 4.1.3 「歌词样式预览动画」开关 + 小图缓存（v0.4.16）

货架那 17 格小图（`data-spw-shelf` 里每个 `[data-value]`）默认是**真实渲染器**画的：上游
`LyricStylePicture` → `LivePicture` 逐格串行把样式画到一张窗口大小的舞台上，冻结成静态图，
指针停留 280ms 才让那一格跑起来。这条路很贵，真机量过（1920×1200、DSF 1、宽 7 列）：

| 场景 | 出图耗时 | 峰值造图并发 | 新增样式渲染器 chunk |
| --- | --- | --- | --- |
| 冷启第一次打开设置 | **24.3 s**（17 格串行，均 1.37 s/格，最慢 nebbia 3.9 s） | 1 | 19 |
| 同页关掉再打开 | 0.05 s | 0 | 0（上游 `pictureImages` 的页内 Map） |
| **重启进程后再打开** | **23.0 s** | 1 | 19 |
| **v0.4.16 起，重启进程后再打开** | **0.37 s** | **0** | **0**（磁盘缓存命中） |

> 两个口径别混：`19` 是**样式渲染器** chunk（`assets/Visualizer*`，验收脚本按 resource entry 求差集）；
> 基线测量脚本另报过「81 个 chunk」，那是 `settings/assets/` 下**全部**新加载资源（含 three/pixi 等
> 共享库与 shell），不是同一件事。缓存命中后两组数字都是 0 + 1（`ShelfLiveView` 这个 lazy 壳本身，
> live 模式必然加载），所以验收把「渲染器」与「壳」分开断言。

期间主线程还有 22 次长任务、最长一次 1.7 s、累计阻塞 2.5 s —— 这就是「一开设置就卡一下」的真实体积。

两处改动：

**① 磁盘缓存（`src/model/previewImageCache.ts`）**。上游 `preview/pictureImages.ts` 那只 Map 只活在
**页面生命周期**里，重启进程就全没了。这一层把已经冻结好的静态图（canvas 全部编码成 `<img>`）
写进 IndexedDB，下次开窗口直接贴出来 —— 贴进的是**上游那只 Map**（`keepImage`），于是
`LivePicture` 一上来就认为「这张图已经有了」：不排队造图、不拉渲染器 chunk、不起 rAF；指针停留时
照旧走上游既有的 `image → live` 路径挂真渲染器。**没有改一行上游代码。**

- 库/表/键：`spw-folia-preview` / `pictures` / keyPath `key`（这三个名字是验收脚本的取证口径）。
- 键 = `v1|` + 上游 `stylePictureKey(...)` 原始串。**复用上游那个函数而不是自己拼字段清单**（它已经把
  mode/stage/theme/isDaylight/sample/fontScale/tuning/mod 设置全写进 JSON），但**不传三个上传图参数**：
  上游会把上传图对象编码成 WeakMap 序号，每次重启都不一样，拿它做磁盘键永远不命中。上传图在场时
  整条缓存直接关掉（`uploadsBlockCaching`）。
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
| --- | --- |
| `tiles` / `pictures` / `images` / `making` / `running` | 沿用上游 `data-picture` 标记的计数 |
| `chosen` / `glyphs` / `runningValue` / `runningPicture` | 同上 |
| `animated` | 货架是实时版（= `[data-spw-shelf-mode] === "live"`） |
| `cached` | 当前显示「磁盘恢复图」的格子数；**static 模式恒 0** |
| `pending` | 还没有图、也还没在造图的**样式格**数（随机格不计）；**static 模式恒 0** |

**已知且有意接受**：入口 chunk 里仍能看到上游 preview 代码（`LyricPreviewProvider`、`LivePicture` 的
`data-picture` 字符串等）。来源是 `App.tsx` → `VisPlaygroundSettingsPanel` → `RandomPoolGroup` →
`lyricStyleChoices` 这条静态 import，**改动前就存在**：设置面板的随机池区域引用 `drawLyricStyleChoice`。
它不影响开关的效果（随机池本身画的就是字形图案，`drawRandomPoolChoice`），真机 resource entries 在
关掉时确实是 0。要连入口 chunk 一起清干净得改 `App.tsx` 的静态 import 图，是另一件事。

验收：`packaging/tools/verify-preview-animation-switch.mjs`（已接入 `verify-all.mjs`，五组断言
A 默认开 / B 关掉零渲染器 / C 跨进程缓存命中 / D 热切换 / E 同页重开不退化）。

## 5. 元数据（tuning）与样式面板

- 样式面板拿到的 `settings` 是 Folia 的 `VisualizerTuningSettings` 袋：`{ sonnetTuning, temperaTuning, …, latentBackgroundTuning, monetBackgroundTuning, nomandBackgroundTuning, soraBackgroundTuning, smartBeat }`（由 `selectTuningSettings` 从快照的 `styleTunings`/`backgroundTunings` 组装）。
- `styleDraft = { tuning: styleTunings[styleId], change: setStyleTuning, reset: resetStyleTuning }`，与 Folia `useTuningDrafts` 的 `StyleDraft` 接口一致；拖动滑杆时 `onSliderPointerDown/Commit` 交给面板自己的提交逻辑（`panelRows.SliderRow` 只在 release 时提交）。
- 每个样式的默认值全部来自 `Folia src/types.ts`，见 `docs/folia-spec/tunings.md`；本工程 `model/settings.ts:STYLE_TUNING_DEFAULTS` 直接引用同一批常量。

## 6. 配置发布器（publisher）

文件：`src/publisher/config.ts`、`src/publisher/deriveTheme.ts`、`src/useConfigPublisher.ts`。

- 输入：本地 store 快照、`__SPW_FOLIA__.inputs.track/lyrics/state`（事件增量也在 `bridge.on('track'|'lyrics'|'state')` 里收）、`state` 的播放状态用于时钟换算、主题（封面派生，见下）。
- 输出：`ObsBrowserSourceConfig`（Folia `src/types/obsBrowserSource.ts:37-101`），经 `__SPW_FOLIA__.pushConfig(config)` → 宿主直接派发 Folia 的 `config` 事件，视觉器即时更新，不重载页面。**页面侧构建、宿主只转发**（protocol §4）。
- 字段映射（`publisher/config.ts:buildConfig`）：
  - `activePlaybackContext:'main'`、`stageSource:null`、`hasTrack`、`song{id,name}|null`、`songArtist/songAlbum/coverUrl`、`lyrics`（Folia `LyricData`）、`theme`/`subtitleTheme`、`isDaylight`、`seed`（曲目 id 兜底）。
  - `visualizerMode` ← `styleId`；`visualizerTunings` ← 除 `still` 外全部 `styleTunings`（渲染器按 `visualizerTunings[mode]` 应用）。
  - `background` ← `backgroundMode` + `commonBackground` + 各背景 tuning 合并默认值（结构同 Folia `VisualizerBackgroundConfig`）。
  - 外观：`lyricsFontScale`/`subtitleFontScale`（clamp 0.85–1.4）、`visualizerOpacity`/`subtitleOverlayOpacity`（clamp 0.2–1）、`staticMode:false`、`hideTranslationSubtitle`、`showSubtitleTranslation = !hide && contentMode!=='none'`、`subtitleContentMode`、`subtitleOverlayBackground` 等。
  - `updatedAt`：每次推送加时间戳；**去重签名**用去掉 `updatedAt` 的 JSON，签名不变不推。
- 歌词：插件给的每行 `{startMs,endMs,main,sub?,romanization?,id?,words?}` → Folia `Line{words,startTime,endTime,fullText,translation}`；没有逐字时间时按字符均分回退（视觉器逐字样式依赖 `words`）。
- 节流：`CONFIG_MIN_INTERVAL_MS=100`（≤10Hz），拖动过程中合并，释放后由 `flush()` 立即推一次；窗口/曲目变化 0.35s 跳变阈值与 Folia `useObsBrowserSourcePublisher` 一致（时钟插值仍由 Shim/宿主负责）。
- 主题派生（`deriveTheme.ts`）：封面 URL → `48×48` canvas 采样 → 像素均值做 `backgroundColor`/`primaryColor`、最饱和桶做 `accentColor`，亮度阈值（`luminance`）决定 `isDaylight` 与文字色；无封面/加载失败回退深色 demo 主题 `#09090b / #f4f4f5 / #71717a`。这是“页面内派生”，与 Folia 桌面版的取色链路同职责（宿主只给 bytes，见 protocol §4）。
- 兼容：下游仍兼容 v1 的宿主直推 `config`（webview-spike 的 `--demo` 路径），本 publisher 只负责 settings 驱动的 v2 路径；两者产出同一 `ObsBrowserSourceConfig` 形状。

## 7. 与 Folia 原版的差异（需在验收时知晓）

1. **预览是真实宿主渲染帧**（`poc/webview/host` 全屏运行 Folia dist 截屏，按 16:10 裁切 1440×900 JPEG q82），不是 Folia 的实时 `preview/LyricStylePicture` 小渲染；换样式/调参时大图与样式货架不会跟着实时重绘（Folia 会），货架格数从 v0.3.x 的 14 格涨到现在的 17 格。这是性能与依赖取舍，视觉上等价于截图 1。
2. **智能动感模式默认 ON**：与 `packaging/testdata/default-settings.json` 一致，也与截图 1 一致；Folia 应用自身的 stored default 是 `false`（`types.ts:609`），本工程按 v1 树 + 截图取 ON。
3. **模型/播放能力降级**：`useSmartBeatAvailability()` 桩返回 `'ready'`（为了不显示“仅桌面版可用”提示，与截图 1 一致）；实际 webview 内没有 `beat_this`/`htdemucs` 模型，节拍效果不会真正驱动动画（视觉器在 `isBeatFxReady()` 为假时像素不变）。开关/强度均照常保存进设置树。
4. **上传类控件降级（v0.4.0 起只剩部分）**：自定义字体已可用——「自定义」磁贴可导入字体包（`.ttf/.otf/.woff/.woff2`，单个 ≤ 50 MB，存 IndexedDB 并用 `FontFace` 注册）或从插件下发的 `systemFonts`（AWT 枚举，最多 400 个家族，不持久化）里选，不再走 no-op 桩。仍然降级的还有 tempera 画布图片、monet 封面/肖像、cappella 自定义表情/头像——按钮存在但为 no-op（对应桩）；文案与布局保持 Folia 原样。
5. **Folium mod 扩展卡片**不渲染（无 mod）；`背景类型 → 嵌入/空` 的动态图片列表为空。
6. **背景缩略图**是 Folia 无图时的 glyph fallback（深色卡片 + 模式字形，沿 `backgrounds/<mode>/entry.tsx` 的 `PictureFrame` 语义重绘；Folia 在有背景数据时画实时小画布）；`背景` tab 设置项行为完全一致。
7. **返回按钮**关闭注入覆盖层（不是回播放页）；顶部 header 的 `←` 与 §7.5 一致。
8. **纹理分辨率显示 1.50x**（Folia 默认 1.5）；截图 1 的 1.00x 是用户改过的状态。
9. 注入层全局 CSS（kit.css/Tailwind）会作用到整个页面，但每次打开前只在 head 注入一次 `<style data-spw-settings-ui-css>`，与 Folia 页面自身的 Tailwind 共存（选择器均为 kit 前缀 `st-` / CSS 变量，实测无冲突）。
10. 眼镜/英文字体：`Folia Noto Serif SC` 仍由 Folia 页面自己的 `@font-face`（CDN）提供；本 bundle 不额外拉字体，离线时回退系统衬线栈。
11. 与安装版 Folia 的 1:1 对比（task-11）见 `research/settings-ui/fidelity-diff.md`：已修复 `--text-primary` 未取配色主题、CJK 字体栈缺失、body/滚动条配色、背景格渐变占位四处可见偏差；剩余差异均为 v1 有意降级。

## 8. §7.5 chrome 契约实现（实测）

- `__SPW_FOLIA__.ui = { isSettingsOpen(), openSettings(), closeSettings() }`：`bridge.ts:registerSettingsUiController()` 在 Shim 建好的对象上**增补** `ui` 字段（不替换对象），同时保留 `__SPW_FOLIA_UI__` / `__SPW_FOLIA_SETTINGS_UI__` 兼容名。
- ⚙ 按钮：`.spw-chrome-btn`（`src/app.css`）固定右上 24/24，40×40 圆钮，`rgba(0,0,0,.28)` + `backdrop-filter:blur(12px)` + 1px 白 16% 描边 + 白色 lucide `Settings` 20px，hover 提亮；`pointermove/pointerdown/keydown` 重置 2.5s 空闲计时，超时与光标一起淡出（opacity/translate 过渡），关闭覆盖层后重新出现。
- **指针事件（必须显式开启）**：注入挂载根 `#spw-settings-ui-root`（`src/mount.tsx:16`）是 `pointer-events:none` 的点击穿透层，好让关闭状态下的点击落到下面的 Folia 视觉器；所以 ⚙ 必须在 CSS 里显式 `pointer-events:auto`，否则 `document.elementFromPoint()` 与真实鼠标命中都会被 Folia 页面元素截走——合成 `.click()` 能过、真实点击会失效（真实输入回归，见 §13/F5）；按钮隐藏态 `[data-visible='false']` 恢复 `pointer-events:none`，保证空闲时点穿透。覆盖层打开时其容器自身 `pointer-events:auto` 接管整屏。
- 覆盖层：打开时 `data-spw-settings-ui` 容器 `pointer-events:auto` 且 `display:block`；**组件不卸载**（隐藏时 `display:none`），再次打开不重挂载、预览帧不闪。
- ESC：打开时在 `window` **capture** 阶段监听，命中后 `preventDefault()+stopPropagation()+close()`；关闭时不注册该监听，ESC 直接落到宿主（宿主负责关窗）。
- 实测（`scripts/host-ui-check.mjs`，真实宿主 + 注入 bundle，无 `--force-dsf`；输出存 `poc/webview/host/out/ui-check/results.txt`）：
  ```text
  初始：uiApi=function, isOpen=false, gear=true
  指针命中（⚙ 中心 elementFromPoint，CSS 844,44）：可见态 pointerEvents=auto，命中 gear（该点最顶层元素为按钮内 svg，gear.contains 成立）
  空闲 2.5s 后：visible=false, pointerEvents=none，命中 HEADER（点击穿透视觉器，符合预期）
  ⚙ 点击 → isOpen=true, chrome 隐藏
  ESC（打开时）→ isOpen=false（事件被 preventDefault）
  ui.openSettings() → true；ui.closeSettings() → false
  ESC（关闭时）→ 未 preventDefault（交还宿主）
  重新打开 → 立即打开，.st-window 数量始终为 1（未重挂载）
  host/page errors = 0
  ```
- 宿主命令 `command open-settings` / `close-settings` 由 Shim 转成 `ui` / `settingsUI` 事件触达本页（`bridge.ts` 同时监听两种事件名），也可直接 `ExecuteScriptAsync("__SPW_FOLIA__.ui.openSettings()")`。

## 9. 截图与证据

| 文件 | 内容 |
| --- | --- |
| `research/settings-ui/ours-tab-歌词动画.png` / `-背景` / `-字体` / `-字幕` | 我们页面 4 tab 的 1600×1000 截图（`scripts/dev-capture.mjs`） |
| `research/settings-ui/ours-window*.png` | 我们窗口的 1240×780 精确裁切（用于逐像素对比） |
| `research/settings-ui/real-window.png` / `real-window-<tab>.png` | **安装版 Folia 原版**同状态、同视口的 1240×780 窗口裁切（`scripts/folia-drive.mjs shot-el`） |
| `research/settings-ui/fidelity-*.png` | 原版/我们左右并排的区域对比图 |
| `research/settings-ui/fidelity-diff.md` | task-11 逐区域 PASS/DIFF 报告 + 复跑命令 |
| `research/settings-ui/metrics-real2.json` / `metrics-ours.json` | 同口径 DOM/CSS 度量（窗口/标题/tab/下划线/行/开关/滑轨/货架 tile） |
| `research/settings-ui/window-style-tempera.png` | 切换凝彩：大预览与样式面板同步切换 |
| `research/settings-ui/window-tempera-texture-max.png` | 拖满纹理分辨率后的状态 |
| `research/settings-ui/chrome-fullscreen.png` | dev harness 下 ⚙ chrome（无底层画面） |
| `research/settings-ui/host-fullscreen-chrome.png` | **真实宿主全屏**：Folia 视觉器 + ⚙ |
| `research/settings-ui/host-fullscreen-overlay-open.png` | **真实宿主全屏**：覆盖层打开（3200×2000 @DSF1.8，两栏） |
| `research/settings-ui/host-packaged-fullscreen.png` | **打包树实测**：从 `packaging/web` 注入、覆盖层打开 |
| `research/settings-ui/pushed-config.json` | 一次实际 `pushConfig` 的完整 payload |
| `research/settings-ui/host-ui-check-results.txt` | 真实宿主 §7.5 契约 + ⚙ 指针命中（`elementFromPoint`）回归输出（含 `gearHit`/`gearHitHidden`） |
| `docs/images/settings-ui.jpg` | 真实宿主全屏、覆盖层打开（2200 宽 JPEG q88）；本文件 §9 引用 |
| `docs/images/fullscreen-chrome.jpg` | 公开 README 用：视觉器 + 右上 ⚙ chrome（JPEG q88） |
| `docs/images/style-grid.png` | 公开 README 用：样式货架网格裁切。**注意：当前文件是 v0.3.x 时期的 14 格截图**（缺「花火」「町景」「雾笺」），需补一张 17 格版本后替换。 |
| `docs/images/transparent-background.jpg` | 公开 README 用：播放页透明背景（歌词叠加桌面，含开关面板） |
| `docs/images/menu-folia.png` | 公开 README 用：迷你播放器「更多」菜单里的 Folia 条目 |

## 10. 验收清单

- [x] `npm run build` 通过，产物单文件 `dist/settings-ui.js`（CSS 内联），无运行期网络请求。
- [x] 标题 `歌词样式`、右上 `默认`、4 tab `歌词动画/背景/字体/字幕`、15 样式 + 随机 → 8 列 2 行（商籁…花火…静止，随机在末位）。
  **注：本清单是 v0.4.1 时期（15 样式）的验收记录，未随上游 0.7.25 的 17 样式重测**——现行代码是 17 样式
  （新增 町景 `machi` / 雾笺 `nebbia`），登记在 `poc/settings-ui/src/model/styles.tsx`。
- [x] 大预览 + 暂停钮 + 样式货架与 Folia 截图 1 同构；尺寸/间距来自 Folia 原组件（1240×780、右栏 420、tile 16:10）。
- [x] 智能动感模式/动感效果/渲染质量/动态与构图四组，值与范围来自 `DEFAULT_SONNET_TUNING`（纹理 1.5x、镜头 1.00x、文字动势 1.00x）。
- [x] 13 个样式面板全部可渲染（cadenza/still 为空态）。**注：同上，v0.4.1 口径；现行 17 样式里 15 个带面板、
  `cadenza`/`still` 仍为空态。**
- [x] 控件改动 → store → `setSettings`（≤10Hz）→ 宿主持久化；`pushConfig` 带 `visualizerTunings` 与 `visualizerMode`。
- [x] 真实宿主注入：0 页面错误，全屏两栏，⚙/ESC 契约通过。
- [x] 与安装版 Folia 1:1 对比：标题行/tab/四组卡片/字体/字幕区域 MAE 1.16–7.00（亚像素级），几何与 CSS 变量逐项一致；详见 `research/settings-ui/fidelity-diff.md`。
- [ ] `嵌入/空` 背景与上传类控件（§7.3/7.4）留给 v2——功能降级不影响 v1 视觉与设置树。

## 11. 风险与后续

- **DSF 视口**：生产若在 1080p 屏全屏（CSS 1920×1080）仍两栏；若窗口化到窄尺寸，Folia 会变单栏（接受）。
- **覆盖层遮住视觉器交互**：打开时 `pointer-events:auto` 覆盖全屏，播放器点击被挡住（Folia 自身设置窗口也如此），关闭即恢复。
- **模型缺失**：§7.3；后续若 webview-spike 的 beat 注入链路落地，可把 `useSmartBeatAvailability` 桩换成真实探测。
- **上传能力**：待宿主/插件提供文件选择与 asset 通道后，替换对应桩即可（接口已按 Folia 形状保留）。
- **AGPL-3.0**：本 bundle 编译了 Folia 的 React 组件（AGPL 代码），分发时必须随附相应源码/构建脚本与许可证声明（见 `docs/licensing.md`、`NOTICE`），且不得以专有条款再授权。截图源自 Folia 仓库 README（同许可证）。

## 12. v1 明确不含（v2 follow-ups）

公开版本有意识地只做到“设置窗口 + 配置下发 + 全屏 chrome”这一层，以下为 v2 待补，不是 bug：

- **上传类控件降级**：tempera 画布图片、monet 封面取色/肖像、cappella 自定义表情/头像——控件在、点击 no-op（对应 `src/stubs/` 桩）。需要宿主/插件提供文件选择与 asset 通道。（自定义字体已在 v0.4.0 实现：导入字体包 + 系统字体列表，见 §7 第 4 条。）
- **节拍效果只有 UI**：`beat_this` / `htdemucs` 模型不在 webview 内，开关与强度照常写进设置树，但视觉器不会真正随拍动画（`useSmartBeatAvailability` 桩返回 `'ready'` 仅为与截图 1 的桌面形态一致；缺失模型提示因此不显示）。
- **预览是真实宿主渲染帧**，不是 Folia 的实时 `LyricStylePicture` 小渲染：换样式/拖参数时大图与样式货架不跟着实时重绘（静态 jpg，来自 `poc/webview/host` 全屏截屏 16:10 裁切；货架现行 17 格）。视觉等价、性能更好，但少了实时性。
- **背景缩略图**为 Folia glyph fallback（静态模式字形），不是实时小画布；`嵌入/空` 背景无动态图片列表。
- **Folium mod 扩展卡片**不渲染（无 mod 运行时）。
- **DSF/视口**：生产全屏两栏成立（如 3200×2000@1.8 → CSS 1778×1111）；窗口化到窄尺寸时 Folia 自身响应式会变单栏，属预期行为，不做特判。
- **全局动感强度 `lyricMotion`（0.5–1.2）** 已在设置树透传，但本窗口暂无对应控件（Folia 的全局外观页有）。

## 13. 与原版 1:1 还原度（task-11）

报告：`research/settings-ui/fidelity-diff.md`（方法、逐区域 MAE、修复记录、有意差异、复跑命令）。

| 区域 | MAE | 结论 |
| --- | --- | --- |
| 标题行（返回 / 歌词样式 20px 600） | 1.16 | PASS |
| Tab 栏文字 / 下划线 | 7.10 / 2.11 | PASS（文字差为 0.25px 亚像素） |
| 智能动感模式 / 动感效果 / 渲染质量 / 动态与构图 | 1.15 / 3.24 / 2.22 / 3.06 | PASS |
| 字体 tab / 字幕 tab / 背景「隐现背景」卡片 | 2.08 / 4.61 / 7.00 | PASS |
| 背景类型 6 格 / 样式货架 15 格 / 大预览 | 23.72 / 29.66 / 53.88 | 有意差异（实时渲染 vs 静态帧；MAE 为 v0.3.x 14 格时期测得，15 格未重测；**现行货架是 17 格，仍未重测**） |

修复的 4 处可见偏差：`--text-primary` 取配色主题（原为 kit fallback）、补齐 Folia `@theme` CJK 字体栈、body/滚动条配色对齐、背景格改为 Folia glyph fallback（原为渐变占位）。

另修复 1 处**真实输入回归（F5，非视觉差异）**：注入挂载根是 `pointer-events:none` 穿透层，⚙ 未显式开启命中测试，导致真实鼠标点不到 ⚙（合成 `.click()` 测不出来）；已在 `.spw-chrome-btn` 加 `pointer-events:auto`、隐藏态保持 `none`，并用真实宿主 `elementFromPoint` 命中测试 + 完整 chrome/ESC 契约回归验证（上方 §8 实测块）。细节与复跑命令见 `research/settings-ui/fidelity-diff.md` §3.5。


## 13. v0.1.2 变更（2026-10-19）

1. **封面取色修复**：`bridge.ts` 新增 `BridgeTrackMessage.coverDataUrl` 与
   `bridgeTrackCover(track) = track.coverUrl ?? track.coverDataUrl`；`useConfigPublisher.ts`
   的 `toPublisherTrack()` 改用 `bridgeTrackCover()`，因此宿主转发的 `coverDataUrl` 也能触发
   `deriveThemeFromCover()`。验证见 `docs/archive/verification-v0.1.2.md`（纯色封面实验：橙 RGB 165/105/66，
   黑 71/71/72）。
2. **移除「智能动感模式」卡片**：`vite.config.ts` 新增 `stripSmartBeatCard()`（`enforce:'pre'`）——
   构建时精确替换 `VisPlaygroundSettingsPanel.tsx` 里的 `<SmartBeatSettingsCard t={t} />`（找不到即抛错），
   不修改 Folia 上游源码；`SmartBeatSettingsCard` 不再进入 bundle。「动感效果」等其它卡片保持不变。
3. 失效开关清单：`docs/known-inert-settings.md`。

## 14. v0.1.3 变更（2026-10-19）

1. **A/B 组控件剥离**：`vite.config.ts` 的 `stripSmartBeatCard()` 升级为数据驱动的
   `foliaSettingsSurgery()`（`enforce:'pre'`，标记缺失即抛错），共 12 处编辑：VisPlaygroundSettingsPanel
   （智能动感卡片、动感效果、背景 url 项、罗马音/两者选项、自定义字体 Reveal、和声分组）、
   Tempera（图像图层分组）、Monet（自定义人像来源 + 上传行）、Cappella（自定义头像/表情包来源 +
   两条上传行）。Folia 上游源码不变。
2. **C 组映射修复**：新增 `src/publisher/themeFonts.ts` 的 `applyThemeFonts()`；`useConfigPublisher`
   的主题 = 封面派生主题 + 字体族/字重合成，字幕主题按「跟随歌词」继承或独立映射；`config.ts`
   归一化 `subtitleContentMode` 并固定和声字段为 false。此前字体族/字重/字幕字体从不进入 config。
3. **旧值迁移**：`App.tsx` 挂载时归一化持久化设置（custom→sans、romanization/both→translation、
   url→latent），并移除自定义字体磁贴。
4. 验证：`docs/archive/verification-v0.1.3.md`（DOM + pushConfig 断言 + 真实 SPW 截图）。
