package dev.spw.folia

import com.xuncorp.spw.workshop.api.PluginPermission
import com.xuncorp.spw.workshop.api.WorkshopApi
import java.awt.Desktop
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * v0.4.7 「出现问题」自检 — the **judgement layer**.
 *
 * Two entry points feed this file: SPW's 模组管理 → 配置 → 支持与反馈 → 出现问题 button (declared in
 * `preference_config.json`, target [onReportProblem]) and the player page's 救生圈 panel, which asks
 * the *native host* for its half of the report (`ProblemReportPanel.tsx` → `HostForm.BuildEnvReport`).
 *
 * ## What changed vs v0.4.2–0.4.6, and why
 *
 * The old implementation produced the report in the screenshot: on a healthy Windows 11 build 26300
 * machine it announced 「缺少运行环境：Windows 10 x64（1809+）（Windows 11 10.0 amd64）→ 需要 64 位
 * Windows 10 1809 (17763) 或更新版本」. It was wrong **by construction**:
 *
 * | # | defect in the old code | consequence |
 * | --- | --- | --- |
 * | 1 | build parsed out of `System.getProperty("os.version")`, which is `"10.0"` on every modern HotSpot — the regex needs three components | the OS check could **never** pass on any machine |
 * | 2 | the OS verdict was `is64 && build != null && build >= 17763`, so "no build available" collapsed into "too old" | a read failure was reported as a missing dependency |
 * | 3 | `.NET Release` was parsed by stripping a `0x` prefix and reparsing as hex regardless of the value type | a decimal `REG_SZ`/`REG_DWORD` was silently corrupted into a bogus number |
 * | 4 | `reg.exe` failures were indistinguishable from absent values (a thrown probe returned null) | 「未安装」 was shown for anything unreadable |
 * | 5 | registry name matching used `line.contains(name)` | `Release` could match a longer value name |
 * | 6 | a thrown probe and a failed probe both produced `ok = false` | the diagnostic tool itself became a source of false alarms |
 * | 7 | 5 missing items produced 5 error toasts in a row, one of which could be a false positive | alarm fatigue; users learn to ignore it |
 *
 * The replacement rule, applied to every single check, is:
 *
 * > **Only evidence can produce a failure. Absence of evidence produces *unknown*, and *unknown* is
 * > reported as *unknown* — never as a missing dependency.**
 *
 * That is what [Verdict] encodes, and it is why [Check.evidence] is mandatory: the UI and the issue
 * body can always show *where* a verdict came from, so a wrong verdict is arguable instead of
 * unexplainable.
 */
internal object FoliaDiagnostics {

    // ------------------------------------------------------------------ result model ----

    /**
     * The four outcomes a check can have.
     *
     * [PASS] / [FAIL] require positive evidence. [UNKNOWN] means the check could not be decided —
     * it is explicitly **not** a failure and does not open the 「缺少运行环境」 summary.
     * [ADVISORY] is a soft dependency (`docs/runtime-requirements.md` S1–S8): worth saying, never
     * counted either way.
     */
    enum class Verdict(val label: String) {
        PASS("正常"),
        FAIL("缺失"),
        UNKNOWN("无法判定"),
        ADVISORY("提示"),
    }

    /**
     * One environment check.
     *
     * @property evidence where the value came from; mandatory, and rendered in the UI/issue body so
     *   the user (or a maintainer) can verify the verdict instead of trusting it.
     * @property fix the concrete action when — and only when — the verdict is [Verdict.FAIL].
     */
    data class Check(
        val id: String,
        val label: String,
        val verdict: Verdict,
        val detail: String,
        val evidence: String = "",
        val fix: String? = null,
    ) {
        val ok: Boolean get() = verdict == Verdict.PASS
        val failed: Boolean get() = verdict == Verdict.FAIL
        val unknown: Boolean get() = verdict == Verdict.UNKNOWN
    }

    /**
     * The complete self-check.
     *
     * [missing] and [unverified] are deliberately separate: the first is 「你去装东西」, the second is
     * 「这个工具读不到，但这不代表坏了」. Merging them is the bug this version fixes.
     */
    data class Report(
        val checks: List<Check>,
        val logFiles: List<File>,
        val logDir: File,
        val summary: String,
        val issueBody: String,
        val windowsLine: String,
        val pluginVersion: String,
        val spwVersion: String,
        val generatedAt: LocalDateTime,
    ) {
        val missing: List<Check> get() = checks.filter { it.verdict == Verdict.FAIL }
        val unverified: List<Check> get() = checks.filter { it.verdict == Verdict.UNKNOWN }
        val advisory: List<Check> get() = checks.filter { it.verdict == Verdict.ADVISORY }
        val healthy: Boolean get() = missing.isEmpty()

        /** One line for the log: what was decided, and what could not be decided. */
        fun logLine(): String = buildString {
            append("diagnostics: ")
            append(checks.count { it.verdict == Verdict.PASS }).append('/').append(checks.size)
            append(" pass")
            if (missing.isNotEmpty()) append(", missing=").append(missing.joinToString(",") { it.id })
            if (unverified.isNotEmpty()) append(", unknown=").append(unverified.joinToString(",") { it.id })
            if (missing.isEmpty() && unverified.isEmpty()) append(", environment ok")
        }
    }

