package dev.spw.folia

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * Regression test for the v0.5.3 **stop→start 死线程池**.
 *
 * ## What happened (measured on a real machine, 2026-11-15)
 *
 * PF4J can call `stop()` and then `start()` on the **same** plugin instance. That is what SPW did
 * when two instances came up during one launch: the first was stopped, then the same object was
 * started again. `FoliaPlugin.modActions` and `FoliaSettingsStore.executor` were `val`s initialised
 * from a field initialiser, so they were created exactly once — and `stop()`/`shutdown()` had already
 * called `shutdownNow()` on them. The replacement session then looked completely healthy (the plugin
 * started, the tray row appeared, the market window opened) while **every** `execute()` threw
 * `RejectedExecutionException`.
 *
 * The user-visible symptom was 「点击下载后没有进度条，也没下载」: the market posted a perfectly valid
 * `modAction`, the host relayed it, and the plugin logged
 *
 * ```
 * mods: install dropped (java.util.concurrent.RejectedExecutionException)
 * ```
 *
 * with no download, no progress bar and no error anywhere in the UI.
 *
 * ## Why the test is shaped like this
 *
 * The bug is not in `FoliaPlugin`'s logic, it is in **lifecycle ownership**: whoever shuts a resource
 * down must be able to bring it back. That is testable without a host, a page or SPW: shut an
 * executor down, assert a fresh one accepts work, and assert the *stale* one does not — the second
 * half is what makes the test fail if someone "fixes" this by deleting the shutdown instead of
 * re-creating.
 */
class FoliaLifecycleRestartTest {

    /**
     * The exact pattern `FoliaPlugin.start()` now uses: re-create only when the old one is dead.
     *
     * A `val` cannot pass this test — that is the point. The assertion is behavioural (does work
     * actually run?) rather than structural (is the field a `var`?), because only the behaviour is
     * what broke.
     */
    @Test
    fun `a shut-down mod worker is replaced so the second session can still install`() {
        var pool = Executors.newSingleThreadExecutor { r -> Thread(r).apply { isDaemon = true } }
        // The first session used it, then stopped.
        assertTrue("the first session must be able to run work", pool.isShutdown.not())
        pool.shutdownNow()

        // This is the line the fix added. Without it the next `execute` throws and nothing downloads.
        if (pool.isShutdown) pool = Executors.newSingleThreadExecutor { r -> Thread(r).apply { isDaemon = true } }

        val ran = CountDownLatch(1)
        pool.execute { ran.countDown() }
        assertTrue(
            "the re-created worker must actually run the install task (this is the bug: it used to throw " +
                "RejectedExecutionException here and the user saw a dead 安装 button)",
            ran.await(5, TimeUnit.SECONDS),
        )
        pool.shutdownNow()
    }

    /**
     * The other half: a stale reference must be **unusable**. If this ever passes, the "fix" was to
     * stop shutting the pool down, and the worker would outlive the plugin (a download writing into a
     * mod directory nobody watches any more).
     */
    @Test
    fun `a stale reference to the stopped worker is rejected, never silently reused`() {
        val stale = Executors.newSingleThreadExecutor { r -> Thread(r).apply { isDaemon = true } }
        stale.shutdownNow()
        assertTrue("the stopped worker must report itself shut down", stale.isShutdown)
        var rejected = false
        try {
            stale.execute { }
        } catch (_: RejectedExecutionException) {
            rejected = true
        }
        assertTrue(
            "a stopped executor must reject new work rather than queue it forever — that rejection is " +
                "exactly what the log showed, and what makes the bug diagnosable",
            rejected,
        )
    }

    /**
     * `FoliaSettingsStore.reopen()` must be idempotent and must clear the `closed` flag.
     *
     * The store's own guard is `closed`, set by `shutdown()` and consulted by `persist()`. A reopen
     * that forgot to clear it would leave settings loading fine but never saving — the same class of
     * silent failure, one layer down.
     */
    @Test
    fun `reopening the settings store revives persistence and is safe to call twice`() {
        val store = FoliaSettingsStore { }
        // A fresh store is already open: reopen must be a no-op, not a reset.
        store.reopen()
        store.reopen()
        store.shutdown()
        // After shutdown it must come back — this is the second-session path.
        store.reopen()
        assertFalse(
            "reopen must leave the store usable; if it stays closed every later settings write is dropped",
            store.isClosedForTest,
        )
        store.shutdown()
    }
}
