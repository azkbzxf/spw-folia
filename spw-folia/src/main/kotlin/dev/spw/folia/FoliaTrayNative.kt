@file:OptIn(UnstableSpwWorkshopApi::class)

package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.WorkshopApi
import com.xuncorp.spw.workshop.api.hook.HookHandle
import com.xuncorp.spw.workshop.api.hook.MethodHook
import com.xuncorp.spw.workshop.api.hook.MethodHookParam
import java.lang.reflect.Constructor
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Deterministic native half of the tray "Folia" row.
 *
 * The compose-side hook in [FoliaTrayMenu] rewrites the recorded `MenuOp` list, but in SPW 1.19.2
 * `AppTray` passes a *remembered* composable lambda to `Tray(...)`; when the tray composable skips
 * recomposition after our late hook install, the rewritten list is never turned into new native
 * menu items (observed: hook + `setResult` succeed, the right-click menu still shows 9 rows).
 *
 * This class therefore patches the native side directly:
 *  1. `after` hook on `WindowsTrayMenuBuilderImpl.build()` — every native item list the library
 *     builds (first paint and every later update) gets one `MenuItem("Folia", …)` inserted right
 *     after the `桌面歌词` row, so the row can never be lost to a skipped recomposition.
 *  2. A retry thread calling [refreshNativeMenu] at 1.2 s / 3.5 s / 8 s after install: if the tray
 *     was initialised before the plugin loaded (no `build()` calls at all afterwards), it reads the
 *     manager's `currentMenuItems`, inserts the same item and calls `WindowsTrayManager.update(...)`,
 *     whose update queue rebuilds the native menu handles.
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
    private var managersField: Field? = null

    @Volatile
    private var managerUpdate: Method? = null

    @Volatile
    private var managerFields: Map<String, Field> = emptyMap()

    /** Installs the native patch (builder hook first, retry thread for a pre-existing tray). */
    fun install(): Boolean {
        if (installed.get()) return true
        if (!resolve()) {
            log("tray native: patch disabled: $BUILDER_CLASS/build()/MenuItem missing on this host build")
            return false
        }
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
    }

    // ------------------------------------------------------------ build patch ----

    private fun patchNativeItems(call: MethodHookParam) {
        val ctor = menuItemCtor ?: return
        val items = call.result as? List<*> ?: return
        if (items.isEmpty()) return

        val labels = items.map { textOf(it) }
        if (buildLogLines.getAndIncrement() < 4) {
            log("tray native: build() items=${items.size} $labels")
        }
        if (FOLIA_LABEL in labels) return

        val insertAt = insertionIndex(items, labels)
        val item = newFoliaItem(ctor) ?: return
        val merged = ArrayList<Any?>(items.size + 1)
        for (i in 0 until insertAt) merged.add(items[i])
        merged.add(item)
        for (i in insertAt until items.size) merged.add(items[i])
        call.setResult(merged)
        log("tray native: build() patched items ${items.size} -> ${merged.size} at index $insertAt")
    }

    // ------------------------------------------------------ forced native update ----

    /**
     * Reads every live [WindowsTrayManager] and, when its current native items lack `Folia`,
     * performs one `update(...)` with the row inserted. Returns true when a patched or already
     * patched menu was observed.
     */
    private fun refreshNativeMenu(attempt: Int): Boolean {
        val ctor = menuItemCtor ?: return false
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
        var patched = false
        for (manager in managers.values) {
            if (manager == null) continue
            val items = runCatching { managerFields["currentMenuItems"]?.get(manager) as? List<*> }.getOrNull()
            if (items.isNullOrEmpty()) {
                log("tray native: manager items not ready (attempt $attempt)")
                continue
            }
            val labels = items.map { textOf(it) }
            if (FOLIA_LABEL in labels) {
                log("tray native: native menu already has Folia (${items.size} items, attempt $attempt)")
                patched = true
                continue
            }
            val insertAt = insertionIndex(items, labels)
            val item = newFoliaItem(ctor) ?: continue
            val merged = ArrayList<Any?>(items.size + 1)
            for (i in 0 until insertAt) merged.add(items[i])
            merged.add(item)
            for (i in insertAt until items.size) merged.add(items[i])
            val update = managerUpdate
            if (update == null) {
                log("tray native: WindowsTrayManager.update unavailable; build hook only")
                continue
            }
            val iconPath = runCatching { managerFields["iconPath"]?.get(manager) }.getOrNull()
            val tooltip = runCatching { managerFields["tooltip"]?.get(manager) }.getOrNull()
            val onLeftClick = runCatching { managerFields["onLeftClick"]?.get(manager) }.getOrNull()
            val onMenuOpened = runCatching { managerFields["onMenuOpened"]?.get(manager) }.getOrNull()
            runCatching { update.invoke(manager, iconPath, tooltip, onLeftClick, onMenuOpened, merged) }
                .onSuccess {
                    patched = true
                    log(
                        "tray native: forced menu update attempt=$attempt items=${items.size} -> " +
                            "${merged.size} at index $insertAt"
                    )
                }
                .onFailure {
                    log("tray native: forced update failed attempt=$attempt: ${it::class.java.name}: ${it.message}")
                }
        }
        return patched
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

    // --------------------------------------------------------------- helpers ----

    private fun insertionIndex(items: List<*>, labels: List<String?>): Int {
        val desktopLyrics = labels.indexOf(DESKTOP_LYRICS_LABEL)
        if (desktopLyrics >= 0) return desktopLyrics + 1
        // Fallback: right after the first checkable row (桌面歌词 equivalent) if the label is localised.
        val checkable = items.indexOfFirst { isCheckable(it) }
        if (checkable >= 0) return checkable + 1
        return items.size
    }

    private fun newFoliaItem(ctor: Constructor<*>): Any? = runCatching {
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

    private fun textOf(item: Any?): String? {
        if (item == null) return null
        return runCatching { textGetter?.invoke(item) as? String }.getOrNull()
    }

    private fun isCheckable(item: Any?): Boolean {
        if (item == null) return false
        return runCatching { checkableGetter?.invoke(item) as? Boolean }.getOrNull() == true
    }

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
        for (name in listOf("iconPath", "tooltip", "onLeftClick", "onMenuOpened", "currentMenuItems")) {
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

        private const val FOLIA_LABEL = "Folia"
        private const val DESKTOP_LYRICS_LABEL = "桌面歌词"

        private val RETRY_DELAYS_MS = longArrayOf(1_200L, 3_500L, 8_000L)
    }
}
