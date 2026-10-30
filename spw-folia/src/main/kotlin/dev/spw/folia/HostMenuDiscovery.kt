package dev.spw.folia

import java.io.File

/**
 * Structural discovery of the SPW "更多" flyout entry points from host **bytecode**.
 *
 * Why this file exists
 * --------------------
 * Every SPW release runs the host through R8 again, which renames the whole
 * `PlayerMoreMenuFlyout` facade (`androidx.compose.ui.<greek letter>`), its four-item helper and
 * the `MenuFlyoutScope` / `PopupState` interfaces. Up to v0.4.4 the plugin carried hardcoded
 * per-version name profiles in [HostTargets] and refused unknown builds, so a rename broke the
 * `Folia` entry until a profile was hand-written. This module replaces that with a *structural*
 * walk over the host's call graph ([HostBytecodeIndex]): every step pins down one role by its
 * shape (parameter lists, a self-referential Kotlin default-argument bridge, call sites of
 * Compose entry points) and never by an obfuscated name.
 *
 * Discipline (inherited from SPW-Lyrics' `HostPlayerMenuDiscovery`)
 * ---------------------------------------------------------------
 *  * each step must resolve to exactly **one** candidate; anything else throws
 *    `IllegalStateException` with the role name and the candidate count. No best-effort picks:
 *    invoking the wrong method in the host would corrupt the flyout silently.
 *  * class names handed to callers are **binary dotted** names (`androidx.compose.ui.ɦ`) while the
 *    index speaks JVM **internal** names (`androidx/compose/ui/ɦ`); the conversion happens once,
 *    here, because v0.4.4 shipped the raw internal form and every `Class.forName` failed.
 *  * optional decorations (palette colour, native label renderer) degrade to `null`; the flyout
 *    entry itself is the only hard requirement.
 *
 * Verified on SPW 1.19.3 (`app/ffmpeg-x64.dll`, 2026-10-30): the six required roles resolve
 * uniquely and reproduce the hand-verified names in [HostTargets.PROFILES] — menu facade
 * `androidx.compose.ui.ɦ` (U+0266), helper `Ϳ` (U+037F), scope `त` (U+0924), bridge `Ϳ`,
 * popup state `ל` (U+05DC), dismiss `ԩ` (U+0529).
 */
internal object HostMenuDiscovery {

    /** Everything needed to append one item to the live flyout on this host build. */
    data class MenuTarget(
        /** Binary dotted name of the Compose file facade that owns the four-item helper. */
        val menuClass: String,
        /** Name of the static helper that appends the host's own items. */
        val addItemsMethod: String,
        /** Parameter types in order, as reflection-style binary names (used by `hookMethod`). */
        val addItemsParams: List<String>,
        /** Binary dotted name of the `MenuFlyoutScope` interface. */
        val scopeClass: String,
        /** Static Kotlin default-argument bridge `item(onClick, content)` on [scopeClass]. */
        val scopeBridge: String,
        /** Binary dotted name of the popup state type, when it could be resolved. */
        val popupStateClass: String?,
        /** `dismiss()` name on the popup state; closes the flyout after a click. */
        val popupDismiss: String?,
        /** Index of [scopeClass] inside [addItemsParams] — the hook reads its callback argument. */
        val scopeParameter: Int,
        /** Index of [popupStateClass] inside [addItemsParams]. */
        val popupParameter: Int,
        /** Optional host-native label renderer, reused so Folia items match host styling. */
        val labelMethod: String? = null,
        /** Where this target came from, for the plugin log (`scan`). */
        val origin: String = "scan",
    ) {
        /** `Track, PiscesMediaItem, …` — log-friendly signature without package prefixes. */
        val shortSignature: String
            get() = addItemsParams.joinToString(", ") { it.substringAfterLast('.') }
    }

    /** `PaletteAccessor(Composer)` → palette object → `colorMethod(): Color(long)`. */
    data class PaletteTarget(
        val accessorClass: String,
        val accessorMethod: String,
        val paletteClass: String,
        val colorMethod: String,
        val origin: String = "scan",
    )

