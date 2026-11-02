@file:OptIn(UnstableSpwWorkshopApi::class)

package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.WorkshopApi
import com.xuncorp.spw.workshop.api.hook.HookHandle
import com.xuncorp.spw.workshop.api.hook.MethodHook
import com.xuncorp.spw.workshop.api.hook.MethodHookParam
import java.io.OutputStream
import java.io.PrintStream
import java.lang.reflect.Constructor
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Deterministic native half of the tray "Folia" row.
 *
 * ## Why the native side, not just the compose recording
 * The compose-side hook in [FoliaTrayMenu] rewrites the recorded `MenuOp` list, but SPW's `AppTray`
 * hands a *remembered* composable lambda to `Tray(...)`. When the plugin loads after the tray has
 * already been composed (the normal case for a workshop plugin), `RecordingComposableScope.snapshot()`
 * is never called again, so a rewritten op list can never reach the native menu. The native half
 * patches `WindowsTrayMenuBuilderImpl.build()` instead: every item list the library builds — first
 * paint and every later update — is rebuilt with one `MenuItem("Folia", …)` inserted right after the
 * 桌面歌词 checkable run. A retry thread additionally forces one `WindowsTrayManager.update(...)`
 * when the tray was initialised before the plugin loaded.
 *
 * ## v0.4.12 root cause: the stale-row regression
 * `WindowsTrayInitializer.trayManagers` is a **static** map in the host's bundled tray library, so a
 * `WindowsTrayManager` (and the `currentMenuItems` list inside it) survives a plugin reload in the
 * same JVM. v0.4.11's [refreshNativeMenu] treated "the list already contains a row labelled Folia"
 * as success and returned early. After a hot plugin-dir swap that label match was true — the row
 * belonged to the *previous* plugin instance, whose classloader PF4J had already closed — so the
 * visible row kept a dead `onClick` (`NoClassDefFoundError`, an `Error` the library's
 * `catch (Exception)` does not catch) and the click silently did nothing. On a fresh app start there
 * is no such manager, the row is built by this instance, and the click works.
 *
 * Therefore the invariant is **identity, never label**: a row counts as ours only when its
 * `getOnClick()` is this instance's [clickAction] object. On every refresh a live list that lacks
 * *our* callback is rebuilt from scratch — every existing Folia row is dropped and one fresh
 * `MenuItem` carrying the current callback is inserted — and the result is re-read from
 * `currentMenuItems` to prove the identity landed. Stale rows are reported as `stale=true` with the
 * foreign callback's class/identity/classloader so this bug class is diagnosable in the field.
 *
 * Two plugin instances can coexist (PF4J); the newest claims the row through a JVM-wide property
 * (`dev.spw.folia.trayOwner`) and older instances stand down when they see a newer token.
 *
 * Everything is reflective and fail-soft: a missing class/field logs one line and leaves the host's
 * tray untouched. Launching Folia is routed through the same click action as the compose-level item
 * (worker thread, because the tray callback runs on the Win32 message-loop thread).
 */
