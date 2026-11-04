# 播放控制通道

播放条与画面点击分区驱动真实播放器的完整链路。**线协议以 [`docs/protocol.md`](protocol.md)
为准**（§1 `queue`、§2 `control`、§3.1 页面 `control`、§3.2 `queue`、§3.4 action 语义）；
本文记录**宿主内部反射映射**与各层实现契约。

## 1. 数据流

```
[设置岛 PlaybackBar / PlaybackQueuePanel / PlaybackClickZones]
   --emit('control')--> Shim --§3.1 {"type":"control",...}--> HostForm.OnWebMessageReceived
   --§2 {"t":"control",...}--> 插件 FoliaHostBridge stdout 读取
   --> FoliaPlaybackControls（反射）--> PlaybackController / PlaybackQueue

[队列状态] PlaybackController.getPlaybackQueueState()
   --> FoliaPlaybackControls.snapshotJson() --§1 {"t":"queue",...}--> HostForm.HandleStdinLine
   --§3.2 {"type":"queue",...}--> Shim emit('queue')
   --> PlaybackBar（随机激活态）+ PlaybackQueuePanel（列表 / 当前项 / 点击切歌）
```

**宿主只做搬运**（`t` ⇄ `type` 改名、字段白名单校验），不得自行处理播放语义；插件是控制落点。

## 2. 宿主内部反射映射

宿主播放器不在 Workshop API 里，`FoliaPlaybackControls`（`spw-folia/src/main/kotlin/dev/spw/folia/`）
用 `java.lang.reflect` 打宿主自己的 classloader。**不要**把宿主类加入编译期依赖。

**关键前提：混淆名不可写死。** SPW 是 R8 混淆的，每个 build 都会重新生成混淆名，同一版本的
Windows / Linux 构建也不相同。`HostMemberResolver` 用两条与名字无关的策略定位成员：

1. **Kotlin `@Metadata` 的原始属性名 + 声明顺序**（R8 默认保留 metadata，字段表顺序与 metadata
   顺序一致）—— 例如 `PlaybackQueueState` 的 metadata 仍含
   `mode / normalQueue / normalIndex / randomQueue / randomIndex`；
2. metadata 被剥掉时退回**返回类型 / 元数形状**匹配（state 对象恰好声明一个 mode getter、
   一组 normal 的 list/int、一组 random 的 list/int）。

改这里之前先读 `HostMemberResolver.kt` 的类注释 —— 那里有完整的推导过程与实测证据。

### 2.1 反射目标（结构角色）

| 角色 | 说明 |
|---|---|
| `PlaybackController` | 宿主播放器门面；static `INSTANCE`；`getPlaybackQueueState()`、`playOrPause()`、`previous()`、`next()`、`seekTo(long)`、`changePlaybackMode(Mode)`、`playMusicAt(int, boolean)` |
| `StateFlow` | `getPlaybackQueueState()` 的返回类型；`getValue()` 名字**未**被混淆，可直接用 |
| `PlaybackQueueState` | 队列状态对象：`mode` + `normalQueue/normalIndex` + `randomQueue/randomIndex` |
| `PlaybackQueue$Mode` | 枚举，`values()` 顺序 = `[Circle, CircleEnd, RepeatOne, Random]`（ordinal 0..3）；**枚举名可读，`valueOf` 可用** |
| QueueItem | `com.xuncorp.spc.core.queue` 下的单字符顶层类（原始名 `PlaybackQueueItem`，在 `@Metadata` 里）；取 id 与 `data` |
| `PiscesMediaItem` | `id` / `title` / `artist` / `album` / `albumArtist` / `path` |

源码里残留的 `\u037F`（getter）、`\u0528…\u052B`（四个队列访问器）**只是最后兜底**，写在常量池
注释里作为「元数据与形状都失败时」的退路。

### 2.2 注意事项（改这里前必读）

