# 可视化器运行时契约

插件的播放画面由 **Folia 自己的 `VisualizerRenderer`** 画，宿主只喂输入。本文是那套输入与生命周期的权威
说明：任何要改渲染数据、字幕、音频或样式切换的人，先读这里。

- 上游源码：`work/folia/folia-major-main`（Folia **0.7.26**）；下文路径均相对它。
- 插件侧落点：`poc/webview/host/Shim.js`（把宿主消息变成页面事件）、
  `poc/settings-ui/src/publisher/config.ts`（`config` 构建）、`poc/settings-ui/src/bridge.ts`（页面桥）。
- 样式与背景清单：[`style-map.md`](style-map.md)；tuning 默认值：[`tunings.md`](tunings.md)。
- 「MV」= framer-motion 的 `MotionValue`。

## 0. 最小输入

渲染任一样式只需 4 类输入，不需要播放器、Electron 或文件系统：

1. **三个 MV**：`currentTime`（秒）、`audioPower`（**0..255**，不是 0..1）、`audioBands`
   （`{bass, lowMid, mid, vocal, treble}` 各 0..255 + 可选 `spectrum: MV<Uint8Array>`）。
2. **离散 props**：`currentLineIndex`、`lines`、`theme`，加可选的 `showText` / `coverUrl` / `seed` / 字号倍率等。
3. **一个 mode 字符串** → `<VisualizerRenderer mode={mode} {...props} />`。
4. **i18n 与 CSS**：部分样式用 `t('ui.waitingForMusic')` 之类的文案；kit/样式需要 Folia 编译出的 Tailwind CSS
   与 `--text-primary` 等主题变量。

实际上这几件事已经由「Folia 自己的 OBS 页面」替我们做好了：`src/components/obs/ObsBrowserSourceApp.tsx` 是纯浏览器
页面，它自建 MV 与 rAF、用 `EventSource` 读 `config` / `clock` / `audio` 三条流，然后挂 `VisualizerRenderer`。
插件注入的 `Shim.js` 只是把 `EventSource` 换成宿主消息驱动 —— 这是**参照实现也是生产路径**，不是模拟。

## 1. MotionValue 契约

源码：`src/components/visualizer/definition.ts`、`src/stores/motionSignals.ts`。

- 应用内这些 MV 是**模块级单例**（`motionValue(0)`），组件只读，永不写回 store。
- 两种消费方式：词级/帧级用 `useMotionValueEvent` / `useTransform`；行级用 `useVisualizerRuntime` 直接
  `currentTime.get()` 取快照（**不订阅**，行号变化靠父组件重渲染）。
- `currentLineIndex === -1` 表示「当前没有活动行」（前奏/行间空档），是合法且常见的状态，样式据此显示等待文案
  或上一句余韵。
- OBS 页面每帧做的事（`ObsBrowserSourceApp.tsx`）：`currentTime.set(resolveObsBrowserSourceClockTime(clock))`
  + 用 `findLatestActiveLineIndex(lines, t)` 算行号（只在变化时才 `setState`）。

## 2. `VisualizerSharedProps` 全表

类型定义在 `src/components/visualizer/definition.ts`。

