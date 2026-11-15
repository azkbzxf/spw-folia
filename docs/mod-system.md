# 模组系统实现（Beta）—— 面向维护者

面向使用者的一面见 [`docs/mods.md`](mods.md)。本文讲**这层是怎么接进来的**、哪些地方不能碰、
以及为什么这里的形状与上游 Folia 的模组系统不一样。

当前目标适配范围：**歌词动画（`visualizers`）+ 播放条按钮（`progressButtons`）**。

---

## 1. 为什么能直接复用上游的模组契约

Folia 的模组不是插件，是**一段 ESM 文件**（`client.mjs`），导出一个 `activate(folium)`，
用 `folium.registries.*` 往宿主注册东西。本插件内嵌的是 Folia 的**生产 OBS 产物**，
其中模组运行时（`src/mods/**` 编译后的 chunk）完整存在 —— 它只是**从来没有被启动过**：
上游只在主窗口 `bootstrap.tsx` 里调 `startFoliumForMainWindow()`，而我们这个页面是
`?obs=1` 的 OBS surface，走不到那条路。

所以这一层的本质是：**给已经编进产物的模组运行时补一条启动路径 + 一个桥门面 + 一份磁盘目录**，
而不是重新实现一套模组协议。代价是三个必须由我们自己维护的契约点（见 §3）。

已实测的事实（`.scratch/issue23/` 有真机证据，勿凭印象推翻）：

| 事实 | 后果 |
|---|---|
| 注册路径**零桥调用** | `window.electron.mods` 门面是「健壮性」，不是「必需」 |
| 激活 + `pushConfig({visualizerMode:'mod:<id>:<viz>'})` 能渲染 | 注册即生效，不需要往 registry 里塞东西 |
| **跨源** `import()` / `fetch()` 全部失败 | 模组文件必须与页面**同源** |
| 不 wrap `addOldClientNames` 时 `shells:1, spans:0` | 旧名兼容是必需的（见 §3.1） |

## 2. 数据流与单写者

```
市场 catalog.json ──页面直接 fetch（有 CORS）──▶ 设置岛货架化列表
                                                        │ 用户点「安装」
                                          postMessage {type:'modAction', action:'install', download:{…}}
                                                        ▼
                                                     宿主 exe（只搬运 + 校验字段白名单）
                                                        │  stdout {"t":"modAction",…}
                                                        ▼
                                              插件 FoliaModStore（唯一碰磁盘的人）
                                        下载 zip → 核 SHA-256 → 解包 → mods/<id>/
                                                        │  stdin {"t":"mods","mods":[…]}
                                                        ▼
                                                     宿主 exe → PostToPage
                                                        ▼
                         Shim.js：window.electron.mods 门面 + 逐模组激活 client.mjs
                                                        ▼
                                  上游 appendVisualizerEntry → 货架可选 'mod:<id>:<viz>'
```

**单写者铁律**：

- 模组目录、清单、启用开关 —— **只有插件**（JVM 才有文件系统；WebView2 里只有虚拟主机）。
  清单以「注入成员」的形式随 `settings` 下发，页面**只读**。页面把清单写回设置树就是引入了
  第二个真相（`docs/lessons.md` §3.1 的反例）。
- 模组 client 的注册 —— **只有页面**。插件不碰任何 UI 注册表。
- 市场清单的展示态（滚动位置、正在下载哪一项）—— **只有页面**，不落盘。

## 3. 页面侧激活器（`poc/webview/host/Shim.js` 的 `modHost` 段）

上游的 `clientLoader.ts` 我们不能直接用：它开头就 `isModsBridgeAvailable()`，随后经
`ipc.ts` 向 Electron 主进程要模组列表。我们自己在注入脚本里维护等价的激活器。

### 3.1 激活顺序（固定，不要换）

```js
const runtime = await import('/' + host.api);                    // createFoliumClientApi 等
let api = runtime.createFoliumClientApi(mod, {
    context: 'main',                                             // 不是 'export'/'obs'
    experimental: {},
    onRelease: (release) => record.releases.push(release),        // ← 必须收集
    stopped: () => record.stopped,                                // ← 停用后返回 true
});
api = await (await import('/' + host.deprecated)).addOldClientNames(api, mod, 'main');
```