1. **加载器**：首选 `Class.forName(name, false, WorkshopApi::class.java.classLoader)`；失败再依次
   退回 `Thread.currentThread().contextClassLoader`、插件自身 classloader。首次解析记录实际生效的
   loader 与失败原因到插件日志。
2. **不要独立 JVM 探测**：`PlaybackController.<clinit>` 会构造 `PlaybackService` 并初始化 BASS
   原生库（独立 JVM 里表现为 `IllegalArgumentException: Invalid library name ""`）。
3. 反射失败必须**吞掉并记日志**（首次含异常类型/消息，之后限流），绝不能让宿主桥线程或插件加载
   失败。
4. `Method`/`Field` 句柄一次性解析并缓存（`@Volatile` + 双检）；`getValue()` **每次实时读**，
   不回放缓存。
5. 队列元素是包装类：先取 id 与 `data`，再把 `data` 当 `PiscesMediaItem` 取字段。
6. 反射枚举一律走 `Enum.name` / `values()`，绝不按字段名取值。

> 历史提醒（只作为「为什么现在这样做」的背景）：早期版本把五个原始混淆标识符写死，正是 Steam
> workshop「插件开发建议」帖警告的失效模式；`HostMemberResolver` 就是为消除它而引入的。

## 3. 各层契约

### 3.1 插件（Kotlin）

`FoliaPlaybackControls.kt`（`internal object`）：

- `handleControl(line: String)`：入参是宿主 stdout 的整行 `{"t":"control",...}`，按 `action` 分派：
  - `toggle` → `playOrPause()`
  - `previous` / `next` → 对应方法
  - `seek` → `seekTo(max(0, positionMs))`
  - `shuffle` → 当前 mode 名：`Random` → `changePlaybackMode(记住的非随机模式)`；否则先记住当前
    模式再 `changePlaybackMode(Random)`。记住值默认 `Circle`，**仅保存在插件内存**
  - `queue-play` → `playMusicAt(index, random)`（`index<0` 忽略；`random` 缺省 false）
  - 未知 action：忽略并记日志（前向兼容）
- `queueJson(): String?`：读
  `getPlaybackQueueState().getValue()` 生成
  `{"mode":"circle|circle-end|repeat-one|random","random":bool,"index":int,"items":[{id,title,artist,album}]}`。
  `random = modeName == "Random"`；列表取 `randomQueue/randomIndex` 或 `normalQueue/normalIndex`；
  字段用 `Json` 转义。**反射不可用时返回 `null`**。
- 控制成功后置 `queueDirty = true`，让 pump 立即重发快照（例如 shuffle 切换后的激活态、切歌后的
  高亮）。

`FoliaHostBridge.kt`：

- providers 里有 `@Volatile var queueProvider: (() -> String?)? = null`（与 snapshot / lyrics /
  track provider 同处；`onClosed` / disable 时清空）。
- `replaySnapshot()` 在 `ready` 时发送一次 `queue`。
- state pump 每 5 tick（500ms）调用 `queueProvider`，与 `AtomicReference` 缓存比较，变化才发送；
  `queueDirty` 时下一 tick 强制发送。
- `handleHostLine` 的 `"control"` 分支 → `FoliaPlaybackControls.handleControl(line)`；异常只记日志。
- `queueJson()` 返回 `null` → **不发送**，页面保留上一份快照（不是清空）。
- 首帧/回放顺序：`sendState` → `sendTrack` → `queue`（页面侧允许任意顺序）。

### 3.2 宿主（C#，`poc/webview/host`）

`HostForm.cs`：

- `OnWebMessageReceived`（页面→宿主）的 `type == "control"` 分支：
  - 白名单 `action ∈ {toggle, previous, next, seek, shuffle, queue-play}`；非法 action 丢弃并记
    `control-drop` warn。
  - 组装并 `log.WriteLine`（即写插件 stdin，**不要**用 `Console.Out` 另开通道）：
    `{"t":"control","action":"<a>"[, "positionMs":<num>][, "index":<num>][, "random":true|false]}`
    - `positionMs`/`index` 用 `JsonUtil.Num` 输出；负数夹到 0；`random` 用 `JsonUtil.GetBool`。
