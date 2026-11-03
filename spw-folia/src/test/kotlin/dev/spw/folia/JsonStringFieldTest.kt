package dev.spw.folia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v0.4.14 regression tests for `Json.stringField`'s handling of malformed escapes.
 *
 * `stringField` is the protocol dispatcher: `FoliaHostBridge` does
 * `when (val t = Json.stringField(line, "t"))`. So when a corrupt/truncated host line carries a
 * broken escape, returning a *plausible but wrong* string routes that line into the wrong handler
 * instead of dropping it. The old code silently produced garbage for a bad unicode escape (it
 * neither consumed the four characters nor reported the failure), and an unknown escape became the
 * literal character.
 *
 * Contract: a malformed literal yields **null**, so the caller drops the line.
 *
 * (Note: comments in this file must not contain a literal backslash-u sequence. kapt copies KDoc
 * into Java stubs, and javac rejects an illegal unicode escape even inside a comment.)
 */
class JsonStringFieldTest {

    /** The ordinary cases must keep working exactly as before. */
    @Test
    fun `plain and escaped strings decode as before`() {
        assertEquals("settings", Json.stringField("""{"t":"settings"}""", "t"))
        assertEquals("a\nb", Json.stringField("""{"m":"a\nb"}""", "m"))
        assertEquals("a\tb", Json.stringField("""{"m":"a\tb"}""", "m"))
        assertEquals("q\"q", Json.stringField("""{"m":"q\"q"}""", "m"))
        assertEquals("b\\s", Json.stringField("""{"m":"b\\s"}""", "m"))
        assertEquals("A", Json.stringField("""{"m":"\u0041"}""", "m"))
    }

    /** Skipped keys are still skipped. */
    @Test
    fun `a missing key stays null`() {
        assertNull(Json.stringField("""{"other":"x"}""", "t"))
    }

    /** A truncated four-hex escape is a malformed literal, not text. */
    @Test
    fun `a truncated unicode escape yields null`() {
        assertNull(
            "a cut-off \\u escape must not decode into plausible text",
            Json.stringField("""{"m":"\u12"}""", "m"),
        )
    }

    /** Non-hex digits are equally malformed. */
    @Test
    fun `a non-hex unicode escape yields null`() {
        assertNull(
            "ZZZZ is not hex; the old code emitted the literal characters",
            Json.stringField("""{"m":"\uZZZZ"}""", "m"),
        )
    }

    /**
     * An unknown escape is not a literal character.
     *
     * Before v0.4.14 `\q` decoded to `q`, which is exactly the "plausible but wrong" outcome that
     * lets a corrupt line be dispatched to a real handler.
     */
    @Test
    fun `an unknown escape yields null`() {
        assertNull(Json.stringField("""{"m":"\q"}""", "m"))
    }

    /**
     * The dispatch-relevant case: a message whose type field is corrupt must not be routed as if it
     * were a valid message.
     */
    @Test
    fun `a corrupt message type is dropped rather than misrouted`() {
        val line = """{"t":"\uZZZZ","settings":{}}"""
        assertNull(
            "a corrupt t must be null so FoliaHostBridge's when() falls through to its default",
            Json.stringField(line, "t"),
        )
    }

    /** Valid unicode escapes in the BMP round-trip, including CJK. */
    @Test
    fun `valid unicode escapes including CJK round-trip`() {
        assertEquals("歌词", Json.stringField("""{"m":"\u6b4c\u8bcd"}""", "m"))
        assertEquals("A", Json.stringField("""{"m":"\u0041"}""", "m"))
        assertEquals("\u0000", Json.stringField("""{"m":"\u0000"}""", "m"))
    }

    // -------------------------------------------------- singleLine / round-trip ----

    /**
     * `singleLine` must preserve in-string whitespace byte for byte and drop only token whitespace.
     *
     * A real tab INSIDE a JSON string literal is content, not formatting, so it survives untouched —
     * that is the property that lets a song title carry exactly the bytes the user saved.
     */
    @Test
    fun `singleLine preserves string content and drops token whitespace`() {
        val pretty = "{\n  \"title\": \"a b\tc\",\n  \"n\": 1\n}"
        // The embedded tab survives; the newlines and the spaces around tokens do not.
        assertEquals("""{"title":"a b	c","n":1}""", Json.singleLine(pretty))
    }

    /** Escaped quotes must not confuse the in-string state machine. */
    @Test
    fun `singleLine survives escaped quotes`() {
        val input = """{"s": "he said \"hi\"\n and left"}"""
        val out = Json.singleLine(input)
        assertTrue("no raw newline may survive outside a literal: $out", !out.contains('\n'))
        assertEquals("""{"s":"he said \"hi\"\n and left"}""", out)
    }

    /** A collapsed tree must still be a single physical line — the whole point of the fix. */
    @Test
    fun `singleLine output carries no newline`() {
        val pretty = "{\n\"a\":1,\n\"b\":[1,2]\n}"
        val out = Json.singleLine(pretty)
        assertTrue(out.none { it == '\n' || it == '\r' })
    }
}