**`addOldClientNames` 不能省。** Folium 2 的 mount ctx 里**没有** `currentTime`、没有 `subscribe`
（实测 `typeof ctx.currentTime === 'undefined'`），而市场上绝大多数模组（含官方样例）写的正是
`ctx.currentTime.on('change', …)` 与 `ctx.subscribe(…)`。不 wrap 的表现是**模组注册成功、
mount 挂上外壳、一个字都画不出来**（实测 `shells:1, spans:0`）—— 这是最容易被当成「模组本身坏了」
的静默失败。`addOldClientNames` 的导出名在产物里保留原名（上游运行时按名解构），可以放心用。

`context` 必须是 `'main'`：`progressButtons` / `stageLayers` 这些 `uiOnly` 注册表在非 main 上下文
只拿到 inert handle（注册了但什么都不做）。

### 3.2 停用的五步（顺序有语义）

```js
record.stopped = true;                    // 之后所有 register / events.on 被拒绝
record.dispose?.();                       // activate 返回的 disposer
record.releases.forEach(release => release());   // ← 漏了它，模组的定时器会继续跑
record.eventDisposers.forEach(off => off());
listFoliumHostRegistries().forEach(r => r.unregisterAll(modId));
```

**`onRelease` 必须收集并执行。** 上游靠同一个机制：一次普通激活会推 4 个 release
（scope.end / rpc 通道 / secrets 通道 / omni 在途请求）。漏跑的实测后果是
`api.every()` 起的定时器**继续跑**、`api.onDispose()` 的清理**一次都不执行**。

`api.events.on` 注册的 handler **不在** `onRelease` 里，而清理它的 `removeFoliumEventHandlers`
在产物里被压成单字母（名字随构建变）。所以**包一层 `api.events.on`** 自己收集 disposer，
不要依赖那个内部函数。

`unregisterAll` 只动注册表，**不改 `config.visualizerMode`**。渲染时
`getVisualizerRegistryEntry` 对未知 mode 回落内置默认模式 —— 所以「停用后画面回到 classic 而不是白屏」，
但设置岛必须**明确提示**这次回落，不能让用户以为选择还在（见 §5.2）。

### 3.3 桥门面（`window.electron.mods`）

只为了让两件事成立：

1. `isModsBridgeAvailable()` 为真（万一将来复用上游 loader）；
2. 模组摸 `folium.storage` / `secrets` / `rpc` / `net` 时**拿到空值而不是抛异常**。

`folium.playback` / `ui` / `lyrics` / `account` / `omni` / `equalizer` / `visualizer` 这一批
**门面救不了**：它们要的是 `registerFoliumHostActions` 之类的宿主安装点，OBS 页没有。
**让它们抛就好** —— 错误串清晰（`playback-unavailable-in-main-context`），上游的守卫会记到模组行上，
不会炸页面。

## 4. 同源服务（`/__mods/*`）

模组文件在插件数据目录里，而 `SetVirtualHostNameToFolderMapping` 只能映射一个固定目录。
所以宿主用 `WebResourceRequested` 把 `https://spw-folia.local/__mods/<id>/<file>` 映射到磁盘：

- 路径 **URL decode → 规范化 → 必须仍落在 mods 根内**；`..` 一律 404（有门禁断言三条穿越路径）。
- 只允许 `GET`。
- **Content-Type 必须对**（`.mjs`/`.js` → `text/javascript`）：`import()` 会拒绝非 JS MIME，
  而失败形态同样是「模组装好了但不生效」。

模组 URL 带 `?v=<version>`：改内容 = 改 URL = 新 module record。这是上游
`folia-mod://…?v=<shortDigest>` 的等价物，我们用版本号而不是 digest（版本变了就必然要重新
激活，而模组的「改内容不换版本」是我们不支持的场景）。

## 5. 设置岛

### 5.1 市场页是并列模态，不是第 5 个 tab

`VisPlaygroundEditSection` 是上游**闭集**（`'visualizer' | 'background' | 'common' | 'subtitle' | 'global'`），
而且现有构建期 surgery 正在把 `global` 摘掉。往里加 tab 会同时踩上游与门禁。
所以市场页是 `App.tsx` 里的一个平级模态，层级用岛内部那套数（`MODAL_Z_INDEX = 2147483200`），
**不碰** `ISLAND_Z_INDEX`（必须 < 200，否则上游 body-portaled 的每个下拉都点不到，
`docs/lessons.md` §4.1）。

### 5.2 货架上的模组格走「第二套清单」

**一个字节都不许进** `STYLE_ENTRIES` / `STYLE_MODE_SHELF_ORDER` / `StyleMode` 联合 /
`vite.config.ts` 的 `STYLE_MODES`。四处断言会炸，其中两处是**静默**的：

