# Folia 复刻规格 · 总索引

> 上游 **Folia 0.7.22**（`folia-major-main`，AGPL-3.0）。这一组文档记录 **Folia 侧的技术契约**：样式映射、运行时
> 输入、设置页控件语义、全屏外壳层序、素材与授权约束。它描述的是「上游是什么样」，不是本仓库的实现说明 ——
> 本仓库怎么用这些契约，见 `docs/architecture.md`、`docs/settings-ui-impl.md`、`docs/host-app.md`。

## 1. 文档索引

| 文件 | 内容 |
|---|---|
| [`style-map.md`](style-map.md) | 15 个样式 ↔ `src/components/visualizer/<dir>` 映射（网格顺序 = `order` 升序）、命名纠错、渲染技术栈、共享依赖（pixi/three/pretext）、字体主题 |
| [`settings-ui.md`](settings-ui.md) | 设置页 1240×780 骨架、大预览 stage、5 个 tab（歌词动画/背景/字体/字幕/全局）、每个控件的 default/min/max/step/格式、kit 组件视觉规格、复用方案、坑与验收清单 |
| [`tunings.md`](tunings.md) | 15 种样式里 **14 种**（除 `still`）的 tuning storage key / setter / 面板 / 每个键的默认值 + 背景 tuning 默认值 |
| [`runtime-contracts.md`](runtime-contracts.md) | `VisualizerSharedProps` 全表、MotionValue 契约、Line/Word 语义与词三态、GlowWord、音频输入（0..255 + gamma + 呼吸值）、平移/切换/交接、背景、字幕、renderer 生命周期、性能旋钮、最小 harness 代码 |
| [`fullscreen-shell.md`](fullscreen-shell.md) | 全屏歌词 = 播放页外壳：z-index 层表、背景/视频/样式/字幕/和声层序、返回键 120px 热点、底部胶囊、chrome 自动隐藏与光标、设置页大预览、harness 复刻清单与验收 |
| [`assets.md`](assets.md) | 素材清单（截图、cappella 头像/表情、占位封面、构建入口/CSS）、app.asar 结构、无缩略图/无字体说明、AGPL-3.0 合规约束与复现命令 |

原始调研笔记（未精简、含源码行号）：`research/folia/notes-runtime.md`、`notes-audio.md`、`notes-shell.md`、
`tuning-defaults.md`。

## 2. 必须知道的结论

1. **网格顺序 = 各样式 `entry.tsx` 的 `order` 升序**，不是目录名/字母序：商籁10 · 凝彩20 · 绘光25 · **花火26** ·
   流光30 · 心象40 · 云阶50 · 浮名60 · 倾诉70 · 回环80 · 莫奈90 · 时计100 · 群唱110 · 镜台120 · 静止130。样式架末尾
   还有一个「随机」，所以宽窗是 8 列 × 2 行、计数显示 16。
2. **第 13 个中文是「镜台」，不是「铭台」**：`zh-CN.ts:900`、`diorama/entry.tsx:18` 均如此；`铭台` 在源码中出现 0 次。
3. **样式网格没有缩略图图片**：每格是 `preview/LyricStylePicture.tsx` 用真渲染器实时画的小图。复用组件即可，别找 PNG
   （本项目自己的设置页用的是另行截图生成的 JPG，见 `assets.md` §3）。
4. **默认值以源码为准**：`DEFAULT_SMART_BEAT_SETTINGS = { mode: 'off', effects: {} }`（**三档 `off`/`cached`/`on`**，
   不是布尔）；`textureResolution` 默认 **1.5**（不是 1.00）；单效果默认 `{on:true, strength:1}`，强度上限 2。
5. **音频尺度是 0..255，不是 0..1**，且要套 gamma：`audioPower = ((bass+lowMid)/2 /255)^3 *255`（各频段另有 boost）。
   设置页 preview 用 0..1 是**反例**，照抄会让多个样式「不随音乐动」。
