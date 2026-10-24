# 完整预览动画（Live Preview）契约 — iframe + OBS surface

目标：歌词样式设置页左侧大预览必须是 **Folia 真实动画渲染器**（真视觉、真动效、可暂停/播放），
取代 v0.1.5 的 Ken Burns 静态帧漂移。

v0.4.1 起预览是 **播放页的逐帧镜像**：不再有占位歌、示例歌词或预设背景。预览框渲染的就是播放页
此刻收到的配置（真实曲目/歌词/主题/背景与播放页透明开关）与真实时钟/音频，设置页不再“猜”任何东西。

## 架构

设置覆盖层（settings-ui.js）由宿主注入到 **顶层文档**，该顶层文档就是 Folia 的 OBS surface：
`https://spw-folia.local/index.html?obs=1&token=spike`（已挂载真实 `VisualizerRenderer`）。

预览 = 在同一顶层文档里放一个**同源 iframe**，加载 bundle 里新增的 `preview.html`（= dist index.html 的副本 + 子帧垫片），
URL：`https://spw-folia.local/preview.html?obs=1&preview=1`。
iframe 内跑 Folia 自己的 `ObsBrowserSourceApp`（真实渲染器），不需要任何 stubs / 不需要重建渲染器图。

数据流（v0.4.1）：

```
宿主/插件 ── stdin/stdout ──▶ 顶层 Shim.js
   │  state/audio 消息 → SSE clock/audio + emitLocal('state'/'audio')
   │  config 消息 / settings island 的 pushConfig → deliver('config')
   ▼
settings-ui (top doc)
   │  usePlayerConfig(): 读 bridge.lastConfig() + bridgeOn('config')，镜像“播放页实际收到的 config”
   │  postMessage({__spwFoliaPreview:1, kind:'config'|'live'|'paused'|'state'|'audio'})
   ▼
iframe (preview.html)  PreviewShim.js（子帧垫片，classic script，在 module 入口前执行）
   │  覆盖 window.EventSource = FakeEventSource；把父页消息转成 SSE 事件
   │  live 模式：转发真实 clock/audio（不再本地合成）；无父页桥时保留合成回退
   ▼
ObsBrowserSourceApp → VisualizerRenderer（15 样式全部可用，含 three/pixi 懒加载块）
```

为什么必须 iframe：iframe 内拿不到 WebView2 桥（`chrome.webview` 只在顶层），所以真实 clock/audio
由顶层订阅桥事件后转发；config 由父页直传（同源 + `contentWindow.postMessage`），从而**自动镜像
播放页正在渲染的状态**（样式/调参/背景/字体/字幕/透明）。

## config 的唯一来源（v0.4.1，关键）

`Shim.js` 的 `deliver('config', data)` 是播放页收到 config 的**唯一入口**（宿主下发的 config 与
settings island 的 `pushConfig` 都走这里）。v0.4.1 起它在投递的同时：

- 记住 `lastConfig = data`，并通过 `bridge.lastConfig()` 暴露；
- `emitLocal('config', data)`，让设置 island 能订阅。

设置 island 的 `useConfigPublisher.ts` 因此新增：

- `ensurePlayerConfigSource()`：首次读 `bridge.lastConfig()`，随后 `bridgeOn('config')` 持续跟随；
- `usePlayerConfig()`：返回播放页最后一版 config（null = 播放页还没有 config，预览框保持空）；
- 诊断环 `window.__spwFoliaPublishHistory`（最近 8 次 config 的 song/lyric 行数/透明位）；
- `getLastPublishedTheme()/getLastPublishedSubtitleTheme()` 仍保留给旧调用方，但预览不再依赖它们。

**不要**用 `buildConfig()` 在设置页重新构造预览 config（v0.4.0 及以前的做法）：那会得到一份“设置页
以为的”配置，与播放页实际渲染的配置可能不同（例如宿主/插件直接下发的 config）；v0.4.1 要求逐字节相同。

## 尺寸与缩放（关键，保真度）

Folia 自己的 playground 是「按窗口大小排布，再整体缩放塞进预览框 + 1.15 倍放大裁切」。
OBS surface 只在 >1920 时放大；小 iframe 会排成“小窗口布局”（相对字号不对）。
因此：**iframe 元素固定 1920×1080 CSS px**，再用 CSS transform 缩放并居中裁切：

```
k = max(boxW / 1920, boxH / 1080) * 1.15          // 1.15 = Folia DEFAULT_SAMPLE_ZOOM
iframe { position:absolute; width:1920px; height:1080px; left:50%; top:50%;
         transform: translate(-50%,-50%) scale(k); transform-origin:center;
         pointer-events:none; border:0; }
wrapper { position:absolute; inset:0; overflow:hidden; }
```

