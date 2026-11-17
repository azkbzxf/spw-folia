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

### 5.1.1 入口在 SPW 的配置页（`preference_config.json`）+ 播放页右下角胶囊

`spw-folia/src/main/resources/preference_config.json` 有一个 `configs[]` 分区
**「模组」/ `mods.json`**（紧跟「播放页」，在「诊断与日志」之前），里面**三个** `type:"button"`：

| 顺序 | 按钮 | `on_click` | 做什么 |
|---|---|---|---|
| 1 | **导入模组…** | `dev.spw.folia.FoliaPlugin.onImportModZip` | `SwingUtilities.invokeLater` → `JFileChooser`（只筛 `.zip`）→ `FoliaModStore.install(zip, expectedSha256 = null)` 在 `modActions` 线程 |
| 2 | 打开模组文件夹 | `dev.spw.folia.FoliaPlugin.onOpenModsFolder` | `ProcessBuilder(listOf("explorer.exe", modsRoot))` |
| 3 | 模组市场 | `dev.spw.folia.FoliaPlugin.onOpenModMarket` | `openMarketWindow()` → 第二个宿主进程，`--url` 指向 `mod-market.html?market=1`（**不再需要播放页**） |

**顺序是用户定的**（原话：「模组市场在配置中的主要功能是能手动导入模组」）：手动导入是**第一项**，
市场降到第三项。JVM 测试钉住了顺序（按 json 文本里的偏移量比较），所以有人调换会被测出来。

**为什么是 `button` 而不是 `switch`**：`verify-all.mjs` 的双向契约检查只认 `type:"switch"`
（`verify-all.mjs:115` + `FoliaDiagnostics.KNOWN_CONFIG_SWITCHES`），加一个 switch 就会要求同步那份
集合、否则「存在问题」自检报 FAIL。这三个入口都不存值，天然是 button。

**手动导入那条路径的两个线程**（弄反了单测验不出来）：

- `JFileChooser.showOpenDialog` **必须在 Swing EDT** 上；它是模态对话框、自己泵事件循环，off-EDT
  构造/打开就是典型的「对话框不画 / 窗口冻住」。
- 解包 **必须离开 EDT**：`FoliaModStore.install` 会走一遍 zip 并写最多 `MAX_TOTAL_BYTES`，占住 EDT
  就是冻住 SPW 整个设置窗口。它跑在 `modActions`（市场安装用的同一个串行 worker）上，所以手动导入
  与市场安装永远不会同时往 `mods/` 里解包。
- **取消不是错误**：`CANCEL_OPTION` 与对话框失败都返回 null → 静默返回，不 toast、不写 error 日志。
  用户改主意不该被告诉「出错了」。
- **这条路径没有摘要**：`install(zip, null)` 跳过 SHA-256 那一步，于是 `install` 内部其余全部规则
  （逐个条目 canonicalize 防穿越、条目数/总字节上限、`mod.json` 校验、原子替换）成为**唯一**防护。

**整条链路（v0.5.3 起是「第二个进程」，不再是「借播放页的一层遮罩」）**：

```
preference_config.json  on_click: …onOpenModMarket
   → FoliaPlugin.onOpenModMarket()      @JvmStatic @JvmName，无参
   → FoliaPlugin.openMarketWindow()     幂等：进程还活着就只重推清单/设置树
   → marketBridge.open()                FoliaHostBridge(marketOnly = true) → 第二个 spw-folia-host.exe
   → argv: --url https://spw-folia.local/settings/mod-market.html?market=1
           --window 1200x860 --no-topmost --no-transparency --no-curtain --no-keep-awake
           --user-data <pluginPath>/webview-market
   → main.tsx 的 isMarketWindow() 为真 → mountMarketWindow() → 只渲染 ModMarketPanel
```

