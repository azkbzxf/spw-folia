# Hook 目标：往 SPW 菜单里插入 Folia 条目

两个相互独立的 hook，都在运行时解析：

| 菜单 | hook 位置 | 文件 |
|---|---|---|
| 迷你播放器 **更多** 弹层 | 宿主「往弹层里加条目」的辅助方法（`hookMethod`） | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` |
| 托盘（最小化图标）右键 | `compose-native-tray` 的 `RecordingComposableScope.snapshot()` | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaTrayMenu.kt` |

两个 hook 各有自己的 `HookHandle` 与失败路径，任一失效不影响另一个。下文先讲 更多 弹层，
托盘 hook 见 §4。

## 1. 为什么是 `hookMethod`，而不是 `appendContent`

`appendContent` 在这套 R8 混淆的宿主上**不可行**。它的引擎先解析目标调用点，然后要求传入的
`parameter` 是目标方法的**业务参数名**之一（`UiTarget.names`）。这些名字来自 JVM
`MethodParameters` 属性或 Kotlin `@Metadata`，而走 `@Metadata` 这一路时 metadata 里存的
**原始 JVM 方法签名必须与运行时方法名一致**。R8 把方法名全改成了 `Ϳ`(U+037F)，metadata 里却
仍是 `BlurPopupMenu` / `MenuFlyoutItemCompat` 这些原名，两边对不上 → `names` 全是空串 →
`indexOf("content") = -1` → 抛
`UI call missing or ambiguous: … (0 calls)`。宿主也不生成 `MethodParameters` 属性。
这是宿主对所有插件的限制，不是我们目标特有的。

**结论：对 SPW 的 hook 目标永远不要依赖 Kotlin 名字。** 可用的是
`hookMethod`（JVM 类名 + JVM 方法名 + 完整**业务**参数类型列表，不需要 Kotlin 名字也不需要
`@Metadata` 关联），或 `replaceComposable` / `afterComposable`（按 JVM 名 + 参数类型解析**调用点**，
不需要参数名）。

## 2. 解析层（按成本从低到高）

SPW 是 R8 混淆的，**每个版本都会重命名我们碰到的类和方法的混淆名** —— 1.19.2 把
`ē`/`ন`/`Ⴈ` 改成 `घ`/`Ը`/`ะ`，1.19.3 又改成 `ɦ`/`ל`/`त`。所以解析不能靠写死名字。

`HostTargets.kt` 在运行时按层解析，最便宜的层优先：

| # | 层 | 何时使用 | 成本 |
|---|---|---|---|
| 1 | `host-targets.json` 缓存（按 `spwVersion` 键控） | 该 build 首次成功之后的每次启动 | ~0 |
| 2 | 内置 profile（`PROFILES`：1.19.3 / 1.19.2 / 1.19.0） | 已知 build —— **回归基准 + 零成本快路径** | ~0（含校验 53–57 ms） |
| 3 | **结构发现**（`HostMenuDiscovery` + `HostBytecodeIndex`） | 未知 build —— **主路径**，只在后台线程 | 每个 build 索引一次约 1.3–1.5 s，之后走缓存 |
| 4 | 旧 classpath `scan()`（手写 class parser + 反射） | 结构发现失败时的第二意见 | 一次性 0.5–2 s |
| — | **反射护栏**（`validateMenu` / `validatePalette`） | **每一层**的结果在用之前 | ~0 |

`quickLoad()`（在 `start()` 内调用）只跑第 1–2 层，两者都不通过就返回 `false`，所以 `start()`
永远不会付字节码索引的代价。`deepResolve()`（后台 worker）跑第 3 层，失败退回第 4 层。

**每个结果用前都要过反射校验** —— 辅助方法签名（`hookMethod` 的确切参数列表）、scope bridge
（`MenuFlyoutScope.item(onClick, content)` 的静态 `(self, Function0, Function2)V` 形态）、
palette getter —— 过期的名字永不被信任。结构发现的结果还会**额外**与仍然有效的内置 profile 交叉
核对：已知 build 上两条路径必须完全一致，不一致记 `WARNING` 而不是悄悄取其一。

解析链必须绕开的两个宿主事实：