    // -------------------------------------------------------------------- entry point ----

    private val NATIVE_FILES = listOf(
        "spw-folia-host.exe",
        "spw-folia-host.exe.config",
        "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.WinForms.dll",
        "WebView2Loader.dll",
    )

    /** `docs/runtime-requirements.md` H8: the permissions this plugin asks for. */
    private val REQUIRED_PERMISSIONS = listOf(
        PluginPermission.CLASS_TRANSFORM to "菜单入口需要；在插件权限页授予后重启 SPW",
        PluginPermission.LIBRARY_READ to "封面/歌词需要；未授予时歌词样式仍在、封面与歌词取不到",
        PluginPermission.KEY_BINDINGS to "透明背景快捷键需要；未授予时快捷键不注册，其余功能正常",
    )

    /** v0.4.11: the declaration ships inside the jar, so this is the installed copy. */
    private const val CONFIG_DECLARATION = "preference_config.json"

    /**
     * v0.4.11: every `switch` key the plugin actually reads, i.e. the other half of the contract that
     * [configContractCheck] compares the shipped declaration against.
     *
     * Keep this in step with the `readXxx` functions in [FoliaPlugin]; the check exists precisely so a
     * forgotten entry here fails loudly instead of silently ignoring a user's setting.
     */
    private val KNOWN_CONFIG_SWITCHES = setOf(
        "transitionAnimation",
        "showPlaybackBar",
        "showProblemButton",
        "verboseLog",
    )

    private const val ISSUE_FORM = "https://github.com/azkbzxf/spw-folia/issues/new"
    private const val LOG_TAIL_LINES = 60

    /** GitHub accepts long bodies in the query string, but browsers/OS clip very long URLs. */
    private const val MAX_BODY_CHARS = 6000

    /**
     * Runs the whole self-check and reports it.
     *
     * Never throws: a diagnostics button that crashes is worse than no button, and the caller is
     * SPW's config UI thread.
     */
    fun onReportProblem(
        pluginPath: File,
        spwVersion: String,
        pluginVersion: String,
        hostPid: Long = -1L,
    ) {
        val report = runCatching { inspect(pluginPath, spwVersion, pluginVersion, hostPid) }
            .getOrElse { t ->
                FoliaPlugin.logStatic("diagnostics failed: ${t::class.java.name}: ${t.message}")
                FoliaPlugin.toastStatic(
                    "环境自检自身出错：${t::class.java.simpleName}" +
                        (t.message?.let { "（${it.take(80)}）" } ?: "") + "，请把 spw-folia.log 发给作者",
                    WorkshopApi.Ui.ToastType.Error,
                )
                return
            }
        FoliaPlugin.logStatic(report.logLine())
        FoliaPlugin.logStatic("diagnostics: " + report.windowsLine)
        report.checks.forEach { check ->
            FoliaPlugin.logStatic(
                "diagnostics ${check.verdict.name.lowercase()} ${check.id}: ${check.detail}" +
                    (if (check.evidence.isNotBlank()) " [${check.evidence}]" else "")
            )
        }

        // Toast policy: failures one by one (they are actionable), unknowns as ONE consolidated
        // line (they are not actionable and must never look like a missing dependency).
        report.missing.forEach { check ->
            FoliaPlugin.toastStatic(
                "缺少运行环境：${check.label} — ${check.detail}" + (check.fix?.let { " → $it" } ?: ""),
                WorkshopApi.Ui.ToastType.Error,
            )
        }
        if (report.unverified.isNotEmpty()) {
            FoliaPlugin.toastStatic(
                "有 ${report.unverified.size} 项无法判定（" +
                    report.unverified.joinToString("、") { it.label } +
                    "），这不代表环境有问题；详见日志",
                WorkshopApi.Ui.ToastType.Warning,
            )
        }

        // The log folder is what a maintainer needs in every branch, so it always opens.
        openLogFolder(report)

        if (report.missing.isNotEmpty()) {
            // Do not open the feedback page while something actionable is missing: the user should
            // fix it and re-run, not file a report that will be closed as "install WebView2".
            FoliaPlugin.toastStatic(
                "先按提示补齐上面的 ${report.missing.size} 项，再点一次「出现问题」即可提交反馈",
                WorkshopApi.Ui.ToastType.Warning,
            )
            return
        }
        FoliaPlugin.toastStatic(
            if (report.unverified.isEmpty()) "环境检查通过，正在打开反馈页面" else "已在日志中记录无法判定的项，正在打开反馈页面",
            WorkshopApi.Ui.ToastType.Success,
        )
        openFeedback(report)
    }

    // --------------------------------------------------------------------- self-check ----

