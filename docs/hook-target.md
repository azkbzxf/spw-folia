# Hook target：往 SPW 菜单里注入「Folia」项（迷你播放器 更多 + 托盘右键，SPW 1.19.0+）

两个互相独立的 hook，都在运行时解析：

| 菜单 | hook | 文件 |
| --- | --- | --- |
| 迷你播放器 更多 弹层 | 对宿主加项辅助方法做 `hookMethod` | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` |
| 托盘（最小化图标）右键 | 对 `compose-native-tray` 的 `RecordingComposableScope.snapshot()` 做 `hookMethod` | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaTrayMenu.kt` |

下面先讲弹层 hook，托盘 hook 在
[托盘菜单（最小化图标右键）](#托盘菜单最小化图标右键recordingcomposablescopesnapshot-hook) 一节。

## 更多 弹层（迷你播放器）

做法是**对宿主的加项辅助方法做 `hookMethod`**。原始计划里的 `appendContent` 在这个 R8 混淆过的
宿主构建上**不可能工作**（根因见文末
[appendContent 为什么失败](#appendcontent-为什么在这个宿主上失败)）。
实现位于 `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt`。

## 目标解析层级

SPW 是 R8 混淆的，**每次发版都会改名我们依赖的类与方法**。1.19.2 把
`ē`/`ন`/`Ⴈ` 改成 `घ`/`Ը`/`ะ`，1.19.3 又改成 `ɦ`/`ל`/`त`。人工反编译抄码点的方式每次发版都要
重来一遍，因此目标解析改成了**按结构发现**：读宿主自己的字节码，按形状定位，R8 改名本身不再需要
发插件版本。

插件在运行时解析目标（`spw-folia/src/main/kotlin/dev/spw/folia/HostTargets.kt`），从最便宜的一层
往上试：

| # | 层 | 何时 | 成本 |
| --- | --- | --- | --- |
| 1 | `host-targets.json` 缓存（按 `spwVersion` 键） | 该版本第一次成功之后的每次启动 | ~0 |
| 2 | 内置 profile（`PROFILES`：1.19.3、1.19.2、1.19.0） | 已知版本 —— **回归基准 + 零成本快路径**，不再承担适配职责 | ~0（实测 53–57 ms，含校验） |
| 3 | **结构发现**（`HostMenuDiscovery` 跑在 `HostBytecodeIndex` 上） | 未知版本 —— **主路径**，只在后台线程 | 索引约 1.3–1.5 s，每个宿主版本一次，之后走缓存 |
| 4 | 旧的 classpath `scan()`（手写 class 解析器，纯反射） | 结构发现失败时的第二意见 | 一次性约 0.5–2 s |
| — | **反射守卫**（`validateMenu` / `validatePalette`） | **每一层**的结果在被使用前都过 | ~0 |

`quickLoad()`（在 `start()` 内）只跑第 1–2 层，两者都校验不过就返回 `false`，所以 `start()`
永远不会为字节码索引付时间。`deepResolve()`（后台 worker）跑第 3 层，失败退回第 4 层。

每一层的结果都**先过反射校验**——helper 的签名（`hookMethod` 的精确参数表）、scope 桥
（`MenuFlyoutScope.item(onClick, content)` 作为静态 `(self, Function0, Function2)V`）、
调色板 getter——过期的名字不会被信任。结构发现的结果**额外**与任何仍然能校验通过的内置 profile
逐字段比对：已知版本上两条路径必须完全一致，不一致记 `WARNING` 而不是静默取平均。

整套解析链要绕开两个宿主事实：

- **jar 里的 zip 条目名不可信。** 有些条目存的名字与它实际包含的类不同
  （`androidx/compose/ui/Ϡ.class` 里装的是 `…/ϡ`），所以候选一律按 class 文件里解析出来的
  `this_class` 识别，绝不按条目路径。索引与旧扫描都遵守这条。
- **`java.class.path` 是一个 polyglot jar**（`app/ffmpeg-x64.dll`，111 MB，42,147 个 class，
  可用 `ZipFile` 读）。结构发现优先读宿主类自己的 code source
  （`HostBytecodeIndex.read(hostClass)`），只有那里读不了时才退回 `java.class.path`。

### 已知版本 profile —— 回归基准，不是适配机制

| 构建 | 菜单 facade | helper | MenuFlyoutScope（bridge） | PopupState（dismiss） |
| --- | --- | --- | --- | --- |
| 1.19.0 | `androidx.compose.ui.ē` (U+0113) | `Ϳ` | `androidx.compose.ui.ন` (U+09A8) / `Ϳ` | `androidx.compose.ui.Ⴈ` (U+10A8) / `ԩ` |
| 1.19.2 | `androidx.compose.ui.घ` (U+0918) | `Ϳ` | `androidx.compose.ui.Ը` (U+0538) / `Ϳ` | `androidx.compose.ui.ะ` (U+0E30) / `ԩ` |
| 1.19.3 | `androidx.compose.ui.ɦ` (U+0266) | `Ϳ` | `androidx.compose.ui.त` (U+0924) / `Ϳ` | `androidx.compose.ui.ל` (U+05DC) / `ԩ` |

这三行保留着，但职责已经变了。一个 profile 现在是：

- **回归基准** —— 在我们已经钉住的版本上，结构发现必须逐字符复现它；不一致会记警告，
  把「发现逻辑是不是退化了」从一次 bug 报告变成一行日志；
- **零成本快路径** —— 已知版本上 `quickLoad()` 完全不碰字节码（实测 53–57 ms，含反射校验），
  钉住版本的用户不必付索引成本；
- **不再是适配机制** —— 未知版本不需要新增行。加 profile 变成可选的维护工作（钉住一个版本以跳过
  它的首次索引），不是发版前提。

1.19.3 上的实测形态（Steam 版）：`ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)Unit`，
scope 实现 `গ$Ϳ`（items 列表字段 `Ϳ`），弹层内容色仍是 `ʰ.Ԩ(composer).Ԩ()`。
播放控制与托盘反射在两个版本里都没变。

日志里可以找这些行（`spw-folia.log`）：

```
host menu profile:1.19.3: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)
hookMethod installed: … (profile:1.19.3)
Folia item appended (scope=androidx.compose.ui.গ$Ϳ, bridge=Ϳ)
```

未知版本走结构发现路径，日志变成：

```
host structural index: com.xuncorp.pisces.PiscesMediaItem: 28058 method bodies (1313ms)
host structural matches regression baseline profile:1.19.3
host menu structural: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त) scope=androidx.compose.ui.त.Ϳ (1313ms, 28058 bodies)
host palette structural: androidx.compose.ui.ʹ.Ԩ() via androidx.compose.ui.ʰ.Ԩ
```

`host structural matches regression baseline …` 这一行让已知版本自检：没有它就去找
`WARNING: structural discovery disagrees with <profile>`，那里会打出两侧候选的名字**以及**它们的
`scopeParameter`/`popupParameter` 下标。发现彻底失败时，`lastDiagnostics` 带着逐角色的候选普查
（`structural(indexMs=… bodies=… candidates=[owner=1,popup=1,…])`）与发现过程自己的诊断行
—— 那才是要向用户索取的内容。

### 旧 classpath 扫描的一个历史 bug

保留这段是因为它能解释老报告里可能出现的日志行，也解释了为什么旧扫描现在退到第 4 层。
`menuCandidates()` 曾把 `ParsedClass.name`（原始 `this_class` 值，即带 `/` 分隔符的 JVM
*内部*形式，`androidx/compose/ui/ɦ`）直接塞进 `MenuTarget.menuClass`；`validateMenu()` 随后对它调
`Class.forName()`，抛 `ClassNotFoundException`，于是扫描在**每个**未知宿主版本上都报
`found no flyout helper`。此前每版都有内置 profile，这个 bug 一直没显形；1.19.3 把三个类全改了名，
把它暴露出来（扫描找到了候选，但校验不过）。修复方式是在构造点做 `cls.name.replace('/', '.')`。

结构发现绕开了整个失败模式：它自己把内部名单向转成二进制名（`HostMenuDiscovery` 只输出点分名，
`popupStateClass` 会剥掉 `L…;` 描述符外壳），结果仍然过同一个 `validateMenu()` 守卫。
旧扫描只作为第 4 层第二意见保留，用于 JDK class-file API 解析不了宿主镜像的场景。

## 结构发现

这是**主路径**：不读任何混淆名，改为解析宿主自己的字节码、按结构约束逐个角色定位。
实现分两层，都在 `spw-folia/src/main/kotlin/dev/spw/folia/`：

| 文件 | 职责 |
| --- | --- |
| `HostBytecodeIndex.kt` | 只读索引：用 JDK 25 的 `java.lang.classfile` API 解析宿主 jar，建立「方法体 → 调用点 / 字段访问」的调用图。**从不加载或初始化宿主类**，只读字节。 |
| `HostMenuDiscovery.kt` | 在索引上跑发现链，输出 6 个必需角色 + 2 个可选角色，全部是点分二进制名。 |

设计来源是 SPW-Lyrics（<https://github.com/GaBoron/SPW-Lyrics>，`integration/hostui/HostBytecodeIndex.java`
+ `HostPlayerMenuDiscovery.java`）；它的开发说明里的「主窗口 Hook 与动态发现」一节写了同一套纪律
（联合结构约束、候选必须唯一、每次启用重新扫描）。

### 发现链（每一步只写结构约束，不含混淆名）

| # | 角色 | 结构约束 | 1.19.3 命中 |
| --- | --- | --- | --- |
| 1 | `owner`（菜单 facade 类） | 唯一一个「方法体里调用了 `com/xuncorp/voxzen/service/PlaybackController#releaseAudioEngine`」的方法的 owner。宿主在弹层里「释放音频引擎」，这个业务调用点不会被改名。 | `androidx.compose.ui.ɦ` |
| 2 | `popup`（弹出菜单调用点） | `owner` 的所有方法体中，descriptor 恰为 `(Function0, Function2, Function1, Composer, I, I)V` 的唯一调用点（`BlurPopupMenu(...)` 的形状）。 | `com/xuncorp/voxzen/ui/component.Ԭ` |
| 3 | `entry`（菜单入口方法） | `owner` 里唯一一个「方法体包含上述 popup 调用」的方法。 | `ɦ.ɦ(PopupState, Composer, I)V` |
| 4 | `popupStateType` | `entry` 参数表里唯一一个「以 `L` 开头且不是 `Landroidx/compose/runtime/Composer;`」的类型。 | `Landroidx/compose/ui/ל;` |
| 5 | `itemBridge` | `owner` 所有调用中，`parameterCount==3`、第 0 参自指（`L<callee.owner>;`）、第 1 参 `Function0`、第 2 参 `Function2`、返回 `V`，且**全局唯一**。这是 `MenuFlyoutScope` 上的 Kotlin 默认参数 bridge —— 它的 owner 就是 scope 接口本身。 | `त.Ϳ` |
| 6 | `builder`（要 hook 的方法） | 见下节「为什么要收紧 builder 规则」。 | `ɦ.Ϳ(...)Unit` |
| 7 | `scopeParameter` / `popupParameter` | `builder` 参数表里 `L<scope>;` 与 `popupStateType` 的**下标**，供 hook 回调取参。 | 5 / 2 |
| 8 | `dismiss` | `owner` 里满足「1 个参数 == `popupStateType`、返回 `Lkotlin/Unit;`」的方法体中，调用 owner 为 `popupStateType` 且 descriptor `()V` 的唯一调用。 | `ԩ` |
| 9 | `label`（可选） | `owner` 所有调用里 descriptor 为 `(String, Modifier, Function2, Z, Composer, I, I)V` 的唯一调用（宿主原生行渲染，用于对齐样式）。失败降级 `null`。 | 命中 |
| 10 | `palette`（可选） | 全库中唯一的访问器：static、descriptor 以 `(Landroidx/compose/runtime/Composer;)Landroidx/compose/ui/` 开头并以 `;` 结尾；返回类型 `X` 有 ≥5 个 `MutableState` 字段、≥5 个非 static `()J` getter；内容色 = 名为 `Ԩ`(U+0528) 的 getter，否则退化为第 2 个 getter。失败降级 `null`。 | `androidx.compose.ui.ʹ.Ԩ()` via `androidx.compose.ui.ʰ.Ԩ` |

1.19.3 上 6 个必需角色**全部唯一命中**，且与手写 profile 逐字符一致
（U+0266 / U+037F / U+0924 / U+037F / U+05DC / U+0529）。

### 纪律：候选必须唯一，不唯一就报错

每一步都是 `unique(...)`：候选数 != 1 就抛 `IllegalStateException`，消息带**角色名 + 候选数量**，
绝不 best-effort 挑一个。理由是错的后果不对称——在宿主里调错方法会静默污染弹层，而抛错只是
「这一版没有 Folia 项 + 一条可读日志」。异常被 `HostTargets.structuralResolve` 捕获、记日志、
退回第 4 层 `scan()`，**不会**让插件启动失败。

可选角色（`label` / `palette`）走另一条纪律：失败或候选不唯一时降级为 `null` 并写诊断行
（`FoliaMenuItem` 有常量颜色兜底），只有「必需角色」才允许整体失败。

### 为什么要收紧 SPW-Lyrics 的 builder 规则

SPW-Lyrics 原版的 builder 规则只看「static + 返回 `kotlin.Unit` + 参数里没有 `Composer` + 方法体
调用了 itemBridge」。**这条规则在 SPW 1.19.3 上有 15 个候选**——它对 SPW 自己的菜单结构约束太弱，
照抄过来完全不可用。

收紧版在同样四个条件之外，还要求参数表里**同时**出现下面六个锚点：

| 锚点 | 为什么它不会被 R8 改名 |
| --- | --- |
| `com/xuncorp/voxzen/data/entity/Track` | 宿主业务实体 |
| `com/xuncorp/pisces/PiscesMediaItem` | 第三方播放库类型 |
| `com/xuncorp/voxzen/ui/navigation/Navigator` | 宿主导航类型 |
| `androidx/compose/runtime/State` | Compose 运行时类型 |
| `L<itemBridge.owner>;`（scope） | 由第 5 步推导，不是硬编码 |
| `popupStateType` | 由第 3–4 步推导，不是硬编码 |

六个锚点里只有后两个是「推导出来的」，其余四个是 R8 不会动的库/业务类型。加完后 1.19.3 上
**唯一命中**，且解出的 6 个码点与 profile 逐字符一致。

### 性能与线程红线

真实 1.19.3 宿主（`app/ffmpeg-x64.dll`，111 MB，**42,147 个 class**）实测：

| 指标 | 实测值 |
| --- | --- |
| 索引到的**方法体**数 | **28,058**（预筛只解析引用了 Compose runtime 的类） |
| 索引耗时 | **1,313 ms**（多次运行区间约 **1.3–1.5 s**） |
| 发现本身（索引建好之后） | 约 70–92 ms |
| 已知版本走 profile（对照） | 53–57 ms，**零字节码成本** |

**红线：约 1.3–1.5 s 的索引绝不允许进 `start()` 同步路径。** 它只在 `deepResolve()` 里跑，而
`deepResolve()` 只由 `installHookForHostBuild()` 起的 `spw-folia-target-resolve` 守护线程调用；
`quickLoad()`（唯一在 `start()` 内被调用的解析入口）只碰缓存与 profile。索引结果写入
`host-targets.json`，**同一版本之后每次启动都是零成本**，不会重复索引。

索引可协作取消（`HostBytecodeIndex.read(source, isCancelled)` 轮询线程中断标志），宿主退出时
不会留下一个还在啃 111 MB zip 的线程。

### 边界

- **能适应重命名。** 宿主下一次 R8 把 `ɦ`/`ל`/`त` 再改成别的字形，发现链不受影响——它一个
  混淆名都不读。
- **不能适应页面结构重构。** 如果宿主不再用 `BlurPopupMenu` 这类弹层（第 2 步的形状变了），
  或者「更多」弹层不再从 `Track` / `PiscesMediaItem` 取数（第 6 步的锚点没了），结构约束就会
  失效：候选不唯一或为零 → 抛错 → 退回 `scan()` → 仍失败则记 `could not locate the 更多 flyout`
  并让 Folia 项缺失（其余功能不受影响）。**这种情况需要重新适配，不是自动就能活的。**
  SPW-Lyrics 自己也承认这条边界。
- **不做 best-effort。** 见上「纪律」一节。

### 缓存文件 `host-targets.json`

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
   "diagnostics":[…9 行…]},
 "paletteTarget":{"accessor":"androidx.compose.ui.ʰ","accessorMethod":"Ԩ",
                  "palette":"androidx.compose.ui.ʹ","color":"Ԩ","origin":"structural"}}