- **jar 的 zip 条目名不可信。** 有些条目存的名字与它包含的类不一致
  （`androidx/compose/ui/Ϡ.class` 里装的是 `…/ϡ`），所以候选一律按 class 文件里解析出来的
  `this_class` 识别，绝不按条目路径。索引层与旧扫描都遵守这条。
- **`java.class.path` 是一个 polyglot jar**（`app/ffmpeg-x64.dll`，111 MB，42147 个 class，
  可用 `ZipFile` 读）。结构发现优先读宿主类自己的 code source
  （`HostBytecodeIndex.read(hostClass)`），只有读不到时才退回 `java.class.path`。

### 2.1 内置 profile：回归基准，不再是适配机制

| build | 菜单 facade | 辅助方法 | MenuFlyoutScope（bridge） | PopupState（dismiss） |
|---|---|---|---|---|
| 1.19.0 | `androidx.compose.ui.ē` (U+0113) | `Ϳ` | `androidx.compose.ui.ন` (U+09A8) / `Ϳ` | `androidx.compose.ui.Ⴈ` (U+10A8) / `ԩ` |
| 1.19.2 | `androidx.compose.ui.घ` (U+0918) | `Ϳ` | `androidx.compose.ui.Ը` (U+0538) / `Ϳ` | `androidx.compose.ui.ะ` (U+0E30) / `ԩ` |
| 1.19.3 | `androidx.compose.ui.ɦ` (U+0266) | `Ϳ` | `androidx.compose.ui.त` (U+0924) / `Ϳ` | `androidx.compose.ui.ל` (U+05DC) / `ԩ` |

profile 现在的职责有三个：

- **回归基准** —— 已知 build 上结构发现必须逐字符复现它，不一致就记 warning，把「发现逻辑是不是
  退化了？」变成一个日志行，而不是一个 bug report；
- **零成本快路径** —— 已知 build 上 `quickLoad()` 完全不碰字节码（含校验 53–57 ms）；
- **不再是适配机制** —— 未知 build 不需要新行。加 profile 是可选的家务活（把某个 build 钉住以跳过
  它第一次索引），从来不是发版前提。

## 3. 结构发现

主路径：不读任何混淆名，改为**解析宿主自己的字节码、按结构约束逐个角色定位**。实现分两层：

| 文件 | 职责 |
|---|---|
| `HostBytecodeIndex.kt` | 只读索引：用 JDK 25 的 `java.lang.classfile` API 解析宿主 jar，建立「方法体 → 调用点 / 字段访问」的调用图。**从不加载或初始化宿主类**，只读字节。 |
| `HostMenuDiscovery.kt` | 在索引上跑发现链，输出 6 个必需角色 + 2 个可选角色，全部是点分二进制名。 |

设计来源是 SPW-Lyrics（<https://github.com/GaBoron/SPW-Lyrics>，`integration/hostui/HostBytecodeIndex.java`
+ `HostPlayerMenuDiscovery.java`）；它的 `docs/开发说明.md`「主窗口 Hook 与动态发现」一节写了同一套
纪律（联合结构约束、候选必须唯一、每次启用重新扫描）。

### 3.1 发现链（每一步只写结构约束，不含混淆名）

