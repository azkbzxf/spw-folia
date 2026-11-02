package dev.spw.folia

import java.lang.reflect.Constructor
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.lang.reflect.Modifier

/**
 * Structure-first resolution of the *obfuscated* host members that have no stable name.
 *
 * Why this file exists
 * --------------------
 * The Steam workshop "插件开发建议" post by Salt Player's own developer makes the point directly:
 * SPW is R8-obfuscated and **every build renames the obfuscated classes and methods**, so a plugin
 * that hardcodes them breaks with `NoSuchMethodException` / `ClassNotFoundException` the moment the
 * player updates — and the obfuscated names differ between the Windows and Linux builds of the same
 * version. The post's prescribed fix is to locate members through *compilation-stable features*:
 * Kotlin `@Metadata`, parameter/return type combinations, implemented interfaces, member layout —
 * and to cache whatever was found.
 *
 * [HostTargets] already applies that idea to the flyout; this file applies it to the playback
 * controller's queue model, which until now pinned five raw obfuscated identifiers
 * (`\u037F`, `\u0528`…`\u052B`) and therefore sat exactly on the failure mode the post warns about.
 *
 * Two independent strategies, both name-independent
 * -------------------------------------------------
 * 1. **`@Metadata` property names** ([kotlinPropertyName]). R8 keeps Kotlin metadata by default, and
 *    the metadata retains the *original* source names — verified on the current host build:
 *    `PlaybackQueueState`'s metadata still contains `mode` / `normalQueue` / `normalIndex` /
 *    `randomQueue` / `randomIndex`, and the class that was R8-renamed to `\u037F` still carries
 *    `Lcom/xuncorp/spc/core/queue/PlaybackQueueItem` in its metadata. The getter for a property
 *    named `normalQueue` is then `getNormalQueue()` — a name no rename can change, because it is
 *    derived from source, not from the obfuscator.
 * 2. **Structural signature matching** ([matchByType]) when metadata is stripped. Each getter is
 *    identified by its return type plus the *positional relationship* between the four queue
 *    accessors: the state object declares exactly one mode getter, one list/int pair for the normal
 *    queue and one for the random queue. The two pairs are distinguishable without names because
 *    the metadata-declared *declaration order* is stable in the class file (R8 preserves member
 *    ordering), and because [kotlinPropertyName] — when available — disambiguates outright.
 *
 * Everything here is resolved **once** and cached by the caller ([FoliaPlaybackControls.handles]);
 * the post explicitly warns that repeated reflection or repeated metadata parsing is a performance
 * problem, so no lookup in this file happens on a per-frame path.
 *
 * Nothing in this file throws for "not found": every entry point returns null so the caller can fall
 * back to its last-known-good names instead of losing the feature.
 */
internal object HostMemberResolver {

    // ------------------------------------------------------------------ Kotlin metadata ----

    /**
     * Kotlin `@Metadata` as an annotation *type*, loaded reflectively because the plugin does not
     * compile against kotlin-reflect and the annotation may be absent in a host build compiled by a
     * different toolchain.
     *
     * `d2` is the string table of the metadata: for a class it holds the property names (and, for
     * R8-renamed types, the original type references). `d1` is protobuf and deliberately not parsed
     * here — the string table is enough for name recovery and does not need kotlinx-metadata.
     */
    private const val METADATA_ANNOTATION = "kotlin.Metadata"

    /** Set of strings carried by the class's `@Metadata(d2 = [...])`, or null when absent. */
    fun metadataStrings(type: Class<*>): Set<String>? {
        // `@Metadata` is read in Java (KotlinMetadata) because Kotlin's `Class.getDeclaredAnnotations()`
        // is typed as Array<kotlin.Annotation>, which has no annotationType(). Matching the annotation
        // by *name* is also the only loader-independent test: the annotation instance is created by the
        // host's classloader, so comparing Class objects across loaders would always fail.
        val d2 = try {
            KotlinMetadata.metadataD2(type)
        } catch (_: Throwable) {
            null
        } ?: return null
        return d2.filterNotNull().toSet()
    }

    /**
     * Original Kotlin property names declared by [type], recovered from `@Metadata`.
     *
     * `d2` for a class is a flat table holding both the property names *and* type references, so the
     * caller still filters by "does a getter of this name exist with the expected shape". That keeps
     * the lookup honest: a name recovered from metadata is only trusted once reflection confirms a
     * matching member, which is the same "validate before use" rule [HostTargets] follows.
     *
     * Entries in `d2` are a mix of:
     *   - type refs: `Lcom/x/...;`, `()Ljava/util/List;` — dropped by the flat-name test,
     *   - JVM member names: `getNormalQueue`, `<init>`, `component1` — dropped as non-properties,
     *   - source property names: `mode`, `normalQueue`, … — what this returns.
     */
    fun kotlinPropertyNames(type: Class<*>): Set<String> {
        val strings = metadataStrings(type) ?: return emptySet()
        return strings.filter { isPropertyName(it) }.toSet()
    }

