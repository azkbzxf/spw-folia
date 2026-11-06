# 开发与维护须知

这份文档是**给下一个改这个仓库的人**的：什么时候必须做某件事、什么时候绝对不能做某件事、
哪里埋着不能想当然的陷阱。它不是开发日志，也不记录某个版本怎么一步步做出来 ——
那些属于 Git 历史与 GitHub Releases。

按「你在做什么」查：改宿主 hook → §2；改协议/设置树 → §3；改透明或输入路由 → §4；
改构建打包 → §5；改诊断自检 → §6；准备发版 → §7。§1 是所有改动都适用的方法论。

---

## 1. 通用方法论

1. **先证伪，再下结论。** 任何「这看起来像 bug」的判断，先设计一个能证伪它的对照实验。
   反例是真实发生过的：`dpr=1` 看着像画面被拉伸模糊，做了逐像素梯度能量对照
   （3.183 vs 3.049）之后才确认那是 WebView2 用 `RasterizationScale` 在合成层缩放时的正常表现，
   根本没有缺陷。**没有对照实验就不许下结论。**
2. **混淆名只在真实字节码上认。** `javap -v -p` 是唯一权威；文档、旧记忆、设计稿都不能当证据。
   凡是从 descriptor / internal name 派生的类名，一律过「剥壳（`L…;`）→ 点分化」两个**显式**步骤，
   并在校验里断言「类名里不含 `/`、不以 `L` 开头、不以 `;` 结尾」。
3. **「读不到」≠「缺失」。** 所有检查/诊断/健康度判定一律四态（`PASS/FAIL/UNKNOWN/ADVISORY`），
   并且**只有证据能产生 FAIL**。任何「读不到时算失败吗？」回答「算」的判定就是 bug。
4. **长生命周期对象 + 短生命周期线程 = 必须按会话隔离。** 队列、writer、exit watcher 全部带身份，
   `cleanup(reason, expected)` 在锁内先判身份，身份不符就零状态触碰地返回。
5. **改输入路由必须同时设计「怎么回来」。** 透明/穿透/全屏这类会限制输入的 UI 状态，必须常驻
   「热键 + 可见控件」双通道恢复，否则每一版都要补逃生通道。
6. **落地证据优先于文字汇报。** 验收要 `ls` / `wc -l` / `git status` / 逐文件 hash；
   不要只看自己或子代理的「已完成」。这不是防别人，是防自己。
7. **数字必须带单位与口径。** 42,147 class（总类数）与 17,661（带 SMAP 源名映射的类）不是一回事；
   28058 是 method body；暂存目录 26.19 MB 与用户下载的 zip 11.93 MB 差一倍。写混一定得出错误结论。
8. **验证分级要写进文档第一句。** 离线 / 真机 / 用户验收三级不许混；没做真机的必须明说，
   不许写「用户已确认」。
9. **上游只读。** `work/folia/**` 与 `poc/webview/dist/dist` 是只读产物，定制逻辑集中在注入的
   Shim / Overlay 与 `poc/settings-ui`；扩展上游类型用「自有类型扩宽 + `as never`」，不改上游。

---

## 2. 宿主反射与 Hook

### 2.1 反射目标

- 所有反射目标类名/方法名必须**先在真实字节码上 `javap` 验证**，禁止从设计文档或旧记忆抄。
  `Class.forName("…PlaybackQueueItem")` 编译毫无问题（只是字符串），运行时必
  `ClassNotFoundException` → 永久 unavailable → **整个通道在真实宿主里全灭**。
- **加载器顺序**：`Class.forName(name, false, WorkshopApi::class.java.classLoader)` →
  `Thread.currentThread().contextClassLoader` → 插件自身 classloader。`false` = 禁止初始化。
  首次解析时把实际生效的 loader 与失败原因写进日志。
- **不要在独立 JVM 里跑反射探针。** 宿主类依赖原生库（BASS），`PlaybackController.<clinit>`
  会构造 `PlaybackService`，独立 JVM 里表现为 `IllegalArgumentException: Invalid library name ""`。
  只能在 SPW 进程内调用；离线验证要么挂真实宿主 jar 写 Java harness，要么只做静态字节码核对。
