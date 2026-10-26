package dev.spw.folia

import com.xuncorp.spw.workshop.api.PluginPermission
import com.xuncorp.spw.workshop.api.WorkshopApi
import java.awt.Desktop
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * issue #12 增加日志功能: the 「出现问题」 button on SPW's 配置 page (declared in
 * `preference_config.json`) lands in [onReportProblem].
 *
 * Two halves, exactly as the issue asks for:
 *  1. **environment self-check** — [inspect] probes the hard dependencies from
 *     `docs/runtime-requirements.md` (Windows build, .NET Framework 4.8, WebView2 Runtime, the four
 *     native files next to the helper, the web bundle, the settings island, a writable plugin dir,
 *     the SPW version and the plugin permissions). Missing pieces are named, not summarised.
 *  2. **feedback** — when nothing is missing, [openFeedback] opens a GitHub issue form pre-filled
 *     with the environment report and the tails of every log file, and [openLogFolder] opens the
 *     plugin directory in Explorer with `spw-folia.log` selected, so the user can drag it in.
 *
 * Everything here is deliberately dependency-free: the plugin bundles no JSON library, and the
 * registry is read through `reg.exe` because this runs on Windows and the JVM has no registry API.
 * No step may throw — a diagnostics button that fails is worse than no button.
 */
internal object FoliaDiagnostics {

    /** One environment check. `fix` is what the user should do when `ok` is false. */
    data class Check(
        val id: String,
        val label: String,
        val ok: Boolean,
        val detail: String,
        val fix: String? = null,
    )

    data class Report(
        val checks: List<Check>,
        val logFiles: List<File>,
        val logDir: File,
        val summary: String,
        val issueBody: String,
    ) {
        val missing: List<Check> get() = checks.filter { !it.ok }
        val healthy: Boolean get() = missing.isEmpty()
    }

    /** Registry keys from `docs/runtime-requirements.md` §4, verbatim. */
    private const val WEBVIEW2_CLIENT_KEY =
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    private const val WEBVIEW2_CLIENT_KEY_USER =
        "HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    private const val DOTNET_FULL_KEY = "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full"

    /** .NET Framework 4.8 starts at this `Release` value (4.8.1 builds are 533320/533325/533509). */
    private const val DOTNET_48_RELEASE = 528040

    /** WebView2 Evergreen GA floor (`CoreWebView2` instantiation minimum). */
    private const val WEBVIEW2_MIN_MAJOR = 86

    private val NATIVE_FILES = listOf(
        "spw-folia-host.exe",
        "spw-folia-host.exe.config",
        "Microsoft.Web.WebView2.Core.dll",
        "Microsoft.Web.WebView2.WinForms.dll",
        "WebView2Loader.dll",
    )

    private val ISSUE_FORM = "https://github.com/azkbzxf/spw-folia/issues/new"
    private const val LOG_TAIL_LINES = 60
    /** GitHub accepts long bodies in the query string, but browsers/OS clip very long URLs. */
    private const val MAX_BODY_CHARS = 6000

    /** Entry point behind the 配置 page button; never throws. */
    fun onReportProblem(pluginPath: File, spwVersion: String, pluginVersion: String) {
        val report = runCatching { inspect(pluginPath, spwVersion, pluginVersion) }
            .getOrElse { t ->
                FoliaPlugin.logStatic("diagnostics failed: ${t::class.java.name}: ${t.message}")
                return
            }
        FoliaPlugin.logStatic(
            "diagnostics: ${report.checks.count { it.ok }}/${report.checks.size} ok, " +
                "missing=${report.missing.joinToString(",") { it.id }}"
        )
        if (!report.healthy) {
            report.missing.forEach { check ->
                FoliaPlugin.toastStatic(
                    "缺少运行环境：${check.label}（${check.detail}）" + (check.fix?.let { " → $it" } ?: ""),
                    WorkshopApi.Ui.ToastType.Error,
                )
            }
            // Still open the folder: the logs are what a maintainer needs for a missing-env report.
            openLogFolder(report)
            return
        }
        FoliaPlugin.toastStatic("环境检查通过，正在打开反馈页面与日志文件夹", WorkshopApi.Ui.ToastType.Success)
        openLogFolder(report)
        openFeedback(report)
    }

    // ------------------------------------------------------------- environment ----

    /** Runs every check; [pluginPath] is the installed plugin directory (logs live there). */
    fun inspect(pluginPath: File, spwVersion: String, pluginVersion: String): Report {
        val checks = mutableListOf<Check>()
        checks += osCheck()
        checks += dotnetCheck()
        checks += webView2Check()
        checks += nativeFilesCheck(pluginPath)
        checks += bundleCheck(pluginPath)
        checks += settingsUiCheck(pluginPath)
        checks += writableCheck(pluginPath)
        checks += spwVersionCheck(spwVersion)
        checks += permissionChecks()
        checks += gpuCheck()

        val logs = logFiles(pluginPath)
        val summary = buildString {
            append("spw-folia ").append(pluginVersion)
            append(" · SPW ").append(spwVersion)
            append(" · ").append(System.getProperty("os.name")).append(' ')
            append(System.getProperty("os.version")).append(" (").append(System.getProperty("os.arch")).append(")\n")
            checks.forEach { check ->
                append(if (check.ok) "- [x] " else "- [ ] ").append(check.label)
                if (check.detail.isNotBlank()) append(": ").append(check.detail)
                append('\n')
            }
        }
        return Report(
            checks = checks,
            logFiles = logs,
            logDir = pluginPath,
            summary = summary,
            issueBody = buildIssueBody(summary, logs),
        )
    }