    /** Runs every probe and turns each into a [Check]. [pluginPath] is the installed plugin dir. */
    fun inspect(
        pluginPath: File,
        spwVersion: String,
        pluginVersion: String,
        hostPid: Long = -1L,
    ): Report {
        val windows = FoliaEnvironmentProbe.windows()
        val checks = mutableListOf<Check>()
        checks += osCheck(windows)
        checks += dotnetCheck()
        checks += webView2Check()
        checks += nativeFilesCheck(pluginPath)
        checks += bundleCheck(pluginPath)
        checks += settingsUiCheck(pluginPath)
        checks += writableCheck(pluginPath)
        checks += spwVersionCheck(spwVersion)
        checks += permissionChecks()
        checks += hostSessionCheck(hostPid)
        checks += gpuCheck()
        checks += configContractCheck()

        val logs = logFiles(pluginPath)
        val generatedAt = LocalDateTime.now()
        val windowsLine = windowsLine(windows)
        val summary = buildSummary(checks, pluginVersion, spwVersion, windowsLine, generatedAt)
        return Report(
            checks = checks,
            logFiles = logs,
            logDir = pluginPath,
            summary = summary,
            issueBody = buildIssueBody(summary, logs),
            windowsLine = windowsLine,
            pluginVersion = pluginVersion,
            spwVersion = spwVersion,
            generatedAt = generatedAt,
        )
    }

    /**
     * H1 — Windows x64, build ≥ 17763.
     *
     * Three independent outcomes:
     *  - build known **and** ≥ 17763 **and** 64-bit → [Verdict.PASS]
     *  - build known **and** < 17763 → [Verdict.FAIL] (the only branch that may say 「版本太低」)
     *  - build not readable at all → [Verdict.UNKNOWN] (this is the branch v0.4.6 got wrong)
     */
    private fun osCheck(windows: FoliaEnvironmentProbe.WindowsInfo): Check {
        val build = windows.build
        val is64 = windows.isOs64
        val detail = windows.describe()
        val evidence = buildString {
            append("build: ").append(windows.buildEvidence.describe())
            append("; arch: ").append(windows.arch.describe())
            if (windows.ubr.present) append("; ubr: ").append(windows.ubr.describe())
        }
        return when {
            !is64 -> Check(
                id = "os",
                label = "64 位 Windows",
                verdict = Verdict.FAIL,
                detail = "$detail — 当前不是 64 位系统",
                evidence = evidence,
                fix = "spw-folia 只支持 64 位 Windows 10 1809+；32 位系统无法运行辅助进程",
            )

            build == null -> Check(
                id = "os",
                label = "Windows 10 x64（1809+）",
                verdict = Verdict.UNKNOWN,
                detail = "$detail — 读不到系统构建号（注册表与 JVM 属性都不可用）",
                evidence = evidence,
            )

            build < FoliaEnvironmentProbe.MIN_WINDOWS_BUILD -> Check(
                id = "os",
                label = "Windows 10 x64（1809+）",
                verdict = Verdict.FAIL,
                detail = "$detail — 实测构建号 $build，低于要求的 ${FoliaEnvironmentProbe.MIN_WINDOWS_BUILD}",
                evidence = evidence,
                fix = "升级 Windows 到 10 1809（17763）或更新版本",
            )

            else -> Check(
                id = "os",
                label = "Windows 10 x64（1809+）",
                verdict = Verdict.PASS,
                detail = detail,
                evidence = evidence,
            )
        }
    }

    /** H2 — .NET Framework 4.8. Unreadable → UNKNOWN, not 「未安装」. */
    private fun dotnetCheck(): Check {
        val evidence = FoliaEnvironmentProbe.dotnet()
        val release = evidence.value?.toIntOrNull()
        return when {
            release == null -> Check(
                id = "dotnet",
                label = ".NET Framework 4.8",
                verdict = Verdict.UNKNOWN,
                detail = "读不到注册表 ${"HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full"} 的 Release" +
                    (evidence.error?.let { "（$it）" } ?: ""),
                evidence = evidence.describe(),
            )

            release >= FoliaEnvironmentProbe.DOTNET_48_RELEASE -> Check(
                id = "dotnet",
                label = ".NET Framework 4.8",
                verdict = Verdict.PASS,
                detail = "Release=$release（4.8 起算 ${FoliaEnvironmentProbe.DOTNET_48_RELEASE}）",
                evidence = evidence.describe(),
            )

            else -> Check(
                id = "dotnet",
                label = ".NET Framework 4.8",
                verdict = Verdict.FAIL,
                detail = "Release=$release，低于 4.8 的 ${FoliaEnvironmentProbe.DOTNET_48_RELEASE}",
                evidence = evidence.describe(),
                fix = "安装 .NET Framework 4.8：https://dotnet.microsoft.com/download/dotnet-framework/net48",
            )
        }
    }