6. **渲染一个样式的最小输入**：`mode` + `currentTime/audioPower/audioBands` 三个 MotionValue + `currentLineIndex` +
   `lines` + `theme`，即可 `<VisualizerRenderer>`；不需要 Electron/播放器/文件系统。
7. **Folia 自带现成「浏览器 harness」参照**：`src/components/obs/ObsBrowserSourceApp.tsx` 在纯浏览器页里挂
   `VisualizerRenderer`，自造 MV、改写 DPR/尺寸，经 SSE 接收时钟/音频——可直接抄成 WebView 入口。
8. **构建产物可直接静态托管**：解包 `app.asar` 后的 `dist/` 就是完整前端；主样式包是 `dist/assets/src-*.css`
   （文件名带 content-hash，**按内容找**，不要硬编码）。
9. **全屏歌词不是独立窗口**：它就是播放页 `absolute inset-0 z-0` 的 visualizer 层；返回键是左上 120×120 热区，
   chrome 3s 自动隐藏。
10. **授权硬约束**：Folia 是 **AGPL-3.0**。把其代码打进插件再分发 ⇒ 插件整体按 AGPL-3.0 开源并提供源码；需保留版权头、
    附 LICENSE/第三方说明，不得用 Folia 名称/图标当品牌。落地细节见仓库根 `THIRD_PARTY_NOTICES.md`。

## 3. 使用这些契约时的要点

1. **设置页**：复用 Folia 的 `VisPlaygroundSettingsPanel`/`VisPlayground`/kit 组件（React island，`createRoot`），
   CSS 用 `src-*.css`，i18n 用上游 `zh-CN` locale，状态用上游 store（`localStorage`）。import 清单与 provider 清单见
   `settings-ui.md` §8。
2. **全屏歌词**：宿主全屏窗口 + 透明 WebView2，内部挂 `VisualizerRenderer`（单样式按需 lazy），字幕/和声由 renderer
   自带；返回键/底部胶囊/自动隐藏按 `fullscreen-shell.md` §7 自写（可后置）。
3. **数据**：时钟自建 rAF；音频按 `runtime-contracts.md` §7.2 的公式给 0..255，或接 audio-probe 的 WASAPI 数据。
   智能动感默认 `off`；没有模型的宿主里 `useSmartBeatAvailability()` 恒 `desktopOnly`，相关效果静默不动（不报错）。
4. **打包**：`dist` 静态资源 + cappella PNG + 两个占位封面（Vite 会自动打进去）；字体用系统字体 / 自备 Noto Serif SC
   woff2（OFL），不要依赖 Folia 的 CDN。

## 4. 已知约束 / 需要注意的地方

| 项 | 现状 |
|---|---|
| pixi/three 体积 | sonnet/tempera/lumiere/hanabi 是 WebGL2（pixi）；diorama 用 three.js。三者都是 lazy chunk，不进首屏 |
| 智能动感模式 | 默认 `off`；`on` 需要 WebGPU + beat_this/HTDemucs 权重，权重随桌面安装包发布、不在 web dist 里 |
| 音频 | 需要真实音频才有正确的 0..255 输入；无音频时用呼吸值或常量占位 |
| 字体 | `Folia Noto Serif SC` 走上游 CDN，离线/内网会回退系统字体 |
| AGPL | 插件整体 AGPL-3.0，须提供源码与声明 |

## 5. 关键入口（上游路径）

```
设置页:   src/components/visualizer/window/VisPlayground.tsx + VisPlaygroundSettingsPanel.tsx
渲染器:   src/components/visualizer/VisualizerRenderer.tsx
全屏层:   src/App.tsx（data-testid="player-visual-surface"）
OBS 参考: src/components/obs/ObsBrowserSourceApp.tsx
样式注册: src/components/visualizer/registry.tsx、src/types/visualizerModes.ts
```