| prop | 类型 | 必需 | 语义 / 来源 |
|---|---|---|---|
| `currentTime` | `MotionValue<number>` | ✅ | 歌词时钟（秒），所有词/行动画的时间基准 |
| `duration` | `number?` | | 歌曲时长（秒）；未知 = 0 |
| `currentLineIndex` | `number` | ✅ | 当前活动行下标；`-1` = 无活动行 |
| `lines` | `Line[]` | ✅ | 全部歌词行（见 §3） |
| `theme` | `Theme` | ✅ | 当前歌曲主题（颜色/字体/动画强度/wordColors） |
| `subtitleTheme` | `Theme?` | | 字幕专用主题（缺省 = theme） |
| `isDaylight` | `boolean?` | | 亮色主题 |
| `audioPower` | `MotionValue<number>` | ✅ | **0..255**（bass/lowMid 均值 ^3），见 §7 |
| `audioBands` | `AudioBands` | ✅ | 5 频段各 0..255 + 可选 spectrum，见 §7 |
| `showText` | `boolean?` | | 是否显示歌词文本；缺省 true |
| `songTitle` / `songArtist` / `songAlbum` | `string?` | | 曲目元数据（片尾卡/封面用） |
| `coverUrl` | `string?` | | 封面地址（背景/莫奈等用）；背景层把它缩到 1024 宽 |
| `temperaLayerImageAssets` | `{id,name,url}[]?` | | 凝彩图层图片（OBS 页面用它替代 IndexedDB） |
| `seed` | `string \| number?` | | 随机种子（同一首同布局，通常 = 曲目 id） |
| `songHandoff` | `VisualizerSongHandoff?` | | automix 混音交接（见 §9.3；非交接场景 = null） |
| `staticMode` | `boolean?` | | 画静帧，不跑持续动画 |
| `backgroundStaticMode` | `boolean?` | | 背景不逐帧动 |
| `visualizerOpacity` | `number?` | | 整个可视化层不透明度（「整体透明度」，0.2–1） |
| `background` | `VisualizerBackgroundConfig?` | | 背景配置（见 §10） |
| `lyricsFontScale` | `number?` | | 歌词字号倍率（0.85–1.4，默认 1） |
| `subtitleFontScale` | `number?` | | 字幕倍率（0.85–1.4，默认 1） |
| `subtitleOverlayOpacity` | `number?` | | 字幕层不透明度（默认 0.6） |
| `subtitleOverlayBackground` | `boolean?` | | 字幕光晕底（默认 true） |
| `subtitleUpcomingLyricsBlur` | `boolean?` | | 下一句预览加模糊（默认 true） |
| `showHarmonySubtitle` | `boolean?` | | 和声字幕层开关（默认 true） |
| `harmonySubtitleBackground` | `boolean?` | | 和声字幕光晕（默认 true） |
| `isPlayerChromeHidden` | `boolean?` | | 播放器 chrome 是否隐藏（影响字幕底距） |
| `hideTranslationSubtitle` | `boolean?` | | 隐藏底部字幕层 |
| `showSubtitleTranslation` | `boolean?` | | 是否显示译文（配合 `subtitleContentMode`） |
| `subtitleContentMode` | `'translation' \| 'romanization' \| 'both' \| 'none'?` | | 副字幕内容（旧字段，本页只发 `'translation'`） |
| `subtitleOverlayLayout` | `SubtitleOverlayLayout?` | | 字幕行组合，本页按设置树的 `subtitle.subtitleOverlayLayout` 下发；缺省 `DEFAULT_SUBTITLE_OVERLAY_LAYOUT = 'translation'` |
| `paused` | `boolean?` | | 暂停（时钟不再推进） |
| `onBack` | `() => void?` | | 返回按钮回调（仅当样式壳自己画返回键） |
| `isPanelOpen` | `boolean?` | | 播放面板打开（影响返回键/热区） |
| `alwaysShowBackButton` | `boolean?` | | 常显返回键 |
| `onPlayerPanelGuideHotspotChange` | `(active: boolean) => void?` | | 触摸右下热区时通知宿主显示引导 |
| `onLyricLineSeek` | `(lyricTimeSec: number) => void?` | | 点歌词行跳转（仅 `seeksOnLineClick` 的样式拿到） |
| `isPreviewMode` | `boolean?` | | 设置页预览（部分样式简化/降载） |
| `visualizerTunings` | `VisualizerTuningBundle?` | | 全量 tuning 包，见 §2.1 |
| `onVisualizerTuningChange` | `(patch: object) => void?` | | 样式在舞台上改自己的 tuning（拖动部件）时回写 |
| `classicTuning` … `lumiereTuning` | 各 `XxxTuning?` | | 每样式的命名 tuning prop（`applyVisualizerTuning` 注入） |
| `cappellaCustomEmojiImages` / `cappellaCustomAvatarImages` | 数组? | | 群唱自定义表情/头像（可空） |
| `monetPortraitImage` | `MonetPortraitImage?` | | 莫奈人像图（可空；为空用封面） |
| `onMonetTuningChange` | `(patch) => void?` | | 莫奈快捷控件 |

只被少数样式用到的 prop（凝彩图层、莫奈人像、群唱资产）传 `null` / `[]` 即可，渲染器不校验。

### 2.1 样式入口与 tuning 注入

`VisualizerRegistryEntry`（同文件）的完整字段见 [`style-map.md`](style-map.md) §2。与本文相关的两条：

- `render` **必须**是 `React.lazy` 包装，调用方必须提供 `Suspense` 边界（`VisualizerRenderer` 内部已有
  `fallback={null}`）。
- tuning 走 `applyVisualizerTuning(mode, props, bundle)`（`tuningRegistry.ts`）：有 `apply` 的样式拿到命名 prop，
  没有 `apply` 的样式自己用 `read(props.visualizerTunings)` 从 bundle 取。bundle 里少键会让渲染器算 `NaN`，
  所以插件侧有两道 defaults-first 打底（见 [`tunings.md`](tunings.md) §1）。

