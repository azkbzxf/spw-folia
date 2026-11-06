# 样式与背景的 tuning：存储键、默认值

每个歌词样式和 4 个背景各有一组可调的数值（`tuning`）。设置页的样式面板把字段渲染成 kit 控件，改动先落在草稿上、
松手才落盘；「默认」按钮写回 `DEFAULT_*_TUNING` 并弹 `notifications.<mode>Reset` 提示。

- 默认值：13 个早期样式的 `DEFAULT_<MODE>_TUNING` 在 `work/folia/folia-major-main/src/types.ts`；花火、町景、雾笺的
  默认值跟样式自己放在 `<mode>/types.ts`（`DEFAULT_HANABI_TUNING` / `DEFAULT_MACHI_TUNING` / `DEFAULT_NEBBIA_TUNING`）。
- 插件侧镜像：`poc/settings-ui/src/model/settings.ts` 的 `STYLE_TUNING_DEFAULTS` / `STYLE_TUNING_KEYS` /
  `BACKGROUND_TUNING_DEFAULTS` 直接从上游 import，不另抄一份。
- 上游契约：[`runtime-contracts.md`](runtime-contracts.md) §2.1 的 `applyVisualizerTuning`；样式清单见
  [`style-map.md`](style-map.md) §1。

## 1. 样式 tuning 一览

16 个样式有 `tuning.ts`（静止没有），**全部**遵循 `defineVisualizerTuning`，声明 `settingsKey`、
`settingsSetterKey`、`settingsResetterKey`、`storage.key` 与 `defaults`：

> 0.7.26 还给其中 15 个 tuning 声明了 `modKeys`（Folium mod 通过 `folium.visualizer.setTuning`
> 读写时的字段白名单与取值守卫）。**本插件不渲染 mod、`folium` 桩是空 registry，这块用不到**，
> 新增样式时不必照抄。

| 样式 | settingsKey | 设置面板 | 动感效果 |
|------|-------------|----------|----------|
| sonnet 商籁 | `sonnetTuning` | `sonnet/SonnetSettingsPanel.tsx` | `sonnet.lensTear` 推镜裂光 |
| tempera 凝彩 | `temperaTuning` | `tempera/TemperaSettingsPanel.tsx` | `tempera.inkFlash` 墨染奥行 |
| lumiere 绘光 | `lumiereTuning` | `lumiere/LumiereSettingsPanel.tsx` | — |
| hanabi 花火 | `hanabiTuning` | `hanabi/HanabiSettingsPanel.tsx` | `hanabi.beatBursts`、`hanabi.beatPulse` |
| machi 町景 | `machiTuning` | `machi/MachiSettingsPanel.tsx` | `machi.neonPulse`、`machi.drumRipple`、`machi.screenFlash` |
| nebbia 雾笺 | `nebbiaTuning` | `nebbia/NebbiaSettingsPanel.tsx` | `nebbia.drizzleRide`（两段强度）、`nebbia.aquaBeat`（0.7.26 新增，四段） |
| classic 流光 | `classicTuning` | `settingsPanels.tsx` 的 `ClassicSettingsPanel` | — |
| cadenza 心象 | `cadenzaTuning` | `cadenza/CadenzaSettingsPanel.tsx`（0.7.26 起，只有「渲染」一组） | — |
| partita 云阶 | `partitaTuning` | `settingsPanels.tsx` 的 `PartitaSettingsPanel` | — |
| fume 浮名 | `fumeTuning` | `settingsPanels.tsx` 的 `FumeSettingsPanel` | — |
| tilt 倾诉 | `tiltTuning` | `settingsPanels.tsx` 的 `TiltSettingsPanel` | — |
| claddagh 回环 | `claddaghTuning` | `settingsPanels.tsx` 的 `CladdaghSettingsPanel` | — |
| monet 莫奈 | `monetTuning` | `monet/MonetSettingsPanel.tsx` | — |
| pendolo 时计 | `pendoloTuning` | `pendolo/PendoloSettingsPanel.tsx` | `pendolo.drumhead` 仿真鼓面（`pendolo.gearBeats` 已停用） |
| cappella 群唱 | `cappellaTuning` | `settingsPanels.tsx` 的 `CappellaSettingsPanel` | — |
| diorama 镜台 | `dioramaTuning` | `settingsPanels.tsx` 的 `DioramaSettingsPanel` | `diorama.ripple` 水镜涟漪 |
| still 静止 | —（无 `tuning.ts`） | 无 | — |

