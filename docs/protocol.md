# 通信协议 v1

本文件是 **插件（Kotlin）↔ 宿主进程（C#）↔ WebView2 页面（JS）** 的接口契约。
任何一方改字段都要先改本文件。设计目标：页面内计算 `config`，宿主只做搬运；无 HTTP 服务、无网络依赖。

协议 v1 只允许**追加**：新消息进本文件，不破坏既有字段；「动作类」消息统一用扁平信封（与 `control` 一致）。

## 0. 进程与职责

```
SPW (JVM) ── spawn ──> spw-folia-host.exe（C#/.NET，全屏窗口 + WebView2 + WASAPI 采集）
   │  stdin/stdout JSON-lines              │  chrome.webview.postMessage
   │                                       ▼
   │                            WebView2 页面 = Folia dist + 注入 Shim.js + 注入设置岛
   └── 菜单项点击 / 播放数据                  （配置构建、主题推导、渲染、设置界面）
```

- **插件**：唯一数据源（播放时间/歌词/曲目/封面/持久化设置）。不做音频分析、不建窗口。
- **宿主 exe**：窗口/全屏/ESC/DPI、加载离线 web bundle、注入 Shim + 设置岛、WASAPI 环回音频分析、
  stdin/stdout 转发、退出汇报。**不做本地播放语义处理，只搬运**。
- **页面**：Folia 生产 dist（`/obs` surface）负责视觉；注入脚本负责 (a) 用 `EventSource` shim
  接收 clock/audio/config，(b) 设置界面与 `ObsBrowserSourceConfig` 构建、主题推导。
- **无 HTTP**：bundle 通过 `SetVirtualHostNameToFolderMapping(https://spw-folia.local)` 加载；
  开发可选 `--dev-url`。

## 1. 插件 → 宿主（stdin，每行一个 JSON 对象，UTF-8）

> **铁律：一条消息必须严格占一行 —— 内嵌的子 JSON 里不允许出现裸换行。**
>
> 两端都是行导向的：插件 `BufferedWriter.write(line)` + `"\n"`，宿主
> `Console.OpenStandardInput()` + `reader.ReadLine()`。而 `settings` / `lyrics` / `track`
> 这些字段是**原样内嵌**（字符串拼接，不经过再序列化），所以子 JSON 里任何一个 `\n` 都会把
> 一条消息拆成多条，全部解析失败并被丢弃。
>
> 历史故障：内置 `default-settings.json` 是美化格式（7188 字节 / 268 个换行），启动那一次
> `settings` 推送被拆成几百条非法片段，页面永远收不到三个配置页开关。
>
> 规则：发送前对外部来源的 JSON 调用 `Json.singleLine()`（跳过字符串字面量内部，只压缩 token
> 之间的空白）。回归见 `packaging/tools/verify-json-singleline.mjs`；压缩后的载荷与压缩前
> `JSON.parse` 结果必须完全等价。

| t | 字段 | 说明 |
|---|---|---|
| `hello` | `protocol:1`, `pluginVersion`, `spwVersion`, `devUrl?`, `bundleDir?` | 启动握手；`devUrl` 存在时加载开发服务器（仅开发） |
| `settings` | `settings: object` | 全量持久化设置。**打开窗口时下发一次，收到 `ready` 后再重发一次**（见 §2 `ready`）；UI 每次改动后回传一次做确认。载荷必须先 `Json.singleLine()` |
| `state` | `posMs:int`, `durationMs:int`, `playing:bool`, `rate:number`, `tsMs:int64`, `lyricOffsetMs?` | 播放时钟，建议 100ms 一次（≥20Hz）。页面按 `tsMs + (now-tsMs)*rate` 插值 |
| `lyrics` | `lines:[{startMs,endMs,main,sub,cells:[{startMs,endMs,text}]}]`, `offsetMs:int`, `translationMode?` | 曲目/歌词变化时发送；空数组=无歌词。**`cells` 是真实逐字时轴**（SPW `LyricsLine.Cell`，绝对毫秒），页面 `toPublisherLyrics` 把它映射成 Folia 的 `words[]`，缺失时才退回按字符均分的 `fallbackWords` |
| `track` | `id`, `title`, `artist`, `album`, `durationMs`, `coverDataUrl?`, `coverPath?` | 封面优先 data URL（JPEG/PNG base64），否则宿主负责本地读取。宿主转发页面时同时给出 `coverUrl` 镜像（见 §1.1） |
| `queue` | `mode:"circle"\|"circle-end"\|"repeat-one"\|"random"`, `random:bool`, `index:int`, `items:[{id,title,artist,album}]` | 当前播放队列快照。`random=true` 时 `items` 是随机队列且 `index` 对应随机队列位置，否则是顺序队列。首次连接后、队列/模式变化时发送（低频）；播放进度不在此处 |
| `config` | `config: object` | 可选覆盖：插件强制推送完整 Folia `ObsBrowserSourceConfig`（调试/兼容用，正常不用） |
| `audioMode` | `mode:"loopback"\|"host-fft"\|"off"` | 可选；默认 loopback |
| `quit` | — | 请求优雅退出 |

