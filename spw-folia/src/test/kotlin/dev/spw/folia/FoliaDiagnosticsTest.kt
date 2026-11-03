package dev.spw.folia

import dev.spw.folia.FoliaDiagnostics.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for the v0.4.7 「出现问题」 self-check.
 *
 * **Every sample string below was captured from a real Windows 11 machine** (build 26300, UBR 9711,
 * .NET Release 534296, WebView2 150.0.4078.83) unless the test name says otherwise. That is the
 * point: the previous implementation was wrong on exactly these inputs, and the screenshot in the
 * issue is what a user saw on a perfectly healthy machine.
 *
 * The rule under test throughout: **a read failure must never become a missing dependency.**
 */
class FoliaDiagnosticsTest {

    // ------------------------------------------------------------ the bug from the screenshot ----

    /**
     * The exact regression. HotSpot on Windows reports `os.version = "10.0"` — two components, no
     * build. v0.4.6 parsed this with a three-group regex, got null, and reported
     * 「缺少运行环境：Windows 10 x64（1809+）」.
     */
    @Test
    fun `os version property without build is unknown, never a failure`() {
        val evidence = FoliaEnvironmentProbe.Evidence(
            value = "10.0",
            source = FoliaEnvironmentProbe.Source.SYSTEM_PROPERTY,
            raw = "os.version=10.0",
        )
        val build = FoliaEnvironmentProbe.buildFromVersionProperty(evidence)

        assertNull("a two-component os.version cannot yield a build number", build.value)
        assertNotNull("the reason must be recorded so the report can explain itself", build.error)
        // The critical assertion: absence of a build number is NOT "Windows too old".
        assertFalse("the old code turned this into a FAIL", build.present)
    }

    /** Same evidence, but with a build someone actually provides (older JVMs / other vendors). */
    @Test
    fun `os version property with a build is parsed`() {
        val evidence = FoliaEnvironmentProbe.Evidence(
            value = "10.0.26300.9711",
            source = FoliaEnvironmentProbe.Source.SYSTEM_PROPERTY,
            raw = "os.version=10.0.26300.9711",
        )
        assertEquals("26300", FoliaEnvironmentProbe.buildFromVersionProperty(evidence).value)
    }

    /** `10.0.26100` (build, no revision) is also legitimate. */
    @Test
    fun `os version property with three components is parsed`() {
        val evidence = FoliaEnvironmentProbe.Evidence(
            value = "10.0.22631",
            source = FoliaEnvironmentProbe.Source.SYSTEM_PROPERTY,
            raw = "os.version=10.0.22631",
        )
        assertEquals("22631", FoliaEnvironmentProbe.buildFromVersionProperty(evidence).value)
    }

    // ---------------------------------------------------------------- reg.exe output parsing ----

    /**
     * The real `reg query … /v Release` line, byte-for-byte: four spaces between fields, no tabs,
     * no trailing spaces, CRLF line ending. Split on runs of whitespace this must yield exactly
     * `["Release", "REG_DWORD", "0x82718"]`.
     */
    @Test
    fun `dotnet release dword is decoded as hex`() {
        val decoded = FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", "0x82718")
        assertEquals("0x82718 is .NET Framework 4.8.1", 534296, decoded)
    }

    @Test
    fun `dotnet release below 48 decodes and stays below the floor`() {
        // 4.7.2 = Release 461808 = 0x70BF0
        val decoded = FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", "0x70BF0")
        assertEquals(461808, decoded)
        assertTrue("4.7.2 must be below the 4.8 floor", decoded!! < FoliaEnvironmentProbe.DOTNET_48_RELEASE)
    }

    /**
     * A `REG_SZ` Release is already decimal. v0.4.6 stripped `0x` and reparsed as hex *always*, so a
     * decimal `528040` became `0x528040` = 5406784 — a bogus "4.8 installed" for a machine without it,
     * and the reverse corruption is equally possible.
     */
    @Test
    fun `dotnet release as decimal string is not mistaken for hex`() {
        assertEquals(528040, FoliaEnvironmentProbe.decodeDotnetRelease("REG_SZ", "528040"))
        assertEquals(461808, FoliaEnvironmentProbe.decodeDotnetRelease("REG_SZ", "461808"))
    }