```

两个实现细节值得记下来：

- **调色板的键叫 `paletteTarget` 而不是 `palette`。** 项目自带的 `Json.rawField` 不做层级区分，
  只返回**第一个**文本匹配，而 `structural.candidateCounts` 里也有一个 `palette` 键（候选计数）——
  同名会读出数字而不是对象。读取侧仍兼容旧缓存里的 `palette` 键，但只在它的值真的是对象时采用。
- **缓存命中仍要 `validateMenu` / `validatePalette`。** 缓存可能来自另一个宿主版本或一个有 bug 的
  发行版，不校验就等于信任磁盘上的字符串。

## 这个菜单是什么

迷你播放器里的 更多 按钮打开一个由 `PlayerMoreMenuFlyout` 渲染的 `PopupState` 弹层
（原始文件 `com/xuncorp/voxzen/ui/player/popup/PlayerMoreMenuFlyout.kt`；1.19.0 的运行时 file facade
是 `androidx.compose.ui.ē`，1.19.2 是 `घ`，1.19.3 是 `ɦ`）。它显示 4 项：播放速度 / 桌面歌词 /
歌词翻译（勾选）/ 释放音频引擎。

*本节里的码点是 1.19.0 的，因为反编译是在那个版本上做的。对现在的实现来说，重要的是**形状**：
同样的角色在任意版本上都能靠结构重新发现——见上面的「结构发现」。*

反编译结果：`work/host/dec_more/androidx/compose/ui/ē.kt`。它的 composable（约第 96 行）调用
`Blur.kt` 的 file facade `com.xuncorp.voxzen.ui.component.Ԭ`（Ԭ = U+052C）：

```
BlurPopupMenu(onDismissRequest /*Function0*/, header /*Function2?*/, content /*MenuFlyoutScope.()->Unit*/)
```

4 个条目由**同一个类里的私有 static helper**（content-builder lambda 的方法体）追加，javap 签名：

```java
private static final kotlin.Unit Ϳ(com.xuncorp.voxzen.data.entity.Track,
                                   com.xuncorp.pisces.PiscesMediaItem,
                                   androidx.compose.ui.Ⴈ,          // PopupState
                                   com.xuncorp.voxzen.ui.navigation.Navigator,
                                   androidx.compose.runtime.State, // State<PiscesPlayer.State>
                                   androidx.compose.ui.ন)          // MenuFlyoutScope