### 1.1 封面字段兼容

`coverDataUrl` 是插件发送的规范字段（base64 data URL）。宿主转发给页面时把同一值**镜像**为
`coverUrl`，以同时满足 Folia 自身 `ObsBrowserSourceConfig.coverUrl` 与旧调试脚本；页面消费方可读
任一拼写，设置岛 `bridgeTrackCover(track)` 优先 `coverUrl`、回退 `coverDataUrl`。

## 2. 宿主 → 插件（stdout，每行一个 JSON 对象）

| t | 字段 | 说明 |
|---|---|---|
| `ready` | `protocol:1`, `pid`, `webviewVersion`, `bundle`, `frameRateCleared?` | WebView2 与 bundle 就绪，可开始发 state。**插件收到后必须重发 `settings`**：宿主在 WebView2 就绪前把 `settings` 直接丢弃（`post-page-skip reason=not-ready`），首次推送必然落在窗口外，不重发就等于页面永远收不到配置页开关值 |
| `closed` | `reason:"user"\|"error"\|"plugin"` | 窗口关闭（ESC/Alt+F4/崩溃）；随后进程退出。**插件必须据此清理状态，再点菜单可重新启动** |
| `settings` | `settings: object` | UI 修改了设置 → 插件持久化（并可选校验/夹紧） |
| `action` | `name:"reset"\|"openDevTools"\|"reload"` | UI 请求的动作 |
| `control` | `action:"toggle"\|"previous"\|"next"\|"seek"\|"shuffle"\|"queue-play"`, `positionMs?`, `index?`, `random?` | 播放条控制请求（由 §3.1 页面 `control` 转发），插件落到宿主播放器接口，见 §3.4 |
| `log` | `level:"info"\|"warn"\|"error"`, `msg` | 诊断日志（插件写入 `spw-folia.log`） |

## 3. 宿主 ↔ 页面

### 3.1 页面 → 宿主（`window.chrome.webview.postMessage`）

- `{"type":"ready"}`：页面/注入脚本就绪（dist 与设置岛分别报，宿主转发给插件仅作诊断）
- `{"type":"settings","settings":{...}}`：设置 UI 改动（宿主立即转发给插件持久化）
- `{"type":"action","name":"close"|"reset"|"openDevTools"|"reload"}`
- `{"type":"control","action":…,"positionMs"?,"index"?,"random"?}`：播放条控制。宿主原样转发为
  §2 `control`，不自行处理；页面侧经 `__SPW_FOLIA__.emit('control', {action, …})` 发出（Shim 平铺字段）。
- `{"type":"ui","settingsOpen":bool}`：设置覆盖层开合状态（Shim 在捕获阶段拦截 `settingsUI` 消息后
  发出）；宿主据此在覆盖层打开期间强制显示光标，并保证 ESC 优先关闭覆盖层。
- `{"type":"hitbox","vw":n,"vh":n,"rects":[{x,y,w,h}]}`：页面热区（CSS px）。`rects` 数量动态，
  宿主**不得写死**；`rects=0` 时 fail-open = 整窗可点。
- `{"type":"windowDrag"}`：Alt + 左键拖动 → 宿主进入原生窗口移动循环（可跨屏）。
- `{"type":"envCheck"}`：「出现问题」面板请求宿主环境自检，宿主回 §3.2 `envReport`。
- `{"type":"openLogFolder","path"?:"<dir>"}`：用资源管理器打开日志目录并选中 `spw-folia.log`；
  `path` 省略时宿主用自己的 exe 目录。
- `{"type":"openUrl","url":"https://…"}`：用默认浏览器打开反馈页；宿主只接受 `http`/`https`，
  其余一律拒绝并记 warn。