    /**
     * Result of one discovery pass. [menu] is mandatory; [palette] and the per-role
     * [diagnostics] lines are informational (a host build may legitimately drop them).
     *
     * [candidateCounts] records how many candidates each role matched on this host build
     * (`owner`, `popup`, `entry`, `popupState`, `itemBridge`, `builder`, `scopeParameter`,
     * `popupParameter`, `dismiss`, `label`, `palette`). On the success path every required role is
     * `1`; the map is meant for cache files and support logs, so a future build that starts
     * drifting can be diagnosed without re-running the scan. Roles that were never reached (because
     * an earlier step threw) are simply absent.
     */
    data class Discovery(
        val menu: MenuTarget,
        val palette: PaletteTarget?,
        val diagnostics: List<String> = emptyList(),
        val candidateCounts: Map<String, Int> = emptyMap(),
    )

    // ------------------------------------------------------------------- shapes ----

    /** Host service that only the "更多" flyout facade tears down. */
    private const val PLAYBACK_CONTROLLER = "com/xuncorp/voxzen/service/PlaybackController"
    private const val RELEASE_AUDIO_ENGINE = "releaseAudioEngine"

    /** `BlurPopupMenu(...)` call site inside the flyout entry composable. */
    private const val POPUP_CALL =
        "(Lkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function2;" +
            "Lkotlin/jvm/functions/Function1;Landroidx/compose/runtime/Composer;II)V"

    /** Host-native flyout row (`TextLabel`-style composable) — reused for our own item. */
    private const val LABEL_CALL =
        "(Ljava/lang/String;Landroidx/compose/ui/Modifier;Lkotlin/jvm/functions/Function2;" +
            "ZLandroidx/compose/runtime/Composer;II)V"

    private const val COMPOSER = "Landroidx/compose/runtime/Composer;"
    private const val FUNCTION0 = "Lkotlin/jvm/functions/Function0;"
    private const val FUNCTION2 = "Lkotlin/jvm/functions/Function2;"
    private const val UNIT = "Lkotlin/Unit;"
    private const val MUTABLE_STATE = "Landroidx/compose/runtime/MutableState;"

    // Anchors that R8 cannot rename: host data/navigation types and Compose runtime types.
    private const val TRACK = "Lcom/xuncorp/voxzen/data/entity/Track;"
    private const val MEDIA_ITEM = "Lcom/xuncorp/pisces/PiscesMediaItem;"
    private const val NAVIGATOR = "Lcom/xuncorp/voxzen/ui/navigation/Navigator;"
    private const val STATE = "Landroidx/compose/runtime/State;"

    /** `ACC_STATIC` from the JVM class-file access flags. */
    private const val ACC_STATIC = 0x0008

    /** Palette content colour getter (`Ԩ`, U+0528) in the 1.19.x palettes. */
    private const val PALETTE_CONTENT_COLOR = "\u0528"

    private const val PALETTE_ACCESSOR_PREFIX = "(Landroidx/compose/runtime/Composer;)Landroidx/compose/ui/"

    // -------------------------------------------------------------------- entry ----

    /**
     * Resolves the flyout targets from an already built [HostBytecodeIndex.Index].
     *
     * Throws [IllegalStateException] when any **required** role is ambiguous or missing; returns
     * [Discovery] with `palette = null` when only the optional colour palette cannot be pinned
     * down (the caller falls back to its own constants).
     */
    fun discover(index: HostBytecodeIndex.Index): Discovery {
        val diagnostics = ArrayList<String>(8)
        val counts = LinkedHashMap<String, Int>(12)
        val menu = discoverMenu(index, diagnostics, counts)
        val palette = discoverPalette(index, diagnostics, counts)
        return Discovery(menu, palette, diagnostics.toList(), counts.toMap())
    }

    /** Convenience overload: reads the host code source and discovers in one call. */
    fun discover(host: Class<*>): Discovery = discover(HostBytecodeIndex.read(host))

    /** Convenience overload for an extracted host image (`ffmpeg-x64.dll` / jar / class dir). */
    fun discover(source: File): Discovery = discover(HostBytecodeIndex.read(source))

    // --------------------------------------------------------------------- menu ----