    private fun osCheck(): Check {
        val version = System.getProperty("os.version").orEmpty()
        val arch = System.getProperty("os.arch").orEmpty()
        val build = parseWindowsBuild(version)
        val is64 = arch.contains("64")
        // docs/runtime-requirements.md H1: Windows 10 x64, 1809 (17763) or newer.
        val ok = is64 && build != null && build >= 17763
        return Check(
            id = "os",
            label = "Windows 10 x64（1809+）",
            ok = ok,
            detail = "${System.getProperty("os.name")} $version $arch" +
                if (build != null) " build=$build" else "",
            fix = if (ok) null else "需要 64 位 Windows 10 1809 (17763) 或更新版本",
        )
    }

    private fun parseWindowsBuild(version: String): Int? =
        Regex("""(\d+)\.(\d+)\.(\d+)""").find(version)?.groupValues?.getOrNull(3)?.toIntOrNull()

    private fun dotnetCheck(): Check {
        val release = regQuery(DOTNET_FULL_KEY, "Release")
        val value = release?.toIntOrNull()
        val ok = value != null && value >= DOTNET_48_RELEASE
        return Check(
            id = "dotnet",
            label = ".NET Framework 4.8",
            ok = ok,
            detail = if (value == null) "未安装（注册表 $DOTNET_FULL_KEY 无 Release）" else "Release=$value",
            fix = if (ok) null else "安装 .NET Framework 4.8：https://dotnet.microsoft.com/download/dotnet-framework/net48",
        )
    }

    private fun webView2Check(): Check {
        // Evergreen Runtime registers `pv` under the machine key; a per-user install uses HKCU.
        val pv = regQuery(WEBVIEW2_CLIENT_KEY, "pv") ?: regQuery(WEBVIEW2_CLIENT_KEY_USER, "pv")
        val major = pv?.substringBefore('.')?.toIntOrNull()
        val ok = major != null && major >= WEBVIEW2_MIN_MAJOR
        return Check(
            id = "webview2",
            label = "WebView2 Runtime（≥ $WEBVIEW2_MIN_MAJOR）",
            ok = ok,
            detail = pv ?: "未安装（注册表无 EdgeUpdate Client pv）",
            fix = if (ok) null else "安装 WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/consumer/",
        )
    }

    private fun nativeFilesCheck(pluginPath: File): Check {
        // Release layout puts them under native/ (older builds lib/); the dev checkout uses host/.
        val dirs = listOf("native", "lib", "host", "native/x64", "lib/x64")
        val found = dirs.firstOrNull { dir ->
            NATIVE_FILES.all { File(pluginPath, "$dir/$it").isFile }
        }
        val missing = if (found != null) emptyList() else NATIVE_FILES.filterNot { name ->
            dirs.any { dir -> File(pluginPath, "$dir/$name").isFile }
        }
        return Check(
            id = "native",
            label = "辅助进程与 WebView2 原生文件",
            ok = found != null,
            detail = if (found != null) "$found/" else "缺少 ${missing.joinToString(", ")}",
            fix = if (found != null) null else "插件安装不完整，重新安装 spw-folia",
        )
    }

    private fun bundleCheck(pluginPath: File): Check {
        val candidates = listOf("web", "web/dist")
        val dir = candidates.map { File(pluginPath, it) }.firstOrNull { File(it, "index.html").isFile }
        return Check(
            id = "bundle",
            label = "Folia 页面资源（web/index.html）",
            ok = dir != null,
            detail = dir?.let { "web/index.html 存在，${countFiles(it)} 个文件" } ?: "缺少 web/index.html",
            fix = if (dir != null) null else "插件安装不完整（或被杀毒软件删除文件），重新安装",
        )
    }

    private fun settingsUiCheck(pluginPath: File): Check {
        val file = listOf("web/settings/settings-ui.js", "web/settings-ui.js", "settings/settings-ui.js")
            .map { File(pluginPath, it) }
            .firstOrNull { it.isFile }
        return Check(
            id = "settings-ui",
            label = "设置界面资源（settings-ui.js）",
            ok = file != null,
            detail = file?.let { "存在，${it.length() / 1024} KB" } ?: "缺少 settings-ui.js",
            fix = if (file != null) null else "插件安装不完整，重新安装",
        )
    }