| # | 角色 | 结构约束 | 1.19.3 命中 |
|---|---|---|---|
| 1 | `owner`（菜单 facade 类） | 唯一一个「方法体里调用了 `com/xuncorp/voxzen/service/PlaybackController#releaseAudioEngine`」的方法的 owner。宿主在弹层里「释放音频引擎」，这个业务调用点不会被改名。 | `androidx.compose.ui.ɦ` |
| 2 | `popup`（弹出菜单调用点） | `owner` 的所有方法体中，descriptor 恰为 `(Function0, Function2, Function1, Composer, I, I)V` 的唯一调用点（`BlurPopupMenu(...)` 的形状）。 | `com/xuncorp/voxzen/ui/component.Ԭ` |
| 3 | `entry`（菜单入口方法） | `owner` 里唯一一个「方法体包含上述 popup 调用」的方法。 | `ɦ.ɦ(PopupState, Composer, I)V` |
| 4 | `popupStateType` | `entry` 参数表里唯一一个「以 `L` 开头且不是 `Landroidx/compose/runtime/Composer;`」的类型。 | `Landroidx/compose/ui/ל;` |
| 5 | `itemBridge` | `owner` 所有调用中，`parameterCount==3`、第 0 参自指（`L<callee.owner>;`）、第 1 参 `Function0`、第 2 参 `Function2`、返回 `V`，且**全局唯一**。这是 `MenuFlyoutScope` 上的 Kotlin 默认参数 bridge —— 它的 owner 就是 scope 接口本身。 | `त.Ϳ` |
| 6 | `builder`（要 hook 的方法） | 见 §3.2。 | `ɦ.Ϳ(...)Unit` |
| 7 | `scopeParameter` / `popupParameter` | `builder` 参数表里 `L<scope>;` 与 `popupStateType` 的**下标**，供 hook 回调取参。 | 5 / 2 |
| 8 | `dismiss` | `owner` 里满足「1 个参数 == `popupStateType`、返回 `Lkotlin/Unit;`」的方法体中，调用 owner 为 `popupStateType` 且 descriptor `()V` 的唯一调用。 | `ԩ` |
| 9 | `label`（可选） | `owner` 所有调用里 descriptor 为 `(String, Modifier, Function2, Z, Composer, I, I)V` 的唯一调用（宿主原生行渲染，用于对齐样式）。失败降级 `null`。 | 命中 |
| 10 | `palette`（可选） | 全库中唯一的访问器：static、descriptor 以 `(Landroidx/compose/runtime/Composer;)Landroidx/compose/ui/` 开头并以 `;` 结尾；返回类型 `X` 有 ≥5 个 `MutableState` 字段、≥5 个非 static `()J` getter；内容色 = 名为 `Ԩ`(U+0528) 的 getter，否则退化为第 2 个 getter。失败降级 `null`。 | `androidx.compose.ui.ʹ.Ԩ()` via `androidx.compose.ui.ʰ.Ԩ` |

1.19.3 上 6 个必需角色**全部唯一命中**，且与手写 profile 逐字符一致
（U+0266 / U+037F / U+0924 / U+037F / U+05DC / U+0529）。

### 3.2 `builder` 规则的六个锚点

只看「static + 返回 `kotlin.Unit` + 参数里没有 `Composer` + 方法体调用了 `itemBridge`」在
1.19.3 上有 **15 个候选** —— 对 SPW 的菜单结构约束太弱，不可用。现行规则在同样四个条件之外，
还要求参数表里**同时**出现下面六个锚点：

| 锚点 | 为什么它不会被 R8 改名 |
|---|---|
| `com/xuncorp/voxzen/data/entity/Track` | 宿主业务实体 |
| `com/xuncorp/pisces/PiscesMediaItem` | 第三方播放库类型 |
| `com/xuncorp/voxzen/ui/navigation/Navigator` | 宿主导航类型 |
| `androidx/compose/runtime/State` | Compose 运行时类型 |
| `L<itemBridge.owner>;`（scope） | 由第 5 步推导，不是硬编码 |
| `popupStateType` | 由第 3–4 步推导，不是硬编码 |

六个锚点里只有后两个是「推导出来的」，其余四个是 R8 不会动的库/业务类型。加完后 1.19.3 上
**唯一命中**。

### 3.3 纪律：候选必须唯一，不唯一就报错

每一步都是 `unique(...)`：候选数 != 1 就抛 `IllegalStateException`，消息带**角色名 + 候选数量**，
绝不 best-effort 挑一个。理由是错的后果不对称 —— 在宿主里调错方法会静默污染弹层，而抛错只是
「这一版没有 Folia 项 + 一条可读日志」。异常被 `HostTargets.structuralResolve` 捕获、记日志、
退回第 4 层 `scan()`，**不会**让插件启动失败。

可选角色（`label` / `palette`）走另一条纪律：失败或候选不唯一时降级为 `null` 并写诊断行
（`FoliaMenuItem` 有常量颜色兜底）。只有「必需角色」才允许整体失败。

### 3.4 性能与线程红线

真实 1.19.3 宿主（`app/ffmpeg-x64.dll`，111 MB，**42147 个 class**）实测：

| 指标 | 实测值 |
|---|---|
| 索引到的**方法体**数 | **28058**（约 2.8 万；预筛只解析引用了 Compose runtime 的类） |
| 索引耗时 | **1313 ms**（多次运行区间约 **1.3–1.5 s**） |
| 发现本身（索引建好之后） | 约 70–92 ms |
| 已知版本走 profile（对照） | 53–57 ms，**零字节码成本** |