这样 iframe 内 `documentElement.clientWidth = 1920` → OBS surface 的 resize 逻辑 `scale = max(1, 1920/1920) = 1`，
排布等同 1080p 全屏播放，视觉与全屏模式一致。

## 消息契约（父 ⇄ 子，同源 postMessage）

所有消息带 `__spwFoliaPreview: 1`。

父 → 子：

| kind | payload | 说明 |
| --- | --- | --- |
| `live` | `true` | 进入 live 模式：停用子帧合成时间线，改用父页转发的真实 clock/audio |
| `config` | `ObsBrowserSourceConfig` | 播放页实际收到的完整配置（逐字节镜像，不再由设置页构造） |
| `paused` | `boolean` | 暂停时冻结时间轴（子帧发 `playerState:'PAUSED'` 钉住时钟；停 rAF） |
| `state` | 宿主原始 state 消息（`posMs/durationMs/playing/rate/tsMs`） | 仅 live 模式；子帧按 Shim.js 同款映射转成 SSE `clock` |
| `audio` | 插件原始 audio 消息（`bands`/`spectrum`/`audioPower`…） | 仅 live 模式；子帧按 Shim.js 同款映射转成 SSE `audio` |

子 → 父：

| kind | payload | 说明 |
| --- | --- | --- |
| `ready` | `{}` | 子帧就绪；子帧在 0/100/300/1000/2000 ms 重试直到收到第一条 `config` |
| `error` | `{ message: string }` | 子帧初始化失败（父页据此回退静态图） |
| `stats` | `{ canvases: number, frames: number }` | 每秒一次，调试/验收用 |

父页在收到 `ready` 后发送 `live` + `paused` + 当前 `config`，之后转发每条 `state`/`audio`
（暂停或页面隐藏时暂停转发；`paused` 变化时重发）。4s 内未收到 `ready` 或收到 `error` → 预览
回退为 `StylePreview`（Ken Burns）。

## 子帧垫片 `poc/webview/host/PreviewShim.js`

classic script，由 `preview.html` 在 `<head>` 里以 `<script src="/_host/preview-shim.js"></script>` 引入
（**必须早于** module 入口；module 是 deferred，classic 先执行）。要求：

1. 幂等：`if (window.__SPW_FOLIA_PREVIEW_SHIM__) return;` 后置位。
2. `window.top === window` 时直接 `return;`（只在子帧生效）。
3. 实现 `FakeEventSource(url)`：`addEventListener(name, fn)` 按事件名记监听；`onopen` 立即（setTimeout 0）；
   `close()`；`readyState` 兼容。**事件对象 `data` 必须是 JSON 字符串**（ObsBrowserSourceApp 用 `JSON.parse(event.data)`）。
4. `window.EventSource = FakeEventSource`（覆盖宿主 Shim 可能已设的值）。
5. 监听 `window.addEventListener('message')`：`event.data.__spwFoliaPreview === 1` 时按 kind 处理
   （`config` / `live` / `paused` / `state` / `audio`）。
6. **live 模式（v0.4.1）**：`state` → `clock`（`currentTime = posMs/1000`、`duration = durationMs/1000`、
   `playerState = playing === false ? 'PAUSED' : 'PLAYING'`、`playbackRate = rate`、`lyricOffsetMs/1000`）；
   `audio` → 归一成 `{audioPower, bands:{bass,lowMid,mid,vocal,treble}, spectrum: Uint8Array, sentAtMs}`；
   `paused` 时用最后一帧 state 发 PAUSED 钉住时钟，恢复时重发最后一帧 state（下一帧真实 state 到来即接上）。
7. **合成回退模式**（父页没有发 `live`，例如浏览器里直接打开 preview.html）：保留 v0.1.6 的本地 rAF 合成
   clock/audio（`DEFAULT_LOOP_SECONDS = 14.4`，正弦 wave/spectrum），保证垫片可独立调试。
8. 透传诊断：`window.onerror` / `unhandledrejection` → 父页 `{kind:'error'}`（父页转发到宿主 log）。
9. 暴露 `window.__SPW_FOLIA_PREVIEW__ = { receivedConfig, live, frames, canvases, clockMs, paused,
   configTransparent, configUpdatedAt, songTitle, configLyricCount }` 供验收 eval。

## 透明背景（v0.4.1 真机验收）

- 播放页透明 = `config.background.transparent === true`：OBS 根节点不画背景，且 `ObsBrowserSourceApp`
  启动时已把 `document.documentElement/body` 背景设为 `transparent`（宿主再用色键让桌面透出）。