## 3. 歌词行模型（`Line` / `Word`）

定义：`src/types.ts`（`Word`、`Line`）。时间单位**全部是秒**。

```ts
interface Word { text: string; startTime: number; endTime: number; syllables?: LyricSyllable[] }
interface Line {
  words: Word[]; startTime: number; endTime: number; fullText: string;
  translation?: string; romanization?: string; id?: string; agentId?: string; songPart?: string; blockIndex?: number;
  alternateTexts?: LyricAlternateText[]; backgroundVocal?: LyricBackgroundVocal; backgroundVocals?: LyricBackgroundVocal[];
  renderHints?: LineRenderHints; isChorus?: boolean; chorusEffect?: 'bars' | 'circles' | 'beams';
  wordSegments?: string[];      // 用户保存的词边界，join('') === fullText，优先于自动分词
  autoWordSegments?: string[];  // icu-folia 自动词边界，否则回退 Intl.Segmenter
}
```

- 词间可以有 gap；样式**不得**假设 `words[i].endTime === words[i+1].startTime`。
- 逐字词：中日文常见 `words` 每项一个 grapheme；英文一行 5–12 个 token 词。
- 行渲染结束时间不是 `line.endTime`：走 `src/utils/lyrics/renderHints.ts` 的 `getLineRenderHints` /
  `getLineRenderEndTime`。`getLineRenderEndTime(null | undefined)` 返回 **`Number.NEGATIVE_INFINITY`**，所以
  「没有行」在 `currentTime > endTime` 这类比较里自然算作已经过去；把它改成 0 会让前奏阶段误判成 `t=0` 那一行已结束。
  阈值 `MICRO_LINE_DURATION_THRESHOLD = 0.10`、`SHORT_LINE_DURATION_THRESHOLD = 0.18`、
  `MICRO_LINE_RENDER_FLOOR = 0.067`；由此派生 `timingClass`（micro/short/normal）、`lineTransitionMode`
  （micro → `none`、short → `fast`）、`wordRevealMode`（micro → `instant`、short → `fast`）。
- 提示是**可缓存**的：`line.renderHints` 命中时直接用，否则 `buildLineRenderHints(line)` 现算。跨进程传来的行没有
  `renderHints`（协议里不带这个字段），播放页会现算，这是正常路径。
- 插件侧把 SPW 的逐字时轴映射成这套结构：`publisher/config.ts` 的 `buildLine`。有 `words` 就用，没有时按字符均分
  （`fallbackWords`）—— 缺 `words` 会让逐词样式整行不动画。

### 3.1 行/词查询工具（`runtime.ts`）

| 函数 | 语义 |
|---|---|
| `getRecentCompletedLine({lines, currentLineIndex, currentTime, getLineEndTime})` | **仅当 `currentLineIndex === -1`** 时生效；从尾向头找第一条已结束的行（行间空档继续显示上一句） |
| `getUpcomingLine(lines, currentLineIndex, currentTime)` | 有活动行 → 下一行；无 → 第一条 `startTime > currentTime` |
| `getUpcomingLines(lines, index, count = 2)` | 无活动行 → `[]`；用于「下一句预览」 |
| `shouldPreheatLine(line, currentTime, {minLead, maxLead})` | 按提前量预热 |
| `useVisualizerRuntime({...})` | 返回 `{currentTimeValue, activeLine, recentCompletedLine, upcomingLine, nextLines}` |

## 4. 词级动画（`GlowWord`：流光 / 云阶共用）

### 4.1 三态与时间窗（`glowWordTiming.ts`）

- `resolveGlowWordRenderProfile(line)` → `wordLookahead` = instant `0.03` / fast `0.08` / normal `0.15`。
- `getGlowWordActiveEndTime`：instant → 整行 `renderEndTime`；fast → `min(lineRenderEndTime, max(word.endTime,
  word.startTime + 0.12))`；normal → `word.endTime`。
- 状态：`active` 当 `t >= startTime - lookahead && t <= activeEnd`；`passed` 当 `t > activeEnd`；只在状态变化时
  `setState`。状态只影响动画，不控制显隐（词留在屏上直到行容器退出）。
- 行容器动效（`getGlowWordLineContainerMotion`）：`none` / `fast` / `normal` 三套 initial/animate/exit，
  三者都设 `transitionEnd = {filter: 'none'}`（避免常驻 filter 图层）。

### 4.2 三层 DOM（`GlowWord.tsx`）

