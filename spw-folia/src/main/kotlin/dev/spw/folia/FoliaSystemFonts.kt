package dev.spw.folia

import java.awt.GraphicsEnvironment
import java.text.Collator
import java.util.Locale

/**
 * Enumerates the font families installed on this machine so the injected settings UI can offer a
 * font picker that mirrors Salt Player / Folia on Android.
 *
 * Everything here is defensive on purpose: the enumeration runs on the AWT graphics environment and
 * must never throw into the plugin lifecycle (a broken font cache or a headless display can make it
 * fail). Failures degrade to "no font list", and the page keeps its own built-in fallback.
 *
 * The JSON handling is hand-rolled to avoid adding a JSON dependency for a single array member.
 */
object FoliaSystemFonts {
    /** Upper bound for the injected list, keeps the settings tree small (~15 KB worst case). */
    private const val MAX_FAMILIES = 400

    private const val MEMBER_NAME = "systemFonts"

    /** Names are computed once and reused; failures are cached as an empty list (fonts are static). */
    private val cachedFamilies: List<String> by lazy {
        runCatching { loadFamilyNames() }.getOrElse { emptyList() }
    }

    /** Installed font family names, trimmed, de-duplicated, sorted and capped. Never throws. */
    fun familyNames(): List<String> = cachedFamilies

    // ---------------------------------------------------------------------------------------
    // Settings-tree plumbing
    // ---------------------------------------------------------------------------------------

    /**
     * Returns [json] with a top-level `"systemFonts":[...]` member holding the installed families.
     *
     * Behaviour:
     * - input that is not a well-formed JSON object is returned completely unchanged (a broken tree
     *   must never be corrupted any further);
     * - an existing `systemFonts` member has its value replaced in place, so the rest of the tree
     *   keeps its exact original bytes;
     * - otherwise the member is inserted immediately after the opening `{`.
     *
     * When the tree already carries the exact payload the same String instance is returned, which
     * lets callers skip re-sending an unchanged tree.
     */
    fun mergeSystemFontsJson(json: String): String {
        val array = runCatching { arrayJson() }.getOrNull() ?: return json
        if (array.isEmpty()) return json
        return runCatching {
            val span = findMember(json) ?: return@runCatching insertMember(json, array) ?: json
            if (json.regionMatches(span.valueStart, array, 0, array.length) &&
                span.valueEnd - span.valueStart == array.length
            ) {
                return@runCatching json
            }
            json.substring(0, span.valueStart) + array + json.substring(span.valueEnd)
        }.getOrDefault(json)
    }

    /**
     * Removes the injected `"systemFonts"` member from a settings tree before it is persisted.
     *
     * The list is derived data (recomputed on every plugin start), so persisting it would only bloat
     * the settings file by a few KB of names that go stale whenever a font is installed. Input that
     * is not a JSON object, or that has no such member, is returned byte for byte unchanged.
     */
    fun withoutSystemFontsJson(json: String): String {
        return runCatching {
            val span = findMember(json) ?: return@runCatching json
            var tail = span.valueEnd
            while (tail < json.length && json[tail].isJsonSpace()) tail++
            val hasFollowingComma = tail < json.length && json[tail] == ','
            // Removing a middle member must eat exactly one separator, or the object ends up with a
            // double comma. Prefer the following one and only fall back to the preceding one when
            // this member is last.
            val start = if (hasFollowingComma) {
                span.keyStart
            } else {
                var before = span.keyStart - 1
                while (before >= 0 && json[before].isJsonSpace()) before--
                if (before >= 0 && json[before] == ',') before else span.keyStart
            }
            val end = if (hasFollowingComma) tail + 1 else tail
            json.removeRange(start, end)
        }.getOrDefault(json)
    }

    // ---------------------------------------------------------------------------------------
    // Font enumeration
    // ---------------------------------------------------------------------------------------

    private fun loadFamilyNames(): List<String> {
        val environment = GraphicsEnvironment.getLocalGraphicsEnvironment()
        val raw = environment.availableFontFamilyNames ?: return emptyList()
        val seen = HashSet<String>(raw.size * 2)
        val names = ArrayList<String>(raw.size)
        for (entry in raw) {
            val name = entry?.trim() ?: continue
            if (name.isEmpty()) continue
            // Some Windows fonts register the same family twice with different casing.
            if (!seen.add(name.lowercase(Locale.ROOT))) continue
            names.add(name)
        }
        names.sortWith(fontNameComparator())
        return if (names.size > MAX_FAMILIES) names.subList(0, MAX_FAMILIES).toList() else names
    }

    /**
     * Latin names first (A-Z, case-insensitive) then CJK names collated for a Chinese user, so the
     * picker does not interleave `微软雅黑` between `Arial` and `Bahnschrift`.
     */
    private fun fontNameComparator(): Comparator<String> {
        val collator = runCatching { Collator.getInstance(Locale.CHINA) }.getOrNull()
        return Comparator { left, right ->
            val leftCjk = left.hasCjk()
            if (leftCjk != right.hasCjk()) {
                if (leftCjk) 1 else -1
            } else {
                val collated = runCatching { collator?.compare(left, right) }.getOrNull()
                collated ?: left.compareTo(right, ignoreCase = true)
            }
        }
    }

    private fun String.hasCjk(): Boolean = any { it in '\u3400'..'\u9FFF' }

