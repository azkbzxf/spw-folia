package dev.spw.folia

import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * v0.4.7 「出现问题」自检 — the **evidence layer**.
 *
 * Every fact the self-check reasons about is captured here as an [Evidence] record: the value that
 * was read, **where it came from**, the raw text the source produced, and — when a read failed —
 * why. The judgement layer ([FoliaDiagnostics]) never invents a value: it either has evidence or it
 * reports the check as *unknown*, which is a different outcome from *missing*.
 *
 * ## Why this file exists (the v0.4.2–0.4.6 bug)
 *
 * The previous self-check read `System.getProperty("os.version")` and parsed it with
 * `Regex("(\\d+)\\.(\\d+)\\.(\\d+)")`. On every modern HotSpot JVM on Windows that property is the
 * two-component string `"10.0"` — the build number lives in the registry / `GetVersionEx`, not in
 * the system property. The regex therefore never matched, `parseWindowsBuild` returned null, and
 * `osCheck` reported 「缺少运行环境：Windows 10 x64（1809+）… build=null」 on **every** machine,
 * including Windows 11 build 26300. A check that can never pass is not a check.
 *
 * The same class of mistake appeared elsewhere: the .NET `Release` value could be reported as
 * missing when `reg.exe` merely printed its message in the OEM code page, and a probe that threw
 * was indistinguishable from a dependency that was absent.
 *
 * ## Rules this file follows
 *
 * 1. **No probe throws.** Each one is wrapped; a throwing probe becomes a failed [Evidence] that
 *    carries the exception, so the UI can say 「读不到」 instead of 「没有」.
 * 2. **No probe needs admin.** Verified: every registry/file probe below succeeds under a plain
 *    restricted user token; nothing here touches SAM/SECURITY or writes outside the plugin dir.
 * 3. **English output, OEM-safe.** `reg.exe` writes its errors in the OEM code page (CP936 here),
 *    so its stderr is **never** parsed or shown; only the value line is used, and success is
 *    decided by the exit code plus a present value.
 * 4. **Bounded.** Every child process is waited on with a short timeout and destroyed afterwards;
 *    the diagnostics button must not be able to hang SPW.
 */
internal object FoliaEnvironmentProbe {

    // ------------------------------------------------------------------ evidence model ----

    /** Where a value came from, so a report can be argued with instead of just believed. */
    enum class Source(val label: String) {
        SYSTEM_PROPERTY("system property"),
        REGISTRY("registry"),
        CHILD_PROCESS("child process"),
        FILE_SYSTEM("file system"),
        RUNTIME_API("runtime API"),
        ENVIRONMENT("environment variable"),
        UNAVAILABLE("unavailable"),
    }

    /**
     * One measured fact.
     *
     * @property value the parsed value, or null when it could not be established.
     * @property raw exactly what the source said (trimmed, bounded), kept for the issue report.
     * @property error why the read failed, null when it succeeded. A null [value] with a null
     *   [error] means "the source is valid but does not contain this fact" (e.g. a registry key
     *   with no `Release` value) — still *unknown*, never *missing*.
     */
    data class Evidence(
        val value: String?,
        val source: Source,
        val raw: String = "",
        val error: String? = null,
    ) {
        val present: Boolean get() = !value.isNullOrBlank()

        /** Human-readable provenance for the issue body, e.g. `registry HKLM\…\Full : Release=534296`. */
        fun describe(): String = buildString {
            append(source.label)
            if (raw.isNotBlank()) append(" [").append(raw.abbreviate(160)).append(']')
            if (error != null) append(" error=").append(error)
        }

        companion object {
            fun missing(source: Source, error: String? = null, raw: String = "") =
                Evidence(value = null, source = source, raw = raw, error = error)
        }
    }

    // ---------------------------------------------------------------------- constants ----

    /** `docs/runtime-requirements.md` H1: Windows 10 x64 1809 = build 17763. */
    const val MIN_WINDOWS_BUILD = 17763