- **失败语义**：`CNFE` / `NoClassDefFoundError` / `ExceptionInInitializerError` → 永久 unavailable；
  其余每 5 s 重试；失败日志前 3 次全文、之后每 100 次限流；**绝不抛出到桥线程**。
- `Method`/`Field` 句柄一次性解析并缓存（`@Volatile` + 双检）；**状态值每次实时读，不回放缓存**。
- **反射枚举一律走 `Enum.name` / `values()`**，绝不按字段名取值（静态字段名会被混淆成
  `Ϳ/Ԩ/ԩ/Ԫ`，`javap` 里显示成 `?`）。
- **缓存 key 必须是「解析结果本身」，不能是 `by lazy` 的一次性初始化。** 典型故障：调色板要等
  ~1.4 s 后台解析完才有值，`by lazy` 在未知版本下必然先把 `null` 永久缓存住，注入项颜色永远是
  兜底常量。正确做法是按 `HostTargets.palette` 的**实例**失效。

### 2.2 字节码解析

- **jar 的 zip 条目名不可信。** 一律按解析出的 `this_class` 识别类；审计时逐条比对 entry name 与
  `this_class`。
- 自写 class-file 解析器只用于批量扫描，**必须与 `javap` 对同一类输出逐字节一致**；
  权威交叉验证一律走 `javap`。已知坑：常量池计数在 byte 8 不在 byte 6。
- 从 polyglot jar 导出 class 统一用 **UTF-8** 并记录导出参数，否则偏移/字符串比对全部失真。
- 用 `code source` 锚点时**不要碰业务数据类**（`Track` 会触发 native 库初始化并失败），
  换一个纯 UI 类。
- `java.class.path` 可能只有一个条目（宿主 jar 本身）；优先用宿主类自己的 `codeSource`，
  读不到时才退回 `java.class.path`。
- **hook 取参下标来自发现结果，不写死。** 先确认目标是 static 还是实例方法再决定偏移
  （`addItemsMethod` 被规则强制为 static，所以 `args` 与参数 1:1、不减 1），并且用前对
  `args.size` 做越界检查。
- **hook 前必须确认返回类型**，不能假设。实例：`snapshot()` 声明
  `public final java.util.List<MenuOp>`，实现是 `ops.toList()`，**不是** `SnapshotStateList`。
- **库类也能 hook，但有精确边界**：registrar 只拒绝 `pf4j.PluginClassLoader` 加载的类，
  以及前缀 `com.xuncorp.voxzen.workshop.hooks.WorkshopHook` / `com.xuncorp.spw.workshop.api.hook.`。
  插件 jar 里的类被拒；**app jar 里的类**（宿主本体 + 打包进来的库如 compose-native-tray）可以。
- **`WPARAM/LPARAM` 一律 `unchecked((int)x.ToInt64())`**，不用 `ToInt32()`。x64 上
  `IntPtr.ToInt32()` 是**带溢出检查**的窄化转换，零扩展的 `WM_MOUSEWHEEL` 下滚（bit31 置位）
  必抛 `OverflowException`。
- **Compose 侧「改数据」≠「UI 会刷新」。** 托盘菜单这类记录式结构依赖 `remember`，
  插件晚加载时 Compose 会跳过重组；必须有确定性的原生补丁（每次构建都补行，或对已存在的
  manager 强制 update 一次），不能依赖重组时机。

### 2.3 结构发现的纪律

- **候选必须唯一，不唯一就报错。** 每一步都是 `unique(...)`：候选数 != 1 就抛
  `IllegalStateException`（带角色名 + 候选数量），绝不 best-effort 挑一个。
  理由是后果不对称：在宿主里调错方法会**静默污染弹层**，而抛错只是「这一版没有 Folia 项 +
  一条可读日志」，且异常被捕获后退回下一层，不会让插件启动失败。
