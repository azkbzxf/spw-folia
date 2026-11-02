package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.config.ConfigHelper
import com.xuncorp.spw.workshop.api.config.ConfigManager
import java.util.concurrent.atomic.AtomicBoolean
import java.util.function.Consumer

/**
 * v0.4.12: 配置页开关的**唯一**读取/推送通道（重写「改开关不立即生效」）。
 *
 * ## 为什么重写
 *
 * v0.4.10–v0.4.11 把这条链路压在宿主的 `ConfigManager.addConfigChangeListener` 上，结果在真机上
 * 三处都不可靠：
 *
 *  1. **回调不一定来。** 实测：在配置页把「显示播放条」关掉，`config.json` 的字节确实变了、
 *     界面上的开关也变灰了，但插件的监听器**一次都没被调用**（日志里没有任何 `showPlaybackBar`
 *     行）。带组名 / 不带组名的重载都注册过，仍然如此。
 *  2. **`getConfig()` 返回缓存。** 在回调里再调一次 `manager.getConfig(PLAYER_CONFIG)`，拿到的是
 *     管理器缓存的那个 `ConfigHelper`，值还是**改之前**的。于是 `changed == false`，推送被跳过 ——
 *     这正是「必须重开窗口才生效」的直接原因。
 *  3. **同一次编辑会触发多次回调。** 回调里若在「这个 helper 没这个键」时回退去读缓存 helper，
 *     一次点击就会产生「新值、旧值」两条事件，页面最后收到旧值，于是「开关变灰了，播放条还在」。
 *
 * 所以这里不再把回调当成事实来源，而是把**磁盘上的文件**当成唯一事实来源：
 *
 *  - [sync] 对每个配置文件先 `reload()`（强制从磁盘重读，绕开宿主的缓存），再读全部开关；
 *    只有值真的变了才写日志并 `sendSettings` 推送一次。
 *  - 触发 [sync] 的有两条：宿主的变更回调（快路径，回调真的来时立即生效）、以及一个低频守护
 *    线程（兜底，回调不来时最多等一个 [SYNC_INTERVAL_MS] 周期）。
 *  - 回调传入的 `helper` 只用来**缩小范围**（它属于哪个文件），绝不用它当值来源；读值一律走
 *    [readBoolean] 从刚 reload 过的 helper 读。
 *
 * 代价：守护线程每 [SYNC_INTERVAL_MS] 读两个小 JSON 文件。两个文件都在几 KB 量级，且只在插件
 * 存活期间运行，可以忽略；换来的是「开关一定会在一个周期内生效」，不再依赖宿主行为。
 */