    /** .NET Framework 4.8 `Release` floor; 4.8.1 builds are 533320 / 533325 / 533509. */
    const val DOTNET_48_RELEASE = 528040

    /** WebView2 Evergreen GA floor: `CoreWebView2` instantiation needs >= 86. */
    const val WEBVIEW2_MIN_MAJOR = 86

    private const val CURRENT_VERSION_KEY = """HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion"""
    private const val DOTNET_FULL_KEY = """HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full"""

    /**
     * WebView2 Evergreen Runtime client keys. The WOW6432Node one is authoritative for the x64
     * installer and is the only one present on the reference machine; the other two cover
     * per-machine 64-bit installs and per-user installs.
     */
    private val WEBVIEW2_CLIENT_KEYS = listOf(
        """HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}""",
        """HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}""",
        """HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}""",
    )

    private const val REG_TIMEOUT_SECONDS = 3L

    // ------------------------------------------------------------------------ Windows ----

    /** Everything the OS check needs, all three components measured independently. */
    data class WindowsInfo(
        /** `os.name`, e.g. `Windows 11`. Cosmetic only — never used for the version verdict. */
        val osName: Evidence,
        /** Build number from the registry (`CurrentBuildNumber`). The authoritative value. */
        val registryBuild: Evidence,
        /** Build as reported by the JVM's `os.version` — usually absent, see the class docs. */
        val propertyBuild: Evidence,
        /** `UBR`: the revision after the dash in `10.0.26300.9711`. Cosmetic. */
        val ubr: Evidence,
        /** `DisplayVersion`, e.g. `26H2` / `23H2`. Cosmetic. */
        val displayVersion: Evidence,
        /** `ProductName`. Note: Windows 11 still reports 「Windows 10 …」 here. Cosmetic. */
        val productName: Evidence,
        /** `os.arch`, e.g. `amd64`. */
        val arch: Evidence,
        /** `sun.arch.data.model` = 64 when this JVM is 64-bit. */
        val archDataModel: Evidence,
    ) {
        /**
         * The build number to judge on: registry first (authoritative), JVM property as a fallback
         * for the unlikely case that the registry read is blocked. Null only when **both** are
         * unavailable — and that must surface as *unknown*, never as a failure.
         */
        val build: Int?
            get() = registryBuild.value?.toIntOrNull() ?: propertyBuild.value?.toIntOrNull()

        /** [ubr] as a decimal number: `reg.exe` prints a REG_DWORD as hex (`0x25ef` = 9711). */
        val ubrNumber: Int?
            get() {
                val raw = ubr.value ?: return null
                return parseRegNumber(raw)
            }

        val buildEvidence: Evidence
            get() = if (registryBuild.present) registryBuild else propertyBuild

        /** 64-bit OS. `amd64`/`x86_64`/`arm64` are 64-bit; `x86`/`i386` are not. */
        val isOs64: Boolean
            get() {
                val model = archDataModel.value
                if (model != null) return model == "64"
                val a = arch.value?.lowercase(Locale.ROOT) ?: return false
                return a.contains("64")
            }

        /** Human-readable identity, e.g. `Windows 11 (26H2, build 26300.9711, amd64)`. */
        fun describe(): String = buildString {
            append(osName.value ?: "Windows")
            val dv = displayVersion.value
            val b = build
            if (dv != null || b != null) {
                append(" (")
                if (dv != null) append(dv).append(", ")
                if (b != null) {
                    append("build ").append(b)
                    ubrNumber?.let { append('.').append(it) }
                }
                append(')')
            } else {
                append(" (build 未知)")
            }
            arch.value?.let { append(", ").append(it) }
        }
    }

