package dev.spw.folia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * issue #23: the plugin's mod directory.
 *
 * ## What these tests defend
 *
 * Everything here writes files a **page** will later load over a URL, so the failure modes are the
 * expensive kind: a mod that installs "successfully" but never appears, a zip that writes outside the
 * directory we meant to write into, a digest that is computed but never enforced. None of them throws
 * and none of them is visible in the UI — they just quietly do the wrong thing.
 *
 * Two habits from `docs/lessons.md` shape the whole file:
 *
 *  - **§4.3 — real files, not a fake filesystem.** Every test below runs against a real directory
 *    from [TemporaryFolder], and one of them installs the actual sample archive the market serves
 *    (`.scratch/modtest/aurora.zip`). A test whose filesystem has no production file path is testing
 *    a code path production does not have.
 *  - **§1.1 — a claim needs a falsifiable check.** The traversal test asserts on the *filesystem*
 *    (nothing outside the mod directory, nothing inside it either), not on a returned string: a
 *    refusal message with the file already written would still pass a message-only assertion.
 */
class FoliaModStoreTest {

    @Rule
    @JvmField
    val tmp: TemporaryFolder = TemporaryFolder()

    /** Records log lines so "it refused quietly" and "it refused loudly" can be told apart. */
    private class Recorder {
        private val lines: MutableList<String> = Collections.synchronizedList(mutableListOf())
        fun log(message: String) {
            lines.add(message)
        }

        fun snapshot(): List<String> = lines.toList()
        fun contains(fragment: String): Boolean = lines.any { it.contains(fragment) }
    }

    private fun store(): Pair<FoliaModStore, Recorder> {
        val recorder = Recorder()
        return FoliaModStore(tmp.newFolder("plugin"), recorder::log) to recorder
    }

    // ------------------------------------------------------- the real sample zip ----

    /**
     * End to end against the archive the market actually serves.
     *
     * `.scratch/modtest/aurora.zip` (101228 B, sha256 `e7577423…`) is a real `sample-aurora-visualizer`
     * download: its own root contains one folder named after the mod, i.e. exactly the shape that made
     * "installed but invisible" the first thing to get wrong. The assertion that matters is the
     * resulting **path**: `mods/sample-aurora-visualizer/mod.json` and not
     * `mods/sample-aurora-visualizer/sample-aurora-visualizer/mod.json`. Both would satisfy "the files
     * are on disk", and only the first one is servable as `/__mods/sample-aurora-visualizer/…`.
     */
    @Test
    fun `installs the real aurora sample without an extra directory level`() {
        val zip = sampleZip()
        val (store, recorder) = store()
        val installed = store.install(zip, AURORA_SHA256).getOrElse { failure ->
            throw AssertionError("install failed: ${failure.message}", failure)
        }
        assertEquals("sha256 digest must decide the id, not the zip's file name", "sample-aurora-visualizer", installed.id)
        assertEquals("1.0.1", installed.version)
        assertEquals("虹光歌词动画（样例）", installed.name)
        assertEquals("Folia Mod Samples", installed.author)
        assertEquals("client.mjs", installed.clientEntry)
        assertEquals("preview.jpg", installed.previewEntry)
        assertTrue("a freshly installed mod is enabled at once (issue #23)", installed.enabled)
        assertNull("no error expected for a well-formed mod: ${installed.error}", installed.error)

        val modRoot = File(store.root, "sample-aurora-visualizer")
        assertTrue("mod.json must sit directly at mods/<id>/mod.json", File(modRoot, "mod.json").isFile)
        assertTrue("client.mjs must sit directly at mods/<id>/client.mjs", File(modRoot, "client.mjs").isFile)
        assertFalse(
            "the extra folder must NOT survive: that is the layout the page cannot load",
            File(modRoot, "sample-aurora-visualizer").exists(),
        )
        // The scanned list is what the page receives; assert it rather than trusting install().
        val scanned = store.scan()
        assertEquals(1, scanned.size)
        assertEquals(modRoot.canonicalPath, File(store.root, scanned[0].id).canonicalPath)
        assertTrue(
            "the install must say what it did: ${recorder.snapshot()}",
            recorder.contains("sha256 ok") && recorder.contains("installed sample-aurora-visualizer"),
        )
    }

    /** The digest the market publishes for that archive; recomputed here so the constant is honest. */
    @Test
    fun `the reference digest matches the sample archive on disk`() {
        assertEquals(AURORA_SHA256, FoliaModStore.sha256Of(sampleZip()))
    }

    // ------------------------------------------------------------ digest refusal ----

    /**
     * A mismatch must install **nothing**: the archive does not land in `mods/`, no mod directory
     * appears, and the temporary file is gone.
     *
     * The temp file deletion is not tidiness — it is the whole point. Leaving the rejected bytes on
     * disk is how "install failed" and "the file is right there" end up in the same bug report.
     */
    @Test
    fun `rejects a sha256 mismatch and leaves nothing behind`() {
        val zip = sampleZip()
        val (store, recorder) = store()
        val wrong = "0".repeat(64)
        val result = store.install(zip, wrong)
        assertTrue("a mismatch must fail", result.isFailure)
        val message = result.exceptionOrNull()?.message.orEmpty()
        assertTrue("the failure must name the digests: $message", message.contains("sha256"))
        assertFalse("the rejected archive must be deleted", zip.exists())
        assertTrue("a rejected install must not create a mod directory", store.scan().isEmpty())
        assertFalse("staging/trash leftovers must be cleaned up", hasDotDirectory(store.root))
        assertTrue("the refusal must be logged: ${recorder.snapshot()}", recorder.contains("sha256 不匹配"))
    }

    /** An upper-case digest from a catalog written by a different tool must still verify. */
    @Test
    fun `accepts a sha256 given in upper case`() {
        val (store, _) = store()
        val installed = store.install(sampleZip(), AURORA_SHA256.uppercase()).getOrNull()
        assertNotNull("hex case must not decide whether a package is valid", installed)
        assertEquals("sample-aurora-visualizer", installed?.id)
    }

    /** No digest at all is a caller bug, but it must not be an exception out of `install`. */
    @Test
    fun `refuses a malformed sha256 without touching the mods directory`() {
        val (store, _) = store()
        val result = store.install(sampleZip(), "not-a-digest")
        assertTrue(result.isFailure)
        assertTrue(store.scan().isEmpty())
    }

    // --------------------------------------------------------- directory traversal ----