    /** H3 — WebView2 Runtime ≥ 86. Registry first, installed-directory fallback second. */
    private fun webView2Check(): Check {
        val info = FoliaEnvironmentProbe.webView2()
        val version = info.version
        val major = info.major
        val evidence = buildString {
            append("registry: ").append(info.pv.describe())
            if (!info.pv.present) append("; dir: ").append(info.installedDirVersion.describe())
            info.registryKey?.let { append("; key=").append(it) }
        }
        return when {
            version == null -> Check(
                id = "webview2",
                label = "WebView2 Runtime（≥ ${FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR}）",
                verdict = Verdict.UNKNOWN,
                detail = "读不到 WebView2 版本（注册表三个 EdgeUpdate 键与安装目录都不可用）",
                evidence = evidence,
            )

            // EdgeUpdate writes 0.0.0.0 for "installed but not ready"; the host then exits with 3.
            version.startsWith("0.0.0.0") -> Check(
                id = "webview2",
                label = "WebView2 Runtime（≥ ${FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR}）",
                verdict = Verdict.FAIL,
                detail = "注册表 pv=0.0.0.0，表示运行时已注册但不可用（宿主会以退出码 3 结束）",
                evidence = evidence,
                fix = "修复/重装 WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/consumer/",
            )

            major == null -> Check(
                id = "webview2",
                label = "WebView2 Runtime（≥ ${FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR}）",
                verdict = Verdict.UNKNOWN,
                detail = "版本号 \"$version\" 无法解析出主版本",
                evidence = evidence,
            )

            major < FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR -> Check(
                id = "webview2",
                label = "WebView2 Runtime（≥ ${FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR}）",
                verdict = Verdict.FAIL,
                detail = "实测 $version，主版本 $major 低于 ${FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR}",
                evidence = evidence,
                fix = "更新 WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/consumer/",
            )

            else -> Check(
                id = "webview2",
                label = "WebView2 Runtime（≥ ${FoliaEnvironmentProbe.WEBVIEW2_MIN_MAJOR}）",
                verdict = Verdict.PASS,
                detail = version,
                evidence = evidence,
            )
        }
    }

    /**
     * v0.4.11 — the self-check must agree with the version that is actually running.
     *
     * A diagnostics button that keeps reporting yesterday's expectations is worse than none: after a
     * config-page change it would call a perfectly good install broken (or, worse, *pass* while the
     * declaration and the code have drifted apart).
     *
     * The contract checked here is the one that has actually broken before: **every switch declared in
     * `preference_config.json` must be one this build reads.** The declaration ships inside the jar
     * (`classes/preference_config.json`), so reading it from [pluginPath] is reading the installed
     * copy; when no declaration is reachable the verdict is [Verdict.UNKNOWN], never a failure.
     *
     * Deliberately narrow: it does not try to validate SPW's rendering of the page (that is SPW's
     * schema and is covered by the real-machine pass in `packaging/tools/verify-diagnostics.mjs`).
     */
    private fun configContractCheck(): Check {
        val label = "配置页声明与代码一致"
        val declared = runCatching { readDeclaredConfigKeys() }.getOrNull()
            ?: return Check(
                id = "config-contract",
                label = label,
                verdict = Verdict.UNKNOWN,
                detail = "无法读取内置的 preference_config.json",
                evidence = "resource ${'$'}CONFIG_DECLARATION",
            )
        if (declared.isEmpty()) {
            return Check(
                id = "config-contract",
                label = label,
                verdict = Verdict.UNKNOWN,
                detail = "内置声明里没有可识别的开关",
                evidence = "resource ${'$'}CONFIG_DECLARATION",
            )
        }
        val known = KNOWN_CONFIG_SWITCHES
        val unhandled = declared.keys.filter { it !in known }.sorted()
        val evidence = "declared=" + declared.entries.sortedBy { it.key }
            .joinToString(",") { "${it.key}:${it.value}" } + " handled=" + known.sorted().joinToString(",")
        return if (unhandled.isEmpty()) {
            Check(
                id = "config-contract",
                label = label,
                verdict = Verdict.PASS,
                detail = "${declared.size} 个开关全部有读取实现（${declared.keys.sorted().joinToString("、")}）",
                evidence = evidence,
            )
        } else {
            Check(
                id = "config-contract",
                label = label,
                verdict = Verdict.FAIL,
                detail = "声明里有代码没读的开关：${unhandled.joinToString("、")}（改了配置页却忘了接读取）",
                evidence = evidence,
                fix = "这是插件自身缺陷，请反馈；临时可在配置页忽略该项",
            )
        }
    }

    /**
     * Parses the `switch` entries out of the bundled `preference_config.json`.
     *
     * Hand-rolled on purpose: the plugin carries no JSON library (the settings tree is edited with
     * [Json]'s text helpers), and the declaration is a flat, machine-written file. Only `key` and
     * `default_value` of `"type": "switch"` entries are extracted — the same two fields the readers
     * use — so a change in SPW's schema cannot make this check lie.
     */
    private fun readDeclaredConfigKeys(): Map<String, String>? {
        val stream = FoliaDiagnostics::class.java.classLoader
            ?.getResourceAsStream(CONFIG_DECLARATION) ?: return null
        val text = stream.use { it.readBytes().toString(Charsets.UTF_8) }
        val out = LinkedHashMap<String, String>()
        // Split on object boundaries is unreliable; scan for "type": "switch" then take the nearest
        // following "key"/"default_value" — the file writes type first, which is SPW's own order.
        var index = 0
        while (true) {
            val typeAt = text.indexOf("\"type\"", index)
            if (typeAt < 0) break
            val objectEnd = text.indexOf('}', typeAt)
            if (objectEnd < 0) break
            val chunk = text.substring(typeAt, objectEnd)
            index = objectEnd
            if (!chunk.contains("\"switch\"")) continue
            val key = stringMember(chunk, "key") ?: continue
            out[key] = when {
                chunk.contains("\"default_value\": true") -> "true"
                chunk.contains("\"default_value\": false") -> "false"
                else -> "?"
            }
        }
        return out
    }