    fun windows(): WindowsInfo {
        val osName = systemProperty("os.name")
        val version = systemProperty("os.version")
        val arch = systemProperty("os.arch")
        val model = systemProperty("sun.arch.data.model")

        // The registry key is read in one shot: three separate reg.exe calls for build / UBR /
        // DisplayVersion would triple the latency of a button the user is waiting on.
        val key = regKey(CURRENT_VERSION_KEY)
        return WindowsInfo(
            osName = osName,
            registryBuild = key.value(CURRENT_VERSION_KEY, "CurrentBuildNumber")
                .takeIf { it.present } ?: key.value(CURRENT_VERSION_KEY, "CurrentBuild"),
            propertyBuild = buildFromVersionProperty(version),
            ubr = key.value(CURRENT_VERSION_KEY, "UBR"),
            displayVersion = key.value(CURRENT_VERSION_KEY, "DisplayVersion"),
            productName = key.value(CURRENT_VERSION_KEY, "ProductName"),
            arch = arch,
            archDataModel = model,
        )
    }

    private fun systemProperty(name: String): Evidence {
        val value = runCatching { System.getProperty(name) }.getOrNull()
        return Evidence(
            value = value?.takeIf { it.isNotBlank() },
            source = Source.SYSTEM_PROPERTY,
            raw = "$name=$value",
        )
    }

    /**
     * Pulls a build number out of a `os.version`-shaped string.
     *
     * HotSpot on Windows reports `"10.0"` (no build), so this normally yields null — which is the
     * point of separating it from [WindowsInfo.registryBuild]. A three- or four-component string
     * (`10.0.26300` / `10.0.26300.9711`) is honoured when some JVM/vendor does provide one.
     */
    fun buildFromVersionProperty(evidence: Evidence): Evidence {
        val text = evidence.value ?: return Evidence.missing(
            Source.SYSTEM_PROPERTY,
            error = evidence.error ?: "os.version 不含构建号",
            raw = evidence.raw,
        )
        val parts = text.split('.', '-', '_', ' ').filter { it.isNotBlank() }
        val build = parts.getOrNull(2)?.takeWhile { it.isDigit() }?.takeIf { it.isNotEmpty() }
        return if (build != null) {
            Evidence(build, Source.SYSTEM_PROPERTY, raw = evidence.raw)
        } else {
            Evidence.missing(
                Source.SYSTEM_PROPERTY,
                error = "os.version=\"$text\" 只有主次版本号，没有构建号（HotSpot 在 Windows 上的正常行为）",
                raw = evidence.raw,
            )
        }
    }

    // ------------------------------------------------------------------------- WebView2 ----

    /**
     * WebView2 Runtime version (`pv`) plus the on-disk fallback.
     *
     * The registry is authoritative; the `Application\<version>\msedgewebview2.exe` layout is only
     * consulted when no key answers, because a hand-copied or partially uninstalled runtime can
     * leave files behind. Both paths are recorded so the report shows which one was used.
     */
    data class WebView2Info(
        val pv: Evidence,
        val registryKey: String?,
        val installedDirVersion: Evidence,
    ) {
        val effective: Evidence
            get() = if (pv.present) pv else installedDirVersion

        /** Major version, or null when it could not be read at all (→ unknown, never missing). */
        val major: Int?
            get() = effective.value?.substringBefore('.')?.trim()?.toIntOrNull()

        val version: String? get() = effective.value
    }

    private val WEBVIEW2_APPLICATION_DIRS = listOf(
        """C:\Program Files (x86)\Microsoft\EdgeWebView\Application""",
        """C:\Program Files\Microsoft\EdgeWebView\Application""",
    )

