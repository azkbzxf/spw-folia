# 左侧大预览：同源 iframe 机制

设置页左侧大预览必须是 **Folia 真实动画渲染器**（真视觉、真动效、可暂停/播放），不是静态帧。

它是**播放页的逐帧镜像**：没有占位歌、示例歌词或预设背景 —— 预览框渲染的就是播放页此刻收到的
配置（真实曲目/歌词/主题/背景与透明开关）与真实时钟/音频，设置页不再「猜」任何东西。

设置岛本身（构建、设置树、chrome 契约）见 [`docs/settings-ui-impl.md`](settings-ui-impl.md)。
播放控制通道与协议字段见 [`docs/protocol.md`](protocol.md)。

## 1. 架构

设置岛由宿主注入到**顶层文档**，该顶层文档就是 Folia 的 OBS surface
（`https://spw-folia.local/index.html?obs=1&token=…`，已挂载真实 `VisualizerRenderer`）。

预览 = 在同一顶层文档里放一个**同源 iframe**，加载 bundle 里的 `preview.html`（= dist index.html
的副本 + 子帧垫片），URL `https://spw-folia.local/preview.html?obs=1&preview=1`。
iframe 内跑 Folia 自己的 `ObsBrowserSourceApp`（真实渲染器），不需要任何桩、不需要重建渲染器图。

```
宿主/插件 ── stdin/stdout ──▶ 顶层 Shim.js
   │  state/audio → SSE clock/audio + emitLocal('state'/'audio')
   │  config 消息 / 设置岛的 pushConfig → deliver('config')
   ▼
设置岛 (top doc)
   │  usePlayerConfig(): 读 bridge.lastConfig() + bridgeOn('config')，镜像播放页实际收到的 config
   │  postMessage({__spwFoliaPreview:1, kind:'config'|'live'|'paused'|'state'|'audio'})
   ▼
iframe (preview.html)  PreviewShim.js（子帧垫片，classic script，在 module 入口前执行）
   │  覆盖 window.EventSource = FakeEventSource；把父页消息转成 SSE 事件
   │  live 模式：转发真实 clock/audio；无父页桥时保留合成回退
   ▼
ObsBrowserSourceApp → VisualizerRenderer（17 样式全部可用，含 three/pixi 懒加载块）
```

**为什么必须 iframe**：iframe 内拿不到 WebView2 桥（`chrome.webview` 只在顶层），所以真实
clock/audio 由顶层订阅桥事件后转发；config 由父页直传（同源 + `contentWindow.postMessage`），
从而自动镜像播放页正在渲染的状态（样式/调参/背景/字体/字幕/透明）。

## 2. config 的唯一来源

`Shim.js` 的 `deliver('config', data)` 是播放页收到 config 的**唯一入口**（宿主下发的 config 与
设置岛的 `pushConfig` 都走这里）。它投递的同时：

- 记住 `lastConfig = data`，并通过 `bridge.lastConfig()` 暴露；
- `emitLocal('config', data)`，让设置岛能订阅。

设置岛的 `useConfigPublisher.ts` 因此有：

- `ensurePlayerConfigSource()`：首次读 `bridge.lastConfig()`，随后 `bridgeOn('config')` 持续跟随；
- `usePlayerConfig()`：返回播放页最后一版 config（null = 播放页还没有 config，预览框保持空）；
- 诊断环 `window.__spwFoliaPublishHistory`（最近 8 次 config 的 song/lyric 行数/透明位）。

**不要**在设置页用 `buildConfig()` 重新构造预览 config：那会得到一份「设置页以为的」配置，与播放页
实际渲染的配置可能不同（例如宿主/插件直接下发的 config）。

## 3. 尺寸与缩放

Folia 自己的 playground 是「按窗口大小排布，再整体缩放塞进预览框 + 1.15 倍放大裁切」。
OBS surface 只在 >1920 时放大；小 iframe 会排成「小窗口布局」（相对字号不对）。

因此：**iframe 元素固定 1920×1080 CSS px**，再用 CSS transform 缩放并居中裁切：

```
k = max(boxW / 1920, boxH / 1080) * 1.15          // 1.15 = Folia DEFAULT_SAMPLE_ZOOM
iframe { position:absolute; width:1920px; height:1080px; left:50%; top:50%;
         transform: translate(-50%,-50%) scale(k); transform-origin:center;
         pointer-events:none; border:0; }
wrapper { position:absolute; inset:0; overflow:hidden; }
```