    private fun discoverMenu(
        index: HostBytecodeIndex.Index,
        diagnostics: MutableList<String>,
        counts: MutableMap<String, Int>,
    ): MenuTarget {
        // 1. The facade that owns the flyout: the only class whose method bodies call
        //    PlaybackController.releaseAudioEngine (the host stops playback before dismissing).
        val owner = unique(
            index.methods().asSequence()
                .filter { body ->
                    body.calls.any { it.owner == PLAYBACK_CONTROLLER && it.name == RELEASE_AUDIO_ENGINE }
                }
                .map { it.method.owner }
                .distinct()
                .toList(),
            "播放器菜单 facade 类",
            "owner",
            counts,
        )
        diagnostics += "菜单 facade 类 = ${codepoints(owner)}"

        val ownerBodies = index.methods().filter { it.method.owner == owner }

        // 2. The popup composable call site: one fixed Compose signature, unique in the facade.
        val popup = unique(
            ownerBodies.flatMap { it.calls }.filter { it.descriptor == POPUP_CALL }.distinct(),
            "弹出菜单调用点",
            "popup",
            counts,
        )
        diagnostics += "弹出菜单调用点 = ${codepoints(popup.owner)}.${codepoints(popup.name)}"

        // 3. The facade method that opens the popup (the `onClick` lambda body lives here).
        val entry = unique(
            ownerBodies.filter { it.calls.contains(popup) },
            "菜单入口方法",
            "entry",
            counts,
        )
        diagnostics += "菜单入口方法 = ${codepoints(entry.method.name)}${codepoints(entry.method.descriptor)}"

        // 4. The popup state: the only non-Composer object parameter of the entry method.
        val popupStateType = unique(
            parameterDescriptors(entry.method.descriptor).orEmpty()
                .filter { it.startsWith("L") && it != COMPOSER },
            "弹出菜单状态类型",
            "popupState",
            counts,
        )
        diagnostics += "弹出菜单状态类型 = ${codepoints(popupStateType)}"

        // 5. The Kotlin default-argument bridge on MenuFlyoutScope: static, 3 parameters,
        //    self-typed receiver first, Function0 onClick, Function2 content, void return.
        //    Its owner is the scope interface itself — that is how the scope class is found.
        val itemBridge = unique(
            ownerBodies.flatMap { it.calls }
                .filter { call ->
                    val params = parameterDescriptors(call.descriptor)
                    params != null && params.size == 3 &&
                        params[0] == "L${call.owner};" &&
                        params[1] == FUNCTION0 &&
                        params[2] == FUNCTION2 &&
                        returnDescriptor(call.descriptor) == "V"
                }
                .distinct(),
            "菜单项 bridge 方法",
            "itemBridge",
            counts,
        )
        val scopeClass = itemBridge.owner
        diagnostics += "菜单项 bridge 方法 = ${codepoints(scopeClass)}.${codepoints(itemBridge.name)}"

        // 6. The ordinary (non-composable) builder that appends the host's four items. This is
        //    the *tightened* rule: the four R8-stable anchors plus the scope interface and the
        //    popup state must all appear in the parameter list. The looser SPW-Lyrics rule
        //    (bridge call only) matches 15 methods on 1.19.3 and is therefore useless.
        val requiredAnchors = listOf(TRACK, MEDIA_ITEM, NAVIGATOR, STATE, "L$scopeClass;", popupStateType)
        val builder = unique(
            ownerBodies.filter { body ->
                (body.flags and ACC_STATIC) != 0 &&
                    returnDescriptor(body.method.descriptor) == UNIT &&
                    body.calls.contains(itemBridge) &&
                    body.method.descriptor.let { descriptor ->
                        val params = parameterDescriptors(descriptor)
                        params != null &&
                            params.none { it == COMPOSER } &&
                            requiredAnchors.all { anchor -> params.contains(anchor) }
                    }
            }.map { it.method },
            "普通菜单 builder 方法",
            "builder",
            counts,
        )
        diagnostics += "普通菜单 builder 方法 = ${codepoints(builder.name)}${codepoints(builder.descriptor)}"

        // 7. Callback parameter indices, so the hook can pull the scope and popup state out of args.
        val builderParams = parameterDescriptors(builder.descriptor)
            ?: throw IllegalStateException("普通菜单 builder 方法 descriptor 无法解析：${builder.descriptor}")
        val scopeParameter = unique(
            builderParams.indices.filter { builderParams[it] == "L$scopeClass;" },
            "菜单 builder 的 scope 参数下标",
            "scopeParameter",
            counts,
        )
        val popupParameter = unique(
            builderParams.indices.filter { builderParams[it] == popupStateType },
            "菜单 builder 的 popup 参数下标",
            "popupParameter",
            counts,
        )

        // 8. `dismiss()`: called from the facade's one-argument popup-state helper, no args, void.
        val dismissBodies = ownerBodies.filter { body ->
            val params = parameterDescriptors(body.method.descriptor)
            params != null && params.size == 1 && params[0] == popupStateType &&
                returnDescriptor(body.method.descriptor) == UNIT
        }
        val dismiss = unique(
            dismissBodies.flatMap { it.calls }
                .filter { it.owner == internalName(popupStateType) && it.descriptor == "()V" }
                .distinct(),
            "弹出菜单关闭方法",
            "dismiss",
            counts,
        ).name
        diagnostics += "弹出菜单关闭方法 = ${codepoints(dismiss)}"

        // 9. Optional: the host's own row renderer, reused so Folia's item looks native.
        val label = runCatching {
            unique(
                ownerBodies.flatMap { it.calls }.filter { it.descriptor == LABEL_CALL }.distinct(),
                "菜单项 label 渲染方法",
                "label",
                counts,
            ).name
        }.getOrElse { failure ->
            diagnostics += "菜单项 label 渲染方法未解析（降级为 null）：${failure.message}"
            null
        }
        label?.let { diagnostics += "菜单项 label 渲染方法 = ${codepoints(it)}" }

        return MenuTarget(
            menuClass = dotted(owner),
            addItemsMethod = builder.name,
            addItemsParams = builderParams.map { binaryName(it) },
            scopeClass = dotted(scopeClass),
            scopeBridge = itemBridge.name,
            // `popupStateType` is a *descriptor* (`Landroidx/compose/ui/ל;`); every consumer of
            // `popupStateClass` (Class.forName, the dismiss lookup, the cache file) needs the
            // binary dotted name, so strip the L…; wrapper first. v0.4.4 shipped a raw descriptor
            // here in the scan path, which made every reflective lookup fail.
            popupStateClass = internalName(popupStateType)?.let(::dotted),
            popupDismiss = dismiss,
            scopeParameter = scopeParameter,
            popupParameter = popupParameter,
            labelMethod = label,
            origin = "scan",
        )
    }