1. 外壳 `motion.div`（`origin-center relative will-change-transform whitespace-nowrap`），
   `fontWeight: resolveThemeFontWeight(theme, 700)`、`lineHeight: 1.22`；
2. **glow 层** `absolute inset-0 select-none pointer-events-none`（多 grapheme 时逐 grapheme 一个 span）；
3. **body 层** `relative z-10`；
4. 可选合唱涟漪（`isChorus && active`）。

变体数值见 `glowWordVariants.ts` / `wordGlow.ts`。两处维护要点：

- passed 量化分支必须**重申 color**，否则透明字形不投 `drop-shadow`，辉光瞬间消失；
- Linux/Chromium 上渐变 `text-shadow` 会让 glyph cache 每帧新建 strike（fd 泄漏，约 35 分钟后合成器停帧），
  `isGlowBlurQuantized()` 为真时改整层 `filter: drop-shadow(...)`。**WebView2（Windows）默认不触发**。
- grapheme 时序由 `src/utils/lyrics/graphemeTiming.ts` 决定：有 `word.syllables` 按音节均分，否则按 grapheme 数均分。

### 4.3 关键词着色（`wordColoring.ts`）

`Theme.wordColors: {word, color}[]` → `resolveWordColor`（逐词）、`prepareWordColorMatchers` /
`buildWordColorRanges`（行内 range，最长匹配优先）。流光用法：`activeColor = resolveWordColor(...)`，
`baseColor = theme.primaryColor`。

## 5. 主题与字体

见 [`style-map.md`](style-map.md) §6（`Theme` 结构、封面取色、字体栈、`@font-face`、自定义字体与字号范围）。
渲染相关的补充：

- `isDaylight` 由设置岛的 `publisher/deriveTheme.ts` 判定（封面亮度 > 0.55 为亮色；播放页透明时改用系统深浅色，
  封面只提供色相），同时体现在 `theme` 和 prop 上。亮色主题影响部分样式的配色与后处理。
- `resolveThemeFontWeight(theme, fallback)` 把字重 clamp 到 100–900（step 10）。
- 字号倍率由各样式乘进自己的 clamp；字幕字号公式见 §8。

## 6. 渲染生命周期

### 6.1 `VisualizerRenderer`（真正被挂载的组件）

1. `shownMode = useDeferredValue(mode)` —— 新样式模块没到时旧样式留场。
2. `entry = getVisualizerRegistryEntry(shownMode)`；补默认背景 `DEFAULT_VISUALIZER_BACKGROUND_MODE`。
3. `resolvedProps = applyVisualizerTuning(shownMode, sharedProps, props.visualizerTunings)`。
4. `transition = animateStyleSwitch && !staticMode && !reducedMotion ? softFocus : null`。
   `animateStyleSwitch` **默认 `false`**，OBS 页面不传它 —— 也就是插件里切样式是直接换，不做过渡。
5. `songHandoff = transition ? props.songHandoff : null`；`backgroundTransition = transition && handoff.progress
   ? alongProgress(transition, handoff.progress) : transition`。
6. DOM：`<Suspense fallback={null}>` 里 `<VisualizerBackdrop>`（背景 + 样式 + 视频层 + 舞台插槽）包
   `<VisualizerStyleTransition>`；`<VisualizerHarmonyOverlay>` 在 Suspense **外面**（切样式不闪）。

### 6.2 `VisualizerBackdrop`

根 `relative w-full h-full overflow-hidden`，`opacity = visualizerOpacity ?? 1`。内部顺序：

1. 背景层 + 视频层（`VisualizerBackdropLayers`：`VisualizerBackgroundTransition` → `VideoLayer`）
2. `FoliumStageLayerSlot slot="player.stage.back"`（mod 舞台层）
3. 样式本体（`VisualizerStyleTransition`）
4. `FoliumStageLayerSlot slot="player.stage.front"`（`z-20`，`pointer-events-none`）

- 背景 cover 固定缩到 **1024** 宽：`getSizedCoverUrl(coverUrl, 1024)`。
- 视频层只在主界面播放页画（`!isPreviewMode && !staticMode && isMainAppSurface`）；OBS surface 的
  `isMainAppSurface` 为 false，所以**插件里没有视频层**。
- 舞台插槽同样只在非预览、非静态模式下渲染。

### 6.3 `VisualizerShell`（样式内部的通用外壳）

所有样式 renderer 用它包内容：根 `w-full h-full flex flex-col items-center justify-center overflow-hidden relative`，
主题字体/字重/`visualizerOpacity`，背景透明。