    /**
     * A d2 entry is a source property name when it is a plain lower-camel identifier: no `/`, `;`,
     * `(`, `<`, no spaces, and not starting with an uppercase letter (those are type simple names).
     * Synthetic Kotlin names (`component1`, `copy`, `equals`) end up in this set too — harmless,
     * because every caller looks a specific expected name up rather than trusting the whole set.
     */
    private fun isPropertyName(entry: String): Boolean {
        if (entry.isEmpty()) return false
        val first = entry[0]
        if (!first.isLowerCase()) return false
        for (ch in entry) {
            val ok = ch.isLetterOrDigit() || ch == '_' || ch == '$'
            if (!ok) return false
        }
        return true
    }

    /** The getter Kotlin would generate for property [property] (`normalQueue` → `getNormalQueue`). */
    fun getterNamesFor(property: String): List<String> {
        if (property.isEmpty()) return emptyList()
        val capitalized = property[0].uppercaseChar() + property.substring(1)
        // `isX` properties keep their name (`isReady` → `isReady()`), boolean getters included.
        return listOf("get$capitalized", property)
    }

    /**
     * The `@Metadata` property names of a class **in declaration order**, or null when absent.
     *
     * This is the load-bearing primitive for name-free resolution. R8 renames the *JVM* members but
     * keeps the Kotlin metadata, whose `d2` table lists the source property names in the order the
     * data class declares them. That order is identical in the class file's field table — verified on
     * the current host build:
     *
     *   metadata: `mode, normalQueue, normalIndex, randomQueue, randomIndex`
     *   fields:   `\u037F Mode`, `\u0528 List`, `\u0529 int`, `\u052A List`, `\u052B int`
     *
     * So the strategy is: read the *names* from metadata (stable across R8 passes) and the *members*
     * by position, then zip them by that shared declaration order. Nothing depends on the obfuscated
     * JVM identifier, which is exactly what the workshop post asks for.
     *
     * Note this deliberately does NOT return `getNormalQueue`-style names: R8 renames methods too, so
     * no such method exists on the obfuscated class (verified against the live host). The property
     * names are only a *positional key* into the member list.
     */
    fun metadataPropertyOrder(type: Class<*>): List<String>? {
        val d2 = try {
            KotlinMetadata.metadataD2(type)
        } catch (_: Throwable) {
            null
        } ?: return null
        val synthetic = setOf(
            "copy", "equals", "hashCode", "toString", "other", "areEqual",
            "checkNotNullParameter", "makeConcatWithConstants",
        )
        return d2.filterNotNull()
            .filter { isPropertyName(it) }
            .filter { it !in synthetic && !it.startsWith("component") && !it.startsWith("get") }
            .toList()
    }

    // -------------------------------------------------------------- structural matching ----

    /**
     * Zero-arg instance methods of [type], optionally restricted to getters.
     *
     * Only `public` and *declared* members are considered: the queue state is a `final` Kotlin data
     * class, so walking the hierarchy would only add `Object` noise. Sorted by {@link Class#getDeclaredMethods}
     * order, which the class file preserves and R8 does not reorder.
     */
    fun getters(type: Class<*>): List<Method> = try {
        type.declaredMethods.filter { method ->
            method.parameterCount == 0 &&
                !Modifier.isStatic(method.modifiers) &&
                !method.name.contains('$') &&
                method.returnType != Void.TYPE &&
                method.name != "toString" && method.name != "hashCode"
        }
    } catch (_: Throwable) {
        emptyList()
    }

    /**
     * Zero-arg instance methods satisfying [predicate], in **field declaration order** where the
     * method is a property accessor.
     *
     * Ordering matters for every caller that zips these results against a role list (normal vs random
     * queue). `getters()` returns `getDeclaredMethods()` order, which R8 shuffles; this method returns
     * field order first (the authoritative data-class component order) and appends any remaining
     * non-field-backed methods afterwards so nothing is dropped.
     */
    fun matchByType(type: Class<*>, predicate: (Method) -> Boolean): List<Method> {
        val ordered = ArrayList<Method>()
        val seen = HashSet<Method>()
        for ((_, getter) in fieldAccessorsInOrder(type)) {
            if (predicate(getter) && seen.add(getter)) ordered.add(getter)
        }
        for (getter in getters(type)) {
            if (predicate(getter) && seen.add(getter)) ordered.add(getter)
        }
        return ordered
    }

