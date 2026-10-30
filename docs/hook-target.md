# Hook target: inject "Folia" items into SPW menus (mini-player 更多 + tray right-click, SPW 1.19.0+)

Two independent hooks, both resolved at runtime:

| menu | hook | file |
| --- | --- | --- |
| mini-player 更多 flyout | `hookMethod` on the host's obfuscated item-adding helper | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` |
| tray (minimised icon) right-click | `hookMethod` on `compose-native-tray`'s `RecordingComposableScope.snapshot()` | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaTrayMenu.kt` |

The flyout hook is described first; the tray hook is the section
[托盘菜单（最小化图标右键）](#托盘菜单最小化图标右键recordingcomposablescopesnapshot-hook).

## 更多 弹层（mini-player）：`hookMethod` on the item-adding helper

Status: **version-independent since v0.3.1** (2026-10-23); **structure-discovered since v0.4.6**
(2026-10-30). The obfuscated names below are *data*, not code: `HostTargets` resolves them per host
build and caches the result, so a new SPW patch release no longer needs a plugin release. Since
v0.4.6 an unknown build does not need a hand-written profile at all — `HostMenuDiscovery` derives the
targets from the host's own bytecode by *shape* (see 「结构发现」 below).

The working approach is **`hookMethod` on the host's item-adding helper**; the originally planned
`appendContent` is **impossible on this R8-obfuscated host build** (root cause below). Implemented
in `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` (owner: hook-poc). Deep background:
`docs/archive/re-host.md`.

## Resolution layers (v0.4.6+)

SPW is R8-obfuscated, so **every release renames the classes and methods we touch** — 1.19.2 renamed
`ē`/`ন`/`Ⴈ` to `घ`/`Ը`/`ะ`, and 1.19.3 renamed those again to `ɦ`/`ל`/`त`. Up to v0.4.5 each rename
meant: decompile by hand → extract the new names → add a profile → ship a plugin release. v0.4.6
replaces that with **structural discovery**, which reads the host's bytecode and finds the targets by
shape, so an R8 rename alone no longer needs a plugin release.

The plugin resolves its targets at runtime (`spw-folia/src/main/kotlin/dev/spw/folia/HostTargets.kt`),
cheapest layer first:

| # | layer | when | cost |
| --- | --- | --- | --- |
| 1 | `host-targets.json` cache (keyed by `spwVersion`) | every start after the first success on that build | ~0 |
| 2 | built-in profile (`PROFILES`: 1.19.3, 1.19.2, 1.19.0) | known builds — **regression baseline + zero-cost fast path**, no longer the adaptation mechanism | ~0 (53–57 ms measured, including validation) |
| 3 | **structural discovery** (`HostMenuDiscovery` over `HostBytecodeIndex`) | unknown build — **the primary path**, background thread only | ~1.3–1.5 s index once per build, cached afterwards |
| 4 | legacy classpath `scan()` (hand-rolled class parser, pure reflection) | second opinion when structural discovery fails | ~0.5–2 s once |
| — | **reflection guard** (`validateMenu` / `validatePalette`) | **every** layer's result, before use | ~0 |

`quickLoad()` (inside `start()`) only runs layers 1–2 and returns `false` when neither validates, so
`start()` never pays for bytecode indexing. `deepResolve()` (background worker) runs layer 3 and falls
back to layer 4.

Every layer is **validated by reflection** before use — helper signature (`hookMethod`'s exact
parameter list), scope bridge (`MenuFlyoutScope.item(onClick, content)` as a static
`(self, Function0, Function2)V`), palette getter — so a stale name is never trusted. A structural
result is *additionally* cross-checked against any built-in profile that still validates: on a known
build both paths must agree exactly, and a disagreement is logged as a `WARNING` instead of being
silently averaged.

Two host facts the whole resolution chain works around:

- **The jar's zip entry names cannot be trusted.** Several entries are stored under a name that
  differs from the class they contain (`androidx/compose/ui/Ϡ.class` holds `…/ϡ`), so candidates are
  identified by the `this_class` parsed out of the class file, never by the entry path. Both the index
  and the legacy scan honour this.
- **`java.class.path` is a single polyglot jar** (`app/ffmpeg-x64.dll`, 111 MB, 42147 classes,
  readable with `ZipFile`). Structural discovery prefers the host class's own code source
  (`HostBytecodeIndex.read(hostClass)`) and only falls back to `java.class.path` when that is
  unreadable.

### Known profiles — regression baseline, not the adaptation mechanism

| build | menu facade | helper | MenuFlyoutScope (bridge) | PopupState (dismiss) |
| --- | --- | --- | --- | --- |
| 1.19.0 | `androidx.compose.ui.ē` (U+0113) | `Ϳ` | `androidx.compose.ui.ন` (U+09A8) / `Ϳ` | `androidx.compose.ui.Ⴈ` (U+10A8) / `ԩ` |
| 1.19.2 | `androidx.compose.ui.घ` (U+0918) | `Ϳ` | `androidx.compose.ui.Ը` (U+0538) / `Ϳ` | `androidx.compose.ui.ะ` (U+0E30) / `ԩ` |
| 1.19.3 | `androidx.compose.ui.ɦ` (U+0266) | `Ϳ` | `androidx.compose.ui.त` (U+0924) / `Ϳ` | `androidx.compose.ui.ל` (U+05DC) / `ԩ` |

**These rows are kept on purpose, but their job has changed.** Since v0.4.6 a profile is:

- a **regression baseline** — on a build we already pinned, structural discovery must reproduce it
  character for character; a mismatch is logged as a warning, which turns "did the discovery logic
  regress?" into a single log line instead of a bug report;
- a **zero-cost fast path** — on a known build `quickLoad()` resolves from the profile without
  touching bytecode at all (measured 53–57 ms including reflection validation), so users on a pinned
  build never pay the index cost;
- **no longer the adaptation mechanism** — an unknown build needs no new row. Adding a profile is
  now optional housekeeping (pin a build to skip its first index), never a prerequisite for a
  release.

Verified on 1.19.3 (Steam build, 2026-10-30) from the same `ffmpeg-x64.dll`:
`ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)Unit`, scope impl `গ$Ϳ` (items list field `Ϳ`),
flyout content colour still `ʰ.Ԩ(composer).Ԩ()`; playback-controls and tray reflection unchanged.

**The classpath scan had a latent bug until v0.4.5** — kept as history, because it explains the log
lines users may still find in older reports, and because it is the reason the *legacy* scan is now
layer 4 rather than the main path. `menuCandidates()` passed `ParsedClass.name` — the raw
`this_class` value, i.e. the JVM *internal* form with `/` separators
(`androidx/compose/ui/ɦ`) — straight into `MenuTarget.menuClass`. `validateMenu()` then called
`Class.forName()` on that dotted-expected string, threw `ClassNotFoundException`, and the scan
reported `found no flyout helper` on **every** unknown host build. Every build so far had a
built-in profile, so the bug never showed; 1.19.3 renamed all three classes and exposed it
(the scan found the candidate but could not validate it). Fixed by
`cls.name.replace('/', '.')` at the construction site.

v0.4.6 sidesteps this whole failure mode: structural discovery does its own one-way conversion from
internal to binary names (`HostMenuDiscovery` emits dotted names only, and `popupStateClass` strips the
`L…;` descriptor wrapper), and its result still goes through the same `validateMenu()` guard. The
legacy scan remains only as the layer-4 second opinion for builds where the JDK class-file API cannot
parse the host image.

The **playback-controls** reflection (`FoliaPlaybackControls.kt`) needed no change in 1.19.2 or
1.19.3 — `PlaybackQueueState`'s field order and `com.xuncorp.spc.core.queue.Ϳ` survived both
renames.

Log lines to look for in `spw-folia.log`:

```
host menu profile:1.19.3: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)
hookMethod installed: … (profile:1.19.3)
Folia item appended (scope=androidx.compose.ui.গ$Ϳ, bridge=Ϳ)
```

An unknown build logs the structural path instead (real output, 1.19.3, 2026-10-30):

```
host structural index: com.xuncorp.pisces.PiscesMediaItem: 28058 method bodies (1313ms)
host structural matches regression baseline profile:1.19.3
host menu structural: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त) scope=androidx.compose.ui.त.Ϳ (1313ms, 28058 bodies)
host palette structural: androidx.compose.ui.ʹ.Ԩ() via androidx.compose.ui.ʰ.Ԩ
```

`host structural matches regression baseline …` is the line that makes a known build self-checking:
absent it, look for `WARNING: structural discovery disagrees with <profile>`, which prints both
candidates' names **and** their `scopeParameter`/`popupParameter` indices. When discovery fails
outright, `lastDiagnostics` carries the per-role candidate census
(`structural(indexMs=… bodies=… candidates=[owner=1,popup=1,…])`) plus the discovery's own diagnostic
lines — that is the block to ask a user for.

## 结构发现（structural discovery，v0.4.6+）

这是 v0.4.6 的主路径：不读任何混淆名，改为**解析宿主自己的字节码、按结构约束逐个角色定位**。
实现分两层，都在 `spw-folia/src/main/kotlin/dev/spw/folia/`：

| 文件 | 职责 |
| --- | --- |
| `HostBytecodeIndex.kt` | 只读索引：用 JDK 25 的 `java.lang.classfile` API 解析宿主 jar，建立「方法体 → 调用点 / 字段访问」的调用图。**从不加载或初始化宿主类**，只读字节。 |
| `HostMenuDiscovery.kt` | 在索引上跑发现链，输出 6 个必需角色 + 2 个可选角色，全部是点分二进制名。 |

设计来源是 SPW-Lyrics（<https://github.com/GaBoron/SPW-Lyrics>，`integration/hostui/HostBytecodeIndex.java` +
`HostPlayerMenuDiscovery.java`）；它的 `docs/开发说明.md`「主窗口 Hook 与动态发现」一节明确写了同一套纪律
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
绝不 best-effort 挑一个。理由是错的后果不对称 —— 在宿主里调错方法会静默污染弹层，而抛错只是
「这一版没有 Folia 项 + 一条可读日志」。异常被 `HostTargets.structuralResolve` 捕获、记日志、
退回第 4 层 `scan()`，**不会**让插件启动失败。

可选角色（`label` / `palette`）走另一条纪律：失败或候选不唯一时降级为 `null` 并写诊断行
（`FoliaMenuItem` 有常量颜色兜底），只有「必需角色」才允许整体失败。

### 为什么要收紧 SPW-Lyrics 的 builder 规则

SPW-Lyrics 原版的 builder 规则只看「static + 返回 `kotlin.Unit` + 参数里没有 `Composer` + 方法体
调用了 itemBridge」。**这条规则在 SPW 1.19.3 上有 15 个候选** —— 它对 SPW 自己的菜单结构约束太弱，
照抄过来完全不可用。

v0.4.6 的收紧版在同样四个条件之外，还要求参数表里**同时**出现下面六个锚点：

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

真实 1.19.3 宿主（`app/ffmpeg-x64.dll`，111 MB，**42147 个 class**）实测：

| 指标 | 实测值 |
| --- | --- |
| 索引到的**方法体**数 | **28058**（约 2.8 万；预筛只解析引用了 Compose runtime 的类） |
| 索引耗时 | **1313 ms**（多次运行区间约 **1.3–1.5 s**） |
| 发现本身（索引建好之后） | 约 70–92 ms |
| 已知版本走 profile（对照） | 53–57 ms，**零字节码成本** |

**红线：约 1.3–1.5 s 的索引绝不允许进 `start()` 同步路径。** 它只在 `deepResolve()` 里跑，而
`deepResolve()` 只由 `installHookForHostBuild()` 起的 `spw-folia-target-resolve` 守护线程调用；
`quickLoad()`（唯一在 `start()` 内被调用的解析入口）只碰缓存与 profile。索引结果写入
`host-targets.json`，**同一版本之后每次启动都是零成本**，不会重复索引。

索引可协作取消（`HostBytecodeIndex.read(source, isCancelled)` 轮询线程中断标志），宿主退出时
不会留下一个还在啃 111 MB zip 的线程。

### 边界（如实写）

- **能适应重命名。** 宿主下一次 R8 把 `ɦ`/`ל`/`त` 再改成别的字形，发现链不受影响 —— 它一个
  混淆名都不读。这正是本方案要解决的问题。
- **不能适应页面结构重构。** 如果宿主不再用 `BlurPopupMenu` 这类弹层（第 2 步的形状变了），
  或者「更多」弹层不再从 `Track` / `PiscesMediaItem` 取数（第 6 步的锚点没了），结构约束就会
  失效：候选不唯一或为零 → 抛错 → 退回 `scan()` → 仍失败则记 `could not locate the 更多 flyout`
  并让 Folia 项缺失（其余功能不受影响）。**这种情况需要重新适配，不是自动就能活的。**
  SPW-Lyrics 自己也承认这条边界（其 `docs/常见问题.md`：「动态发现能适应重命名，但不保证任意
  页面结构变化后都能继续接入」）。
- **不做 best-effort。** 见上「纪律」一节。

### 缓存文件 `host-targets.json`（v0.4.6 新增字段）

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

两个实现细节值得记下来，它们都是踩过的坑：

- **调色板的键叫 `paletteTarget` 而不是 `palette`。** 项目自带的 `Json.rawField` 不做层级区分，
  只返回**第一个**文本匹配，而 `structural.candidateCounts` 里也有一个 `palette` 键（候选计数）——
  同名会读出数字而不是对象。读取侧仍兼容旧缓存里的 `palette` 键，但只在它的值真的是对象时采用。
- **缓存命中仍要 `validateMenu` / `validatePalette`。** 缓存可能来自另一个宿主版本或一个有 bug 的
  发行版，不校验就等于信任磁盘上的字符串。

## What the menu is

The 更多 button in the mini player opens a `PopupState` flyout rendered by `PlayerMoreMenuFlyout`
(original file: `com/xuncorp/voxzen/ui/player/popup/PlayerMoreMenuFlyout.kt`, runtime file facade
`androidx.compose.ui.ē` in 1.19.0 — `घ` in 1.19.2, `ɦ` in 1.19.3). It shows 4 items: 播放速度 /
桌面歌词 / 歌词翻译(checked) / 释放音频引擎 (screenshot 2).

*The glyphs in this section are the 1.19.0 ones because that is the build the decompilation was
done on. What matters for v0.4.6 is the **shape**: the same roles are rediscovered on any build by
structure alone — see 「结构发现」 above.*

Decompiled: `work/host/dec_more/androidx/compose/ui/ē.kt`. Its composable (line ~96) calls the
Blur.kt file facade `com.xuncorp.voxzen.ui.component.Ԭ` (Ԭ = U+052C):

```
BlurPopupMenu(onDismissRequest /*Function0*/, header /*Function2?*/, content /*MenuFlyoutScope.()->Unit*/)
```

The 4 items are appended by a **private static helper in the same class** (the content-builder
lambda body), javap signature:

```java
private static final kotlin.Unit Ϳ(com.xuncorp.voxzen.data.entity.Track,
                                   com.xuncorp.pisces.PiscesMediaItem,
                                   androidx.compose.ui.Ⴈ,          // PopupState
                                   com.xuncorp.voxzen.ui.navigation.Navigator,
                                   androidx.compose.runtime.State, // State<PiscesPlayer.State>
                                   androidx.compose.ui.ন)          // MenuFlyoutScope
```

It appends items through the Kotlin default-argument static bridge
`androidx.compose.ui.ন.Ϳ(ন scope, Function0 onClick, Function2 content)` (the menu item's
`@Composable` content lambda), i.e. host items go through the same bridge we reuse.

## FINAL SOLUTION (implemented, registration verified)

`hookMethod` needs only JVM class name + JVM method name + full **business** parameter type list —
no Kotlin names, no `@Metadata` association:

```kotlin
WorkshopApi.hookRegistrar.hookMethod(
    "androidx.compose.ui.ē",                    // PlayerMoreMenuFlyoutKt file facade
    "\u037f",                                   // obfuscated JVM name of the item-adding helper
    listOf(
        "com.xuncorp.voxzen.data.entity.Track",
        "com.xuncorp.pisces.PiscesMediaItem",
        "androidx.compose.ui.\u10a8",           // PopupState (Ⴈ)
        "com.xuncorp.voxzen.ui.navigation.Navigator",
        "androidx.compose.runtime.State",
        "androidx.compose.ui.\u09a8",           // MenuFlyoutScope (ন)
    ),
    object : MethodHook() {
        override fun after(call: MethodHookParam) {
            // v0.4.6: indices come from the resolved target (scopeParameter/popupParameter), not
            // from a hardcoded args[5]/args[2]. The 1.19.x profiles carry 5 and 2; structural
            // discovery derives them from the builder's parameter list.
            val scope = call.args[target.scopeParameter]        // MenuFlyoutScope
            appendItem(scope, call.args[target.popupParameter]) // dedupe + reflect bridge below
        }
    }
)
```

Inside `after` (runs on the composition thread right after the 4 host items are appended):

```kotlin
val scopeCls = Class.forName("androidx.compose.ui.\u09a8")
val bridge = scopeCls.getDeclaredMethod(
    "\u037f", scopeCls, Function0::class.java, Function2::class.java)
bridge.isAccessible = true
val onClick: () -> Unit = { dismissPopup(); openFoliaWindow() }
val content: @Composable () -> Unit = { BasicText("Folia") }   // runtime type = Function2<Composer,Int,Unit>
bridge.invoke(null, scope, onClick, content)
```

- Dedupe: the scope implementation keeps items in a mutable list field `Ϳ` (U+037F); use it as a
  `WeakHashMap` key so recomposition does not add duplicate items. The field is found **by type**
  (first non-static `java.util.List` field), not by name, so a rename cannot break it.
- Dismiss: `PopupState.ԩ()` (ԩ = U+0529) = no-arg void method, resolved reflectively.
- Argument indices: read from `MenuTarget.scopeParameter` / `.popupParameter`, and range-checked
  against `call.args.size` before use — a reshuffled signature logs
  `after: argument indices out of range …` instead of silently feeding us the wrong argument.
- Compile requirements: plugin applies `org.jetbrains.kotlin.plugin.compose` (Kotlin 2.4.20) and
  declares `compileOnly` compose runtime/foundation/material3 (`androidx.compose.*` classes are
  host-provided; **never bundle** a second Compose runtime in `lib/`).
- Verified: plugin log shows `hookMethod installed: com.xuncorp.voxzen.workshop.hooks.ԩ$ԯ@…` then
  `start done`; hook-poc evidence under `poc/hook/shots/`. Menu-open verification is the current
  remaining check (see task board).

## 托盘菜单（最小化图标右键）：`RecordingComposableScope.snapshot()` hook

Status: **implemented v0.4.0** (2026-10-24), owner `tray-menu`. 新增
`spw-folia/src/main/kotlin/dev/spw/folia/FoliaTrayMenu.kt`，在托盘右键菜单里插入一行 **Folia**，
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
和 更多 弹层的做法一致：`hookMethod` + JVM 名字 + 参数类型列表，零编译期依赖。

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
已用 `Instrumentation` agent 验证：`isModifiableClass(RecordingComposableScope) == true`、
`retransformClasses` 不抛异常（`work/tray/agent/ModifiableProbe.java`）。

### 仍未经端到端验证的一步

静态证据只到「`snapshot()` 在 `ComposableTrayKt.rememberRecordedMenuContent` 里有且仅有一处调用」。
**安装版宿主在真机上是否真的走到这条录制路径**还没有被观测过（GUI 宿主无法在本环境无头驱动）。
验收时按下面三步确认（插件已装、`enabled.txt` 含 `dev.spw.folia`、`permissions.json` 已授
`class-transform`）：

1. 启动 SPW，等插件 `start done` 后看 `…\workshop\plugins\<…>\plugin\spw-folia.log`，应出现
   `tray hook installed: dev.nucleusframework.composenativetray.menu.impl.RecordingComposableScope.snapshot() …`
   （没有这行 = 目标解析失败，看紧跟的 `WARNING: tray menu item disabled: …`）。
2. 最小化 SPW 到托盘，右键托盘图标：菜单里「桌面歌词」下方应出现一条 **Folia**；
   若在播歌期间「锁定桌面歌词」存在，则 Folia 在它下面、同一栏内。
3. 点该 Folia 项 → Folia 窗口打开；日志追加 `tray: Folia item clicked`。再开合托盘菜单 2–3 次，
   确认 Folia 行**不重复**、日志里 `tray: Folia item recorded at index …` 只出现一次。

## appendContent: why it fails on this host build (historical)

The earlier plan was `appendContent(className="…Ԭ", methodName="\u037f", inClass="androidx.compose.ui.ē",
parameter="content", scopeType=Class.forName("…ন"), parameterTypes=[F0,F2,F1], …)`. It always throws
`UI call missing or ambiguous: androidx.compose.ui.ē -> com.xuncorp.voxzen.ui.component.Ԭ.BlurPopupMenu (0 calls)`.

Root cause (decoded from host bytes, `work/host/dec_ws/.../hooks/Ԫ.kt` = WorkshopHookTargets and the
registrar): the engine resolves the target call, then requires `parameter` to be one of the target's
**business parameter names** (`UiTarget.names`). Those names come from (a) JVM `MethodParameters`
attributes or (b) Kotlin `@Metadata` functions — and for (b) the metadata's *original* JVM method
signature must match the runtime method name. R8 renamed the JVM methods (all composables share the
name `Ϳ`, U+037F) while `@Metadata` still stores the original names (`BlurPopupMenu`,
`MenuFlyoutItemCompat`, …), so no function associates → `names` are all empty strings →
`indexOf("content") = -1` → exception (bytecode check requires index ≥ 0 **and** that param's type
be `kotlin.jvm.functions.Function1`). Also no `MethodParameters` attribute is emitted. This is a host
build limitation for *all* plugins, not specific to our target.

Consequence: never rely on Kotlin names against SPW 1.19.0 targets; use `hookMethod` with JVM names +
parameter types, or `replaceComposable`/`afterComposable` (those resolve the *call site* by JVM name +
parameter types and do not need parameter names).

## Fallback plans if the helper hook ever breaks

- Plan B: `replaceComposable(className="com.xuncorp.voxzen.ui.component.Ԭ", methodName="\u037f",
  inClass="androidx.compose.ui.ē", parameterTypes=[F0,F2,F1], …)` and re-implement the 4 host items +
  Folia item inside our own Composable (host singletons via reflection: `PlaybackController.INSTANCE`,
  `AppConfig.INSTANCE`, navigator; see `docs/archive/re-host.md`).
- Plan C: `replaceComposable` on `PlayerMoreMenuFlyout` at its call site inside
  `com.xuncorp.voxzen.ui.player.mini.֏` (MiniPlayerMenu.kt) — same effect, different injection point.
- Plan D: hook `MenuFlyoutScope` item append implementation instead of the builder helper (harder:
  needs to detect the host's 4th item to append after it).
- Diagnostics: host exceptions surface in `…\Salt Player for Windows\logs.txt`; the plugin also writes
  `spw-folia.log` in its own install dir.

## Re-derivation recipes (if the target changes with an SPW update)

**Since v0.4.6 you normally do not need any of this.** Structural discovery resolves an unknown build
by itself; these recipes are only for (a) pinning a new build with an optional profile, (b)
diagnosing a discovery failure (i.e. the host's page structure really changed), or (c) hand-verifying
a discovery result.

1. Class-name→original-source map: `work/host/smap.json` (17,661 obfuscated classes → `.kt` file names).
   `PlayerMoreMenuFlyout.kt → androidx/compose/ui/ē.class`, `Blur.kt → com/xuncorp/voxzen/ui/component/Ԭ.class`.
2. Extract classes: Python `zipfile` on
   `C:\Program Files\WindowsApps\Sakawish.SaltPlayerforWindows_1.19.0.0_x64__q65q631pyh094\app\ffmpeg-x64.dll`
   (polyglot jar; `unzip` fails). Then `java -jar work/host/vineflower.jar -dgs=1 <inDir> <outDir>` → `.kt`.
3. javap (JDK 25): `"/c/Program Files/Java/jdk-25.0.2/bin/javap.exe" -J-Dstdout.encoding=UTF-8 -p -s <file>`
   (write to file + read as UTF-8; console garbles the obfuscated unicode names).
4. Decode Kotlin `@Metadata` d1/d2 (original names, but renamed JVM signatures): `work/host/tools/`
   `ParseMeta.java` / `ListMethods.java` / `ResolveTest.java` (compile+run against the polyglot jar
   directly), dumps `work/host/d2_dump.txt`, `work/host/blur_d2_strings.txt`.
5. All jar entries: `work/host/entries.txt`.
6. **Faster than 1–5 for a new build: read the plugin log.** `host structural index: … (N method
   bodies, Mms)` then `host menu structural: …` already gives the dotted names and the parameter list.
   Only if the log shows a discovery failure do you need the decompile recipes above — and then the
   useful artifact is `lastDiagnostics` (the per-role candidate census), not the names.

## Codepoints (copy-paste safety)

| glyph | codepoint | name / role |
|---|---|---|
| ē | U+0113 | PlayerMoreMenuFlyoutKt file facade (1.19.0) |
| ঘ | U+0918 | PlayerMoreMenuFlyoutKt file facade (1.19.2) |
| ɦ | U+0266 | PlayerMoreMenuFlyoutKt file facade (1.19.3) |
| Ԭ | U+052C | Blur.kt file facade |
| ন | U+09A8 | MenuFlyoutScope interface (1.19.0) |
| Ը | U+0538 | MenuFlyoutScope interface (1.19.2) |
| त | U+0924 | MenuFlyoutScope interface (1.19.3) |
| Ϳ | U+037F | shared obfuscated JVM method name (builder helper, scope item bridge, list field) |
| ઠ | U+0AA0 | host menu-item content lambda factories |
| Ⴈ | U+10A8 | PopupState (1.19.0) |
| ะ | U+0E30 | PopupState (1.19.2) |
| ל | U+05DC | PopupState (1.19.3) |
| ԩ | U+0529 | PopupState.dismiss() |
| ʰ | U+02B0 | palette accessor facade (`ʰ.Ԩ(composer).Ԩ()`) |
| Ԩ | U+0528 | palette accessor method **and** content-colour getter |
| ʹ | U+0374 | palette object class |

Since v0.4.6 these glyphs are **only regression baselines and copy-paste aids**. No code path
*requires* them: structural discovery derives every name from bytecode structure, so a build with
entirely different glyphs still resolves. Treat the table as "what the discovery must reproduce on
these three builds", not as a lookup the plugin depends on.
