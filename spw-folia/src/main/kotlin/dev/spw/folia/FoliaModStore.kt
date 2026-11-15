package dev.spw.folia

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Locale
import java.util.zip.ZipFile

/**
 * One installed Folium mod, as the plugin sees it on disk (issue #23).
 *
 * The plugin is the **only** writer of this fact set (`docs/lessons.md` §3.1: one fact, one writer).
 * The page receives it and may only ask for actions; it never keeps its own copy of the list. The
 * same object is published twice, on two channels that exist for different consumers:
 *
 *  - `{"t":"mods","mods":[...]}` on stdin -> host -> `PostToPage` -> `Shim.js`, which activates the
 *    enabled clients from `/__mods/<id>/<clientEntry>`;
 *  - a top-level `mods` member of the settings tree, for the settings island (read-only), because the
 *    island only ever sees `getSettings()` / `settings` events.
 *
 * `clientEntry` / `previewEntry` are paths **relative to the mod directory** — exactly the strings a
 * consumer appends to `/__mods/<id>/`. Both are null when the file is missing, or when the on-disk
 * layout cannot be served at that URL, so nobody ever requests a 404.
 *
 * `error` is non-null for a mod that is present but unusable. Reported, never silently skipped: a mod
 * that merely *vanishes* from the list with one log line is the silent-failure shape this repo keeps
 * paying for.
 */
internal data class InstalledMod(
    val id: String,
    val name: String,
    val version: String,
    val author: String?,
    val description: String?,
    val permissions: List<String>,
    val enabled: Boolean,
    val clientEntry: String?,
    val previewEntry: String?,
    val error: String?,
)

/**
 * The mod directory: scan / verify / unpack / enable (issue #23).
 *
 * ## Why this class exists at all
 *
 * The mod market's archive endpoint (the `downloads` directory of the market host) answers **without**
 * `Access-Control-Allow-Origin`
 * (`.scratch/issue23/repo-report.md` §7.2), so a page inside WebView2 cannot read those bytes; only
 * the plugin (real filesystem, real sockets) can download, verify, unpack and store them. This is
 * that half. It is deliberately self-contained (JDK only, no Compose, no Workshop API) so a plain JVM
 * test can drive it against real files under `java.nio.file.Files.createTempDirectory` — the lesson
 * from `docs/lessons.md` §4.3: a test whose fake filesystem has no production file path is testing a
 * code path production does not have.
 *
 * ## Layout (mirrors the upstream loader)
 *
 * ```
 * <pluginPath>/mods/
 *   mod-system.json          {"enabled":[...],"known":[...]}   <- enable/disable state
 *   <modId>/mod.json, client.mjs, preview.jpg, folium.sig.json
 *   .staging-<nano>/         transient (never listed, never served)
 *   .trash-<nano>/           transient
 * ```
 *
 * The upstream Electron loader has the same shape and the same rule for finding the manifest inside
 * an entry (`electron/modSystem/discovery.cjs:35-57`): `mod.json` sits either in the entry itself or
 * in **exactly one** subfolder, because a zip extracted by hand usually leaves that extra folder
 * behind (`mods/foo-1.0.0/foo/mod.json`). [resolveModRoot] copies that rule verbatim.
 *
 * ## Threading
 *
 * Every method runs on the **calling** thread and this class starts no thread of its own: the disk IO
 * belongs to whoever asked for it, and the plugin owns the background thread. That keeps the class
 * trivially testable and keeps the bridge's stdout-reader thread out of the disk path.
 */
