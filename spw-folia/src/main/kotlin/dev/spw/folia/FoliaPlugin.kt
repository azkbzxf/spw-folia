@file:OptIn(UnstableSpwWorkshopApi::class)
@file:Suppress("unused")

package dev.spw.folia

import androidx.compose.runtime.Composable
import com.xuncorp.spw.workshop.api.ActionShortcut
import com.xuncorp.spw.workshop.api.PluginContext
import com.xuncorp.spw.workshop.api.PluginPermission
import com.xuncorp.spw.workshop.api.SpwPlugin
import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.WorkshopApi
import com.xuncorp.spw.workshop.api.config.ConfigHelper
import com.xuncorp.spw.workshop.api.config.ConfigManager
import com.xuncorp.spw.workshop.api.hook.HookHandle
import com.xuncorp.spw.workshop.api.hook.MethodHook
import com.xuncorp.spw.workshop.api.hook.MethodHookParam
import java.awt.Color
import java.awt.Toolkit
import java.awt.event.KeyEvent
import java.awt.event.WindowAdapter
import java.awt.event.WindowEvent
import java.io.File
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.time.LocalDateTime
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.function.Consumer
import javax.swing.JComponent
import javax.swing.JFrame
import javax.swing.JLabel
import javax.swing.KeyStroke
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

/**
 * spw-folia workshop plugin.
 *
 * Adds a "Folia" entry to the SPW 更多 (more) flyout of the mini-player bar and opens the real
 * Folia fullscreen visualizer when it is clicked: the plugin spawns the native helper
 * `spw-folia-host.exe` (C# + WebView2, ships Folia's production web bundle) and drives it over
 * the protocol-v1 JSON-lines bridge in [FoliaHostBridge].
 *
 * Why hookMethod instead of appendContent (SPW 1.19.0, R8-obfuscated host build):
 *  - appendContent needs a *parameter name* of the target call, resolved from Kotlin
 *    @Metadata + MethodParameters. In this host build R8 renamed the JVM methods while
 *    @Metadata JvmMethodSignature keeps the original names, and no MethodParameters
 *    attribute is emitted, so the host hook engine cannot associate metadata parameter
 *    names with the real JVM method -> "UI call missing or ambiguous (0 calls)".
 *  - hookMethod only needs className + JVM method name + full JVM parameter type list.
 *    We hook the non-composable helper that adds the four host menu items and append
 *    our item to the MenuFlyoutScope after it returns.
 *
 * Host targets are resolved at runtime by [HostTargets] instead of being pinned to one build:
 * SPW is R8-obfuscated, so 1.19.1/1.19.2 renamed every class and method we touch (the 1.19.0
 * pair `ē`/`ন`/`Ⴈ` became `घ`/`Ը`/`ะ`). Known builds are matched by a validated profile, unknown
 * ones by a structural classpath scan, and the outcome is cached per host version.
 */