    private fun stringMember(chunk: String, name: String): String? {
        val at = chunk.indexOf("\"$name\"")
        if (at < 0) return null
        val colon = chunk.indexOf(':', at)
        if (colon < 0) return null
        val open = chunk.indexOf('"', colon)
        if (open < 0) return null
        val close = chunk.indexOf('"', open + 1)
        if (close < 0) return null
        return chunk.substring(open + 1, close)
    }

    /**
     * v0.4.11: is [dir] a *source checkout* rather than an installed plugin directory?
     *
     * Two markers, either is enough: the Gradle project file next to `src/`, or a `src/main/kotlin`
     * tree. Deliberately conservative — a real install has `classes/`, `web/`, `native/` and none of
     * these, so this can never hide a genuine broken install.
     *
     * Why it exists: `gradlew runDiagnostics` (and any IDE run) points the self-check at the project
     * directory, where the packaged payload is *supposed* to be absent. Before this the check reported
     * native/bundle/settings-ui as FAIL — three false alarms on a perfectly healthy machine, which is
     * exactly the failure mode the four-state model was introduced to prevent.
     */
    private fun isDevCheckout(dir: File): Boolean {
        if (File(dir, "src/main/kotlin").isDirectory) return true
        val projectFiles = listOf("build.gradle.kts", "build.gradle", "settings.gradle.kts")
        return projectFiles.any { File(dir, it).isFile } && File(dir, "src").isDirectory
    }

    /** H4/H5 — the five native files beside the helper. Missing files come from a directory listing. */
    private fun nativeFilesCheck(pluginPath: File): Check {
        // Release layout puts them under native/ (older builds lib/); the dev checkout uses host/.
        val dirs = listOf("native", "lib", "host", "native/x64", "lib/x64")
        val found = dirs.firstOrNull { dir -> NATIVE_FILES.all { File(pluginPath, "$dir/$it").isFile } }
        if (found != null) {
            return Check(
                id = "native",
                label = "辅助进程与 WebView2 原生文件",
                verdict = Verdict.PASS,
                detail = "$found/（${NATIVE_FILES.size} 个文件齐全）",
                evidence = "file system ${pluginPath.absolutePath}/$found",
            )
        }
        val present = mutableListOf<String>()
        val missing = mutableListOf<String>()
        NATIVE_FILES.forEach { name ->
            if (dirs.any { dir -> File(pluginPath, "$dir/$name").isFile }) present += name else missing += name
        }
        val evidence = "file system ${pluginPath.absolutePath}（候选目录：${dirs.joinToString("/")}）"
        // Only a directory listing that actually ran can prove a file is missing. If the plugin dir
        // itself is unreadable, that is an unknown, not "install incomplete".
        if (!pluginPath.isDirectory) {
            return Check(
                id = "native",
                label = "辅助进程与 WebView2 原生文件",
                verdict = Verdict.UNKNOWN,
                detail = "插件目录不可读：${pluginPath.absolutePath}",
                evidence = evidence,
            )
        }
        // v0.4.11: the dev checkout (runDiagnostics / IDE runs) legitimately has no staged payload.
        // Without this branch the self-check reported 3 false failures on a healthy machine — the exact
        // class of bug this file was written to stop (docs/dev-experience.md §9.3). A tree that does
        // not even claim to be a deployed plugin is «not deployed», not «missing dependencies».
        if (isDevCheckout(pluginPath)) {
            return Check(
                id = "native",
                label = "辅助进程与 WebView2 原生文件",
                verdict = Verdict.UNKNOWN,
                detail = "开发检出目录，未暂存原生文件（不是安装缺失）",
                evidence = evidence,
            )
        }
        return if (missing.isEmpty()) {
            Check(
                id = "native",
                label = "辅助进程与 WebView2 原生文件",
                verdict = Verdict.PASS,
                detail = "分散在多个候选目录里，5 个文件都在",
                evidence = evidence,
            )
        } else {
            Check(
                id = "native",
                label = "辅助进程与 WebView2 原生文件",
                verdict = Verdict.FAIL,
                detail = "缺少 ${missing.joinToString("、")}" +
                    (if (present.isEmpty()) "" else "（已有：${present.joinToString("、")}）"),
                evidence = evidence,
                fix = "插件安装不完整（或被安全软件删除文件），重新安装 spw-folia",
            )
        }
    }

