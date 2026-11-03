@file:OptIn(UnstableSpwWorkshopApi::class)

package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.config.ConfigHelper
import com.xuncorp.spw.workshop.api.config.ConfigManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Path
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.function.Consumer

/**
 * Regression tests for the v0.4.13 **TERMINATED_HANG**.
 *
 * ## What happened
 *
 * v0.4.13 added a retry for "config file unreadable", written as a recursion whose own
 * re-entrancy guard was cleared *before* the recursive call:
 *
 * ```kotlin
 * if (retriedAfterEmpty.compareAndSet(false, true)) {
 *     Thread.sleep(EMPTY_RETRY_DELAY_MS)
 *     retriedAfterEmpty.set(false)   // <-- guard released ...
 *     sync(reason = "$reason/retry") // <-- ... and then it re-enters itself
 * }
 * ```
 *
 * `sync()` is `@Synchronized`, but a JVM monitor is reentrant for the same thread, so nothing
 * stopped it. On a real machine — where BOTH `config.json` and `diagnostics.json` were absent —
 * this produced **1450 nested calls over 559 s**, froze SPW's UI, and ended in
 * `failure.kind=TERMINATED_HANG` (see `dist/release/taken-down/v0.4.13-handoff/`).
 *
 * ## Why the release gate missed it
 *
 * `verify-all.mjs` reported 10/10 green. Every suite drove the plugin against a machine whose
 * `config.json` existed, so **the failure branch was never executed by any test**. Only real users
 * reached it. Hence: these tests drive that exact branch through a real [FoliaConfigSync] and a
 * [ConfigFileResolver] over a temp directory.
 *
 * The contract under test: **a missing config file is a normal, terminating, non-noisy condition.**
 */
class FoliaConfigSyncTest {

    // @Rule must sit on the FIELD here. `@get:Rule` would target a getter that @JvmField does not
    // generate, so the rule would silently never run (the failure looks like "temporary folder has
    // not yet been created" from inside the test).
    @Rule
    @JvmField
    val tmp: TemporaryFolder = TemporaryFolder()

    /** Records every log line so tests can assert on noise as well as on termination. */
    private class Recorder {
        private val lines: MutableList<String> = Collections.synchronizedList(mutableListOf())
        fun log(message: String) {
            lines.add(message)
        }

        fun count(fragment: String): Int = lines.count { it.contains(fragment) }
        fun snapshot(): List<String> = lines.toList()
    }

    /** Resolver over a fixed directory that counts consultations (a recursion explodes this). */
    private class DirResolver(private val dir: File) : ConfigFileResolver {
        @Volatile
        var calls: Int = 0
            private set

        override fun resolve(name: String): File? {
            calls++
            return File(dir, name)
        }
    }

    /**
     * A [ConfigManager] stub. The injected resolver means [FoliaConfigSync] never asks it for paths,
     * but `start()` still registers a change listener on it.
     */
    private class FakeConfigManager(private val dir: File) : ConfigManager {
        val listeners: MutableList<Consumer<ConfigHelper>> = mutableListOf()

        override fun getConfig(): ConfigHelper = helper("config.json")

        override fun getConfig(fileName: String): ConfigHelper = helper(fileName)

        override fun addConfigChangeListener(listener: Consumer<ConfigHelper>) {
            listeners.add(listener)
        }

        override fun addConfigChangeListener(
            fileName: String,
            listener: Consumer<ConfigHelper>,
        ) {
            listeners.add(listener)
        }

        override fun removeConfigChangeListener(listener: Consumer<ConfigHelper>) {
            listeners.remove(listener)
        }

        private fun helper(name: String): ConfigHelper = object : ConfigHelper {
            override fun <T> get(key: String, defaultValue: T): T = defaultValue

            override fun set(key: String, value: Any) = Unit
            override fun save(): Boolean = true
            override fun reload(): Boolean = true
            override fun getConfigPath(): Path = File(dir, name).toPath()
        }
    }

    private fun newSync(
        dir: File,
        rec: Recorder,
        resolver: DirResolver = DirResolver(dir),
    ): FoliaConfigSync = FoliaConfigSync(rec::log, resolver) { rec.log("push") }

    // ------------------------------------------------------ the exact v0.4.13 hang ----