这样 iframe 内 `documentElement.clientWidth = 1920` → OBS surface 的 resize 逻辑
`scale = max(1, 1920/1920) = 1`，排布等同 1080p 全屏播放，视觉与全屏模式一致。

## 4. 消息契约（父 ⇄ 子，同源 postMessage）

所有消息带 `__spwFoliaPreview: 1`。

父 → 子：

| kind | payload | 说明 |
|---|---|---|
| `live` | `true` | 进入 live 模式：停用子帧合成时间线，改用父页转发的真实 clock/audio |
| `config` | `ObsBrowserSourceConfig` | 播放页实际收到的完整配置（逐字节镜像，不由设置页构造） |
| `paused` | `boolean` | 暂停时冻结时间轴（子帧发 `playerState:'PAUSED'` 钉住时钟；停 rAF） |
| `state` | 宿主原始 state 消息（`posMs/durationMs/playing/rate/tsMs`） | 仅 live 模式；子帧按 Shim.js 同款映射转成 SSE `clock` |
| `audio` | 插件原始 audio 消息 | 仅 live 模式；子帧按 Shim.js 同款映射转成 SSE `audio` |

子 → 父：

| kind | payload | 说明 |
|---|---|---|
| `ready` | `{}` | 子帧就绪；子帧在 0/100/300/1000/2000 ms 重试直到收到第一条 `config` |
| `error` | `{ message }` | 子帧初始化失败（父页据此回退静态图） |
| `stats` | `{ canvases, frames }` | 每秒一次，调试/验收用 |

父页在收到 `ready` 后发送 `live` + `paused` + 当前 `config`，之后转发每条 `state`/`audio`
（暂停或页面隐藏时暂停转发；`paused` 变化时重发）。4 s 内未收到 `ready` 或收到 `error` →
预览回退为 `StylePreview`（静态帧）。

## 5. 子帧垫片 `poc/webview/host/PreviewShim.js`

classic script，由 `preview.html` 在 `<head>` 里以 `<script src="/_host/preview-shim.js"></script>`
引入（**必须早于** module 入口；module 是 deferred，classic 先执行）。要求：

1. 幂等：`if (window.__SPW_FOLIA_PREVIEW_SHIM__) return;` 后置位。
2. `window.top === window` 时直接 `return;`（只在子帧生效）。
3. 实现 `FakeEventSource(url)`：`addEventListener(name, fn)` 按事件名记监听；`onopen` 立即
   （setTimeout 0）；`close()`；`readyState` 兼容。**事件对象 `data` 必须是 JSON 字符串**
   （`ObsBrowserSourceApp` 用 `JSON.parse(event.data)`）。
4. `window.EventSource = FakeEventSource`（覆盖宿主 Shim 可能已设的值）。
5. 监听 `window.addEventListener('message')`：`event.data.__spwFoliaPreview === 1` 时按 kind 处理。
6. **live 模式**：`state` → `clock`（`currentTime = posMs/1000`、`duration = durationMs/1000`、
   `playerState = playing === false ? 'PAUSED' : 'PLAYING'`、`playbackRate = rate`、
   `lyricOffsetMs/1000`）；`audio` → 归一成 `{audioPower, bands, spectrum: Uint8Array, sentAtMs}`；
   `paused` 时用最后一帧 state 发 PAUSED 钉住时钟，恢复时重发最后一帧 state（下一帧真实 state
   到来即接上）。
7. **合成回退模式**（父页没有发 `live`，例如浏览器里直接打开 preview.html）：保留本地 rAF 合成
   clock/audio（`DEFAULT_LOOP_SECONDS = 14.4`，正弦 wave/spectrum），保证垫片可独立调试。
8. 透传诊断：`window.onerror` / `unhandledrejection` → 父页 `{kind:'error'}`（父页转发到宿主 log）。
9. 暴露 `window.__SPW_FOLIA_PREVIEW__ = { receivedConfig, live, frames, canvases, clockMs, paused,
   configTransparent, configUpdatedAt, songTitle, configLyricCount }` 供验收 eval。

顶层 `Shim.js` 的两个配套约定：