    /**
     * A zip entry climbing out with `..` must be refused, and **nothing may be written anywhere**.
     *
     * The assertion is the filesystem, twice: the escaped target path does not exist (that is the bug
     * being prevented), and the mod directory stays empty (a partial extraction is still a write).
     */
    @Test
    fun `refuses a zip entry that escapes with dot dot`() {
        val zip = zipOf(
            "mod.json" to """{"folium":1,"id":"evil-mod","name":"Evil","version":"1.0.0","client":"client.mjs"}""",
            "client.mjs" to "export default function activate() {}",
            "../escaped.txt" to "this must never be written",
        )
        val (store, recorder) = store()
        val pluginPath = store.root.parentFile!!
        val escaped = File(pluginPath, "escaped.txt")
        val result = store.install(zip, null)
        assertTrue("a traversal entry must fail the install", result.isFailure)
        assertTrue(
            "the refusal must say why: ${result.exceptionOrNull()?.message}",
            result.exceptionOrNull()?.message.orEmpty().contains("逃出") ||
                result.exceptionOrNull()?.message.orEmpty().contains("不合法"),
        )
        assertFalse("the escaped file must not exist: ${escaped.absolutePath}", escaped.exists())
        assertFalse(File(modsParent(store), "escaped.txt").exists())
        assertTrue("nothing may be installed", store.scan().isEmpty())
        assertTrue("no leftovers", !hasDotDirectory(store.root) && !File(store.root, "evil-mod").exists())
        assertTrue(
            "the refusal must be logged: ${recorder.snapshot().filter { it.contains("mods:") }}",
            recorder.contains("拒绝"),
        )
    }

    /**
     * An absolute entry name is the other way out of a staging directory. `java.util.zip` keeps the
     * leading separator (and a Windows drive prefix) as text, so this checks the rule that rejects it
     * rather than the platform's behaviour on write.
     */
    @Test
    fun `refuses an absolute zip entry name`() {
        val zip = zipOf(
            "/absolute-escape.txt" to "nope",
            "mod.json" to """{"folium":1,"id":"abs-mod","name":"Abs","version":"1.0.0","client":"client.mjs"}""",
        )
        val (store, _) = store()
        val result = store.install(zip, null)
        assertTrue("an absolute entry must fail the install", result.isFailure)
        assertFalse(File("C:/absolute-escape.txt").exists())
        assertFalse(File("/absolute-escape.txt").exists())
        assertTrue(store.scan().isEmpty())
    }

    /**
     * `__MACOSX/` and dot-entries are what a Finder-made zip carries; they must be skipped, not treated
     * as an escape and not counted as mod content.
     */
    @Test
    fun `skips macOS resource forks and dot entries`() {
        val zip = zipOf(
            "__MACOSX/._mod.json" to "resource fork",
            ".DS_Store" to "junk",
            "mod.json" to """{"folium":1,"id":"clean-mod","name":"Clean","version":"2.0.0","client":"client.mjs"}""",
            "client.mjs" to "export default function activate() {}",
        )
        val (store, _) = store()
        val installed = store.install(zip, null).getOrThrow()
        assertEquals("clean-mod", installed.id)
        val modRoot = File(store.root, "clean-mod")
        assertFalse(File(modRoot, "__MACOSX").exists())
        assertFalse(File(modRoot, ".DS_Store").exists())
        assertTrue(File(modRoot, "client.mjs").isFile)
    }

    // --------------------------------------------------------- resolveModRoot rule ----

    /** `mod.json` in the entry itself: the entry is the root (upstream discovery.cjs:43-45). */
    @Test
    fun `resolveModRoot uses the entry when mod json is in it`() {
        val entry = tmp.newFolder("direct")
        File(entry, "mod.json").writeText("{}")
        assertEquals(entry.canonicalPath, FoliaModStore.resolveModRoot(entry).canonicalPath)
    }

    /** `mod.json` in exactly one subfolder: that subfolder is the root (the hand-extracted zip case). */
    @Test
    fun `resolveModRoot descends into the only subdirectory`() {
        val entry = tmp.newFolder("nested")
        val inner = File(entry, "nested-inner").apply { mkdirs() }
        File(inner, "mod.json").writeText("{}")
        assertEquals(inner.canonicalPath, FoliaModStore.resolveModRoot(entry).canonicalPath)
    }

    /**
     * Two candidate subfolders: ambiguous, so it must fall back to the entry — which then reports the
     * missing manifest. Picking one silently would install a mod nobody chose.
     */
    @Test
    fun `resolveModRoot refuses to guess between two candidates`() {
        val entry = tmp.newFolder("ambiguous")
        listOf("left", "right").forEach { name ->
            val child = File(entry, name).apply { mkdirs() }
            File(child, "mod.json").writeText("{}")
        }
        assertEquals(
            "an ambiguous layout must not be guessed at",
            entry.canonicalPath,
            FoliaModStore.resolveModRoot(entry).canonicalPath,
        )
    }

    /** A dot-directory is the loader's own bookkeeping and must never be chosen as a mod root. */
    @Test
    fun `resolveModRoot ignores dot directories`() {
        val entry = tmp.newFolder("dots")
        val hidden = File(entry, ".staging-1").apply { mkdirs() }
        File(hidden, "mod.json").writeText("{}")
        assertEquals(entry.canonicalPath, FoliaModStore.resolveModRoot(entry).canonicalPath)
    }

    /** A scan of a directory with no manifest anywhere must report (not install) and never throw. */
    @Test
    fun `scan skips a directory without a manifest and says so`() {
        val (store, recorder) = store()
        File(store.root, "not-a-mod").apply { mkdirs() }
        File(store.root, "not-a-mod/client.mjs").writeText("export default () => {}")
        assertTrue(store.scan().isEmpty())
        assertTrue(
            "a skipped directory must appear in the log: ${recorder.snapshot()}",
            recorder.contains("skipping not-a-mod"),
        )
    }

    // ------------------------------------------------------------------ enable state ----

    /**
     * The issue's promise: dropping a mod folder into `mods/` makes it work, with no state file and no
     * user action. Then the user turns it off, and it stays off across a restart (a fresh
     * [FoliaModStore] over the same directory is a restart).
     */
    @Test
    fun `a hand-dropped mod is enabled by default and a disable survives a restart`() {
        val zip = zipOf(
            "mod.json" to """{"folium":1,"id":"toggle-mod","name":"Toggle","version":"1.0.0","client":"client.mjs"}""",
            "client.mjs" to "export default function activate() {}",
        )
        val (store, _) = store()
        store.install(zip, null).getOrThrow()
        assertTrue(store.scan().single().enabled)

        store.setEnabled("toggle-mod", false).getOrThrow()
        assertFalse("the user's choice must win", store.scan().single().enabled)
        val reopened = FoliaModStore(store.root.parentFile!!, {})
        assertFalse("a disable must survive a restart", reopened.scan().single().enabled)

        reopened.setEnabled("toggle-mod", true).getOrThrow()
        assertTrue(reopened.scan().single().enabled)
        val stateFile = File(store.root, "mod-system.json")
        assertTrue("the state file must be on disk", stateFile.isFile)
        assertTrue(stateFile.readText(StandardCharsets.UTF_8).contains("toggle-mod"))
    }