- `storage.key` 一律 `<mode>_tuning`（`sonnet_tuning` … `diorama_tuning`，花火/町景/雾笺同样命名）。
  唯一带 `olderKeys` 的是心象：旧键 `cadenze_tuning`。
- `applyVisualizerTuning(mode, props, bundle)` 把 tuning 以命名 prop（`sonnetTuning` 等）交给渲染器，同时把整包
  bundle 放在 `props.visualizerTunings`。花火/町景/雾笺没有命名 prop，渲染器自己用 `read(props.visualizerTunings)`
  从 bundle 取。
- `tuning.ts` 还能声明 `preview(draft, saved)`（拖动滑块时预览画什么）与 `storage`
  的 `read` / `merge` / `onChange` / `resetNotice` / `actions`；不声明 `preview` 时预览画草稿。
- **默认值必须打底**：`defineVisualizerTuning(...).apply` 把交给它的 bag 原样存下，从不跑样式自己的 `resolve()`。
  bag 里少一个键不是报错，而是渲染器乘出 `NaN`，`position` / `alpha` / `scale` 变 `NaN` 后整个构图静默消失
  （凝彩在 0.7.25 新增三个景深键时就那样丢过字形）。插件因此在持久化层（`model/mergeTuning.ts` 的
  defaults-first 合并）和发布层（`publisher/config.ts` 的 `buildTuningBundle`）各打一次底。

## 2. 各样式默认值

以下每个字面量都是上游 `DEFAULT_<MODE>_TUNING` 的**原文**；`render` 单独见 §2.1，不在这里重复。
换上游版本后照 `src/types.ts` / `<mode>/types.ts` 重抄，不要凭记忆补。

### Classic —— `ClassicTuning`
```ts
enableWordRotation: true, breathingFloatMultiplier: 1, useLegacyLayout: false, wordSpacing: 0.7,
avoidOverlap: false,
```

### Cadenza —— `CadenzaTuning`
```ts
fontScale: 1.12, widthRatio: 0.72, motionAmount: 1, glowIntensity: 1, beamIntensity: 0,
```

### Partita —— `PartitaTuning`
```ts
showGuideLines: true, useSemanticLayout: true, staggerMin: 20, staggerMax: 100,
avoidOverlap: false,
```

### Fume —— `FumeTuning`
```ts
hidePrintSymbols: false, disableGeometricBackground: true, backgroundObjectOpacity: 0.5, textHoldRatio: 1,
cameraTrackingMode: 'smooth', cameraSpeed: 1, glowIntensity: 1, heroScale: 1,
```

### Tilt —— `TiltTuning`
```ts
splitProbability: 0.75, tiltStyleProbability: 0.35, colorScheme: 'default',
```

### Claddagh —— `CladdaghTuning`
```ts
focusScaleRatio: 0.65, radiusScale: 1.0, ellipseTiltDeg: 45, showAxisLine: true, letterSpacingOffset: 0,
```

### Cappella —— `CappellaTuning`
```ts
showEmoMessages: true, emojiPackSource: 'builtin', avatarSource: 'cover',
```

### Monet —— `MonetTuning`
```ts
keywordColoringEnabled: true, showDescription: true, showAudioVisualization: true, audioStyle: 'bar',
fontScale: 1.2, portraitSource: 'cover', portraitOffsetX: 0, portraitStyle: 'square',
showPortraitDragHanger: true,
```

### Pendolo —— `PendoloTuning`
```ts
arcRadius: 0.42, arcAngleDeg: 100, wheelCenterX: 0.0, wheelCenterY: 0.50, tickSnappiness: 2.0,
activeScale: 1.25, showGearDecor: 'subtle', showCenterGradient: true, showCoverOnWatchFace: false,
enableLineGlow: false,
```