internal class FoliaTrayNative(
    private val log: (String) -> Unit,
    private val clickAction: () -> Unit,
) {

    @Volatile
    private var buildHook: HookHandle? = null

    private val installed = AtomicBoolean(false)
    private val buildLogLines = AtomicInteger(0)
    private var refreshThread: Thread? = null

    @Volatile
    private var builderClass: Class<*>? = null

    @Volatile
    private var menuItemClass: Class<*>? = null

    @Volatile
    private var menuItemCtor: Constructor<*>? = null

    @Volatile
    private var textGetter: Method? = null

    @Volatile
    private var checkableGetter: Method? = null

    @Volatile
    private var onClickGetter: Method? = null

    @Volatile
    private var managersField: Field? = null

    @Volatile
    private var managerUpdate: Method? = null

    @Volatile
    private var managerFields: Map<String, Field> = emptyMap()

    /**
     * This instance's ownership token. Written to a JVM-wide system property so two live plugin
     * instances can see each other; the last writer owns the row, older ones stand down.
     */
    private val ownerToken: String = UUID.randomUUID().toString() + ":" + System.identityHashCode(this)

    private val supersededLogged = AtomicBoolean(false)
    private val updateUnavailableLogged = AtomicBoolean(false)

    // ---- bundled tray library log mirror (diagnostics) ----
    private val mirroredLines = AtomicInteger(0)
    private val teeInstalled = AtomicBoolean(false)

    /** Guards the mirror against re-entering itself through our own log sink. */
    private val mirroring = ThreadLocal.withInitial { false }

    @Volatile
    private var teeStream: PrintStream? = null

    @Volatile
    private var teeOriginal: PrintStream? = null

    /** Installs the native patch (builder hook first, retry thread for a pre-existing tray). */
    fun install(): Boolean {
        if (installed.get()) return true
        if (!resolve()) {
            log("tray native: patch disabled: $BUILDER_CLASS/build()/MenuItem missing on this host build")
            return false
        }
        enableLibraryLogging()
        claimOwnership()
        val hook = runCatching {
            WorkshopApi.hookRegistrar.hookMethod(
                BUILDER_CLASS,
                "build",
                emptyList(),
                object : MethodHook() {
                    override fun after(call: MethodHookParam) {
                        try {
                            patchNativeItems(call)
                        } catch (t: Throwable) {
                            log("tray native: build patch error: ${t::class.java.name}: ${t.message}")
                        }
                    }
                }
            )
        }
        hook.onSuccess {
            buildHook = it
            installed.set(true)
            log("tray native: $BUILDER_CLASS.build() hook installed, Folia row forced after 桌面歌词")
        }.onFailure {
            log("tray native: build hook registration failed: ${it::class.java.name}: ${it.message}")
        }
        startRefreshThread()
        return hook.isSuccess
    }

    fun uninstall() {
        runCatching { buildHook?.unhook() }.onFailure { log("tray native: unhook failed: $it") }
        buildHook = null
        installed.set(false)
        refreshThread?.interrupt()
        refreshThread = null
        releaseOwnership()
        restoreTee()
    }

    // ------------------------------------------------------------ build patch ----

    private fun patchNativeItems(call: MethodHookParam) {
        val items = call.result as? List<*> ?: return
        if (items.isEmpty()) return

        val labels = items.map { textOf(it) }
        if (buildLogLines.getAndIncrement() < BUILD_LOG_BUDGET) {
            log("tray native: build() items=${items.size} labels=$labels")
        }
        // Identity, not label: a row only counts as ours when it carries THIS instance's callback.
        if (items.any { isOwnItem(it) }) return

        val fresh = newFoliaItem() ?: return
        val cleaned = items.filterNot { isFoliaRow(it) }
        val insertAt = insertionIndex(cleaned)
        val merged = ArrayList<Any?>(cleaned.size + 1)
        for (i in 0 until insertAt) merged.add(cleaned[i])
        merged.add(fresh)
        for (i in insertAt until cleaned.size) merged.add(cleaned[i])
        call.setResult(merged)
        log(
            "tray native: build() patched items ${items.size} -> ${merged.size} at index $insertAt " +
                "(droppedStale=${items.size - cleaned.size})"
        )
    }

    // ------------------------------------------------------ forced native update ----

    /**
     * Reads every live [WindowsTrayManager] and makes sure its item list carries a Folia row whose
     * `onClick` is THIS instance's [clickAction].
     *
     * Never trusts the label: a list that already contains a (possibly stale) Folia row is rebuilt —
     * the row is dropped and re-created from the current callback — then one `update(...)` is
     * enqueued (whose `performUpdate` → `setupMenu` → `buildMenuItems` reinstalls the native
     * callbacks) and the resulting `currentMenuItems` is re-read to prove the identity landed.
     *
     * Returns true when every manager is settled (row live with our callback, or nothing to do).
     */
    private fun refreshNativeMenu(attempt: Int): Boolean {
        supersededBy()?.let { owner ->
            if (supersededLogged.compareAndSet(false, true)) {
                log("tray native: superseded by newer plugin instance $owner; leaving the tray row to it")
            }
            return true
        }
        val field = managersField
        if (field == null) {
            if (attempt == 1) log("tray native: WindowsTrayInitializer.trayManagers unavailable; build hook only")
            return false
        }
        val managers = runCatching { field.get(null) as? Map<*, *> }.getOrNull()
        if (managers.isNullOrEmpty()) {
            log("tray native: no tray manager yet (attempt $attempt)")
            return false
        }
        var settled = true
        for ((instanceId, manager) in managers) {
            if (manager == null) continue
            val id = instanceId?.toString() ?: "?"
            val items = currentItemsOf(manager)
            if (items.isNullOrEmpty()) {
                log("tray native: manager $id items not ready (attempt $attempt)")
                settled = false
                continue
            }
            if (items.any { isOwnItem(it) }) {
                log("tray native: manager $id row already ours (items=${items.size}, attempt $attempt)")
                continue
            }
            if (isInitializedOf(manager) != true || isRunningOf(manager) != true) {
                log(
                    "tray native: manager $id not running " +
                        "(initialized=${isInitializedOf(manager)} running=${isRunningOf(manager)}); " +
                        "an update would be queued but never applied — build hook only"
                )
                settled = false
                continue
            }
            val update = managerUpdate
            if (update == null) {
                if (updateUnavailableLogged.compareAndSet(false, true)) {
                    log("tray native: WindowsTrayManager.update unavailable; build hook only")
                }
                return false
            }
            val stale = items.firstOrNull { isFoliaRow(it) }
            val fresh = newFoliaItem() ?: continue
            val cleaned = items.filterNot { isFoliaRow(it) }
            val insertAt = insertionIndex(cleaned)
            val merged = ArrayList<Any?>(cleaned.size + 1)
            for (i in 0 until insertAt) merged.add(cleaned[i])
            merged.add(fresh)
            for (i in insertAt until cleaned.size) merged.add(cleaned[i])
            val iconPath = runCatching { managerFields["iconPath"]?.get(manager) }.getOrNull()
            val tooltip = runCatching { managerFields["tooltip"]?.get(manager) }.getOrNull()
            val onLeftClick = runCatching { managerFields["onLeftClick"]?.get(manager) }.getOrNull()
            val onMenuOpened = runCatching { managerFields["onMenuOpened"]?.get(manager) }.getOrNull()
            if (iconPath == null || tooltip == null) {
                log("tray native: manager $id iconPath/tooltip unavailable; cannot enqueue update")
                settled = false
                continue
            }
            runCatching { update.invoke(manager, iconPath, tooltip, onLeftClick, onMenuOpened, merged) }
                .onSuccess {
                    log(
                        "tray native: manager $id rebuilt items ${items.size} -> ${merged.size} " +
                            "at index $insertAt (droppedStale=${items.size - cleaned.size}, attempt $attempt)"
                    )
                    if (stale != null && !isOwnItem(stale)) {
                        log("tray native: manager $id dropped stale row ${describeClick(stale)}")
                    }
                    val identity = verifyIdentity(manager)
                    if (identity.own) {
                        log("tray native: manager $id identity own=true items=${identity.items} (attempt $attempt)")
                    } else {
                        log("tray native: manager $id identity ${identity.detail} (attempt $attempt)")
                        settled = false
                    }
                }
                .onFailure {
                    log("tray native: manager $id update failed attempt=$attempt: ${it::class.java.name}: ${it.message}")
                    settled = false
                }
        }
        return settled
    }

    private data class IdentityResult(val own: Boolean, val items: Int, val detail: String)

    /**
     * Re-reads `currentMenuItems` after an update and proves that the live Folia row carries this
     * instance's callback object. `performUpdate` assigns the request's list to `currentMenuItems`
     * before `setupMenu`/`buildMenuItems` install the native callbacks, so once the list is visible
     * the callback is the one that will run.
     */
    private fun verifyIdentity(manager: Any): IdentityResult {
        val deadline = System.currentTimeMillis() + IDENTITY_TIMEOUT_MS
        var last: List<*>? = null
        while (System.currentTimeMillis() < deadline) {
            last = currentItemsOf(manager)
            val row = last?.firstOrNull { isFoliaRow(it) }
            if (row != null && isOwnItem(row)) return IdentityResult(true, last.size, "own=true")
            Thread.sleep(IDENTITY_POLL_MS)
        }
        val row = last?.firstOrNull { isFoliaRow(it) }
            ?: return IdentityResult(false, last?.size ?: 0, "stale=missing(no Folia row in live items)")
        return IdentityResult(
            false,
            last.size,
            "stale=true old=${describeClick(row)}"
        )
    }

    private fun startRefreshThread() {
        val worker = Thread({
            for ((index, delay) in RETRY_DELAYS_MS.withIndex()) {
                try {
                    Thread.sleep(delay)
                } catch (e: InterruptedException) {
                    return@Thread
                }
                val attempt = index + 1
                val done = runCatching { refreshNativeMenu(attempt) }
                    .onFailure { log("tray native: refresh attempt $attempt failed: ${it::class.java.name}: ${it.message}") }
                    .getOrDefault(false)
                if (done) return@Thread
            }
            log("tray native: refresh retries exhausted; build hook keeps the row on later rebuilds")
        }, "spw-folia-tray-native")
        worker.isDaemon = true
        worker.start()
        refreshThread = worker
    }

    // ------------------------------------------------------------- ownership ----

    private fun claimOwnership() {
        val previous = runCatching { System.getProperty(OWNER_PROPERTY) }.getOrNull()
        runCatching { System.setProperty(OWNER_PROPERTY, ownerToken) }
        log(
            "tray native: row owner token=$ownerToken previous=${previous ?: "none"}" +
                if (previous != null && previous != ownerToken) {
                    " (taking the row over from a previous plugin instance)"
                } else {
                    ""
                }
        )
    }

    private fun releaseOwnership() {
        val current = runCatching { System.getProperty(OWNER_PROPERTY) }.getOrNull()
        if (current == ownerToken) {
            runCatching { System.getProperties().remove(OWNER_PROPERTY) }
            log("tray native: released row ownership")
        }
    }

    /** Non-null when a newer plugin instance has claimed the row; this instance must stand down. */
    private fun supersededBy(): String? {
        val owner = runCatching { System.getProperty(OWNER_PROPERTY) }.getOrNull()
        return if (owner != null && owner != ownerToken) owner else null
    }

    // ------------------------------------------------ library log mirror (diag) ----

    /**
     * The bundled tray library gates ALL of its own logging (including `MenuItem clicked: …`, the
     * `catch (Exception)` bodies in `performUpdate`/`buildMenuItems`, and "Calling nativeUpdateTray()")
     * behind a static `allowComposeNativeTrayLogging` flag that its `static {}` never initialises, so
     * it defaults to false and every line is silently dropped. That is why a swallowed click used to
     * leave no trace anywhere. This enables the flag reflectively and mirrors timestamped library
     * lines from `System.out` into the plugin log, tagged `[tray-lib]`, bounded by [MIRROR_LIMIT].
     */
    private fun enableLibraryLogging() {
        runCatching {
            val debugLn = Class.forName(DEBUG_LN_CLASS)
            debugLn.getMethod("setAllowComposeNativeTrayLogging", java.lang.Boolean.TYPE)
                .invoke(null, java.lang.Boolean.TRUE)
            // The level defaults to VERBOSE, but set it explicitly in case the host raised it.
            val levelClass = Class.forName(LOG_LEVEL_CLASS)
            val verbose = levelClass.getField("VERBOSE").get(null)
            debugLn.getMethod("setComposeNativeTrayloggingLevel", levelClass).invoke(null, verbose)
        }.onSuccess {
            installTee()
            log(
                "tray native: library logging enabled " +
                    "(lines from the bundled tray library are mirrored as [tray-lib], cap=$MIRROR_LIMIT)"
            )
        }.onFailure {
            log("tray native: library logging unavailable: ${it::class.java.name}: ${it.message}")
        }
    }

    private fun installTee() {
        if (!teeInstalled.compareAndSet(false, true)) return
        val original = System.out
        if (original == null) {
            teeInstalled.set(false)
            return
        }
        val tee = PrintStream(TeeStream(original) { line -> mirrorLibraryLine(line) }, true)
        teeOriginal = original
        teeStream = tee
        runCatching { System.setOut(tee) }
            .onFailure { log("tray native: could not install System.out mirror: ${it.message}") }
    }

    private fun restoreTee() {
        val mine = teeStream ?: return
        if (System.out === mine) {
            val original = teeOriginal
            if (original != null) runCatching { System.setOut(original) }
            log("tray native: library log mirror removed")
        }
        teeStream = null
        teeInstalled.set(false)
    }

    private fun mirrorLibraryLine(line: String) {
        // Only the library's own format: "[yyyy-MM-dd HH:mm:ss.SSS] message".
        if (!LIB_LINE_PREFIX.containsMatchIn(line)) return
        // Re-entrancy guard: our own log() sink may itself write to System.out (a test harness, or a
        // host that tees stdout). Without this, a mirrored line that still contains the library's
        // timestamp prefix would match the filter again and recurse until the cap.
        if (mirroring.get()) return
        mirroring.set(true)
        try {
            val count = mirroredLines.incrementAndGet()
            if (count > MIRROR_LIMIT) {
                if (count == MIRROR_LIMIT + 1) {
                    log("tray native: [tray-lib] further library lines suppressed (cap=$MIRROR_LIMIT)")
                }
                return
            }
            // Strip ANSI colours AND the library's own timestamp prefix, so the line we write can
            // never be mistaken for a fresh library line by a re-reading tee.
            val clean = LIB_LINE_PREFIX.replace(ANSI_ESCAPE.replace(line, ""), "").trim()
            log("tray native: [tray-lib] $clean")
        } finally {
            mirroring.set(false)
        }
    }

    // --------------------------------------------------------------- helpers ----

    private fun insertionIndex(items: List<*>): Int {
        // Structural, not label-based: right after the run of checkable rows (桌面歌词 is the only
        // checkable in SPW's tray menu) so a localised label change cannot move our row.
        val firstCheckable = items.indexOfFirst { isCheckable(it) }
        if (firstCheckable < 0) return items.size
        var index = firstCheckable + 1
        while (index < items.size && isCheckable(items[index])) index++
        return index
    }

    private fun newFoliaItem(): Any? {
        val ctor = menuItemCtor ?: return null
        return runCatching {
            ctor.newInstance(
                FOLIA_LABEL,
                null,
                java.lang.Boolean.TRUE,
                java.lang.Boolean.FALSE,
                java.lang.Boolean.FALSE,
                clickAction,
                java.util.Collections.emptyList<Any?>()
            )
        }.onFailure {
            log("tray native: MenuItem construction failed: ${it::class.java.name}: ${it.message}")
        }.getOrNull()
    }

    private fun textOf(item: Any?): String? {
        if (item == null) return null
        return runCatching { textGetter?.invoke(item) as? String }.getOrNull()
    }

    private fun isCheckable(item: Any?): Boolean {
        if (item == null) return false
        return runCatching { checkableGetter?.invoke(item) as? Boolean }.getOrNull() == true
    }

    private fun onClickOf(item: Any?): Any? {
        if (item == null) return null
        return runCatching { onClickGetter?.invoke(item) }.getOrNull()
    }

    /** True only when the item's `onClick` is this instance's callback object (identity). */
    private fun isOwnItem(item: Any?): Boolean = onClickOf(item) === clickAction

    /** Our own literal label; used only to drop previous instances' rows, never to trust a row. */
    private fun isFoliaRow(item: Any?): Boolean = textOf(item) == FOLIA_LABEL

    private fun describeClick(item: Any?): String {
        val fn = onClickOf(item) ?: return "onClick=null"
        val cls = fn.javaClass
        return "onClick=${cls.name}@${System.identityHashCode(fn)} loader=${cls.classLoader?.name ?: "<none>"}"
    }

    private fun currentItemsOf(manager: Any): List<*>? =
        runCatching { managerFields["currentMenuItems"]?.get(manager) as? List<*> }.getOrNull()

    private fun isRunningOf(manager: Any): Boolean? =
        runCatching {
            (managerFields["running"]?.get(manager) as? java.util.concurrent.atomic.AtomicBoolean)?.get()
        }.getOrNull()

    private fun isInitializedOf(manager: Any): Boolean? =
        runCatching {
            (managerFields["initialized"]?.get(manager) as? java.util.concurrent.atomic.AtomicBoolean)?.get()
        }.getOrNull()

    private fun resolve(): Boolean {
        val builder = runCatching { Class.forName(BUILDER_CLASS) }.getOrNull()
        if (builder == null) {
            log("tray native: $BUILDER_CLASS not on the host classpath")
            return false
        }
        val buildMethod = runCatching { builder.getDeclaredMethod("build") }.getOrNull()
        if (buildMethod == null || !java.util.List::class.java.isAssignableFrom(buildMethod.returnType)) {
            log("tray native: $BUILDER_CLASS.build() has an unexpected shape")
            return false
        }
        val itemClass = runCatching { Class.forName(MENU_ITEM_CLASS) }.getOrNull()
        if (itemClass == null) {
            log("tray native: $MENU_ITEM_CLASS missing on this host build")
            return false
        }
        val function0 = runCatching { Class.forName("kotlin.jvm.functions.Function0") }.getOrNull()
        if (function0 == null) {
            log("tray native: kotlin.jvm.functions.Function0 missing")
            return false
        }
        // Real descriptor: (String text, String iconPath, boolean isEnabled, boolean isCheckable,
        // boolean isChecked, Function0 onClick, List subMenuItems).
        val ctor = runCatching {
            itemClass.getDeclaredConstructor(
                String::class.java,
                String::class.java,
                java.lang.Boolean.TYPE,
                java.lang.Boolean.TYPE,
                java.lang.Boolean.TYPE,
                function0,
                java.util.List::class.java
            ).apply { isAccessible = true }
        }.getOrNull()
        if (ctor == null) {
            log("tray native: unexpected $MENU_ITEM_CLASS constructor")
            return false
        }
        builderClass = builder
        menuItemClass = itemClass
        menuItemCtor = ctor
        textGetter = runCatching { itemClass.getMethod("getText") }.getOrNull()
        checkableGetter = runCatching { itemClass.getMethod("isCheckable") }.getOrNull()
        onClickGetter = runCatching { itemClass.getMethod("getOnClick") }.getOrNull()
        if (onClickGetter == null) {
            log("tray native: $MENU_ITEM_CLASS.getOnClick() missing; cannot verify row identity")
            return false
        }
        resolveManager()
        return true
    }

    private fun resolveManager() {
        val initializer = runCatching { Class.forName(INITIALIZER_CLASS) }.getOrNull() ?: return
        managersField = runCatching {
            initializer.getDeclaredField("trayManagers").apply { isAccessible = true }
        }.getOrNull()
        val managerClass = runCatching { Class.forName(MANAGER_CLASS) }.getOrNull() ?: return
        managerUpdate = runCatching {
            managerClass.declaredMethods.firstOrNull { it.name == "update" && it.parameterCount == 5 }
                ?.apply { isAccessible = true }
        }.getOrNull()
        val fields = LinkedHashMap<String, Field>()
        for (name in listOf(
            "iconPath",
            "tooltip",
            "onLeftClick",
            "onMenuOpened",
            "currentMenuItems",
            "running",
            "initialized"
        )) {
            runCatching {
                managerClass.getDeclaredField(name).apply { isAccessible = true }
            }.onSuccess { fields[name] = it }
        }
        managerFields = fields
    }

    private companion object {
        private const val BUILDER_CLASS =
            "dev.nucleusframework.composenativetray.menu.impl.WindowsTrayMenuBuilderImpl"
        private const val MENU_ITEM_CLASS =
            "dev.nucleusframework.composenativetray.lib.windows.WindowsTrayManager\$MenuItem"
        private const val INITIALIZER_CLASS =
            "dev.nucleusframework.composenativetray.tray.impl.WindowsTrayInitializer"
        private const val MANAGER_CLASS =
            "dev.nucleusframework.composenativetray.lib.windows.WindowsTrayManager"
        private const val DEBUG_LN_CLASS =
            "dev.nucleusframework.composenativetray.utils.DebugLnKt"
        private const val LOG_LEVEL_CLASS =
            "dev.nucleusframework.composenativetray.utils.ComposeNativeTrayLoggingLevel"

        /** JVM-wide row ownership marker: newest plugin instance wins. */
        private const val OWNER_PROPERTY = "dev.spw.folia.trayOwner"

        private const val FOLIA_LABEL = "Folia"

        private const val BUILD_LOG_BUDGET = 4
        private const val MIRROR_LIMIT = 400

        /** How long to wait for the tray thread to apply a queued update before re-reading it. */
        private const val IDENTITY_TIMEOUT_MS = 900L
        private const val IDENTITY_POLL_MS = 25L

        private val RETRY_DELAYS_MS = longArrayOf(1_200L, 3_500L, 8_000L)

        private val LIB_LINE_PREFIX = Regex("""\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}]""")
        private val ANSI_ESCAPE = Regex("""\u001B\[[0-9;]*m""")
    }

    /**
     * `System.out` wrapper that forwards every byte to the original stream and hands complete lines
     * to [onLine]. Used to mirror the bundled tray library's log lines into the plugin log without
     * disturbing anything else that writes to stdout.
     */
    private class TeeStream(
        private val original: PrintStream,
        private val onLine: (String) -> Unit,
    ) : OutputStream() {
        private val line = StringBuilder()

        override fun write(b: Int) {
            original.write(b)
            append(b.toChar())
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            original.write(b, off, len)
            for (i in off until off + len) append(b[i].toInt().toChar())
        }

        override fun flush() {
            original.flush()
        }

        private fun append(c: Char) {
            when (c) {
                '\n' -> emit()
                '\r' -> Unit
                else -> line.append(c)
            }
        }

        private fun emit() {
            if (line.isEmpty()) return
            val text = line.toString()
            line.setLength(0)
            runCatching { onLine(text) }
        }
    }
}