- **参考实现的结构规则必须在自己的目标版本上重跑候选计数。** SPW-Lyrics 原版的 builder 规则
  在 1.19.3 上给出 15 个候选 —— 照抄必失败。
- **性能红线写进文档，评审按这条卡**：约 1.3–1.5 s 的字节码索引绝不允许进 `start()` 同步路径，
  只在后台线程跑，结果缓存，同一版本之后零成本。
- **两条硬边界**：结构发现能适应**重命名**；**不能**适应**页面结构重构**。后者需要重新适配，
  不是自动就能活的。
- `candidateCounts` 的键名固定；palette 降级时值是 0（不是缺失），未走到的角色不会出现在 map 里
  → **禁用 `getValue`**，用 `getOrDefault` / `?.`。
- **自研 JSON 取值器一律假定「扁平、首个匹配」。** 所以缓存键名必须全局唯一：调色板缓存键叫
  `paletteTarget` 而不是 `palette`（后者会读到 `candidateCounts.palette` 的数字）。
- 缓存命中仍要过校验。缓存可能来自另一个宿主版本或一个有 bug 的发行版，不校验就等于信任磁盘上的
  字符串。
- **宿主发版要审计全部反射目标，别只盯菜单。** 1.19.3 那次菜单三个类全改名，其余目标全部 unchanged ——
  但这是审计出来的结论，不是猜的。

### 2.4 写混淆名

- 单字符码点一律用 `\uXXXX` 转义字面量写进源码，不要用肉眼粘贴的字符（编辑器与编码会破坏它们）。
- **不要在含 `\uXXXX` / 反斜杠转义的源码上用 `sed -i`**（`sed` 会吃掉反斜杠），改完用脚本统计
  反斜杠数量确认。
- 混淆名（尤其含非 ASCII 码点的）不要走命令行参数，写进文件或代码里。

---

## 3. 协议与设置树

- **协议只允许追加**：新消息写进 [`docs/protocol.md`](protocol.md)，不破坏既有字段；
  「动作类」消息统一用**扁平信封**（与 `control` 一致，不套 `payload`）。
- **一条消息必须严格占一行。** 插件与宿主都是行导向的（`write(line+"\n")` / `ReadLine()`），
  而 `settings`/`lyrics`/`track` 是**原样内嵌**的字符串拼接。子 JSON 里任何一个 `\n` 都会把一条
  消息拆成多条、全部解析失败并被丢弃。对外部来源的 JSON 发送前必须过 `Json.singleLine()`。
  这个坑曾经让三个配置开关同时失效，且没有任何报错。
- **`state` 是 RAW 形状**（`{posMs,durationMs,playing,rate,tsMs,lyricOffsetMs}`）；**只有 `clock`**
  是秒制且节流 ≥250 ms。注入 UI 按 `tsMs + rate` 自行插值。消费 bridge 事件前先读 `Shim.js`
  源码确认形状，不要按事件名猜单位。
- **插件的 `settings` 必须发两次**：打开窗口时一次，收到 `ready` 后再一次。宿主在 WebView2 就绪前
  把 `settings` 直接丢弃，首次推送必然落在窗口外。
- **`control` 白名单外的 action 丢弃 + 记 warn**（前向兼容）；`positionMs`/`index` 负数夹 0；
  `random` 缺省 false；`queue.mode` 非法按 `circle` 处理；`items` 原样透传（缺失 → `[]`）。
- **宿主只搬运，不做本地播放语义处理。** 宿主→插件通道复用现有 `log.WriteLine`（插件 stdin），
  不另开 `Console` 通道 —— 现有通道已验证，新开通道等于新增故障面。
- **`hitbox.rects` 数量是动态的**，宿主不得写死；`rects=0` 是 **fail-open = 整窗可点**
  （所以「穿透失效」的表现其实是「整窗吃鼠标」）。热区上报必须挂 `transitionend` +
  `ResizeObserver`，且 settle 时间大于最长 transition。

### 3.1 配置页开关