**红线：约 1.3–1.5 s 的索引绝不允许进 `start()` 同步路径。** 它只在 `deepResolve()` 里跑，
而 `deepResolve()` 只由 `installHookForHostBuild()` 起的 `spw-folia-target-resolve` 守护线程调用；
`quickLoad()` 只碰缓存与 profile。索引结果写入 `host-targets.json`，**同一版本之后每次启动都是
零成本**，不会重复索引。

索引可协作取消（`HostBytecodeIndex.read(source, isCancelled)` 轮询线程中断标志），宿主退出时不会
留下一个还在啃 111 MB zip 的线程。

### 3.5 边界

- **能适应重命名。** 宿主下一次 R8 把 `ɦ`/`ל`/`त` 再改成别的字形，发现链不受影响 —— 它一个混淆名
  都不读。
- **不能适应页面结构重构。** 如果宿主不再用 `BlurPopupMenu` 这类弹层（第 2 步的形状变了），或者
  「更多」弹层不再从 `Track` / `PiscesMediaItem` 取数（§3.2 的锚点没了），结构约束就会失效：
  候选不唯一或为零 → 抛错 → 退回 `scan()` → 仍失败则记 `could not locate the 更多 flyout`
  并让 Folia 项缺失（其余功能不受影响）。**这种情况需要重新适配，不是自动就能活的。**
  SPW-Lyrics 自己也承认这条边界（其 `docs/常见问题.md`：「动态发现能适应重命名，但不保证任意
  页面结构变化后都能继续接入」）。
- **不做 best-effort。**

### 3.6 缓存文件 `host-targets.json`

结构发现的结果写进同一份缓存（`pluginDir/host-targets.json`），带 `origin: "structural"`，
并额外记录诊断数据：

```json
{"spwVersion":"1.19.3",
 "menu":{"class":"androidx.compose.ui.ɦ","method":"Ϳ","params":[6 项],"scope":"androidx.compose.ui.त",
         "bridge":"Ϳ","popup":"androidx.compose.ui.ל","dismiss":"ԩ",
         "scopeParameter":5,"popupParameter":2,"label":"…","origin":"structural"},
 "structural":{"indexMs":1313,"bodies":28058,
   "candidateCounts":{"owner":1,"popup":1,"entry":1,"popupState":1,"itemBridge":1,
                      "builder":1,"scopeParameter":1,"popupParameter":1,"dismiss":1,
                      "label":1,"palette":1},
   "diagnostics":["…"]},
 "paletteTarget":{"accessor":"androidx.compose.ui.ʰ","accessorMethod":"Ԩ",
                  "palette":"androidx.compose.ui.ʹ","color":"Ԩ","origin":"structural"}}
```

两个踩过的坑，改这里前必读：

- **调色板的键叫 `paletteTarget` 而不是 `palette`。** 项目自带的 `Json.rawField` 不做层级区分，
  只返回**第一个**文本匹配，而 `structural.candidateCounts` 里也有一个 `palette` 键（候选计数）——
  同名会读出数字而不是对象。读取侧仍兼容旧缓存里的 `palette` 键，但只在它的值真的是对象时采用。
- **缓存命中仍要 `validateMenu` / `validatePalette`。** 缓存可能来自另一个宿主版本或一个有 bug 的
  发行版，不校验就等于信任磁盘上的字符串。

`candidateCounts` 的键名固定为
`owner, popup, entry, popupState, itemBridge, builder, scopeParameter, popupParameter, dismiss, label, palette`。
palette 降级时值是 **0**（不是缺失），未走到的角色不会出现在 map 里 → **禁用 `getValue`**，
用 `getOrDefault` / `?.`。

## 4. 托盘菜单 hook：`RecordingComposableScope.snapshot()`

与 更多 弹层 hook **完全独立**（两个 `HookHandle`、两条失败路径）。它在托盘右键菜单里插入一行
**Folia**，与「桌面歌词」同一栏。

### 4.1 目标与调用链

SPW 的托盘菜单不是 Win32 手写菜单，而是自带库 `compose-native-tray` 的 Compose → 原生菜单投影：