```

它通过 Kotlin 默认参数静态桥
`androidx.compose.ui.ন.Ϳ(ন scope, Function0 onClick, Function2 content)`（菜单项的 `@Composable`
content lambda）追加条目，也就是说宿主自己的条目走的就是我们复用的同一条桥。

## 实现

`hookMethod` 只需要 JVM 类名 + JVM 方法名 + 完整的**业务**参数类型表——不需要 Kotlin 名字，
也不需要 `@Metadata` 关联：

```kotlin
WorkshopApi.hookRegistrar.hookMethod(
    "androidx.compose.ui.ē",                    // PlayerMoreMenuFlyoutKt file facade
    "\\u037f",                                   // 加项辅助方法的混淆 JVM 名
    listOf(
        "com.xuncorp.voxzen.data.entity.Track",
        "com.xuncorp.pisces.PiscesMediaItem",
        "androidx.compose.ui.\\u10a8",           // PopupState (Ⴈ)
        "com.xuncorp.voxzen.ui.navigation.Navigator",
        "androidx.compose.runtime.State",
        "androidx.compose.ui.\\u09a8",           // MenuFlyoutScope (ন)
    ),
    object : MethodHook() {
        override fun after(call: MethodHookParam) {
            // 下标来自解析结果（scopeParameter/popupParameter），不是硬编码的 args[5]/args[2]。
            // 1.19.x 的 profile 携带 5 和 2；结构发现从 builder 的参数表推导它们。
            val scope = call.args[target.scopeParameter]        // MenuFlyoutScope
            appendItem(scope, call.args[target.popupParameter]) // dedupe + 反射桥见下
        }
    }
)
```

`after` 里（在宿主 4 个条目追加完之后、于合成线程上运行）：

```kotlin
val scopeCls = Class.forName("androidx.compose.ui.\\u09a8")
val bridge = scopeCls.getDeclaredMethod(
    "\\u037f", scopeCls, Function0::class.java, Function2::class.java)
