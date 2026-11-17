# v0.5.4 · Beta 模组系统（修补版）

**预览版（Pre-release）** —— 这一版不增加新扩展点，只把 v0.5.2 里「模组装得上但看不见 / 点不动」的
那几个断点修掉。如果你装过模组却觉得「没什么变化」，这一版就是为了那个。

> 模组是第三方代码。本插件**不审查、也不校验签名**，只在下载后核对市场公布的 SHA-256。
> 请只安装你信任的来源。

---

## 一句话：三个「装了没效果」的断点

它们都**不会报错**，症状一模一样（装好、启用、看不到任何变化），所以只能靠真机逐段取证。

### 1. 插件从未把模组目录交给宿主

`FoliaHostBridge` 拼出的启动参数里从来没有 `--mods-dir`。宿主于是走
`mods-dir none (mod files are not served)` 分支，**不注册 `/__mods/` 拦截器**；页面去
`import()` 模组文件必然失败，Shim 记一条错误后把模组停用 —— 货架上连格子都不出现。

修法是两个 argv 元素（不是拼接串）。守卫：`FoliaModStoreTest` 钉住 argv 形状。

### 2. 选中的模组样式从未进入 `config.visualizerMode`

模组样式存在独立字段 `modVisualizerMode` 里，而发布用的 `snapshotFromState` 只带内置的 `styleId`。
点模组格只移动了货架高亮，发出去的还是 `classic`。

修法是在 **publisher 发布时**投影 `effectiveVisualizerMode(state)`，而不是改 `snapshotFromState` ——
后者同时喂持久化，把 `mod:` 写进持久化的 `styleId` 会破坏「模组卸掉后回落到内置样式」这个前提。

### 3. 设置页的**大预览框**没有模组激活器

大预览是**同源 iframe**（`preview.html` + `PreviewShim.js`），而 `Shim.js` 在子帧里第一行就
`return`。激活器从来不在那个文档里跑，`__SPW_FOLIA_MOD_VISUALIZERS__` 不存在，Folia 渲染器拿到
`mod:<id>:<viz>` 找不到就**静默回落**成内置样式：货架是模组、播放页是模组，只有大预览画的是
`classic`。

修法是把激活器抽成 `ModHostActivator.js`，**两个 shim 共用一份**（不复制：第二份稍旧的副本会让
「模组加载了但画不出字」只在一个窗口里复现）。

---

## 播放条模组：两个断点

官方样例「进度条增强（样例）」和「更多进度条按钮」都是这一类。

### 旧注册表名 `controlButtons`

模组写的是 `folium.registries.controlButtons`（Folium 1.5 名字）。`addOldClientNames` 确实把它挂成了
`progressButtons` 的别名，但那个别名闭包指向**未包装**的 `progressButtons.register` —— 于是按钮镜像
不进播放条。现在两个名字都包装。

### 旧 ctx 名 `ctx.subscribe` / `ctx.currentTime`

我们的播放条 ctx 是**自己造**的（上游那套注册表在这个 OBS surface 上没人求值），
`addOldClientNames` 碰不到它。模组的 `mount` 里一句 `ctx.subscribe(...)` 就是
`TypeError: ctx.subscribe is not a function`，按钮被标成 failed，DOM 里什么都没有。

现在按上游 `deprecated/oldNames.ts` 逐字补齐两个旧名（`subscribe`→`onChange`、
`currentTime`→`playbackTime`），指向同一批实现。

实测（真实安装的插件 + 市场装的模组）：

```
registry: 4 条  [more-progress-buttons:shuffle / volume / like, sample-progress-bar:bookmark]
slots: leading:1, trailing:2
buttons: 三个按钮真实挂载进 DOM
errors: []
```

---

## 市场与窗口

### 模组市场现在是**独立小窗口**

不再借播放页：点「模组市场」会开第二个宿主进程，`--url` 直接指向 `mod-market.html?market=1`，
小窗（1200×860）、不置顶、不穿透、独立 WebView2 profile。**不需要先打开播放页**。

实测：市场窗口里 59 张卡片、0 个 canvas、0 个设置浮层 —— 播放页从未加载。

### 安装进度条

