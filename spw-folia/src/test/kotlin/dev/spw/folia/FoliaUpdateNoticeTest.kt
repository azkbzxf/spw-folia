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

    @org.junit.Rule
    @JvmField
    val tmp: org.junit.rules.TemporaryFolder = org.junit.rules.TemporaryFolder()

    private fun store(saveResult: Boolean = true, throwOnPath: Boolean = false) =
        FileConfig(tmp.newFolder(), saveResult = saveResult, throwOnPath = throwOnPath)

    /**
     * The read and write halves must agree on the same key and value type. This is the failure the
     * pure-decision tests above CANNOT see: a write to `updateNoticeShownVersion` and a read from a
     * differently-spelled key both "work", and the user gets the notice on every single start.
     */
    @Test
    fun `what the write stores is what the read finds`() {
        val store = store()
        val nothingSeen = FoliaUpdateNotice.readNoticedVersion(store)
        assertNull("an untouched store must read as 'never shown'", nothingSeen)

        assertTrue("the write must report success", FoliaUpdateNotice.writeNoticedVersion(store, "0.5.0"))
        assertEquals("0.5.0", FoliaUpdateNotice.readNoticedVersion(store))

        // And the round trip must actually change the decision.
        assertTrue(FoliaUpdateNotice.shouldShow("0.5.0", nothingSeen))
        assertFalse(FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(store)))
    }

    /**
     * **The bug that shipped in the first 0.5.0 build.** The marker was on disk, but the read went
     * through the host's `ConfigHelper.get`, which answered from a stale in-memory view — so every
     * restart showed the notice again.
     *
     * The fake below deliberately carries a stale view that lacks the key; the read must ignore it
     * and parse the FILE. This test fails if `readNoticedVersion` ever goes back to `config.get(...)`.
     */
    @Test
    fun `a stale in-memory helper view cannot resurrect the notice`() {
        val store = store()
        // The file already records "0.5.0" (a previous run wrote it) ...
        store.seedFile("""{"updateNoticeShownVersion":"0.5.0"}""")
        // ... while the helper's cached view knows nothing about it. This is what the host returned
        // on the real machine: `get(key, null)` -> null despite the value being on disk.
        store.seedStaleView("settingsJson", "{}")

        assertEquals(
            "the disk is the source of truth; a stale cache must not re-show the notice",
            "0.5.0",
            FoliaUpdateNotice.readNoticedVersion(store),
        )
        assertFalse(
            "this is the exact restart path that showed the notice twice",
            FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(store)),
        )
    }

    /** The marker must survive being written into a file that already holds other keys. */
    @Test
    fun `writing the marker preserves unrelated keys`() {
        val store = store()
        store.seedFile("""{"settingsJson":"{\"styleId\":\"sonnet\"}","textureDefaultMigrated":true}""")

        assertTrue(FoliaUpdateNotice.writeNoticedVersion(store, "0.5.0"))
        val text = java.io.File(store.getConfigPath().toString()).readText()
        assertTrue("the settings tree must not be destroyed", text.contains("settingsJson"))
        assertTrue("other markers must survive", text.contains("textureDefaultMigrated"))
        assertEquals("0.5.0", FoliaUpdateNotice.readNoticedVersion(store))
    }

    /**
     * `save()` returning false means the marker never reached disk. The read must then behave as if
     * nothing was stored — otherwise the notice would be suppressed for a user who was never told.
     */
    @Test
    fun `a failed save leaves the notice enabled`() {
        val store = store(saveResult = false)
        assertFalse("a save that did not happen must be reported as such", FoliaUpdateNotice.writeNoticedVersion(store, "0.5.0"))
        assertTrue(
            "the next start must try again rather than silently swallowing the notice",
            FoliaUpdateNotice.shouldShow("0.5.0", FoliaUpdateNotice.readNoticedVersion(store)),
        )
    }

    /** A throwing config layer must degrade to "not seen" and never break plugin start-up. */
    @Test
    fun `a broken config layer degrades to not seen`() {
        val store = store(throwOnPath = true)
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
     * Minimal [ConfigHelper] stand-in backed by a **real JSON file**.
     *
     * The first version of this fake kept the value in a map, and that is exactly why it missed the
     * defect that shipped in the first 0.5.0 build: the production read path goes through
     * `getConfigPath()` + the raw file text (see [FoliaUpdateNotice.readNoticedVersion]), so a
     * map-backed fake tested a code path that no longer existed. The fake therefore has to own a
     * file, and `get()` deliberately models the host's **stale in-memory view** so the tests can
     * prove the read does not trust it.
     */
    private class FileConfig(
        private val dir: java.io.File,
        private val saveResult: Boolean = true,
        private val throwOnPath: Boolean = false,
    ) : ConfigHelper {
        private val file = java.io.File(dir, "config.json")

        /** What a cached helper would answer — kept stale on purpose, never used for assertions. */
        private val staleView: MutableMap<String, Any> = mutableMapOf()

        override fun <T> get(key: String, defaultValue: T): T {
            @Suppress("UNCHECKED_CAST")
            return (staleView[key] as? T) ?: defaultValue
        }

        override fun set(key: String, value: Any) {
            staleView[key] = value
        }

        override fun save(): Boolean {
            if (!saveResult) return false
            // Merge into whatever is already on disk, like the host does for a multi-key file.
            val existing = if (file.isFile) file.readText(Charsets.UTF_8).trim() else "{}"
            var out = existing.ifBlank { "{}" }
            for ((k, v) in staleView) {
                out = upsertMember(out, k, v)
            }
            file.writeText(out, Charsets.UTF_8)
            staleView.clear()
            return true
        }

        /** Minimal root-level member upsert; enough for the two value kinds this feature stores. */
        private fun upsertMember(json: String, key: String, value: Any): String {
            val encoded = if (value is String) {
                "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
            } else {
                value.toString()
            }
            // Drop the previous root-level member of the same name (string/bool/number/null).
            val pattern = Regex(
                "\"${Regex.escape(key)}\"\\s*:\\s*(?:\"(?:[^\"\\\\]|\\\\.)*\"|true|false|null|-?[0-9.eE+]+)\\s*,?"
            )
            val stripped = pattern.replace(json, "").trim().trimEnd(',').trim()
            val body = stripped.removePrefix("{").removeSuffix("}").trim().trimEnd(',')
            val merged = if (body.isEmpty()) "\"$key\":$encoded" else body + ",\n  \"$key\":$encoded"
            return "{$merged}"
        }

        override fun reload(): Boolean = true

        override fun getConfigPath(): java.nio.file.Path {
            if (throwOnPath) throw IllegalStateException("config layer unavailable")
            return file.toPath()
        }

        /** Seeds the file directly, bypassing [save] — used to model "a previous run already wrote it". */
        fun seedFile(text: String) {
            file.writeText(text, Charsets.UTF_8)
        }

        /** Corrupts the helper with a stale in-memory value that the file does not have. */
        fun seedStaleView(key: String, value: Any) {
            staleView[key] = value
        }
    }
}