bridge.isAccessible = true
val onClick: () -> Unit = { dismissPopup(); openFoliaWindow() }
val content: @Composable () -> Unit = { BasicText("Folia") }   // 运行时类型 = Function2<Composer,Int,Unit>
bridge.invoke(null, scope, onClick, content)
```

- 去重：scope 实现把条目放在可变列表字段 `Ϳ`（U+037F）里；以它作 `WeakHashMap` 键，
  重组就不会重复加条目。字段**按类型**查找（第一个非 static `java.util.List` 字段），不按名字，
  因此改名破坏不了它。
- 关闭：`PopupState.ԩ()`（ԩ = U+0529）= 无参 void 方法，反射解析。
- 参数下标：读 `MenuTarget.scopeParameter` / `.popupParameter`，使用前对 `call.args.size` 做越界检查
  ——签名重排时记 `after: argument indices out of range …`，而不是静默喂错参数。
- 编译要求：插件应用 `org.jetbrains.kotlin.plugin.compose`（Kotlin 2.4.20）并 `compileOnly`
  声明 compose runtime/foundation/material3（`androidx.compose.*` 由宿主提供；**绝不**在
  `lib/` 里再打一个 Compose runtime）。

## 托盘菜单（最小化图标右键）：`RecordingComposableScope.snapshot()` hook

`spw-folia/src/main/kotlin/dev/spw/folia/FoliaTrayMenu.kt` 在托盘右键菜单里插入一行 **Folia**，
与「桌面歌词」同一栏。与上面的 更多 弹层 hook **完全独立**（两个 `HookHandle`、两条失败路径），
任一失败不影响另一个。

### 目标与调用链

SPW 的托盘菜单不是 Win32 手写菜单，而是自带库 `compose-native-tray` 的 Compose → 原生菜单投影：

| 步骤 | 类 / 方法 | 说明 |
| --- | --- | --- |
| 1 | 宿主 `AppTray.kt`（1.19.2 里被 R8 落到 `androidx.compose.ui.Ƌ`） | 调 `Tray(..., menuContent = { … })`，内部依次 `Item(显示主窗口)` / `Divider` / `CheckableItem(桌面歌词)` / [`CheckableItem(锁定桌面歌词)`] / `Divider` / 播放·上一首·下一首 / `Divider` / `Item(退出)` |
| 2 | `dev.nucleusframework.composenativetray.tray.api.ComposableTrayKt.rememberRecordedMenuContent` | 建一个 `RecordingComposableScope`，把上面的 lambda 对它执行一遍；每个 `Item`/`CheckableItem`/`Divider` 往私有 `SnapshotStateList<MenuOp> ops` 里追加一个 `MenuOp` |
| 3 | **`…menu.impl.RecordingComposableScope.snapshot()`** | `public final java.util.List<MenuOp> snapshot()`，方法体就一句 `return ops.toList()` → 返回的是**拷贝**，不是内部 list |
| 4 | `…menu.impl.RecordingComposableScopeKt.asTrayMenuBuilderBlock` + `replay` | 把 `List<MenuOp>` 投影成 `TrayMenuBuilder` 调用（`PlainItem` → `Item(label, enabled, shortcut, onClick)`） |
| 5 | `WindowsTrayInitializer` / `WindowsTrayManager` | 把 builder 调用换成一串原生菜单句柄 |

`javap -p` 实测（安装版 1.19.2，`app/ffmpeg-x64.dll`，JDK 21/25 均可读，class file v69）：

```
public final class dev.nucleusframework.composenativetray.menu.impl.RecordingComposableScope
        implements dev.nucleusframework.composenativetray.menu.api.ComposableTrayMenuScope {
  private final androidx.compose.runtime.snapshots.SnapshotStateList<MenuOp> ops;
  public final java.util.List<MenuOp> snapshot();
}
public dev.nucleusframework.composenativetray.menu.impl.MenuOp$PlainItem(
        java.lang.String, boolean,
        dev.nucleusframework.composenativetray.menu.api.KeyShortcut,
        kotlin.jvm.functions.Function0<kotlin.Unit>);
