# spw-folia v0.4.7 — 设置页两处「看起来坏了」的修复：预览框空白、样式缩略图破图

> **未发布**：本版本仅本地构建与测试，从未上传 GitHub Releases；其改动随后续版本一并交付。最后发布的版本是 v0.4.6。

v0.4.7 只修设置界面（歌词样式窗口）的两个可见故障，播放功能、协议、设置格式、宿主参数都没有
行为变化。两个故障都**不是渲染 bug**：一个是上一版安装残留的 Service Worker 在劫持预览 iframe 的
导航，一个是样式缩略图根本没进发布包。

## 问题

用户截图里同时出现两件事：

1. **预览框不显示 / 显示不全** —— 左侧大预览是整片黑色空框，只剩左上角一个样式名和暂停钮；
2. **样式图片显示错误、乱码** —— 下方「样式 15」货架的 15 个 tile 全是浏览器的破图图标
   （一个彩色小方块 + 文件名）。

宿主日志里只有一行 `console.warn: [spw-live-preview] preview iframe did not report ready in time`，
页面本身没有任何报错。

## 根因（两条独立链路，同时命中就得到截图里的样子）

### A. 旧版安装遗留的 Service Worker 劫持了 `/preview.html`

- v0.1–v0.3 的本地安装直接把 Folia **原始 dist** 拷进 `web/`，那份 bundle 注册了 PWA service
  worker（`sw.js`，带 `NavigationRoute`，覆盖该 origin 的所有导航）。
- 宿主的 WebView2 profile 是**固定目录**（`%LOCALAPPDATA%\spw-folia\webview`），与插件版本无关。
  v0.4+ 的 `web/` 已经不再分发 `sw.js`，但**旧注册仍留在 profile 里**并继续控制
  `https://spw-folia.local/`。
- 于是预览 iframe 请求的 `/preview.html` 被旧 SW 重新导回 `index.html`：子帧里没有
  `PreviewShim`，永远不会 `ready`；4 s 后 `Stage` 回退到静态图 `StylePreview`。

复现证据（`scripts/repro-stale-sw.mjs`，先用原始 dist 把 `sw.js` 注册进 profile，再跑打包 bundle）：

```
controller: "https://spw-folia.local/sw.js"      # 旧注册还在
childHref: null, childHasShim: false, ready: null, staticFallback: true
warn: [spw-live-preview] preview iframe did not report ready in time
```

### B. 15 张样式缩略图从来没有进过发布包

- 货架每个 tile 渲染 `thumbs/` 下对应样式的 jpg；这 15 张帧是**构建输入**
  （`poc/settings-ui/public/thumbs/`），被 `.gitignore` 掉，干净检出时连 `public/` 目录都没有。
- `vite build` 在缺 `public/thumbs` 时**照样成功**，只是产物里一张 thumbs 都没有；`stage-web.mjs`
  也没有校验，于是 `.spmod` 里 `web/settings/thumbs/` 整个目录不存在。
- 实测本地包 `spw-folia-0.4.6.1.spmod`（未发布）：`web/settings/` 下 1916 个文件，**jpg 数量为 0**。

复现证据（`scripts/probe-thumbs.mjs`，真实宿主 + 打包产物）：

```
"thumbImages": 15, "loaded": 0,
"broken": ["…/settings/thumbs/sonnet.jpg", … 15 条]
```

### A + B 的组合效应

A 让预览框回退到静态图，B 让静态图的 `<img>` 也 404 —— 静态图渲染出来就是**一个空框**，
两个症状于是看起来像同一个“渲染坏了”。（`Stage` 的静态图回退本身是 v0.4.1 起的既有设计，
这里没有改动它。）

## 方案

### 1. 宿主启动时清掉旧 SW（`HostForm.PurgeStaleServiceWorkersAsync`）

在**第一次 `Navigate` 之前**调
`CoreWebView2Profile.ClearBrowsingDataAsync(ServiceWorkers | CacheStorage | DiskCache)`。

- 必须早于导航：页面一旦加载，那次导航就已经被旧 SW 接管，页面里的清理只对之后的加载有效。
- 只清这三类，**不用 `AllProfile`**：设置快照存在 localStorage 里，不能被顺手清掉。
- 3 s 上限；失败只记一条 `warn` 继续导航，绝不阻塞启动（冷 profile 实测 < 200 ms）。
- `--no-sw-purge` 可关闭，仅供诊断。

### 2. 页面内第二道自愈（`LivePreview.tsx`）

第一次 4 s 超时后：注销本 origin 的 Service Worker、清空 Cache Storage，然后用
`/preview.html?…&r=1` 重建 iframe（`key={attempt}` 强制换新文档，避免旧文档的 shim 状态带过来），
再给一次 4 s。两级都失败才回退静态图。

实测（`scripts/probe-heal.mjs`，**禁用**宿主清理、只留页面自愈）：