- `{"type":"splash","state":"…","atMs":n}`：开屏遮罩的页面侧时间线（诊断用）。
- `{"type":"log","level":"…","msg":"…"}` / `{"type":"fps",…}` / `{"type":"first-frame",…}` / `{"type":"key",…}`

### 3.2 宿主 → 页面（`chrome.webview.postMessage`，页面侧由 Shim.js 统一接收）

| type | 负载 | Shim 行为 |
|---|---|---|
| `hello` | `{protocol:1,bundleVersion}` | 记录，触发 `emit('hello')` |
| `settings` | `{settings}` | 交给设置岛初始化（`window.__SPW_FOLIA__.settings`） |
| `state` | `{posMs,durationMs,playing,rate,tsMs,lyricOffsetMs?}` | 转成 `clock` 事件：`{currentTime:posMs/1000, duration:durationMs/1000, playerState:playing?'playing':'paused', sentAtMs:Date.now(), playbackRate:rate, lyricOffsetMs:offsetMs/1000}`（EventSource 分发，250ms 或变化时发；时间插值在页面侧做） |
| `lyrics` | `{lines,offsetMs}` | 更新设置岛的歌词输入 + 重算 config |
| `track` | `{…}` | 更新配置（theme/cover/title） |
| `queue` | `{mode,random,index,items:[{id,title,artist,album}]}` | 记入 `inputs.queue` 并 `emit('queue')`，播放条与播放列表据此渲染 |
| `audio` | `{power,bass,lowMid,mid,vocal,treble,spectrum:[…]}` | 转成 `audio` 事件，**已是 0..255 gamma 尺度**；spectrum 为 0..255 数组（1024 bins） |
| `config` | `{config}` | 直接分发 `config` 事件（覆盖页面自算，调试用） |
| `ui` | `{settingsOpen}` | 更新 `__SPW_FOLIA__.ui` 状态 |
| `envReport` | 宿主环境自检对象（§3.5） | 记入 `inputs.envReport` 并 `emit('envReport')`；「出现问题」面板据此渲染 |
| `beat` | `{beatImpact,downbeatImpact}` | **目前宿主不发送这条消息**，`beatImpact/downbeatImpact` 恒为 0。Shim 侧的接收路径与 `window.__SPW_FOLIA_BEAT__` 钩子已就绪，但宿主没有任何发 `beat` 的代码 —— 加节拍特效前必须先补宿主侧（见 [`docs/audio-timeline.md`](audio-timeline.md)） |

### 3.3 注入全局（Shim.js 暴露，设置岛使用）

```ts
window.__SPW_FOLIA__ = {
  protocol: 1,
  on(type: 'hello'|'settings'|'state'|'lyrics'|'track'|'audio'|'config'|'queue'|'envReport', fn),
  emit(type, payload),                  // 设置岛 → 宿主（内部转 chrome.webview.postMessage；
                                        // type:'control' 平铺为 §3.1 control 消息）
  pushConfig(config),                   // 设置岛 → 页面：立即作为 config 事件分发
  getSettings(), setSettings(partial),  // 内存 + 持久化（emit({type:'settings'})）
  requestClose(),
  inputs: { state, lyrics, track, queue, envReport },   // 只读快照
  ui: { isSettingsOpen(), openSettings(), closeSettings() },
  lastConfig()                          // 播放页收到的最后一版 config（预览子帧镜像用）
}
```

### 3.4 播放控制通道

播放条（注入的底部 HUD）与画面点击分区通过 §3.1 `control` 驱动真实播放器；宿主只做搬运，插件落到
SPW 宿主进程内的播放器接口（`spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlaybackControls.kt`）。

| action | 字段 | 语义 |
|---|---|---|
| `toggle` | — | 播放/暂停切换 |
| `previous` | — | 上一首 |
| `next` | — | 下一首 |
| `seek` | `positionMs:int` | 跳转到指定毫秒（夹紧到 `[0,durationMs]`） |
| `shuffle` | — | 切换随机播放：开 → 记住当前非随机模式并切到 Random；关 → 恢复记住的模式（默认 circle） |
| `queue-play` | `index:int`, `random:bool` | 播放列表中第 `index` 项；`random` 与 `queue` 的 `random` 字段一致，插件据此选择随机/顺序队列 |

白名单外的 action 丢弃并记 warn（前向兼容）；`positionMs`/`index` 负数夹 0；`random` 缺省 false。

