@file:OptIn(UnstableSpwWorkshopApi::class)

package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.config.ConfigHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v0.5.0: the one-shot update notice.
 *
 * ## What these tests defend
 *
 * The notice is deliberately an exception to the v0.3.2 rule "no success toast on every start"
 * (issue #9) — it is allowed to interrupt the user exactly **once**, on 0.5.0. Every failure mode
 * below would turn it back into the noise that rule exists to prevent, and **none of them shows up
 * as a crash or a broken UI**: the plugin keeps working, it just becomes annoying. That is precisely
 * the class of defect a release gate has to pin down, so the decision lives in
 * [FoliaUpdateNotice.shouldShow] and is driven directly here.
 *
 * The three ways this can go wrong:
 *
 *  1. **Every version shows it** — 0.5.1, 0.5.2, 0.6.0 each pop the same 0.5.0 text (or worse, their
 *     own), i.e. issue #9 is reopened with extra steps.
 *  2. **The same version shows it twice** — the marker was never read, or read from a key that is
 *     not the one written.
 *  3. **It never shows at all** — the marker is treated as "already seen" when it is absent, which
 *     would make the feature a no-op that still passes review.
 */
class FoliaUpdateNoticeTest {

    // ------------------------------------------------------------ 1. fires exactly once ----

    /** A fresh install has no marker: this is the one start that must show it. */
    @Test
    fun `shows on the first start of the notice version`() {
        assertTrue(
            "a user who has never been told must be told",
            FoliaUpdateNotice.shouldShow(pluginVersion = "0.5.0", noticedVersion = null),
        )
    }

    /** The marker written by [FoliaUpdateNotice.writeNoticedVersion] must suppress the second start. */
    @Test
    fun `does not show twice for the same version`() {
        assertFalse(
            "the marker exists precisely so a restart is silent",
            FoliaUpdateNotice.shouldShow(pluginVersion = "0.5.0", noticedVersion = "0.5.0"),
        )
    }

    /**
     * An upgrading user's marker reads `0.4.x` (or any older value): the notice still has to appear,
     * because they, too, are "first time on 0.5.0".
     */
    @Test
    fun `still shows when the marker holds an older version`() {
        assertTrue(
            "upgrading from 0.4.20 is exactly who this notice is for",
            FoliaUpdateNotice.shouldShow(pluginVersion = "0.5.0", noticedVersion = "0.4.20"),
        )
    }

    // ------------------------------------------------------------ 2. never fires again ----

    /**
     * The important one for the future: the code ships forever, so every later version must stay
     * silent even though the check runs on every start.
     */
    @Test
    fun `never shows for any version other than the notice version`() {
        val laterVersions = listOf("0.5.1", "0.5.2", "0.6.0", "1.0.0", "0.4.20")
        for (version in laterVersions) {
            assertFalse(
                "$version must stay silent — otherwise issue #9 (start-up toast noise) is back",
                FoliaUpdateNotice.shouldShow(pluginVersion = version, noticedVersion = null),
            )
        }
    }

    // ------------------------------------------------------------ 3. the seam is exact ----

    /**
     * `shouldShow` compares the *build* against the literal notice version, so the constant must not
     * silently follow [FoliaPlugin.PLUGIN_VERSION]. If someone "tidies" it into an alias, this test
     * fails — which is the point: the one-shot property depends on it being pinned.
     */
    @Test
    fun `the notice version is pinned, not derived from the running build`() {
        assertEquals(
            "the notice is a one-off for 0.5.0 and must not track PLUGIN_VERSION",
            "0.5.0",
            FoliaUpdateNotice.NOTICE_VERSION,
        )
    }

    /** The persisted key is part of the on-disk contract; pin the spelling. */
    @Test
    fun `the marker key is stable`() {
        assertEquals(
            "renaming this orphans the marker on every existing install, and the notice reappears",
            "updateNoticeShownVersion",
            FoliaUpdateNotice.KEY_NOTICED_VERSION,
        )
    }

    /** A blank marker counts as absent (a hand-edited or truncated config must not mute the notice). */
    @Test
    fun `a blank marker counts as not seen`() {
        assertTrue(FoliaUpdateNotice.shouldShow("0.5.0", ""))
        assertTrue(FoliaUpdateNotice.shouldShow("0.5.0", "   "))
    }

    /** Whitespace around the stored value must not defeat the comparison. */
    @Test
    fun `a padded marker still suppresses the notice`() {
        assertFalse(
            "a JSON round trip can leave padding; it must still mean 'already seen'",
            FoliaUpdateNotice.shouldShow("0.5.0", " 0.5.0 "),
        )
    }

    // ------------------------------------------------------------ 4. the text ----

    /**
     * The user-facing text must name the version that is actually running. A hardcoded "0.5.0" here
     * would keep announcing 0.5.0 if the constant is ever changed for a future notice.
     */
    @Test
    fun `the message interpolates the running version`() {
        assertEquals(
            "模组spw-folia已更新至0.5.0版本（重要更新）",
            FoliaUpdateNotice.message("0.5.0"),
        )
        assertEquals(
            "the version must come from the argument, not be baked into the string",
            "模组spw-folia已更新至0.5.1版本（重要更新）",
            FoliaUpdateNotice.message("0.5.1"),
        )
    }

    // ------------------------------------------------------------ 5. storage round trip ----

    /**
     * The read and write halves must agree on the same key and value type. This is the failure the
     * pure-decision tests above CANNOT see: a write to `updateNoticeShownVersion` and a read from a
     * differently-spelled key both "work", and the user gets the notice on every single start.
     */
    @Test
    fun `what the write stores is what the read finds`() {
        val store = InMemoryConfig()
        val nothingSeen = FoliaUpdateNotice.readNoticedVersion(store)
        assertNull("an untouched store must read as 'never shown'", nothingSeen)

        assertTrue("the write must report success", FoliaUpdateNotice.writeNoticedVersion(store, "0.5.0"))
        assertEquals("0.5.0", FoliaUpdateNotice.readNoticedVersion(store))

        // And the round trip must actually change the decision.
        assertTrue(FoliaUpdateNotice.shouldShow("0.5.0", nothingSeen))
        assertFalse(FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(store)))
    }

    /**
     * `save()` returning false means the marker never reached disk. The read must then behave as if
     * nothing was stored — otherwise the notice would be suppressed for a user who was never told.
     */
    @Test
    fun `a failed save leaves the notice enabled`() {
        val store = InMemoryConfig(saveResult = false)
        assertFalse("a save that did not happen must be reported as such", FoliaUpdateNotice.writeNoticedVersion(store, "0.5.0"))
        assertTrue(
            "the next start must try again rather than silently swallowing the notice",
            FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(store)),
        )
    }

    /** A throwing config layer must degrade to "not seen" and never break plugin start-up. */
    @Test
    fun `a broken config layer degrades to not seen`() {
        val store = InMemoryConfig(throwOnGet = true)
        assertNull(FoliaUpdateNotice.readNoticedVersion(store))
        assertTrue(FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(store)))
    }

    /** Null helper (no ConfigManager available yet) is a real path on a partially-wired host. */
    @Test
    fun `a missing config helper does not throw`() {
        assertNull(FoliaUpdateNotice.readNoticedVersion(null))
        assertFalse(FoliaUpdateNotice.writeNoticedVersion(null, "0.5.0"))
        assertTrue(
            "with no storage the notice still shows — being told twice is better than never being told",
            FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(null)),
        )
    }

    /**
     * Minimal [ConfigHelper] stand-in: a map plus the failure switches the real callers have to
     * survive. Only the three methods this feature touches are meaningful.
     */
    private class InMemoryConfig(
        private val saveResult: Boolean = true,
        private val throwOnGet: Boolean = false,
    ) : ConfigHelper {
        val values: MutableMap<String, Any> = mutableMapOf()

        override fun <T> get(key: String, defaultValue: T): T {
            if (throwOnGet) throw IllegalStateException("config layer unavailable")
            @Suppress("UNCHECKED_CAST")
            return (values[key] as? T) ?: defaultValue
        }

        override fun set(key: String, value: Any) {
            values[key] = value
        }

        override fun save(): Boolean {
            // A failed save must not leave the value readable: that is exactly the lie the caller
            // would act on, so model the real behaviour (nothing reached disk).
            if (!saveResult) values.clear()
            return saveResult
        }

        override fun reload(): Boolean = true

        override fun getConfigPath(): java.nio.file.Path =
            java.io.File("in-memory-config.json").toPath()
    }
}