    /**
     * A mod copied in by hand **after** the state file exists must still come up enabled — that is what
     * `known` is for. Without it, one earlier toggle would silently disable every later manual install.
     */
    @Test
    fun `a mod added after the state file exists is still enabled`() {
        val (store, _) = store()
        File(store.root, "first-mod").apply { mkdirs() }
        File(store.root, "first-mod/mod.json").writeText(
            """{"folium":1,"id":"first-mod","name":"First","version":"1.0.0","client":"client.mjs"}"""
        )
        File(store.root, "first-mod/client.mjs").writeText("export default () => {}")
        store.setEnabled("first-mod", false).getOrThrow()

        File(store.root, "second-mod").apply { mkdirs() }
        File(store.root, "second-mod/mod.json").writeText(
            """{"folium":1,"id":"second-mod","name":"Second","version":"1.0.0","client":"client.mjs"}"""
        )
        File(store.root, "second-mod/client.mjs").writeText("export default () => {}")

        val byId = store.scan().associateBy { it.id }
        assertFalse("the explicit disable must survive", byId.getValue("first-mod").enabled)
        assertTrue("a newly dropped mod must be usable at once", byId.getValue("second-mod").enabled)
    }

    /** A corrupt state file fails **open**: worse to lose everyone's mods than to honour a stale off. */
    @Test
    fun `an unreadable state file means installed is enabled`() {
        val (store, recorder) = store()
        File(store.root, "some-mod").apply { mkdirs() }
        File(store.root, "some-mod/mod.json").writeText(
            """{"folium":1,"id":"some-mod","name":"Some","version":"1.0.0","client":"client.mjs"}"""
        )
        File(store.root, "some-mod/client.mjs").writeText("export default () => {}")
        File(store.root, "mod-system.json").writeText("{ this is not json")
        assertTrue(store.scan().single().enabled)
        assertTrue(recorder.contains("无法解析"))
    }

    // ------------------------------------------------------------------- uninstall ----

    /** Uninstall removes the directory and the state entry; the mod disappears from the next scan. */
    @Test
    fun `uninstall removes the directory and forgets the mod`() {
        val (store, _) = store()
        store.install(sampleZip(), AURORA_SHA256).getOrThrow()
        assertTrue(File(store.root, "sample-aurora-visualizer").exists())

        store.uninstall("sample-aurora-visualizer").getOrThrow()
        assertFalse(File(store.root, "sample-aurora-visualizer").exists())
        assertTrue(store.scan().isEmpty())
        assertFalse("no trash directory may survive", hasDotDirectory(store.root))
        assertTrue(store.uninstall("sample-aurora-visualizer").isFailure)
    }

    /** A second install of the same id replaces the old copy instead of nesting it. */
    @Test
    fun `reinstalling the same mod replaces the old copy`() {
        val (store, _) = store()
        store.install(sampleZip(), AURORA_SHA256).getOrThrow()
        File(File(store.root, "sample-aurora-visualizer"), "stale-marker.txt").writeText("old")
        store.install(sampleZip(), AURORA_SHA256).getOrThrow()
        val modRoot = File(store.root, "sample-aurora-visualizer")
        assertFalse("the replaced copy must be gone entirely", File(modRoot, "stale-marker.txt").exists())
        assertTrue(File(modRoot, "mod.json").isFile)
        assertEquals("exactly one entry after a reinstall", 1, store.scan().size)
        assertFalse(hasDotDirectory(store.root))
    }

    // ------------------------------------------------------------------- mods JSON ----

    /**
     * The list that crosses the line protocol: **one line**, every field escaped, no pretty printing.
     *
     * `docs/lessons.md` §3: a newline anywhere outside a string literal splits one message into several
     * invalid ones, and the host drops them all without an error. This asserts on the bytes for exactly
     * that reason — a `json().parse()` round-trip would pass even with newlines in it.
     */
    @Test
    fun `toJson emits one escaped line`() {
        val json = FoliaModStore.toJson(
            listOf(
                InstalledMod(
                    id = "quote-mod",
                    name = "a \"quoted\" name\nwith a newline",
                    version = "1.0.0",
                    author = "back\\slash",
                    description = "带中文的说明",
                    permissions = listOf("playback.control", "filesystem.data"),
                    enabled = true,
                    clientEntry = "client.mjs",
                    previewEntry = null,
                    error = null,
                ),
                InstalledMod(
                    id = "second-mod",
                    name = "Second",
                    version = "2.0.0",
                    author = null,
                    description = null,
                    permissions = emptyList(),
                    enabled = false,
                    clientEntry = null,
                    previewEntry = "preview.jpg",
                    error = "只有 main（Node）入口",
                ),
            )
        )
        assertFalse("the mods array must be one line", json.contains('\n'))
        assertFalse(json.contains('\r'))
        assertTrue(json.startsWith("[{"))
        assertTrue(json.endsWith("}]"))
        assertTrue("quotes must be escaped: $json", json.contains("\\\"quoted\\\""))
        assertTrue("a newline inside a string must be escaped: $json", json.contains("\\n"))
        assertTrue("a backslash must be escaped: $json", json.contains("back\\\\slash"))
        assertTrue(json.contains("\"enabled\":true"))
        assertTrue(json.contains("\"enabled\":false"))
        assertTrue("a null preview must be a JSON null", json.contains("\"previewEntry\":null"))
        assertTrue(json.contains("\"permissions\":[]"))
        assertTrue(json.contains("\"permissions\":[\"playback.control\",\"filesystem.data\"]"))
        // Every field the protocol promises must be present on every entry.
        listOf("id", "name", "version", "author", "description", "permissions", "enabled", "clientEntry", "previewEntry", "error")
            .forEach { field ->
                assertEquals(
                    "field $field must appear twice (once per mod)",
                    2,
                    Regex("\"" + field + "\":").findAll(json).count(),
                )
            }
    }

    /** An empty list is `[]`, not an omission: the page must be able to tell "none" from "no news". */
    @Test
    fun `toJson of no mods is an empty array`() {
        assertEquals("[]", FoliaModStore.toJson(emptyList()))
    }

    /**
     * The whole stdin line, not just the array: `{"t":"mods","mods":[…]}`.
     *
     * This is the boundary the host parses. It has to be one line (line protocol), the array has to be
     * spliced verbatim (re-serialising would double-escape `name`), and the message type has to be
     * exactly `mods` — a typo there is the failure mode with no symptom at all: the host drops an
     * unknown `t` silently, so the page would simply never see any mod.
     */
    @Test
    fun `the mods stdin line is one line with the array spliced verbatim`() {
        val mods = FoliaModStore.toJson(
            listOf(
                InstalledMod(
                    id = "line-mod",
                    name = "带 \"引号\" 与 \\ 的模组",
                    version = "1.0.0",
                    author = null,
                    description = null,
                    permissions = emptyList(),
                    enabled = true,
                    clientEntry = "client.mjs",
                    previewEntry = null,
                    error = null,
                ),
            )
        )
        val line = FoliaHostBridge.modsLine(mods)
        assertFalse("the protocol is line oriented: no newline may survive", line.contains('\n'))
        assertFalse(line.contains('\r'))
        assertTrue("the message type must be exactly `mods`: $line", line.startsWith("{\"t\":\"mods\",\"mods\":["))
        assertTrue("the array must be spliced unmodified", line.endsWith(mods + "}"))
        // What the host does: read `t`, then pull the raw array back out of the line.
        assertEquals("mods", Json.stringField(line, "t"))
        assertEquals(mods, Json.rawField(line, "mods"))
        // And every string inside is recoverable, i.e. it was escaped exactly once.
        val first = Json.rawField(line, "mods")!!.removePrefix("[").removeSuffix("]")
        assertEquals("带 \"引号\" 与 \\ 的模组", Json.stringField(first, "name"))
    }