新协议消息 `modProgress`（下载 / 校验 / 解包 / 结束），分母未知时画不定长条。插件按 ≥200 ms 且
百分比变化节流（这条队列满了会丢最旧的 `state` 时钟）。

### 点卡片打开官网

点击卡片本体或右下角外链图标，在浏览器里打开该模组页面（社区模组→作者仓库，官方→市场里它的锚点），
底部出现「已在浏览器中打开：…」。点「安装」不会触发。页头新增「模组网站」按钮打开市场首页。

### 清单缓存 + 无黑边

市场清单落到本机，再次打开首帧就有内容、后台更新。独立窗口里去掉了模态遮罩（它本来是用来压暗
播放页的，在这里只是一圈黑边）。

---

## 这一版踩到并修掉的坑

- **「显示播放条」在鼠标穿透时仍然显示且可拨开。** 穿透的含义是「每次点击都属于桌面」，播放条唯一
  的用途就是被点击：现在它既不渲染、进入穿透时也会落到「关」。
- **鼠标穿透后右下角按钮全部消失。** 根因不在胶囊（它 `display:none` 是设计），而在**空闲淡出**：
  它靠页面自己的 `pointermove` 唤醒，而穿透时页面**收不到**那些事件（按定义它们属于桌面）。
  2.5 秒后齿轮淡成 `opacity:0`，永远醒不过来 —— 只剩两个你多半不知道的热键。
  现在穿透期间整个停掉淡出计时器，齿轮常显。
- **面板里的两行开关点不动。** 「点击外部关闭」那条 capture 监听用的 ref 只包住**胶囊**，而面板是
  它的兄弟节点：面板内任意一次 `pointerdown` 都被判成「外部」，在行的 `click` 跑起来之前就把面板关了。
  面板看起来还开着，开关永远不响应。
- **进度消息只发给了播放页。** 用户是从**市场小窗**点安装的，进度条长在那个窗口上；只发播放页时它
  一条都收不到（下载其实成功了，只是没有任何反馈）。
- **市场清单缓存从来没命中过。** 第一版存的是归一化对象，读回来又交给只认线上格式的解析器，于是
  每次都当成「没有缓存」重新请求。改存原始响应文本。
- **模组缩略图是破图。** `previewEntry` 是裸文件名，被当成站内相对路径解析成
  `https://spw-folia.local/preview.jpg`。
- **分组标题显示成 `MODMARKETOFFICIAL`。** i18n 键少了 `options.` 前缀。
- **SPW 重启时插件会带着死线程池跑。** PF4J 可以对同一个实例 `stop()` → `start()`，而 `modActions`
  与设置存储的执行器在 `stop` 里被 `shutdownNow()` 且再也不会重建 —— 之后每一次安装都抛
  `RejectedExecutionException`，日志只有一行 `mods: install dropped`，界面上**没有下载、没有进度条、
  没有任何提示**。现在生命周期自己拥有这两个执行器，并在 `start()` 里重建。

---

## 门禁

- `verify-all.mjs`：**12/12**（6 套件并发）。
- `verify-click-zones`：**60/60**（新增面板内点击、穿透淡出守卫、「显示播放条」隐藏三组）。
- `verify-mod-market`：**32/32**（新增旧注册表名按钮挂载、大预览激活两条）。
- `verify-select-layers` 11/11、`verify-layout` PASS、Gradle 测试全过。

## 已知边界（与 v0.5.2 相同）

`progressLayers`（轨道图层）、`settingsSections`（模组自己的设置页）仍然只注册不绘制；
`backgrounds` / `stageLayers` / `homeTabs` / `playerPanelTabs` / `commands` / `styles` 属于 Folia
桌面主窗口界面，本插件不提供。不支持的能力不会导致装不上，只是那部分不生效。

## 升级提醒

- 模组目录在插件目录里面。**这一版的安装脚本已修好**（会把 `mods/` 拷出来再放回去），
  但如果你用别的方式重装，请先备份 `<插件目录>/mods/`。
- 装了模组却没看到变化，先确认插件日志里有 `mods-serve root=…`；看到
  `mods-dir none (mod files are not served)` 说明宿主没拿到模组目录（插件与宿主版本不匹配），
  重装插件即可。