- **返回键**：`absolute top-6 left-6 z-30 h-10 w-10 rounded-full backdrop-blur-md bg-black/20`，
  `ChevronLeft size 20`；`isBackButtonVisible = alwaysShowBackButton || showBackButton`，
  后者由指针是否进入左上 **120×120** 热区（`PLAYER_CHROME_HOTSPOT_SIZE`）决定。
- **右下热区**：同样 120×120；触摸时 `onPlayerPanelGuideHotspotChange(true)`，`TOUCH_GUIDE_DISPLAY_MS = 1400`
  后自动收起。
- 插件不传 `onBack` / `alwaysShowBackButton`（返回与关闭由宿主 chrome 负责），所以样式壳**不画**返回键，
  避免出现重复按钮。

## 7. 音频输入

> 这是最容易做错的一节。插件宿主的选择是**照 Folia 的生产管线算**，不是在页面里重算。

### 7.1 尺度：0..255，不是 0..1

- 所有音频 MV 的值都是 **AnalyserNode 字节尺度 0..255 的浮点**（`getByteFrequencyData` 后经 gamma 整形），
  样式自己 `/255`。
- **反例**：Folia 设置页预览里的假数据是 0..1，因此在预览里 latent/monet/cadenza/diorama 的音频反应≈0。
  不要照抄预览的尺度。
- `spectrum`：`Uint8Array`，真机 1024 bin（`fftSize = 2048`），元素 0..255，每帧替换。`new Uint8Array(0)`
  是合法的「没有 FFT」（暂停时真机就这样）。唯一严格消费者是莫奈：长度 ≤ `MIN_RAW_SPECTRUM_BIN = 6` 时静默
  退回五带插值；给 64/256/1024 都能工作。
- `beatImpact` / `downbeatImpact`（智能动感节拍包络）是**模块级 MV**，不在 `AudioBands` 里，范围 0..1。

### 7.2 生产管线（插件宿主即按此实现）

Folia 侧（`usePlaybackAudioBridge.ts` / `usePlaybackVisualizerBridge.ts`）：

```
fftSize = 2048 → 1024 bins；smoothingTimeConstant = 0.6；
minDecibels / maxDecibels 用浏览器默认（-100 / -30 dBFS）
每 rAF：
  analyser.getByteFrequencyData(buf)              // Uint8Array(1024)，原始字节
  spectrum.set(buf)                               // 未 gamma
  energy(minHz, maxHz) = 区间内 bin 的算术平均      // 不是 RMS，也不是峰值
  shape(v, boost) = (v / 255)^boost * 255
  audioPower = shape((bass + lowMid) / 2, 3)      // bass/lowMid 均值再 ^3
  bands: bass ^1.8 · lowMid ^2 · mid ^2 · vocal ^1.5 · treble ^2
频段：bass 20–150 · lowMid 150–400 · mid 400–1200 · vocal 1000–3500 · treble 3500–12000 Hz
      （vocal 与 mid 在 1000–1200 重叠）
```
宿主 C# 实现（`poc/webview/host/audio/`）逐条对应，并有自检：

- `SpectrumAnalyzer.cs`：`2048` 点 FFT → 1024 bin，**bin 宽 = `sampleRate / 2048`，绝不硬编码 21.5 Hz**；
  mag → 平滑 → `20*log10` → `255 * (dB - min) / (max - min)`；五带取区间算术平均；
  gamma 表与 Folia 同式（`FoliaAudioMapper.Shape`），`--selftest` 里有独立算出的期望值。
- `FoliaAudioMapper.cs`：gamma 曲线与暂停时的呼吸值；
- `LoopbackAnalyzer.cs`：WASAPI 环回采集，按 `1/TargetFps` 分析一个 2048 样本窗口并发帧。

> 上游那段 `getEnergy` 里的 `minHz / 21.5` 是**硬编码的 44.1kHz 假设**（`44100/2/1024 ≈ 21.53`）。插件宿主不抄
> 这个数字：采样率不是 44.1k 时（48k 很常见）照抄会让五个频带整体偏移。这是有意的偏离，不是笔误。

数值量级（用来对拍）：`audioPower` 原始 40→8.9 / 80→71.7 / 120→243；`bass`(^1.8) 100→46.9 / 150→96.5；
`mid`(^2) 100→39.2 / 150→88.2。**不套 gamma 会偏大 2–3 倍。**

### 7.3 无信号 / 暂停