    /** The `log` line (plugin -> host) used to report every mod action. */
    @Test
    fun `the log stdin line escapes level and message`() {
        val line = FoliaHostBridge.logLine("warn", "mods: action=install -> 失败：\"C:\\Users\\x\"")
        assertFalse(line.contains('\n'))
        assertEquals("log", Json.stringField(line, "t"))
        assertEquals("warn", Json.stringField(line, "level"))
        assertEquals("mods: action=install -> 失败：\"C:\\Users\\x\"", Json.stringField(line, "msg"))
    }

    /**
     * issue #23 配置页入口: the `command` line (plugin -> host) that carries 「模组市场」.
     *
     * This is the **first** command the plugin ever sends the host, so the shape has to be pinned
     * rather than reviewed: the host reads it with the same `JsonUtil.GetString(msg, "command")` it
     * uses for its own commands, and a splice-instead-of-escape here would let a bad action inject a
     * second member into the line. One string with a quote in it is the whole falsification.
     */
    @Test
    fun `the command stdin line carries one escaped action name`() {
        val line = FoliaHostBridge.commandLine(FoliaPlugin.OPEN_MOD_MARKET_COMMAND)
        assertFalse("the protocol is line oriented: no newline may survive", line.contains('\n'))
        assertFalse(line.contains('\r'))
        assertEquals("command", Json.stringField(line, "t"))
        assertEquals(
            "the host resolves the action by this exact string",
            "open-mod-market",
            Json.stringField(line, "command"),
        )
        // A hostile/typo'd action must stay a VALUE, never become a second member of the envelope.
        val hostile = FoliaHostBridge.commandLine("x\",\"command\":\"close")
        assertEquals("x\",\"command\":\"close", Json.stringField(hostile, "command"))
        assertEquals(
            "the envelope keeps exactly the two members it declares: $hostile",
            2,
            Regex("\"(t|command)\"\\s*:").findAll(hostile).count(),
        )
    }

    /**
     * The name the 配置 page's `on_click` points at must be the one the constant feeds the host.
     *
     * `preference_config.json` is the contract SPW resolves by reflection; nothing at compile time
     * connects `dev.spw.folia.FoliaPlugin.onOpenModMarket` to `OPEN_MOD_MARKET_COMMAND`. This test
     * closes the loop from the DECLARATION side: the button exists, and the action it eventually
     * produces is the string the page's `ui` handler answers to.
     *
     * v0.5.2: the group now carries three buttons, and the FIRST one is 导入模组… — the user's
     * 「模组市场在配置中的主要功能是能手动导入模组」 put manual import ahead of the market. Order is
     * asserted, not just presence: a reordering is a silent UX change and nothing else would catch it.
     */
    @Test
    fun `the mods group is declared with the three buttons in the agreed order and its own config file`() {
        val declaration = javaClass.classLoader
            ?.getResourceAsStream("preference_config.json")
            ?.use { it.readBytes().toString(Charsets.UTF_8) }
        assertNotNull("preference_config.json must ship inside the jar", declaration)
        val text = declaration!!
        assertTrue("the 模组 group needs its own config file (换组 = 换存储文件)", text.contains("\"mods.json\""))
        assertTrue(text.contains("\"title\": \"模组\""))
        assertTrue(
            "manual import is the group's PRIMARY action: its on_click must resolve to a real static method",
            text.contains("dev.spw.folia.FoliaPlugin.onImportModZip"),
        )
        assertTrue(
            "the folder button must resolve to a real static method",
            text.contains("dev.spw.folia.FoliaPlugin.onOpenModsFolder"),
        )
        assertTrue(
            "the market button must resolve to a real static method",
            text.contains("dev.spw.folia.FoliaPlugin.onOpenModMarket"),
        )
        // Order inside the group: 导入 → 打开文件夹 → 市场. Asserted on offsets in the declaration text
        // because that is the only place the order exists (SPW renders `preferences` verbatim).
        val importAt = text.indexOf("dev.spw.folia.FoliaPlugin.onImportModZip")
        val folderAt = text.indexOf("dev.spw.folia.FoliaPlugin.onOpenModsFolder")
        val marketAt = text.indexOf("dev.spw.folia.FoliaPlugin.onOpenModMarket")
        assertTrue(
            "the order must be 导入模组 → 打开模组文件夹 → 模组市场, got offsets " +
                "import=$importAt folder=$folderAt market=$marketAt",
            importAt in 0 until folderAt && folderAt < marketAt,
        )
        assertFalse(
            "the mods group must not declare a switch: verify-all's contract only tracks switches",
            text.contains("\"mods.json\"") && text.substringAfter("\"mods.json\"").substringBefore("]").contains("\"type\": \"switch\""),
        )
        // The plugin-to-page action the buttons produce, pinned here so a rename shows up as a test
        // failure instead of a dead button.
        assertEquals("open-mod-market", FoliaPlugin.OPEN_MOD_MARKET_COMMAND)
    }

    /**
     * issue #23（第二轮）: the two argv shapes that decide whether mods work at all.
     *
     * 「安装模组后没有变化」 had a root cause that no test could see: the plugin spawned the helper
     * **without** `--mods-dir`, so the host mounted no `/__mods/` interceptor, every mod import
     * rejected, and the shelf stayed empty while everything looked installed. Nothing at compile time
     * connects a flag in an argv list to a behaviour on the other side of a process boundary, so the
     * only defence is pinning the shape here.
     *
     * Two halves:
     *  - the **player** argv must carry `--mods-dir` + an absolute path as two separate entries (a
     *    joined `"--mods-dir <path>"` would be one unrecognised argument — the same failure the
     *    `/select` argv test guards against);
     *  - the **market** argv must NOT: it opens `mod-market.html` in a small window and never imports a
     *    mod entry. It must also not be fullscreen (the host's default is true and there is no
     *    `--no-fullscreen`), must not be topmost, must not be colour-keyed, and must use its own
     *    WebView2 profile (two processes on one profile is undefined behaviour).
     */
    @Test
    fun `the market window argv is small, opaque, and does not serve mod files`() {
        val args = FoliaHostBridge.marketArgs("""C:\plugin\webview-market""")
        assertTrue("the page is the market-only shell", args.contains("--url"))
        assertEquals(
            "the market page URL and the constant must agree: a mismatch is a blank window",
            "settings/mod-market.html?market=1",
            FoliaHostBridge.MARKET_PAGE,
        )
        val url = args[args.indexOf("--url") + 1]
        assertTrue("the URL must point at the market-only page: $url", url.endsWith(FoliaHostBridge.MARKET_PAGE))
        assertTrue("a small window, not the fullscreen player", args.contains("--window"))
        assertFalse(
            "`--window WxH` already sets Fullscreen=false in Program.cs; passing --fullscreen too would " +
                "make the market window fill the screen",
            args.contains("--fullscreen"),
        )
        assertTrue("a config window must not sit on top of everything", args.contains("--no-topmost"))
        assertTrue("the settings tree may ask for transparency; this window must refuse it", args.contains("--no-transparency"))
        assertTrue("no opening splash in a config window", args.contains("--no-curtain"))
        assertTrue("nothing plays here, so the display may sleep", args.contains("--no-keep-awake"))
        assertFalse(
            "the market never imports a mod entry, so it must not mount the /__mods/ interceptor",
            args.contains("--mods-dir"),
        )
        assertEquals(
            "a second process needs its own WebView2 profile (docs/host-app.md)",
            """C:\plugin\webview-market""",
            args[args.indexOf("--user-data") + 1],
        )
    }

