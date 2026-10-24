@file:OptIn(UnstableSpwWorkshopApi::class)

package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.WorkshopApi
import com.xuncorp.spw.workshop.api.hook.HookHandle
import com.xuncorp.spw.workshop.api.hook.MethodHook
import com.xuncorp.spw.workshop.api.hook.MethodHookParam
import java.lang.reflect.Constructor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Folia" entry in SPW's tray (minimised-icon) right-click menu, in the same section as 桌面歌词.
 *
 * ## Why this target
 * SPW builds its tray menu with the bundled `compose-native-tray` library:
 * `AppTray.kt` (obfuscated host class, `androidx.compose.ui.Ƌ` in 1.19.2) calls
 * `Tray(..., menuContent = { ... })`, whose body composes `Item(显示主窗口)`, `Divider`,
 * `CheckableItem(桌面歌词)`, [`CheckableItem(锁定桌面歌词)`], `Divider`, transport items,
 * `Divider`, `Item(退出)`.
 *
 * `menuContent` is a `ComposableTrayMenuScope` lambda, and the library bridges it to the native
 * Win32 menu in two steps:
 *  1. `rememberRecordedMenuContent(menuContent)` (ComposableTrayKt) creates a
 *     `RecordingComposableScope`, runs the host lambda against it — every `Item`/`CheckableItem`/
 *     `Divider` call appends one `MenuOp` to its private `SnapshotStateList` — then calls
 *     `scope.snapshot()` which returns `ops.toList()` (a fresh `java.util.List`).
 *  2. `asTrayMenuBuilderBlock(snapshot)` turns that list into a `TrayMenuBuilder` block
 *     (`PlainItem` → `Item(label, enabled, shortcut, onClick)`), which
 *     `WindowsTrayInitializer`/`WindowsTrayManager` replay into native menu handles.
 *
 * So an `after` hook on `RecordingComposableScope.snapshot()` can rewrite the recorded op list
 * before it is turned into native items — no compile-time dependency on the library, no need to
 * touch the obfuscated host class that builds the tray, and no Win32 handle juggling. The inserted
 * op is a plain `MenuOp.PlainItem("Folia", ...)`, the same op type the host's own `Item(退出)`
 * produces, which is why it renders as a normal row of the menu and behaves as a sibling of
 * 桌面歌词 in the native menu.
 *
 * ## Why it is safe
 * - `snapshot()` is also called for *nested submenu* scopes; a scope whose ops contain a
 *   `*SubMenu` op, or none of the checkable ops, is left untouched. 桌面歌词 is the only
 *   checkable in SPW's tray menu, so "after the run of checkable ops" is exactly "the 桌面歌词
 *   section" without hardcoding any localised label text.
 * - `snapshot()` returns `ops.toList()`, i.e. a throw-away copy: appending to the list we hand back
 *   via `call.setResult` never mutates the recorded ops, so recomposition cannot accumulate
 *   duplicate rows (the menu is rebuilt from a clean recording every time).
 * - Everything is reflective and wrapped in `runCatching`: on a host build where any of these
 *   names changed, [install] logs one warning and the plugin keeps working with the flyout item.
 *
 * ## Called on every composition, from any thread
 * `snapshot()` is invoked once per tray-menu recording, not once per process: every tray menu open
 * (and every recomposition that invalidates the remembered content) calls it again, on whatever
 * thread Compose is composing. [inject] is therefore a **pure function of its input**:
 * - it never mutates `ops` (which is `ops.toList()`, a throw-away copy) — it builds a new
 *   `ArrayList` and hands that back via [MethodHookParam.setResult];
 * - there is **no static mutable state**: the only write-once state is the per-instance
 *   `@Volatile plainItemCtor` plus two `AtomicBoolean`s, and none of them retains an op;
 * - the injected `Function0` is created fresh per call ([foliaClickAction]); it captures this
 *   manager and the `openFolia` lambda, both long-lived and stateless, so sharing it is safe;
 * - the hook body is a single `try/catch (Throwable)` (see `install`), so a failure inside
 *   [inject] can never propagate into the host's tray composition.
 */