- 预览框因此能**真实呈现透明**：`Stage` 外层不在 iframe 下铺任何预设色，只在透明时给 wrapper
  加 `.st-stage-transparent`（棋盘格）并显示左下角「播放页透明背景」chip；iframe 自身 `background:transparent`，
  棋盘格即表示“这里会透出桌面”。
- 不支持透明的样式（monet、浅色 lumiere）仍由 `setTransparentPlayerBackground` 的守卫与
  `transparencyCompat.ts` 的渲染期 tuning 处理，预览与播放页保持一致。

## settings-ui 侧（v0.4.1）

- `poc/settings-ui/src/model/Stage.tsx`：`const config = usePlayerConfig()`（null 时渲染空框，避免闪烁）；
  透明判断 `config?.background?.transparent === true`；不再调用 `buildConfig` / `previewTrackFor` /
  `getPreviewPlaceholder` / `previewStartOffsetFor`。
- `poc/settings-ui/src/model/LivePreview.tsx`：props `{ paused, config, uploadedFonts, onError? }`
  （`loopDuration`/`startOffset`/`meta` 已删除）；ready 后发 `live` + `paused` + `config`；
  `bridgeOn('state'/'audio')` → `send('state'|'audio', payload)`（仅 ready 且非 paused/hidden）。
- `poc/settings-ui/src/model/currentLyric.ts`：仅剩 `currentLyricText()` / `useCurrentLyricText()`
  （字体选择器样本行用）；占位歌数据 `previewSong.ts` 已删除。
- 预览文本 Segmented 由 `vite.config.ts` 的 `SETTINGS_SURGERY` 从上游
  `VisPlaygroundSettingsPanel.tsx` 中剥离（import/props/解构/重置调用/Row 五处 marker），
  App 不再传 `previewPlaceholderId` 等三个 props。

## Bundle 组装 `packaging/tools/stage-web.mjs`

1. 复制 `poc/webview/host/PreviewShim.js` → `out/_host/preview-shim.js`。
2. 由 `out/index.html` 生成 `out/preview.html`：在 `<head>` 内**第一个 `<script`（或 `</head>`）之前**插入
   `<script src="/_host/preview-shim.js"></script>`；其余内容保持一致（`?obs=1` 会让内联脚本移除 splash）。
3. 把 dist 里的占位封面复制到稳定路径：`assets/placeholder_cover-CufMMif3.jpg` → `out/preview/placeholder_cover.jpg`，
   `assets/placeholder_cover-2-BuqqkGqf.jpg` → `out/preview/placeholder_cover-2.jpg`
   （v0.4.1 起预览不再使用这两张图；保留为宿主/插件未来的示例曲资源，不影响预览）。
4. 报告里加 `previewHtml: true/false`、`previewShimCopied: true/false`。
5. **本地安装也必须走这个脚本**：`spw-folia/build.gradle.kts` 的 `stageDevWeb`（Gradle 调
   `node packaging/tools/stage-web.mjs --dist poc/webview/dist/dist --out build/web-stage/web --report build/web-stage/report.json`）
   生成与发布包一致的 `web/` 布局，再由 `syncDevAssets` 拷进 `build/plugin-root/web`。
   **不要**再直接拷贝 `poc/webview/dist/dist`：裸 dist 会带上 PWA 的 `sw.js`，它的 `NavigationRoute`
   会把 `/preview.html` 这次导航重新导回 `index.html`（OBS 页没有子帧垫片、没有 token），
   预览就永远停在「正在连接 Folia」；同时裸 dist 里也没有生成的 `preview.html` / `_host/preview-shim.js`。

## 顶层 `Shim.js` 改动（v0.4.1）

- 子帧守卫：`if (window.top !== window) return;`（避免宿主把顶层垫片注入 iframe 后与子帧垫片互相干扰）。
- `deliver(name, data)`：`name === 'config'` 时更新 `lastConfig` 并 `emitLocal('config', data)`。

## 验收

`poc/settings-ui/scripts/diag-real-preview.mjs`（真机、真实宿主、模拟插件 track/lyrics）：

```bash
cd poc/settings-ui && npx --no-install vite build
cd ../.. && node packaging/tools/stage-web.mjs --out .tmp-verify/web --report .tmp-verify/report.json
cd poc/settings-ui && node scripts/diag-real-preview.mjs
```

17 项断言（全 PASS 才算通过）：overlay open、iframe mounted、ready、config delivered、shim live、
real song、real lyrics、iframe config === player config、真实 clock 跟随 host posMs、frames 渲染、
透明标记到父级、透明标记到 iframe config、棋盘格 chip、暂停冻结子帧时钟、恢复后时钟前进、
字体 tab 已无「预览文本」、切 tab 后预览继续渲染。截图输出在
`poc/webview/host/out/real-preview/shots/`（`preview-live.png` / `preview-transparent.png` / `preview-fonts.png`）。