- **不要依赖宿主的 `ConfigManager` 变更回调。** 真机实测三处都不可靠：回调不一定来、
  `getConfig()` 返回缓存（值还是改之前的）、一次编辑触发多次回调。正确做法是把**磁盘文件**当
  唯一事实来源：先 `reload()` 强制重读，再读值，只有真变了才推送；触发用「宿主回调（快路径）
  + 低频守护线程（兜底）」两条。
- **开关换组 = 换存储文件。** `ConfigManager.getConfig(name)` 按 config 文件名分别存取，把某个
  开关从一组移到另一组，对用户只是换了个位置，对存储却是换了文件。直接 `get(key, default)`
  会拿到默认值 —— 用户明明开着，升级后静默变回关闭。必须做**旧值回退 + 一次性迁移**：
  新文件有就为准；没有就回退读旧文件；真读到旧值就**立刻写进新文件**并落盘。
  （只回退不迁移的话，两处都能改值就永远说不清谁是真源。）
- **「键是否存在」不能用 `get(key, default)` 判定**，它区分不出「不存在」和「存在且等于默认值」。
  用一个不可能与真实键冲突的 String 哨兵做类型探测。
- **SPW `ConfigHelper.get()` 在键不存在**或**值类型不匹配时都返回 defaultValue**。
  读数值一律按「double 优先 + 多类型哨兵」读，并把探测结果打进日志
  （`probe(double=300.0,int=-1,long=-1)`）。曾经的故障：seekbar 存的是 `2000.0`（浮点），
  插件用 `get(key, 800)`（Int）读 → 永远判「不存在」→ 静默回落 800 ms。
- **页面拥有的开关不能有第二个写者。** 插件注入的布尔成员（`systemFonts`、`verboseLog`、
  `previewAnimation`、`showProblemButton` 等）在 `onSettingsFromPage` 落盘前必须**统一剥离**，
  否则就是双写方 + 启动竞态覆盖。新增同类开关照这条走：插件读 config → 塞进设置树顶层 →
  页面读 `getSettings()` + 监听 `settings` 事件。
- **改配置页后跑 `packaging/tools/verify-all.mjs`** 的静态契约 4 项：三处版本戳一致、
  声明的开关都有读取方（且读取方没有多余键）、每组指向独立 config 文件、被移动的开关仍保留
  迁移路径。

### 3.2 给用户可调项之前

先量「可感知窗口」。反例：过渡动画的时长设置在 WebView2 冷启动（1.5–2 s）之下，
300 ms 与 2000 ms 的差异**不可感知**，于是那个设置被删掉而不是留着。给一个假开关比不给更糟。

---

## 4. 透明、穿透与输入

- **色键透明窗口 = 天然鼠标穿透**，页面控件全点不到。所以任何透明状态都必须有常驻逃生热键
  （`Ctrl+Alt+B` 恢复不透明），并把页面开关同步回「关」+ 持久化。
- **鼠标穿透用 OS 命中测试层，不做合成输入。** 捕获窗 `SetWindowRgn` = 页面热区并集
  （±4 CSS px 容差），区域外原生穿透。**禁止**再用 `mouse_event` 回放 / 220 ms 恢复捕获窗 /
  逐点命中 —— 合成输入只回放左键（右键/滚轮/悬停被吞）、拖拽必断、会被提权窗口与反作弊拦截。
- **fail-open**：热区数据缺失时宁可整窗可点，也不吞用户点击。
- **拖拽连续性**：按住键期间区域临时整窗，并用 `GetAsyncKeyState` 自愈丢失的抬起事件。
- **透明窗口不要用 WinForms `TransparencyKey`**，它会闪一帧洋红（设置色键会重建窗口句柄）。
  直接用 `SetLayeredWindowAttributes` / 分层窗口 API，并在设置背景色**之前**装好色键。
- **多窗口 TopMost 叠层必须显式抬升**（`SetWindowPos(HWND_TOPMOST)` 在 `OnHandleCreated` /
  `OnShown` / `OnActivated` 三处），不能靠创建顺序。