- 子帧守卫：`if (window.top !== window) return;`（避免宿主把顶层垫片注入 iframe 后与子帧垫片互相干扰）。
- `deliver(name, data)`：`name === 'config'` 时更新 `lastConfig` 并 `emitLocal('config', data)`。

## 6. 透明背景的呈现

- 播放页透明 = `config.background.transparent === true`：OBS 根节点不画背景，且
  `ObsBrowserSourceApp` 启动时已把 `document.documentElement/body` 背景设为 `transparent`
  （宿主再用色键让桌面透出）。
- 预览框因此能**真实呈现透明**：`Stage` 外层不在 iframe 下铺任何预设色，只在透明时给 wrapper
  加 `.st-stage-transparent`（棋盘格）并显示左下角「播放页透明背景」chip；iframe 自身
  `background:transparent`，棋盘格即表示「这里会透出桌面」。
- 不支持透明的样式（monet、浅色 lumiere）仍由 `setTransparentPlayerBackground` 的守卫与
  `transparencyCompat.ts` 的渲染期 tuning 处理，预览与播放页保持一致。

## 7. 旧版 Service Worker 残留（**排障先看这里**）

症状：预览框整片空白/显示不全，宿主日志里是
`[spw-live-preview] preview iframe did not report ready in time`，页面本身没有任何报错。

根因：早期本地安装把 Folia **原始 dist** 拷进 `web/`，那份 bundle 注册了 PWA service worker
（`sw.js`，`NavigationRoute` 覆盖所有导航）。宿主的 WebView2 profile 是固定目录
（`%LOCALAPPDATA%\spw-folia\webview`，与插件版本无关），升级到不再分发 `sw.js` 的版本后旧注册仍在
profile 里、继续控制 `https://spw-folia.local/`：预览 iframe 请求的 `/preview.html` 被重新导回
`index.html`，子帧里因此没有 `PreviewShim`，永远不 `ready` → 4 s 后回退静态图。

两级修复，缺一不可：

1. **宿主启动清理**（`HostForm.PurgeStaleServiceWorkersAsync`，`--no-sw-purge` 可关）：
   在**第一次 `Navigate` 之前**调
   `CoreWebView2Profile.ClearBrowsingDataAsync(ServiceWorkers | CacheStorage | DiskCache)`，
   3 s 上限，失败只记 warn 不阻塞启动。必须早于导航：页面一旦加载，那次导航就已经被旧 SW 接管，
   页面里的清理只对之后的加载有效。
2. **页面内自愈**（`LivePreview.tsx` 的 `purgeStaleServiceWorker()` + `attempt` 重试）：
   第一次 4 s 超时后，在当前页注销本 origin 的 SW、清空 Cache Storage，然后用带 `&r=1` 的新 URL
   重建 iframe（`key={attempt}` 强制换新文档，避免旧文档状态带过来），再给一次 4 s。
   两级都失败才回退静态图。

验收脚本：`node scripts/repro-stale-sw.mjs <stagedWeb> <profile>`（先用原始 dist 把 sw.js 注册进
profile，再用打包 bundle 验证预览可用）；`node scripts/probe-heal.mjs <stagedWeb> <profile>`
（同上但加 `--no-sw-purge`，只验证页面内自愈）。

## 8. 开屏遮罩 `#app-splash`

上游 Folia 的 `index.html` 自带首帧开屏（`#app-splash`：深色底 + "Folia" 白色辉光词标 + 13 根波形
竖条，内联 `<style>` + 内联 `<script>`，不等 CSS/JS bundle 就画）。
`src/utils/appSplash.ts#hideAppSplash()` 在 React 挂载后 320 ms 淡出移除。

spw-folia 的两条约束**必须由 `stage-web.mjs` 的硬闸守住**（grep 看不出来）：

| 文件 | 要求 | 闸门 |
|---|---|---|
| `web/index.html`（播放页） | **保留**完整开屏 | `assertIndexHtmlKeepsSplash()`：缺 `id="app-splash"` 或 `app-splash-wave` 就 throw |
| `web/preview.html`（预览子帧） | **不含**任何 `app-splash` | `assertPreviewHtmlHasNoSplash()`：命中数 ≠ 0 就 throw |
| `web/assets/*.js` | 仍有 `hideAppSplash()` | `assertSplashTeardownInBundle()`：同一 chunk 必须同时含 `app-splash` + `is-hiding` |