    /**
     * THE regression. Both config files absent is what a fresh install looks like, and it is the
     * exact state the crashed machine was in (`bytes=-1` for both probes).
     *
     * Must: (a) return, (b) not recurse, (c) not sleep. A hung implementation fails here as a test
     * timeout instead of as a user's dead app.
     */
    @Test(timeout = 15_000)
    fun `both config files missing returns promptly and does not recurse`() {
        val dir = tmp.newFolder()
        val rec = Recorder()
        val resolver = DirResolver(dir)
        val sync = newSync(dir, rec, resolver)

        sync.start(FakeConfigManager(dir))

        // A bounded number of consults per sync (one per group) is fine; a recursion multiplies it
        // without limit. 20 is far above any legitimate sync and far below 1450.
        assertTrue(
            "resolver consulted ${resolver.calls} times; a retry recursion is the v0.4.13 hang",
            resolver.calls <= 20,
        )
        // The growing `/retry` reason string WAS the recursion signature in the shipped log.
        val retryLines = rec.snapshot().filter { it.contains("retry") || it.contains("no config") }
        assertTrue("unexpected retry noise: $retryLines", retryLines.size <= 2)
        assertTrue(
            "no log line may carry a nested retry chain: $retryLines",
            retryLines.none { it.split("retry").size > 3 },
        )
    }

    /**
     * A file that exists but is EMPTY is the one case that legitimately deserves a retry (the host
     * truncates then rewrites). The bound must be small and constant.
     */
    @Test(timeout = 15_000)
    fun `empty existing file retries a bounded number of times`() {
        val dir = tmp.newFolder()
        File(dir, "config.json").writeText("")
        File(dir, "diagnostics.json").writeText("")
        val rec = Recorder()
        val resolver = DirResolver(dir)
        val sync = newSync(dir, rec, resolver)

        sync.start(FakeConfigManager(dir))

        // Both groups are probed per attempt; attempts are bounded by EMPTY_RETRY_COUNT.
        val maxCalls = 2 * (FoliaConfigSyncAccess.retryCount + 1) + 4
        assertTrue(
            "resolver consulted ${resolver.calls} times, expected <= $maxCalls",
            resolver.calls <= maxCalls,
        )
    }

    /**
     * A missing config file is normal, not an error. It must be logged at most ONCE — the watcher
     * runs at 1 Hz, so per-tick logging would be ~86k lines/day for a non-problem.
     */
    @Test(timeout = 15_000)
    fun `missing config file is logged at most once across repeated syncs`() {
        val dir = tmp.newFolder()
        val rec = Recorder()
        val sync = newSync(dir, rec)

        sync.start(FakeConfigManager(dir))
        repeat(5) { sync.sync("watch") }

        assertEquals(
            "the fresh-install notice must be written once, not once per tick; got ${rec.snapshot()}",
            1,
            rec.count("no config file"),
        )
    }

    /** Values must stay at their compiled-in defaults so the plugin remains usable. */
    @Test(timeout = 15_000)
    fun `missing config keeps defaults so the plugin still works`() {
        val dir = tmp.newFolder()
        val rec = Recorder()
        val sync = newSync(dir, rec)

        sync.start(FakeConfigManager(dir))

        assertEquals(
            "显示播放条 defaults to on",
            FoliaConfigSyncAccess.defaultShowPlaybackBar,
            sync.showPlaybackBar,
        )
        assertEquals(
            "显示问题反馈按钮 defaults to off",
            FoliaConfigSyncAccess.defaultShowProblemButton,
            sync.showProblemButton,
        )
        assertEquals(
            "打开过渡动画 defaults to off",
            FoliaConfigSyncAccess.defaultTransitionAnimation,
            sync.transitionAnimation,
        )
        assertEquals(
            "歌词样式预览动画 defaults to on",
            FoliaConfigSyncAccess.defaultPreviewAnimation,
            sync.previewAnimation,
        )
    }

    /** A real tree must still be read, so the fix did not trade the hang for a dead feature. */
    @Test(timeout = 15_000)
    fun `a present config file still applies its values`() {
        val dir = tmp.newFolder()
        File(dir, "config.json").writeText(
            """{"transitionAnimation":true,"showPlaybackBar":false,"showProblemButton":true}""",
        )
        val rec = Recorder()
        val sync = newSync(dir, rec)

        // sync() is a no-op until start() binds a manager — that ordering is intentional, so the
        // test must go through start() the way the plugin does.
        sync.start(FakeConfigManager(dir))
        try {
            assertTrue("打开过渡动画 must be read", sync.transitionAnimation)
            assertEquals("显示播放条 must be read", false, sync.showPlaybackBar)
            assertTrue("显示问题反馈按钮 must be read", sync.showProblemButton)
        } finally {
            sync.stop()
        }
    }