### Diorama —— `DioramaTuning`
```ts
cameraSpeed: 1, motionAmount: 1, audioReactivity: 1,
geometryVisibility: { enabled: true, mode: 'clouds', strands: true, blobs: true, ribbons: true, rings: true },
particleDensity: 576, particleScale: 1, particleGlowEnabled: true, particleGlowIntensity: 0.65,
showParticles: true, backgroundParticleCircumference: 28, backgroundParticleRadial: 2,
glowEnabled: true, glowIntensity: 1, soulEnabled: true, soulIntensity: 1, soulActiveEnabled: false,
gradientEnabled: false, gradientIntensity: 1, keywordColoringEnabled: true,
```

`geometryVisibility` 的默认值是 `DEFAULT_DIORAMA_GEOMETRY_VISIBILITY`（上文已展开）

### Sonnet —— `SonnetTuning`
```ts
cameraIntensity: 1, typographyMotion: 1, mgDensity: 1,
showOnlyText: false, showGuide: true, showBackgroundMg: true, showFixedGeo: true,
showGiantDecorativeText: true, showBackgroundDecor: true, enableTransitions: true,
outerFrameMode: 'full', textureResolution: 1.5,
postProcessEnabled: false, postProcessGrain: 0.2, postProcessContrast: 0, postProcessRgbShift: 0,
postProcessHalftone: 0, postProcessVignette: 0.85, postProcessLensDistortion: 0.3,
postProcessLensDispersion: 0.6,
```

### Tempera —— `TemperaTuning`
```ts
cameraIntensity: 1, glyphMotion: 1, wholeLineLyrics: false, glyphSettleStretch: 0.5,
depthOfField: 1, depthPan: 1, glyphDepth: 1,
colorMode: 'duo', showBlocks: true, showDecor: true, showCornerMarks: true, textInversion: true,
layerImages: [], layerImageDepth: 'back', layerImageFrequency: 0.6,
enableTransitions: true, textureResolution: 1.5,
postProcessEnabled: true, postProcessTextureCompression: false, postProcessGrain: 0.2,
postProcessContrast: 0, postProcessRgbShift: 0, postProcessVignette: 0.85, postProcessLensDistortion: 0.3,
```

`depthOfField` / `depthPan` / `glyphDepth` 是 0.7.25 新增的三个景深键，与 `tempera.inkFlash` 同一版引入

### Lumiere —— `LumiereTuning`
```ts
lightIntensity: 1, audioResponse: 1, fogDensity: 1, darkField: 0.75, moteAmount: 1,
bloom: 1, textBloom: 1, unlitOpacity: 0.22, windowNeighbors: 2, decay: 1, echo: 1, fogOctaves: 5,
lineArt: true, frontBokeh: true, trails: true, hideTrails: false, seamlessTransitions: true,
overlayFrame: true, textOnly: false, keywordColors: true, themeIcons: true, themeColorMix: 0.3,
renderQuality: 'full',
```

### Hanabi —— `HanabiTuning`（`hanabi/types.ts`）
```ts
colorMode: 'mixed', sparkAmount: 1, ornamentAmount: 1, textMotion: 1, blockOpacity: 1,
riseSpeed: 1, spin: 1, ambient: 1, glow: 1, bloom: 0.8, chorusBloom: 1.3,
launches: true, overlayFrame: true, textOnly: false, sky: 0.85, collage: 1, renderQuality: 'full',
```

### Machi —— `MachiTuning`（`machi/types.ts`）
```ts
scene: 'auto', timeOfDay: 'auto', weather: 'auto', camera: 'default',
views: { konbini: DEFAULT_MACHI_VIEW, station: DEFAULT_MACHI_VIEW, kowloon: DEFAULT_MACHI_VIEW },
motion: false, motionSpeed: 1, aperture: 8, dof: 1, dofRange: 1, tiltShift: 0.3,
focus: 'center', focusOffset: 0, simulatedBeat: true,
quality: DEFAULT_MACHI_QUALITY,
```

`views` 的每项默认是 `DEFAULT_MACHI_VIEW = { azimuth: 0, elevation: 0, zoom: 1, panX: 0, panZ: 0 }`；
`quality` 的默认是 `{ ...MACHI_QUALITY_PRESETS.high, adaptive: true, revision: MACHI_QUALITY_REVISION }`。