    /** H10 — `web/index.html`. */
    private fun bundleCheck(pluginPath: File): Check {
        if (!pluginPath.isDirectory) {
            return Check(
                id = "bundle",
                label = "Folia 页面资源（web/index.html）",
                verdict = Verdict.UNKNOWN,
                detail = "插件目录不可读：${pluginPath.absolutePath}",
                evidence = "file system ${pluginPath.absolutePath}",
            )
        }
        if (isDevCheckout(pluginPath)) {
            return Check(
                id = "bundle",
                label = "Folia 页面资源（web/index.html）",
                verdict = Verdict.UNKNOWN,
                detail = "开发检出目录，未暂存 web/（不是安装缺失）",
                evidence = "file system ${pluginPath.absolutePath}",
            )
        }
        val candidates = listOf("web", "web/dist")
        val dir = candidates.map { File(pluginPath, it) }.firstOrNull { File(it, "index.html").isFile }
        return if (dir != null) {
            Check(
                id = "bundle",
                label = "Folia 页面资源（web/index.html）",
                verdict = Verdict.PASS,
                detail = "${dir.absolutePath}（${countFiles(dir)} 个文件）",
                evidence = "file system ${dir.absolutePath}/index.html",
            )
        } else {
            Check(
                id = "bundle",
                label = "Folia 页面资源（web/index.html）",
                verdict = Verdict.FAIL,
                detail = "web/ 与 web/dist/ 下都没有 index.html",
                evidence = "file system ${pluginPath.absolutePath}/{web,web/dist}",
                fix = "插件安装不完整（或被安全软件删除文件），重新安装 spw-folia",
            )
        }
    }

    /** H10 — the settings island bundle. */
    private fun settingsUiCheck(pluginPath: File): Check {
        if (!pluginPath.isDirectory) {
            return Check(
                id = "settings-ui",
                label = "设置界面资源（settings-ui.js）",
                verdict = Verdict.UNKNOWN,
                detail = "插件目录不可读：${pluginPath.absolutePath}",
                evidence = "file system ${pluginPath.absolutePath}",
            )
        }
        if (isDevCheckout(pluginPath)) {
            return Check(
                id = "settings-ui",
                label = "设置界面资源（settings-ui.js）",
                verdict = Verdict.UNKNOWN,
                detail = "开发检出目录，未暂存 settings-ui.js（不是安装缺失）",
                evidence = "file system ${pluginPath.absolutePath}",
            )
        }
        val candidates = listOf("web/settings/settings-ui.js", "web/settings-ui.js", "settings/settings-ui.js")
        val file = candidates.map { File(pluginPath, it) }.firstOrNull { it.isFile }
        return if (file != null) {
            Check(
                id = "settings-ui",
                label = "设置界面资源（settings-ui.js）",
                verdict = Verdict.PASS,
                detail = "${file.absolutePath}（${file.length() / 1024} KB）",
                evidence = "file system ${file.absolutePath}",
            )
        } else {
            Check(
                id = "settings-ui",
                label = "设置界面资源（settings-ui.js）",
                verdict = Verdict.FAIL,
                detail = "web/settings/、web/、settings/ 下都没有 settings-ui.js",
                evidence = "file system ${pluginPath.absolutePath}",
                fix = "插件安装不完整，重新安装 spw-folia",
            )
        }
    }

    /** H9 — the plugin directory must be writable for logs and settings. */
    private fun writableCheck(pluginPath: File): Check {
        val evidence = FoliaEnvironmentProbe.writable(pluginPath)
        return if (evidence.present) {
            Check(
                id = "writable",
                label = "插件目录可写（日志/配置）",
                verdict = Verdict.PASS,
                detail = pluginPath.absolutePath,
                evidence = evidence.describe(),
            )
        } else {
            Check(
                id = "writable",
                label = "插件目录可写（日志/配置）",
                verdict = Verdict.FAIL,
                detail = "${pluginPath.absolutePath} 写入失败：${evidence.error ?: "未知原因"}",
                evidence = evidence.describe(),
                fix = "检查插件目录权限，或把 SPW 移出只读/受控目录（杀软的「受保护文件夹」也会拦住写入）",
            )
        }
    }

    /** H6 — the host release must be ≥ 1.19.0 (the menu hook targets live there). */
    private fun spwVersionCheck(spwVersion: String): Check {
        val version = HostTargets.Version.parse(spwVersion)
        val label = "Salt Player for Windows ${HostTargets.Version.MIN_SUPPORTED}+"
        return when {
            version == null -> Check(
                id = "spw",
                label = label,
                verdict = Verdict.UNKNOWN,
                detail = "读不到 SPW 版本（pluginContext.spwVersion=\"$spwVersion\"）",
                evidence = "runtime API pluginContext.spwVersion",
            )

            version < HostTargets.Version.MIN_SUPPORTED -> Check(
                id = "spw",
                label = label,
                verdict = Verdict.FAIL,
                detail = "实测 $version，低于 ${HostTargets.Version.MIN_SUPPORTED}",
                evidence = "runtime API pluginContext.spwVersion=\"$spwVersion\"",
                fix = "升级 Salt Player for Windows（菜单 hook 只针对 1.19.0+）",
            )

            else -> Check(
                id = "spw",
                label = label,
                verdict = Verdict.PASS,
                detail = version.toString(),
                evidence = "runtime API pluginContext.spwVersion=\"$spwVersion\"",
            )
        }
    }