    private fun writableCheck(pluginPath: File): Check {
        val ok = runCatching {
            pluginPath.mkdirs()
            val probe = File(pluginPath, ".spw-folia-write-probe")
            probe.writeText("ok")
            probe.delete()
        }.isSuccess
        return Check(
            id = "writable",
            label = "插件目录可写（日志/配置）",
            ok = ok,
            detail = pluginPath.absolutePath,
            fix = if (ok) null else "检查插件目录权限，或把 SPW 移出只读/受控目录",
        )
    }

    private fun spwVersionCheck(spwVersion: String): Check {
        val version = HostTargets.Version.parse(spwVersion)
        val ok = version != null && version >= HostTargets.Version.MIN_SUPPORTED
        return Check(
            id = "spw",
            label = "Salt Player for Windows ${HostTargets.Version.MIN_SUPPORTED}+",
            ok = ok,
            detail = spwVersion.ifBlank { "未知" },
            fix = if (ok) null else "升级 Salt Player for Windows（菜单 hook 只针对 1.19.0+）",
        )
    }

    private fun permissionChecks(): List<Check> = listOf(
        Triple(PluginPermission.CLASS_TRANSFORM, "class-transform", "菜单入口需要；在插件权限页授予后重启 SPW"),
        Triple(PluginPermission.LIBRARY_READ, "library-read", "封面/歌词需要；在插件权限页授予后重启 SPW"),
        Triple(PluginPermission.KEY_BINDINGS, "key-bindings", "快捷键需要；不授予时其余功能正常"),
    ).map { (permission, id, fix) ->
        val granted = runCatching { WorkshopApi.manager.isPermissionGranted(permission) }.getOrDefault(false)
        Check(
            id = "perm-$id",
            label = "插件权限 $id",
            ok = granted,
            detail = if (granted) "已授予" else "未授予",
            fix = if (granted) null else fix,
        )
    }

    private fun gpuCheck(): Check {
        // Soft dependency (docs/runtime-requirements.md S1): a session without a usable GPU still
        // runs, it just renders badly. Reported, never treated as a missing environment.
        val session = System.getenv("SESSIONNAME").orEmpty()
        val remote = session.startsWith("RDP-", ignoreCase = true)
        return Check(
            id = "gpu",
            label = "本地图形会话（WebGL）",
            ok = !remote,
            detail = if (remote) "远程桌面会话 $session，WebGL 可能降级/黑屏" else "本地会话",
            fix = if (remote) null else null,
        )
    }

    // ------------------------------------------------------------------- logs ----

    /** Every log the maintainer needs, newest-first content order kept as written. */
    fun logFiles(pluginPath: File): List<File> {
        val candidates = mutableListOf(
            File(pluginPath, "spw-folia.log"),
            File(pluginPath, "spw-folia-host.stdout.log"),
            File(pluginPath, "spw-folia-host.stderr.log"),
        )
        // SPW's own log: plugin load / permission errors land here.
        val appData = System.getenv("APPDATA")
        if (!appData.isNullOrBlank()) candidates += File(appData, "Salt Player for Windows/logs.txt")
        return candidates.filter { it.isFile }
    }

    private fun countFiles(dir: File): Int =
        runCatching { dir.walkTopDown().count { it.isFile } }.getOrDefault(0)

    // --------------------------------------------------------------- feedback ----

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
                "无法自动打开浏览器，请手动访问 https://github.com/azkbzxf/spw-folia/issues/new",
                WorkshopApi.Ui.ToastType.Warning,
            )
        }
    }

    /** The exact form URL, capped so the OS/browser does not truncate it. */
    fun issueUrl(body: String): String {
        val title = "问题反馈："
        val trimmed = if (body.length > MAX_BODY_CHARS) body.substring(0, MAX_BODY_CHARS) + "\n\n(完整日志见附件)" else body
        return ISSUE_FORM +
            "?title=" + urlEncode(title) +
            "&body=" + urlEncode(trimmed) +
            "&labels=" + urlEncode("bug")
    }

    private fun urlEncode(text: String): String =
        URLEncoder.encode(text, "UTF-8").replace("+", "%20")

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

    // ----------------------------------------------------------------- registry ----

    /**
     * Reads one `REG_SZ`/`REG_DWORD` value through `reg.exe query <key> /v <name>`.
     *
     * Returns the value text or null. `reg.exe` is always present on Windows and keeps this
     * dependency-free; the call is bounded (2 s) so a hung registry provider cannot freeze the UI.
     */
    fun regQuery(key: String, name: String): String? = runCatching {
        val process = ProcessBuilder("reg.exe", "query", key, "/v", name)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        process.waitFor(2, TimeUnit.SECONDS)
        // Output line: "    Release    REG_DWORD    0x81234" (or REG_SZ with a plain value).
        val line = output.lineSequence().firstOrNull { it.contains(name, ignoreCase = false) }
            ?: return@runCatching null
        val fields = line.trim().split(Regex("\\s{2,}"))
        val raw = fields.lastOrNull() ?: return@runCatching null
        if (raw.startsWith("0x", ignoreCase = true)) {
            raw.substring(2).toIntOrNull(16)?.toString() ?: raw
        } else {
            raw
        }
    }.getOrNull()
}