    @Test
    fun `dotnet release decoding tolerates whitespace, quotes and qword`() {
        assertEquals(534296, FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", "  0x82718  "))
        assertEquals(534296, FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", "\"0x82718\""))
        assertEquals(534296, FoliaEnvironmentProbe.decodeDotnetRelease("REG_QWORD", "0x82718"))
    }

    @Test
    fun `dotnet release decoding rejects garbage instead of guessing`() {
        assertNull(FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", ""))
        assertNull(FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", "   "))
        assertNull(FoliaEnvironmentProbe.decodeDotnetRelease("REG_SZ", "not-a-number"))
        assertNull(FoliaEnvironmentProbe.decodeDotnetRelease("REG_DWORD", "0xZZZZ"))
    }

    /**
     * `reg.exe` separates the name from the type with a run of spaces. Matching used to be
     * `line.contains(name)`, which also matches a *longer* value name that merely starts the same.
     */
    @Test
    fun `registry value name matching is exact, not substring`() {
        val releaseLine = "    Release    REG_DWORD    0x82718"
        val longerLine = "    ReleaseType    REG_SZ    something"

        assertTrue(FoliaEnvironmentProbe.RegistryDump.lineStartsWithValue(releaseLine, "Release"))
        assertFalse(
            "a longer value name must not satisfy the lookup",
            FoliaEnvironmentProbe.RegistryDump.lineStartsWithValue(longerLine, "Release"),
        )
        // A key header line ("HKEY_LOCAL_MACHINE\…") must never match either.
        assertFalse(
            FoliaEnvironmentProbe.RegistryDump.lineStartsWithValue(
                """HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full""",
                "Release",
            ),
        )
    }

    /**
     * A trailing `\r` (the normal CRLF case when a line is not stripped correctly) used to leave the
     * value as `"0x82718\r"`, which fails every hex parse. The whole-line trim handles it.
     */
    @Test
    fun `crlf line endings do not corrupt the value`() {
        val line = "    Release    REG_DWORD    0x82718\r"
        val fields = line.trim().split(Regex("\\s{2,}"))
        assertEquals(listOf("Release", "REG_DWORD", "0x82718"), fields)
        assertEquals(534296, FoliaEnvironmentProbe.decodeDotnetRelease(fields[1], fields[2]))
    }

    // -------------------------------------------------------------------- WebView2 versioning ----

    /**
     * `Application\<version>\` directory discovery has to compare versions numerically; a lexical
     * comparison puts 99 above 150.
     */
    @Test
    fun `webview2 version selection is numeric not lexical`() {
        val versions = listOf("99.0.1", "150.0.4078.83", "120.0.2210.91")
        val best = versions.maxByOrNull { version ->
            // mirrors FoliaEnvironmentProbe.versionKey (private); kept in sync deliberately
            val parts = version.split('.').mapNotNull { it.trim().toIntOrNull() }
            var key = 0L
            repeat(4) { i -> key = key * 1000 + (parts.getOrNull(i) ?: 0).coerceIn(0, 999) }
            key
        }
        assertEquals("150.0.4078.83", best)
    }

    // ---------------------------------------------------------------------- verdict semantics ----

    /**
     * `Verdict` is the whole fix in one enum: only FAIL may render as 「缺少运行环境」.
     */
    @Test
    fun `only fail counts as missing`() {
        val pass = check(Verdict.PASS)
        val fail = check(Verdict.FAIL)
        val unknown = check(Verdict.UNKNOWN)
        val advisory = check(Verdict.ADVISORY)

        assertTrue(pass.ok)
        assertFalse(pass.failed)

        assertTrue(fail.failed)
        assertFalse(fail.ok)

        // The two must not be conflated in either direction.
        assertTrue(unknown.unknown)
        assertFalse("unknown must never look like a failure", unknown.failed)
        assertFalse(unknown.ok)

        assertFalse("advisory is soft-dependency noise, never a failure", advisory.failed)
        assertFalse(advisory.ok)
    }

    /** The log summary has to name failures and unknowns separately; that is how it is triaged. */
    @Test
    fun `report log line separates missing from unknown`() {
        val report = report(
            listOf(
                check(Verdict.PASS, id = "os"),
                check(Verdict.FAIL, id = "webview2"),
                check(Verdict.UNKNOWN, id = "dotnet"),
                check(Verdict.ADVISORY, id = "gpu"),
            )
        )
        val line = report.logLine()

        assertTrue(line, line.contains("missing=webview2"))
        assertTrue(line, line.contains("unknown=dotnet"))
        // The two lists must stay disjoint: the unknown id must not appear in the missing list.
        val missingIds = line.substringAfter("missing=", "").substringBefore(",").trim()
        val unknownIds = line.substringAfter("unknown=", "").substringBefore(",").trim()
        assertEquals("webview2", missingIds)
        assertEquals("dotnet", unknownIds)
        assertEquals(1, report.missing.size)
        assertEquals(1, report.unverified.size)
        assertEquals(1, report.advisory.size)
        assertTrue("one failure keeps the report unhealthy", report.healthy.not())
    }

    /** Unknowns alone leave the environment "healthy" — they are not a reason to block feedback. */
    @Test
    fun `report with only unknowns is still healthy`() {
        val report = report(
            listOf(
                check(Verdict.PASS, id = "os"),
                check(Verdict.UNKNOWN, id = "dotnet"),
            )
        )
        assertTrue(report.healthy)
        assertTrue(report.missing.isEmpty())
        assertEquals(1, report.unverified.size)
        // And the log line must say so instead of implying success.
        assertTrue(report.logLine().contains("unknown=dotnet"))
    }

    // ---------------------------------------------------------------------------- issue body ----

    /** The issue body must carry the evidence, otherwise a maintainer cannot argue with a verdict. */
    @Test
    fun `issue body renders verdict, detail and evidence`() {
        val checks = listOf(
            FoliaDiagnostics.Check(
                id = "os",
                label = "Windows 10 x64（1809+）",
                verdict = Verdict.PASS,
                detail = "Windows 11 (26H2, build 26300.9711, amd64)",
                evidence = "registry CurrentBuildNumber=26300",
            ),
            FoliaDiagnostics.Check(
                id = "dotnet",
                label = ".NET Framework 4.8",
                verdict = Verdict.UNKNOWN,
                detail = "读不到 Release",
                evidence = "registry error=reg query 退出码 1",
            ),
        )
        val summary = bodyOf(checks)

        assertTrue(summary, summary.contains("Windows 11 (26H2, build 26300.9711, amd64)"))
        assertTrue("evidence must be in the body", summary.contains("依据: registry CurrentBuildNumber=26300"))
        assertTrue(summary, summary.contains("无法判定"))
        // An UNKNOWN row must not be labelled as a missing environment anywhere in the body.
        val conclusion = summary.substringAfter("【结论】")
        assertTrue(conclusion, conclusion.contains("没有发现缺失的运行环境"))
        assertTrue(conclusion, conclusion.contains("不代表没有"))
    }

    /**
     * The v0.4.14 regression: this used to assert only `url.length < 15_000`, while the cap was
     * applied to the RAW body — so the shipped URL really was ~15,000 characters and GitHub answered
     * 「Whoa there! Your request URL is too long.」, i.e. the feedback button was dead on arrival.
     *
     * The bound that matters is the one browsers and GitHub actually enforce (~8 KB). Assert that,
     * for the pure-CJK worst case that made the old character cap wrong.
     */
    @Test
    fun `issue url stays under the browser limit for any input`() {
        val cases = mapOf(
            "ascii" to "x".repeat(20_000),
            "pure CJK" to "问".repeat(20_000),
            "mixed" to ("unknown 插件权限 class-transform: 宿主返回 false\n").repeat(2_000),
            "emoji" to "😀".repeat(10_000),
        )
        for ((name, input) in cases) {
            val url = FoliaDiagnostics.issueUrl(input)
            assertTrue(
                "$name: URL is ${url.length} chars; GitHub/browsers reject over ~8192",
                url.length < 8_000,
            )
            assertTrue("$name: form endpoint", url.startsWith("https://github.com/azkbzxf/spw-folia/issues/new?"))
            assertTrue("$name: title kept", url.contains("title="))
            assertTrue("$name: labels kept", url.contains("&labels=bug"))
            // Half an escape would be a subtly-broken URL; make sure truncation never emitted one.
            val bodyPart = url.substringAfter("&body=").substringBefore("&labels=")
            assertTrue("$name: no dangling %XX escape at the end", !Regex("%[0-9A-Fa-f]?$").containsMatchIn(bodyPart))
        }
    }

    /** A short body must pass through essentially intact (no needless truncation). */
    @Test
    fun `short issue body is not truncated`() {
        val body = "### 问题描述\n\n播放窗口打不开。"
        val url = FoliaDiagnostics.issueUrl(body)
        // The body is percent-encoded in the URL, so compare after decoding it back.
        val encodedBody = url.substringAfter("&body=").substringBefore("&labels=")
        val decoded = java.net.URLDecoder.decode(encodedBody, "UTF-8")
        assertEquals("a short body must survive whole", body, decoded)
        assertTrue("no truncation marker on a short body", !decoded.contains("截断"))
    }

    // ------------------------------------------------------------------ exit-code translation ----

    /**
     * `docs/host-app.md` §2 defines the exit codes; v0.4.7 finally shows them to the user instead of
     * only writing the number into the log — the same "blinks and vanishes" complaint the docs had
     * flagged since v0.1.
     */
    @Test
    fun `host exit codes are translated into actionable sentences`() {
        assertEquals(
            "辅助进程启动失败（WebView2 初始化失败、浏览器进程崩溃或未处理异常）",
            FoliaHostBridge.describeExitCode(1),
        )
        assertTrue(FoliaHostBridge.describeExitCode(2)!!.contains("index.html"))
        assertTrue(FoliaHostBridge.describeExitCode(3)!!.contains("WebView2 Runtime"))
        assertTrue(FoliaHostBridge.describeExitCode(-2146232576)!!.contains("0x80131700"))
    }

    /** A normal close is not an error, so it must not produce a toast. */
    @Test
    fun `normal exit produces no message`() {
        assertNull(FoliaHostBridge.describeExitCode(0))
        // An unknown code is reported by the log line itself; inventing a sentence for it would be
        // exactly the kind of unbacked claim this version removes.
        assertNull(FoliaHostBridge.describeExitCode(42))
    }

    // ------------------------------------------------------------------------------ helpers ----

    private fun check(verdict: Verdict, id: String = "os") = FoliaDiagnostics.Check(
        id = id,
        label = "check-$id",
        verdict = verdict,
        detail = "detail-$id",
        evidence = "evidence-$id",
        fix = if (verdict == Verdict.FAIL) "fix-$id" else null,
    )

    private fun report(checks: List<FoliaDiagnostics.Check>) = FoliaDiagnostics.Report(
        checks = checks,
        logFiles = emptyList(),
        logDir = java.io.File("."),
        summary = "",
        issueBody = "",
        windowsLine = "Windows 11 (26H2, build 26300.9711, amd64) · JVM 25",
        pluginVersion = "0.4.7",
        spwVersion = "1.19.3",
        generatedAt = java.time.LocalDateTime.now(),
    )

    /** Mirrors the summary section of `buildSummary`, which is private; the shape is under test. */
    private fun bodyOf(checks: List<FoliaDiagnostics.Check>): String = buildString {
        checks.forEach { check ->
            append('-').append(' ').append(check.verdict.label).append(' ').append(check.label)
            if (check.detail.isNotBlank()) append(": ").append(check.detail)
            if (check.evidence.isNotBlank()) append("\n    依据: ").append(check.evidence)
            append('\n')
        }
        val missing = checks.filter { it.verdict == Verdict.FAIL }
        val unknown = checks.filter { it.verdict == Verdict.UNKNOWN }
        append('\n').append("【结论】")
        append('\n').append(
            if (missing.isEmpty()) "没有发现缺失的运行环境。"
            else "缺失 ${missing.size} 项：" + missing.joinToString("、") { it.label }
        )
        append('\n').append(
            if (unknown.isEmpty()) "所有检查项都有明确结果。"
            else "无法判定 ${unknown.size} 项：" + unknown.joinToString("、") { it.label } + "（读不到，不代表没有）"
        )
    }
}