不是 0，是**呼吸**：`breath = (sin(nowMs / 2000) + 1) * 20`（0..40），同时写 `power` 与 5 个 band，
`spectrum` 为空数组；周期约 12.6s。`paused`（prop）与音频值语义独立：前者由播放器状态决定，后者由
`audioEl.paused/ended`（宿主里是环回有无信号）决定，**两者要分开给**。

### 7.4 智能动感与节拍

- 默认关闭：`DEFAULT_SMART_BEAT_SETTINGS = {enabled: false, effects: {}}`；每个效果默认 `{on: true, strength: 1}`，
  `BEAT_EFFECT_STRENGTH_MAX = 2`。
- 哪些模型会跑由画面声明决定（`beatClockTargets.ts`）：取当前样式 `entry.beatEffects`（`entry.background !== false`
  时并上背景的）→ 有 `source: 'beats'` 才跑 beat_this，有 `'drums'` / `'stems'` 才跑 HTDemucs。没声明就一个模型都不跑。
- 关闭路径不影响画面一致性：不加载模型、包络恒 0，样式只吃 `audioPower` / `audioBands`。
- **本插件没有节拍通道**：宿主不产出也不转发 beat 消息，`config` 里不带 `smartBeat` 的效果数据，设置页也裁掉了
  相关卡片（[`settings-ui.md`](settings-ui.md) §3.1）。所以节拍效果不会触发，样式本身的动画不受影响。
- 若将来要接：包络参数是 `BEAT_FX_BEAT_DECAY_MS = 160`、`BEAT_FX_DOWNBEAT_DECAY_MS = 200`、
  `BEAT_FX_WEAK_BEAT_FLOOR = 0.35`，指数衰减 `exp(-dtMs / decay * 2.3)`，命中取 `max(current, gain * exp(...))`，
  `trackScale` 曲目动态范围 0.45..1；可用性 `useSmartBeatAvailability()` 返回
  `'ready' | 'desktopOnly' | 'noGpu'`。

## 8. 字幕层（`VisualizerSubtitleOverlay`）

内容解析（`resolveVisualizerSubtitleOverlayContent`）：

- `!showText || hideTranslationSubtitle` → 整层不渲染。
- 取行：`line = activeLine ?? recentCompletedLine`（行间空档继续显示上一句）。
- 行内容由 `subtitleOverlayLayout` 决定（`utils/lyrics/subtitleOverlayLayout.ts`，默认
  `DEFAULT_SUBTITLE_OVERLAY_LAYOUT = 'translation'`）：它是「行源」的组合，取值只有
  `current` / `translation` / `romanization` / `next` 四种，单行时是前三种之一，多行必须以 `current`
  开头、其后每行从 `next` / `translation` / `romanization` 里选（`parseSubtitleOverlayLayout` 是唯一
  判定）。例如 `'translation'` 只有译文行，`'current+translation'` 是「原文 + 译文」两行。
  本页把设置树的 `subtitle.subtitleOverlayLayout` 原样放进 config；缺省时用默认单行译文。
  **注意插件只发主/副文本，不发罗马音**：`romanization` 行取不到文本，本页因此在构建期把该选项
  滤掉、并在 store 侧把树里残留的罗马音行换掉（见 [`../known-inert-settings.md`](../known-inert-settings.md) §2）。
- 每个行源取文本：`current` → `line.fullText.trim()`，其余走 `resolveLyricAlternateText`；`hasReadableText`
  要求 `/[\p{L}\p{N}]/u` 命中（纯标点行不显示）；非 `current` 行若与本行 `current` 文本相同则去重（拉丁歌词的
  「译文」常等于原文）。
- 兜底：`rows` 为空且有活动行时，改显示下一句预览（`nextLines` 里第一条有可读文本的行）。

DOM 与样式：

- `absolute left-0 right-0 text-center space-y-2 px-4 z-20 pointer-events-none`；**`bottom` 直接绑 MV，
  不能用 transform**（下方压着 blur 光晕，多一个合成层会变色）。
- 光晕底（`subtitleOverlayBackground = true`）：径向渐变 + `blur-2xl` + `translateZ(0)`；
  文本阴影 `0 1px 2px ${colorWithAlpha(theme.backgroundColor, 0.24)}`。
- 译文行：`color: theme.secondaryColor`；字体走 `resolveThemeTranslationFontStack`；字重
  `resolveThemeFontWeight(subtitleTheme ?? theme, 次级 ? 400 : 500)`；次级行
  `SECONDARY_TRACK_SIZE_FACTOR = 0.88`、`SECONDARY_TRACK_OPACITY = 0.82`、`SECONDARY_TRACK_GAP_EM = 0.25`
  （`src/utils/lyrics/subtitleTrackStyle.ts`）。