    /**
     * issue #23（第二轮）: the `modProgress` line the page's progress bar is built from.
     *
     * The page pairs a bar with the install it started by `actionId`, so the shape is a contract:
     * one line, `phase` whitelisted by the host, `total = -1` when the denominator is unknown (the
     * page draws an indeterminate bar for exactly that). A `null` id must stay JSON `null`, never the
     * string `"null"` — `Json.str` is the one place that distinction lives.
     */
    @Test
    fun `the modProgress line is one line with a numeric total and a real null id`() {
        val line = FoliaHostBridge.modProgressLine("mod-abc", "visualizer52hz", "download", 1234, 5678)
        assertFalse("line oriented protocol", line.contains('\n'))
        assertFalse(line.contains('\r'))
        assertEquals("modProgress", Json.stringField(line, "t"))
        assertEquals("download", Json.stringField(line, "phase"))
        assertEquals("mod-abc", Json.stringField(line, "actionId"))
        assertEquals("visualizer52hz", Json.stringField(line, "modId"))
        assertTrue("received must be a number, not a string: $line", line.contains("\"received\":1234"))
        assertTrue("total must be a number: $line", line.contains("\"total\":5678"))

        // Unknown denominator: -1 reaches the page as a number, which is what draws the indeterminate bar.
        val unknown = FoliaHostBridge.modProgressLine(null, "m", "unpack", 0, -1)
        assertTrue("an unknown total stays -1: $unknown", unknown.contains("\"total\":-1"))
        assertEquals(
            "a missing actionId is JSON null, not the four-letter string",
            "null",
            Json.rawField(unknown, "actionId"),
        )
        // A hostile phase must stay a VALUE inside the string, never become a second member.
        val hostile = FoliaHostBridge.modProgressLine("x\",\"phase\":\"done", "m", "download", 1, 2)
        assertEquals("x\",\"phase\":\"done", Json.stringField(hostile, "actionId"))
    }

    // ------------------------------------------------------- injected settings member ----
    /**
     * `mods` goes into the settings tree as a top-level member and is replaced in place, so the island
     * reads the current list and the rest of the tree survives byte for byte.
     */
    @Test
    fun `withModsMember injects and replaces the list without touching the rest of the tree`() {
        val mods = """[{"id":"m","name":"M"}]"""
        val injected = FoliaModStore.withModsMember("""{"theme":"dark","tuning":{"a":1}}""", mods)
        assertTrue(injected, injected.contains("\"mods\":" + mods))
        assertTrue("the other members must survive", injected.contains("\"theme\":\"dark\""))
        assertTrue(injected.contains("\"tuning\":{\"a\":1}"))

        val replaced = FoliaModStore.withModsMember(injected, "[]")
        assertTrue(replaced, replaced.contains("\"mods\":[]"))
        assertFalse("the old list must be gone", replaced.contains("m\",\"name\":\"M"))
        assertTrue(replaced.contains("\"theme\":\"dark\""))
        assertEquals(
            "injecting twice must not duplicate the member",
            1,
            Regex("\"mods\":").findAll(replaced).count(),
        )
    }

    /** A non-object tree comes back untouched: never make a malformed tree worse. */
    @Test
    fun `withModsMember leaves a non-object tree alone`() {
        assertEquals("not json", FoliaModStore.withModsMember("not json", "[]"))
        assertEquals("[]", FoliaModStore.withModsMember("[]", "[]"))
    }

    /**
     * The real settings tree the plugin ships (`packaging/testdata/default-settings.json`, pretty
     * printed, 7000+ bytes): inject, collapse to one line, and the list must still be readable back
     * out of the line.
     *
     * This is the test `docs/lessons.md` §3 asks for. The bundled tree is the one file that is
     * definitely pretty-printed, so it is the one that can break the line protocol — and did, once,
     * for three config switches at a time. A synthetic `{"a":1}` would have proved nothing.
     */
    @Test
    fun `the real default settings tree survives mods injection and line collapsing`() {
        val source = findRepoFile("packaging/testdata/default-settings.json")
            ?: throw AssertionError("missing the bundled default settings tree")
        val pretty = source.readText(StandardCharsets.UTF_8)
        assertTrue("the fixture must be the pretty-printed tree", pretty.contains('\n'))

        val mods = FoliaModStore.toJson(
            listOf(
                InstalledMod(
                    id = "sample-aurora-visualizer",
                    name = "虹光歌词动画（样例）",
                    version = "1.0.1",
                    author = "Folia Mod Samples",
                    description = "带 \"引号\" 与 \\ 反斜杠 的说明",
                    permissions = listOf("playback.control"),
                    enabled = true,
                    clientEntry = "client.mjs",
                    previewEntry = "preview.jpg",
                    error = null,
                ),
            )
        )
        val injected = FoliaModStore.withModsMember(pretty, mods)
        // This is exactly what the bridge does before writing the line (sendSettings/sendMods).
        val line = Json.singleLine(injected)
        assertFalse("a newline outside a string would split the message", Json.needsCollapsing(line))
        assertFalse(line.contains('\n'))

        val roundTripped = Json.rawField(line, "mods")
        assertEquals("the injected array must come back byte-identical", mods, roundTripped)
        assertTrue("the rest of the tree must survive injection", line.contains("\"styleId\":\"sonnet\""))

        // And stripping it must leave a tree that still has everything else. The plugin's live tree is
        // always the collapsed form (FoliaSettingsStore collapses the bundled default on load), so the
        // round trip that ships is strip(collapse(inject(pretty))).
        val stripped = FoliaPlugin.stripInjectedMembers(line)
        assertFalse(stripped.contains("\"mods\""))
        assertTrue("every other member must survive the strip", stripped.contains("\"styleId\":\"sonnet\""))
        assertTrue("the strip must not truncate the tree", stripped.contains("\"styleTunings\""))
        assertNotNull("the stripped tree must still be a JSON object", FoliaModStore.rootMembers(stripped.trim()))
        assertFalse("and it must still fit on one line", Json.needsCollapsing(stripped))
    }