- `HandleStdinLine`（插件→宿主）的 `t == "queue"` 分支 → `SendQueueToPage(msg, line)`：
  - payload：`{"type":"queue","mode":"...","random":true|false,"index":N,"items":<原样数组>}`
  - `items` 用 `JsonUtil.ExtractRawValue(line, "items")` 原样搬运；`mode` 白名单校验
    （非法按 `circle` 处理）。
  - 缓存 `lastQueuePayload`；`OnNavigationCompleted` 回放（紧邻 lyrics/track 回放），并在
    `type == "bridgeReady"` 处理里再回放一次（设置岛晚挂载时补发）。
- `PostToPage` 已线程安全，不必额外 marshal。

`Shim.js`：

- host→page 的 `switch` 增加 `case 'queue': inputs.queue = msg; emitLocal('queue', msg); break;`
- `emit()` 增加 `else if (type === 'control') post(Object.assign({type:'control'}, payload || {}))`
  （**平铺字段**，不要嵌套 `payload`）。同一类「动作消息」的信封形状要统一。
- 不改动其它消息路径；`__SPW_FOLIA__` 版本仍是 `protocol: 1`。

### 3.3 设置岛（React/TS，`poc/settings-ui`）

`src/bridge.ts`：

- `BridgeEventType` 含 `'queue'`；导出
  `PlaybackQueueSnapshot { mode: 'circle'|'circle-end'|'repeat-one'|'random'; random: boolean;
  index: number; items: QueueItem[] }`、`QueueItem { id; title; artist; album? }`。
- 导出 `sendPlaybackControl(action, extra?)` → `getBridge().emit('control', { action, ...extra })`。
- fake bridge（`dev.html`）：维护 demo 队列，初始派发 `queue`；`emit('control', …)` 记录到
  `window.__SPW_FOLIA_TEST_CONTROLS__` 并模拟语义后回发新的 `queue` / `state`，让 UI 有真实反馈。

`src/chrome/playback/PlaybackBar.tsx`：

- 所有按钮可点击、可键盘聚焦（`type="button"`，保留 `aria-label`）。
  - 播放/暂停：`sendPlaybackControl('toggle')`，图标按 `meta.playing`。
  - 上一首/下一首：`previous` / `next`。
  - 随机播放：`sendPlaybackControl('shuffle')`；`data-active={queue?.mode==='random'}`，激活时高亮
    （`.spw-playback-icon[data-active='true']`），title 动态「随机播放：开/关」。
  - 播放列表：切换 `PlaybackQueuePanel` 开合；`aria-expanded`。
  - 进度条：pointerdown/move/up（以及点击）计算比例 → `sendPlaybackControl('seek', {positionMs})`；
    拖动中本地预览填充，不等回流；拖动时 `stopPropagation`，避免误触展开/收起。
- 订阅 `bridgeOn<PlaybackQueueSnapshot>('queue')`（初值读 `getBridge().inputs?.queue` 兼容晚挂载）。
- 设置覆盖层打开或鼠标穿透时组件**不渲染**。

`src/chrome/playback/PlaybackQueuePanel.tsx`（DOM 选择器契约，集成验收脚本依赖）：

- 面板根节点 class `spw-queue-panel`；每个可点击行 `data-queue-index="<items 下标>"`；
  当前项行 `data-current="true"` 高亮。
- 标题「播放列表」+ 曲目数；列表项显示序号/标题/歌手；当前项 `scrollIntoView({block:'center'})`；
  点击项 → `sendPlaybackControl('queue-play', { index, random })`。
- 打开时 capture 阶段监听 Escape 关闭面板并 `stopPropagation()`（不关设置覆盖层/窗口）；
  点击面板外关闭；关闭后焦点回到列表按钮。
