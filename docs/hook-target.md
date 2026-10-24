# Hook target: inject "Folia" items into SPW menus (mini-player 更多 + tray right-click, SPW 1.19.0+)

Two independent hooks, both resolved at runtime:

| menu | hook | file |
| --- | --- | --- |
| mini-player 更多 flyout | `hookMethod` on the host's obfuscated item-adding helper | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` |
| tray (minimised icon) right-click | `hookMethod` on `compose-native-tray`'s `RecordingComposableScope.snapshot()` | `spw-folia/src/main/kotlin/dev/spw/folia/FoliaTrayMenu.kt` |

The flyout hook is described first; the tray hook is the section
[托盘菜单（最小化图标右键）](#托盘菜单最小化图标右键recordingcomposablescopesnapshot-hook).

## 更多 弹层（mini-player）：`hookMethod` on the item-adding helper

Status: **version-independent since v0.3.1** (2026-10-23). The obfuscated names below are *data*, not
code: `HostTargets` resolves them per host build and caches the result, so a new SPW patch release no
longer needs a plugin release.

The working approach is **`hookMethod` on the host's item-adding helper**; the originally planned
`appendContent` is **impossible on this R8-obfuscated host build** (root cause below). Implemented
in `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` (owner: hook-poc). Deep background:
`docs/archive/re-host.md`.

## Resolution layers (v0.3.1+)

SPW is R8-obfuscated, so **every release renames the classes and methods we touch** — 1.19.2 kept the
structure but renamed `ē`/`ন`/`Ⴈ` to `घ`/`Ը`/`ะ`. The plugin therefore resolves its targets at
runtime (`spw-folia/src/main/kotlin/dev/spw/folia/HostTargets.kt`):

| layer | when | cost |
| --- | --- | --- |
| `host-targets.json` cache (keyed by `spwVersion`) | every start after the first success on that build | ~0 |
| built-in profile (`PROFILES`: 1.19.2, 1.19.0) | known builds | ~0 |
| structural classpath scan | unknown build — background thread, does not stall start-up | ~0.5–2 s once |

Every layer is **validated by reflection** before use (helper signature + scope bridge + palette
getter), so a stale name is never trusted. The scan finds the helper by shape —
`(Track, PiscesMediaItem, <PopupState>, Navigator, State, <MenuFlyoutScope>)` is unique in the host
and three of those types are not obfuscated — then splits the two `androidx.compose.ui.*` parameters
by looking for the interface that carries the Kotlin default-argument item bridge.

Two host facts the scan works around:

- **The jar's zip entry names cannot be trusted.** Several entries are stored under a name that
  differs from the class they contain (`androidx/compose/ui/Ϡ.class` holds `…/ϡ`), so candidates are
  identified by the `this_class` parsed out of the class file, never by the entry path.
- **`java.class.path` is a single polyglot jar** (`app/ffmpeg-x64.dll`), readable with `ZipFile`.

### Known profiles

| build | menu facade | helper | MenuFlyoutScope (bridge) | PopupState (dismiss) |
| --- | --- | --- | --- | --- |
| 1.19.0 | `androidx.compose.ui.ē` (U+0113) | `Ϳ` | `androidx.compose.ui.ন` (U+09A8) / `Ϳ` | `androidx.compose.ui.Ⴈ` (U+10A8) / `ԩ` |
| 1.19.2 | `androidx.compose.ui.घ` (U+0918) | `Ϳ` | `androidx.compose.ui.Ը` (U+0538) / `Ϳ` | `androidx.compose.ui.ะ` (U+0E30) / `ԩ` |

Verified on 1.19.2 (Steam build) from `…/Salt Player for Windows/app/ffmpeg-x64.dll`:
`घ.Ϳ(Track, PiscesMediaItem, ะ, Navigator, State, Ը)Unit`, scope impl `ʎ$Ϳ` (items list field `Ϳ`),
flyout content colour still `ʰ.Ԩ(composer).Ԩ()`. The **playback-controls** reflection
(`FoliaPlaybackControls.kt`) needed no change — `PlaybackQueueState`'s field order and
`com.xuncorp.spc.core.queue.Ϳ` survived the rename.

Log lines to look for in `spw-folia.log`:

```
host menu profile:1.19.2: androidx.compose.ui.घ.Ϳ(Track, PiscesMediaItem, ะ, Navigator, State, Ը)
hookMethod installed: … (profile:1.19.2)
Folia item appended (scope=androidx.compose.ui.ʎ$Ϳ, bridge=Ϳ)
```

`unsupported SPW version …` appears only below 1.19.0. An unknown newer build logs
`scanning the host classpath in the background`, then either the resolved target or
`could not locate the 更多 flyout`.

## What the menu is

The 更多 button in the mini player opens a `PopupState` flyout rendered by `PlayerMoreMenuFlyout`
(original file: `com/xuncorp/voxzen/ui/player/popup/PlayerMoreMenuFlyout.kt`, runtime file facade
`androidx.compose.ui.ē`, ē = U+0113). It shows 4 items: 播放速度 / 桌面歌词 / 歌词翻译(checked) /
释放音频引擎 (screenshot 2).

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
            val scope = call.args[5]            // MenuFlyoutScope
            appendItem(scope, call.args[2])     // dedupe + reflect bridge below
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
  `WeakHashMap` key so recomposition does not add duplicate items.
- Dismiss: `PopupState.ԩ()` (ԩ = U+0529) = no-arg void method, resolved reflectively.
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

## Codepoints (copy-paste safety)

| glyph | codepoint | name / role |
|---|---|---|
| ē | U+0113 | PlayerMoreMenuFlyoutKt file facade |
| Ԭ | U+052C | Blur.kt file facade |
| ন | U+09A8 | MenuFlyoutScope interface |
| Ϳ | U+037F | shared obfuscated JVM method name (builder helper, scope item bridge, list field) |
| ઠ | U+0AA0 | host menu-item content lambda factories |
| Ⴈ | U+10A8 | PopupState |
| ԩ | U+0529 | PopupState.dismiss() |