@OptIn(UnstableSpwWorkshopApi::class)
internal class FoliaConfigSync(
    private val log: (String) -> Unit,
    /** Publishes the current settings tree to the page; no-op when no window is running. */
    private val pushTree: () -> Unit,
) {

    /** Last known values. Written only by [sync], read by [withInjectedMembers] callers. */
    @Volatile
    var showPlaybackBar: Boolean = DEFAULT_SHOW_PLAYBACK_BAR
        private set

    @Volatile
    var showProblemButton: Boolean = DEFAULT_SHOW_PROBLEM_BUTTON
        private set

    @Volatile
    var transitionAnimation: Boolean = DEFAULT_TRANSITION_ANIMATION
        private set

    @Volatile
    var verboseLog: Boolean = DEFAULT_VERBOSE_LOG
        private set

    private var manager: ConfigManager? = null
    private var listener: Consumer<ConfigHelper>? = null
    private var watcher: Thread? = null

    private val started = AtomicBoolean(false)
    private val firstSyncDone = AtomicBoolean(false)

    /** Guards the one-shot retry used when a config file is caught mid-write. */
    private val retriedAfterEmpty = AtomicBoolean(false)

    /**
     * Binds the manager, does the first sync, registers the fast-path listener and starts the
     * fallback watcher. Idempotent; safe to call from `start()` only.
     */
    fun start(manager: ConfigManager) {
        if (!started.compareAndSet(false, true)) return
        this.manager = manager
        // v0.4.12 diagnostic: print where each group really lives and what the FILE holds, so a
        // "switch did not apply" report can be settled from the log alone.
        for (group in listOf(PLAYER_CONFIG, DIAGNOSTICS_CONFIG)) {
            runCatching {
                val file = configFileOf(manager, group)
                val text = readConfigText(file)
                val bar = readBoolean(text, SHOW_PLAYBACK_BAR_KEY)
                log(
                    "config probe $group path=$file bytes=${if (file != null && file.isFile) file.length() else -1} " +
                        "$SHOW_PLAYBACK_BAR_KEY=$bar textLen=${text?.length ?: 0}"
                )
            }.onFailure { log("config probe $group failed: ${it::class.java.name}: ${it.message}") }
        }
        sync(reason = "start")

        val callback = Consumer<ConfigHelper> { helper ->
            // Fast path only. The value is NOT read from `helper` (it may be the manager's cached
            // copy — that was the original bug); it is re-read from disk by [sync].
            val group = groupOf(helper)
            sync(reason = "listener($group)")
        }
        runCatching { manager.addConfigChangeListener(callback) }
            .onSuccess {
                listener = callback
                log("config listener registered (fast path)")
            }
            .onFailure { log("config listener registration failed: ${it::class.java.name}: ${it.message}") }

        startWatcher()
    }

    /** Stops the watcher and drops the listener. Idempotent. */
    fun stop() {
        watcher?.interrupt()
        watcher = null
        val m = manager
        val l = listener
        if (m != null && l != null) {
            runCatching { m.removeConfigChangeListener(l) }
                .onFailure { log("config listener removal failed: $it") }
        }
        listener = null
        manager = null
        started.set(false)
    }

    /** The switch values as the settings tree carries them. */
    fun applyTo(tree: String): String {
        val withBar = Json.withBoolMember(tree, SHOW_PLAYBACK_BAR_KEY, showPlaybackBar)
        val withProblem = Json.withBoolMember(withBar, SHOW_PROBLEM_BUTTON_KEY, showProblemButton)
        return withProblem
    }

    // ------------------------------------------------------------------ sync ----

    /**
     * Re-reads every switch from disk and pushes the tree when anything changed.
     *
     * [reason] is only for the log. Every read goes through [ConfigHelper.reload] first, because the
     * manager hands back cached helpers whose values predate an edit made through the 配置 page.
     */
    @Synchronized
    fun sync(reason: String) {
        val m = manager ?: return
        val playerText = readConfigText(configFileOf(m, PLAYER_CONFIG))
        val diagnosticsText = readConfigText(configFileOf(m, DIAGNOSTICS_CONFIG))
        if (playerText == null && diagnosticsText == null) {
            // A missing file is normal on a fresh install, but an EMPTY one is what we see while the
            // host rewrites config.json (its save truncates first, then writes). Treating that window
            // as "no config" silently skipped a whole sync — the next change then looked like it did
            // not apply, which is the very symptom this class exists to prevent. Wait one watcher
            // tick and try once more before giving up.
            if (retriedAfterEmpty.compareAndSet(false, true)) {
                log("config sync ($reason): no config file readable; retrying once")
                Thread.sleep(EMPTY_RETRY_DELAY_MS)
                retriedAfterEmpty.set(false)
                sync(reason = "$reason/retry")
            } else {
                log("config sync ($reason): no config file readable")
            }
            return
        }
        retriedAfterEmpty.set(false)

        var changed = false

        // 播放页组
        readBoolean(playerText, TRANSITION_ANIMATION_KEY)?.let { value ->
            if (value != transitionAnimation) {
                transitionAnimation = value
                changed = true
                log("config $TRANSITION_ANIMATION_KEY=$value (splash=${if (value) "on" else "off"})")
            }
        }
        readBoolean(playerText, SHOW_PLAYBACK_BAR_KEY)?.let { value ->
            if (value != showPlaybackBar) {
                showPlaybackBar = value
                changed = true
                log("config $SHOW_PLAYBACK_BAR_KEY=$value (playback bar ${if (value) "shown" else "hidden"})")
            }
        }
        readBoolean(playerText, SHOW_PROBLEM_BUTTON_KEY)?.let { value ->
            if (value != showProblemButton) {
                showProblemButton = value
                changed = true
                log("config $SHOW_PROBLEM_BUTTON_KEY=$value (problem button ${if (value) "shown" else "hidden"})")
            }
        }

        // 诊断与日志组（v0.4.11 搬过去的；旧值从 config.json 迁移）
        val verbose = readBoolean(diagnosticsText, VERBOSE_LOG_KEY)
            ?: readBoolean(playerText, VERBOSE_LOG_KEY)
        if (verbose != null && verbose != verboseLog) {
            verboseLog = verbose
            changed = true
            log("config $VERBOSE_LOG_KEY=$verbose (host --verbose-log=${if (verbose) "on" else "off"})")
        }

        if (changed) {
            log("config sync ($reason): pushing settings tree")
            runCatching { pushTree() }
                .onFailure { log("settings push failed: ${it::class.java.name}: ${it.message}") }
        } else if (firstSyncDone.compareAndSet(false, true)) {
            log(
                "config sync ($reason): unchanged " +
                    "(showPlaybackBar=$showPlaybackBar showProblemButton=$showProblemButton " +
                    "transitionAnimation=$transitionAnimation verboseLog=$verboseLog)"
            )
        }
        // A periodic "unchanged" line would flood the log once per second; only the first sync
        // reports the values, every later one stays silent unless something actually changed.
    }

    // --------------------------------------------------------------- helpers ----

    private fun startWatcher() {
        val worker = Thread({
            while (!Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(SYNC_INTERVAL_MS)
                } catch (e: InterruptedException) {
                    return@Thread
                }
                runCatching { sync(reason = "watch") }
                    .onFailure { log("config watch failed: ${it::class.java.name}: ${it.message}") }
            }
        }, "spw-folia-config-sync")
        worker.isDaemon = true
        worker.start()
        watcher = worker
        log("config watcher started (every ${SYNC_INTERVAL_MS} ms; disk is the source of truth)")
    }

    /**
     * Where the config file of [name] lives, according to the host.
     *
     * Only the PATH is taken from the host's helper: its `get()` returns null for keys that are
     * plainly present in the file on disk (measured on SPW 1.19.3 — `config.json` held
     * `"showPlaybackBar":false` while `helper.get("showPlaybackBar", null)` returned null), so the
     * helper's value store is not the file the 配置 page writes. Reading the file directly is the
     * only way both sides are guaranteed to agree.
     */
    private fun configFileOf(manager: ConfigManager, name: String): java.io.File? {
        val helper = runCatching { manager.getConfig(name) }.getOrElse { t ->
            log("config open $name failed: ${t::class.java.name}: ${t.message}")
            return null
        }
        return runCatching { helper.getConfigPath().toFile() }.getOrElse { t ->
            log("config path $name failed: ${t::class.java.name}: ${t.message}")
            null
        }
    }

    /** The raw JSON text of a config file, or null when it is missing / unreadable. */
    private fun readConfigText(file: java.io.File?): String? {
        if (file == null || !file.isFile) return null
        return runCatching { file.readText(Charsets.UTF_8).trim().ifEmpty { null } }
            .getOrElse { t ->
                log("config read ${file.name} failed: ${t::class.java.name}: ${t.message}")
                null
            }
    }

    /** A stored boolean, or null when the file does not carry the key as a boolean literal. */
    private fun readBoolean(text: String?, key: String): Boolean? {
        if (text == null) return null
        return Json.boolField(text, key)
    }

    /** Which group a listener helper belongs to, for the log only. */
    private fun groupOf(helper: ConfigHelper): String = runCatching {
        val path = helper.getConfigPath().toString().replace('\\', '/')
        if (path.endsWith("/$DIAGNOSTICS_CONFIG")) DIAGNOSTICS_CONFIG else PLAYER_CONFIG
    }.getOrDefault("?")

    private companion object {
        const val PLAYER_CONFIG = "config.json"
        const val DIAGNOSTICS_CONFIG = "diagnostics.json"

        const val TRANSITION_ANIMATION_KEY = "transitionAnimation"
        const val SHOW_PLAYBACK_BAR_KEY = "showPlaybackBar"
        const val SHOW_PROBLEM_BUTTON_KEY = "showProblemButton"
        const val VERBOSE_LOG_KEY = "verboseLog"

        const val DEFAULT_TRANSITION_ANIMATION = false
        const val DEFAULT_SHOW_PLAYBACK_BAR = true
        const val DEFAULT_SHOW_PROBLEM_BUTTON = false
        const val DEFAULT_VERBOSE_LOG = false

        /** How long a switch edit may take to reach the page when the host's callback never fires. */
        const val SYNC_INTERVAL_MS = 1000L

        /** Wait before the single retry taken when config.json was caught mid-write (see [sync]). */
        const val EMPTY_RETRY_DELAY_MS = 120L
    }
}