**町景的分辨率/抗锯齿不在 `render` 里**，走自己的 `quality`（0.7.26 起 `renderScale` / `antialias`
都可以取 `'global'`，三档预设是）：

```ts
high:     { renderScale: 'global', antialias: 'global', shadows: 'high', reflections: 'high', glow: true },
balanced: { renderScale: 'global', antialias: 'fxaa',   shadows: 'low',  reflections: 'low',  glow: true },
low:      { renderScale: 0.75,     antialias: 'off',    shadows: 'off',  reflections: 'off',  glow: false },
```

`quality.revision`（`MACHI_QUALITY_REVISION = 2`）只用来判别「这棵树早于『跟随全局』」：老存档里
分辨率 100% / SMAA 是当时的默认值（没人动过也会存下来），读的时候由 `machiTuning.ts` 的
`normalizeMachiQuality` 换成 `'global'`。**这是上游的读时迁移，本页不要另写一份**。

### Nebbia —— `NebbiaTuning`（`nebbia/types.ts`）
```ts
appear: ['write', 'fade'], fade: ['fog'], layouts: [...NEBBIA_LAYOUTS],
behind: 'night', glass: 'rain', scenery: [...NEBBIA_SCENERY], rain: 'slant',
credits: true, jitter: 0.6, warp: 0.6, mist: 0.75, hold: 1.2, refog: 4,
strokeWidth: 0.09, writeSpeed: 1, doodle: 0.3, busSpeed: 1,
neon: 1, spot: 0.5, spotX: 0.8, rainHit: 1, rainBig: 1, bump: 1,
jellies: 16, jellySize: 1, bubbles: 0.6,
dew: 1, dewSize: 1, dewGlint: 1,
snow: 1, snowSize: 1, snowMelt: 1,
```

`behind` / `glass`（窗外景与玻璃质感）、`jellies` / `jellySize` / `bubbles`（水母与气泡）、
`dew*` 与 `snow*` 这几组是 0.7.26 新增的：雾笺在这一版把「窗外」变成可选景，并加了水族箱方向的一整组
玻璃/雾面参数（因此也多了一条 `nebbia.aquaBeat` 动感效果，见 [`style-map.md`](style-map.md) §2）。

### Still —— 无 tuning
`still` 没有 `tuning.ts`（上游目录里只有 `entry.tsx` 和 `VisualizerStill.tsx`），设置页显示「这个样式没有参数」。
插件侧的 `STYLE_TUNING_DEFAULTS.still` / `STYLE_TUNING_KEYS.still` 仍给出 `{}` 与 `'stillTuning'`，因为它们是
`Record<StyleMode, …>`；这对渲染没有影响 —— 上游没有对应的 tuning 注册项，`applyVisualizerTuning` 找不到
`apply` 时原样把共享 props 交下去。

### 2.1 `render`：分辨率与抗锯齿的每样式覆盖（#929）

0.7.26 给下表这 10 个样式的 tuning 加了必填的 `render: LyricRenderOverride`，默认一律

```ts
render: { scale: 'global', antialias: 'global' },
```

`'global'` 表示「跟随全局挡位」，实际生效值由 `utils/lyricRenderQuality.ts` 的
`resolveLyricRenderQuality(global, override)` 合出来：覆盖里写了具体值就用它，否则用全局挡位
（`lyricRenderQuality`，默认 `{ scale: 1, antialias: 'auto' }`）。`antialias` 的取值是
`'global' | 'on' | 'off'`——`'auto'` **只存在于全局挡位**，样式覆盖里没有它。

| 样式 | tuning 里 `render` | 面板渲染该组 | 面板带抗锯齿行 |
|---|---|---|---|
| cadenza | ✅ | ✅ | ❌（2D canvas，只有分辨率） |
| diorama | ✅ | ✅ | ✅ |
| fume | ✅ | ✅ | ❌（2D canvas） |
| hanabi | ✅ | ✅ | ✅ |
| lumiere | ✅ | ✅ | ✅ |
| monet | ✅ | ✅ | ❌（2D canvas） |
| nebbia | ✅ | ✅ | ❌（2D canvas） |
| pendolo | ✅ | ✅ | ✅ |
| sonnet | ✅ | ✅ | ✅ |
| tempera | ✅ | ✅ | ✅ |
| 其余 7 个（cappella / claddagh / classic / machi / partita / still / tilt） | — | — | — |