internal class FoliaModStore(
    pluginPath: File,
    private val log: (String) -> Unit,
) {

    /** `<pluginPath>/mods`, created on first construction (and by every [modsRoot] call). */
    val root: File = modsRoot(pluginPath)

    private val stateFile: File = File(root, STATE_FILE)

    // ---------------------------------------------------------------- scanning ----

    /**
     * Lists every mod directory, with its manifest and enable state. Never throws: a broken mod is
     * reported (skip + warn, or `error` when the entry is still meaningful) instead of taking the
     * caller down.
     */
    fun scan(): List<InstalledMod> {
        val state = readState()
        val entries = runCatching { root.listFiles() }.getOrNull() ?: return emptyList()
        val seen = HashSet<String>()
        val mods = ArrayList<InstalledMod>()
        entries
            // Dot-directories are the loader's own bookkeeping (staging, trash), never mods
            // (upstream discovery.cjs:71 says the same thing).
            .filter { it.isDirectory && !it.name.startsWith(".") }
            .sortedBy { it.name }
            .forEach { entry ->
                val resolved = toInstalled(entry, state) ?: return@forEach
                if (!seen.add(resolved.id)) {
                    log("mods: duplicate id ${resolved.id} in ${entry.name}, keeping the first one")
                    return@forEach
                }
                mods.add(resolved)
            }
        return mods
    }

    /** Reads one entry; null when it has to be skipped (with a warn). */
    private fun toInstalled(entry: File, state: ModState): InstalledMod? {
        val modRoot = resolveModRoot(entry)
        val read = readManifest(modRoot)
        val manifest = read.manifest
        if (manifest == null) {
            log("mods: skipping ${entry.name}: ${read.error}")
            return null
        }
        // The page asks for `/__mods/<id>/<file>` and the host maps that to `<mods>/<id>/<file>`
        // verbatim. Any other layout (an entry folder whose name differs from the manifest id, or a
        // manifest one level too deep) reads fine on disk but can never be fetched over the mod host,
        // so it is reported rather than handed to the page as a loadable mod.
        val servable = File(root, manifest.id)
        val layoutError = when {
            !File(servable, MANIFEST).isFile ->
                "目录布局与 id 不符：需要 mods/${manifest.id}/mod.json（实际是 mods/${entry.name}/…），请从市场重新安装"
            modRoot.canonicalFile != servable.canonicalFile ->
                "目录布局与 id 不符：mod.json 不在 mods/${manifest.id}/ 这一层，请从市场重新安装"
            else -> null
        }
        val base = if (layoutError == null) servable else modRoot
        val client = resolveEntry(base, manifest.client, " .mjs/.js ")
        val preview = resolveEntry(base, manifest.preview, "图片")
        return InstalledMod(
            id = manifest.id,
            name = manifest.name,
            version = manifest.version,
            author = manifest.author,
            description = manifest.description,
            permissions = manifest.permissions,
            enabled = state.isEnabled(manifest.id),
            clientEntry = if (layoutError == null) client.path else null,
            previewEntry = if (layoutError == null) preview.path else null,
            error = layoutError
                ?: read.error.takeIf { it.isNotBlank() }
                ?: client.error
                ?: preview.error,
        )
    }

    /** One declared relative entry: the path the moment it is servable, plus why it is not. */
    private class ResolvedEntry(val path: String?, val error: String?)

    private fun resolveEntry(base: File, declared: String?, kind: String): ResolvedEntry {
        if (declared == null) return ResolvedEntry(null, null)
        if (!isSafeRelativePath(declared) || File(base, declared).isDirectory) {
            return ResolvedEntry(null, "mod.json 里的入口路径不合法（$declared）")
        }
        return if (File(base, declared).isFile) {
            ResolvedEntry(declared, null)
        } else {
            ResolvedEntry(null, "清单声明了 $declared，但模组目录里没有这个${kind}文件")
        }
    }

    // ----------------------------------------------------------------- install ----

    /**
     * Verifies, unpacks and installs one archive. **Never throws** — the [Result] carries the reason.
     *
     * Order matters, and every step is a rule:
     *  1. SHA-256 first. A mismatch deletes the temporary archive and installs nothing: a download is
     *     untrusted input until the market's digest agrees. A null [expectedSha256] means the caller
     *     had no digest to check — the market UI refuses to offer install in that case.
     *  2. Unpack into `<mods>/.staging-<nano>/` so a half-written mod is never visible; the rename
     *     into `<mods>/<id>/` is the only moment it appears.
     *  3. Every zip entry is canonicalised and re-checked against the staging directory, so `..`,
     *     drive letters and absolute names cannot escape. A zip is attacker-controlled bytes and this
     *     is the only place we write them out.
     *  4. An existing `<mods>/<id>/` is renamed into `.trash-<nano>` (atomic on NTFS) *before* the new
     *     copy is renamed in; if that rename fails, the old copy is renamed back.
     */
    fun install(zipFile: File, expectedSha256: String?): Result<InstalledMod> = try {
        if (expectedSha256 != null) {
            val expected = normalizeSha256(expectedSha256)
            if (expected == null) {
                zipFile.delete()
                return refuse("sha256 值不合法（需要 64 位十六进制）：$expectedSha256")
            }
            val actual = sha256Of(zipFile)
            if (actual == null) {
                zipFile.delete()
                return refuse("无法读取下载的模组包：${zipFile.name}")
            }
            if (!actual.equals(expected, ignoreCase = true)) {
                // Never leave the archive behind: it is the untrusted artifact, and "it is only a
                // temp file" is how a rejected download becomes tomorrow's mystery.
                zipFile.delete()
                return refuse("sha256 不匹配：期望 $expected，实际 $actual；已丢弃下载的内容")
            }
            log("mods: sha256 ok ($actual) for ${zipFile.name} (${zipFile.length()} bytes)")
        }
        val staging = File(root, ".staging-" + System.nanoTime())
        if (!staging.mkdirs()) return refuse("无法创建暂存目录 ${staging.name}")
        try {
            val refusal = extract(zipFile, staging)
            if (refusal != null) return refuse(refusal)
            val stagedRoot = resolveModRoot(staging)
            if (!File(stagedRoot, MANIFEST).isFile) {
                return refuse("模组包里没有 mod.json（根目录与唯一子目录都不是模组根）")
            }
            val read = readManifest(stagedRoot)
            val manifest = read.manifest ?: return refuse("mod.json 无效：${read.error}")
            val target = File(root, manifest.id)
            var parked: File? = null
            if (target.exists()) {
                val moved = File(root, ".trash-" + System.nanoTime())
                if (!target.renameTo(moved)) {
                    return refuse("无法替换已安装的 ${manifest.id}（目录被占用？）")
                }
                parked = moved
            }
            if (!moveInto(stagedRoot, target)) {
                if (parked != null && !parked.renameTo(target)) {
                    log("WARNING: mods: rollback of ${manifest.id} failed, old copy stays in ${parked.name}")
                }
                return refuse("无法把 ${stagedRoot.name} 移到 ${target.name}（旧版本已回滚）")
            }
            if (parked != null) deleteRecursively(parked)
            val state = readState()
            // A first-time id is enabled at once (issue #23: 「移入模组文件夹即可生效」); one the user
            // had explicitly switched off keeps that choice across a reinstall.
            if (!state.known.contains(manifest.id)) state.enabled.add(manifest.id)
            state.known.add(manifest.id)
            writeState(state)
            val installed = toInstalled(target, state)
                ?: return refuse("安装后无法读取 ${manifest.id} 的清单")
            log(
                "mods: installed ${installed.id} ${installed.version}" +
                    (installed.error?.let { " (warning: $it)" } ?: "")
            )
            Result.success(installed)
        } finally {
            deleteRecursively(staging)
        }
    } catch (t: Throwable) {
        refuse("${t::class.java.name}: ${t.message}")
    }

    /**
     * One refusal: **logged and returned**, in that order.
     *
     * Both halves matter. The `Result` is what the action handler forwards to the user, but the log
     * line is what an offline investigation has: without it, "the install did nothing" is
     * indistinguishable from "the action never arrived", and the failure leaves no trace at all
     * (`docs/lessons.md` §1.6 — evidence over recollection).
     */
    private fun <T> refuse(message: String): Result<T> {
        log("mods: 拒绝安装：$message")
        return Result.failure(IOException(message))
    }

    /** Copies every entry of [zipFile] into [target], or returns the reason it refused. */
    private fun extract(zipFile: File, target: File): String? {
        val base = target.canonicalFile.toPath()
        var entries = 0
        var bytes = 0L
        ZipFile(zipFile).use { zip ->
            val iterator = zip.entries()
            while (iterator.hasMoreElements()) {
                val entry = iterator.nextElement()
                val raw = entry.name ?: continue
                if (entry.isDirectory) continue
                val normalized = raw.replace('\\', '/')
                if (normalized.endsWith("/")) continue
                if (!isSafeRelativePath(normalized) || normalized.contains(':')) {
                    return "拒绝解包：条目路径不合法（$raw），可能是目录穿越"
                }
                val segments = normalized.split('/')
                // `__MACOSX/…` is what a Finder-made zip carries, and a leading dot is both `.DS_Store`
                // junk and how the loader names its own bookkeeping directories. Neither ever belongs
                // to a mod, so they are skipped rather than treated as an error.
                if (segments.first().equals(MACOSX_PREFIX, ignoreCase = true)) continue
                if (segments.any { it.isEmpty() || it.startsWith(".") }) continue
                if (++entries > MAX_ENTRIES) return "拒绝解包：条目超过 $MAX_ENTRIES 个"
                val file = File(target, normalized)
                // The gate that matters: after canonicalisation the destination must still be inside
                // the staging directory. Checked BEFORE any parent directory is created. A name the
                // platform cannot canonicalise (a reserved device name, an over-long path) is refused
                // rather than allowed through on the assumption that it would fail later anyway.
                val canonical = runCatching { file.canonicalFile }.getOrNull()
                    ?: return "拒绝解包：条目路径无法规范化（$raw）"
                if (!canonical.toPath().startsWith(base)) {
                    return "拒绝解包：条目逃出目标目录（$raw）"
                }
                canonical.parentFile?.mkdirs()
                val written = zip.getInputStream(entry).use { input ->
                    writeLimited(input, canonical, MAX_ENTRY_BYTES)
                }
                bytes += written
                if (bytes > MAX_TOTAL_BYTES) return "拒绝解包：解压后超过 $MAX_TOTAL_BYTES 字节"
            }
        }
        return if (entries == 0) "模组包里没有任何文件" else null
    }

    /** Streams [input] into [target], refusing to write more than [limit] bytes. Returns the count. */
    private fun writeLimited(input: InputStream, target: File, limit: Long): Long {
        var total = 0L
        FileOutputStream(target).use { out ->
            val buffer = ByteArray(COPY_BUFFER)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > limit) throw IOException("条目超过 $limit 字节：${target.name}")
                out.write(buffer, 0, read)
            }
        }
        return total
    }

    /** Renames [from] onto [to], falling back to a copy for a cross-volume move. */
    private fun moveInto(from: File, to: File): Boolean {
        if (from.renameTo(to)) return true
        val moved = runCatching {
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }.isSuccess
        if (moved) return true
        val copied = runCatching {
            from.copyRecursively(to, overwrite = true) && from.deleteRecursively()
        }.getOrDefault(false)
        return copied && File(to, MANIFEST).isFile
    }

    // --------------------------------------------------------------- mutations ----

    /** Moves the mod directory into `.trash-<nano>` (rename first, then delete) and forgets its state. */
    fun uninstall(id: String): Result<Unit> = try {
        when {
            !MOD_ID_PATTERN.matches(id) ->
                Result.failure(IllegalArgumentException("模组 id 不合法：$id"))
            !File(root, id).exists() ->
                Result.failure(IllegalStateException("模组未安装：$id"))
            else -> {
                val dir = File(root, id)
                // Rename first: the directory disappears from the mod list atomically, so a slow or
                // failing recursive delete can never leave a half-mod behind in view.
                val parked = File(root, ".trash-" + System.nanoTime())
                if (!dir.renameTo(parked)) {
                    Result.failure(IOException("无法移走 $id（目录被占用？）"))
                } else {
                    deleteRecursively(parked)
                    val state = readState()
                    state.enabled.remove(id)
                    state.known.remove(id)
                    writeState(state)
                    log("mods: uninstalled $id")
                    Result.success(Unit)
                }
            }
        }
    } catch (t: Throwable) {
        Result.failure(t)
    }

    /** Records an explicit enable/disable. Only an installed mod can be toggled. */
    fun setEnabled(id: String, on: Boolean): Result<Unit> = try {
        when {
            !MOD_ID_PATTERN.matches(id) -> Result.failure(IllegalArgumentException("模组 id 不合法：$id"))
            !File(root, id).exists() -> Result.failure(IllegalStateException("模组未安装：$id"))
            else -> {
                val state = readState()
                state.known.add(id)
                if (on) state.enabled.add(id) else state.enabled.remove(id)
                writeState(state)
                log("mods: $id enabled=$on")
                Result.success(Unit)
            }
        }
    } catch (t: Throwable) {
        Result.failure(t)
    }

    // -------------------------------------------------------------- mod-system ----

    /**
     * Enable state, persisted in `mod-system.json`.
     *
     * Two id sets, because the issue asks for two things one set cannot express:
     *  - **installed means enabled**: an id the file has never seen is enabled, so a mod works the
     *    moment it lands in the folder (issue #23: 「移入模组文件夹即可生效」) — including one the user
     *    drops in by hand after the file was written;
     *  - the user's explicit choice wins: a mod they switched off sits in `known` but not in `enabled`,
     *    which is what makes it stay off.
     *
     * Without `known`, a single toggle would silently turn off every later hand-dropped mod (they
     * would look like ids missing from `enabled`). A corrupt or unreadable file fails **open**, exactly
     * like no file: the worst case is that a mod the user disabled is on again, and every mod here was
     * put there by that user — whereas failing closed would read as "all my mods vanished". The same
     * 「read the file, and treat unreadable as absent」 rule as `FoliaConfigSync` (lessons §4.3).
     */
    private class ModState(val enabled: MutableSet<String>, val known: MutableSet<String>) {
        fun isEnabled(id: String): Boolean = enabled.contains(id) || !known.contains(id)
    }

    private fun readState(): ModState {
        val enabled = LinkedHashSet<String>()
        val known = LinkedHashSet<String>()
        val text = runCatching {
            if (stateFile.isFile) stateFile.readText(StandardCharsets.UTF_8) else null
        }.getOrNull()
        if (text == null) return ModState(enabled, known)
        val enabledRaw = stringArray(Json.rawField(text, "enabled"))
        val knownRaw = stringArray(Json.rawField(text, "known"))
        if (enabledRaw == null && knownRaw == null) {
            log("mods: $STATE_FILE 无法解析，按「已装即启用」处理")
            return ModState(enabled, known)
        }
        enabled.addAll(enabledRaw.orEmpty())
        known.addAll(knownRaw.orEmpty())
        // `enabled` implies `known`: an id the user turned on was obviously seen before.
        known.addAll(enabled)
        return ModState(enabled, known)
    }

    /** Writes the state file through a temp file + rename, so a crash cannot leave half an object. */
    private fun writeState(state: ModState) {
        val json = buildString {
            append("{\"enabled\":[")
            state.enabled.sorted().forEachIndexed { index, id ->
                if (index > 0) append(',')
                append(Json.str(id))
            }
            append("],\"known\":[")
            state.known.sorted().forEachIndexed { index, id ->
                if (index > 0) append(',')
                append(Json.str(id))
            }
            append("]}")
        }
        runCatching {
            val temp = File(root, "$STATE_FILE.tmp")
            temp.writeText(json, StandardCharsets.UTF_8)
            if (!temp.renameTo(stateFile)) {
                stateFile.writeText(json, StandardCharsets.UTF_8)
                temp.delete()
            }
        }.onFailure {
            // Reported, not fatal: the in-memory state still drives this session, and the next write
            // retries. A mod list that cannot be *read* again would be the visible symptom, so say it.
            log("mods: 无法写入 $STATE_FILE：${it::class.java.name}: ${it.message}")
        }
    }

    // ---------------------------------------------------------------- manifest ----

    /** The fields of `mod.json` this plugin uses. Unknown fields are ignored (upstream validates them). */
    private class Manifest(
        val id: String,
        val name: String,
        val version: String,
        val author: String?,
        val description: String?,
        val permissions: List<String>,
        val client: String?,
        val preview: String?,
    )

    /** A manifest read, plus why it is unusable (blank when it is fine). */
    private class ManifestRead(val manifest: Manifest?, val error: String)

    /**
     * Decodes one root member located by [rootMembers] as a JSON string literal; null when absent or
     * when it is not a string. The literal is handed to [Json.stringField] so there is exactly one
     * escape decoder in this codebase.
     */
    private fun Map<String, String>.string(key: String): String? {
        val raw = this[key] ?: return null
        if (!raw.startsWith("\"")) return null
        return Json.stringField("{\"k\":$raw}", "k")
    }

    /**
     * Parses `mod.json` without a JSON library.
     *
     * Root-level members are located by a real scanner ([rootMembers]) instead of a substring search:
     * `mod.json` may carry a nested object whose keys collide with ours (`"settings":{"id":…}`), and a
     * first-match text search would happily return the nested value. Each located literal is then
     * decoded by [Json.stringField] — the audited decoder the protocol already depends on — rather
     * than a second escape table.
     */
    private fun readManifest(modRoot: File): ManifestRead {
        val file = File(modRoot, MANIFEST)
        if (!file.isFile) return ManifestRead(null, "缺少 $MANIFEST")
        val text = runCatching { file.readText(StandardCharsets.UTF_8) }.getOrElse { failure ->
            return ManifestRead(null, "无法读取 $MANIFEST：${failure.message}")
        }
        val body = text.removePrefix("\uFEFF").trim()
        val members = rootMembers(body) ?: return ManifestRead(null, "$MANIFEST 不是 JSON 对象")
        val id = members.string("id")?.trim().orEmpty()
        if (id.isEmpty()) return ManifestRead(null, "缺少 id")
        if (id.length > MAX_ID_LENGTH || !MOD_ID_PATTERN.matches(id)) {
            return ManifestRead(null, "id 不合法（需要小写字母/数字/连字符）：$id")
        }
        val version = members.string("version")?.trim().orEmpty()
        if (version.isEmpty()) return ManifestRead(null, "缺少 version")
        if (version.length > MAX_FIELD_LENGTH) return ManifestRead(null, "version 过长")
        val client = members.string("client")?.takeIf { it.isNotBlank() }
        val main = members.string("main")?.takeIf { it.isNotBlank() }
        val error = when {
            client == null && main == null ->
                "清单既没有 client（渲染端）也没有 main（Node）入口，装上了也不会运行"
            // v1 runs renderer clients only (PLAN §8), so a main-only mod is listed but never claimed
            // as working — the market page can show this instead of letting the user wonder.
            client == null ->
                "只有 main（Node）入口；本版不执行 main，因此不会产生任何效果"
            !isSafeRelativePath(client) ->
                "client 入口必须是模组目录内的相对路径（当前是 $client）"
            !CLIENT_PATTERN.containsMatchIn(client) ->
                "client 入口必须是 .mjs/.js 文件（当前是 $client）"
            else -> ""
        }
        return ManifestRead(
            Manifest(
                id = id,
                name = members.string("name")?.trim()?.takeIf { it.isNotEmpty() }?.take(MAX_FIELD_LENGTH) ?: id,
                version = version,
                author = members.string("author")?.trim()?.takeIf { it.isNotEmpty() }?.take(MAX_FIELD_LENGTH),
                description = members.string("description")?.trim()?.takeIf { it.isNotEmpty() }
                    ?.take(MAX_DESCRIPTION_LENGTH),
                permissions = stringArray(members["permissions"]).orEmpty()
                    .filter { it.isNotBlank() }
                    .take(MAX_LIST_ITEMS),
                client = client,
                preview = members.string("preview")?.takeIf { it.isNotBlank() },
            ),
            error,
        )
    }

    companion object {

        /** `<pluginPath>/mods`, created on demand. */
        internal fun modsRoot(pluginPath: File): File =
            File(pluginPath, MODS_DIR).also { runCatching { it.mkdirs() } }

        /**
         * Upstream's rule, copied (`electron/modSystem/discovery.cjs:35-57`): `mod.json` in the entry
         * itself, or in **exactly one** non-dot subfolder; anything else falls back to the entry, which
         * then reports the missing manifest. `internal` so a JVM test pins it: getting it wrong means
         * "installed but invisible".
         */
        internal fun resolveModRoot(entry: File): File {
            if (File(entry, MANIFEST).isFile) return entry
            val children = runCatching { entry.listFiles() }.getOrNull() ?: return entry
            val candidates = children.filter { child ->
                child.isDirectory && !child.name.startsWith(".") && File(child, MANIFEST).isFile
            }
            return if (candidates.size == 1) candidates[0] else entry
        }

        /**
         * The `mods` array as **one line** of JSON, ready to embed as `{"t":"mods","mods":$json}`.
         *
         * Hand-built on purpose: the protocol is line oriented on both ends, so a pretty printer that
         * puts a newline between members would split one message into several invalid ones and the
         * whole list would be dropped with no error at all (`docs/lessons.md` §3). Every string goes
         * through [Json.esc], so a mod name containing a quote or a backslash cannot break the line.
         */
        internal fun toJson(mods: List<InstalledMod>): String = buildString {
            append('[')
            mods.forEachIndexed { index, mod ->
                if (index > 0) append(',')
                append("{\"id\":").append(Json.str(mod.id))
                append(",\"name\":").append(Json.str(mod.name))
                append(",\"version\":").append(Json.str(mod.version))
                append(",\"author\":").append(Json.str(mod.author))
                append(",\"description\":").append(Json.str(mod.description))
                append(",\"permissions\":[")
                mod.permissions.forEachIndexed { position, permission ->
                    if (position > 0) append(',')
                    append(Json.str(permission))
                }
                append(']')
                append(",\"enabled\":").append(Json.bool(mod.enabled))
                append(",\"clientEntry\":").append(Json.str(mod.clientEntry))
                append(",\"previewEntry\":").append(Json.str(mod.previewEntry))
                append(",\"error\":").append(Json.str(mod.error))
                append('}')
            }
            append(']')
        }

        /**
         * Sets the root-level `mods` member of the settings tree to [modsJson].
         *
         * The island reads the list from the settings tree (it has no direct channel from the plugin).
         * Exactly like `systemFonts`, the member is derived data the page must never persist, so
         * `FoliaPlugin.stripInjectedMembers` removes it again from the page's echo — a persisted copy
         * would be a second writer for one fact.
         *
         * Text surgery, not re-serialisation: an existing member is replaced in place, a missing one is
         * appended before the closing brace, and every other byte of the tree survives. Non-object
         * input comes back unchanged, so a malformed tree is never made worse.
         */
        internal fun withModsMember(tree: String, modsJson: String): String {
            val trimmed = tree.trim()
            if (trimmed.length < 2 || trimmed[0] != '{' || trimmed[trimmed.length - 1] != '}') return tree
            val without = Json.withoutMember(tree, MODS_MEMBER)
            val close = without.lastIndexOf('}')
            if (close < 0) return tree
            var last = close - 1
            while (last >= 0 && without[last].isWhitespace()) last--
            if (last < 0) return tree
            val separator = if (without[last] == '{') "" else ","
            return without.substring(0, last + 1) + separator + "\"" + MODS_MEMBER + "\":" + modsJson +
                without.substring(last + 1)
        }

        /** SHA-256 of [file] as lowercase hex, or null when it cannot be read. */
        internal fun sha256Of(file: File): String? = runCatching {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(COPY_BUFFER)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            digest.digest().joinToString("") { String.format(Locale.ROOT, "%02x", it) }
        }.getOrNull()

        /** A 64-hex digest in canonical lowercase form, or null when the caller gave something else. */
        internal fun normalizeSha256(raw: String): String? =
            raw.trim().lowercase(Locale.ROOT).takeIf { SHA256_PATTERN.matches(it) }

        /**
         * The **manual import** entry point's only two decisions, in one place so a JVM test can pin
         * them (`FoliaPlugin.onImportModZip` is a Swing callback and cannot be driven from a test).
         *
         * Returns [candidate] as a canonical [File] when it is an existing regular file whose name
         * ends in [ZIP_EXTENSION]; null otherwise. Null is the ordinary "nothing to do" answer: the
         * `JFileChooser` returns null on cancel and the extension filter is advisory (a user can type
         * any name into the file-name box, and the filter is not applied to typed names), so the
         * caller must not read "a File came back" as "a mod archive came back".
         *
         * What this deliberately does NOT do: check the digest. A hand-imported zip has no published
         * digest to compare against, so there is nothing to verify here and
         * `install(file, expectedSha256 = null)` is the right call — but that means **every other
         * guard inside [install] (traversal, entry count, total bytes, manifest) is the only thing
         * standing between a hostile archive and `mods/`**. They are not optional on this path.
         */
        internal fun importableArchive(candidate: File?): File? {
            if (candidate == null) return null
            val file = runCatching { candidate.canonicalFile }.getOrNull() ?: return null
            if (!file.isFile) return null
            if (!file.name.lowercase(Locale.ROOT).endsWith(ZIP_EXTENSION)) return null
            return file
        }

        /**
         * A relative path inside a mod directory: no traversal, no backslashes, no absolute path.
         *
         * The same rule as upstream `manifest.cjs:isSafeRelativePath`, and it guards two different
         * things: the value appended to `/__mods/<id>/` for the page, and every zip entry we extract.
         */
        internal fun isSafeRelativePath(value: String): Boolean {
            val text = value.trim()
            return text.isNotEmpty() &&
                !text.contains("..") &&
                !text.contains('\\') &&
                !text.startsWith("/") &&
                !WINDOWS_ABSOLUTE_PATTERN.containsMatchIn(text)
        }

        /**
         * Parses a JSON array of strings (`["a","b"]`) without a JSON library. Null when [raw] is not
         * an array at all, so callers can tell "absent" from "empty".
         *
         * Each literal is handed back to [Json.stringField] for decoding, so there is exactly one
         * escape table in this codebase.
         */
        internal fun stringArray(raw: String?): List<String>? {
            if (raw == null) return null
            val text = raw.trim()
            if (text.length < 2 || text[0] != '[' || text[text.length - 1] != ']') return null
            val values = ArrayList<String>()
            var index = 1
            while (index < text.length - 1) {
                if (text[index] != '"') {
                    index++
                    continue
                }
                val end = endOfString(text, index)
                if (end < 0) break
                Json.stringField("{\"v\":" + text.substring(index, end) + "}", "v")?.let { values.add(it) }
                index = end
            }
            return values
        }

        /**
         * The root object's members as `key -> raw JSON value text`, or null when [text] is not an
         * object. Nested objects and arrays are kept whole as one raw value, and string content is
         * skipped, so a nested `"id"` can never be mistaken for the manifest's own.
         */
        internal fun rootMembers(text: String): Map<String, String>? {
            var index = 0
            while (index < text.length && text[index].isWhitespace()) index++
            if (index >= text.length || text[index] != '{') return null
            index++
            val members = LinkedHashMap<String, String>()
            while (index < text.length) {
                while (index < text.length && text[index].isWhitespace()) index++
                if (index >= text.length) return null
                when (text[index]) {
                    '}' -> return members
                    ',' -> {
                        index++
                        continue
                    }
                    '"' -> Unit
                    else -> return null
                }
                val keyEnd = endOfString(text, index)
                if (keyEnd < 0) return null
                val key = Json.stringField("{\"k\":" + text.substring(index, keyEnd) + "}", "k") ?: return null
                index = keyEnd
                while (index < text.length && text[index].isWhitespace()) index++
                if (index >= text.length || text[index] != ':') return null
                index++
                while (index < text.length && text[index].isWhitespace()) index++
                val valueEnd = endOfValue(text, index)
                if (valueEnd < 0) return null
                members[key] = text.substring(index, valueEnd)
                index = valueEnd
            }
            return null
        }

        /** Index just past the string literal starting at [start] (a quote); -1 when unterminated. */
        private fun endOfString(text: String, start: Int): Int {
            var index = start + 1
            var escaped = false
            while (index < text.length) {
                val char = text[index]
                if (escaped) {
                    escaped = false
                } else if (char == '\\') {
                    escaped = true
                } else if (char == '"') {
                    return index + 1
                }
                index++
            }
            return -1
        }

        /** Index just past the JSON value starting at [start]; -1 when the text is truncated. */
        private fun endOfValue(text: String, start: Int): Int {
            if (start >= text.length) return -1
            return when (text[start]) {
                '"' -> endOfString(text, start)
                '{', '[' -> {
                    var depth = 0
                    var index = start
                    var result = -1
                    while (index < text.length) {
                        when (text[index]) {
                            '"' -> {
                                index = endOfString(text, index)
                                if (index < 0) return -1
                                continue
                            }
                            '{', '[' -> depth++
                            '}', ']' -> {
                                depth--
                                if (depth == 0) {
                                    result = index + 1
                                    break
                                }
                            }
                        }
                        index++
                    }
                    result
                }
                else -> {
                    var index = start
                    while (index < text.length) {
                        val char = text[index]
                        if (char == ',' || char == '}' || char == ']' || char.isWhitespace()) break
                        index++
                    }
                    index
                }
            }
        }

        /** Recursively deletes [dir]; failures are swallowed (a leftover `.trash-*` is harmless). */
        internal fun deleteRecursively(dir: File) {
            runCatching {
                if (dir.isDirectory) dir.listFiles()?.forEach { deleteRecursively(it) }
                dir.delete()
            }
        }

        /** `<pluginPath>/mods` — user data, not part of the `.spmod` (same home as `spw-folia.log`). */
        internal const val MODS_DIR = "mods"

        /** Enable/disable state file inside the mod directory. */
        internal const val STATE_FILE = "mod-system.json"

        /** The manifest name upstream uses; also what marks a directory as a mod root. */
        internal const val MANIFEST = "mod.json"

        /** Root-level settings-tree member the settings island reads (derived data, stripped on echo). */
        internal const val MODS_MEMBER = "mods"

        /** Same id rule as upstream `manifest.cjs` (lowercase, digits, hyphen). */
        internal const val MOD_ID_PATTERN_TEXT = "^[a-z0-9][a-z0-9-]*$"
        internal val MOD_ID_PATTERN = Regex(MOD_ID_PATTERN_TEXT)
        internal const val MAX_ID_LENGTH = 64
        internal const val MAX_FIELD_LENGTH = 64
        internal const val MAX_DESCRIPTION_LENGTH = 512
        internal const val MAX_LIST_ITEMS = 32

        /** Zip guards: real mods are a few hundred KB, so these only ever stop a zip bomb. */
        internal const val MAX_ENTRIES = 512
        internal const val MAX_ENTRY_BYTES = 16L * 1024 * 1024
        internal const val MAX_TOTAL_BYTES = 64L * 1024 * 1024

        /** The only archive type the 配置 page's 导入模组 accepts (matched case-insensitively). */
        internal const val ZIP_EXTENSION = ".zip"

        private val CLIENT_PATTERN = Regex("\\.m?js$", RegexOption.IGNORE_CASE)
        private const val MACOSX_PREFIX = "__MACOSX"
        private const val COPY_BUFFER = 64 * 1024
        private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
        private val WINDOWS_ABSOLUTE_PATTERN = Regex("^[a-zA-Z]:")
    }
}