    /**
     * The class's property accessors in **field declaration order**, each paired with the backing
     * field it reads.
     *
     * This is the only ordering authority that survives R8 — established empirically on the live host:
     *
     *   field order   (`getDeclaredFields`) : \u037F Mode, \u0528 List, \u0529 int, \u052A List, \u052B int, \u052C boolean
     *   getter order  (`getDeclaredMethods`): \u052B int, \u0529 int, \u052A List, \u037F Mode, \u0528 List, \u052C boolean
     *
     * The method table is **shuffled**; the field table keeps the data-class component (source)
     * order. Pairing "i-th getter of type T with i-th field of type T" is therefore wrong, and any
     * bucket-then-zip over getter order silently swaps normal/random — a bug the verification suite
     * caught on this exact host.
     *
     * The link used here is: a field and its getter carry the **same obfuscated name** (`\u0528` field
     * ↔ `\u0528()` getter) and the same type. Both conditions are structural, not name-derived. When a
     * build breaks that correspondence, the entry is matched by type instead (and, if ambiguous,
     * dropped) so the caller can fall back rather than assign a wrong role.
     */
    fun fieldAccessorsInOrder(type: Class<*>): List<Pair<Field, Method>> {
        val fields = declaredFields(type)
        val getters = getters(type)
        val used = HashSet<Method>()
        val result = ArrayList<Pair<Field, Method>>(fields.size)

        // Match by name: real R8 output keeps field and accessor names in sync — verified on the live
        // host, where field Ԩ pairs with getter Ԩ() and both are the same component.
        //
        // Anything that does NOT match by name is deliberately left unresolved. A per-type positional
        // guess was tried and rejected: when accessor names diverge from field names, the reflective
        // method table is ordered arbitrarily, so "i-th List field <- i-th List getter" silently swaps
        // normal/random. Returning a *partial* list lets the caller fall through to its own fallback
        // (and ultimately to the pinned ids) instead of acting on a wrong role assignment.
        for (field in fields) {
            val hit = getters.firstOrNull {
                it !in used && it.name == field.name && typesAgree(it.returnType, field.type)
            }
            if (hit != null) {
                used.add(hit)
                result.add(field to hit)
            }
        }
        return result
    }

    private fun typesAgree(getterType: Class<*>, fieldType: Class<*>): Boolean =
        getterType == fieldType ||
            (getterType.isPrimitive && boxed(getterType) == fieldType) ||
            (fieldType.isPrimitive && boxed(fieldType) == getterType)

    private fun boxed(type: Class<*>): Class<*>? = when (type) {
        java.lang.Integer.TYPE -> java.lang.Integer::class.java
        java.lang.Boolean.TYPE -> java.lang.Boolean::class.java
        java.lang.Long.TYPE -> java.lang.Long::class.java
        java.lang.Double.TYPE -> java.lang.Double::class.java
        java.lang.Float.TYPE -> java.lang.Float::class.java
        else -> null
    }

    /**
     * `[normalQueue, normalIndex]`, `[randomQueue, randomIndex]` — in field declaration order.
     *
     * Built from [fieldAccessorsInOrder], so the i-th `List` component pairs with the i-th `int`
     * component exactly as the data class declares them.
     */
    fun listIntPairs(type: Class<*>): List<Pair<Method, Method>> {
        val accessors = fieldAccessorsInOrder(type)
        val listGetters = accessors.filter { isListReturn(it.first.type) }.map { it.second }
        val intGetters = accessors.filter { isIntReturn(it.first.type) }.map { it.second }
        if (listGetters.size < 2 || intGetters.size < 2) return emptyList()
        return listOf(listGetters[0] to intGetters[0], listGetters[1] to intGetters[1])
    }

    /** The nested class of [parent] whose values are all instances of [parent] (Kotlin `enum`). */
    fun enumNestedClass(parent: Class<*>): Class<*>? = try {
        parent.declaredClasses.firstOrNull { nested ->
            nested.isEnum || (nested.superclass == Enum::class.java && nested.isEnum)
        }
    } catch (_: Throwable) {
        null
    }

    /**
     * A single-argument constructor whose parameter is [owner] itself: the signature of a Kotlin
     * `data class` copy helper (`copy(id: Int, data: Any?)`, obfuscated to `\u037F`). Used to confirm
     * that a type really is the queue item model rather than "some class with an int and an object".
     */
    fun selfTypedFactory(type: Class<*>): Method? = try {
        type.declaredMethods.firstOrNull { method ->
            Modifier.isStatic(method.modifiers) &&
                method.parameterCount == 2 &&
                method.parameterTypes[0] == type &&
                isIntReturn(method.returnType)
        }
    } catch (_: Throwable) {
        null
    }

    /** Fields of [type] in declaration order (data-class components are declared in order). */
    fun declaredFields(type: Class<*>): List<Field> = try {
        type.declaredFields.filter { !Modifier.isStatic(it.modifiers) }
    } catch (_: Throwable) {
        emptyList()
    }

    /** First constructor of [type] with [arity] parameters, preferring the widest one. */
    fun constructorOf(type: Class<*>, arity: Int): Constructor<*>? = try {
        type.declaredConstructors.firstOrNull { it.parameterCount == arity }
    } catch (_: Throwable) {
        null
    }

    // --------------------------------------------------------------------- type helpers ----

    fun isIntReturn(type: Class<*>): Boolean =
        type == Int::class.java || type == Int::class.javaObjectType

    fun isListReturn(type: Class<*>): Boolean =
        Collection::class.java.isAssignableFrom(type)
}