    // ------------------------------------------------------------------ palette ----

    /**
     * The flyout's content colour palette: a `@Composable` accessor returning a palette object
     * whose every colour is a `MutableState<Long>` (background first, content second in
     * constructor order — 1.19.x names the content getter `Ԩ`, U+0528).
     *
     * Optional: returns `null` (with a diagnostic) instead of failing the whole discovery.
     */
    private fun discoverPalette(
        index: HostBytecodeIndex.Index,
        diagnostics: MutableList<String>,
        counts: MutableMap<String, Int>,
    ): PaletteTarget? {
        val hits = ArrayList<PaletteTarget>(4)
        for (accessor in index.methods()) {
            if ((accessor.flags and ACC_STATIC) == 0) continue
            val descriptor = accessor.method.descriptor
            if (!descriptor.startsWith(PALETTE_ACCESSOR_PREFIX) || !descriptor.endsWith(";")) continue
            val palette = internalName(returnDescriptor(descriptor) ?: continue) ?: continue

            // A palette keeps one MutableState per colour and exposes one `()J` getter per colour.
            val stateFields = index.type(palette)?.fields?.count { it.descriptor == MUTABLE_STATE } ?: 0
            if (stateFields < 5) continue
            val getters = index.methods().filter { body ->
                body.method.owner == palette && body.method.descriptor == "()J" &&
                    (body.flags and ACC_STATIC) == 0
            }
            if (getters.size < 5) continue

            // Content colour: the known getter when the build still names it, else the second
            // colour getter (constructor order: background first, content second).
            val content = getters.firstOrNull { it.method.name == PALETTE_CONTENT_COLOR }
                ?: getters.getOrNull(1) ?: continue
            hits += PaletteTarget(
                accessorClass = dotted(accessor.method.owner),
                accessorMethod = accessor.method.name,
                paletteClass = dotted(palette),
                colorMethod = content.method.name,
                origin = "scan",
            )
        }

        val distinct = hits.distinct()
        counts["palette"] = distinct.size
        if (distinct.size != 1) {
            diagnostics += "调色板候选不唯一（${distinct.size} 个），降级为 null：" +
                distinct.joinToString { "${codepoints(it.accessorClass)}.${codepoints(it.accessorMethod)}" }
            return null
        }
        val palette = distinct.single()
        diagnostics += "调色板 = ${codepoints(palette.paletteClass)}.${codepoints(palette.colorMethod)}() " +
            "via ${codepoints(palette.accessorClass)}.${codepoints(palette.accessorMethod)}"
        return palette
    }