- **色键方案下不要指望半透明**：目标是把大面积半透明底板**去掉**，不是调淡。
- **透明兼容必须逐样式枚举键**：`STYLE_COMPAT` 是 `Record<StyleMode, …>`（新增样式不写就编译
  失败）；透明开关不止 `showBlocks`，要按「不读该开关的图层」逐个覆盖。
- **不可适配就自动关闭该功能**，用户偏好是「功能降级而非勉强适配」。当前：`monet` 不可适配；
  `lumiere` 在浅色主题下不可适配（深色可）；`tempera` 需 `showBlocks:false` +
  `postProcessVignette:0`；`still` 需隐藏 `[class*="bg-[radial-gradient"]` 暗角；
  `pendolo` 需 `showCenterGradient:false`。
- **遇到「怎么调都不变」先怀疑代码里的 clamp / 地板，而不是参数没生效。** 实例：dist 里
  `createLumierePixiRuntime` 按主题背景亮度 `> 0.18` 判定，浅色 `#e8e4dc`（亮度 0.8952）把 alpha
  clamp 到下限 0.94，`darkField` 参数被整个吃掉。
- **透明度度量要带强度分带，不要只报覆盖率。** `cov8`（alpha ≥8）把 1–32 的淡雾也算进去，
  而色键能吃 1–32、只有 >64 才是肉眼实体；只报覆盖率会让结论反过来。
- **headless 覆盖率只能当必要条件**，样式底板类问题必须真机复验。
- **粒子/文字样式验证必须显式注入歌词**，别信「画面是空的 = 样式问题」。

### 4.1 注入页与上游浮层的叠放次序（issue #21）

- **注入岛是一个层叠上下文，上游的浮层是它的 `body` 兄弟节点。** `#spw-settings-ui-root` 用
  `position:fixed; inset:0; z-index:<一个数>` 把自己变成一个层叠上下文，而 Folia 把
  `CustomSelect` 选项菜单与 `Sheet`（`z-[200]`）、kit `Tooltip`（`z-[210]`）、
  `PonderStage`（`z-[220]`）、调试窗（`z-[300]`）全部 `createPortal(..., document.body)`。
  **兄弟节点之间只有 z-index 大者胜**，所以岛只要高于 200，这些浮层就全部被压在设置窗口**背后**
  —— 它们渲染了、在 DOM 里、`aria-expanded` 也翻了，就是**一个像素都点不到**。
- **所以岛的 z-index 必须低于上游最大浮层（现在是 200），当前取 100。** 100 这个数是从测量来的：
  Folia 自己页面内容的层叠上限是 `z-20`（画布是 `z:-1`），100 仍然盖得住画面，而 200/205/210/220/300
  全部浮到岛上面。**不要「保险起见调大」**——任何高于 200 的取值会静默废掉设置页里每一个下拉。
- **症状会伪装成「下拉点了没反应」，而不是「看不见」。** 菜单其实开了，只是画在窗口下面；
  `elementFromPoint` 在菜单中心返回的是**后面那一行**的 combobox。判断这类问题一律用
  `elementFromPoint`，不要看 `querySelector('[role=listbox]')` 存不存在 —— 它一直存在。
- **`app.css` 里 214748xxxx 那组数字是岛内部的次序**（chrome 按钮 / 播放条 / 点击分区 / 问题面板），
  它们相对彼此保持不变，岛整体降下来不影响它们。
- **压缩菜单（`compact`）会在页面滚动时自动收起**，自动化探针必须先 `scrollIntoView` 并等滚动
  停稳，再点开菜单；顺序反了会「打开即关闭」，误判成 bug。

### 4.2 插件的 UI 副作用必须等宿主界面就绪（v0.5.0）

- **插件 `start()` 比 SPW 主界面早约 0.7 s。** 真机日志：插件 `22:43:53.099` 启动、
  `22:43:53.803` 调 `WorkshopApi.ui.toast`，而 SPW 自己的 `App start` 到 `22:43:54.236` 才写出。
- **界面未就绪时 `WorkshopApi.ui.toast` 是静默丢弃：不抛异常、不排队、不补发。**
  「调用没报错」因此**不能**作为「用户已经看到」的证据 —— 这是本仓库第一次遇到「日志写成功、
  用户却什么都没看到」的类型。