    /**
     * H8 — plugin permissions.
     *
     * `isPermissionGranted` is a **default method on the interface that returns false**, and only a
     * host build that overrides it can answer truthfully. A `false` therefore cannot distinguish
     * 「拒绝授予」 from 「这个宿主版本不支持查询」, so it is reported as UNKNOWN with the raw answer in
     * the evidence rather than as a missing permission. The plugin's own start-up path already
     * logs/blocks on the same call, so nothing is lost by being honest here.
     */
    private fun permissionChecks(): List<Check> = REQUIRED_PERMISSIONS.map { (permission, fix) ->
        val id = permission.id
        val label = "插件权限 $id"
        val api = "runtime API WorkshopApi.manager.isPermissionGranted(${permission.name})"
        val answer = runCatching { WorkshopApi.manager.isPermissionGranted(permission) }
        when (val granted = answer.getOrNull()) {
            true -> Check(
                id = "perm-$id",
                label = label,
                verdict = Verdict.PASS,
                detail = "已授予",
                evidence = "$api = true",
            )

            false -> Check(
                id = "perm-$id",
                label = label,
                verdict = Verdict.UNKNOWN,
                detail = "宿主返回 false；该接口的默认实现恒为 false，无法区分「确实没给」与「本宿主版本不支持查询」，请到插件权限页核对",
                evidence = "$api = false（$fix）",
            )

            null -> Check(
                id = "perm-$id",
                label = label,
                verdict = Verdict.UNKNOWN,
                detail = "权限查询失败：" + (
                    answer.exceptionOrNull()?.let { "${it::class.java.simpleName}: ${it.message}" }
                        ?: "未知原因"
                    ),
                evidence = "$api 抛异常",
            )
        }
    }

    /**
     * S9 — a live helper session, when the caller knows one exists.
     *
     * Only meaningful from the 配置 page while Folia is open; with no session this reports
     * [Verdict.ADVISORY] rather than a failure (the window simply is not running).
     */
    private fun hostSessionCheck(pid: Long): Check {
        val label = "辅助进程会话"
        if (pid <= 0L) {
            return Check(
                id = "host-session",
                label = label,
                verdict = Verdict.ADVISORY,
                detail = "当前没有正在运行的 Folia 窗口",
                evidence = "runtime state pid=-1",
            )
        }
        val alive = runCatching { ProcessHandle.of(pid).map { it.isAlive }.orElse(false) }
            .getOrDefault(false)
        return Check(
            id = "host-session",
            label = label,
            verdict = if (alive) Verdict.PASS else Verdict.ADVISORY,
            detail = if (alive) "运行中 pid=$pid" else "pid=$pid 已退出",
            evidence = "runtime state pid=$pid",
        )
    }

    /**
     * S1 — a remote desktop session degrades WebGL but does not stop the plugin.
     *
     * Reported as [Verdict.ADVISORY] always: the old code set `ok = !remote` but attached no `fix`,
     * which made a remote-desktop session count as a missing environment in the summary line while
     * showing no remedy.
     */
    private fun gpuCheck(): Check {
        val session = System.getenv("SESSIONNAME").orEmpty()
        val remote = session.startsWith("RDP-", ignoreCase = true)
        return Check(
            id = "gpu",
            label = "本地图形会话（WebGL）",
            verdict = Verdict.ADVISORY,
            detail = if (remote) "远程桌面会话 $session，WebGL 可能降级/黑屏" else "本地会话（$session）",
            evidence = "environment variable SESSIONNAME=\"$session\"",
        )
    }

    // -------------------------------------------------------------------------- logs ----

    /** Every log the maintainer needs, in the order they should be read. */
    fun logFiles(pluginPath: File): List<File> {
        val candidates = mutableListOf(
            File(pluginPath, "spw-folia.log"),
            File(pluginPath, "spw-folia-host.stdout.log"),
            File(pluginPath, "spw-folia-host.stderr.log"),
        )
        // SPW's own log: plugin load / permission errors land here.
        System.getenv("APPDATA")?.takeIf { it.isNotBlank() }?.let { appData ->
            candidates += File(appData, "Salt Player for Windows/logs.txt")
        }
        return candidates.filter { it.isFile }
    }

    private fun countFiles(dir: File): Int =
        runCatching { dir.walkTopDown().count { it.isFile } }.getOrDefault(0)

    // ---------------------------------------------------------------------- feedback ----

    /** Opens Explorer in the plugin dir with `spw-folia.log` selected (`explorer /select,<file>`). */
    fun openLogFolder(report: Report) {
        val target = report.logFiles.firstOrNull() ?: report.logDir
        val ok = runCatching {
            val command = if (target.isFile) {
                listOf("explorer.exe", "/select,${target.absolutePath}")
            } else {
                listOf("explorer.exe", target.absolutePath)
            }
            ProcessBuilder(command).start()
            true
        }.getOrElse { t ->
            FoliaPlugin.logStatic("open log folder failed: ${t::class.java.name}: ${t.message}")
            false
        }
        FoliaPlugin.logStatic("open log folder target=${target.absolutePath} ok=$ok")
    }