**状态回流**：`queue` 事件携带 `mode`、`random`、`index` 与 `items`；页面以 `mode === 'random'`
作为随机按钮激活态，以 `index` 高亮当前项。点的列表项立即发 `queue-play`，不等回流。
`queue` 与高频 `state` 独立，不要求 20Hz。反射不可用时 `queueJson()` 返回 `null` → 桥不发送 →
页面保留上一份快照（不是清空）。

#### 宿主播放器反射映射

宿主播放器不在 Workshop API 里，`FoliaPlaybackControls` 用 `java.lang.reflect` 打宿主自己的
classloader。要点（改这里前必读）：

1. **用结构而不是混淆名定位成员。** SPW 是 R8 混淆的，**每个 build 都会重新生成混淆名**，同一版本的
   Windows / Linux 构建也不相同。`HostMemberResolver` 用两条与名字无关的策略：
   Kotlin `@Metadata` 的**原始属性名 + 声明顺序**（R8 默认保留 metadata，字段表顺序与 metadata 顺序
   一致），metadata 被剥掉时退回**返回类型/元数形状**匹配。文件里残留的 `\u037F`/`\u0528…\u052B`
   只是最后兜底。
2. **加载器**：首选 `Class.forName(name, false, WorkshopApi::class.java.classLoader)`
   （`com.xuncorp.spw.workshop.api.WorkshopApi` 由宿主运行时提供，其 classloader 必能看见宿主类）；
   失败再退回 `Thread.currentThread().contextClassLoader`、插件自身 classloader。首次解析记录实际
   生效的 loader 与失败原因。
3. **不要独立 JVM 探测**：`PlaybackController.<clinit>` 会构造 `PlaybackService` 并初始化 BASS
   原生库（独立 JVM 里表现为 `IllegalArgumentException: Invalid library name ""`）。只能在 SPW 进程内调用。
4. **失败必须吞掉并记日志**（首次全文，之后限流），绝不能让宿主桥线程或插件加载失败。
5. `Method`/`Field` 句柄一次性解析并缓存（`@Volatile` + 双检）；`getValue()` 每次实时读，不回放缓存。
6. 队列元素是 `com.xuncorp.spc.core.queue` 下的单字符类（原始名 `PlaybackQueueItem`），
   先取 id 与 `data`，再把 `data` 当 `PiscesMediaItem` 取 `id/title/artist/album`。
7. 反射枚举一律走 `Enum.name` / `values()`，绝不按字段名取值。

### 3.5 环境自检报告

`HostForm.BuildEnvReport()` 产出的字段（全部 best-effort，取不到就是 `null`）：

| 字段 | 含义 |
|---|---|
| `hostVersion` / `pid` / `protocol` / `startedAtMs` | 辅助进程身份与已运行时长 |
| `webView2` | `CoreWebView2Environment.GetAvailableBrowserVersionString()`；缺失时 `null`（对应 exit 3） |
| `dotnet` | 注册表 `NET Framework Setup\NDP\v4\Full\Release`（4.8 = 528040，4.8.1 = 533320+） |
| `os` / `os64` / `process64` | 系统版本与两个位数标志 |
| `windowsBuild` / `windowsVersion` / `windowsRevision` | 面板判定用的构建号（`Environment.OSVersion.Version.Build`）。**不要再从 `os` 展示串里反推**——JVM 侧 `os.version` 恒为 `10.0` |
| `webView2Error` / `dotnetError` | 对应值为 null 时的失败原因。有原因 → 判「无法判定」，不是「未安装」 |
| `bundle` / `bundleIndex` | 页面 bundle 目录、`index.html` 是否存在（缺失 = exit 2） |
| `settingsDir` / `settingsEntry` | 设置岛目录、`settings-ui.js` 是否存在 |
| `userData` | WebView2 用户数据目录 |
| `nativeFiles` | `{dir, present[], missing[]}`：与 exe 同目录的 5 个原生文件 |
| `dpi` / `dpiAwareness` / `screen` | 窗口 DPI 与客户区尺寸 |
| `transparent` / `audio` | 当前是否色键透明、音频采集源（WASAPI 回环失败时回落合成信号） |
| `fps` / `statesReceived` / `framesPosted` / `droppedLogLines` | 运行期计数 |
| `logPath` | 插件把宿主 stdout 镜像到的日志文件（`--log-file`），面板据此定位日志 |

