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
     * v0.4.12: every 配置 page switch (显示播放条 / 显示问题反馈按钮 / 打开过渡动画 / 详细日志) is
     * read and pushed by this one object. It treats the config FILES as the source of truth and
     * reloads them, because the host's change callback proved unreliable on a real machine and
     * `ConfigManager.getConfig()` hands back a cached helper (see [FoliaConfigSync]).
     */
    private val configSync: FoliaConfigSync = FoliaConfigSync(::log) {
        // v0.4.13 (issue: 三个配置开关全部不生效): the spawn-time flags must follow the switch too.
        // v0.4.12 assigned them only once inside registerConfigSync(), so toggling 打开过渡动画 while
        // Folia was not running left `--no-curtain` stale for every later launch — the switch looked
        // saved but the next window still behaved like the old value. Re-assigning here (on every
        // push) means the next spawn always reflects the current file.
        bridge.curtainEnabled = configSync.transitionAnimation
        bridge.verboseLog = configSync.verboseLog
        if (bridge.isRunning()) bridge.sendSettings(withInjectedMembers(settingsTree))
    }

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
        registerConfigSync()
        bridge.settingsTree = withInjectedMembers(settingsTree)
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
            val cleanTree = stripInjectedMembers(tree)
            settingsTree = cleanTree
            bridge.settingsTree = withInjectedMembers(cleanTree)
            settingsStore.persist(cleanTree)
            // v0.4.0: a refusal of the shortcut's transparency request arrives through this path.
            checkTransparencyExpectation(cleanTree)
        }
        bridge.onClosed = { reason -> log("folia window closed (reason=$reason); plugin stays loaded") }
        // v0.4.7: when the helper dies for a diagnosable reason, tell the user *what* it was instead
        // of letting the window blink out and leaving the exit code buried in the log.
        bridge.onHostExitReason = { text ->
            log("host exit reason: $text")
            toast("Folia 窗口已关闭：$text", WorkshopApi.Ui.ToastType.Error)
        }
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
     * the historical behaviour, and still the fastest path because it costs zero bytecode work. An
     * unknown build needs a structural index of the host archive (~1.4 s on 1.19.3, 42k classes), so
     * it runs on a background thread to keep host UI start-up free of that one-off stall; the
     * registration is retried because the hook API only accepts the starting/started plugin.
     */
    private fun installHookForHostBuild() {
        val dir = File(pluginContext.pluginPath)
        val version = pluginContext.spwVersion
        if (HostTargets.quickLoad(dir, version, ::log)) {
            installHook()
            return
        }
        log("host build $version matched no known profile; indexing the host bytecode in the background")
        // The host class locates its own code source, which is more reliable than `java.class.path`
        // (a single polyglot `ffmpeg-x64.dll` on shipped builds). Read lazily inside the worker so a
        // missing or odd WorkshopApi instance can never break `start()`.
        val worker = Thread({
            val hostClass = runCatching { WorkshopApi.instance.javaClass }.getOrElse { failure ->
                log("host class unavailable for structural discovery: ${failure::class.java.name}: ${failure.message}")
                null
            }
            val target = HostTargets.deepResolve(dir, version, hostClass, ::log)
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
        runCatching { configSync.stop() }.onFailure { log("config sync stop failed: $it") }
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
                            // The indices come from the resolved target: the profiles carry the
                            // 1.19.x constants (5 / 2) and structural discovery derives them from
                            // the builder's parameter list, so a reshuffled signature cannot
                            // silently feed us the wrong argument.
                            val scopeIndex = target.scopeParameter
                            val popupIndex = target.popupParameter
                            if (scopeIndex !in args.indices || popupIndex !in args.indices) {
                                log(
                                    "after: argument indices out of range " +
                                        "(scope=$scopeIndex popup=$popupIndex args=${args.size}, ${target.origin})"
                                )
                                return
                            }
                            val scope = args[scopeIndex]
                            if (scope == null) {
                                log("after: null MenuFlyoutScope")
                                return
                            }
                            appendFoliaItem(scope, args[popupIndex], target)
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
     * v0.4.8: mirrors the 配置 page's 打开过渡动画 switch (declared in `preference_config.json`).
     *
     * SPW renders that page from the declaration and stores the value in the plugin's `config.json`
     * through its own ConfigManager; the plugin never shows its own UI for it. The value decides
     * whether the native helper is spawned with `--no-curtain`; the listener fires when the user
     * edits the page, so no SPW restart is needed. The animation itself is Folia's own page splash —
     * the host only times its fade-out, so there is nothing to configure here.
     */
    /**
     * v0.4.12: hands the config manager to [FoliaConfigSync], which does the first read, registers
     * the fast-path listener and starts the disk watcher.
     *
     * The switches are owned by SPW's ConfigManager (`preference_config.json` → one file per group)
     * and the plugin never renders its own UI for them; it only mirrors them. Two are spawn-time
     * (`transitionAnimation` → `--no-curtain`, `verboseLog` → `--verbose-log`) and two are hot
     * (`showProblemButton`, `previewAnimation`), injected into the settings tree so the page remounts
     * the 救生圈 button / the style shelf without a restart.
     *
     * v0.4.17 (issue #18 item 2): `showPlaybackBar` is no longer one of them. The switch moved to the
     * player page's own menu and the page owns it; the plugin only reads its old `config.json` value
     * as a one-time migration hint (`showPlaybackBarLegacy`).
     */
    private fun registerConfigSync() {
        val manager = try {
            WorkshopApi.manager.createConfigManager()
        } catch (t: Throwable) {
            log("config manager unavailable: ${t::class.java.name}: ${t.message}; config switches stay at defaults")
            return
        }
        runCatching { configSync.start(manager) }
            .onFailure { log("config sync start failed: ${it::class.java.name}: ${it.message}") }
        bridge.curtainEnabled = configSync.transitionAnimation
        bridge.verboseLog = configSync.verboseLog
    }

    /**
     * Applies the root-level members the page must receive but must never persist.
     *
     * Four of them today, and they differ in where the truth lives:
     *  - `systemFonts` — derived data enumerated locally, stripped on the way back by
     *    [FoliaSystemFonts.withoutSystemFontsJson];
     *  - `showProblemButton` (v0.4.11) — a 配置 page switch owned by the plugin, rewritten from
     *    [FoliaConfigSync] on every push instead of trusted from the incoming tree;
     *  - `previewAnimation` (v0.4.15) — the same kind of switch, same rule;
     *  - `showPlaybackBarLegacy` (v0.4.17) — a one-time MIGRATION hint, not a setting: the old
     *    `config.json` value, offered to the page so it can seed its own switch. The page owns that
     *    switch now, so this member is stripped on the way back and never trusted from the echo.
     *
     * One helper for all of them matters because four call sites publish the tree (startup, host
     * open, shortcut edits, page echo); missing one used to mean "the setting silently stops
     * applying after the first echo from the page".
     */
    private fun withInjectedMembers(tree: String): String =
        withSystemFonts(configSync.applyTo(tree))

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
                bridge.sendSettings(withInjectedMembers(updated))
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
        bridge.settingsTree = withInjectedMembers(settingsTree)
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
        const val PLUGIN_VERSION = "0.4.19"

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
         * v0.4.17 (issue #18 item 2): the root-level settings-tree member that seeds the page's own
         * 「显示播放条」 switch from the OLD `config.json` value.
         *
         * The switch itself moved to the player page's menu, and the page persists it in the settings
         * tree, so `showPlaybackBar` is no longer ours: it is stripped from nothing, injected by
         * nobody, and only ever echoed back to us for storage.
         *
         * This `…Legacy` spelling is separate because the two roles must stay distinguishable: the
         * page seeds its store from this ONCE (only while its tree has no `showPlaybackBar`), and we
         * strip it on the way back. Reusing one name would let a stale config.json value masquerade
         * as the page's live value and overwrite the user's choice on the next push.
         *
         * Kept in step with `FoliaConfigSync.SHOW_PLAYBACK_BAR_LEGACY_KEY`, which produces it.
         */
        private const val SHOW_PLAYBACK_BAR_LEGACY_KEY = "showPlaybackBarLegacy"

        /**
         * v0.4.11: 配置 page switch that shows the 救生圈 diagnostics button on the player page.
         * Default **off**; also the root-level settings-tree member the page reads.
         */
        private const val SHOW_PROBLEM_BUTTON_KEY = "showProblemButton"

        /**
         * v0.4.15: 配置 page switch that lets the 歌词样式 shelf draw live animated thumbnails.
         * Default **on**; also the root-level settings-tree member the page reads.
         *
         * Off is the cheap path: the page draws a plain glyph per style instead of importing the
         * renderer chunks, so opening 设置 costs no WebGL contexts and no memory for pictures.
         */
        private const val PREVIEW_ANIMATION_KEY = "previewAnimation"

        /** Dev checkout root, used only as a fallback while assets are not packaged next to the plugin. */
        private const val DEV_ROOT = "D:/输出目录/dsh2"

        @Volatile
        private var instance: FoliaPlugin? = null

        fun devRoot(): File = File(DEV_ROOT)

        /**
         * Removes the injected members from a tree the page echoed back, before it is persisted.
         *
         * Three are stripped, and they are stripped for two different reasons:
         *  - `systemFonts` is DERIVED data (recomputed on every start); persisting it would add
         *    ~10-20 KB of names that go stale as soon as a font is installed;
         *  - `showProblemButton` / `previewAnimation` are owned by the 配置 page (config.json), so
         *    keeping a copy in the settings file would give one fact two writers and let the page's
         *    echo win;
         *  - `showPlaybackBarLegacy` is a one-time MIGRATION HINT, not a setting: its value is
         *    whatever the old config.json still holds. Persisting it would freeze a stale copy into
         *    the tree and make it look like the page's own value.
         *
         * ## `showPlaybackBar` is deliberately NOT in that list (v0.4.17, issue #18 item 2)
         *
         * The 「显示播放条」 switch moved from the 配置 page to a menu on the player page itself.
         * That makes the PAGE the owner and this settings file its persistence, so stripping the
         * member here would silently discard every change the user makes in the new menu: the switch
         * would look live and forget itself on the next restart. This is the exact inverse of the
         * pre-v0.4.17 rule — the two must not be "harmonised" back together, which is why it is
         * spelled out.
         *
         * `internal` (not private) so a JVM test can pin both halves of that rule: the legacy hint
         * and the config-page switches are removed, the page-owned one survives. Losing either half
         * is invisible in the UI and would only show up as "my setting does not stick" from a user.
         */
        internal fun stripInjectedMembers(tree: String): String = Json.withoutMember(
            Json.withoutMember(
                Json.withoutMember(
                    FoliaSystemFonts.withoutSystemFontsJson(tree),
                    SHOW_PROBLEM_BUTTON_KEY,
                ),
                PREVIEW_ANIMATION_KEY,
            ),
            SHOW_PLAYBACK_BAR_LEGACY_KEY,
        )

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
         *
         * v0.4.7: the running helper's pid is forwarded so the report can tell "the window is
         * closed" (advisory) from "the window died" (worth saying). The self-check itself never
         * throws — see [FoliaDiagnostics.onReportProblem].
         */
        @JvmStatic
        @JvmName("onReportProblem")
        fun onReportProblem() {
            val target = instance
            if (target == null) {
                runCatching {
                    WorkshopApi.ui.toast(
                        "spw-folia 插件未启动，无法检查环境；请在 SPW 插件管理里启用后重启",
                        WorkshopApi.Ui.ToastType.Warning,
                    )
                }
                return
            }
            val pluginPath = File(target.pluginContext.pluginPath)
            val hostPid = runCatching { target.bridge.pidOrNull() }.getOrDefault(-1L)
            FoliaDiagnostics.onReportProblem(
                pluginPath = pluginPath,
                spwVersion = target.pluginContext.spwVersion,
                pluginVersion = target.pluginContext.pluginVersion,
                hostPid = hostPid,
            )
        }
    }
}