internal class FoliaTrayMenu(
    private val log: (String) -> Unit,
    private val openFolia: () -> Unit,
) {

    private var handle: HookHandle? = null

    /** Reflectively resolved `MenuOp.PlainItem(String, boolean, KeyShortcut, Function0)` ctor. */
    @Volatile
    private var plainItemCtor: Constructor<*>? = null

    private val installed = AtomicBoolean(false)
    private val warned = AtomicBoolean(false)

    /** One-shot latch: the success line is written once per process, not once per tray-menu open. */
    private val loggedInjection = AtomicBoolean(false)

    /**
     * Installs the tray hook. Returns true when the hook is live.
     *
     * Fails soft: a single warning line is logged (no toast) and the flyout hook is untouched.
     */
    fun install(): Boolean {
        if (installed.get()) return true
        val reason = when {
            !resolveClasses() -> "target classes missing"
            else -> null
        }
        if (reason != null) {
            warn("WARNING: tray menu item disabled: $reason on this host build")
            return false
        }
        val ctor = plainItemCtor ?: return false
        val result = runCatching {
            WorkshopApi.hookRegistrar.hookMethod(
                SCOPE_CLASS,
                SNAPSHOT_METHOD,
                emptyList(),
                object : MethodHook() {
                    override fun after(call: MethodHookParam) {
                        try {
                            inject(call)
                        } catch (t: Throwable) {
                            log("tray: inject error: ${t::class.java.name}: ${t.message}")
                        }
                    }
                }
            )
        }
        return result.fold(
            onSuccess = {
                handle = it
                installed.set(true)
                log(
                    "tray hook installed: $SCOPE_CLASS.$SNAPSHOT_METHOD() -> " +
                        "MenuOp\$PlainItem(\"Folia\") after the 桌面歌词 checkable ($it)"
                )
                true
            },
            onFailure = {
                warn("WARNING: tray menu item disabled: hook registration failed: ${it::class.java.name}: ${it.message}")
                false
            }
        )
    }

    fun uninstall() {
        runCatching { handle?.unhook() }.onFailure { log("tray unhook failed: $it") }
        handle = null
        installed.set(false)
        loggedInjection.set(false)
    }

    // ------------------------------------------------------------ internals ----

    /**
     * Verifies that this host build still has the recording plumbing and resolves the item ctor.
     * Unknown / renamed classes leave [plainItemCtor] null and the hook is not attempted.
     */
    @Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN") // the host method is declared as java.util.List
    private fun resolveClasses(): Boolean {
        val scope = runCatching { Class.forName(SCOPE_CLASS) }.getOrNull()
        if (scope == null) {
            log("tray: $SCOPE_CLASS not on the host classpath")
            return false
        }
        val snapshot = runCatching { scope.getDeclaredMethod(SNAPSHOT_METHOD) }.getOrNull()
        if (snapshot == null || !java.util.List::class.java.isAssignableFrom(snapshot.returnType)) {
            log("tray: $SCOPE_CLASS.$SNAPSHOT_METHOD() has an unexpected shape on this build")
            return false
        }
        val keyShortcut = runCatching { Class.forName(KEY_SHORTCUT_CLASS) }.getOrNull()
        val function0 = runCatching { Class.forName("kotlin.jvm.functions.Function0") }.getOrNull()
        if (keyShortcut == null || function0 == null) {
            log("tray: KeyShortcut/Function0 missing on the host classpath")
            return false
        }
        val itemClass = runCatching { Class.forName("$MENU_OP_CLASS\$PlainItem") }.getOrNull()
        if (itemClass == null) {
            log("tray: $MENU_OP_CLASS\$PlainItem missing on this build")
            return false
        }
        val ctor = runCatching {
            itemClass.getDeclaredConstructor(
                String::class.java,
                java.lang.Boolean.TYPE,
                keyShortcut,
                function0
            ).apply { isAccessible = true }
        }.getOrNull()
        if (ctor == null) {
            log("tray: unexpected MenuOp.PlainItem constructor on this build")
            return false
        }
        plainItemCtor = ctor
        return true
    }

    /**
     * Rewrites the recorded op list: our plain item goes right after the 桌面歌词 section, i.e.
     * after the consecutive run of checkable ops that starts at the first checkable.
     */
    private fun inject(call: MethodHookParam) {
        val ctor = plainItemCtor ?: return
        val ops = call.result as? List<*> ?: return
        if (ops.isEmpty()) return

        // Nested submenu scopes are recorded by the very same class; never touch them.
        if (ops.any { isSubMenu(it) }) return

        val firstCheckable = ops.indexOfFirst { isCheckable(it) }
        if (firstCheckable < 0) {
            // Not the host's tray menu content (or the checkable layout changed): stay out.
            if (warned.compareAndSet(false, true)) {
                log("tray: recorded scope has no checkable op; tray item not injected (host layout changed?)")
            }
            return
        }
        var insertAt = firstCheckable + 1
        while (insertAt < ops.size && isCheckable(ops[insertAt])) insertAt++

        if (ops.any { isFolia(it) }) return

        val item = ctor.newInstance("Folia", java.lang.Boolean.TRUE, null, foliaClickAction())
        val merged = ArrayList<Any?>(ops.size + 1)
        for (i in 0 until insertAt) merged.add(ops[i])
        merged.add(item)
        for (i in insertAt until ops.size) merged.add(ops[i])
        call.setResult(merged)
        // Log only the first time: this runs on the composition thread for every tray menu open, and
        // log() appends to a file — no need to pay for that on each open.
        if (loggedInjection.compareAndSet(false, true)) {
            log("tray: Folia item recorded at index $insertAt/${ops.size} (after 桌面歌词 section)")
        }
    }

    /**
     * The click callback handed to the native menu. The tray menu runs on the Win32 message-loop
     * thread, and opening Folia spawns the WebView2 helper (blocking), so hop to our own thread.
     */
    private fun foliaClickAction(): () -> Unit = {
        log("tray: Folia item clicked")
        val worker = Thread({
            try {
                openFolia()
            } catch (t: Throwable) {
                log("tray: Folia click failed: ${t::class.java.name}: ${t.message}")
            }
        }, "spw-folia-tray-click")
        worker.isDaemon = true
        worker.start()
    }

    private fun isFolia(op: Any?): Boolean =
        op != null && op.javaClass.name == "$MENU_OP_CLASS\$PlainItem" && runCatching {
            op.javaClass.getMethod("getLabel").invoke(op) as? String
        }.getOrNull() == FOLIA_LABEL

    private fun isCheckable(op: Any?): Boolean =
        op != null && op.javaClass.name in CHECKABLE_OPS

    private fun isSubMenu(op: Any?): Boolean =
        op != null && op.javaClass.name in SUBMENU_OPS

    private fun warn(message: String) {
        log(message)
    }

    private companion object {
        /** `internal class RecordingComposableScope` in compose-native-tray (not R8-renamed in 1.19.2). */
        private const val SCOPE_CLASS =
            "dev.nucleusframework.composenativetray.menu.impl.RecordingComposableScope"
        private const val SNAPSHOT_METHOD = "snapshot"
        private const val MENU_OP_CLASS = "dev.nucleusframework.composenativetray.menu.impl.MenuOp"
        private const val KEY_SHORTCUT_CLASS =
            "dev.nucleusframework.composenativetray.menu.api.KeyShortcut"

        private const val FOLIA_LABEL = "Folia"

        /** Op types the host uses for ticked rows; 桌面歌词 is the only one in the tray menu. */
        private val CHECKABLE_OPS = setOf(
            "$MENU_OP_CLASS\$PlainCheckable",
            "$MENU_OP_CLASS\$PainterCheckable",
            "$MENU_OP_CLASS\$VectorCheckable",
        )

        private val SUBMENU_OPS = setOf(
            "$MENU_OP_CLASS\$PlainSubMenu",
            "$MENU_OP_CLASS\$PainterSubMenu",
            "$MENU_OP_CLASS\$VectorSubMenu",
        )
    }
}