判定口径见 [`docs/logging-and-diagnostics.md`](logging-and-diagnostics.md)：
四态 `pass/fail/unknown/advisory`，**只有证据能产生 fail**，拿不到证据只产生 unknown，
unknown 绝不表述成「缺失」。

## 4. 设置对象（settings）与 config 构建

- `settings` 是设置岛的状态树（JSON），字段见 [`docs/folia-spec/settings-ui.md`](folia-spec/settings-ui.md)；
  键名**沿用 Folia 存储键**（`styleId`、`smartBeat`…），便于与上游对照。
- **注入成员（插件写、页面只读，不属于持久化快照）**：设置树顶层由插件在 `withInjectedMembers()`
  写入、页面**不回写不持久化**的成员：
  - `systemFonts`（AWT 枚举的系统字体，不落盘）、`transitionAnimation`、`verboseLog`；
  - `previewAnimation`（配置页「歌词样式预览动画」，默认开）；
  - `showProblemButton`（配置页「显示问题反馈按钮」，默认**关**）；
  - `showPlaybackBarLegacy`：**只作迁移来源**，见下。
  `FoliaPlugin.onSettingsFromPage` 在落盘前把这些成员从页面回传的树里剥掉，避免双写方与启动竞态覆盖。
  **新增同类开关照这条走：插件读 config → 塞进设置树顶层 → 页面读 `getSettings()` + 监听 `settings` 事件。**
- **`showPlaybackBar` 已迁移所有权（v0.4.17）**：它现在是**页面自己 settings 树**里的字段
  （`model/settings.ts`），持久化走页面既有的「改动 → emit → 插件写盘」链路；入口是播放页右下角
  菜单里的一行开关。插件侧仍读旧的 `config.json` 值，但只以 `showPlaybackBarLegacy` 下发，
  页面仅在树里还没有该键时用它播种一次，之后永远以树为准。
- **配置页开关的读取通道**：不要依赖宿主的 `ConfigManager` 变更回调（真机实测回调不一定来、
  `getConfig()` 返回缓存、一次编辑触发多次回调）。`FoliaConfigSync` 把**磁盘文件**当唯一事实来源：
  先 `reload()` 强制从磁盘重读，再读全部开关，只有值真的变了才推送；触发有两条 —— 宿主回调
  （快路径）加一个低频守护线程（兜底，回调不来时最多等一个周期）。
- config 构建由页面内 **settings publisher** 完成：
  `inputs(settings, lyrics, state, track, coverColors, theme)` → `ObsBrowserSourceConfig`
  （字段同 Folia `src/types/obsBrowserSource.ts`，见 [`docs/folia-spec/runtime-contracts.md`](folia-spec/runtime-contracts.md)）。
- 主题由页面从封面图像 canvas 取色推导（暗/亮、主色、次色、背景色）；无封面用默认暗色主题。
- 节流：settings/lyrics/theme 变化时重算 config（≤10Hz）；`state` 不进 config（走 clock 事件）。

## 5. 音频（宿主内完成，页面只用结果）

- 宿主 WASAPI loopback，sampleRate = mix format rate。每帧（30–60Hz）：
  - `spectrum[1024]` = `getByteFrequencyData` 等价（0..255 raw）
  - binHz = `sampleRate/2/1024`；五带 = **bin 算术平均**（20–150 / 150–400 / 400–1200 / 1000–3500 / 3500–12000 Hz）
  - `shape(v,boost) = (v/255)^boost*255`；`power=shape((bass+lowMid)/2,3)`、
    `bass^1.8`、`lowMid^2`、`mid^2`、`vocal^1.5`、`treble^2`
  - **无信号/暂停**：`breath=(Math.sin(Date.now()/2000)+1)*20` 写进 power + 五带，spectrum 空数组
- 采样率不是 44100 时必须用实际 binHz，否则五带整体偏移。
- provider 有三档：`LoopbackAudioProvider`（真实分析）、`StdinAudioProvider`（调试，音频帧从 stdin
  推进来）、`SyntheticAudioProvider`（回环不可用时的呼吸兜底）。
- **音频分析结果已进页面，节拍事件没有。** `PlaybackTimeline` 有一个可选的 `hostClock` 校正钩子
  （预留给 `HostPlaybackProbe`），但 `FoliaPlaybackExtension` 构造 `TimelineController()` 时不传它，
  仓库里也没有 `HostPlaybackProbe` 的实现 —— 位置仍然只来自 SPW 的 1 Hz 回调 + 插值。

## 6. 生命周期