| 步骤 | 类 / 方法 | 说明 |
|---|---|---|
| 1 | 宿主 `AppTray.kt`（1.19.2 里被 R8 落到 `androidx.compose.ui.Ƌ`） | 调 `Tray(..., menuContent = { … })`，内部依次 `Item(显示主窗口)` / `Divider` / `CheckableItem(桌面歌词)` / [`CheckableItem(锁定桌面歌词)`] / `Divider` / 播放·上一首·下一首 / `Divider` / `Item(退出)` |
| 2 | `dev.nucleusframework.composenativetray.tray.api.ComposableTrayKt.rememberRecordedMenuContent` | 建一个 `RecordingComposableScope`，把上面的 lambda 对它执行一遍；每个 `Item`/`CheckableItem`/`Divider` 往私有 `SnapshotStateList<MenuOp> ops` 里追加一个 `MenuOp` |
| 3 | **`…menu.impl.RecordingComposableScope.snapshot()`** | `public final java.util.List<MenuOp> snapshot()`，方法体就一句 `return ops.toList()` → 返回的是**拷贝**，不是内部 list |
| 4 | `…menu.impl.RecordingComposableScopeKt.asTrayMenuBuilderBlock` + `replay` | 把 `List<MenuOp>` 投影成 `TrayMenuBuilder` 调用（`PlainItem` → `Item(label, enabled, shortcut, onClick)`） |
| 5 | `WindowsTrayInitializer` / `WindowsTrayManager` | 把 builder 调用换成一串原生菜单句柄 |

**为什么 hook 这里**：`snapshot()` 是**唯一**一个「菜单已经录完、还没投影成原生菜单」的接缝。
录制过程本身在宿主的 lambda 里（R8 混淆，且每版重建），原生句柄层要碰 Win32 消息与 id 分配；
只有这里拿到的 `List<MenuOp>` 是可读可改的普通集合，改完塞回 `MethodHookParam.setResult` 即可，
宿主完全无感。做法与 更多 弹层一致：`hookMethod` + JVM 名字 + 参数类型列表，零编译期依赖。

```kotlin
WorkshopApi.hookRegistrar.hookMethod(
    "dev.nucleusframework.composenativetray.menu.impl.RecordingComposableScope",
    "snapshot",
    emptyList(),                      // 无参
    object : MethodHook() {
        override fun after(call: MethodHookParam) = inject(call)   // 整体 try/catch
    }
)
```

### 4.2 插入位置：与「桌面歌词」同一栏

不硬编码任何本地化文案，只看 **op 类型**：

1. 找到第一个 checkable 类 op（`MenuOp$PlainCheckable` / `$PainterCheckable` / `$VectorCheckable`）
   —— SPW 托盘里只有「桌面歌词」是 checkable，所以这就是该栏的起点；
2. 往后吃掉**连续的一段** checkable（有歌词在播时会多出「锁定桌面歌词」）；
3. 在这段之后插入 `MenuOp.PlainItem("Folia", true, null, onClick)`。

`PlainItem` 与宿主自己的 `Item(退出)` 是同一 op 类型，所以原生侧就是普通可点行，语义上就是
「桌面歌词」那一栏的兄弟项。

### 4.3 幂等 / 线程

- `snapshot()` **每次打开托盘菜单都会跑**（每次录制一遍菜单），`after` 必须纯函数化：
  不修改传入的 `ops`（它是 `ops.toList()` 的临时拷贝），另建 `ArrayList` 再 `setResult`。
- `ops` 里已有 label == `"Folia"` 的 `PlainItem` 时直接返回 → 重复注入不产生重复行。
- 无静态可变状态：实例上只有 `@Volatile plainItemCtor` 与几个 `AtomicBoolean`，都不持有 op 引用。
- 注入的 `Function0` 每次新建；点击时另起 `spw-folia-tray-click` 守护线程再 `openFolia()`，
  避免在 Win32 消息循环线程上阻塞式拉起 WebView2 helper。
- 成功日志一次性写（`loggedInjection` latch），不会每次开菜单都追加一行。

### 4.4 失败模式（全部 log-only，无 toast）