- **正确做法**：起 daemon 线程轮询 `java.awt.Window.getWindows()`，等到出现第一个
  `isDisplayable && isShowing` 的窗口，再 `SwingUtilities.invokeLater` 执行 UI 副作用；
  必须带超时上限，超时就**不执行**（而不是在错误时机执行）。
- **一次性提示特别危险**：若在副作用确认之前就写下「已完成」标记，一次静默丢弃就把该提示
  **永久作废**，且单测与发布门禁都发现不了（它们只驱动打包页面，不驱动插件启动时序）。
  顺序永远是「先确认副作用真的发生，再落标记」；宁可在失败时下次重试。
- 代码位置：`FoliaPlugin.awaitUiThenShowNotice`（`NOTICE_UI_WAIT_MS` / `NOTICE_UI_POLL_MS`），
  真机复验日志 `update notice: UI ready after 2182ms / 2246ms`。


---

## 5. 构建与打包

### 5.1 顺序就是正确性

改宿主后核对**四处同源大小**：`poc/webview/host/build/*.exe`、`packaging/native/*.exe`、
`spw-folia/build/plugin-root/host/*.exe`、安装目录 `native/`。大小不一致就是流水线顺序问题。
`packaging/native` 与 `packaging/licenses` 都是**生成目录**，只改真源
（`packaging/licenses-src/`），改完 `cmp` 验字节。

**先刷新 `packaging/native`，再构建插件** —— 反了就会把旧宿主装进去（本地安装的宿主大小会在几个
历史值之间反复横跳，就是这个循环）。

**同名源文件有副本时，先确认编译的是哪一份。** `poc/audio/native/*.cs` 在构建期被拷进
`poc/webview/host/audio/` 参与编译，两份可能已经不同步：当前宿主的 `SpectrumAnalyzer.cs` 节拍检测
仍是 120 ms 不应期、没有上升沿判据，而 `poc/audio/native/` 那份已是 180 ms + `BeatRiseMin`
（后果是**发货的是旧算法**，`beatImpact` 还恒为 0 所以暂时看不出来）。改这类文件要么两处一起改，
要么先确认构建脚本的拷贝方向，否则改的是不发货的那份。

### 5.2 本地安装与发布包走同一条 staging

**绝不直接拷上游 dist。** 裸 dist 会带 PWA 的 `sw.js`，它的 `NavigationRoute` 会把
`/preview.html` 重新导回 `index.html`，预览永远停在「正在连接 Folia」；裸 dist 里也没有生成的
`preview.html` / `_host/preview-shim.js`。本地安装也走 `spw-folia/build.gradle.kts` 的
`stageDevWeb`（内部调 `packaging/tools/stage-web.mjs`）。

### 5.3 兼容性发布必须走 splice

**判断标准 = 本次是否只改 `classes/`。** 是就走 `splice-compat-release.py`：以已发布产物为基线，
逐字节保留 `web/native/licenses`（逐一断言非 classes 条目 CRC 全同），只替换 `classes/`，
先核对基线 `sha256 == GitHub asset digest`，最后 `verify-layout.mjs` 全 true 并下载回验 sha256。
**禁止**用 `assemble-release.py`：仓库 staging 可能比已发布版本旧，会**静默回退** web/helper
（实测少 18,714 B，而且没有任何报错）。

### 5.4 体积预算绑在用户下载的那个文件上

两个门限各守各的：暂存目录膨胀是**警戒线**（只报告不中断），用户下载体积是**硬门限**
（超限 `exit 1`）。报告里必须写清口径（哪个目录、压缩与否），否则下一个人还会拿暂存量跟 zip 比。
数字对不上先看 `size-report.json` 的 `biggest`，别急着调大阈值。

### 5.5 其它必知

- **`build.sh` 会改写 tracked 的 `DefaultConfig.json` 的 `updatedAt`**，每次构建都产生脏 diff。
  构建后还原该文件，或提交前用 `git diff` 白名单过滤。