**为什么是第二个进程而不是「给现有实例加多会话」**：`FoliaHostBridge` 的每个会话状态
（`process`/`pendingLines`/`writerThread`/`stdinBroken`/`pid`/`stdoutLog`/`pump`）都是**实例字段**，
`open()` 的 `@Synchronized` 也是实例级的，所以第二个实例天然隔离；多会话改造要动每一个字段的归属。

**三条必须分开的东西**（分开写在 `open()` 里，不是装饰）：

| 项 | 播放页 | 市场窗口 | 不分开会怎样 |
|---|---|---|---|
| `--user-data` | 默认 `%LOCALAPPDATA%\spw-folia\webview` | `<pluginPath>/webview-market` | 两个进程共用一个 WebView2 profile = 未定义行为（`docs/host-app.md`） |
| stdout/stderr 日志 | `spw-folia-host.stdout.log` | `spw-folia-host-market.stdout.log` | `bufferedWriter` 是**截断**写，后开的会把播放页的日志清空 |
| `onSettingsFromPage` | 接 | **不接** | 设置树会出现第二个写者（`docs/lessons.md` §3.1） |
| 窗口形态 | `--fullscreen` | `--window 1200x860`（`Program.cs` 的 `--window` 解析会把 `Fullscreen` 置 false） | 市场会变成一个全屏窗 |
| `/__mods/` | `--mods-dir` | 不传 | 市场不需要导入 `client.mjs`，传了等于多开一条攻击面 |

**市场窗口不接的东西，以及为什么安全**：`__SPW_FOLIA_MOD_VISUALIZERS__`（货架用，市场不读）、
`setSettingsUiOpenState`（没有浮层）、热区上报（没有穿透）、`--mods-dir`（市场只列清单与预览图，
导入 `client.mjs` 是播放页的事）。`Shim.js` 的 `case 'mods'` 在
`window.__SPW_FOLIA_MARKET_ONLY__` 为真时**跳过** `modHost.reconcile`：那个页面没有 Folia 的
visualizer 注册表，激活只会往 errors 里塞一堆假故障。

**`open-mod-market` 这条宿主命令仍然存在**（`HostForm.HandleCommand` + `DeliverPendingModMarket`
+ `Shim.pendingUiIntents`），但它不再是配置页按钮的路径 —— 它服务的是**播放页右下角胶囊**那个入口
（`PlayerBackgroundControl` 的左半，见下）。两段链路各自成立，不要把它们合成一条。

**页面未就绪时不丢 message，靠两段各自成立的机制**：

1. **宿主侧**：`modMarketRequested` 标记 + `OnTick` 里的 `DeliverPendingModMarket()`（门控在
   `webviewReady && navDone`）。**⚠️ 不能挂在 `bridgeReady` 分支上** —— 实测（2026-11-15 本机）
   设置岛只把 `bridgeReady` 当**页面内本地事件**发出（`bridge.ts` 的 `emitLocally`），它
   `chrome.webview.postMessage` 从来没发出去，宿主日志里一条 `bridgeReady` 都没有。`HostForm.cs`
   里那个分支是死代码，`--open-settings` 的打开实际靠的是 `OnTick` 的 2.5 s 兜底计时器。
   `navDone` 才是本进程真正拥有的事实。
2. **页面侧**：`Shim.js` 的 `pendingUiIntents`。`emitLocal` 在没有订阅者时是空操作 —— 设置岛 bundle
   是宿主后注入的，冷启动要 0.5–2 s 才挂载。所以 `case 'ui'` 发现没人收且 action 是
   `open-mod-market` 时就排队，等 `__SPW_FOLIA__.on('ui', …)` 第一次被调用时（宏任务里）补投。
   **只排队幂等的一次性意图**：`toggle-settings` 绝不能重放，否则会把用户刚关掉的面板再弹开。