1. 菜单项点击 → 插件确保单例；无窗口则 spawn 宿主 → 发 `hello` + `settings`；收 `ready` 后重发
   `settings`，再按 100ms 周期发 `state`。
2. 宿主窗口关闭 → `closed` → 插件停止 state 发送、等进程退出（超时强杀）、清理。
3. 插件 disable/uninstall → 插件发 `quit`，等 2s 后强杀；删除任务前先释放。
4. 宿主崩溃 → 插件读 stdout EOF + 退出码，写日志并允许重开。
5. **长生命周期对象 + 短生命周期线程 = 按会话隔离**：队列、writer、exit watcher 都带会话身份，
   `cleanup(reason, expected)` 在锁内先判身份，否则会出现「第二次打开静默失效」。

## 7. 开发与调试

- 开发模式：`spw-folia-host.exe --dev-url http://127.0.0.1:18080/?obs=1&token=dev --dev-settings <json>`
  （`poc/webview/server/` 的 `server.mjs` 提供 demo 数据）。
- 生产：`--bundle <dir>`（`.spmod` 包里的 `web/`），虚拟 host `https://spw-folia.local/`。
- 常用参数：`--fullscreen`（默认）、`--windowed w,h`、`--devtools`、`--fps-log <path>`、
  `--user-data-dir <dir>`、`--no-sw-purge`。完整清单见 [`docs/host-app.md`](host-app.md)。

## 8. 全屏 UI / 交互契约

- 设置岛在 `window.__SPW_FOLIA__.ui` 注册 `isSettingsOpen()` / `openSettings()` / `closeSettings()`
  （页面内覆盖层状态，不重建页面）。
- 覆盖层打开时接管 ESC：capture 阶段 `keydown Escape` → closeSettings + `stopPropagation()`；
  覆盖层关闭时不拦截 ESC，交给宿主/Shim → `action close` → 宿主关窗。
- 覆盖层开合状态通过 `{"type":"ui","settingsOpen":bool}` 报告给宿主。
- 轻量 chrome：右上角 ⚙（唤出设置；鼠标静止 2.5s 后与光标一起淡出）、覆盖层左上角 ← 返回按钮、
  右下角播放页设置按钮（透明背景 / 鼠标穿透 / 显示播放条）。
- 宿主首次打开且无持久化设置时带 `--open-settings`；之后直接显示视觉器。菜单再次点击时窗口已存在
  则置前（不重复开窗）。宿主收到 `command close-settings` 时调 `ui.closeSettings()`，`open-settings` 相反。
- 鼠标侧键「返回」（XBUTTON1，DOM `button===3`）与 ESC 同义：Shim 在 window capture 阶段处理
  `mousedown`，overlay 打开时只关 overlay，否则发 `{"type":"action","name":"close"}`（`reason=user`）。
  透明模式下由宿主 `TransparencyInputCatcher` 转发 `WM_XBUTTONDOWN/UP`；侧键「前进」不退出。
- 视觉器页面本身保持 OBS 模式（`isPlayerChromeHidden:true`），不注入任何 Folia 播放器 chrome。
- 光标策略：全屏窗口内鼠标静止 2.5 s 后隐藏，移动即恢复；覆盖层打开期间强制显示；关窗后恢复系统光标。
  宿主把「`settingsOpen` OR 未空闲」作为目标可见性（幂等，只在状态变化时写日志）。
- **画面点击分区（v0.4.17）**：`chrome/PlaybackClickZones.tsx` 提供一层不可见热区 —— 左 1/3 上一首、
  中 1/3 播放/暂停、右 1/3 下一首。它在所有控件**之下**（z-index 2147482990，播放条 2147483000、
  chrome 按钮/面板 2147483001+），因此被覆盖的控件永远赢；设置覆盖层打开时与鼠标穿透时整层禁用
  （`data-enabled="false"` → `pointer-events:none`）；位移 > `DRAG_SLOP_PX`(10px)、手势取消或按住
  Alt（宿主窗口拖动）都不算点击。DOM 契约：`[data-spw-click-zone]` 容器 +
  `[data-zone="prev"|"toggle"|"next"]`。
- 覆盖层内容在 `display:none` 下保持挂载（不重建 React 树），重新打开是瞬时的。

## 9. DPI 与多显示器

宿主按目标屏 DPI 设置 WebView2 的 `RasterizationScale` / `Bounds`，避免模糊；详见
[`docs/host-app.md`](host-app.md)。