- **`csc.exe` 不是确定性编译器**：同一源码两次导出的 exe 有 51 字节差异（PE 时间戳 / MVID /
  PDB GUID，**长度相同、不含源码内容**）。装配本身是确定性的。所以「可复现」的口径是
  「装配 + 插件包 + 暂存树可复现，宿主 exe 不可复现」，release notes 要如实写明。
- **任何脚本里的版本号都从 `build.gradle.kts` / MANIFEST 读，不写字面量。**
- **`.spmod` 的 entry 数会随内容变化**，文档/断言不要写死。
- **上游产物不要改文件名/扩展名**，只能在 staging 阶段做「同哈希去重 + 引用改写 + 原位重压缩」。
- **上游 Folia 源码树必须有 `postcss.config.js` + `tailwind.config.js`**，缺了 `vite build` 仍然
  exit 0 但产物 CSS 只剩 ~29.6 KB、所有 Tailwind 工具类消失（预览子帧会塌成 270 px）。
  判断「预览框尺寸/布局不对」**先量产物 CSS**：
  `grep -c '@tailwind' packaging/web/assets/*.css`（期望 0）+
  `grep -o '.h-full{height:100%}' packaging/web/assets/*.css`（期望命中）。
  `stage-web.mjs` 已有硬闸兜底这种静默失败。

---

## 6. 诊断与自检

- **判定一律四态**：`Verdict = pass | fail | unknown | advisory`，字段名共用不许改。
  只有 `fail` 计入 `missing`，`unknown` 计入 `unverified`，`advisory` 只展示不影响结论。
- **只有证据能产生 FAIL**；拿不到证据只产生 UNKNOWN；UNKNOWN 绝不表述成缺失。
  这条规则的来源是一个真实事故：一条在任何机器上都不可能通过的检查被发了出去，用户每次点按钮都
  看到一句「你的系统太老，去升级」。
- **每个判定必须携带 `evidence`**（`Evidence(value, source, raw, error)` 四元组），并在 UI、日志、
  issue 正文三处都显示 —— 让判定可被反驳，而不是只能被相信。
- **Windows 构建号必须读注册表** `CurrentBuildNumber`（UBR 读 `UBR`），**绝不用
  `System.getProperty("os.version")`** —— HotSpot 在 Windows 上恒报 `"10.0"`（两段、没有构建号）。
  `[Environment]::OSVersion.Version.Revision` 也恒为 0，不是 UBR。
- **注册表值必须按 `REG_SZ` / `REG_DWORD` 类型标记解码**：`reg.exe` 的 DWORD 打 `0x82718`
  才是 hex；分隔符是恰好 4 个半角空格、无 TAB，行尾 CRLF。Python 正则里要写 `\\u` 不写 `\u`。
- **探测层零依赖、零抛异常、零写文件**：不 import SPW API，可独立跑；外部进程统一 3 s 超时 +
  `destroyForcibly()`；子进程 stderr 只用于防死锁，不参与判定。
- **软依赖一律 ADVISORY**：远端会话 / 音频采集 / 日志管道 / 无运行中的 Folia 窗口 ——
  永不进 `missing`，也不阻止打开反馈页。
- **自检入口签名是契约**：`preference_config.json` 的 `on_click` 指向
  `dev.spw.folia.FoliaPlugin.onReportProblem`（`@JvmStatic @JvmName`，无参）；重写只加参数，
  **不改名字**。
- **`isPermissionGranted` 之类的接口默认方法恒返回 false** —— 「宿主不支持查询」会被报成
  「缺少权限」。这类 API 的返回值要先确认语义。
- **C# 保持 C# 5 语法**：in-box `csc.exe` v4.0.319 不支持字符串插值、`?.`、`out var`。
- **「打开/选中文件夹」这类接口，`explorer.exe` 的开关和路径必须是两个独立参数**：
  `listOf("explorer.exe", "/select,", target.absolutePath)`。拼成一个字符串、或自己给路径加引号，
  都会重新造出「打开了错的位置 / 什么都没选中」的 bug。传文件 → 选中它所属目录里的它；
  传目录 → 选中其中的日志文件；路径缺失 → 报警告。日志里打 `selected=True/False` 便于复核。