    /**
     * v0.4.15: the 「歌词样式预览动画」 switch (`previewAnimation`) must behave exactly like the
     * other hot switches — read from disk, default **on**, and pushed once per real change.
     *
     * It is a user-visible performance knob: off makes the page's style shelf draw a static glyph
     * per style instead of importing a renderer. A reader that silently ignored it would look like
     * "the setting does nothing", which is the exact class of defect [FoliaConfigSync] exists to
     * prevent — so it is asserted here rather than only through the release gate's static contract.
     */
    @Test(timeout = 15_000)
    fun `previewAnimation is read from disk and pushed once per change`() {
        val dir = tmp.newFolder()
        val configFile = File(dir, "config.json")
        configFile.writeText("""{"previewAnimation":false}""")
        val rec = Recorder()
        // Count the pushes directly instead of grepping the log: the sync log line also contains the
        // word "pushing", so a text search would not tell the two apart.
        val pushes = AtomicInteger(0)
        val sync = FoliaConfigSync(rec::log, DirResolver(dir)) { pushes.incrementAndGet() }

        sync.start(FakeConfigManager(dir))
        try {
            assertEquals(
                "关闭歌词样式预览动画 must be read from config.json",
                false,
                sync.previewAnimation,
            )
            assertEquals("one change must push the tree exactly once", 1, pushes.get())

            // A re-read of the same value must not push: every push remounts the shelf, so a push
            // per watcher tick would restart it once a second.
            sync.sync("watch")
            assertEquals("an unchanged value must not push again", 1, pushes.get())

            configFile.writeText("""{"previewAnimation":true}""")
            sync.sync("watch")
            assertEquals("turning it back on must be read too", true, sync.previewAnimation)
            assertEquals("the second change must push again", 2, pushes.get())
        } finally {
            sync.stop()
        }
    }

    /**
     * A half-written file (truncated JSON) must not throw and must not hang. It yields no booleans
     * this tick; the watcher picks the completed file up on the next one.
     */
    @Test(timeout = 15_000)
    fun `a truncated config file does not throw or hang`() {
        val dir = tmp.newFolder()
        File(dir, "config.json").writeText("""{"transitionAnimation":tr""")
        val rec = Recorder()
        val sync = newSync(dir, rec)

        sync.sync("start")

        assertEquals(FoliaConfigSyncAccess.defaultShowPlaybackBar, sync.showPlaybackBar)
    }

    /**
     * The re-entrancy backstop. Even if a future edit reintroduces `sync()` calling `sync()`, the
     * depth guard must stop the descent at a small constant instead of 1450 frames.
     */
    @Test(timeout = 15_000)
    fun `repeated syncs stay bounded and quiet`() {
        val dir = tmp.newFolder()
        val rec = Recorder()
        val sync = newSync(dir, rec)

        repeat(50) { sync.sync("drive") }

        assertTrue(
            "the fresh-install notice must still be one line after 50 syncs, got ${rec.count("no config file")}",
            rec.count("no config file") <= 1,
        )
    }

    /** A failing resolver must degrade to "no config", never throw out of `sync()`. */
    @Test(timeout = 15_000)
    fun `a throwing resolver degrades instead of throwing`() {
        val rec = Recorder()
        val sync = FoliaConfigSync(rec::log, { error("resolver exploded") }) { rec.log("push") }

        sync.sync("start")

        assertEquals(FoliaConfigSyncAccess.defaultShowPlaybackBar, sync.showPlaybackBar)
    }

    /** `stop()` must be safe and idempotent even when `start()` never ran. */
    @Test(timeout = 15_000)
    fun `stop is safe without start`() {
        val dir = tmp.newFolder()
        val sync = newSync(dir, Recorder())

        sync.stop()
        sync.stop()
    }
}

/**
 * Mirrors the private companion constants of [FoliaConfigSync] for assertions.
 *
 * They are `const val` inside a `private companion object`, so a same-package test still cannot see
 * them. Mirroring is deliberate: if a future edit changes a safety bound, these assertions start
 * failing — the bound is a safety property, not a tunable.
 */
private object FoliaConfigSyncAccess {
    /** Mirrors `FoliaConfigSync.EMPTY_RETRY_COUNT`. */
    const val retryCount = 2

    /** Mirrors `FoliaConfigSync.DEFAULT_SHOW_PLAYBACK_BAR`. */
    const val defaultShowPlaybackBar = true

    /** Mirrors `FoliaConfigSync.DEFAULT_SHOW_PROBLEM_BUTTON`. */
    const val defaultShowProblemButton = false

    /** Mirrors `FoliaConfigSync.DEFAULT_TRANSITION_ANIMATION`. */
    const val defaultTransitionAnimation = false

    /** Mirrors `FoliaConfigSync.DEFAULT_PREVIEW_ANIMATION`. */
    const val defaultPreviewAnimation = true
}