**市场页打开时不动设置浮层**：它是并列模态，`openModMarket` 只 `setModMarketOpen(true)`；
`bridge.ts` 的 `uiActionToCommand` 对 `open-mod-market` 返回 `'none'`（不落到 `default: toggle`），
`registerSettingsUiController` 的监听器对 `'none'` 是显式 no-op。把浮层一起打开会让两个各自抢 ESC 的
window-capture 监听同时活着，一次 ESC 会关掉两层，破坏 `docs/protocol.md` §8 的契约。

**右下角胶囊**（v0.5.2 第二轮）：`PlayerBackgroundControl.tsx` 现在渲染一颗胶囊，左半是市场入口
（`data-spw-chrome="mod-market-entry"`）、右半是原来的设置按钮（`data-spw-chrome="player-background"`
**保持不变**，`verify-click-zones.mjs:353` 与 `verify-hit-region.mjs` 都按这个值找它）。

视觉全部取自上游自己的写法，**不是自造的**（这一条踩过三次，改之前先读）：

| 元素 | 取值 | 上游出处 |
|---|---|---|
| 胶囊底 | `rgba(0,0,0,0.4)` + `blur(24px)` + `border-white/5` + `rounded-full` + `shadow-2xl` | `FloatingPlayerControls.tsx:172,674-676`（`glassBgExpanded` / `backdrop-blur-xl shadow-2xl overflow-hidden rounded-full`） |
| 左半（市场） | **`bg-transparent`** + `text-white/75`，hover 才 `bg-black/20`，`rounded-full` | `AppShell.tsx:219`（`border-white/15 bg-transparent text-white/75 hover:bg-black/20 hover:text-white`） |
| 左半图标 | lucide `Command`（⌘：方框四角带环） | 参考截图本身；上游 `CapsuleQuickActions.tsx:3` 用同一图标表达「一个入口、多个去处」 |
| 右半（设置） | 44 px 实心深色圆（`rgba(0,0,0,0.62)`），**比胶囊大、溢出胶囊轮廓** | 参考截图；`overflow` 因此必须保持 `visible` |

**左半在静止态是透明的**（这是「透明会动」的一半）：只有 glyph 和胶囊自己的描边可见，hover 才浮出
填充。另加一条 2 s 的 `box-shadow` 呼吸环（尾巴对齐上游 `animate-pulse` 的 2 s），`prefers-reduced-motion`
下关闭。

**穿透时整颗胶囊 `display:none`，并且两条热区都不再上报**（`App.tsx` 的 `if (!state.mousePassthrough)`）。
只用 CSS 隐藏会让 OS 级捕获窗在同一位置留一块看不见的可点区域。这也是少掉的一条逃生口：
恢复不透明靠 `Ctrl+Alt+B` / `Ctrl+Alt+Shift+G`，右上齿轮始终可点（`docs/lessons.md` §4）。

**市场页本身的热区必须保留**：`[data-spw-mod-market="true"]` 那条 —— 穿透模式下不给它上报，
用户在穿透时打开市场会一张卡片都点不到。

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

### 5.4 v0.5.3 修掉的三个「装了没效果」断点（改之前先读）

这三个断点都**不会报错**，症状都是「装好、启用、看不到效果」，而 `verify-mod-market.mjs` 当时把前两条都绕开了（它自己传 `--mods-dir`、自己 `pushConfig`），所以门禁全绿。