`render` 是**必填**字段（不是可选）：面板拿它当 `tuning.render ?? DEFAULT_LYRIC_RENDER_OVERRIDE` 的
左值，渲染器直接用。所以「老树里没有它」必须靠合并补上——`mergeTuning.ts` 的 defaults-first 合并
恰好做这件事，`render` 是扁平对象、shallow 合并即可整体替换，不需要深合并。

**町景（machi）不在这张表里**也不走 `render`：它的分辨率/抗锯齿在自己的 `quality` 预设里，见上一节。

## 3. 背景 tuning 默认值

4 个背景有自己的 tuning（`backgrounds/<mode>/tuning.ts`）；`common` 的字段是 `CommonBackgroundSettings`
（`{opacity, useCoverColorBg, disableVignette, disableGeometricBackground}`），`url` 没有 tuning。

### Monet 背景 —— `MonetBackgroundTuning`
```ts
backgroundSource: 'cover-derived', backgroundLayout: 'full-overlay', backgroundBlurPx: 6,
backgroundOverlayOpacity: 0.74, backgroundGrayscale: 0, backgroundSaturation: 1.05, backgroundWash: 0.34,
backgroundHalfPaneOffsetX: 0, backgroundWashColorMode: 'theme', backgroundWashCustomColor: '#8fb7ff',
backgroundDriftEnabled: true, backgroundDriftStrength: 0.5, backgroundStreaksEnabled: true,
```

### Nomand 背景 —— `NomandBackgroundTuning`
```ts
imageSource: 'cover-derived', effect: 'dithering', ditheringType: '8x8', size: 3, colorSteps: 4,
originalColors: false, inverted: false,
flutedGlassSize: 0.5, flutedGlassDistortion: 0.5, flutedGlassBlur: 0.08,
paperTextureContrast: 0.32, paperTextureRoughness: 0.42, paperTextureFiber: 0.3,
halftoneDotsSize: 0.5, halftoneDotsRadius: 1.25, halftoneDotsContrast: 0.4,
halftoneDotsOriginalColors: false, halftoneDotsInverted: false,
lensDistortionSpread: 0.45, lensDistortionBulge: 0.3, lensDistortionDispersion: 0.65,
overlayEnabled: true, overlayOpacity: 0.35,
```

### Latent 背景 —— `LatentBackgroundTuning`
```ts
displayMode: 'both', colorSource: 'cover-theme', dynamicOnlyInPlayer: true, enhancedBeatResponse: true,
ditheringSpeed: 0.1, ditheringAudioSpeed: 1.2, ditheringSize: 2.5, ditheringOpacity: 0.55,
meshSpeed: 0.3, meshAudioSpeed: 2, meshDistortion: 0.8, meshSwirl: 0.1,
overlayEnabled: true, overlayOpacity: 0.35,
```

### Sora 背景 —— `SoraBackgroundTuning`
```ts
blank: false,
```

## 4. 改默认值 / 做迁移时的注意点

- 数值区间不在 `types.ts` 里，而在各样式面板组件（`SliderRow` 的 `min` / `max` / `step`）。改区间得改面板；
  改默认值改 `DEFAULT_<MODE>_TUNING`。
- 上游加字段时（例如 0.7.25 给凝彩加三个景深键），**老用户的设置树里没有这些键**。插件的 `applySnapshot`
  与 `buildTuningBundle` 都是 defaults-first 合并，缺键自动补默认；这条不能退化成整对象替换。
- 迁移桌面 Folia 配置时同样按 `DEFAULT_*_TUNING` 合并后再用，`readStoredTuning` 也走 `storage.read` 把缺字段补成
  完整 tuning。
- 智能动感效果的开关与强度不在这套 tuning 里：它们是 `SmartBeatSettings.effects[<effectId>]`
  （`{on, strength}`，强度 0–2，默认 `{on: true, strength: 1}`），而该模式在当前插件里不暴露（见
  [`style-map.md`](style-map.md) §3）。`tuning.ts` 的 `resetNotice` 只负责样式自己的重置提示。