    private fun arrayJson(): String {
        val families = familyNames()
        if (families.isEmpty()) return ""
        val builder = StringBuilder(families.size * 16)
        builder.append('[')
        for (index in families.indices) {
            if (index > 0) builder.append(',')
            // Reuse the shared escaper instead of hand-rolling a second one.
            builder.append(Json.str(families[index]))
        }
        builder.append(']')
        return builder.toString()
    }

    private fun Char.isJsonSpace(): Boolean = this == ' ' || this == '\t' || this == '\n' || this == '\r'

    // ---------------------------------------------------------------------------------------
    // Minimal structural scanner (only the root object is inspected — page data is opaque)
    // ---------------------------------------------------------------------------------------

    private class MemberSpan(val keyStart: Int, val valueStart: Int, val valueEnd: Int)

    /** Finds the root-level `"systemFonts"` member; null when absent or when [json] is malformed. */
    private fun findMember(json: String): MemberSpan? {
        var index = 0
        while (index < json.length && json[index].isJsonSpace()) index++
        if (index >= json.length || json[index] != '{') return null
        if (!isWellFormedObject(json)) return null

        var depth = 1
        index++
        while (index < json.length) {
            val character = json[index]
            when {
                character == '"' -> {
                    val stringStart = index
                    val stringEnd = endOfString(json, index)
                    if (stringEnd < 0) return null
                    var after = stringEnd + 1
                    while (after < json.length && json[after].isJsonSpace()) after++
                    if (depth == 1 && after < json.length && json[after] == ':') {
                        // A key of the root object: capture where its value starts.
                        if (json.substring(stringStart + 1, stringEnd) == MEMBER_NAME) {
                            var valueStart = after + 1
                            while (valueStart < json.length && json[valueStart].isJsonSpace()) valueStart++
                            val valueEnd = endOfValue(json, valueStart)
                            if (valueEnd <= valueStart) return null
                            return MemberSpan(stringStart, valueStart, valueEnd)
                        }
                        // Skip straight to the value so its braces do not disturb the depth counter.
                        var valueStart = after + 1
                        while (valueStart < json.length && json[valueStart].isJsonSpace()) valueStart++
                        val valueEnd = endOfValue(json, valueStart)
                        if (valueEnd <= valueStart) return null
                        index = valueEnd
                        continue
                    } else {
                        index = stringEnd + 1
                        continue
                    }
                }
                character == '{' || character == '[' -> depth++
                character == '}' || character == ']' -> {
                    depth--
                    if (depth == 0) return null
                }
            }
            index++
        }
        return null
    }

    private fun firstNonSpace(json: String): Int {
        var index = 0
        while (index < json.length && json[index].isJsonSpace()) index++
        return if (index < json.length) index else -1
    }

    /** True when [json] starts with `{`, ends with `}` and all braces/strings balance. */
    private fun isWellFormedObject(json: String): Boolean {
        val start = firstNonSpace(json)
        if (start < 0 || json[start] != '{') return false
        var end = json.length - 1
        while (end > start && json[end].isJsonSpace()) end--
        if (end <= start || json[end] != '}') return false
        var depth = 0
        var inString = false
        var escaped = false
        var index = start
        while (index <= end) {
            val character = json[index]
            if (inString) {
                when {
                    escaped -> escaped = false
                    character == '\\' -> escaped = true
                    character == '"' -> inString = false
                }
            } else {
                when (character) {
                    '"' -> inString = true
                    '{', '[' -> depth++
                    '}', ']' -> {
                        depth--
                        if (depth < 0) return false
                    }
                }
            }
            index++
        }
        return depth == 0 && !inString
    }

    private fun insertMember(json: String, array: String): String? {
        val brace = firstNonSpace(json)
        if (brace < 0 || json[brace] != '{' || !isWellFormedObject(json)) return null
        var next = brace + 1
        while (next < json.length && json[next].isJsonSpace()) next++
        val separator = if (next < json.length && json[next] == '}') "" else ","
        val member = "\"" + MEMBER_NAME + "\":" + array
        return json.substring(0, brace + 1) + member + separator + json.substring(brace + 1)
    }

    /** Index of the closing quote of the string starting at [start], or -1. */
    private fun endOfString(json: String, start: Int): Int {
        var index = start + 1
        while (index < json.length) {
            when (json[index]) {
                '\\' -> index += 2
                '"' -> return index
                else -> index++
            }
        }
        return -1
    }

    /** Exclusive end index of the JSON value starting at [start], or -1. */
    private fun endOfValue(json: String, start: Int): Int {
        if (start >= json.length) return -1
        return when (json[start]) {
            '"' -> endOfString(json, start).let { if (it < 0) -1 else it + 1 }
            '{', '[' -> endOfContainer(json, start)
            else -> endOfScalar(json, start)
        }
    }

    private fun endOfContainer(json: String, start: Int): Int {
        var depth = 0
        var inString = false
        var escaped = false
        var index = start
        while (index < json.length) {
            val character = json[index]
            if (inString) {
                when {
                    escaped -> escaped = false
                    character == '\\' -> escaped = true
                    character == '"' -> inString = false
                }
            } else {
                when (character) {
                    '"' -> inString = true
                    '{', '[' -> depth++
                    '}', ']' -> {
                        depth--
                        if (depth == 0) return index + 1
                        if (depth < 0) return -1
                    }
                }
            }
            index++
        }
        return -1
    }

    private fun endOfScalar(json: String, start: Int): Int {
        var index = start
        while (index < json.length) {
            val character = json[index]
            if (character == ',' || character == '}' || character == ']' || character.isJsonSpace()) break
            index++
        }
        return if (index > start) index else -1
    }
}