- 样式写 `app.css` 播放条附近：深色半透明 + 模糊、圆角、最大高度 46vh、内部滚动、hover/current
  高亮、宽度 420px 居中、位于栏上方；`data-flat` 下沿用扁平视觉。

`src/chrome/PlaybackClickZones.tsx`（画面点击分区）：左 1/3 上一首、中 1/3 播放/暂停、右 1/3
下一首。**v0.4.18 起它是幽灵层**：`pointer-events` 全为 `none`，画布重新拿到 `pointerdown`
（「町景」的 OrbitControls 拖动旋转 / 滚轮缩放 / 右键平移、monet 的歌词轨滚轮因此恢复），手势判定
改在 `window` 的 capture 阶段做。四条规则保证它不抢真实控件的点击：从交互控件上按下就放弃这次手势
（标签/ARIA role/本岛 `data-spw-chrome` 等等，**外加祖先链上 `cursor` 是 `pointer|grab|move|*-resize`
之类的「我要指针」语义** —— 上游有些控件只是裸 `div.cursor-pointer`，monet 的挂绳就是；
那个判定是这条规则的一半，删了挂绳单击会连带暂停）；覆盖层 / 穿透 / 打开的菜单与面板时整层失效
（`data-enabled="false"`）；位移 > `DRAG_SLOP_PX`(10px)、手势取消、Alt 拖动不算点击；对 zone
子元素的合成 `pointerdown`+window `pointerup` 与纯 `el.click()` 仍各触发一次。
详见 [`docs/protocol.md`](protocol.md) §8 与文件头注释。

## 4. DOM 选择器契约（验收脚本依赖）

| 元素 | 选择器 |
|---|---|
| 播放条按钮 | `.spw-playback-play` / `.spw-playback-step` / `.spw-playback-icon` |
| 随机按钮 | `aria-label="随机播放"` |
| 列表按钮 | `aria-label="播放列表"` |
| seek 区域 | `.spw-playback-bar .spw-playback-track`，须同时响应 `pointerdown+pointerup` 与 `click` |
| 队列面板 | `.spw-queue-panel` / `[data-queue-index]` / `[data-current="true"]` |
| 点击分区 | `[data-spw-click-zone]`（`data-enabled="true\|false"`，`pointer-events:none`）+ `[data-zone="prev"\|"toggle"\|"next"]`（仍在 DOM，仍是合成输入入口，但不再是命中目标） |
| 测试记录 | `window.__SPW_FOLIA_TEST_CONTROLS__` |

改这些选择器会让 `verify-click-zones.mjs` FAIL —— 它是门禁，不是建议。

## 5. 验收

| 脚本 | 覆盖 |
|---|---|
| `packaging/tools/verify-click-zones.mjs` | 点击分区 / 幽灵层：DOM 契约、三等分命中、拖动不发指令、控件不被抢、覆盖层失效、画布收得到指针（也覆盖 control/queue 往返的既有断言） |

`verify-all.mjs` 一条命令跑完（4 个套件并发，约 45 s）。

> **v0.4.18 的门禁精简**（按用户要求「早已稳定区域的门禁自动删除」）：
> `verify-playback-controls.mjs`、`verify-playback-switches.mjs`、`verify-mouse-back.mjs`、
> `verify-json-singleline.mjs`、`verify-playback-bar-switch.mjs`、`verify-problem-button-switch.mjs`、
> `verify-live-settings-payload.mjs`、`verify-log-folder.mjs` 均已删除。
> 最后这个 `verify-log-folder.mjs` 每次运行都会真的拉起一个 `explorer.exe` **打开文件夹窗口**，
> 且是整套门禁里最慢的一项（46 s）——它守的落点修复自 v0.4.17 起没再动过。
> 需要回看时从 Git 历史取回：`git show v0.4.18:packaging/tools/<name>`。