- **字号只有一个来源**（`subtitleFontSizes.ts`，全样式一致，否则切样式那一下字幕会跳大小）：

  ```ts
  clampSize(min, preferred, max, s) = `clamp(${(min*s).toFixed(3)}rem, ${(preferred*s).toFixed(3)}vw, ${(max*s).toFixed(3)}rem)`
  resolveSubtitleFontSizes(lyricsFontScale) = {
    translationFontSize: clampSize(1.125, 2.6, 1.25, scale),
    upcomingFontSize:    clampSize(0.875, 2,   1,    scale),
  }
  ```
  最终字号再乘 `subtitleFontScale`（次级行额外 ×0.88）。
- 底距由 `usePlayerSubtitleBottomPx(isPlayerChromeHidden)` 给出；OBS 页面传 `isPlayerChromeHidden={true}`，
  它读到的是「底栏不在」的基线。插件自绘播放条，字幕落点不受它影响。

## 9. 三种「换」的机制

### 9.1 过渡曲线 `softFocus`（只在 `animateStyleSwitch` 打开时用）

`leave`：`{opacity:0, blur(8px), scale(1.02)}`，360ms；`enter`：同起点、`delay 80`、520ms。
该 prop 默认 `false`，插件也不打开，所以切样式是直接换 —— 与上游 OBS 源一致。

### 9.2 图层状态机

- 最多同时挂两层；`waits` 期间新层不可见、旧层不动；切回仍在离场的层会取消切换。
- `LEAVE_FALLBACK_MARGIN_MS = 1000`：离场动画 finish 事件可能不来（窗口隐藏），用 duration+1000ms 兜底移除，
  防 WebGL 上下文泄漏。
- 首帧门：新样式可 `claim()` 承诺上报首帧，未 claim 的在其 layout effect 后视为就绪；`FIRST_FRAME_LIMIT_MS = 1500`
  兜底（浮名首次布局实测 2.9s）。背景侧 `BACKGROUND_READY_LIMIT_MS = 1000`。

### 9.3 歌曲交接（automix）

`VisualizerSongHandoff`：`progress`（MV 0..1，0 直到 blend 宣告）+ 新歌的 seed/元数据/theme/lines/时钟。
只有 `followsSongHandoff === true` 的样式（莫奈）拿到它。歌曲真正切换要过 `songHandover.ts` 的
`decideSongCommit`：按 `getLyricsSignature`（行数 + 首行文本 + 分词边界的 FNV1a）**按内容而非数组身份**判定；
纯音乐额外需要 `(sawPlaybackReset && playbackTime >= 2) || 8000ms grace`。

**插件不实现 automix**：`config` 里没有 `songHandoff`，样式拿到的是 `null`（对样式代码而言是正常路径），
切歌直接换。

## 10. 背景系统

6 个 mode、背景 tuning 与样式覆盖规则见 [`style-map.md`](style-map.md) §5。渲染契约：

- `VisualizerBackgroundConfig`：`{mode?, transparent?, common?, customImage?, url?, <每个背景 tuning 槽>}`；
  插件下发的形状见 `publisher/config.ts` 的 `buildBackgroundConfig`（`{mode, transparent, common, latent, monet,
  nomand, sora, url}`，每槽是 `{ tuning }`）。
- `VisualizerBackgroundRenderProps`：`{config, theme, isDaylight, coverUrl, audioPower, audioBands, seed,
  staticMode, paused, blendMs?, blendProgress?}`。
- 背景画布由 `VisualizerBackdrop` 统一挂载；`entry.background` 可覆盖（浮名）或关闭（静止/町景/雾笺）。
- 设置页背景 tab 的渲染面板入参是 `VisualizerBackgroundSettingsProps`
  （`{config, actions, t, isDaylight, theme, controlCardBg, rangeInputClass, onSliderPointerDown, onSliderCommit}`）。

## 11. 宿主 → 页面的三条流

`Shim.js` 把宿主消息翻成页面认识的事件（`FakeEventSource`），字段级协议见 [`protocol.md`](../protocol.md)：

| 页面事件 | 宿主消息 | 页面侧真实来源 | 页面怎么用 |
|---|---|---|---|
| `config` | `config` / 页面 `pushConfig` | 设置岛 `publisher/config.ts` 构建的 `ObsBrowserSourceConfig`（≤10Hz、去重） | 决定样式/调参/背景/字体/字幕/透明 |
| `clock` | `state` | 插件播放时钟（`posMs/durationMs/playing/rate/tsMs`） | `resolveObsBrowserSourceClockTime` 插值出歌词时间 |
| `audio` | `audio` | 宿主 WASAPI 环回（0..255 已 gamma）+ 暂停呼吸值 | 写 5 个 band MV + `audioPower` + `spectrum` |