class FoliaPlugin(
    pluginContext: PluginContext
) : SpwPlugin(pluginContext) {

    private var methodHook: HookHandle? = null

    /**
     * v0.3.2: the user-editable shortcut that opens/closes the visualizer. Registered through the
     * host's [com.xuncorp.spw.workshop.api.KeyBindingManager], so SPW's own 快捷键 settings own the
     * key combination (in-app by default, global when the user enables it there).
     */
    private var toggleShortcut: AutoCloseable? = null

    /**
     * Tray (minimised-icon) right-click entry, in the same section as 桌面歌词.
     *
     * The entry toggles like the 呼出 / 关闭 shortcut: open a window when none is running, close the
     * running one otherwise (clicking it while Folia is on screen must not be a no-op).
     */
    private val trayMenu: FoliaTrayMenu by lazy { FoliaTrayMenu(::log, ::toggleFoliaWindow) }

    /**
     * v0.4.0: the two player-page transparency shortcuts (透明背景 / 透明背景 + 鼠标穿透).
     *
     * They are separate actions rather than one cycling action so both get their own line in SPW's
     * 快捷键管理, each with its own user-editable combination. The handlers only rewrite the settings
     * tree; the native host owns the window colour key and applies the tree (see [FoliaTransparency]).
     */
    private var transparentShortcut: AutoCloseable? = null
    private var transparentPassthroughShortcut: AutoCloseable? = null

    /** Flags the last transparency shortcut asked for; see [checkTransparencyExpectation]. */
    @Volatile
    private var expectedTransparency: Triple<Boolean, Boolean, Long>? = null

    /**
     * v0.4.0: 配置 page (SPW 模组管理 → 配置, declared by `preference_config.json`).
     *
     * `transitionAnimation` (default off) enables the cover-tinted opening animation; while it is on,
     * every Folia open plays it. The animation length is fixed at [TRANSITION_ANIMATION_MS] — WebView2's
     * cold start dominates the opening time anyway, so a user-tunable length was removed. The switch is
     * owned by SPW's ConfigManager (`config.json` in the plugin data dir) and mirrored here on start and
     * on every config change; the host receives the cover palette as `--curtain-palette`.
     */
    @Volatile
    private var transitionAnimationEnabled: Boolean = false

    /**
     * issue #12 增加日志功能: 配置 page switch `verboseLog` (default off). When on, the helper is
     * spawned with `--verbose-log` so the log carries navigation transitions, page console lines at
     * every level and per-window stall warnings. Read at spawn time like the animation switch.
     */
    @Volatile
    private var verboseLogEnabled: Boolean = false

    /** Last cover the palette was derived from (track id + data URL hash) and the palette itself. */
    private var curtainPaletteCache: Pair<String, String>? = null

    private var curtainConfigManager: ConfigManager? = null
    private var curtainConfigListener: Consumer<ConfigHelper>? = null

    /** Legacy Swing fallback, only used when the native helper cannot be found/spawned. */
    private var swingFallbackWindow: JFrame? = null

    /** Guards against duplicate items when the menu content recomposes. Key = scope backing list. */
    private val appendedLists = Collections.synchronizedMap(WeakHashMap<Any, Boolean>())

    private val bridge = FoliaHostBridge(File(pluginContext.pluginPath), ::log)
    private val settingsStore = FoliaSettingsStore(::log)

    /** Persisted tree, read by the shortcut handlers and written by the host-bridge reader thread. */
    @Volatile
    private var settingsTree: String = "{}"

    /** Host build this process runs on, e.g. 1.19.2. */
    private val hostVersion: HostTargets.Version? =
        HostTargets.Version.parse(pluginContext.spwVersion)

    /** Menu injection target for this host build; null until [HostTargets] resolved it. */
    @Volatile
    private var menuTarget: HostTargets.MenuTarget? = null

    /** Fields of MenuFlyoutScope implementations that hold the item list, cached per class. */
    private val scopeListFields = ConcurrentHashMap<String, Field?>()

    override fun start() {
        instance = this
        log(
            "start: id=${pluginContext.pluginId} version=${pluginContext.pluginVersion} " +
                "spw=${pluginContext.spwVersion} channel=${pluginContext.spwChannel} path=${pluginContext.pluginPath}"
        )
        // v0.3.2 (issue #9): the "loaded" success toast is gone — a notification on every start is
        // pure noise. Only failures toast (see the class-transform and hook paths below); normal
        // startup is proven by the log line above.
        settingsTree = settingsStore.load()
        // v0.4.0: read the 配置 page switch before the first spawn so the very first Folia open
        // already honours it (the host spawns later, from the menu/tray/shortcut handlers).
        registerTransitionAnimationConfig()
        bridge.settingsTree = withSystemFonts(settingsTree)
        bridge.hostVersion = pluginContext.spwVersion
        // Fallback snapshot keeps the state line flowing at 100 ms even if the PF4J extension is
        // not instantiated yet (proves the bridge/clocks even on a bare host); the extension
        // replaces it as soon as PF4J creates it from META-INF/extensions.idx.
        bridge.snapshotProvider = {
            FoliaPlaybackExtension.get()?.snapshot() ?: PlaybackSnapshot(0L, 0L, false, 1.0)
        }
        bridge.lyricsProvider = { FoliaPlaybackExtension.get()?.lyricsJson() }
        bridge.trackProvider = { FoliaPlaybackExtension.get()?.trackJson() }
        // v0.3.0 playback bar: queue snapshot + controls (reflection over the host player).
        bridge.queueProvider = { FoliaPlaybackControls.queueJson() }
        bridge.onSettingsFromPage = { tree ->
            // The page echoes the tree it was given, including the injected `systemFonts` list. That
            // list is derived data (recomputed on every start), so it is stripped before it reaches
            // the in-memory tree or the settings file — persisting it would add ~10-20 KB of names
            // that go stale as soon as a font is installed.
            val cleanTree = FoliaSystemFonts.withoutSystemFontsJson(tree)
            settingsTree = cleanTree
            bridge.settingsTree = withSystemFonts(cleanTree)
            settingsStore.persist(cleanTree)
            // v0.4.0: a refusal of the shortcut's transparency request arrives through this path.
            checkTransparencyExpectation(cleanTree)
        }
        bridge.onClosed = { reason -> log("folia window closed (reason=$reason); plugin stays loaded") }
        startExtensionWatch()
        // Registered before the hook checks: the shortcuts are independent of the 更多 menu injection
        // and should keep working even when a host build's flyout target cannot be resolved.
        registerToggleShortcut()
        registerTransparencyShortcuts()

        val version = hostVersion
        if (version == null || version < HostTargets.Version.MIN_SUPPORTED) {
            log(
                "unsupported SPW version ${pluginContext.spwVersion} " +
                    "(need >= ${HostTargets.Version.MIN_SUPPORTED}); hook not installed"
            )
            return
        }
        if (!runCatching { WorkshopApi.manager.isPermissionGranted(PluginPermission.CLASS_TRANSFORM) }
                .getOrDefault(false)
        ) {
            log("CLASS_TRANSFORM not granted; hook not installed")
            toast("spw-folia: class-transform permission missing", WorkshopApi.Ui.ToastType.Error)
            return
        }
        // Tray right-click entry: independent of the 更多 flyout target, so it is attempted even if
        // that resolution fails. Degrades to a single log warning (no toast) on unsupported builds.
        runCatching { trayMenu.install() }
            .onFailure { log("WARNING: tray menu item disabled: ${it::class.java.name}: ${it.message}") }
        installHookForHostBuild()
        log("start done")
    }

    /**
     * Installs the flyout hook on this host build.
     *
     * Known builds (cache + profiles) resolve instantly and are hooked before `start()` returns —
     * the historical behaviour. An unknown build needs a classpath scan of the host jar, so it runs
     * on a background thread to keep the host UI start-up free of a one-off 1-2 s stall; the
     * registration is retried because the hook API only accepts the starting/started plugin.
     */
    private fun installHookForHostBuild() {
        val dir = File(pluginContext.pluginPath)
        val version = pluginContext.spwVersion
        if (HostTargets.quickLoad(dir, version, ::log)) {
            installHook()
            return
        }
        log("host build $version matched no known profile; scanning the host classpath in the background")
        val worker = Thread({
            val target = HostTargets.deepResolve(dir, version, ::log)
            if (target == null) {
                log("WARNING: could not locate the 更多 flyout in ${pluginContext.spwVersion}; the Folia menu item will be missing")
                return@Thread
            }
            for (attempt in 1..HOOK_RETRY_COUNT) {
                if (installHook()) return@Thread
                Thread.sleep(HOOK_RETRY_DELAY_MS)
                log("hook retry $attempt/${HOOK_RETRY_COUNT} after registration failure")
            }
        }, "spw-folia-target-resolve")
        worker.isDaemon = true
        worker.start()
    }

    override fun stop() {
        log("stop")
        for (shortcut in listOf(toggleShortcut, transparentShortcut, transparentPassthroughShortcut)) {
            runCatching { shortcut?.close() }.onFailure { log("shortcut unregister failed: $it") }
        }
        toggleShortcut = null
        transparentShortcut = null
        transparentPassthroughShortcut = null
        expectedTransparency = null
        runCatching {
            val manager = curtainConfigManager
            val listener = curtainConfigListener
            if (manager != null && listener != null) manager.removeConfigChangeListener(listener)
        }.onFailure { log("config listener removal failed: $it") }
        curtainConfigManager = null
        curtainConfigListener = null
        runCatching { methodHook?.unhook() }.onFailure { log("unhook failed: $it") }
        methodHook = null
        runCatching { trayMenu.uninstall() }.onFailure { log("tray unhook failed: $it") }
        runCatching { bridge.stop() }.onFailure { log("bridge stop failed: $it") }
        runCatching { settingsStore.shutdown() }
        runCatching { FoliaPlaybackExtension.get()?.shutdown() }
        SwingUtilities.invokeLater { swingFallbackWindow?.dispose() }
        instance = null
    }

    override fun delete() {
        log("delete")
        runCatching { bridge.stop() }.onFailure { log("bridge stop failed: $it") }
        runCatching { settingsStore.shutdown() }
        runCatching { FoliaPlaybackExtension.get()?.shutdown() }
    }

    override fun update() {
        log("update")
    }

    /**
     * PF4J instantiates `@Extension` classes from `META-INF/extensions.idx` after the plugin class
     * loads. Logs when the playback extension appears (or never does) so the integration log always
     * tells whether the playback bridge is wired.
     */
    private fun startExtensionWatch() {
        val worker = Thread({
            val startedAt = System.currentTimeMillis()
            var reported = false
            while (System.currentTimeMillis() - startedAt < EXTENSION_WATCH_MS) {
                val extension = FoliaPlaybackExtension.get()
                if (extension != null) {
                    log("playback extension discovered: ${extension::class.java.name}")
                    reported = true
                    break
                }
                Thread.sleep(500L)
            }
            if (!reported) {
                log(
                    "WARNING: PlaybackExtensionPoint extension was not instantiated within " +
                        "${EXTENSION_WATCH_MS / 1000}s - check META-INF/extensions.idx in the plugin jar"
                )
            }
        }, "spw-folia-ext-watch")
        worker.isDaemon = true
        worker.start()
    }

    // ---------------------------------------------------------------- hook ----

    private fun installHook(): Boolean {
        val target = HostTargets.menu ?: menuTarget
        if (target == null) {
            log("installHook: no host menu target resolved yet")
            return false
        }
        val result = runCatching {
            WorkshopApi.hookRegistrar.hookMethod(
                target.menuClass,
                target.addItemsMethod,
                target.addItemsParams,
                object : MethodHook() {
                    override fun after(call: MethodHookParam) {
                        try {
                            val args = call.args
                            if (args.size < 6) {
                                log("after: unexpected args size ${args.size}")
                                return
                            }
                            val scope = args[5]
                            if (scope == null) {
                                log("after: null MenuFlyoutScope")
                                return
                            }
                            appendFoliaItem(scope, args[2], target)
                        } catch (t: Throwable) {
                            log("after hook error: ${t::class.java.name}: ${t.message}")
                        }
                    }
                }
            )
        }
        result.onSuccess {
            methodHook = it
            menuTarget = target
            log("hookMethod installed: $it (${target.origin})")
            // v0.3.2 (issue #9): no success toast on every start — the hook is an implementation
            // detail, not something to interrupt playback for. Failures still toast below.
        }.onFailure {
            log("hookMethod FAILED: ${it::class.java.name}: ${it.message}")
            toast("spw-folia: hook failed (${it.message})", WorkshopApi.Ui.ToastType.Error)
        }
        return result.isSuccess
    }

    /**
     * Appends one "Folia" item to the live MenuFlyoutScope.
     *
     * Host's own helper adds its four items through the Kotlin default-argument bridge
     * `MenuFlyoutScope.item(onClick, content)` — a static JVM method on the scope interface itself,
     * whose name is resolved per host build by [HostTargets]. It calls the interface implementation
     * `item(onClick, enabled=true, content)`, exactly like the host's four items, so the popup
     * renders our item too.
     */
    private fun appendFoliaItem(scope: Any, popupState: Any?, target: HostTargets.MenuTarget) {
        val dedupeKey = scopeBackingList(scope) ?: scope
        if (appendedLists.putIfAbsent(dedupeKey, true) != null) {
            return
        }
        try {
            val scopeClass = Class.forName(target.scopeClass)
            val function0 = Class.forName("kotlin.jvm.functions.Function0")
            val function2 = Class.forName("kotlin.jvm.functions.Function2")
            val bridgeMethod: Method = scopeClass.getDeclaredMethod(
                target.scopeBridge, scopeClass, function0, function2
            )

            val onClick: () -> Unit = {
                log("Folia item clicked")
                runCatching { dismissPopup(popupState, target) }
                    .onFailure { log("dismissPopup failed: ${it::class.java.name}: ${it.message}") }
                openFolia()
            }
            val content: @Composable () -> Unit = {
                FoliaMenuItemContent()
            }

            bridgeMethod.isAccessible = true
            bridgeMethod.invoke(null, scope, onClick, content)
            log("Folia item appended (scope=${scope.javaClass.name}, bridge=${bridgeMethod.name})")
        } catch (t: Throwable) {
            log("appendFoliaItem error: ${t::class.java.name}: ${t.message}")
        }
    }

    /**
     * The MenuFlyoutScope implementation keeps its items in a `List` field. 1.19.0 and 1.19.2 both
     * name it Ϳ, but the field is discovered by type so a rename cannot break the recomposition
     * de-duplication (a null result simply degrades to keying on the scope instance).
     */
    private fun scopeBackingList(scope: Any): Any? {
        val field = scopeListFields.computeIfAbsent(scope.javaClass.name) { _ ->
            runCatching {
                scope.javaClass.declaredFields.firstOrNull {
                    java.util.List::class.java.isAssignableFrom(it.type) &&
                        !java.lang.reflect.Modifier.isStatic(it.modifiers)
                }?.apply { isAccessible = true }
            }.getOrNull()
        } ?: return null
        return runCatching { field.get(scope) }.getOrNull()
    }

    private fun dismissPopup(popupState: Any?, target: HostTargets.MenuTarget) {
        if (popupState == null) return
        val dismiss: Method? = target.popupDismiss?.let { name ->
            popupState.javaClass.methods.firstOrNull {
                it.name == name && it.parameterCount == 0 && it.returnType == Void.TYPE
            }
        }
        if (dismiss == null) {
            log("dismissPopup: no dismiss method on ${popupState.javaClass.name}")
            return
        }
        dismiss.isAccessible = true
        dismiss.invoke(popupState)
    }

    // -------------------------------------------------------------- shortcut ----

    /**
     * Registers the open/close shortcut with the host.
     *
     * The binding itself lives in SPW (快捷键管理): the default shortcut is in-app only and
     * `hasGlobal = true` lets the user promote it to a system-wide key there. Requires the
     * `key-bindings` permission declared in build.gradle.kts; without it the menu entry keeps
     * working and only the shortcut is skipped.
     */
    private fun registerToggleShortcut() {
        val granted = runCatching {
            WorkshopApi.manager.isPermissionGranted(PluginPermission.KEY_BINDINGS)
        }.getOrDefault(false)
        if (!granted) {
            log("KEY_BINDINGS not granted; shortcut not registered (menu entry unaffected)")
            return
        }
        runCatching {
            WorkshopApi.manager.keyBindingManager.register(
                actionId = TOGGLE_ACTION_ID,
                title = "呼出 / 关闭 Folia 歌词",
                defaultShortcut = ActionShortcut(KeyEvent.VK_F, ActionShortcut.CONTROL or ActionShortcut.ALT),
                hasGlobal = true,
                handler = Runnable { toggleFoliaWindow() }
            )
        }.onSuccess {
            toggleShortcut = it
            log("shortcut registered action=$TOGGLE_ACTION_ID default=Ctrl+Alt+F global=configurable")
        }.onFailure {
            log("shortcut registration failed: ${it::class.java.name}: ${it.message}")
        }
    }

    // ------------------------------------------------------------------ config ----

    /**
     * v0.4.0: mirrors the 配置 page's 打开过渡动画 switch (declared in `preference_config.json`).
     *
     * SPW renders that page from the declaration and stores the value in the plugin's `config.json`
     * through its own ConfigManager; the plugin never shows its own UI for it. The value decides
     * whether the native helper is spawned with `--no-curtain`; the listener fires when the user
     * edits the page, so no SPW restart is needed. The animation length is fixed at
     * [TRANSITION_ANIMATION_MS]: WebView2's cold start dominates the opening time, so a length
     * slider was removed in favour of a predictable 0.8 s fade-in.
     */
    private fun registerTransitionAnimationConfig() {
        val manager = try {
            WorkshopApi.manager.createConfigManager()
        } catch (t: Throwable) {
            log("config manager unavailable: ${t::class.java.name}: ${t.message}; transition animation stays off")
            return
        }
        readTransitionAnimation(manager.getConfig())
        readVerboseLog(manager.getConfig())
        val listener = Consumer<ConfigHelper> { helper ->
            readTransitionAnimation(helper)
            readVerboseLog(helper)
        }
        runCatching { manager.addConfigChangeListener(listener) }
            .onSuccess {
                curtainConfigManager = manager
                curtainConfigListener = listener
                log("config listener registered keys=$TRANSITION_ANIMATION_KEY,$VERBOSE_LOG_KEY")
            }
            .onFailure { log("config listener registration failed: ${it::class.java.name}: ${it.message}") }
    }

    /**
     * issue #12: mirrors the 配置 page's 详细日志 switch into the helper spawn (`--verbose-log`).
     *
     * Same plumbing as [readTransitionAnimation] and the same caveat: it is read at spawn time, so
     * flipping it affects the next Folia open. Kept a separate key so a user who needs a trace can
     * turn it on without also re-enabling the opening animation.
     */
    private fun readVerboseLog(helper: ConfigHelper) {
        val enabled = try {
            helper.get(VERBOSE_LOG_KEY, false) as? Boolean ?: false
        } catch (t: Throwable) {
            log("verbose log read failed: ${t::class.java.name}: ${t.message}")
            false
        }
        if (enabled != verboseLogEnabled) {
            log("config $VERBOSE_LOG_KEY=$enabled (host --verbose-log=${if (enabled) "on" else "off"})")
        }
        verboseLogEnabled = enabled
        bridge.verboseLog = enabled
    }

    private fun readTransitionAnimation(helper: ConfigHelper) {
        val enabled = try {
            helper.get(TRANSITION_ANIMATION_KEY, false) as? Boolean ?: false
        } catch (t: Throwable) {
            log("transition animation read failed: ${t::class.java.name}: ${t.message}")
            false
        }
        val changed = enabled != transitionAnimationEnabled
        transitionAnimationEnabled = enabled
        bridge.curtainEnabled = enabled
        if (changed) {
            log(
                "config $TRANSITION_ANIMATION_KEY=$enabled " +
                    "(curtain=${if (enabled) "on" else "off"}, fadeIn=${TRANSITION_ANIMATION_MS}ms)"
            )
        }
    }

    /**
     * v0.4.0: palette for the opening animation, taken from the current song cover.
     *
     * Cached per cover (track id + data URL hash): decoding a multi-megabyte artwork once per open
     * would add a visible delay to the menu click. A missing cover or a grey artwork yields the
     * built-in violet palette, so the curtain always has something to draw with.
     */
    private fun curtainPaletteCsv(): String {
        val extension = FoliaPlaybackExtension.get()
        val trackId = extension?.currentTrackId().orEmpty()
        val dataUrl = extension?.coverDataUrlForPalette()
        val key = trackId + ":" + (dataUrl?.let { it.length.toString() + "-" + it.hashCode() } ?: "none")
        curtainPaletteCache?.let { (cachedKey, cachedCsv) ->
            if (cachedKey == key) return cachedCsv
        }
        val palette = FoliaCoverPalette.paletteFromDataUrl(dataUrl)
        val csv = palette.joinToString(",")
        curtainPaletteCache = key to csv
        log("curtain palette id=${trackId.ifEmpty { "?" }} colors=$csv")
        return csv
    }

    /**
     * v0.4.0: registers the two player-page transparency shortcuts.
     *
     * Both actions toggle flags in the persisted settings tree and, while a window is running, hand
     * the tree to the host; the host applies the layered-window colour key and re-posts the tree to
     * the page. The page's settings store owns the style-compatibility guard, so a style that cannot
     * render transparency (e.g. `monet`) refuses the request and re-emits the corrected tree — the
     * plugin then warns instead of leaving a shortcut that silently does nothing.
     *
     * Defaults are Ctrl+Alt+G / Ctrl+Alt+Shift+G: the host owns its own global transparency hotkeys
     * Ctrl+Alt+B → Ctrl+Alt+Y → P → Shift+B (see `docs/live-transparency.md`) and Ctrl+Alt+T is
     * already taken by another program on the reference machine, so neither may be reused here.
     */
    private fun registerTransparencyShortcuts() {
        val granted = runCatching {
            WorkshopApi.manager.isPermissionGranted(PluginPermission.KEY_BINDINGS)
        }.getOrDefault(false)
        if (!granted) {
            log("KEY_BINDINGS not granted; transparency shortcuts not registered")
            return
        }
        transparentShortcut = registerTransparencyShortcut(
            actionId = TRANSPARENT_ACTION_ID,
            title = "播放页透明背景：开 / 关",
            defaultLabel = "Ctrl+Alt+G",
            defaultShortcut = ActionShortcut(KeyEvent.VK_G, ActionShortcut.CONTROL or ActionShortcut.ALT),
            withPassthrough = false
        )
        transparentPassthroughShortcut = registerTransparencyShortcut(
            actionId = TRANSPARENT_PASSTHROUGH_ACTION_ID,
            title = "播放页透明背景 + 鼠标穿透：开 / 关",
            defaultLabel = "Ctrl+Alt+Shift+G",
            defaultShortcut = ActionShortcut(KeyEvent.VK_G, ActionShortcut.CONTROL or ActionShortcut.ALT or ActionShortcut.SHIFT),
            withPassthrough = true
        )
    }

    private fun registerTransparencyShortcut(
        actionId: String,
        title: String,
        defaultLabel: String,
        defaultShortcut: ActionShortcut,
        withPassthrough: Boolean
    ): AutoCloseable? = runCatching {
        WorkshopApi.manager.keyBindingManager.register(
            actionId = actionId,
            title = title,
            defaultShortcut = defaultShortcut,
            hasGlobal = true,
            handler = Runnable { toggleTransparency(withPassthrough) }
        )
    }.onSuccess {
        log("shortcut registered action=$actionId default=$defaultLabel global=configurable")
    }.onFailure {
        log("shortcut registration failed action=$actionId: ${it::class.java.name}: ${it.message}")
    }.getOrNull()

    /**
     * One shortcut press: compute the next flags, persist them, and push them to a running window.
     *
     * Persisting first means the choice survives a restart even when no window is open; pushing only
     * happens when the bridge is running, because the host only applies `settings` lines it receives
     * while the helper process lives (the tree is replayed on the next open anyway).
     */
    private fun toggleTransparency(withPassthrough: Boolean) {
        try {
            val current = FoliaTransparency.read(settingsTree)
            val next = if (withPassthrough) {
                FoliaTransparency.nextTransparentAndPassthrough(current)
            } else {
                FoliaTransparency.nextTransparentOnly(current)
            }
            val updated = FoliaTransparency.apply(settingsTree, current, next)
            settingsTree = updated
            settingsStore.persist(updated)
            val running = bridge.isRunning()
            if (running) {
                bridge.sendSettings(withSystemFonts(updated))
                // Watch for the page's style-compatibility correction (see FoliaTransparency docs).
                expectedTransparency = Triple(next.transparent, next.passthrough, System.currentTimeMillis())
            }
            log("shortcut transparency: ${if (running) "applied" else "persisted"} ${FoliaTransparency.describe(next)}")
            if (!running) {
                toast(
                    "播放页透明背景：${if (next.transparent) "开" else "关"}" +
                        (if (next.passthrough) " + 鼠标穿透" else "") + "（下次打开歌词窗口生效）",
                    WorkshopApi.Ui.ToastType.Success
                )
            }
        } catch (t: Throwable) {
            log("shortcut transparency failed: ${t::class.java.name}: ${t.message}")
        }
    }

    /**
     * The page applies incoming settings through its own store, which refuses the colour-key mode for
     * styles that cannot render transparency. When it refuses it re-emits the corrected tree; compare
     * that echo with what the shortcut asked for and warn instead of leaving the user with a shortcut
     * that appears to do nothing. Echoes outside the window are unrelated setting changes.
     */
    private fun checkTransparencyExpectation(cleanTree: String) {
        val expected = expectedTransparency ?: return
        val withinWindow = System.currentTimeMillis() - expected.third <= TRANSPARENCY_ECHO_WINDOW_MS
        expectedTransparency = null
        if (!withinWindow) return
        val actual = FoliaTransparency.read(cleanTree)
        if (actual.transparent == expected.first && actual.passthrough == expected.second) return
        log(
            "shortcut transparency refused by page style: wanted=${expected.first}/${expected.second} " +
                "actual=${FoliaTransparency.describe(actual)}"
        )
        toast("当前歌词样式不支持播放页透明背景", WorkshopApi.Ui.ToastType.Warning)
    }

    /** One action for the shortcut and the tray entry: open when no session is running, otherwise close. */
    private fun toggleFoliaWindow() {
        try {
            if (bridge.isRunning()) {
                log("toggle: closing Folia window")
                bridge.stop()
            } else {
                log("toggle: opening Folia window")
                openFolia()
            }
        } catch (t: Throwable) {
            log("toggle failed: ${t::class.java.name}: ${t.message}")
        }
    }

    // -------------------------------------------------------------- window ----

    /**
     * Opens the real Folia window (native WebView2 helper) and streams playback into it.
     * Falls back to the Swing placeholder only when the helper cannot be located/spawned.
     */
    private fun openFolia() {
        bridge.settingsTree = withSystemFonts(settingsTree)
        // v0.4.0: the opening animation is tinted from the current cover (fallback palette when there
        // is no artwork). Computing it before the spawn means the host has everything on first paint.
        if (transitionAnimationEnabled) {
            runCatching { bridge.curtainPalette = curtainPaletteCsv() }
                .onFailure { log("curtain palette preparation failed: ${it::class.java.name}: ${it.message}") }
        }
        val started = try {
            bridge.open()
        } catch (t: Throwable) {
            log("bridge open failed: ${t::class.java.name}: ${t.message}")
            false
        }
        if (started) {
            log("Folia window requested (helper pid=${bridge.pidOrNull()})")
        } else {
            log("helper unavailable, opening Swing fallback window")
            openSwingFallbackWindow()
        }
    }

    private fun openSwingFallbackWindow() {
        SwingUtilities.invokeLater {
            try {
                swingFallbackWindow?.let { existing ->
                    if (existing.isDisplayable) {
                        existing.toFront()
                        existing.requestFocus()
                        return@invokeLater
                    }
                }
                val frame = JFrame("Folia")
                frame.isUndecorated = true
                frame.background = Color.BLACK
                frame.contentPane.background = Color.BLACK
                frame.addWindowListener(object : WindowAdapter() {
                    override fun windowClosed(e: WindowEvent) {
                        swingFallbackWindow = null
                        log("fallback window closed")
                    }
                })
                val label = JLabel("Folia (fallback)", SwingConstants.CENTER)
                label.foreground = Color(0x33, 0xDD, 0x77)
                label.font = label.font.deriveFont(48f)
                frame.contentPane.add(label)
                frame.rootPane.registerKeyboardAction(
                    { frame.dispose() },
                    KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0),
                    JComponent.WHEN_IN_FOCUSED_WINDOW
                )
                val screen = Toolkit.getDefaultToolkit().screenSize
                frame.setSize(screen)
                frame.setLocation(0, 0)
                frame.isAlwaysOnTop = true
                frame.isVisible = true
                frame.requestFocus()
                swingFallbackWindow = frame
                log("fallback fullscreen window opened ($screen)")
            } catch (t: Throwable) {
                log("openSwingFallbackWindow error: ${t::class.java.name}: ${t.message}")
            }
        }
    }

    // --------------------------------------------------------------- misc ----

    /**
     * Settings trees travel to the page with a top-level `"systemFonts":[<installed families>]` member
     * so Folia's font picker can list what this machine actually has.
     *
     * The merge is deliberately dumb and cheap (see [FoliaSystemFonts.mergeSystemFontsJson]): a
     * non-object tree is returned unchanged, an existing member is overwritten in place, and a tree
     * that already carries the exact payload comes back as the same instance. It never throws, so it
     * is safe to call on every hand-off to the helper.
     */
    private fun withSystemFonts(tree: String): String = FoliaSystemFonts.mergeSystemFontsJson(tree)

    private fun toast(text: String, type: WorkshopApi.Ui.ToastType) {
        runCatching { WorkshopApi.ui.toast(text, type) }.onFailure { log("toast failed: $it") }
    }

    fun log(message: String) {
        runCatching {
            val file = File(pluginContext.pluginPath, "spw-folia.log")
            file.parentFile?.mkdirs()
            file.appendText("[${LocalDateTime.now()}] $message\n")
        }
    }

    companion object {
        /** Shown in the helper handshake until [start] forwards the real host version. */
        const val SPW_VERSION = "1.19.0"
        const val PLUGIN_VERSION = "0.4.2"

        /** How long the start-up watcher waits for PF4J to instantiate the playback extension. */
        private const val EXTENSION_WATCH_MS = 20_000L

        /** Hook registration retries while the plugin's "started" transition settles. */
        private const val HOOK_RETRY_COUNT = 20
        private const val HOOK_RETRY_DELAY_MS = 500L

        /** v0.3.2: key-binding action id shown in SPW's shortcut settings. */
        private const val TOGGLE_ACTION_ID = "toggle-folia-visualizer"

        /** v0.4.0: player-page transparency shortcuts (see [FoliaTransparency]). */
        private const val TRANSPARENT_ACTION_ID = "toggle-transparent-player-background"
        private const val TRANSPARENT_PASSTHROUGH_ACTION_ID =
            "toggle-transparent-player-background-mouse-passthrough"

        /** How long a shortcut waits for the page's style-compatibility echo before giving up. */
        private const val TRANSPARENCY_ECHO_WINDOW_MS = 2_500L

        /** v0.4.0: 配置 page switch declared in `preference_config.json` (config.json). */
        private const val TRANSITION_ANIMATION_KEY = "transitionAnimation"

        /** issue #12: 配置 page switch that turns on the host's `--verbose-log` diagnostic stream. */
        private const val VERBOSE_LOG_KEY = "verboseLog"

        /**
         * Fade-in window of the opening animation, milliseconds.
         *
         * Fixed instead of user-configurable: WebView2's cold start takes 1.5–2 s and the veil has to
         * cover it, so a 0.3–2.0 s slider was not perceivable (the opening time stayed load-bound).
         * See the 配置 page — only the on/off switch is exposed.
         */
        private const val TRANSITION_ANIMATION_MS = 800

        /** Dev checkout root, used only as a fallback while assets are not packaged next to the plugin. */
        private const val DEV_ROOT = "D:/输出目录/dsh2"

        @Volatile
        private var instance: FoliaPlugin? = null

        fun devRoot(): File = File(DEV_ROOT)

        fun logStatic(message: String) {
            instance?.log(message)
        }

        /** issue #12: lets [FoliaDiagnostics] toast from the 配置 page button (no plugin instance needed). */
        fun toastStatic(text: String, type: WorkshopApi.Ui.ToastType) {
            val target = instance
            if (target != null) target.toast(text, type)
            else runCatching { WorkshopApi.ui.toast(text, type) }
        }

        /**
         * issue #12 增加日志功能: `preference_config.json` 「出现问题」button target.
         *
         * SPW resolves `on_click` as `<class>.<method>` and calls it with no arguments, so this has to
         * live in the companion object as a static method (see the workshop API example's
         * `MainPlugin.onExampleButtonClick`). Everything it needs comes from the running instance;
         * with no instance (button pressed while the plugin is stopped) it degrades to a toast.
         */
        @JvmStatic
        @JvmName("onReportProblem")
        fun onReportProblem() {
            val target = instance
            if (target == null) {
                runCatching {
                    WorkshopApi.ui.toast("spw-folia 插件未启动，无法检查环境", WorkshopApi.Ui.ToastType.Warning)
                }
                return
            }
            val pluginPath = File(target.pluginContext.pluginPath)
            FoliaDiagnostics.onReportProblem(
                pluginPath = pluginPath,
                spwVersion = target.pluginContext.spwVersion,
                pluginVersion = target.pluginContext.pluginVersion,
            )
        }
    }
}
