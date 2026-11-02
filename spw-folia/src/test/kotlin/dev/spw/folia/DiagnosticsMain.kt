package dev.spw.folia

import java.io.File

/**
 * Ad-hoc real-machine runner for the v0.4.7 self-check (not part of the shipped plugin).
 *
 * Run with `gradle runDiagnostics` or directly on the test classpath. It calls exactly the same
 * [FoliaDiagnostics.inspect] the 「出现问题」 button calls, on this machine, and prints the report —
 * the point is to prove that a healthy Windows 11 machine produces no false failure.
 */
object DiagnosticsMain {
    @JvmStatic
    fun main(args: Array<String>) {
        val pluginPath = File(args.firstOrNull() ?: ".")
        println("=== FoliaEnvironmentProbe (raw evidence) ===")
        val windows = FoliaEnvironmentProbe.windows()
        println("windows.describe = " + windows.describe())
        println("  osName            = " + windows.osName.describe())
        println("  registryBuild     = " + windows.registryBuild.describe() + " -> " + windows.registryBuild.value)
        println("  propertyBuild     = " + windows.propertyBuild.describe() + " -> " + windows.propertyBuild.value)
        println("  ubr               = " + windows.ubr.value)
        println("  displayVersion    = " + windows.displayVersion.value)
        println("  productName       = " + windows.productName.value)
        println("  arch              = " + windows.arch.value + " / model=" + windows.archDataModel.value)
        println("  build (decided)   = " + windows.build)
        println("  isOs64            = " + windows.isOs64)
        val wv = FoliaEnvironmentProbe.webView2()
        println("webview2.version  = " + wv.version + " (major=" + wv.major + ")")
        println("  pv                = " + wv.pv.describe())
        println("  dir               = " + wv.installedDirVersion.describe())
        val dn = FoliaEnvironmentProbe.dotnet()
        println("dotnet.release    = " + dn.value + "  [" + dn.describe() + "]")

        println()
        println("=== FoliaDiagnostics.inspect ===")
        val report = FoliaDiagnostics.inspect(
            pluginPath = pluginPath,
            spwVersion = args.getOrNull(1) ?: FoliaPlugin.SPW_VERSION,
            pluginVersion = FoliaPlugin.PLUGIN_VERSION,
            hostPid = -1L,
        )
        report.checks.forEach { check ->
            println(String.format("%-9s %-38s %s", check.verdict, check.label, check.detail))
            if (check.evidence.isNotBlank()) println("          evidence: " + check.evidence)
            check.fix?.takeIf { check.verdict == FoliaDiagnostics.Verdict.FAIL }?.let {
                println("          fix: $it")
            }
        }
        println()
        println("logLine = " + report.logLine())
        println()
        println("=== SUMMARY (what the issue body carries) ===")
        println(report.summary)

        val failures = report.missing
        if (failures.isNotEmpty()) {
            println()
            println("!!! ${failures.size} FAILED CHECK(S): " + failures.joinToString(",") { it.id })
            // On this reference machine every hard dependency is present; a failure here means the
            // self-check is producing a false alarm again — which is exactly the bug being fixed.
            if (failures.any { it.id == "os" }) {
                println("!!! THE OS CHECK FAILED ON A HEALTHY MACHINE — regression of the reported bug")
                kotlin.system.exitProcess(2)
            }
        }
        if (report.unverified.isNotEmpty()) {
            println("(unknown, not failures: " + report.unverified.joinToString(",") { it.id } + ")")
        }
    }
}