| 断点 | 现象 | 修法 | 现在的守卫 |
|---|---|---|---|
| **插件不给宿主传 `--mods-dir`** | `HostForm.MountModsInterceptor` 走 `mods-dir none` 分支，不注册 `/__mods/` 拦截器；页面 `import('https://spw-folia-mods.local/<id>/client.mjs')` 必然失败，Shim 记错误后 `deactivate`，货架上**一格都没有** | `FoliaHostBridge.open()` 的 argv 里加 `--mods-dir <绝对路径>`（两个 argv 元素，不是一个拼接串） | `FoliaModStoreTest` 的 argv 形状断言 + 门禁 B 段 |
| **模组样式从未进入 `config.visualizerMode`** | `modVisualizerMode` 存在独立字段里，而 `snapshotFromState` 只带内置的 `styleId`；点模组格只移动了货架高亮，推出去的还是 `classic` | `useConfigPublisher.ts` 的 `themedInputs()` 在**发布时**投影 `effectiveVisualizerMode(state)` 进 `styleId` | 门禁 C 段 + `Stage.tsx` 的高亮用的是同一个函数 |
| **大预览框没有模组激活器** | 设置页左侧的大预览是**同源 iframe**（`preview.html` + `PreviewShim.js`），而 `Shim.js` 在子帧里第一行就 `return` —— 激活器从来不在那个文档里。Folia 渲染器拿到 `mod:<id>:<viz>` 在注册表里找不到，**静默回落**成内置样式：货架是模组、播放页是模组，只有大预览画的是 `classic` | 激活器抽成 `poc/webview/host/ModHostActivator.js`，**两个 shim 共用**（宿主把它前置进 `Shim.js` 资源，stage-web 把它作为 `_host/mod-host-activator.js` 放在 `preview.html` 的 `preview-shim.js` 之前）；`PreviewShim` 用 `getMods/emit/post` 三个注入点安装它，`LivePreview.tsx` 把设置树里的 `mods` 以 `settings` 消息转给子帧 | 门禁 C3（真 iframe + 真 `settings` 消息，断言子帧 `__SPW_FOLIA_MOD_VISUALIZERS__` 里有 `mod:` 模式） |

**为什么激活器是「一份代码、两个宿主」而不是复制一份**：`addOldClientNames` 的包装与 `onRelease` 的收集各对应一次实测失败（§3.1-3.2）。第二份稍旧一点的副本会让「模组加载了但画不出字」只在**一个窗口**里复现，那是最难发现的一类 bug。

### 5.5 播放条模组的两个断点（v0.5.3，改之前先读）

用户报告：「目前只适配了歌词样式，播放条还没适配」。官方样例「进度条增强（样例）」装好、启用、
不报错，播放条上就是没有按钮。两个断点叠在一起，**都只表现为「按钮不出现」**：

| 断点 | 现象 | 修法 |
|---|---|---|
| 模组用 **`registries.controlButtons`**（Folium 1.5 旧名）注册 | 激活器只包装了 `progressButtons`。`addOldClientNames` 把 `controlButtons` 挂成别名，但那个别名闭包指向**未包装**的 `progressButtons.register`，于是镜像数组里一条都没有 | `ModHostActivator.js` 的 `buildApi` 同时包装两个名字（`progressButtons` + `controlButtons`），同一份 `wrapProgressRegistry` |
| 我们的 ctx 缺 **`ctx.subscribe` / `ctx.currentTime`** | `mount` 抛 `TypeError: ctx.subscribe is not a function`，`ModSlot` 把按钮标成 failed。实测诊断属性：`data-spw-mod-slot-seen="1" data-spw-mod-slot-failed="1"` | `modProgress.ts` 的 `createModProgressContext` 补齐两个旧名（照上游 `deprecated/oldNames.ts`：`subscribe`→`onChange`、`currentTime`→`playbackTime`），指向同一批实现 |

**为什么 `addOldClientNames` 救不了第二个断点**：它重写的是**上游** `createFoliumClientApi` 交给模组的
ctx 对象。而播放条的 ctx 是我们自己造的（上游的 `progressButtons` 注册表在这个 OBS surface 上根本
没人求值，见 `modProgress.ts` 文件头），包装器碰不到它。

**诊断锚点**：`ModSlot` 现在**永远**渲染一个 `data-spw-mod-slot` 的 span，把「读到了几条 / 失败几条」
写进 `data-spw-mod-slot-seen` / `-failed`。返回 `null` 时页面上什么都不留，「没读到」和「读到了但被
过滤」在外部看起来完全一样 —— 这个 bug 就是靠这两个属性在两次探针内定位的。