| 情况 | 表现 |
|---|---|
| `RecordingComposableScope` / `MenuOp$PlainItem` 类不存在（未来版本改了库名） | `tray: … not on the host classpath` / `… missing on this build`，hook 不注册 |
| `snapshot()` 签名变了（不再是 `List`） | `tray: … has an unexpected shape on this build` |
| `PlainItem` 构造器参数顺序变了 | `tray: unexpected MenuOp.PlainItem constructor on this build` |
| 库类不可被 retransform（`Instrumentation.isModifiableClass == false`）或 registrar 拒绝 | `WARNING: tray menu item disabled: hook registration failed: …` |
| 录制到的 op 列表里没有 checkable（宿主菜单结构改了） | 不注入，一次性 `tray: recorded scope has no checkable op …` |
| `inject` 内部任何异常 | `after` 整体 `try/catch (Throwable)`，只写 `tray: inject error: …` |

以上任一发生时，**更多 弹层的 Folia 项照旧工作**（独立 hook），符合「失败不放大」的约定。

## 5. 注入实现要点

`hookMethod` 只需要 JVM 类名 + JVM 方法名 + 完整业务参数类型列表：

```kotlin
WorkshopApi.hookRegistrar.hookMethod(
    target.menuClass,                            // 例：androidx.compose.ui.ɦ
    target.method,                               // 例：Ϳ
    target.params,                               // 6 个业务参数类型的点分名
    object : MethodHook() {
        override fun after(call: MethodHookParam) {
            val scope = call.args[target.scopeParameter]        // MenuFlyoutScope
            appendItem(scope, call.args[target.popupParameter]) // 去重 + 反射 bridge
        }
    }
)
```

在 `after` 里（宿主 4 个条目加完之后、合成线程上）：

```kotlin
val scopeCls = Class.forName(target.scope)      // 点分二进制名
val bridge = scopeCls.getDeclaredMethod(
    target.bridge, scopeCls, Function0::class.java, Function2::class.java)
bridge.isAccessible = true
val onClick: () -> Unit = { dismissPopup(); openFoliaWindow() }
val content: @Composable () -> Unit = { BasicText("Folia") }   // 运行时类型 = Function2<Composer,Int,Unit>
bridge.invoke(null, scope, onClick, content)
```

- **去重**：scope 实现把条目存在一个可变的 `java.util.List` 字段里；把它当 `WeakHashMap` 的键，
  重组就不会加重复条目。该字段**按类型**找（第一个非 static 的 `java.util.List` 字段），不按名字，
  所以改名打不断它。幂等也可用全列表扫描兜底。
- **dismiss**：`PopupState` 上的无参 void 方法，反射解析（名字来自 `MenuTarget.dismiss`）。
- **参数下标**：读 `MenuTarget.scopeParameter` / `.popupParameter`，并在用前对 `call.args.size`
  做越界检查 —— 签名重排时记 `after: argument indices out of range …`，而不是悄悄喂错参数。
- **编译要求**：插件应用 `org.jetbrains.kotlin.plugin.compose` 并 `compileOnly` compose
  runtime/foundation/material3（`androidx.compose.*` 由宿主提供；**绝不**在 `lib/` 里再打一份
  Compose runtime）。
- **类名对外形态必须是点分二进制名**（`androidx.compose.ui.ɦ`），不是内部名
  （`androidx/compose/ui/ɦ`）—— 下游会直接塞给 `Class.forName`。
  内部名转点分在构造 `MenuTarget` 时一次完成，不要在调用点临时 `replace`。

## 6. 日志与排障

`spw-folia.log` 里正常情况下应当连着出现的三行：

```
host menu profile:1.19.3: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)
hookMethod installed: … (profile:1.19.3)
Folia item appended (scope=androidx.compose.ui.গ$Ϳ, bridge=Ϳ)
```

未知 build 走结构路径，日志是：

```
host structural index: com.xuncorp.pisces.PiscesMediaItem: 28058 method bodies (1313ms)
host structural matches regression baseline profile:1.19.3
host menu structural: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त) scope=androidx.compose.ui.त.Ϳ (1313ms, 28058 bodies)
host palette structural: androidx.compose.ui.ʹ.Ԩ() via androidx.compose.ui.ʰ.Ԩ
```

`host structural matches regression baseline …` 这一行让已知 build 具备自检能力：没有它，就去找
`WARNING: structural discovery disagrees with <profile>`，那行会同时打印两个候选的名字**以及**它们的
`scopeParameter` / `popupParameter` 下标。发现彻底失败时，`lastDiagnostics` 里带着逐角色的候选普查
（`structural(indexMs=… bodies=… candidates=[owner=1,popup=1,…])`）加发现自身的诊断行 —— 那才是要
向用户索取的日志块。