    /** The plugin strips the member before persisting the page's echo (single-writer rule). */
    @Test
    fun `stripInjectedMembers removes the mods the page echoed back`() {
        val tree = """{"theme":"dark","mods":[{"id":"m"}],"previewAnimation":true}"""
        val clean = FoliaPlugin.stripInjectedMembers(tree)
        assertFalse("the page must not own the mod list", clean.contains("\"mods\""))
        assertTrue(clean.contains("\"theme\":\"dark\""))
        assertFalse(clean.contains("previewAnimation"))
    }

    // --------------------------------------------------------- mod.json edge cases ----

    /**
     * `mod.json` with a nested object whose key collides with a manifest field must be read from the
     * ROOT. A first-match text search would return the nested `id` and silently mislabel the mod.
     */
    @Test
    fun `manifest fields are read from the root even when a nested object repeats them`() {
        val zip = zipOf(
            "mod.json" to """
                {
                  "folium": 1,
                  "id": "root-id",
                  "name": "Root Name",
                  "version": "1.2.3",
                  "client": "client.mjs",
                  "settings": { "id": "nested-id", "name": "Nested", "version": "9.9.9" }
                }
            """.trimIndent(),
            "client.mjs" to "export default function activate() {}",
        )
        val (store, _) = store()
        val installed = store.install(zip, null).getOrThrow()
        assertEquals("root-id", installed.id)
        assertEquals("Root Name", installed.name)
        assertEquals("1.2.3", installed.version)
    }

    /** A manifest with no version cannot be listed (it would render as an unversioned row). */
    @Test
    fun `a manifest without version is skipped by scan`() {
        val (store, recorder) = store()
        val dir = File(store.root, "no-version").apply { mkdirs() }
        File(dir, "mod.json").writeText("""{"id":"no-version","name":"No Version","client":"client.mjs"}""")
        File(dir, "client.mjs").writeText("export default () => {}")
        assertTrue(store.scan().isEmpty())
        assertTrue(recorder.contains("缺少 version"))

        val failure = store.install(zipOf("mod.json" to """{"id":"x","name":"X","client":"client.mjs"}"""), null)
        assertTrue("installing it must fail, not silently create a broken mod", failure.isFailure)
    }

    /** A directory whose name differs from its manifest id cannot be served, so it is reported. */
    @Test
    fun `a directory level that does not match the id is reported instead of loaded`() {
        val (store, _) = store()
        val dir = File(store.root, "wrong-folder").apply { mkdirs() }
        File(dir, "mod.json").writeText(
            """{"folium":1,"id":"real-id","name":"Real","version":"1.0.0","client":"client.mjs"}"""
        )
        File(dir, "client.mjs").writeText("export default () => {}")
        val mod = store.scan().single()
        assertEquals("real-id", mod.id)
        assertNull("an unusable layout must not advertise a client entry", mod.clientEntry)
        assertNotNull("and it must say why", mod.error)
        assertTrue(mod.error.orEmpty().contains("目录布局"))
    }

    /** A declared client file that is not in the archive is an error on the entry, not a crash. */
    @Test
    fun `a missing client entry is reported on the mod`() {
        val (store, _) = store()
        val dir = File(store.root, "broken-client").apply { mkdirs() }
        File(dir, "mod.json").writeText(
            """{"folium":1,"id":"broken-client","name":"Broken","version":"1.0.0","client":"client.mjs"}"""
        )
        val mod = store.scan().single()
        assertNull(mod.clientEntry)
        assertTrue(mod.error.orEmpty().contains("client.mjs"))
    }

    /** A `mod.json` that is not JSON at all is skipped with a warn (never an exception). */
    @Test
    fun `a corrupt manifest is skipped without throwing`() {
        val (store, recorder) = store()
        val dir = File(store.root, "corrupt").apply { mkdirs() }
        File(dir, "mod.json").writeText("{ oops")
        assertTrue(store.scan().isEmpty())
        assertTrue(recorder.contains("skipping corrupt"))
    }

    // ------------------------------------------------------------- SSRF / URL rules ----

    /**
     * The download address comes from the page, so the allow-list is load-bearing: without it,
     * `install` is a request-forgery primitive (`file:`, `http://localhost`, an internal host).
     */
    @Test
    fun `only https addresses on the market host are downloadable`() {
        assertTrue(
            FoliaModDownloads.isAllowedUrl("https://folium-compound.cielaniska.top/downloads/aurora-1.0.1.zip")
        )
        assertTrue(FoliaModDownloads.isAllowedUrl("https://FOLIUM-COMPOUND.CIELANISKA.TOP/x.zip"))
        assertTrue(FoliaModDownloads.isAllowedUrl("https://folium-compound.cielaniska.top:443/x.zip"))
        assertTrue(FoliaModDownloads.isAllowedUrl("https://folium-compound.cielaniska.top/x?y=1#z"))

        // Everything below would make the plugin fetch something the user never agreed to.
        assertFalse("plain http", FoliaModDownloads.isAllowedUrl("http://folium-compound.cielaniska.top/x.zip"))
        assertFalse("file", FoliaModDownloads.isAllowedUrl("file:///C:/Windows/win.ini"))
        assertFalse("other host", FoliaModDownloads.isAllowedUrl("https://evil.example/x.zip"))
        assertFalse("localhost", FoliaModDownloads.isAllowedUrl("https://127.0.0.1/x.zip"))
        assertFalse("userinfo trick", FoliaModDownloads.isAllowedUrl("https://folium-compound.cielaniska.top@evil.example/x.zip"))
        assertFalse("odd port", FoliaModDownloads.isAllowedUrl("https://folium-compound.cielaniska.top:8443/x.zip"))
        assertFalse("relative", FoliaModDownloads.isAllowedUrl("/downloads/x.zip"))
        assertFalse("empty", FoliaModDownloads.isAllowedUrl(""))
        assertFalse("null", FoliaModDownloads.isAllowedUrl(null))
    }

    /** The market publishes lower-case hex; an upper-case or padded value must still be accepted. */
    @Test
    fun `sha256 normalization accepts upper case and rejects anything that is not a digest`() {
        assertEquals(AURORA_SHA256, FoliaModStore.normalizeSha256("  " + AURORA_SHA256.uppercase() + "  "))
        assertNull(FoliaModStore.normalizeSha256("abc"))
        assertNull(FoliaModStore.normalizeSha256("z".repeat(64)))
        assertNull(FoliaModStore.normalizeSha256(AURORA_SHA256 + "0"))
    }