```
controller at start: "https://spw-folia.local/sw.js"
warn: preview iframe did not report ready; purging stale service worker and retrying
warn: retrying preview iframe (purged=true)
→ childHref: /preview.html?obs=1&preview=1&r=1, childHasShim: true, ready: "true", staticFallback: false
```

### 3. 缩略图重新采集并接入构建

- 新增 `poc/settings-ui/scripts/make-thumbs.mjs`（`npm run thumbs`）：真实宿主 + 真实 Folia
  渲染器，每种样式截一张 3200×2000 帧，中心裁 16:10，存 1440×900 JPEG q82 到
  `public/thumbs/<mode>.jpg`。15 个样式全采（含此前缺失的 **hanabi/花火**）。
- **两道硬闸**，缺一张就构建失败，而不是发布后才发现：
  - `vite.config.ts` 的 `requireStyleThumbs()`（`writeBundle` 阶段核对 `dist/thumbs/`）；
  - `packaging/tools/stage-web.mjs`（暂存阶段核对 `web/settings/thumbs/`，在 dedupe 之后）。
- `packaging/tools/verify-layout.mjs` 新增两项发布前检查：
  `styleThumbsLoaded`（15/15 tile 真的加载）与 `livePreviewReady`（预览不是静态图回退）。

## 验证

### 复现 → 修复（同一场景，同一 profile 构造方式）

`scripts/repro-reported.mjs`：先用原始 dist 把 `sw.js` 注册进 profile，再跑 web 树。

| | 旧的本地包 0.4.6.1（未发布） | 本版打包树（未发布） |
| --- | --- | --- |
| 预览子帧 | 无 shim、`ready=null`、回退静态图 | `childHasShim: true`、`ready: "true"` |
| 静态图回退 | `true` | `false` |
| 缩略图 | `15` 张、`0` 张加载成功 | `15` 张、`15` 张加载成功 |
| 截图 | 空黑预览框 + 15 个破图 | 真实歌词渲染 + 15 张真实帧 |

### 发布前端到端验收

`node packaging/tools/verify-layout.mjs`（真实宿主 + 真实 WebView2 加载打包产物）**12 项全 true**：

```
exitedZero, closedUser, bridgePresent, settingsInjected, settingsAutoOpened,
closeSettingsCommand, openSettingsCommand, escClosedSettingsOnly,
visualizerCanvases, styleThumbsLoaded, livePreviewReady, noConsoleErrors
```

其中新增的两项：

```
"styleThumbs": { "total": 15, "loaded": 15 }
"preview": { "ready": "true", "staticFallback": false, "childShim": true }
```

### 真实预览契约回归

`cd poc/settings-ui && node scripts/diag-real-preview.mjs <stagedWeb>` —— **17/17 PASS**
（overlay、iframe 挂载、ready、config 逐字节一致、真实曲目/歌词、真实时钟跟随、透明标记、
暂停冻结、恢复、字体 tab、切 tab 后继续渲染）。

预览就绪延迟实测（生产形态 3200×2000 @ DSF1.8，CSS 视口 1776×1110）：**161–211 ms** 到
`data-live-preview-ready=true`，远低于 4 s 超时；没有静态图回退。

### 前端类型检查

`npx tsc --noEmit` 改动前后同为 62 个错误（全部来自 gitignore 掉的 `work/` 上游源码与 `@/`
别名解析），**本次改动引入 0 个新错误**。

## 产物

> **本地产物，未发布。** 下面这个 `.spmod` 只在本机 `dist/release/` 里，**从未上传 GitHub Releases**。
> 最后发布的版本是 v0.4.6。

```
dist/release/spw-folia-0.4.7.spmod
  Plugin-Version: 0.4.7 · Plugin-Id: dev.spw.folia
  web/settings/thumbs/  15×jpg（新增）
```

`packaging/size-report.json` 里 `withinBudget` 仍是 false（26 MB vs 25 MB 预算）—— 这是**既有
超支**：基线 v0.4.6.1 的 web 暂存总量是 28.9 MB，本版是 28.9 MB + 1.6 MB 缩略图 ≈ 与预算的差距
和改动前同一量级，缩略图本身占了新增部分。体积预算调整不在本次范围内。

## 已知限制

- 自愈是**一次**重试：若旧 SW 之外还有别的原因让子帧起不来（缺 `preview.html`、缺
  `_host/preview-shim.js`），预览仍会回退到静态图，且此时静态图依赖 thumbs —— 所以两道构建闸
  必须同时保住。
- 缩略图是**采集帧**，不是实时渲染：换上游 Folia 版本、改默认主题或改字体栈之后需要重跑
  `npm run thumbs`，否则帧会与当前渲染风格不一致（视觉仍可用，只是不再“逐字节同源”）。
- `sw.js` 的注册是**按 origin** 的：清理只影响 `spw-folia.local` 这个虚拟主机，不碰用户其他站点。
