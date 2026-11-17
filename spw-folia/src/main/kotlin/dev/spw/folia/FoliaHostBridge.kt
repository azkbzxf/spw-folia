package dev.spw.folia

import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Owns the `spw-folia-host.exe` helper process and the protocol-v1 JSON-lines bridge.
 *
 * Protocol (docs/protocol.md v1, verified against poc/webview/host/Program.cs + HostForm.cs):
 *  - plugin -> helper (stdin):  {"t":"hello"...}, {"t":"settings"...}, {"t":"state"...},
 *    {"t":"lyrics"...}, {"t":"track"...}, {"t":"queue"...} (v0.3.0), {"t":"mods"...} (issue #23),
 *    {"t":"quit"}
 *  - helper -> plugin (stdout): {"t":"ready"...}, {"t":"closed","reason":...},
 *    {"t":"settings","settings":{...}}, {"t":"action"...}, {"t":"control"...} (v0.3.0),
 *    {"t":"modAction"...} (issue #23), {"t":"log"...}
 *
 * The helper reads stdin on a dedicated thread; EOF (plugin process death) closes it, so a
 * double safety net (quit on stop + stdin EOF) keeps no orphan processes around.
 */
internal class FoliaHostBridge(
    private val pluginPath: File,
    private val log: (String) -> Unit,
    /**
     * issue #23（第二轮）：这个桥开的是「只有市场」的窗口，不是播放页。
     *
     * 同一个宿主 exe、同一套协议，但**窗口形态完全不同**（见 [open] 的 argv）：不要全屏、不要
     * 置顶、不要透明/色键、不要开屏动画、不要常亮屏幕，`--url` 直接指向市场页。用户的要求是
     * 「从配置中进入商店只弹出商店的小窗口」，而播放页那边的一整套形态（全屏 + 色键 + 输入捕获窗）
     * 在这里全是负担。
     *
     * 为什么是**第二个实例**而不是给现有实例加多会话：这个类的每个会话状态（`process`、
     * `pendingLines`、`writerThread`、`stdinBroken`、`pid`、`stdoutLog`、`pump`）都是实例字段，
     * `open()` 的 `@Synchronized` 也是实例级的。所以第二个实例天然隔离，而多会话改造要动每一个
     * 字段的归属。
     */
    private val marketOnly: Boolean = false,
) {

    @Volatile private var process: Process? = null
    @Volatile private var ready = false
    @Volatile private var stopping = false

    /**
     * v0.1.11: the helper's stdin is now written exclusively by one daemon thread fed from a bounded
     * queue. The old `sendLine` wrote *inside synchronized(this)*, so once the helper stopped reading
     * (its stdin pump could die, see the v0.1.11 host fix) the JVM blocked forever inside
     * `OutputStreamWriter.flush()` **while holding the very monitor** that `open()`/`stop()`/
     * `cleanup()`/`mirrorStdout()` also need. `open()` is called straight from the Compose UI thread
     * when the user clicks 更多 -> Folia, so a wedged helper froze all of SPW ("未响应" -> force close).
     * With a dedicated writer nothing in SPW can ever block on the pipe again; back-pressure drops
     * the oldest queued line instead (every line is perishable state, never a command that matters).
     *
     * v0.2.0: the queue belongs to one helper session (re-created by `startStdinWriter`). A window
     * can be closed (ESC / 更多 -> Folia toggled) without the plugin being disabled, so the bridge
     * is re-opened on the same instance: a writer of a previous session may still be parked in
     * `take()`. It is interrupted before the new queue is published, and its `finally` may only
     * touch the session it owns - otherwise a stale writer could wipe the *new* queue or mark the
     * new pipe `stdinBroken` after writing the old, closed process, silently muting the second window.
     */
    @Volatile private var pendingLines: LinkedBlockingQueue<String>? = null
    private val stdoutLogLock = Any()
    @Volatile private var writerThread: Thread? = null
    @Volatile private var stdinBroken = false

    @Volatile private var pid: Long = -1L

    /** Opaque Folia settings tree (canonical JSON), updated from the page via stdout `settings`. */
    @Volatile var settingsTree: String? = null

    /**
     * Host version reported in the `hello` line. Set by [FoliaPlugin.start] to the *running* SPW
     * version (1.19.2, 1.20.x, …); the compile-time constant is only a placeholder so the helper
     * still gets a well-formed handshake when the plugin is driven by tests.
     */
    @Volatile var hostVersion: String = FoliaPlugin.SPW_VERSION

    /** Called when the helper reports `closed` (window closed by user/helper); plugin stays loaded. */
    @Volatile var onClosed: ((String) -> Unit)? = null

    /** Called with the raw settings JSON whenever the page sends an updated tree. */
    @Volatile var onSettingsFromPage: ((String) -> Unit)? = null

    /**
     * issue #23: called with the raw `modAction` line the host forwarded from the page.
     *
     * The raw line (not a parsed command object) is handed over on purpose: the plugin decides which
     * fields an action needs, and a shape it does not understand must be *refused with a reason*
     * rather than silently dropped by a parser in the transport layer.
     */
    @Volatile var onModAction: ((String) -> Unit)? = null

    /**
     * v0.4.8: 配置 page switch `transitionAnimation`. When false the helper is spawned with
     * `--no-curtain`, which drops `splash=1` from the navigation URL so the page never installs the
     * opening splash. Read at spawn time only; toggling it affects the next open.
     *
     * The animation itself is Folia's own `#app-splash` (dark backdrop + letter-hopping wordmark +
     * waveform bars), drawn by the page. The host only decides when it fades out, so there is no
     * palette, no duration and no drawing code on this side any more (v0.4.0 removed the
     * cover-tinted WinForms veil that used to live here).
     */
    @Volatile var curtainEnabled: Boolean = false

    /**
     * issue #12 增加日志功能: spawn the helper with `--verbose-log`, which adds navigation lines and
     * per-window stall warnings to the host log. Off by default; turned on from the 配置 page so a
     * user reporting a problem can capture a detailed trace without living with the extra lines.
     */
    @Volatile var verboseLog: Boolean = false

    // Providers installed by FoliaPlugin; polled by the state pump.
    @Volatile var snapshotProvider: (() -> PlaybackSnapshot?)? = null
    @Volatile var lyricsProvider: (() -> String?)? = null
    @Volatile var trackProvider: (() -> String?)? = null

    /**
     * v0.3.0: playback queue snapshot (`{"mode":...,"random":...,"index":...,"items":[...]}`),
     * polled every 500 ms and diffed before sending. Null when the host player is not reachable.
     */
    @Volatile var queueProvider: (() -> String?)? = null

    private val lastSentTrack = AtomicReference<String?>(null)

    /** v0.3.0: last queue body sent to the helper; the pump only re-sends on change. */
    private val lastSentQueue = AtomicReference<String?>(null)

    /**
     * Lyrics are tracked separately from the track (v0.1.8): SPW parses a new song's lyrics *after*
     * the track change, so gating the lyrics push on a track-string change meant the page kept the
     * previous song's lines until the cover (which also mutates the track JSON) arrived — or forever
     * when the cover load failed. The pump now diffs the cached lyrics JSON every tick.
     */
    private val lastSentLyrics = AtomicReference<String?>(null)
    private var pump: ScheduledExecutorService? = null
    private var pumpTicks = 0L
    private var lastLoggedPlaying: Boolean? = null
    private var stateLinesSent = 0L
    private var fpsLinesSeen = 0L
    private val droppedLines = AtomicLong(0L)
    private var stdoutLog: BufferedWriter? = null

    fun isRunning(): Boolean {
        val p = process
        return p != null && p.isAlive && !stopping
    }

    fun pidOrNull(): Long = pid

    // -------------------------------------------------------------- lifecycle ----

    /** Spawns the helper if needed, sends hello + settings. Returns true when the process is up. */
    @Synchronized
    fun open(): Boolean {
        if (isRunning()) {
            log("host already running (pid=$pid)")
            return true
        }
        val exe = resolveHelper()?.let { physicalFile(it) }
        if (exe == null) {
            log("host helper not found (looked in pluginPath/host and dev checkout)")
            return false
        }
        val web = resolveWebDir()?.let { physicalFile(it) }
        if (web == null) {
            log("web bundle not found (looked in pluginPath/web and dev checkout)")
            return false
        }
        // The helper is a .NET Framework 4.8 executable: its loader reads <exe>.config *before*
        // managed code runs, and it does so with paths the MSIX filesystem redirection does not
        // cover (see physicalFile()). Warn once here so the failure is diagnosable from the log.
        if (!File(exe.parentFile, exe.name + ".config").isFile) {
            log("helper .config not reachable at ${File(exe.parentFile, exe.name + ".config")}; " +
                "CLR activation will likely fail with 0x80131700 (MSIX virtual path?)")
        }
        val command = mutableListOf(
            exe.absolutePath,
            "--bundle", web.absolutePath,
            "--bundle-version", FoliaPlugin.PLUGIN_VERSION
        )
        // cwd = plugin dir so every relative path inside the helper resolves against the install
        // location; all paths we pass are absolute anyway (cwd is only a safety net). Resolved BEFORE
        // the argv because the market window's `--user-data` lives under it.
        val workDir = physicalFile(pluginPath.absoluteFile).also { it.mkdirs() }
        if (marketOnly) {
            command += marketArgs(File(workDir, MARKET_USER_DATA_DIR).absolutePath)
        } else {
            command += "--fullscreen"
            // issue #23 (second round): the mods root MUST be handed to the helper.
            //
            // Without it the host takes the `mods-dir none (mod files are not served)` branch
            // (`HostForm.MountModsInterceptor`) and mounts no `/__mods/` interceptor at all. The page
            // then imports `https://spw-folia-mods.local/<id>/client.mjs` (the host `mod-host.json`
            // names, an UNMAPPED virtual host answered only by that interceptor), the dynamic import
            // rejects, the Shim records the error and deactivates the mod, and the lyric shelf shows
            // no mod tile at all. The user-visible symptom was 「安装模组后没有变化」: everything looked
            // installed because the list did arrive — only the files could never be fetched.
            //
            // `modsRoot` creates the directory on demand, so a first run with no mods still passes a
            // usable path (and the host creates it too). Two argv entries, never one joined string:
            // the same rule the `/select` argument follows (see FoliaDiagnostics.logFolderCommand).
            command += listOf(
                "--mods-dir",
                FoliaModStore.modsRoot(physicalFile(pluginPath.absoluteFile)).absolutePath
            )
        }
        // v0.4.8: the 配置 page can turn the opening splash off; the helper then navigates with
        // `splash=0`, so the page never installs it (the host also skips its reveal timer).
        if (!curtainEnabled && !marketOnly) {
            command += "--no-curtain"
        }
        val settingsDir = resolveSettingsDir(web)?.let { physicalFile(it) }
        if (settingsDir != null) {
            command += listOf("--settings-dir", settingsDir.absolutePath, "--settings-entry", SETTINGS_ENTRY)
        }
        val stderrLog = File(workDir, if (marketOnly) "spw-folia-host-market.stderr.log" else "spw-folia-host.stderr.log")
        val stdoutLogFile = File(workDir, if (marketOnly) "spw-folia-host-market.stdout.log" else "spw-folia-host.stdout.log")
        // issue #12 增加日志功能: the helper reports its own environment through the settings UI's
        // 「出现问题」 flow, and that report names the log file the plugin mirrors its stdout into.
        command += listOf("--log-file", stdoutLogFile.absolutePath)
        // The 配置 page can ask for the fuller diagnostic stream (navigation, page console at every
        // level, per-window stall lines). Off by default: the verbose lines are only worth it when
        // somebody is going to read the log.
        if (verboseLog) command += "--verbose-log"
        log("spawn cmdline: " + command.joinToString(" "))
        log("spawn cwd=$workDir")
        log("spawn exe=${exe.absolutePath} web=${web.absolutePath} settingsDir=${settingsDir?.absolutePath}")
        log("spawn stdout=$stdoutLogFile stderr=$stderrLog")
        listOf("SPW_FOLIA_HELPER", "SPW_FOLIA_WEB", "SPW_FOLIA_SETTINGS").forEach { key ->
            System.getenv(key)?.let { log("spawn env $key=$it") }
        }
        stopping = false
        stdoutLog = try {
            stdoutLogFile.bufferedWriter(StandardCharsets.UTF_8)
        } catch (t: Throwable) {
            log("stdout log open failed: ${t::class.java.name}: ${t.message}")
            null
        }
        val builder = ProcessBuilder(command)
        builder.directory(workDir)
        builder.redirectError(ProcessBuilder.Redirect.appendTo(stderrLog))
        try {
            builder.redirectOutput(ProcessBuilder.Redirect.PIPE)
        } catch (_: Throwable) {
            // PIPE is already the default; keep going if the helper cannot be reconfigured.
        }
        val p = try {
            builder.start()
        } catch (t: Throwable) {
            log("spawn failed: ${t::class.java.name}: ${t.message}")
            return false
        }
        process = p
        pid = p.pid()
        ready = false
        stateLinesSent = 0
        fpsLinesSeen = 0
        pumpTicks = 0L
        lastLoggedPlaying = null
        lastSentTrack.set(null)
        lastSentLyrics.set(null)
        lastSentQueue.set(null)
        startStdoutReader(p)
        startExitWatcher(p)
        startStdinWriter(p)
        sendLine(
            "{\"t\":\"hello\",\"protocol\":1,\"pluginVersion\":${Json.str(FoliaPlugin.PLUGIN_VERSION)}," +
                "\"spwVersion\":${Json.str(hostVersion)},\"bundleDir\":${Json.str(web.absolutePath)}}"
        )
        settingsTree?.let { sendSettings(it) }
        // issue #23: the mod list rides along with the handshake. `ready` re-pushes it (and that is
        // the copy the page actually receives); this one makes the log of a normal session readable
        // in order and keeps the list correct if the host ever starts forwarding before `ready`.
        lastSentMods?.let { sendMods(it) }
        log("host spawned pid=$pid")
        return true
    }

    /** Sends quit and waits for the helper to exit (force kill after 2 s). */
    @Synchronized
    fun stop() {
        val p = process ?: return
        stopping = true
        stopPump()
        sendLine("{\"t\":\"quit\"}")
        sendLine(WRITER_POISON)
        // Give the writer a moment to flush quit + poison into the pipe; it is a no-op when the
        // writer is already gone (stdinBroken), which `waitFor` below handles through the timeout.
        writerThread?.join(500)
        try {
            if (!p.waitFor(2, TimeUnit.SECONDS)) {
                log("helper did not exit in 2s, killing pid=$pid")
                p.destroyForcibly()
            }
        } catch (t: Throwable) {
            log("helper stop error: ${t::class.java.name}: ${t.message}")
            p.destroyForcibly()
        }
        cleanup("stopped", p)
    }

    // -------------------------------------------------------------- protocol ----

    fun sendSettings(settingsJson: String) {
        settingsTree = settingsJson
        // v0.4.13 (issue: 三个配置开关全部不生效): the protocol is LINE oriented on both ends — we
        // write `line + "\n"` and the helper reads `reader.ReadLine()`. The tree is embedded raw, so
        // a pretty-printed tree (the bundled default-settings.json is 7188 bytes with 268 newlines)
        // was split into hundreds of invalid lines that the helper dropped on the floor: the page
        // never received `showPlaybackBar` / `showProblemButton` and the switches looked dead.
        // Collapse before sending; it is byte-identical JSON, just without inter-token whitespace.
        val payload = if (Json.needsCollapsing(settingsJson)) Json.singleLine(settingsJson) else settingsJson
        if (payload !== settingsJson) {
            log("settings -> helper (collapsed ${settingsJson.length} -> ${payload.length} bytes for the line protocol)")
        }
        sendLine("{\"t\":\"settings\",\"settings\":$payload}")
    }

    fun sendState(snapshot: PlaybackSnapshot) {
        val line = "{\"t\":\"state\",\"posMs\":${Json.num(snapshot.posMs.toDouble())}," +
            "\"durationMs\":${Json.num(snapshot.durationMs.toDouble())}," +
            "\"playing\":${Json.bool(snapshot.playing)},\"rate\":${Json.num(snapshot.rate)}," +
            "\"tsMs\":${System.currentTimeMillis()}}"
        val sent = ++stateLinesSent
        // Protocol evidence: first lines verbatim, then one summary line every 10 s (100 ms pump).
        if (sent <= 2L || sent % 100L == 0L) log("state #$sent -> helper: $line")
        sendLine(line)
    }

    fun sendLyrics(linesJson: String) {
        lastSentLyrics.set(linesJson)
        sendLine("{\"t\":\"lyrics\",\"lines\":$linesJson,\"offsetMs\":0}")
    }

    /** Pushes the cached lyrics only when they changed; returns true when a line went out. */
    private fun maybeSendLyrics(force: Boolean = false): Boolean {
        val lyrics = lyricsProvider?.invoke() ?: return false
        if (!force && lyrics == lastSentLyrics.get()) return false
        log("lyrics -> helper (${lyrics.length} bytes${if (force) ", replay" else ""})")
        sendLyrics(lyrics)
        return true
    }

    fun sendTrack(trackJson: String) {
        lastSentTrack.set(trackJson)
        // Protocol v1 keeps the track fields at the top level of the line (no nested object).
        val body = trackJson.trim().removePrefix("{").removeSuffix("}")
        sendLine("{\"t\":\"track\",$body}")
    }

    fun sendQueue(queueJson: String) {
        lastSentQueue.set(queueJson)
        // Same shape as `track` (protocol v1): the queue object's fields sit at the top level.
        val body = queueJson.trim().removePrefix("{").removeSuffix("}")
        sendLine("{\"t\":\"queue\",$body}")
    }

    /**
     * issue #23: publishes the installed-mod list.
     *
     * [modsJson] is already the complete `[…]` array built by [FoliaModStore.toJson], i.e. one line
     * with every string escaped. It is embedded as-is on purpose: re-serialising it here would be the
     * second place that has to keep the line protocol in mind, and a newline anywhere inside would
     * split one message into several invalid ones that the host silently drops (`docs/lessons.md` §3).
     *
     * The list is perishable state, not a command: it is re-pushed after every action and again when
     * the host reports `ready`, because the host drops anything posted before WebView2 is up
     * (`post-page-skip reason=not-ready`). The host forwards it to the page, whose Shim then activates
     * the enabled clients; the plugin never touches the page's registries.
     */
    fun sendMods(modsJson: String) {
        val body = if (Json.needsCollapsing(modsJson)) Json.singleLine(modsJson) else modsJson
        if (body !== modsJson) {
            log("mods -> helper (collapsed ${modsJson.length} -> ${body.length} bytes for the line protocol)")
        }
        lastSentMods = body
        sendLine(modsLine(body))
    }

    /**
     * The last list handed to [sendMods], or null before the first push. Replayed on `ready` for the
     * same reason the settings tree is: the host has no queue for a page that does not exist yet.
     */
    @Volatile
    var lastSentMods: String? = null
        private set

    /**
     * Sends one line back to the host's log channel (`{"t":"log","level":…,"msg":…}`), which the host
     * mirrors into its own log file and (when verbose) the page console.
     *
     * This is the plugin's only way to *say something* over the protocol, and it already exists for
     * exactly this purpose — a mod action's outcome uses it rather than inventing a reply envelope.
     * The message is escaped, so a Windows path full of backslashes stays one valid line.
     */
    fun sendLog(level: String, message: String) {
        sendLine(logLine(level, message))
    }

    /**
     * issue #23（第二轮）：推一条安装进度给宿主，宿主转给页面（协议 §2 `modProgress`）。
     *
     * 调用方负责节流（见 `FoliaPlugin.progress`）：这条通道的队列有界，满了会丢**最旧**的一条，
     * 而最旧的那些是 100 ms 的 `state` 时钟。所以进度最多 ~5 Hz，且只在百分比真的变了时才发。
     */
    fun sendModProgress(actionId: String?, modId: String?, phase: String, received: Long, total: Long) {
        sendLine(modProgressLine(actionId, modId, phase, received, total))
    }

    /**
     * issue #23 配置页入口: asks the host to perform one of its own `command` actions (protocol §1
     * `command`, the same envelope the plugin already receives from the tray/shortcut side).
     *
     * ## Why this exists at all
     *
     * Until now the plugin only ever *answered* the host; every `ui` action the page saw was issued
     * by the host itself (`--open-settings` on first run, F1, ESC). Moving the mod-market entry into
     * SPW's 配置 page inverts that direction: the button lives in the plugin process, so the plugin
     * has to ask the HOST to tell the PAGE. The host's `HandleCommand` is already the place that owns
     * "post this to the page, and replay it once the page is ready", so the plugin must not post to
     * the page itself (it cannot — it has no WebView2 object).
     *
     * ## Discipline
     *
     * [action] is escaped rather than trusted: a caller with a typo must produce one invalid *value*
     * the host ignores, never a second JSON member that changes the meaning of the line. There is no
     * acknowledgement and no retry — the host replays the action on the next `bridgeReady`, so a
     * message that arrives before the page exists is not lost: the plugin sends it once and the host
     * owns delivery.
     */
    fun sendUiCommand(action: String) {
        sendLine(commandLine(action))
    }

    /** Optional mods provider; called on `ready` to replay the current list (never blocking there). */
    @Volatile
    var modsProvider: (() -> String?)? = null

    /**
     * v0.3.0: pushes the queue only when it changed (or [force]); returns true when a line went
     * out. The provider is the reflection layer and already swallows/logs its own failures, so a
     * transient null simply keeps the page's last snapshot.
     */
    private fun maybeSendQueue(force: Boolean = false): Boolean {
        val queue = queueProvider?.invoke() ?: return false
        if (!force && queue == lastSentQueue.get()) return false
        log("queue -> helper (${queue.length} bytes${if (force) ", force" else ""})")
        sendQueue(queue)
        return true
    }

    private fun sendLine(line: String) {
        val queue = pendingLines ?: return
        if (stdinBroken || writerThread == null) return
        // Bounded by design: when the helper stops draining the pipe we must not pile up track
        // payloads unbounded. Drop the oldest buffered line - under normal load the dropped lines
        // are idempotent state (100 ms `state` cadence, lyrics/track snapshots), so the freshest
        // line wins. Quit/poison are only enqueued after the pump stops and never become the oldest
        // entry; in a degenerate sustained overflow `settings` may be the one dropped as well (a
        // reopened window re-sends settings). Note the bound is a line count, not bytes: a track
        // line can reach ~213 KB (cover <=160,000 B -> base64), so the theoretical worst case is
        // tens of MB, but only after seconds of the helper not reading at all.
        while (!queue.offer(line)) {
            val dropped = queue.poll()
            if (dropped != null && dropped != WRITER_POISON) {
                val count = droppedLines.incrementAndGet()
                if (count <= 3L || count % 100L == 0L) {
                    log("stdin queue overflow, dropping buffered line #$count")
                }
            }
        }
    }

    /** The single owner of one helper session's stdin. Any failure marks that pipe dead. */
    private fun startStdinWriter(p: Process) {
        // A previous session's writer may still be parked in take(); retire it before publishing
        // the new queue so it can never consume (or poison) the new session's lines (v0.2.0).
        stopStdinWriter()

        val queue = LinkedBlockingQueue<String>(WRITE_QUEUE_CAPACITY)
        // F5: if the helper dies right after spawn, constructing the pipe writer can throw. Fail the
        // session gracefully (the exit watcher will still clean up) instead of propagating out of
        // open() with a half-initialised bridge.
        val out = try {
            BufferedWriter(OutputStreamWriter(p.outputStream, StandardCharsets.UTF_8))
        } catch (t: Throwable) {
            log("stdin writer setup failed: ${t::class.java.name}: ${t.message}")
            return
        }
        val thread = Thread({
            try {
                while (true) {
                    val line = queue.take()
                    if (line == WRITER_POISON) break
                    out.write(line)
                    out.write("\n")
                    out.flush()
                }
            } catch (t: Throwable) {
                if (!stopping && writerThread === Thread.currentThread()) {
                    log("stdin writer stopped: ${t::class.java.name}: ${t.message}")
                }
            } finally {
                // Only the current session's writer may poison shared state (v0.2.0): a stale writer
                // from a closed window must not clear the new queue or mark the new pipe broken.
                if (writerThread === Thread.currentThread()) {
                    stdinBroken = true
                    queue.clear()
                }
                try {
                    out.flush()
                    out.close()
                } catch (_: Throwable) {
                }
            }
        }, "spw-folia-host-stdin").apply { isDaemon = true }
        pendingLines = queue
        stdinBroken = false
        writerThread = thread
        thread.start()
    }

    /**
     * Retires the current session's writer: invalidate it first (so its `finally` becomes a no-op),
     * then unblock a thread parked in `take()`. Used by cleanup and before each new session.
     */
    private fun stopStdinWriter() {
        val old = writerThread
        writerThread = null
        pendingLines = null
        stdinBroken = true
        old?.interrupt()
        if (old != null && old !== Thread.currentThread()) {
            try {
                old.join(500)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    // --------------------------------------------------------------- threads ----

    private fun startStdoutReader(p: Process) {
        Thread({
            try {
                val reader = p.inputStream.bufferedReader(StandardCharsets.UTF_8)
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    mirrorStdout(line)
                    handleHostLine(line, p)
                }
                log("host stdout EOF")
            } catch (t: Throwable) {
                if (!stopping) log("stdout reader error: ${t::class.java.name}: ${t.message}")
            }
        }, "spw-folia-host-stdout").apply { isDaemon = true }.start()
    }

    /** Mirrors every helper stdout line into spw-folia-host.stdout.log (raw protocol evidence). */
    private fun mirrorStdout(line: String) {
        // v0.1.11: log-file writes moved off the shared monitor (`this`), so they can never be
        // blocked behind - or block - a lifecycle call such as open()/stop() on the UI thread.
        val out: BufferedWriter? = stdoutLog
        if (out == null) return
        synchronized(stdoutLogLock) {
            try {
                out.write(line)
                out.write("\n")
                out.flush()
            } catch (_: Throwable) {
                // Diagnostics only; never break the bridge because of a log file.
            }
        }
    }

    private fun startExitWatcher(p: Process) {
        Thread({
            val code = try {
                p.waitFor()
            } catch (t: Throwable) {
                -1
            }
            if (!stopping) {
                // v0.4.7: translate the exit code instead of only recording it. `docs/host-app.md` §2
                // defined the mapping from the start, but the user was left with a window that
                // "blinked and vanished" and a number they could do nothing with (see
                // `docs/runtime-requirements.md` §3, which called this out explicitly).
                val reason = describeExitCode(code)
                log("host process exited code=$code${if (reason != null) " ($reason)" else ""}")
                cleanup("exited", p)
                reason?.let { onHostExitReason?.invoke(it) }
            }
        }, "spw-folia-host-exit").apply { isDaemon = true }.start()
    }

    /** Callback for a *diagnosable* helper death; the plugin turns it into a toast. */
    var onHostExitReason: ((String) -> Unit)? = null

    private fun handleHostLine(line: String, source: Process) {
        when (val t = Json.stringField(line, "t")) {
            "ready" -> {
                ready = true
                log("host ready: $line")
                // v0.4.13 (issue: 三个配置开关全部不生效): re-send the settings tree here.
                //
                // The host caches nothing for us: PostToPage drops any payload that arrives before
                // WebView2 is ready (`post-page-skip reason=not-ready`) and only the *callers* are
                // supposed to replay it. The plugin pushed the tree once at startup, i.e. before
                // this helper existed, and the host-echo path does not cover a fresh window either —
                // so `showPlaybackBar` / `showProblemButton` never reached the page on first open
                // and the switches looked dead until a manual reload. `ready` is exactly the moment
                // the page can receive messages, so replay the last known tree there.
                settingsTree?.let { tree ->
                    log("settings replay on ready (${tree.length} bytes)")
                    runCatching { sendSettings(tree) }
                        .onFailure { log("settings replay failed: ${it::class.java.name}: ${it.message}") }
                }
                // issue #23: same replay for the mod list. A window opened after the last scan would
                // otherwise start with no mods at all (the host keeps nothing for us), and the page
                // would show an empty shelf until the user toggled something.
                runCatching { modsProvider?.invoke() }
                    .onSuccess { mods ->
                        if (mods != null) {
                            log("mods replay on ready (${mods.length} bytes)")
                            sendMods(mods)
                        }
                    }
                    .onFailure { log("mods replay failed: ${it::class.java.name}: ${it.message}") }
                replaySnapshot()
                startPump()
            }
            "closed" -> {
                val reason = Json.stringField(line, "reason") ?: "?"
                log("host closed reason=$reason")
                // Stale `closed` from a previous session must not close the new window (F1).
                if (cleanup(reason, source)) onClosed?.invoke(reason)
            }
            "settings" -> {
                val raw = Json.rawField(line, "settings")
                if (raw != null) {
                    settingsTree = raw
                    log("host settings update (${raw.length} bytes)")
                    onSettingsFromPage?.invoke(raw)
                }
            }
            "action" -> log("host action: " + (Json.stringField(line, "name") ?: "?"))
            "control" -> {
                // v0.3.0 playback-bar control from the page. Reflection failures are swallowed by
                // FoliaPlaybackControls; this catch is the last line of defence for the reader thread.
                try {
                    FoliaPlaybackControls.handleControl(line)
                } catch (t: Throwable) {
                    log("control handling failed: ${t::class.java.name}: ${t.message}")
                }
            }
            "log" -> {
                val level = Json.stringField(line, "level") ?: "info"
                val msg = Json.stringField(line, "msg") ?: ""
                log("host[$level] $msg")
            }
            // issue #23: the page asked for a mod action (install / uninstall / setEnabled /
            // openFolder) and the host forwarded it verbatim. The bridge only moves the line: the
            // handler lives in FoliaPlugin, which owns the mod directory, the download and the
            // re-push. Dispatching here keeps the reader thread's failure mode unchanged — the
            // callback must never throw back into the stdout pump.
            "modAction" -> {
                val action = Json.stringField(line, "action") ?: "?"
                val handler = onModAction
                if (handler == null) {
                    log("host modAction ($action) ignored: no handler installed")
                } else {
                    try {
                        handler(line)
                    } catch (t: Throwable) {
                        log("modAction handling failed: ${t::class.java.name}: ${t.message}")
                    }
                }
            }
            "fps" -> {
                // Diagnostics for the tiny-viewport investigation (webview-spike task-9):
                // keep the first 5 fps lines verbatim, then one every 10 s, raw file has them all.
                val seen = ++fpsLinesSeen
                if (seen <= 5L || seen % 10L == 0L) log("host fps: $line")
            }
            else -> {
                if (t != "audio-stats" && t != "eval-result") {
                    log("host message: $line")
                }
            }
        }
    }

    /**
     * Tears down the current host session. `expected` is the process the caller owns: a cleanup that
     * arrives late from a previous session's exit watcher / stdout reader must never tear down a
     * newer session (F1), so it returns without touching state. Holding the lifecycle monitor makes
     * cleanup atomic with respect to open()/stop() (F2); both already hold it, so nested calls are
     * re-entrant. Returns true when this call actually cleaned the current session.
     */
    @Synchronized
    private fun cleanup(reason: String, expected: Process? = null): Boolean {
        if (expected != null && process !== expected) {
            log("host cleanup ($reason) ignored: stale session")
            return false
        }
        stopPump()
        // Retire the writer before the process reference disappears: this marks the pipe dead (so
        // the pump stops queueing) and unblocks a writer parked in take() (v0.2.0).
        stopStdinWriter()
        val dropped = droppedLines.getAndSet(0L)
        if (dropped > 0L) log("host cleanup ($reason): $dropped stdin lines were dropped by queue overflow during this session")
        synchronized(stdoutLogLock) {
            try {
                stdoutLog?.flush()
                stdoutLog?.close()
            } catch (_: Throwable) {
            }
            stdoutLog = null
        }
        process = null
        ready = false
        pid = -1L
        log("host cleanup ($reason)")
        return true
    }

    // ------------------------------------------------------------- state pump ----

    /** On ready: pushes the current track/lyrics so a freshly opened window shows content at once. */
    private fun replaySnapshot() {
        val snapshot = snapshotProvider?.invoke()
        log("replay snapshot: ${if (snapshot == null) "none" else "pos=${snapshot.posMs} playing=${snapshot.playing}"}")
        snapshot?.let { sendState(it) }
        val track = trackProvider?.invoke()
        if (track != null && track != lastSentTrack.get()) {
            log("replay track (${track.length} bytes)")
            sendTrack(track)
        }
        maybeSendLyrics(force = true)
        // v0.3.0: queue after state/track/lyrics so a re-opened window shows the list immediately.
        runCatching { maybeSendQueue(force = true) }
            .onFailure { log("replay queue failed: ${it::class.java.name}: ${it.message}") }
    }

    private fun startPump() {
        if (pump != null) return
        pumpTicks = 0
        val service = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "spw-folia-pump").apply { isDaemon = true }
        }
        pump = service
        service.scheduleAtFixedRate({
            try {
                if (!ready) return@scheduleAtFixedRate
                snapshotProvider?.invoke()?.let { snapshot ->
                    if (pumpTicks < 3L || lastLoggedPlaying != snapshot.playing) {
                        lastLoggedPlaying = snapshot.playing
                        log(
                            "state -> helper: pos=${snapshot.posMs} dur=${snapshot.durationMs} " +
                                "playing=${snapshot.playing} rate=${snapshot.rate}"
                        )
                    }
                    sendState(snapshot)
                }
                pumpTicks++
                if (pumpTicks % TRACK_CHECK_EVERY_TICKS == 0L) {
                    trackProvider?.invoke()?.let { track ->
                        if (track != lastSentTrack.get()) {
                            log("track -> helper (${track.length} bytes, cover=${track.contains("\"coverDataUrl\"")})")
                            sendTrack(track)
                        }
                    }
                }
                // Lyrics ride the same pump but are diffed on their own: SPW delivers them a bit
                // after the track change, and a cover load failure must not freeze them (v0.1.8).
                maybeSendLyrics()
                // v0.3.0 queue/mode snapshot: low-frequency diff (500 ms), force-pushed on the
                // tick after a control so shuffle state / the highlighted item update at once.
                val forceQueue = FoliaPlaybackControls.consumeQueueDirty()
                if (forceQueue || pumpTicks % QUEUE_CHECK_EVERY_TICKS == 0L) {
                    maybeSendQueue(force = forceQueue)
                }
            } catch (t: Throwable) {
                log("pump error: ${t::class.java.name}: ${t.message}")
            }
        }, 0L, STATE_PERIOD_MS, TimeUnit.MILLISECONDS)
    }

    private fun stopPump() {
        pump?.shutdownNow()
        pump = null
    }

    // ---------------------------------------------------------------- resolve ----

    /**
     * Returns the *physical* (non-virtualized) form of [file].
     *
     * Why this exists: on the Microsoft Store channel (MSIX) SPW runs packaged, so `pluginPath`
     * is a virtual path (`C:\Users\<u>\AppData\Roaming\Salt Player for Windows\...`) that only
     * resolves for processes carrying the package identity — the real bits live under
     * `%LOCALAPPDATA%\Packages\<pkg>\LocalCache\Roaming\...`.
     *
     * `spw-folia-host.exe` is a .NET Framework 4.8 executable. Its loader (mscoree) opens
     * `<exe>.config` during CLR activation using native NT paths that the MSIX filesystem
     * redirection does **not** cover, so it gets `ERROR_PATH_NOT_FOUND` (0x80070003), concludes
     * "Unable to find a version of the runtime to use" and aborts with exit code
     * **-2146232576 / 0x80131700 (CLR_E_SHIM_RUNTIMELOAD)**, which the user sees as the
     * "This application could not be started" dialog. Managed code never runs, so the helper's
     * own stdout/stderr stay empty.
     *
     * Fix: pass the helper physical paths. Two steps, cheapest first:
     *  1. `toRealPath()` / `canonicalFile` — resolves symlinks, junctions and (on MSIX) the
     *     package's AppData redirection, because the handle is opened on the real file.
     *  2. MSIX fallback: mirror `...\AppData\Roaming\<rest>` into
     *     `%LOCALAPPDATA%\Packages\*\LocalCache\Roaming\<rest>`, which is where Store apps
     *     actually keep the data.
     */
    private fun physicalFile(file: File): File {
        val abs = file.absoluteFile
        val resolved = runCatching { abs.toPath().toRealPath().toFile() }.getOrNull()
            ?: runCatching { abs.canonicalFile }.getOrNull()
            ?: abs
        val out = msixPhysicalPath(resolved) ?: msixPhysicalPath(abs) ?: resolved
        if (!out.path.equals(abs.path, ignoreCase = true)) {
            log("physical path: ${abs.path} -> ${out.path}")
        }
        return out
    }

    /**
     * MSIX fallback: re-maps an `AppData\Roaming` path onto the package's real `LocalCache`
     * location. Returns null when the input is not an AppData\Roaming path or when no
     * installed package holds it (e.g. the non-Store channel, where the path is already real).
     */
    private fun msixPhysicalPath(file: File): File? {
        val roaming = System.getenv("APPDATA")?.takeIf { it.isNotBlank() } ?: return null
        val localAppData = System.getenv("LOCALAPPDATA")?.takeIf { it.isNotBlank() } ?: return null
        val path = file.path
        if (!path.startsWith(roaming, ignoreCase = true)) return null
        val rest = path.substring(roaming.length).trimStart('\\', '/')
        if (rest.isEmpty()) return null
        val packages = File(localAppData, "Packages")
        val dirs = runCatching { packages.listFiles() }.getOrNull() ?: return null
        return dirs.firstNotNullOfOrNull { pkg ->
            File(pkg, "LocalCache/Roaming/$rest").takeIf { it.exists() }
        }
    }

    private fun resolveHelper(): File? {
        val candidates = mutableListOf<File>()
        System.getenv("SPW_FOLIA_HELPER")?.takeIf { it.isNotBlank() }?.let { candidates += File(it) }
        candidates += File(pluginPath, "host/spw-folia-host.exe")
        candidates += File(pluginPath, "host/x64/spw-folia-host.exe")
        // Release (.spmod) layout: helper binaries are packaged under lib/ (0.1.0 build 2) or
        // native/ (0.1.0 final release layout).
        candidates += File(pluginPath, "lib/spw-folia-host.exe")
        candidates += File(pluginPath, "lib/x64/spw-folia-host.exe")
        candidates += File(pluginPath, "native/spw-folia-host.exe")
        candidates += File(pluginPath, "native/x64/spw-folia-host.exe")
        // Dev checkout fallback (task-6 build output); harmless in a packaged plugin.
        candidates += File(DEV_ROOT, "poc/webview/host/build/spw-folia-host.exe")
        return candidates.firstOrNull { it.isFile }
    }

    private fun resolveWebDir(): File? {
        val candidates = mutableListOf<File>()
        System.getenv("SPW_FOLIA_WEB")?.takeIf { it.isNotBlank() }?.let { candidates += File(it) }
        candidates += File(pluginPath, "web")
        candidates += File(pluginPath, "web/dist")
        candidates += File(DEV_ROOT, "poc/webview/dist/dist")
        return candidates.firstOrNull { File(it, "index.html").isFile }
    }

    private fun resolveSettingsDir(web: File): File? {
        // Packaged layout: <bundle>/settings/settings-ui.js is auto-detected by the helper, so
        // no flag is needed there. Only pass explicit flags when the file lives elsewhere.
        if (File(web, "settings/$SETTINGS_ENTRY").isFile) return null
        val candidates = mutableListOf<File>()
        System.getenv("SPW_FOLIA_SETTINGS")?.takeIf { it.isNotBlank() }?.let { candidates += File(it) }
        candidates += File(pluginPath, "web/settings")
        candidates += File(DEV_ROOT, "poc/settings-ui/dist")
        return candidates.firstOrNull { File(it, SETTINGS_ENTRY).isFile }
    }

    companion object {
        /**
         * `docs/host-app.md` §2 exit-code table, as user-facing text.
         * Returns null for codes that carry no useful message: 0 (normal close) needs no toast, and
         * an unrecognised code is reported by the log line itself — inventing a sentence for it
         * would be exactly the kind of unbacked claim v0.4.7 removed from the self-check.
         */
        fun describeExitCode(code: Int): String? = when (code) {
            0 -> null
            1 -> "辅助进程启动失败（WebView2 初始化失败、浏览器进程崩溃或未处理异常）"
            2 -> "辅助进程参数错误或页面资源缺失（bundle 目录 / index.html 不存在）"
            3 -> "WebView2 Runtime 未安装或无法启动"
            -2146232576 -> ".NET Framework 4.8 运行库未能加载（CLR 0x80131700，Store/MSIX 版常见）"
            else -> null
        }

        /** 100 ms state cadence: docs/protocol.md asks for >=20 Hz; the timeline interpolates. */
        private const val STATE_PERIOD_MS = 100L

        /**
         * v0.1.11: bound for the stdin writer queue. Large enough to absorb a ~155 KB track payload
         * and a couple of cover reloads, small enough that a wedged helper cannot balloon memory.
         */
        private const val WRITE_QUEUE_CAPACITY = 256

        /** Poison pill: flushes whatever precedes it, then ends the stdin writer thread. */
        private const val WRITER_POISON = "__spw-folia-writer-poison__"

        /** Track/lyrics are polled every 200 ms (they are cheap cached JSON diffs); the provider
         *  itself throttles the Workshop API round-trip, see FoliaPlaybackExtension. */
        private const val TRACK_CHECK_EVERY_TICKS = 2L

        /**
         * The complete `mods` line for an already-serialised array (issue #23).
         *
         * `internal` so a JVM test can pin the **transport shape** — one line, the array spliced
         * verbatim, no re-serialisation — without a host process. The host side reads the array out
         * of this line and relays it unchanged, so any escaping done here is done exactly once.
         */
        internal fun modsLine(modsJson: String): String = "{\"t\":\"mods\",\"mods\":$modsJson}"

        /** The complete `log` line (plugin -> host) for one message. Same idea as [modsLine]. */
        internal fun logLine(level: String, message: String): String =
            "{\"t\":\"log\",\"level\":${Json.str(level)},\"msg\":${Json.str(message)}}"

        /**
         * The complete `command` line (plugin -> host) for one host action.
         *
         * `internal` so a JVM test can pin the shape the same way [modsLine] / [logLine] do: one line,
         * `command` as an escaped string member, and the action never spliced in raw. The host parses
         * it with the same `JsonUtil.GetString(msg, "command")` it already uses for its own commands.
         */
        internal fun commandLine(command: String): String =
            "{\"t\":\"command\",\"command\":${Json.str(command)}}"

        /**
         * The complete `modProgress` line (plugin -> host -> page), issue #23 second round.
         *
         * ## Why a new message type instead of reusing `log`
         *
         * The host deliberately does **not** forward plugin `log` lines to the page
         * (`HostForm.HandleStdinLine`: 「the page learns the outcome from the refreshed mods/settings
         * push, not from log lines」), and that decision is right — log lines are for the file. But a
         * download percentage is not an outcome, it is live state the user watches. So it gets its own
         * type, forwarded to the page and nothing else.
         *
         * ## Shape
         *
         * `actionId` is the correlation key: the page mints it (`bridge.ts` `newModActionId`), the host
         * echoes it verbatim into the plugin, and this line sends it back, so a panel that issued two
         * installs can tell which bar is which. `total` is `-1` when the size is unknown (chunked
         * response, or unpacking) and the page draws an indeterminate bar for that.
         *
         * Every value goes through [Json.str] / plain number formatting: one line, no splicing.
         * `internal` so a JVM test can pin the shape without a host process.
         */
        internal fun modProgressLine(
            actionId: String?,
            modId: String?,
            phase: String,
            received: Long,
            total: Long,
        ): String = buildString {
            append("{\"t\":\"modProgress\",\"phase\":").append(Json.str(phase))
            append(",\"actionId\":").append(Json.str(actionId))
            append(",\"modId\":").append(Json.str(modId))
            append(",\"received\":").append(received.coerceAtLeast(0L))
            append(",\"total\":").append(if (total < 0L) -1L else total)
            append('}')
        }

        /** v0.3.0: queue is diffed every 500 ms; controls force an immediate push via queueDirty. */
        private const val QUEUE_CHECK_EVERY_TICKS = 5L
        private const val SETTINGS_ENTRY = "settings-ui.js"
        private const val DEV_ROOT = "D:/输出目录/dsh2"

        /**
         * issue #23（第二轮）：市场专用窗口加载的页面。
         *
         * `?market=1` 不是装饰：`main.tsx` 靠它决定「只挂市场面板」还是「挂整个设置岛」
         * （`src/market/mountMarketWindow.tsx` 的 `isMarketWindow()`）。页面本身是
         * `poc/settings-ui/public/mod-market.html`，staging 会把它放到 `web/settings/` 下，而
         * `--settings-dir` 把那个目录映射到 bundle 主机的 `settings/` 子路径上
         * （`HostForm` 的 `settings-inject` 用同一个前缀），所以这个 URL 与注入脚本同源。
         */
        private const val MARKET_PAGE_URL = "https://spw-folia.local/settings/mod-market.html?market=1"
        /** 市场窗口的物理像素尺寸（面板本身 max-w 900，`grid-cols-2 sm:grid-cols-3`）。 */
        private const val MARKET_WINDOW_WIDTH = 1200
        private const val MARKET_WINDOW_HEIGHT = 860

        /** 市场窗口独立的 WebView2 profile 目录名（在插件目录下）。 */
        private const val MARKET_USER_DATA_DIR = "webview-market"

        /**
         * issue #23（第二轮）：市场专用窗口的 argv 片段（**纯函数**，JVM 测试直接驱动它）。
         *
         * 逐条都是「播放页需要、市场不需要」的开关：
         *   `--url`             直接指向 `public/mod-market.html`（`?market=1` 是页面与宿主之间唯一
         *                       的约定，见 `src/market/mountMarketWindow.tsx`）；
         *   `--window WxH`      窗口而不是全屏。宿主的 `--window` 解析会把 `Fullscreen` 置为
         *                       **false**（`Program.cs` 的 `case "--window"`），所以这一个参数同时
         *                       给出尺寸并关掉全屏 —— 不需要也不存在 `--no-fullscreen`；
         *   `--no-topmost`      一个配置窗口压在播放页/桌面之上是错的；
         *   `--no-transparency` 设置树里可能带着 `transparentPlayerBackground:true`，那会把窗口变成
         *                       色键 + 输入捕获窗，只剩两个角可点；
         *   `--no-curtain`      开屏动画是播放页的仪式感，这里只会让人多等一秒；
         *   `--no-keep-awake`   市场不播放任何东西，没有理由按住显示器不睡；
         *   `--user-data`       独立 profile：一个 user-data 目录对应一个 WebView2 profile，两个进程
         *                       并发用同一个是未定义行为（`docs/host-app.md`）。
         *
         * **不传** `--mods-dir`：市场只列清单与预览图，`/__mods/…` 的文件服务是播放页导入
         * `client.mjs` 才需要的。
         *
         * `internal` 而不是 private：`--mods-dir` 那次漏传（「装了没效果」的第一个根因）就是因为
         * argv 没有任何测试钉住。这条形状现在由 `FoliaModStoreTest` 断言。
         */
        internal fun marketArgs(userDataDir: String): List<String> = listOf(
            "--url", MARKET_PAGE_URL,
            "--window", "${MARKET_WINDOW_WIDTH}x${MARKET_WINDOW_HEIGHT}",
            "--title", "模组市场",
            "--no-topmost",
            "--no-transparency",
            "--no-curtain",
            "--no-keep-awake",
            "--user-data", userDataDir,
        )

        /**
         * 市场窗口加载的页面路径（相对 bundle 的 `settings/` 目录），`internal` 供测试断言它与
         * `MARKET_PAGE_URL` 一致 —— 两者写岔的后果是「窗口开了但一片空白」，而那种失败没有任何
         * 编译期信号。
         */
        internal const val MARKET_PAGE = "settings/mod-market.html?market=1"
    }
}