    /** Opens the pre-filled GitHub issue form in the default browser. */
    fun openFeedback(report: Report) {
        val url = issueUrl(report.issueBody)
        val ok = runCatching {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI(url))
                true
            } else {
                // Headless/minimal JRE fallback: hand the URL to the OS anyway.
                ProcessBuilder("rundll32.exe", "url.dll,FileProtocolHandler", url).start()
                true
            }
        }.getOrElse { t ->
            FoliaPlugin.logStatic("open feedback failed: ${t::class.java.name}: ${t.message}")
            false
        }
        FoliaPlugin.logStatic("open feedback ok=$ok bodyChars=${report.issueBody.length}")
        if (!ok) {
            FoliaPlugin.toastStatic(
                "无法自动打开浏览器，请手动访问 $ISSUE_FORM",
                WorkshopApi.Ui.ToastType.Warning,
            )
        }
    }

    /** The exact form URL, capped so the OS/browser does not truncate it. */
    fun issueUrl(body: String): String {
        val title = "问题反馈："
        val trimmed = if (body.length > MAX_BODY_CHARS) {
            body.substring(0, MAX_BODY_CHARS) + "\n\n(完整日志见附件)"
        } else {
            body
        }
        return ISSUE_FORM +
            "?title=" + urlEncode(title) +
            "&body=" + urlEncode(trimmed) +
            "&labels=" + urlEncode("bug")
    }

    private fun urlEncode(text: String): String =
        URLEncoder.encode(text, "UTF-8").replace("+", "%20")

    // ---------------------------------------------------------------- report rendering ----

    /** One-line system identity, e.g. `Windows 11 (26H2, build 26300.9711, amd64)`. */
    private fun windowsLine(windows: FoliaEnvironmentProbe.WindowsInfo): String {
        val jvm = Runtime.version().toString()
        return "${windows.describe()} · JVM $jvm"
    }

    /**
     * The plain-text summary that goes into the issue body.
     *
     * Failures and unknowns are **two different sections** on purpose: a maintainer must be able to
     * tell 「用户缺环境」 from 「我们读不到」 without cross-referencing the code.
     */
    private fun buildSummary(
        checks: List<Check>,
        pluginVersion: String,
        spwVersion: String,
        windowsLine: String,
        generatedAt: LocalDateTime,
    ): String = buildString {
        append("spw-folia ").append(pluginVersion)
        append(" · SPW ").append(spwVersion.ifBlank { "未知" })
        append(" · ").append(windowsLine)
        append("\n生成时间 ").append(generatedAt.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")))
        append("\n\n【检查结果】\n")
        checks.forEach { check ->
            append('-').append(' ').append(check.verdict.label).append(' ')
            append(check.label)
            if (check.detail.isNotBlank()) append(": ").append(check.detail)
            if (check.evidence.isNotBlank()) append("\n    依据: ").append(check.evidence)
            if (check.fix != null && check.verdict == Verdict.FAIL) append("\n    修复: ").append(check.fix)
            append('\n')
        }
        val missing = checks.filter { it.verdict == Verdict.FAIL }
        val unknown = checks.filter { it.verdict == Verdict.UNKNOWN }
        append('\n').append("【结论】")
        append('\n').append(if (missing.isEmpty()) "没有发现缺失的运行环境。" else "缺失 ${missing.size} 项：" + missing.joinToString("、") { it.label })
        append('\n').append(if (unknown.isEmpty()) "所有检查项都有明确结果。" else "无法判定 ${unknown.size} 项：" + unknown.joinToString("、") { it.label } + "（读不到，不代表没有）")
    }

    /** Markdown body: environment table, then the tail of every log, then the reproduction slots. */
    fun buildIssueBody(summary: String, logs: List<File>): String = buildString {
        append("### 问题描述\n\n")
        append("<!-- 请描述你看到的现象、复现步骤，以及期望的结果 -->\n\n")
        append("### 运行环境（自动生成于 ")
        append(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")))
        append("）\n\n```\n").append(summary.trim()).append("\n```\n\n")
        append("### 日志\n\n")
        if (logs.isEmpty()) {
            append("（没有找到日志文件）\n")
        } else {
            logs.forEach { file ->
                append("**").append(file.name).append("** — ").append(file.absolutePath).append("\n\n")
                append("```\n").append(tail(file)).append("\n```\n\n")
            }
        }
        append("> 完整日志文件已在该插件的安装目录，可直接拖入本 issue。\n")
    }

    /** Last [LOG_TAIL_LINES] lines of [file]; never throws, never reads a whole huge file. */
    private fun tail(file: File): String = runCatching {
        val lines = file.readLines()
        val start = (lines.size - LOG_TAIL_LINES).coerceAtLeast(0)
        lines.subList(start, lines.size).joinToString("\n")
    }.getOrElse { t -> "<读取失败: ${t::class.java.name}>" }

    // ---------------------------------------------------------------------- registry ----

    /**
     * Reads one `REG_SZ`/`REG_DWORD` value through `reg.exe query <key> /v <name>`.
     *
     * Kept as a thin compatibility shim for callers that only want the text; all the real work and
     * all the failure attribution live in [FoliaEnvironmentProbe]. A null return here means "no
     * evidence", and callers must treat it as unknown rather than as a negative answer.
     */
    fun regQuery(key: String, name: String): String? =
        FoliaEnvironmentProbe.regValue(key, name).value
}