    fun webView2(): WebView2Info {
        var firstFailure: Evidence? = null
        for (key in WEBVIEW2_CLIENT_KEYS) {
            val ev = regValue(key, "pv")
            // A value of 0.0.0.0 is what EdgeUpdate writes for "installed but not ready"; treat it
            // as present evidence (the caller decides) instead of silently skipping the key.
            if (ev.present) return WebView2Info(ev, key, Evidence.missing(Source.FILE_SYSTEM))
            if (firstFailure == null) firstFailure = ev
        }
        val dir = installedRuntimeVersion()
        return WebView2Info(
            pv = firstFailure ?: Evidence.missing(Source.REGISTRY, error = "三个 EdgeUpdate 客户端键都不存在"),
            registryKey = null,
            installedDirVersion = dir,
        )
    }

    /** Highest `Application\<version>\msedgewebview2.exe` under the known install roots. */
    private fun installedRuntimeVersion(): Evidence {
        val found = mutableListOf<Pair<String, String>>()
        WEBVIEW2_APPLICATION_DIRS.forEach { root ->
            val dir = File(root)
            val children = runCatching { dir.listFiles() }.getOrNull() ?: return@forEach
            children.forEach { child ->
                if (!child.isDirectory) return@forEach
                val version = child.name
                if (!version.firstOrNull()?.isDigit().let { it == true }) return@forEach
                if (File(child, "msedgewebview2.exe").isFile) found += version to child.absolutePath
            }
        }
        if (found.isEmpty()) {
            return Evidence.missing(
                Source.FILE_SYSTEM,
                error = "注册表无 pv，且 ${WEBVIEW2_APPLICATION_DIRS.joinToString(" / ")} 下没有 msedgewebview2.exe",
            )
        }
        val best = found.maxByOrNull { versionKey(it.first) }!!
        return Evidence(best.first, Source.FILE_SYSTEM, raw = best.second)
    }

    /** Sorts `150.0.4078.83` numerically instead of lexically. */
    private fun versionKey(version: String): Long {
        val parts = version.split('.').mapNotNull { it.trim().toIntOrNull() }
        var key = 0L
        repeat(4) { i -> key = key * 1000 + (parts.getOrNull(i) ?: 0).coerceIn(0, 999) }
        return key
    }

    // ----------------------------------------------------------------------------- .NET ----

    /**
     * .NET Framework 4.x `Release` from the registry, decoded from the four supported value types.
     *
     * `reg.exe query` prints a `REG_DWORD` as hex (`0x82718`) while a `REG_SZ` stays decimal, so the
     * decode has to look at the type token, not guess from the text. The previous implementation
     * stripped a `0x` prefix and re-parsed as hex unconditionally, which silently turned a decimal
     * `528040` into the meaningless `0x528040`.
     */
    fun dotnet(): Evidence = regValue(DOTNET_FULL_KEY, "Release", decode = ::decodeDotnetRelease)

    /** Interprets the `(type, value)` pair of the `Release` line; returns null when unparsable. */
    fun decodeDotnetRelease(type: String, raw: String): Int? {
        val text = raw.trim().trim('"').trim()
        if (text.isEmpty()) return null
        return when {
            type.endsWith("_DWORD", ignoreCase = true) -> text.toIntOrNull() ?: text.parseHex()
            type.endsWith("_QWORD", ignoreCase = true) -> text.toLongOrNull()?.toInt() ?: text.parseHex()
            else -> text.toIntOrNull() ?: text.parseHex()
        }
    }

    private fun String.parseHex(): Int? {
        val body = if (startsWith("0x", ignoreCase = true)) substring(2) else this
        return body.toLongOrNull(16)?.toInt()
    }

    /**
     * Decodes a `reg.exe`-printed number without knowing its type: `0x…` is hex, otherwise decimal.
     *
     * `reg query` prints `REG_DWORD` as `0x25ef` but `REG_SZ` as plain digits, and a report that
     * shows `build 26300.0x25ef` instead of `26300.9711` is the kind of unreadable detail that makes
     * a diagnostic tool look broken even when its verdicts are right.
     */
    fun parseRegNumber(raw: String): Int? {
        val text = raw.trim().trim('"')
        if (text.isEmpty()) return null
        return if (text.startsWith("0x", ignoreCase = true)) text.parseHex() else text.toIntOrNull()
    }