**为什么投影在 publisher 而不是 `snapshotFromState`**：后者同时喂持久化（`bridge.ts` 的 `setSettings`），把 `mod:` 写进持久化的 `styleId` 会破坏「`visualizerMode` 永远是合法内置 id」这个回落前提 —— 模组被卸掉以后页面就再也回不到内置样式了。

**顺带修掉的**：模组格的预览图曾是破图（`previewEntry` 是裸文件名，被当成站内相对路径解析成
`https://spw-folia.local/preview.jpg`）。现在 `modStyles.ts` 用 Shim 挂在
`window.__SPW_FOLIA_MODS__.host.modsBase` 上的基址拼绝对地址，拼不出来就退回「图标 + 名字」，
**绝不猜地址**。

### 5.6 市场面板的三个交互（v0.5.3）

- **安装进度**：新协议消息 `modProgress`（`download`/`verify`/`unpack`/`done`，`total = -1` 表示分母
  未知 → 不定长条）。**不复用 `log`**：宿主刻意不把插件的 `log` 转给页面（那条通道是给文件的）。
  节流在 `FoliaPlugin.ModProgressThrottle`（≥200 ms 且百分比变了才发）—— `sendLine` 的队列满了会
  丢**最旧**的一条，而最旧的是 100 ms 的 `state` 时钟。
- **点卡片打开模组网站**：catalog 里**没有** homepage 字段（59 条实测），所以优先用社区/Beta 条目
  的 `source`（GitHub 仓库），否则用市场自己的锚点 `根 + #mod-<id>`（站点首页里 `id="mod-<id>"` 真实
  存在）。卡片本体可点，但 `closest('button, a, input, [role="switch"]')` 命中时放行给按钮；另有
  一个显式外链按钮给键盘用户。`cursor` 用**内联 style** 而不是 Tailwind `cursor-pointer` ——
  `verify-click-zones.mjs` 按 classList 找 monet 的竖排挂件，多一个候选会破坏那个门禁。
- **市场清单缓存**：`localStorage`（`spw-folia.modCatalog.v1`），首帧直接画缓存、后台再取新的。
  存的是**市场自己那份 catalog 的副本**，不是「装了哪些模组」（后者只有插件知道）。读回来的字节
  必须重新过 `parseModCatalog`；`offline` 只在手上什么都没有时才成为状态，有缓存时它只是 `reason`
  —— 断网打开市场应该看到「缓存 + 离线提示」，而不是清单突然变空。

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
- **E. 市场窗口**（v0.5.3）：`mod-market.html` 必须进 staging、必须带 `#root`、不许自带模块标签
  （第二个入口会产出第二个 `settings-ui.js`）；`MARKET_PAGE` 与 `MARKET_PAGE_URL` 必须指同一页；
  真 exe 用**不带** `--mods-dir` 的 argv 开那个 URL，断言 `[data-spw-mod-market]` 存在、
  `canvas` 数为 0、设置浮层数为 0、`__SPW_FOLIA_MARKET_ONLY__` 为真。这一段就是「商店不再依赖
  folia 的主界面」的可执行定义。
- **C3. 大预览的模组激活**（v0.5.3）：在真页面里造一个 `preview.html` iframe，按
  `LivePreview.tsx` 的信封发 `settings` 消息，断言**子帧自己的** `__SPW_FOLIA_MOD_VISUALIZERS__`
  里出现 `mod:` 模式。这条只能用真 iframe 测 —— 失败形态是 Folia 渲染器内部的静默回落，静态检查
  看不到。

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
- `modProgress`（v0.5.3）方向相反：插件 → 宿主 → 页面。宿主白名单 `phase`，逐字段重拼，**不**转发
  `log`（那条通道只进文件）。`total = -1` 是合法的「分母未知」。