**为什么预览是「剥标记」而不是靠 URL 参数**：上游那套 `obs=1` / `splash=0` / `/obs` 的移除判断写在
`<body>` 末尾的内联脚本里，而遮罩是内联 CSS —— 首帧就已经画上去了。iframe 的 query 不可靠，而且设置页
会在 resize 与「旧 SW 自愈重试」时重建这个子帧（`LivePreview.tsx` 的 `key={attempt}`），一次闪烁会被
反复放大。所以 `stripSplashFromHtml()` 直接删掉 DOM + `<style>` + 内联 `<script>`，让子帧**没有能力**
画出开屏，与 `LivePreview.tsx` 拼什么 URL 无关。剥样式时保留同一条 `<style>` 里的
`html,body{background-color:#09090b}` 基础规则，否则子帧在 React 设置页面背景之前会闪白。

`preview.html` 会在 `<head>` 留下
`<!-- spw-folia: first-paint splash removed for the settings live preview ... -->` 标记，
闸门同时校验它。

## 9. Bundle 组装 `packaging/tools/stage-web.mjs`

1. 复制 `poc/webview/host/PreviewShim.js` → `out/_host/preview-shim.js`。
2. 由 `out/index.html` 生成 `out/preview.html`：**先剥掉开屏遮罩**，再在 `<head>` 内
   **第一个 `<script`（或 `</head>`）之前**插入 `<script src="/_host/preview-shim.js"></script>`。
3. 把 dist 里的占位封面复制到稳定路径（`out/preview/placeholder_cover.jpg` 等；预览已不使用，
   保留作未来示例曲资源）。
4. 报告里加 `previewHtml`、`previewShimCopied`、`splash`、`styleShelf`。
5. **本地安装也必须走这个脚本**：`spw-folia/build.gradle.kts` 的 `stageDevWeb` 生成与发布包一致的
   `web/` 布局，再由 `syncDevAssets` 拷进 `build/plugin-root/web`。
   **不要**直接拷贝 `poc/webview/dist/dist`：裸 dist 会带上 PWA 的 `sw.js`（`NavigationRoute` 会把
   `/preview.html` 这次导航重新导回 `index.html`），预览就永远停在「正在连接 Folia」；同时裸 dist
   里也没有生成的 `preview.html` / `_host/preview-shim.js`。

另一条同样的坑：上游 Folia 源码树必须有 `postcss.config.js` + `tailwind.config.js`。缺了它们
`vite build` 仍然 exit 0，但产物 CSS 只剩 ~29.6 KB、所有 Tailwind 工具类消失，`.h-full` 缺失让
预览 iframe 的 100% 高度链断掉 → 子帧塌成 270 px（用户描述为「预览框显示不全」）。
`stage-web.mjs` 已有硬闸（`web/assets/*.css` 仍含字面量 `@tailwind` 或找不到
`.h-full{height:100%}` 就 throw）。判断「预览框尺寸/布局不对」**先量产物 CSS**，不要先怀疑 iframe
的 `height` 或 WebView2 缩放。

## 10. 验收

- `packaging/tools/verify-splash-gates.mjs` —— 三向：正常通过 / 删 splash 抛错 / preview 带 splash 抛错。
- `packaging/tools/verify-splash-browser.mjs` —— 真 Chromium 加载两页，断言盒子、条数、底色。
- `packaging/tools/verify-layout.mjs` —— 打包件真机：`previewHasNoSplash` + 样式缩略图。
- `poc/settings-ui/scripts/diag-real-preview.mjs` —— 真机、真实宿主、模拟插件 track/lyrics，
  17 项断言：overlay open、iframe mounted、ready、config delivered、shim live、真实 song/lyrics、
  `iframe config === player config`、真实 clock 跟随 host posMs、frames 渲染、透明标记到父级与
  iframe config、棋盘格 chip、暂停冻结子帧时钟、恢复后时钟前进、字体 tab 已无「预览文本」、
  切 tab 后预览继续渲染。

  ```bash
  cd poc/settings-ui && npx --no-install vite build
  cd ../.. && node packaging/tools/stage-web.mjs --out .tmp-verify/web --report .tmp-verify/report.json
  cd poc/settings-ui && node scripts/diag-real-preview.mjs
  ```