/**
 * Downloads a mod archive **in the plugin**, because the page cannot (issue #23).
 *
 * The market's archive endpoint answers without `Access-Control-Allow-Origin`, so a WebView2 page
 * gets those bytes only as an opaque failure; the plugin has a socket and a filesystem, so the
 * download has to live here (`.scratch/issue23/repo-report.md` §7.2).
 *
 * ## Why the URL is re-checked on every hop
 *
 * The URL arrives from the page, and the page is the least trusted end of this chain (it renders
 * third-party mod content). Handing an arbitrary URL to `URL.openStream()` would be a
 * server-side-request-forgery primitive: `http://localhost:…`, `file:`, an internal host, a redirect
 * to somewhere else. So: https only, host must be in [ALLOWED_HOSTS], no userinfo, default port — and
 * redirects are followed **by hand**, because `instanceFollowRedirects` would follow a hop that this
 * rule never saw.
 *
 * Size and time are bounded for the same reason: a hostile or broken server must not be able to fill
 * the user's disk or wedge the mod thread.
 */
internal object FoliaModDownloads {

    /** The only host the plugin will download a mod from (the market the catalog points at). */
    internal val ALLOWED_HOSTS = setOf("folium-compound.cielaniska.top")

    /** 32 MB. The largest real mod in the market is ~200 KB, so this only ever stops an accident. */
    internal const val MAX_BYTES = 32L * 1024 * 1024