| 断言 | 触发后果 |
|---|---|
| `styles.tsx` 模块加载期 throw（两份清单必须一一对应） | 整个设置岛**白屏**（岛没有 ErrorBoundary） |
| `check-style-sync.mjs` 双向判「本地多出样式」 | `vite build` 失败 |
| `requireStyleThumbs` 每个 `STYLE_MODES` 成员都要 `thumbs/<id>.jpg` | 构建失败 |

所以模组样式是 `model/modStyles.ts` 里的并行清单（`ModStyleMode = \`mod:${string}\``），
货架在 `Stage.tsx` 里拼第二组 options。

**模组格的图必须用模组的 `previewUrl`（`<img>`）**，不能走 `LyricStylePicture` / `getStyleEntry` ——
那两者对未知 mode 会**静默回落**成内置样式的图（`classic` / `sonnet`），货架上就会出现一张
「看起来是流光、点下去是模组」的格。

### 5.3 `foliumMissingEntries` 从桩换成真实实现

上游用它提示「存着的样式但模组没登记」。这是「选了模组样式 → 模组被卸/禁用 → 页面静默回落成
内置样式」这条路径的**唯一出口**。桩（恒空）会让这次回落完全无声。

## 6. 打包

`packaging/tools/stage-web.mjs` 在 staging 时生成 `mod-host.json`：

```json
{ "format": "spw-folia-mod-host", "version": 1, "folia": "0.7.26",
  "api": "assets/api-XXXXXXXX.js", "deprecated": "assets/deprecated-XXXXXXXX.js" }
```

产物 chunk 的文件名带内容哈希，升级上游就变，**不能写死**。stage 阶段对两个 chunk 各自
**唯一命中**做硬闸，不满足就 throw —— 否则升级上游后页面找不到模组运行时，表现是
「一条 console 警告 + 空的货架格」，没有任何门禁会发现。

模组本身**不随包分发**（不预置任何第三方代码），所以没有对应的 staging 输入。

## 7. 门禁

`packaging/tools/verify-mod-market.mjs`，已挂进 `verify-all.mjs` 的 `REMAINING_SUITES`：

- **A. 打包**：`mod-host.json` 存在、格式对、两个 chunk 真实存在且导出必需符号
  （`createFoliumClientApi` / `addOldClientNames`，后者还要求仍带 `currentTime`/`subscribe` 别名）。
- **B. 宿主**：真 exe + `--mods-dir`，断言 `/__mods/...` 以 JS 类型提供，且三条穿越路径 404。
- **C. 激活**：真机上推一条 `{"t":"mods"}`，选中模组样式后断言**画出了字**（`spans > 0`）——
  这一条就是 `addOldClientNames` 回归的捕手。
- **D. 静态**：`mod:` 前缀不许出现在那三份内置样式清单里；市场域名只许写一处。

## 8. 已知边界（v1）

| 能力 | 状态 | 原因 |
|---|---|---|
| `progressLayers` | 只注册不绘制 | 图层要叠在轨道上，v1 只做了按钮 slot |
| `settingsSections` | 不支持 | 设置窗里没有模组设置面板；`folium.storage` 也是空实现 |
| `backgrounds` / `stageLayers` / `homeTabs` / `playerPanelTabs` / `commands` / `styles` | 不支持 | 属于 Folia 桌面主窗口界面 |
| Node 入口（`main`） | 不支持 | 没有 Node 运行时 |
| `folium.sig.json` 校验 | 只展示不验证 | 需要上游的可信公钥与签名算法；UI 明确标「未验证」 |
| 模组进随机池 | 不支持 | 随机池只认 `STYLE_MODE_SHELF_ORDER` |
| 模组样式 + 透明窗口 | 不支持 | 按内置样式的保守策略当作不可适配，不靠 `??` 默认值假装 native |

这些边界都写进了面向使用者的 [`docs/mods.md`](mods.md)，改动能力时要两份一起改。

## 9. 协议增量

字段级契约见 [`docs/protocol.md`](protocol.md) 的 `mods` 与 `modAction` 两行，这里只记纪律：

- `mods` 是**全量**推送（变更即全量），单行 JSON。
- `modAction` 是**平铺信封**（与 `control` 一致），白名单外丢弃 + warn。
- 页面 → 宿主那一段，宿主**逐个字段读出来再拼**，绝不内嵌未消毒的子 JSON。