    // --------------------------------------------------------------------------- generic ----

    /** A whole registry key read in one `reg.exe query`, kept as raw lines for later value lookup. */
    class RegistryDump(
        val key: String,
        val lines: List<String>,
        val evidence: Evidence,
    ) {
        /** `null` when the dump itself failed — the caller must report *unknown*, not *missing*. */
        fun value(key: String, name: String): Evidence {
            if (evidence.error != null) {
                return Evidence.missing(Source.REGISTRY, error = evidence.error, raw = evidence.raw)
            }
            val line = lines.firstOrNull { lineStartsWithValue(it, name) }
                ?: return Evidence.missing(
                    Source.REGISTRY,
                    error = "$key 没有值 \"$name\"",
                    raw = evidence.raw,
                )
            val fields = line.trim().split(Regex("\\s{2,}"))
            if (fields.size < 2) {
                return Evidence.missing(
                    Source.REGISTRY,
                    error = "无法解析 reg.exe 输出行",
                    raw = line.trim().abbreviate(160),
                )
            }
            // REG_SZ / REG_DWORD / REG_QWORD ...: the value is everything after the type token.
            val type = fields.getOrNull(1).orEmpty()
            val value = fields.drop(2).joinToString("  ").trim()
            return Evidence(value, Source.REGISTRY, raw = line.trim())
        }

        companion object {
            /**
             * Matches `    Release    REG_DWORD    0x82718` but not `    ReleaseSomething    …`.
             *
             * `reg.exe` separates the name from the type with runs of spaces, so a plain
             * `contains(name)` (what v0.4.2 used) could match a *different* value whose name merely
             * starts with the same letters. The name has to be the first whitespace-delimited token.
             */
            fun lineStartsWithValue(line: String, name: String): Boolean {
                val trimmed = line.trimStart()
                if (!trimmed.startsWith(name)) return false
                val rest = trimmed.substring(name.length)
                return rest.isEmpty() || rest.first().isWhitespace()
            }
        }
    }

    /** Reads a whole key once. Never throws; a failure is carried inside the evidence. */
    fun regKey(key: String): RegistryDump {
        val result = runReg(listOf("query", key))
        if (result.exitCode != 0) {
            return RegistryDump(
                key = key,
                lines = emptyList(),
                evidence = Evidence.missing(
                    Source.REGISTRY,
                    error = "reg query $key 退出码 ${result.exitCode}",
                    raw = result.stdout.abbreviate(160),
                ),
            )
        }
        return RegistryDump(
            key = key,
            lines = result.stdout.lines(),
            evidence = Evidence(key, Source.REGISTRY, raw = "reg query $key 退出码 0"),
        )
    }

    /**
     * Reads one value with `reg.exe query <key> /v <name>`.
     *
     * [decode] lets a caller reinterpret `(type, rawValue)`; without it the raw text is returned as
     * printed (hex for dwords), which is what a report wants to show verbatim.
     */
    fun regValue(
        key: String,
        name: String,
        decode: ((String, String) -> Int?)? = null,
    ): Evidence {
        val result = runReg(listOf("query", key, "/v", name))
        if (result.exitCode != 0) {
            return Evidence.missing(
                Source.REGISTRY,
                error = "reg query $key /v $name 退出码 ${result.exitCode}",
                raw = result.stdout.abbreviate(120),
            )
        }
        val line = result.stdout.lines().firstOrNull { RegistryDump.lineStartsWithValue(it, name) }
            ?: return Evidence.missing(
                Source.REGISTRY,
                error = "$key 没有值 \"$name\"",
                raw = result.stdout.abbreviate(120),
            )
        val fields = line.trim().split(Regex("\\s{2,}"))
        val type = fields.getOrNull(1).orEmpty()
        val rawValue = fields.drop(2).joinToString("  ").trim()
        if (rawValue.isEmpty()) {
            return Evidence.missing(
                Source.REGISTRY,
                error = "$key\\$name 是空值",
                raw = line.trim(),
            )
        }
        if (decode == null) {
            return Evidence(rawValue, Source.REGISTRY, raw = line.trim())
        }
        val decoded = runCatching { decode(type, rawValue) }.getOrNull()
            ?: return Evidence.missing(
                Source.REGISTRY,
                error = "无法把 \"$rawValue\"（$type）解析为数字",
                raw = line.trim(),
            )
        return Evidence(decoded.toString(), Source.REGISTRY, raw = line.trim())
    }