## 7. 目标失效时怎么重新推导

**通常不需要这一节。** 结构发现自己就能解析未知 build；下面的配方只用于 (a) 用什么都没有的日志
手工核验一次发现结果，(b) 诊断一次发现失败（即宿主页面结构真的变了），(c) 可选地把某个 build
钉成 profile。

1. **先看插件日志。** `host structural index: … (N method bodies, Mms)` 加
   `host menu structural: …` 已经给出点分名与参数列表。只有当日志显示发现失败时才需要往下走，
   而那时有用的产物是 `lastDiagnostics`（逐角色候选普查），不是名字。
2. 类名 → 原始源码映射：`work/host/smap.json`（17,661 个混淆类 → `.kt` 文件名）。
3. 取类：用 Python `zipfile` 读宿主安装目录下的
   `app/ffmpeg-x64.dll`（polyglot jar，`unzip` 会失败）；再
   `java -jar work/host/vineflower.jar -dgs=1 <inDir> <outDir>` 出 `.kt`。
4. **javap 是唯一权威**：`javap -J-Dstdout.encoding=UTF-8 -p -s <file>`（重定向到文件再按 UTF-8 读，
   控制台会毁掉混淆的 unicode 名）。**混淆名只在真实字节码上认**，文档、旧记忆、设计稿都不能当证据。
5. 解 Kotlin `@Metadata` 的 d1/d2（原始名字，但 JVM 签名已被改名）：`work/host/tools/` 下的
   `ParseMeta.java` / `ListMethods.java` / `ResolveTest.java`。
6. 全部 jar 条目：`work/host/entries.txt`。

## 8. 兜底方案（辅助方法 hook 万一失效）

- **Plan B**：`replaceComposable` 掉 `BlurPopupMenu` 调用点，在自己写的 Composable 里重新实现宿主
  的 4 个条目 + Folia 条目（宿主单例经反射取：`PlaybackController.INSTANCE`、`AppConfig.INSTANCE`、
  navigator）。
- **Plan C**：在 `PlayerMoreMenuFlyout` 的调用点（`MiniPlayerMenu.kt` 里）`replaceComposable`，
  效果相同、注入点不同。
- **Plan D**：hook `MenuFlyoutScope` 的条目追加实现（更难：要先识别宿主的第 4 个条目才能追加在其后）。
- **诊断**：宿主异常出现在 `%APPDATA%\Salt Player for Windows\logs.txt`；插件另写自己的
  `spw-folia.log`。

## 9. 混淆码点对照表

| glyph | codepoint | 名字 / 角色 |
|---|---|---|
| ē | U+0113 | PlayerMoreMenuFlyoutKt file facade（1.19.0） |
| ঘ | U+0918 | PlayerMoreMenuFlyoutKt file facade（1.19.2） |
| ɦ | U+0266 | PlayerMoreMenuFlyoutKt file facade（1.19.3） |
| Ԭ | U+052C | Blur.kt file facade |
| ন | U+09A8 | MenuFlyoutScope 接口（1.19.0） |
| Ը | U+0538 | MenuFlyoutScope 接口（1.19.2） |
| त | U+0924 | MenuFlyoutScope 接口（1.19.3） |
| Ϳ | U+037F | 共享的混淆 JVM 方法名（builder、scope 条目 bridge、list 字段） |
| ઠ | U+0AA0 | 宿主菜单项内容 lambda 工厂 |
| Ⴈ | U+10A8 | PopupState（1.19.0） |
| ะ | U+0E30 | PopupState（1.19.2） |
| ל | U+05DC | PopupState（1.19.3） |
| ԩ | U+0529 | PopupState.dismiss() |
| ʰ | U+02B0 | palette 访问器 facade |
| Ԩ | U+0528 | palette 访问器方法**兼**内容色 getter |
| ʹ | U+0374 | palette 对象类 |

这张表**只是回归基准与复制粘贴辅助**。没有任何代码路径*需要*它：结构发现从字节码结构推导每一个
名字，字形完全不同的 build 照样能解析。把它当成「发现过程在这三个 build 上必须复现出什么」，
而不是插件依赖的查表。

写进源码时，**单字符码点一律用 `\uXXXX` 转义字面量**，不要用肉眼粘贴的字符
（编辑器与编码会破坏它们）。