```

### 为什么 hook 这里

`snapshot()` 是**唯一**一个「菜单已经录完、还没投影成原生菜单」的接缝：录制过程本身在宿主的
lambda 里（R8 混淆，且每版重建），原生句柄层要碰 Win32 消息与 id 分配；只有这里拿到的
`List<MenuOp>` 是可读可改的普通集合，改完塞回 `MethodHookParam.setResult` 即可，宿主完全无感。
和 更多 弹层的做法一致：`hookMethod` + JVM 名字 + 参数类型表，零编译期依赖。

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

### 插入位置：与「桌面歌词」同一栏

不硬编码任何本地化文案，只看 **op 类型**：

1. 找到第一个 checkable 类 op（`MenuOp$PlainCheckable` / `$PainterCheckable` / `$VectorCheckable`）
   —— SPW 托盘里只有「桌面歌词」是 checkable，所以这就是该栏的起点；
2. 往后吃掉**连续的一段** checkable（有歌词在播时会多出「锁定桌面歌词」）；
3. 在这段之后插入 `MenuOp.PlainItem("Folia", true, null, onClick)`。

实测投影结果（`work/tray/harness/TrayHookHarness.java`，对真实宿主 jar + 插件编译产物跑）：

```
order:  [显示主窗口, Divider, 桌面歌词, 锁定桌面歌词, Folia, Divider, 播放/暂停, 上一首, 下一首, Divider, 退出]
replay: [Item(显示主窗口), CheckableItem(桌面歌词), CheckableItem(锁定桌面歌词), Item(Folia), …]
fingerprint: I:显示主窗口:…|C:桌面歌词:…|C:锁定桌面歌词:…|I:Folia:true:null|D|I:播放/暂停:…
```

`PlainItem` 与宿主自己的 `Item(退出)` 是同一 op 类型，所以原生侧就是普通可点行，
语义上就是「桌面歌词」那一栏的兄弟项。

### 幂等 / 线程

- `snapshot()` **每次打开托盘菜单都会跑**（每次录制一遍菜单），不是进程内一次；`after` 必须纯函数化：
  不修改传入的 `ops`（它是 `ops.toList()` 的临时拷贝），另建 `ArrayList` 再 `setResult`。
- `ops` 里已有 label == `"Folia"` 的 `PlainItem` 时直接返回 → 重复注入不产生重复行。
- 无静态可变状态：实例上只有 `@Volatile plainItemCtor` 与几个 `AtomicBoolean`，都不持有 op 引用。
- 注入的 `Function0` 每次新建；点击时另起 `spw-folia-tray-click` 守护线程再 `openFolia()`，
  避免在 Win32 消息循环线程上阻塞式拉起 WebView2 helper。
- 成功日志一次性写（`loggedInjection` latch），不会每次开菜单都追加一行。

### 失败模式（全部 log-only，无 toast）

| 情况 | 表现 |
| --- | --- |
| `RecordingComposableScope` / `MenuOp$PlainItem` 类不存在（未来版本改了库名） | `tray: … not on the host classpath` / `… missing on this build`，hook 不注册 |
| `snapshot()` 签名变了（不再是 `List`） | `tray: … has an unexpected shape on this build` |
| `PlainItem` 构造器参数顺序变了 | `tray: unexpected MenuOp.PlainItem constructor on this build` |
| 库类不可被 retransform（`Instrumentation.isModifiableClass == false`）或 registrar 拒绝 | `WARNING: tray menu item disabled: hook registration failed: …` |
| 录制到的 op 列表里没有 checkable（宿主菜单结构改了） | 不注入，一次性 `tray: recorded scope has no checkable op …` |
| `inject` 内部任何异常 | `after` 整体 `try/catch (Throwable)`，只写 `tray: inject error: …`，宿主编排不受影响 |

以上任一发生时，**更多 弹层的 Folia 项照旧工作**（独立 hook），符合「失败不放大」的约定。

### 安装版上的自查步骤

静态证据只到「`snapshot()` 在 `ComposableTrayKt.rememberRecordedMenuContent` 里有且仅有一处调用」。
装好插件后按下面三步确认（`enabled.txt` 含 `dev.spw.folia`、`permissions.json` 已授
`class-transform`）：

1. 启动 SPW，等插件 `start done` 后看
   `…\workshop\plugins\<…>\plugin\spw-folia.log`，应出现
   `tray hook installed: dev.nucleusframework.composenativetray.menu.impl.RecordingComposableScope.snapshot() …`
   （没有这行 = 目标解析失败，看紧跟的 `WARNING: tray menu item disabled: …`）。
2. 最小化 SPW 到托盘，右键托盘图标：菜单里「桌面歌词」下方应出现一条 **Folia**；
   若在播歌期间「锁定桌面歌词」存在，则 Folia 在它下面、同一栏内。
3. 点该 Folia 项 → Folia 窗口打开；日志追加 `tray: Folia item clicked`。再开合托盘菜单 2–3 次，
   确认 Folia 行**不重复**、日志里 `tray: Folia item recorded at index …` 只出现一次。

## appendContent 为什么在这个宿主上失败

早先的方案是
`appendContent(className="…Ԭ", methodName="\\u037f", inClass="androidx.compose.ui.ē",
parameter="content", scopeType=Class.forName("…ন"), parameterTypes=[F0,F2,F1], …)`。
它永远抛
`UI call missing or ambiguous: androidx.compose.ui.ē -> com.xuncorp.voxzen.ui.component.Ԭ.BlurPopupMenu (0 calls)`。

根因（从宿主字节解出来）：引擎解析到目标调用后，要求 `parameter` 是目标**业务参数名**
（`UiTarget.names`）之一。这些名字来自 (a) JVM `MethodParameters` 属性或 (b) Kotlin `@Metadata`
里的函数——而 (b) 还要求 metadata 里*原始*的 JVM 方法签名与运行时方法名匹配。R8 把 JVM 方法都改名了
（所有 composable 共用 `Ϳ`，U+037F），而 `@Metadata` 里存的仍是原始名（`BlurPopupMenu`、
`MenuFlyoutItemCompat`……），所以没有任何函数能关联上 → `names` 全是空串 →
`indexOf("content") = -1` → 异常（字节码检查要求 index ≥ 0 **且**该参数类型是
`kotlin.jvm.functions.Function1`）。宿主也没有发出 `MethodParameters` 属性。这是该宿主构建对
**所有**插件的限制，不是我们这个目标特有的。

结论：对着 SPW 的目标永远不要依赖 Kotlin 名字；要么用 `hookMethod` + JVM 名字 + 参数类型表，
要么用 `replaceComposable`/`afterComposable`（它们按 JVM 名 + 参数类型解析*调用点*，不需要参数名）。

## 辅助方法 hook 万一失效时的降级方案

- 方案 B：`replaceComposable(className="com.xuncorp.voxzen.ui.component.Ԭ", methodName="\\u037f",
  inClass="androidx.compose.ui.ē", parameterTypes=[F0,F2,F1], …)`，在自己的 Composable 里重新实现
  宿主的 4 个条目 + Folia 条目（宿主单例通过反射取：`PlaybackController.INSTANCE`、
  `AppConfig.INSTANCE`、navigator；见 [`archive/re-host.md`](archive/re-host.md)）。
- 方案 C：对 `com.xuncorp.voxzen.ui.player.mini.֏`（MiniPlayerMenu.kt）里的调用点做
  `replaceComposable` —— 效果相同，注入点不同。
- 方案 D：hook `MenuFlyoutScope` 的加项实现而不是 builder 辅助方法（更难：需要识别宿主的第 4 个
  条目以便在它之后追加）。
- 诊断：宿主异常出现在 `…\Salt Player for Windows\logs.txt`；插件另外在自己的安装目录写
  `spw-folia.log`。

## 重新推导的配方（如果目标随 SPW 更新而变化）

**正常情况下你不需要这些。** 结构发现自己就能解析未知版本；下面这些只用于 (a) 用可选 profile
钉住一个新版本、(b) 诊断发现失败（即宿主页面结构真的变了）、(c) 手工核对发现结果。

1. 类名→原始源码映射：`work/host/smap.json`（17,661 个混淆类 → `.kt` 文件名）。
   `PlayerMoreMenuFlyout.kt → androidx/compose/ui/ē.class`，`Blur.kt → com/xuncorp/voxzen/ui/component/Ԭ.class`。
2. 抽取类：用 Python `zipfile` 打开安装目录里的 `app/ffmpeg-x64.dll`（polyglot jar，`unzip` 会失败）。
   然后 `java -jar work/host/vineflower.jar -dgs=1 <inDir> <outDir>` → `.kt`。
3. javap（JDK 25）：`javap.exe -J-Dstdout.encoding=UTF-8 -p -s <file>`（写到文件再按 UTF-8 读；
   控制台会把混淆的 unicode 名字弄坏）。
4. 解析 Kotlin `@Metadata` 的 d1/d2（原始名，但 JVM 签名已改）：`work/host/tools/`
   里的 `ParseMeta.java` / `ListMethods.java` / `ResolveTest.java`（直接对着 polyglot jar 编译运行），
   输出 `work/host/d2_dump.txt`、`work/host/blur_d2_strings.txt`。
5. 全部 jar 条目：`work/host/entries.txt`。
6. **比 1–5 更快：读插件日志。** `host structural index: … (N method bodies, Mms)` 之后紧跟的
   `host menu structural: …` 已经给出点分名与参数表。只有日志显示发现失败时才需要上面的反编译配方
   ——而这时真正有用的产物是 `lastDiagnostics`（逐角色候选普查），不是名字。

## 码点速查（复制粘贴安全）

| 字形 | 码点 | 名称 / 角色 |
|---|---|---|
| ē | U+0113 | PlayerMoreMenuFlyoutKt file facade (1.19.0) |
| ঘ | U+0918 | PlayerMoreMenuFlyoutKt file facade (1.19.2) |
| ɦ | U+0266 | PlayerMoreMenuFlyoutKt file facade (1.19.3) |
| Ԭ | U+052C | Blur.kt file facade |
| ন | U+09A8 | MenuFlyoutScope interface (1.19.0) |
| Ը | U+0538 | MenuFlyoutScope interface (1.19.2) |
| त | U+0924 | MenuFlyoutScope interface (1.19.3) |
| Ϳ | U+037F | 共用的混淆 JVM 方法名（builder 辅助方法、scope item bridge、list 字段） |
| ઠ | U+0AA0 | 宿主菜单项 content lambda 工厂 |
| Ⴈ | U+10A8 | PopupState (1.19.0) |
| ะ | U+0E30 | PopupState (1.19.2) |
| ל | U+05DC | PopupState (1.19.3) |
| ԩ | U+0529 | PopupState.dismiss() |
| ʰ | U+02B0 | palette 访问器 facade（`ʰ.Ԩ(composer).Ԩ()`） |
| Ԩ | U+0528 | palette 访问器方法 **与** 内容色 getter |
| ʹ | U+0374 | palette 对象类 |

这些码点**只是回归基准和复制粘贴的便利**。没有代码路径*依赖*它们：结构发现从字节码结构推导出
每一个名字，因此一个字形完全不同的构建仍然能解析。把这张表当作「在这些版本的构建上，发现链必须
复现出这些值」，而不是插件查表用的映射。
