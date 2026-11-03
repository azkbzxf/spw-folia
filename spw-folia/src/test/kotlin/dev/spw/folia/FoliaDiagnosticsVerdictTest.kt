package dev.spw.folia

import dev.spw.folia.FoliaDiagnostics.Verdict
import dev.spw.folia.FoliaEnvironmentProbe.Evidence
import dev.spw.folia.FoliaEnvironmentProbe.Source
import dev.spw.folia.FoliaEnvironmentProbe.WindowsInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Verdict-level regression tests for the v0.4.14 self-check fixes.
 *
 * The existing `FoliaDiagnosticsTest` asserts the **evidence layer** — that a two-component
 * `os.version` yields no build number. That is one layer too low: it says nothing about the verdict
 * the user actually sees. The v0.4.6 false-FAIL bug was a `when`-branch mistake downstream of the
 * parse, so the tests below pin the **verdict**, which is the thing that shipped wrong.
 *
 * Rule under test, stated in `FoliaDiagnostics`'s own class doc: **a read failure must never become
 * a missing dependency, and absence of evidence must never become a FAIL.**
 */
class FoliaDiagnosticsVerdictTest {

    private fun evidence(value: String?, source: Source = Source.SYSTEM_PROPERTY): Evidence =
        Evidence(value = value, source = source, raw = "test=$value")

    private fun windows(
        build: String? = null,
        arch: String? = null,
        dataModel: String? = null,
    ): WindowsInfo = WindowsInfo(
        osName = evidence("Windows 11"),
        registryBuild = evidence(build, Source.REGISTRY),
        propertyBuild = Evidence(value = null, source = Source.SYSTEM_PROPERTY, raw = "os.version=10.0"),
        ubr = Evidence(value = null, source = Source.REGISTRY),
        displayVersion = Evidence(value = null, source = Source.REGISTRY),
        productName = Evidence(value = null, source = Source.REGISTRY),
        arch = evidence(arch),
        archDataModel = evidence(dataModel),
    )

    // ------------------------------------------------ the v0.4.14 false-FAIL ----

    /**
     * The v0.4.13 bug: `isOs64` returned `false` when the architecture could not be read at all, and
     * `osCheck` turned `!is34` into a hard FAIL 「当前不是 64 位系统」. On a healthy machine.
     *
     * Unreadable architecture is UNKNOWN, never FAIL.
     */
    @Test
    fun `unreadable architecture is unknown, never a failure`() {
        val check = FoliaDiagnostics.osCheck(windows(build = "26300", arch = null, dataModel = null))

        assertEquals(
            "absence of architecture evidence must not become a FAIL (the v0.4.13 bug)",
            Verdict.UNKNOWN,
            check.verdict,
        )
        assertEquals("os", check.id)
    }

    /**
     * An unrecognised `os.arch` spelling is also "cannot tell", not "32-bit". The old code did
     * `arch.lowercase().contains("64")`, which is `false` for any spelling it did not anticipate.
     */
    @Test
    fun `an unrecognised arch spelling is unknown, never a failure`() {
        val check = FoliaDiagnostics.osCheck(windows(build = "26300", arch = "riscv32-mystery", dataModel = null))

        assertEquals(
            "a spelling we do not recognise is not evidence of 32-bit",
            Verdict.UNKNOWN,
            check.verdict,
        )
    }

    /** A genuine 32-bit JVM IS a failure: the x64 helper cannot run there. */
    @Test
    fun `a 32-bit jvm is a real failure`() {
        val check = FoliaDiagnostics.osCheck(windows(build = "26300", arch = "x86", dataModel = "32"))

        assertEquals("a real 32-bit JVM cannot run the helper", Verdict.FAIL, check.verdict)
        assertEquals("os", check.id)
    }

    /** A 64-bit JVM on a good build passes. */
    @Test
    fun `a healthy 64-bit machine passes`() {
        val check = FoliaDiagnostics.osCheck(windows(build = "26300", arch = "amd64", dataModel = "64"))

        assertEquals(Verdict.PASS, check.verdict)
    }

    /**
     * The historical v0.4.6 regression, now pinned at the VERDICT: `os.version = "10.0"` yields no
     * build number, and that must surface as UNKNOWN rather than 「缺少运行环境」.
     */
    @Test
    fun `a build number that cannot be read is unknown, never a failure`() {
        val check = FoliaDiagnostics.osCheck(windows(build = null, arch = "amd64", dataModel = "64"))

        assertEquals(
            "the v0.4.6 false-FAIL class: no build number is UNKNOWN, not FAIL",
            Verdict.UNKNOWN,
            check.verdict,
        )
    }

    /** An old Windows build is a real, actionable failure. */
    @Test
    fun `a build below the floor is a real failure`() {
        val check = FoliaDiagnostics.osCheck(windows(build = "17134", arch = "amd64", dataModel = "64"))

        assertEquals("1803 (17134) is below the 1809 floor", Verdict.FAIL, check.verdict)
    }

    // ------------------------------------------------ isOs64 tri-state ----

    /** `isOs64` must be tri-state so callers cannot accidentally treat "unknown" as "32-bit". */
    @Test
    fun `isOs64 is tri-state`() {
        val unknown: Boolean? = windows(arch = null, dataModel = null).isOs64
        val unrecognised: Boolean? = windows(arch = "sparc", dataModel = null).isOs64

        assertEquals(true, windows(arch = "amd64", dataModel = "64").isOs64)
        assertEquals(false, windows(arch = "x86", dataModel = "32").isOs64)
        assertNull("unreadable must be null, not false", unknown)
        assertNull("an unrecognised spelling must be null, not false", unrecognised)
    }

    /** `arm64` is 64-bit; the old `contains("64")` got this right and must keep doing so. */
    @Test
    fun `arm64 and x86_64 are 64-bit`() {
        assertEquals(true, windows(arch = "aarch64", dataModel = null).isOs64)
        assertEquals(true, windows(arch = "x86_64", dataModel = null).isOs64)
        assertEquals(true, windows(arch = "amd64", dataModel = null).isOs64)
    }

    /** A 32-bit JVM on a 64-bit OS: `os.arch` reads x86, and that is genuinely unusable for us. */
    @Test
    fun `x86 arch without a data model is 32-bit`() {
        assertEquals(false, windows(arch = "x86", dataModel = null).isOs64)
    }
}