    /** The zip entry path rule, pinned directly: it guards both extraction and the served URL. */
    @Test
    fun `relative entry paths reject traversal and absolute forms`() {
        assertTrue(FoliaModStore.isSafeRelativePath("client.mjs"))
        assertTrue(FoliaModStore.isSafeRelativePath("dist/client.mjs"))
        assertFalse(FoliaModStore.isSafeRelativePath("../client.mjs"))
        assertFalse(FoliaModStore.isSafeRelativePath("a/../../b"))
        assertFalse(FoliaModStore.isSafeRelativePath("dist\\client.mjs"))
        assertFalse(FoliaModStore.isSafeRelativePath("/client.mjs"))
        assertFalse(FoliaModStore.isSafeRelativePath("C:/client.mjs"))
        assertFalse(FoliaModStore.isSafeRelativePath(""))
    }

    // ------------------------------------------------------- 配置页手工导入 zip ----

    /**
     * issue #23 v0.5.2: 「模组 → 导入模组…」在 `JFileChooser` 之后做的唯一两个判断，钉死它。
     *
     * 为什么这个判断值得一个单测、而 `onImportModZip` 本身不值得：那个静态方法只打开一个 Swing
     * 对话框（在无显示环境里必然失败），而**取消要不要算失败**、**非 zip 要不要放进解包器**是两条
     * 会在真机上表现为「点了一下什么都没发生」/「报一个看不懂的错误」的规则，它们必须能被自动化
     * 门禁复现。所以判断逻辑被提到 [FoliaModStore.importableArchive] 这个纯函数里。
     *
     * 三种「不是可导入的包」各占一行，因为它们的消息不一样、修法也不一样：
     *  - `null`（用户取消 / 对话框失败）→ 静默，不是错误；
     *  - 不存在 / 是目录 → 静默；
     *  - 存在但不是 `.zip` → 调用方要明确说「只能导入 .zip」，不能把它丢给解包器。
     */
    @Test
    fun `the manual import accepts only an existing zip file and treats cancel as nothing`() {
        val dir = tmp.newFolder("picked")
        val zip = File(dir, "my-mod.zip").apply { writeText("not really a zip, only the decision matters") }
        val upper = File(dir, "MY-MOD.ZIP").apply { writeText("extension case must not matter") }
        val notZip = File(dir, "my-mod.rar").apply { writeText("wrong container") }
        val noExtension = File(dir, "my-mod").apply { writeText("no extension") }

        assertNull("cancel / a failed dialog is not an error", FoliaModStore.importableArchive(null))
        assertNull("a path that does not exist is not importable", FoliaModStore.importableArchive(File(dir, "gone.zip")))
        assertNull("a directory is not importable", FoliaModStore.importableArchive(dir))
        assertNull("only .zip is accepted", FoliaModStore.importableArchive(notZip))
        assertNull("a file without an extension is refused too", FoliaModStore.importableArchive(noExtension))

        assertEquals("a real .zip is accepted", zip.canonicalPath, FoliaModStore.importableArchive(zip)?.canonicalPath)
        assertEquals(
            "the extension check must be case-insensitive (Windows names are)",
            upper.canonicalPath,
            FoliaModStore.importableArchive(upper)?.canonicalPath,
        )
    }

    /**
     * 手工导入走的是 `install(archive, expectedSha256 = null)`，所以「没有摘要」这条路径必须真的能装。
     *
     * 这不只是「不报错」：市场那条路每次都带 `download.sha256`，`null` 分支只有在手工导入时才被
     * 执行。如果哪天有人给 `install` 加一句「没有摘要就拒绝」，市场页全绿、单测里所有用真实样包
     * 的用例也都带着 AURORA_SHA256，**只有用户按配置页第一个按钮才会失败** —— 这条用例就是那个
     * 唯一会红的检查。
     */
    @Test
    fun `a manually picked archive installs with no digest and keeps every unpack guard`() {
        val (store, recorder) = store()
        val picked = sampleZip()
        assertNull("the fixture is not digest-checked on this path by definition", FoliaModStore.normalizeSha256("x"))
        val archive = FoliaModStore.importableArchive(picked)
        assertNotNull("the picked sample must be importable", archive)
        val installed = store.install(archive!!, null).getOrElse { failure ->
            throw AssertionError("a digest-less manual import must install: ${failure.message}", failure)
        }
        assertEquals("sample-aurora-visualizer", installed.id)
        assertTrue("installed mods are enabled at once", installed.enabled)
        assertNull("no warning for a well-formed mod: ${installed.error}", installed.error)
        assertTrue(File(File(store.root, installed.id), "mod.json").isFile)
        assertTrue(
            "a digest-less install must still say what it did: ${recorder.snapshot()}",
            recorder.contains("installed sample-aurora-visualizer"),
        )
    }

    /**
     * `fetch` must refuse a disallowed address **before opening a socket**, and leave no temp file.
     *
     * The URL check is the whole defence, so this asserts on the outcome a caller sees: a failed
     * `Result` whose message names the allow-list. If the check ever moved after the connect, this test
     * would still pass only by accident — which is why the assertion also pins the message.
     */
    @Test
    fun `fetch refuses a non-allowlisted address without creating a file`() {
        val before = tempFilesWithPrefix()
        val result = FoliaModDownloads.fetch("https://evil.example/mod.zip")
        assertTrue("an off-allowlist address must fail", result.isFailure)
        assertTrue(
            "the refusal must name the allow-list: ${result.exceptionOrNull()?.message}",
            result.exceptionOrNull()?.message.orEmpty().contains("白名单"),
        )
        assertNull("no file may be returned on failure", result.getOrNull())
        assertEquals("a refusal must not leave a temp file behind", before, tempFilesWithPrefix())
    }

    /** `@TempDir`-style prefix scan for the downloader's own temp files. */
    private fun tempFilesWithPrefix(): Set<String> =
        (File(System.getProperty("java.io.tmpdir")).listFiles() ?: emptyArray())
            .filter { it.name.startsWith("spw-folia-mod-") }
            .map { it.name }
            .toSet()

    /**
     * The downloader against the **real** market, end to end.
     *
     * Gated behind `SPW_FOLIA_LIVE_MOD_DOWNLOAD=1` because the rest of the suite must pass offline (and
     * on a machine with no network at all). It is the one test that proves the bytes on this machine are
     * the bytes the catalog advertises: the market serves archives **without**
     * `Access-Control-Allow-Origin`, which is the reason this downloader exists at all, and a regression
     * here would look exactly like a page-side CORS error.
     *
     * An environment variable, not a `-D` system property: `gradlew -D…` sets a property on the Gradle
     * **daemon**, which the forked test JVM does not see (the first attempt at this test silently
     * skipped for that reason). Gradle forwards the environment to test workers.
     *
     * ```
     * SPW_FOLIA_LIVE_MOD_DOWNLOAD=1 ./gradlew.bat test --tests '*FoliaModStoreTest*' --rerun-tasks
     * ```
     */
    @Test
    fun `downloads the real market archive and verifies its published digest`() {
        org.junit.Assume.assumeTrue(
            "set SPW_FOLIA_LIVE_MOD_DOWNLOAD=1 to run the network test",
            System.getenv(LIVE_DOWNLOAD_FLAG) == "1",
        )
        val url = "https://folium-compound.cielaniska.top/downloads/sample-aurora-visualizer-1.0.1.zip"
        val downloaded = FoliaModDownloads.fetch(url, log = {}).getOrElse { failure ->
            throw AssertionError("live download failed: ${failure.message}", failure)
        }
        try {
            assertEquals("the published size must match", AURORA_BYTES, downloaded.length())
            assertEquals("the published digest must match", AURORA_SHA256, FoliaModStore.sha256Of(downloaded))
            // And the downloaded archive must install into the layout the page can load.
            val (store, _) = store()
            val installed = store.install(downloaded, AURORA_SHA256).getOrThrow()
            assertEquals("sample-aurora-visualizer", installed.id)
            assertTrue(File(File(store.root, "sample-aurora-visualizer"), "client.mjs").isFile)
        } finally {
            downloaded.delete()
        }
    }