- **测试必须用本机真实样本**，不构造理想值。要有一条专门断言钉死历史回归
  （例如 `os.version="10.0"` → UNKNOWN 且**不是** FAIL）。

---

## 7. 发布

- **发布门禁：用户说「发布」才动 GitHub。** 本地迭代 → 装本机给用户验收 → 用户说发布 →
  才 push + 打 tag + Release + 更新 README 中英。Workshop 上架默认**不做**。
- **三件资产 + 双校验**：`.spmod` + `.spmod.json` + `SHA256SUMS.txt`；发布后必须
  `gh release download` 回读复算 sha，与本地逐字节一致才算闭环。
- **哈希只能从「最终发布物」取**，不能从 `build/libs` 的中间产物取。
- **版本号散落多处，一次升级要改全**：`build.gradle.kts` 的 `version` + `PluginVersion` +
  `FoliaPlugin.PLUGIN_VERSION`（`verify-all.mjs` 的静态契约会断言三处一致）。
- **补丁版本一律 `X.Y.(Z+1)`**，不要造 `0.4.2a` 这种非法 semver。
- **发布前跑自检**：`./gradlew runDiagnostics` → exit 0 且健康机 `FAIL` 计数为 0（UNKNOWN 允许）；
  `node packaging/tools/verify-diagnostics.mjs` → exit 0。这一步查的是「自检本身有没有跟版本脱节」：
  自检错了不会编译失败，只会在用户机器上默默误报。任一条失败即**阻断发布**。
- **`verify-layout.mjs` 是发布门禁**：`pass=true` + `consoleErrors=0`，**真实宿主 + 真实 WebView2**，
  不用模拟。
- **文档搬动后必跑 `python packaging/tools/check-doc-links.py`**（扫全部 markdown 本地链接，
  失效即非零退出）。
- **改文档后看 `git diff` 是否「小而精准」**：常见的自造错误是段落顺序弄反、误删表格右侧一列、
  脚本重写引入 CRLF（仓库约定 LF + 末尾一个换行）。

---

## 8. 本机环境陷阱（Windows）

- **中文路径会让反射 / PE 解析 / 老工具链失败**（GBK 误解码下损坏）。一律先把文件复制到
  `%TEMP%\<ascii>\` 再加载。
- **终端 GBK 乱码不是文件坏了。** 做二进制校验（字节 / U+FFFD / BOM 三项）定案，不要看终端。
  Python 打印非 ASCII 混淆名要显式 UTF-8 输出或写文件。
- **`ln -s` 会降级成拷贝**，需要真符号链接时用 `pwsh New-Item -ItemType SymbolicLink`。
- **脚本文件名不要与 Python 标准库模块同名**（`struct` / `json` / `types` / `token` 都是高危）。
- **`tsc` 无输出 ≠ 通过。** 要确认它真的跑了；sanctioned gate 是 `vite build`。
  报告类型错误前先用 `git diff` 判定归属（既有错误基线是既有噪声，新增错误数才是判定标准）。
- **本机 `gh` 命令必须在仓库目录内执行。**
- **找同名文件用定向 glob，不要全盘 `find /`。**
- **要改的文件必须先 read**（哪怕已经用 grep/inspect 看过）；遇 `FS_STALE_VERSION` 重读后重放。
- **需要一个脱离 Gradle 跑的 Kotlin 验证**时，写 Java 等价 harness（本机没有可用的 kotlinc）。
- **动画 UI 的度量取多帧中位数**，不要用首帧（首帧常抓在 intro transition 上）。
- **截图前断言前台窗口标题/进程**；按时间轴确定性定位，不要随机采样。
- **自动化点击会改掉用户设置**：脚本跑前记录设置快照，跑完回滚。
- **大文件下载先试国内镜像**（官方源实测掉到 15 KB/s 量级）。
