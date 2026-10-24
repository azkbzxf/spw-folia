package dev.spw.folia

import java.util.Locale

/**
 * Tiny JSON helpers.
 *
 * The plugin deliberately bundles no JSON library: the workshop API is compileOnly and the
 * helper protocol only needs (a) escaping strings when building lines and (b) pulling raw
 * JSON sub-values out of incoming lines without re-serialising them (the settings tree must
 * round-trip byte-identically).
 */
internal object Json {

    fun esc(text: String): String {
        val sb = StringBuilder(text.length + 16)
        for (c in text) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append(String.format(Locale.ROOT, "\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    fun str(value: String?): String = if (value == null) "null" else "\"" + esc(value) + "\""

    fun num(value: Double): String {
        if (value.isNaN() || value.isInfinite()) return "0"
        if (value == value.toLong().toDouble()) return value.toLong().toString()
        return String.format(Locale.ROOT, "%.3f", value).trimEnd('0').trimEnd('.')
    }

    fun bool(value: Boolean): String = if (value) "true" else "false"

    /**
     * Returns the raw JSON text (object / array / scalar) stored under [key] in [json],
     * or null when the key is absent. String aware and brace balanced.
     */
    fun rawField(json: String, key: String): String? {
        val needle = "\"" + key + "\""
        var at = json.indexOf(needle)
        while (at >= 0) {
            var i = at + needle.length
            while (i < json.length && json[i].isWhitespace()) i++
            if (i < json.length && json[i] == ':') {
                i++
                while (i < json.length && json[i].isWhitespace()) i++
                if (i >= json.length) return null
                val start = i
                if (json[i] == '{' || json[i] == '[') {
                    var depth = 0
                    var inString = false
                    var escaped = false
                    while (i < json.length) {
                        val c = json[i]
                        if (inString) {
                            when {
                                escaped -> escaped = false
                                c == '\\' -> escaped = true
                                c == '"' -> inString = false
                            }
                        } else {
                            when (c) {
                                '"' -> inString = true
                                '{', '[' -> depth++
                                '}', ']' -> {
                                    depth--
                                    if (depth == 0) return json.substring(start, i + 1)
                                }
                            }
                        }
                        i++
                    }
                    return null
                }
                if (json[i] == '"') {
                    i++
                    var escaped = false
                    while (i < json.length) {
                        val c = json[i]
                        if (escaped) {
                            escaped = false
                        } else if (c == '\\') {
                            escaped = true
                        } else if (c == '"') {
                            return json.substring(start, i + 1)
                        }
                        i++
                    }
                    return null
                }
                while (i < json.length) {
                    val c = json[i]
                    if (c == ',' || c == '}' || c == ']' || c.isWhitespace()) break
                    i++
                }
                return json.substring(start, i)
            }
            at = json.indexOf(needle, at + 1)
        }
        return null
    }

    /** Extracts the (unescaped) string value of [key] from a flat JSON object line. */
    fun stringField(json: String, key: String): String? {
        val raw = rawField(json, key) ?: return null
        if (raw.length < 2 || raw[0] != '"') return null
        val sb = StringBuilder(raw.length)
        var i = 1
        while (i < raw.length - 1) {
            val c = raw[i]
            if (c == '\\' && i + 1 < raw.length - 1) {
                i++
                when (val n = raw[i]) {
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'b' -> sb.append('\b')
                    'f' -> sb.append('\u000c')
                    'u' -> {
                        if (i + 4 < raw.length) {
                            val code = raw.substring(i + 1, i + 5).toIntOrNull(16)
                            if (code != null) {
                                sb.append(code.toChar())
                                i += 4
                            }
                        }
                    }
                    else -> sb.append(n)
                }
            } else {
                sb.append(c)
            }
            i++
        }
        return sb.toString()
    }

    /** Extracts the boolean value of the root-level member [key]; null when absent or not a bool. */
    fun boolField(json: String, key: String): Boolean? {
        val span = findRootMember(json, key) ?: return null
        return when (json.substring(span.valueStart, span.valueEnd).trim()) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

    /**
     * Returns [json] with the root-level member [key] set to a boolean literal.
     *
     * The settings tree has to round-trip byte-identically, so this edits the text instead of
     * re-serialising it: an existing member is rewritten in place and everything else (key order,
     * whitespace, untouched values) stays as it was; a missing member is appended before the closing
     * brace. Non-object input is returned unchanged, so a malformed tree is never made worse.
     */
    fun withBoolMember(json: String, key: String, value: Boolean): String {
        val literal = bool(value)
        val trimmed = json.trim()
        if (trimmed.length < 2 || trimmed[0] != '{' || trimmed[trimmed.length - 1] != '}') return json
        val member = findRootMember(json, key)
        if (member != null) {
            return json.substring(0, member.valueStart) + literal + json.substring(member.valueEnd)
        }
        val close = json.lastIndexOf('}')
        if (close < 0) return json
        var last = close - 1
        while (last > 0 && json[last].isWhitespace()) last--
        val separator = if (json[last] == '{') "" else ","
        val inserted = separator + "\"" + key + "\":" + literal
        return json.substring(0, last + 1) + inserted + json.substring(last + 1)
    }

    private class MemberSpan(val valueStart: Int, val valueEnd: Int)

    /** Finds the root-level member [key] (nested keys are ignored) and returns its value span. */
    private fun findRootMember(json: String, key: String): MemberSpan? {
        var i = json.indexOf('{')
        if (i < 0) return null
        i++
        while (i < json.length) {
            while (i < json.length && json[i].isWhitespace()) i++
            if (i >= json.length || json[i] == '}') return null
            if (json[i] == ',') {
                i++
                continue
            }
            if (json[i] != '"') return null
            val keyStart = i + 1
            i = endOfString(json, i)
            if (i < 0) return null
            val keyEnd = i - 1
            while (i < json.length && json[i].isWhitespace()) i++
            if (i >= json.length || json[i] != ':') return null
            i++
            while (i < json.length && json[i].isWhitespace()) i++
            val valueStart = i
            i = endOfValue(json, i)
            if (i < 0) return null
            if (json.substring(keyStart, keyEnd) == key) return MemberSpan(valueStart, i)
            while (i < json.length && json[i].isWhitespace()) i++
            if (i < json.length && json[i] == ',') i++
        }
        return null
    }

    /** Index just past the string literal that starts at [start] (a quote); -1 when unterminated. */
    private fun endOfString(json: String, start: Int): Int {
        var i = start + 1
        var escaped = false
        while (i < json.length) {
            val c = json[i]
            if (escaped) escaped = false
            else if (c == '\\') escaped = true
            else if (c == '"') return i + 1
            i++
        }
        return -1
    }

    /** Index just past the JSON value starting at [start]; -1 when the text is truncated. */
    private fun endOfValue(json: String, start: Int): Int {
        if (start >= json.length) return -1
        return when (json[start]) {
            '"' -> endOfString(json, start)
            '{', '[' -> {
                var depth = 0
                var i = start
                while (i < json.length) {
                    when (json[i]) {
                        '"' -> {
                            i = endOfString(json, i)
                            if (i < 0) return -1
                            continue
                        }
                        '{', '[' -> depth++
                        '}', ']' -> {
                            depth--
                            if (depth == 0) return i + 1
                        }
                    }
                    i++
                }
                -1
            }
            else -> {
                var i = start
                while (i < json.length) {
                    val c = json[i]
                    if (c == ',' || c == '}' || c == ']' || c.isWhitespace()) break
                    i++
                }
                i
            }
        }
    }
}