三条流各自的维护要点：

- **`config` 是唯一入口**：`Shim.js` 的 `deliver('config', data)` 同时记 `lastConfig` 并 `emitLocal('config')`，
  设置页的大预览据此镜像播放页（[`live-preview-iframe.md`](../live-preview-iframe.md) §2）。不要在设置页另造一份
  config 给预览用。
- **时钟插值**：播放中按 `currentTime + elapsed * rate` 外推并夹到 `duration`，暂停时直接用 `currentTime`，
  两者都减去 `lyricOffsetMs/1000`。OBS 页面每帧调用一次。
- **音频尺度**：见 §7；宿主已套 gamma，页面不再二次整形。

## 12. 性能开关

| 开关 | 来源 | 作用 |
|---|---|---|
| `textureResolution` | sonnet/tempera/lumiere 的 tuning（默认 1.5，范围 0.5–4） | pixi 渲染纹理倍率 |
| `staticMode` | prop | 不跑持续动画（OBS/省电） |
| `backgroundStaticMode` | prop | 背景不逐帧 |
| `paused` | prop | 暂停时钟 |
| reducedMotion | `useReducedMotionFor('uiMicroMotion')` | 系统减少动效时禁用过渡 |
| `isPreviewMode` | prop | 设置页预览降载 |
| DPR | 宿主 | OBS 页面按 `max(1, realWidth / 1920)` 算 `obsScale`，并覆写 `devicePixelRatio`/`innerWidth` |
| 背景质量 | `config.background.mode` | 背景之间开销差异大 |

**上游有一个 `frameRateLimiter`（`src/utils/frameRateLimiter.ts`），插件不使用它**：SPW 配置页的「帧率」项已在
v0.4.10 整条删除（上游的 `-1 ms` 容差让每个档位都达不到标称值，默认 `off` 本就等于跟随屏幕刷新率）。
`Shim.js` 会在每次文档创建时**主动清掉** `localStorage['visualizer_frame_rate']`，否则老版本写进去的值会永久
静默限流。

## 13. 源码索引

- 契约：`src/components/visualizer/definition.ts`（shared props / panel props / registry entry）、`src/types.ts`
  （`Word` `Line` `Theme` `AudioBands`、`DEFAULT_*_TUNING`、`DEFAULT_SMART_BEAT_SETTINGS`）
- 运行时：`src/components/visualizer/{runtime,glowWordTiming,GlowWord,glowWordVariants,wordGlow,wordColoring}.ts(x)`
- 字幕：`VisualizerSubtitleOverlay.tsx`、`subtitleFontSizes.ts`、`utils/lyrics/subtitleTrackStyle.ts`、
  `utils/lyrics/subtitleOverlayLayout.ts`、`hooks/usePlayerBottomBarBottomPx.ts`
- 切换：`styleTransition/{softFocus,layerTransition,VisualizerStyleTransition,VisualizerBackgroundTransition,
  firstFrame}`、`songHandover.ts`、`useShownTheme.ts`、`useHandoffCover.ts`
- 渲染：`VisualizerRenderer.tsx`、`VisualizerShell.tsx`、`VisualizerBackdrop.tsx`、
  `VisualizerHarmonyOverlay.tsx`、`backgrounds/definition.ts`、`backgrounds/VisualizerBackgroundRenderer.tsx`
- tuning：`tuningDefinition.ts`、`tuningRegistry.ts`、各 `<mode>/tuning.ts`
- 字体：`src/utils/fontStacks.ts`、`src/index.css`
- 渲染 hint：`src/utils/lyrics/renderHints.ts`、`graphemeTiming.ts`
- 生产参照：`src/components/obs/ObsBrowserSourceApp.tsx`（纯浏览器挂 `VisualizerRenderer` 的唯一范例，也是插件
  实际运行的页面）、`src/utils/obsBrowserSource.ts`
- 音频：`src/components/app/playback/bridges/{usePlaybackAudioBridge,usePlaybackVisualizerBridge}.ts`；
  插件实现 `poc/webview/host/audio/`
- 节拍：`src/services/beatFx/beatEffects.ts`、`beatClockTargets.ts`、`beatFxLive.ts`、`analysis/drumHits.ts`
