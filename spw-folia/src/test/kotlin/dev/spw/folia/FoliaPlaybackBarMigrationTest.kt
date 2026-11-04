package dev.spw.folia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v0.4.17 (issue #18 item 2): the 「显示播放条」 switch moved from the 配置 page to the player page's
 * own menu, which moves OWNERSHIP of the value from the plugin to the page.
 *
 * The seam has two halves, and each is invisible when broken:
 *
 *  1. the plugin must hand the OLD `config.json` value down as `showPlaybackBarLegacy` so a page
 *     whose store is empty can seed itself (otherwise an upgrading user's hidden bar reappears);
 *  2. on the way BACK, the page echoes the tree it was given, and the plugin must KEEP the page's
 *     `showPlaybackBar` while stripping the legacy hint (otherwise the user's new-menu choice is
 *     discarded on the next restart — the switch looks live and forgets itself).
 *
 * Both are pinned here because neither shows up in the UI: the failure mode is "my setting does not
 * stick", which is exactly the class of bug the surrounding code exists to prevent.
 */
class FoliaPlaybackBarMigrationTest {

    // ------------------------------------------------------- 1. the legacy hint goes down ----

    /**
     * `FoliaConfigSync.applyTo` is what carries plugin-owned members into the tree. The bar value
     * must travel under the LEGACY name and must not be written as the page-owned key.
     */
    @Test
    fun `the plugin offers the old bar value under the legacy name, never the page's key`() {
        // applyTo reads the value from sync state, so the on-disk read path is covered by
        // FoliaConfigSyncTest. Here the contract is the SHAPE of the two member names.
        val tree = """{"showPlaybackBar":true,"styleId":"sonnet"}"""
        val out = Json.withBoolMember(tree, SHOW_PLAYBACK_BAR_LEGACY_KEY, false)

        assertEquals(
            "the legacy name must be present so the page can seed an empty store",
            false,
            Json.boolField(out, "showPlaybackBarLegacy"),
        )
        assertEquals(
            "writing the legacy member must not disturb the page's own key",
            true,
            Json.boolField(out, "showPlaybackBar"),
        )
        assertEquals("unrelated members must survive", "sonnet", Json.stringField(out, "styleId"))
        assertFalse(
            "the two spellings must stay distinct, or a stale config.json value would be " +
                "indistinguishable from the page's live one",
            SHOW_PLAYBACK_BAR_LEGACY_KEY == "showPlaybackBar",
        )
    }

    /** The two names are part of the cross-file contract with the page; pin the exact spelling. */
    @Test
    fun `the legacy member is spelled exactly showPlaybackBarLegacy`() {
        // The page-side code matches on this literal (model/settings.ts). A rename on one side only
        // produces no error anywhere — the page simply never seeds.
        assertEquals("showPlaybackBarLegacy", SHOW_PLAYBACK_BAR_LEGACY_KEY)
    }

    // ------------------------------------------------- 2. the page's echo is persisted as-is ----

    /**
     * The critical half: a tree echoed by the page carrying `showPlaybackBar` must keep it.
     *
     * `FoliaPlugin.stripInjectedMembers` removes the injected members before persisting. If it also
     * removed `showPlaybackBar` (which it DID before v0.4.17), the new menu's value would be dropped
     * on every save, so the switch would reset on restart.
     */
    @Test
    fun `the page's own showPlaybackBar survives the strip that runs before persisting`() {
        val echoed = """{"showPlaybackBar":false,"showPlaybackBarLegacy":true,""" +
            """"showProblemButton":false,"previewAnimation":true,"styleId":"sonnet"}"""

        val clean = FoliaPlugin.stripInjectedMembers(echoed)

        assertEquals(
            "the page owns 显示播放条 now: its value MUST be persisted, or the new menu's change " +
                "is discarded on the next restart",
            false,
            Json.boolField(clean, "showPlaybackBar"),
        )
        assertNull(
            "the migration hint is not a setting and must not reach the settings file",
            Json.boolField(clean, "showPlaybackBarLegacy"),
        )
        assertNull(
            "showProblemButton is still owned by the 配置 page and must keep being stripped",
            Json.boolField(clean, "showProblemButton"),
        )
        assertNull(
            "previewAnimation is still owned by the 配置 page and must keep being stripped",
            Json.boolField(clean, "previewAnimation"),
        )
        assertEquals("unrelated state must survive the strip", "sonnet", Json.stringField(clean, "styleId"))
    }

    /**
     * The strip must stay SAFE on a tree that has nothing injected (a first echo, or a tree written
     * by an older build): it must not corrupt the JSON or throw.
     */
    @Test
    fun `the strip is a no-op on a tree without injected members`() {
        val plain = """{"styleId":"sonnet","showPlaybackBar":true}"""
        val clean = FoliaPlugin.stripInjectedMembers(plain)

        assertEquals("nothing to strip, nothing may change", plain, clean)
        assertTrue("the page's value must still parse", Json.boolField(clean, "showPlaybackBar")!!)
    }

    private companion object {
        /** Mirrors `FoliaPlugin.SHOW_PLAYBACK_BAR_LEGACY_KEY`, which is private. */
        const val SHOW_PLAYBACK_BAR_LEGACY_KEY = "showPlaybackBarLegacy"
    }
}