    /** 60 s for the whole action (connect + body + redirects), the user-visible budget. */
    internal const val DEADLINE_MS = 60_000L

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000
    private const val MAX_REDIRECTS = 3
    private const val COPY_BUFFER = 64 * 1024
    private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)

    /**
     * Whether [raw] is an address this plugin is willing to fetch: **https**, a host from
     * [allowedHosts], no credentials embedded, no explicit non-443 port.
     *
     * `internal` (not private) so the SSRF rule is pinned by a test instead of being re-derived by the
     * next person who touches the install action. There is deliberately **no** seam to relax the
     * scheme: a test that passed `http` would be proving a rule production does not have.
     */
    internal fun isAllowedUrl(raw: String?, allowedHosts: Set<String> = ALLOWED_HOSTS): Boolean {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return false
        val uri = runCatching { URI(text) }.getOrNull() ?: return false
        if (!uri.isAbsolute) return false
        if (!"https".equals(uri.scheme, ignoreCase = true)) return false
        if (uri.userInfo != null) return false
        if (uri.port != -1 && uri.port != 443) return false
        val host = uri.host?.lowercase(Locale.ROOT) ?: return false
        if (host.isEmpty()) return false
        return allowedHosts.any { it.equals(host, ignoreCase = true) }
    }

    /**
     * Fetches [raw] into a fresh temp file **outside the mod directory** and returns it.
     *
     * The caller owns the returned file and must delete it; on failure nothing is left behind.
     */
    internal fun fetch(
        raw: String,
        allowedHosts: Set<String> = ALLOWED_HOSTS,
        maxBytes: Long = MAX_BYTES,
        deadlineMs: Long = DEADLINE_MS,
        log: (String) -> Unit = {},
    ): Result<File> {
        // Refuse before touching the filesystem: a rejected address must leave nothing behind, not
        // even the temp file that would have held the bytes.
        val first = raw.trim()
        if (!isAllowedUrl(first, allowedHosts)) {
            return Result.failure(IOException(refusalMessage(first, allowedHosts)))
        }
        val deadline = System.currentTimeMillis() + deadlineMs
        val temp = try {
            Files.createTempFile("spw-folia-mod-", ".zip").toFile()
        } catch (t: Throwable) {
            return Result.failure(IOException("无法创建临时文件：${t.message}"))
        }
        var current = first
        var hop = 0
        try {
            while (true) {
                if (!isAllowedUrl(current, allowedHosts)) {
                    throw IOException(refusalMessage(current, allowedHosts))
                }
                val connection = checkedUrl(current).openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = CONNECT_TIMEOUT_MS
                    connection.readTimeout = READ_TIMEOUT_MS
                    // Followed by hand so every hop goes through isAllowedUrl again.
                    connection.instanceFollowRedirects = false
                    connection.requestMethod = "GET"
                    connection.setRequestProperty("User-Agent", "spw-folia-mod-loader")
                    connection.setRequestProperty("Accept", "application/zip,application/octet-stream,*/*")
                    val status = connection.responseCode
                    if (status == HttpURLConnection.HTTP_OK) {
                        val declared = connection.contentLengthLong
                        if (declared > maxBytes) throw IOException("模组包过大：$declared 字节（上限 $maxBytes）")
                        connection.inputStream.use { input ->
                            val written = copyLimited(input, temp, deadline, maxBytes)
                            if (written == 0L) throw IOException("下载内容为空")
                            log("mods: downloaded ${temp.length()} bytes from $current")
                        }
                        return Result.success(temp)
                    }
                    if (REDIRECT_CODES.contains(status)) {
                        val location = connection.getHeaderField("Location")
                            ?: throw IOException("重定向缺少 Location（HTTP $status）")
                        if (hop++ >= MAX_REDIRECTS) throw IOException("重定向次数过多（上限 $MAX_REDIRECTS）")
                        current = resolveRedirect(current, location)
                        log("mods: download redirect $status -> $current")
                        continue
                    }
                    throw IOException("下载失败：HTTP $status")
                } finally {
                    runCatching { connection.disconnect() }
                }
            }
        } catch (t: Throwable) {
            runCatching { temp.delete() }
            return Result.failure(t)
        }
    }

    private fun refusalMessage(url: String, allowedHosts: Set<String>): String =
        "下载地址不在白名单（只允许 https://${allowedHosts.joinToString(",")}）：$url"

    /** [raw] as a [URL], via [URI] so the deprecated `URL(String)` constructor is never used. */
    private fun checkedUrl(raw: String): URL = URI(raw).toURL()

    /** Resolves a `Location: …` header against the request that produced it, rejecting the unusable. */
    private fun resolveRedirect(current: String, location: String): String =
        URI(current).resolve(location.trim()).toString()

    private fun copyLimited(input: InputStream, target: File, deadline: Long, maxBytes: Long): Long {
        var total = 0L
        FileOutputStream(target).use { out ->
            val buffer = ByteArray(COPY_BUFFER)
            while (true) {
                if (System.currentTimeMillis() > deadline) {
                    // Report the budget, not a constant: the deadline also covers redirects, so the
                    // remaining time here can be less than the configured total.
                    throw IOException("下载超时（超出本次动作的时间预算）")
                }
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > maxBytes) throw IOException("模组包过大：已超过 $maxBytes 字节")
                out.write(buffer, 0, read)
            }
        }
        return total
    }
}
