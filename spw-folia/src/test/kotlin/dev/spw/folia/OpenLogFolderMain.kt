package dev.spw.folia

import java.io.File

/**
 * Ad-hoc real-machine runner for issue #18 item 3 — the 「出现问题」 log-folder callsite.
 *
 * Not part of the shipped plugin. It calls the SAME
 * [FoliaDiagnostics.openLogFolder] the 「出现问题」 button reaches, so the evidence covers the real
 * code path instead of a re-typed copy of it: the whole point of the bug was that the argv shape
 * looked correct in review and only failed when Explorer actually parsed it.
 *
 * `openLogFolder` takes a `Report`, which normally arrives from [FoliaDiagnostics.inspect]. Building
 * one by hand keeps this runner fast and lets it point at any plugin dir, including a fresh install
 * with no log yet (the directory branch).
 *
 * The directory comes from the `FOLIA_PLUGIN_DIR` environment variable first and from `args[0]`
 * second: a plugin install path on Windows contains spaces (`...\Salt Player for Windows\...`) and
 * this checkout's own path contains CJK, and both get split or mangled while travelling through a
 * shell argument list. The environment is not re-parsed by anything, so it survives intact.
 *
 * Usage:
 *     FOLIA_PLUGIN_DIR='C:\...\spw-folia-0.4.16' java ... OpenLogFolderMain
 */
object OpenLogFolderMain {
    @JvmStatic
    fun main(args: Array<String>) {
        val fromEnv = System.getenv("FOLIA_PLUGIN_DIR")?.takeIf { it.isNotBlank() }
        val pluginDir = File(fromEnv ?: args.firstOrNull() ?: ".")
        val report = FoliaDiagnostics.Report(
            checks = emptyList(),
            logFiles = FoliaDiagnostics.logFiles(pluginDir),
            logDir = pluginDir,
            summary = "",
            issueBody = "",
            windowsLine = "",
            pluginVersion = FoliaPlugin.PLUGIN_VERSION,
            spwVersion = FoliaPlugin.SPW_VERSION,
            generatedAt = java.time.LocalDateTime.now(),
        )
        val target = report.logFiles.firstOrNull() ?: report.logDir
        val command = FoliaDiagnostics.logFolderCommand(target)
        println("TARGET=" + target.absolutePath)
        println("TARGET_IS_FILE=" + target.isFile)
        println("ARGV=" + command)
        // `FOLIA_OPEN_LOG_FOLDER_DRY_RUN=1` prints the argv and stops. The gate needs to read what
        // the real callsite produces WITHOUT spawning Explorer — a test suite that opens a window on
        // the user's desktop every time it runs is a nuisance, and on a locked/headless session it
        // would fail for reasons unrelated to the shape under test.
        if (System.getenv("FOLIA_OPEN_LOG_FOLDER_DRY_RUN") == "1") {
            println("DRY_RUN=1 (Explorer not launched)")
            return
        }
        // The observable half: this is what Explorer receives.
        FoliaDiagnostics.openLogFolder(report)
        println("OPENED=ok")
    }
}