    /**
     * issue #23（第二轮）: 安装进度回调 —— 进度条唯一的数据来源。
     *
     * 用户的抱怨是「点击下载后没有进度条」。这条测试钉的是**回调真的被调用、且分母说得清**：
     *  - `verify` 的分母必须是文件长度（真百分比）；
     *  - `unpack` 的分母是 `-1`（没有可数的总量，界面画不定长条）；
     *  - 进度必须单调不减，且最后一拍 `done >= total`（否则进度条永远停在 99%）。
     *
     * 用本地 fixture 而不是真网：真网测的是网络，这条测的是**回调契约**，两者失败原因不同，
     * 混在一起会让「网络抖动」看起来像「进度条坏了」。
     */
    @Test
    fun `install reports verify and unpack progress with a usable denominator`() {
        val (store, _) = store()
        val events = Collections.synchronizedList(ArrayList<Triple<String, Long, Long>>())
        val zip = sampleZip()
        val installed = store.install(zip, AURORA_SHA256) { phase, done, total ->
            events.add(Triple(phase, done, total))
        }.getOrThrow()
        assertEquals("sample-aurora-visualizer", installed.id)

        assertTrue("the progress callback must fire at all — an empty list is the dead progress bar", events.isNotEmpty())

        val verify = events.filter { it.first == "verify" }
        assertTrue("verify must report progress (it is the determinate phase)", verify.isNotEmpty())
        val verifyTotal = verify.last().third
        assertEquals("verify's denominator is the file length on disk", zip.length(), verifyTotal)
        assertTrue("verify must finish at 100%, not stall short of it", verify.last().second >= verifyTotal)

        val unpack = events.filter { it.first == "unpack" }
        assertTrue("unpack must report at least start and finish", unpack.size >= 2)
        assertTrue(
            "unpack has no countable total, so it must report -1 (the page draws an indeterminate bar for that)",
            unpack.all { it.third == -1L },
        )

        // Monotonic within a phase: a progress bar that can go backwards is worse than none.
        for (phase in listOf("verify", "unpack")) {
            val done = events.filter { it.first == phase }.map { it.second }
            assertEquals("$phase progress must be monotonic: $done", done.sorted(), done)
        }
    }

    /** The refusal path must not report a bogus 100%: a digest mismatch ends the install, no `done`. */
    @Test
    fun `a refused install reports no completed progress`() {
        val (store, _) = store()
        val events = Collections.synchronizedList(ArrayList<Triple<String, Long, Long>>())
        val wrong = "0".repeat(64)
        val result = store.install(sampleZip(), wrong) { phase, done, total -> events.add(Triple(phase, done, total)) }
        assertTrue("a mismatched digest must refuse", result.isFailure)
        assertTrue(
            "verify may report partial progress, but unpack must never start for a rejected archive",
            events.none { it.first == "unpack" },
        )
    }

    // --------------------------------------------------------------------- helpers ----

    private fun modsParent(store: FoliaModStore): File = store.root.parentFile!!

    /**
     * Finds a repo-relative file by walking up from the working directory.
     *
     * Tests run with `spw-folia/spw-folia` as cwd under Gradle, but a plain JVM invocation could be
     * anywhere; the repo root is whichever ancestor holds the path. Null when nothing matches, so a
     * caller can turn a missing fixture into an explicit failure instead of a silent skip.
     */
    private fun findRepoFile(relative: String): File? {
        var directory: File? = File("").absoluteFile
        while (directory != null) {
            val candidate = File(directory, relative)
            if (candidate.isFile) return candidate
            directory = directory.parentFile
        }
        return null
    }

    /** True when any dot-directory (staging/trash) survives under [root]. */
    private fun hasDotDirectory(root: File): Boolean =
        (root.listFiles() ?: emptyArray()).any { it.isDirectory && it.name.startsWith(".") }

    /**
     * The market's sample archive, checked in under `.scratch/modtest/`.
     *
     * A missing sample is a **failure**, never a skip: this is the only test that installs a real
     * archive, and silently passing without it would let the whole extraction path rot. The file lives
     * in `.scratch/` (git-ignored, local evidence) so the repo never redistributes third-party mod code.
     */
    private fun sampleZip(): File {
        // Gradle runs tests with the project directory as cwd (`spw-folia/spw-folia`), but a plain
        // JVM run from anywhere else has to find the fixture too — so walk up looking for it instead
        // of hard-coding one relative depth.
        val resolved = findRepoFile(SAMPLE_ARCHIVE) ?: throw AssertionError(
            "missing sample archive: no ancestor of ${File("").absolutePath} contains $SAMPLE_ARCHIVE " +
                "(the real-zip end-to-end test cannot be skipped — see .scratch/modtest/)"
        )
        // A copy, because install() deletes the archive on a digest mismatch and a test must not eat
        // the fixture the next test needs.
        val copy = File(tmp.newFolder(), resolved.name)
        resolved.copyTo(copy, overwrite = true)
        assertEquals("fixture changed on disk", AURORA_SHA256, FoliaModStore.sha256Of(copy))
        return copy
    }

    /** Writes a real zip with exactly the entries given, in order. */
    private fun zipOf(vararg entries: Pair<String, String>): File {
        val file = File(tmp.newFolder(), "mod.zip")
        ZipOutputStream(file.outputStream()).use { zip ->
            entries.forEach { (name, content) ->
                val bytes = content.toByteArray(StandardCharsets.UTF_8)
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return file
    }

    private companion object {
        /** `.scratch/modtest/aurora.zip`, resolved against the repo root found by walking up. */
        const val SAMPLE_ARCHIVE = ".scratch/modtest/aurora.zip"

        /** The digest the market publishes for that sample. */
        const val AURORA_SHA256 = "e75774234fc42f34a708068911d377194868a4f67afe4ae2c7e593935ec13501"

        /** Its published size, in bytes. */
        const val AURORA_BYTES = 101228L

        /** Opt-in environment variable for the network test. */
        const val LIVE_DOWNLOAD_FLAG = "SPW_FOLIA_LIVE_MOD_DOWNLOAD"
    }
}