    private data class RegResult(val exitCode: Int, val stdout: String)

    /**
     * Runs `reg.exe` with a hard bound.
     *
     * stderr is redirected into stdout only so it cannot fill a pipe and deadlock; its content is
     * **not** used for decisions. That matters: `reg.exe` writes its error text in the OEM code
     * page (CP936 on this machine) while the JVM decodes UTF-8, so it arrives as `????: …` and any
     * logic keyed on it would be guesswork. The exit code is the contract.
     */
    private fun runReg(args: List<String>): RegResult {
        var process: Process? = null
        return try {
            process = ProcessBuilder(listOf("reg.exe") + args)
                .redirectErrorStream(true)
                .start()
            // Drain before waiting: a full pipe buffer would block the child forever.
            val output = process.inputStream.bufferedReader().use { it.readText() }
            if (!process.waitFor(REG_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                RegResult(-1, output)
            } else {
                RegResult(process.exitValue(), output)
            }
        } catch (t: Throwable) {
            runCatching { process?.destroyForcibly() }
            RegResult(-1, "")
        } finally {
            runCatching { process?.destroyForcibly() }
        }
    }

    // ---------------------------------------------------------------------------- files ----

    /** Whether a directory is writable, measured by an actual probe file, with the reason on failure. */
    fun writable(dir: File): Evidence {
        val error = runCatching {
            dir.mkdirs()
            val probe = File(dir, ".spw-folia-write-probe")
            probe.writeText("ok")
            probe.delete()
            null
        }.getOrElse { t -> "${t::class.java.simpleName}: ${t.message}" }
        return if (error == null) {
            Evidence(dir.absolutePath, Source.FILE_SYSTEM, raw = dir.absolutePath)
        } else {
            Evidence.missing(Source.FILE_SYSTEM, error = error, raw = dir.absolutePath)
        }
    }

    /** A file that must exist, with its size when it does. */
    fun file(file: File): Evidence = if (file.isFile) {
        Evidence(file.absolutePath, Source.FILE_SYSTEM, raw = "${file.length()} B")
    } else {
        Evidence.missing(Source.FILE_SYSTEM, error = "文件不存在", raw = file.absolutePath)
    }

    /** The first directory under [base] that contains [relative]; each candidate is recorded. */
    fun firstDirContaining(base: File, candidates: List<String>, relative: String): Evidence {
        val tried = mutableListOf<String>()
        for (candidate in candidates) {
            val dir = File(base, candidate)
            tried += dir.absolutePath
            if (File(dir, relative).isFile) {
                return Evidence(dir.absolutePath, Source.FILE_SYSTEM, raw = "$candidate/$relative")
            }
        }
        return Evidence.missing(
            Source.FILE_SYSTEM,
            error = "候选目录里都没有 $relative",
            raw = tried.joinToString(" | "),
        )
    }

    // ------------------------------------------------------------------------- utilities ----

    /** Bounded single-line preview: keeps a long `reg.exe` dump or stack from wrecking the report. */
    internal fun String.abbreviate(max: Int): String {
        val oneLine = replace('\r', ' ').replace('\n', ' ').replace(Regex("\\s{2,}"), " ").trim()
        return if (oneLine.length <= max) oneLine else oneLine.take(max) + "…"
    }
}