    // -------------------------------------------------------------- descriptors ----

    /** Splits a method descriptor into its parameter descriptors; `null` when malformed. */
    private fun parameterDescriptors(descriptor: String): List<String>? {
        if (!descriptor.startsWith("(")) return null
        val out = ArrayList<String>(8)
        var i = 1
        while (i < descriptor.length) {
            when (val c = descriptor[i]) {
                ')' -> return if (i + 1 < descriptor.length) out else null
                'L' -> {
                    val end = descriptor.indexOf(';', i)
                    if (end < 0) return null
                    out += descriptor.substring(i, end + 1)
                    i = end + 1
                }
                '[' -> {
                    val start = i
                    while (i < descriptor.length && descriptor[i] == '[') i++
                    if (i >= descriptor.length) return null
                    if (descriptor[i] == 'L') {
                        val end = descriptor.indexOf(';', i)
                        if (end < 0) return null
                        out += descriptor.substring(start, end + 1)
                        i = end + 1
                    } else {
                        out += descriptor.substring(start, i + 1)
                        i++
                    }
                }
                'Z', 'B', 'C', 'S', 'I', 'J', 'F', 'D' -> {
                    out += c.toString()
                    i++
                }
                else -> return null
            }
        }
        return null // missing ')'
    }

    /** Return descriptor (`V`, `L…;`, `[…`); `null` when malformed. */
    private fun returnDescriptor(descriptor: String): String? {
        val close = descriptor.indexOf(')')
        if (close < 0 || close + 1 >= descriptor.length) return null
        return descriptor.substring(close + 1)
    }

    /** `Landroidx/compose/ui/ɦ;` → `androidx/compose/ui/ɦ`. */
    private fun internalName(descriptor: String): String? =
        if (descriptor.startsWith("L") && descriptor.endsWith(";")) {
            descriptor.substring(1, descriptor.length - 1)
        } else {
            null
        }

    /** Internal name (`a/b/C`) → binary dotted name (`a.b.C`) for `Class.forName`. */
    private fun dotted(internalName: String): String = internalName.replace('/', '.')

    /**
     * Descriptor → reflection-style binary name, matching `Class.getName()` (what the host's
     * `hookMethod` matches on): `L…;` dotted, arrays kept in `[…` form, primitives spelled out.
     */
    private fun binaryName(descriptor: String): String {
        if (descriptor.startsWith("L") && descriptor.endsWith(";")) {
            return dotted(descriptor.substring(1, descriptor.length - 1))
        }
        if (descriptor.startsWith("[")) return "[" + binaryName(descriptor.substring(1))
        return when (descriptor) {
            "Z" -> "boolean"
            "B" -> "byte"
            "C" -> "char"
            "S" -> "short"
            "I" -> "int"
            "J" -> "long"
            "F" -> "float"
            "D" -> "double"
            "V" -> "void"
            else -> descriptor
        }
    }

    // ------------------------------------------------------------------- utils ----

    /**
     * Renders a name with every non-ASCII code point as `U+XXXX`, so obfuscated host names survive
     * log files, copy-paste and terminal fonts (the flyout names are Greek/Hebrew/Armenian letters).
     */
    fun codepoints(name: String): String = buildString {
        for (c in name) {
            if (c.code < 0x80) append(c) else append("U+%04X".format(c.code))
        }
    }

    /**
     * Exactly one candidate or a hard failure naming the role and the count.
     *
     * [counts] is recorded before the check so the caller's diagnostics keep the per-role census
     * even on the failure path (the thrown message alone cannot carry the whole chain).
     */
    private fun <T> unique(candidates: List<T>, role: String, key: String, counts: MutableMap<String, Int>): T {
        counts[key] = candidates.size
        if (candidates.size != 1) {
            throw IllegalStateException(
                "$role：期望唯一命中，实际 ${candidates.size} 个（候选统计：${counts.entries.joinToString(", ") { "${it.key}=${it.value}" }}）",
            )
        }
        return candidates.single()
    }
}
