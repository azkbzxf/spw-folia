package dev.spw.folia

import java.io.File
import java.lang.reflect.Method
import java.util.zip.ZipFile

/**
 * Host-version tolerant resolution of the two SPW internals this plugin has to reach:
 *
 *  1. the "更多" flyout's item-append helper (so a `Folia` entry can be injected), and
 *  2. the theme palette that supplies the flyout's content colour.
 *
 * Why this file exists
 * --------------------
 * SPW ships as an R8-obfuscated build, so every host release renames the classes/methods we touch.
 * Up to v0.3.0 the plugin hardcoded the SPW **1.19.0** names (`ē` / `ন` / `Ⴈ`) and refused to run
 * unless `spwVersion == "1.19.0"`, so 1.19.1/1.19.2 looked "unsupported" even though the host
 * structure is identical.
 *
 * Resolution is layered, cheapest first, and every layer is *validated by reflection* before use,
 * so a stale name can never be trusted blindly:
 *
 *  1. `host-targets.json` cache (keyed by host version) written after the last successful resolve;
 *  2. built-in profiles for known host builds ([PROFILES]) — now a *fallback / regression baseline*
 *     and the zero-cost fast path on builds we already pinned by hand;
 *  3. **structural discovery** ([HostMenuDiscovery] over [HostBytecodeIndex]) — the primary path for
 *     any build the profiles do not cover. It indexes the host's own bytecode once and identifies
 *     every role by shape (call graph + parameter lists + the self-typed Kotlin default-argument
 *     bridge), never by an obfuscated name, so an R8 rename alone no longer needs a new profile.
 *     The index costs ~1.4 s on 1.19.3 (42k classes / ~27k method bodies), so it only ever runs on
 *     the background worker thread, never inside `start()`;
 *  4. the legacy classpath [scan] (pure reflection over `java.class.path`, independent of the JDK
 *     class-file API) as a second opinion when structural discovery fails.
 *
 * The result is cached next to the plugin, so the slow path runs at most once per host build.
 */
internal object HostTargets {

    /** `1.19.2`, `1.20.0-beta1` → (1,20,0). Trailing junk is ignored; null = unparsable. */
    data class Version(val major: Int, val minor: Int, val patch: Int) : Comparable<Version> {
        override fun compareTo(other: Version): Int {
            if (major != other.major) return major - other.major
            if (minor != other.minor) return minor - other.minor
            return patch - other.patch
        }

        override fun toString(): String = "$major.$minor.$patch"

        companion object {
            /** Lowest host release whose flyout/layout this plugin targets. */
            val MIN_SUPPORTED = Version(1, 19, 0)

            private val PATTERN = Regex("""^\s*(\d+)\.(\d+)(?:\.(\d+))?""")

            fun parse(text: String?): Version? {
                if (text.isNullOrBlank()) return null
                val m = PATTERN.find(text) ?: return null
                val (a, b, c) = m.destructured
                return Version(a.toInt(), b.toInt(), c.toIntOrNull() ?: 0)
            }
        }
    }

    /**
     * Everything needed to append an item to the flyout on one host build.
     *
     * `addItemsParams` is the exact JVM parameter list `hookMethod` matches on; `scopeClass` /
     * `scopeBridge` locate the Kotlin default-argument bridge `MenuFlyoutScope.item(onClick,
     * content)`; `popupDismiss` (optional) closes the flyout after a click.
     */
    data class MenuTarget(
        val menuClass: String,
        val addItemsMethod: String,
        val addItemsParams: List<String>,
        val scopeClass: String,
        val scopeBridge: String,
        val popupStateClass: String?,
        val popupDismiss: String?,
        /**
         * Index of the `MenuFlyoutScope` argument inside [addItemsParams]. The hook callback reads
         * its receiver from here instead of hardcoding `args[5]`; structural discovery fills it in,
         * and the 1.19.x profiles all use the default (5).
         */
        val scopeParameter: Int = 5,
        /** Index of the popup-state argument inside [addItemsParams] (1.19.x: 2). */
        val popupParameter: Int = 2,
        /**
         * Optional host-native label renderer discovered structurally. Informational only: it names
         * a `BlurPopupMenu` call site, not a method on [menuClass], so it must never be reflected
         * upon as a facade method.
         */
        val labelMethod: String? = null,
        val origin: String,
    ) {
        /** `Track`, `PiscesMediaItem`, … in parameter order, for the log. */
        val shortSignature: String
            get() = addItemsParams.joinToString(", ") { it.substringAfterLast('.') }
    }

    /** `PaletteAccessor(Composer)` → palette object → `colorMethod(): Color(long)`. */
    data class PaletteTarget(
        val accessorClass: String,
        val accessorMethod: String,
        val paletteClass: String,
        val colorMethod: String,
        val origin: String,
    )

    // ------------------------------------------------------------------ profiles ----

    private const val TRACK = "com.xuncorp.voxzen.data.entity.Track"
    private const val MEDIA_ITEM = "com.xuncorp.pisces.PiscesMediaItem"
    private const val NAVIGATOR = "com.xuncorp.voxzen.ui.navigation.Navigator"
    private const val STATE = "androidx.compose.runtime.State"
    private const val COMPOSER = "androidx.compose.runtime.Composer"
    private const val FUNCTION0 = "kotlin.jvm.functions.Function0"
    private const val FUNCTION2 = "kotlin.jvm.functions.Function2"
    private const val MUTABLE_STATE = "Landroidx/compose/runtime/MutableState;"

    /**
     * Known host builds, newest first. The first profile whose classes and method signatures
     * validate wins; a profile is never applied on faith.
     *
     *  - `1.19.3` (Steam, 2026-10-30): verified from `app/ffmpeg-x64.dll` — the whole file facade
     *    was renamed again (`घ`/`ะ`/`Ը` → `ɦ`/`ל`/`त`), which is why the flyout item vanished for
     *    users on that build. Signatures and the palette are unchanged.
     *  - `1.19.2` (Steam, 2026-10): verified by extracting `ffmpeg-x64.dll` and scanning classes.
     *  - `1.19.0` (Store / dev23 pairing): the original v0.1–v0.3 target.
     */
    private val PROFILES: List<MenuTarget> = listOf(
        MenuTarget(
            menuClass = "androidx.compose.ui.\u0266",              // ɦ — PlayerMoreMenuFlyoutKt
            addItemsMethod = "\u037F",                              // Ϳ
            addItemsParams = listOf(
                TRACK, MEDIA_ITEM,
                "androidx.compose.ui.\u05DC",                       // ל — PopupState
                NAVIGATOR, STATE,
                "androidx.compose.ui.\u0924",                       // त — MenuFlyoutScope
            ),
            scopeClass = "androidx.compose.ui.\u0924",
            scopeBridge = "\u037F",
            popupStateClass = "androidx.compose.ui.\u05DC",
            popupDismiss = "\u0529",
            origin = "profile:1.19.3",
        ),
        MenuTarget(
            menuClass = "androidx.compose.ui.\u0918",              // घ — PlayerMoreMenuFlyoutKt
            addItemsMethod = "\u037F",                              // Ϳ
            addItemsParams = listOf(
                TRACK, MEDIA_ITEM,
                "androidx.compose.ui.\u0E30",                       // ะ — PopupState
                NAVIGATOR, STATE,
                "androidx.compose.ui.\u0538",                       // Ը — MenuFlyoutScope
            ),
            scopeClass = "androidx.compose.ui.\u0538",
            scopeBridge = "\u037F",
            popupStateClass = "androidx.compose.ui.\u0E30",
            popupDismiss = "\u0529",
            origin = "profile:1.19.2",
        ),
        MenuTarget(
            menuClass = "androidx.compose.ui.\u0113",               // ē (U+0113)
            addItemsMethod = "\u037F",
            addItemsParams = listOf(
                TRACK, MEDIA_ITEM,
                "androidx.compose.ui.\u10A8",                       // Ⴈ
                NAVIGATOR, STATE,
                "androidx.compose.ui.\u09A8",                       // ন
            ),
            scopeClass = "androidx.compose.ui.\u09A8",
            scopeBridge = "\u037F",
            popupStateClass = "androidx.compose.ui.\u10A8",
            popupDismiss = "\u0529",
            origin = "profile:1.19.0",
        ),
    )

    /**
     * Theme palette profile. Unchanged between 1.19.0 and 1.19.2 — the More-menu builder reads
     * `ʰ.Ԩ(composer).Ԩ()` for its item content colour in both builds.
     */
    private val PALETTE_PROFILES: List<PaletteTarget> = listOf(
        PaletteTarget(
            accessorClass = "androidx.compose.ui.\u02B0",           // ʰ
            accessorMethod = "\u0528",                              // Ԩ
            paletteClass = "androidx.compose.ui.\u0374",            // ʹ
            colorMethod = "\u0528",                                 // Ԩ
            origin = "profile:1.19.x",
        ),
    )

    // -------------------------------------------------------------------- state ----

    @Volatile
    var menu: MenuTarget? = null
        private set

    @Volatile
    var palette: PaletteTarget? = null
        private set

    @Volatile
    private var loadedFor: String? = null

    private val lock = Any()

    /** Scan diagnostics, appended to the plugin log when resolution fails. */
    @Volatile
    var lastDiagnostics: String = ""
        private set

    // -------------------------------------------------------------------- entry ----

    /**
     * Fast path: cache file, then built-in profiles — no bytecode index and no classpath scan, so it
     * is cheap enough to run inside `start()`.
     *
     * The cache is always re-validated by reflection, so a stale file can never inject a wrong
     * target. Returns false when neither layer validates: the caller then resolves on a background
     * thread via [deepResolve], which is where structural discovery lives.
     */
    fun quickLoad(pluginDir: File?, spwVersion: String, log: (String) -> Unit): Boolean {
        synchronized(lock) {
            if (menu != null && loadedFor == spwVersion) return true
            loadedFor = spwVersion
            menu = null

            // The palette is independent of the menu target: a known 1.19.x palette profile stays
            // valid even when no menu profile matches, and without it the item merely falls back to
            // a constant colour. Resolve it first, then let a cache hit override it.
            if (palette == null) {
                palette = PALETTE_PROFILES.firstOrNull { validatePalette(it) }
            }

            val cached = readCache(pluginDir, spwVersion)
            if (cached != null && validateMenu(cached.menu)) {
                menu = cached.menu
                cached.palette?.takeIf { validatePalette(it) }?.let { palette = it }
                log("host menu ${cached.menu.origin}: ${cached.menu.menuClass}.${cached.menu.addItemsMethod}(${cached.menu.shortSignature})")
                palette?.let { log("host palette ${it.origin}: ${it.paletteClass}.${it.colorMethod}()") }
                return true
            }
            if (cached != null) {
                log("cached host menu target for $spwVersion no longer validates; re-resolving")
            }

            val profile = PROFILES.firstOrNull { validateMenu(it) }
            if (profile != null) {
                menu = profile
                log("host menu ${profile.origin}: ${profile.menuClass}.${profile.addItemsMethod}(${profile.shortSignature})")
                palette?.let { log("host palette ${it.origin}: ${it.paletteClass}.${it.colorMethod}()") }
                writeCache(pluginDir, spwVersion, profile, palette, null)
                return true
            }
            return false
        }
    }

    /**
     * Slow path: resolve an unknown host build on a background thread.
     *
     * Structural discovery ([HostMenuDiscovery] over [HostBytecodeIndex]) runs first — it identifies
     * every role by call-graph shape, so an R8 rename alone no longer needs a new profile. The legacy
     * reflection-only [scan] stays as a second opinion (it does not depend on the JDK class-file API,
     * so it still works if the index cannot parse some host build).
     *
     * Both results pass the same [validateMenu] reflection gate, and a structural result is also
     * compared with any built-in profile that still validates: the profiles are the regression
     * baseline, so a disagreement means one of the two paths is wrong and must be logged.
     *
     * @param hostClass `WorkshopApi.instance.javaClass` — the host's own class, used to locate its
     *   code source. `null` falls back to `java.class.path` (tests, unusual launches).
     */
    fun deepResolve(
        pluginDir: File?,
        spwVersion: String,
        hostClass: Class<*>?,
        log: (String) -> Unit,
    ): MenuTarget? {
        synchronized(lock) {
            menu?.let { return it }

            structuralResolve(hostClass, log)?.let { resolved ->
                menu = resolved.menu
                resolved.palette?.let { palette = it }
                lastDiagnostics = resolved.diagnostics
                writeCache(pluginDir, spwVersion, resolved.menu, palette, resolved.report)
                return resolved.menu
            }

            val started = System.currentTimeMillis()
            val scanned = runCatching { scan(log) }.getOrElse { failure ->
                log("host scan failed: ${failure::class.java.name}: ${failure.message}")
                null
            }
            val took = System.currentTimeMillis() - started
            if (scanned == null) {
                log("host scan found no flyout helper (${took}ms) $lastDiagnostics")
                return null
            }
            if (!validateMenu(scanned)) {
                log("host scan candidate failed validation: ${scanned.menuClass}.${scanned.addItemsMethod} " +
                    "(${scanned.shortSignature}) (${took}ms)")
                return null
            }
            menu = scanned
            if (scanned.popupDismiss == null) {
                log("host scan: flyout dismiss unresolved; the popup may stay open behind the Folia window")
            }
            log("host menu scan: ${scanned.menuClass}.${scanned.addItemsMethod}(${scanned.shortSignature}) " +
                "scope=${scanned.scopeClass}.${scanned.scopeBridge} (${took}ms)")
            writeCache(pluginDir, spwVersion, scanned, palette, null)
            return scanned
        }
    }

    /** Backwards-compatible overload: no host class, structural discovery falls back to the classpath. */
    fun deepResolve(pluginDir: File?, spwVersion: String, log: (String) -> Unit): MenuTarget? =
        deepResolve(pluginDir, spwVersion, null, log)

    // ------------------------------------------------------- structural discovery ----

    /** A structural result plus the numbers worth persisting in `host-targets.json`. */
    private class Structural(
        val menu: MenuTarget,
        val palette: PaletteTarget?,
        val report: StructuralReport,
        val diagnostics: String,
    )

    private class StructuralReport(
        val indexMs: Long,
        val bodies: Int,
        val candidateCounts: Map<String, Int>,
        val diagnostics: List<String>,
    )

    /**
     * Index the host's bytecode and discover the flyout targets structurally.
     *
     * Returns null (never throws) when the index or the discovery fails; the caller falls back to
     * [scan]. Every failure is logged with the per-role candidate census from the discovery
     * exception, because that is the only useful information a user report can carry.
     */
    private fun structuralResolve(hostClass: Class<*>?, log: (String) -> Unit): Structural? {
        // The host class is authoritative: [HostBytecodeIndex.read] resolves its code source (or the
        // class resource) itself, which is what works on shipped builds where the only classpath
        // entry is a single polyglot `ffmpeg-x64.dll`.
        if (hostClass != null) {
            structuralResolveFrom(hostClass.name, { HostBytecodeIndex.read(hostClass) }, log)?.let { return it }
            // Still try the classpath: an unreadable code source is not a reason to give up on a
            // build the reflection-only scan might still resolve.
            log("host structural index from ${hostClass.name} failed; falling back to java.class.path")
        }
        return structuralResolveClasspath(log)
    }

    /** Classpath fallback: try each `java.class.path` entry as a host image, archives first. */
    private fun structuralResolveClasspath(log: (String) -> Unit): Structural? {
        val roots = System.getProperty("java.class.path").orEmpty()
            .split(File.pathSeparatorChar)
            .filter { it.isNotBlank() }
            .map(::File)
            .filter { it.exists() }
            // The shipped host is one zip-in-a-`.dll` (~110 MB) and it is the only huge entry on the
            // classpath, so size ordering skips the plugin's own classes and the stdlib jar without
            // paying for a pointless index attempt on each of them.
            .sortedWith(compareByDescending<File> { it.isFile }.thenByDescending { it.length() })
        log("host structural index: no usable host class, probing ${roots.size} classpath entr(y/ies)")
        for (root in roots) {
            structuralResolveFrom(root.name, { HostBytecodeIndex.read(root) }, log)?.let { return it }
        }
        if (roots.isEmpty()) {
            lastDiagnostics = "structural: 无法定位宿主代码来源（classpath 无可用条目）"
            log("host structural discovery failed: ${lastDiagnostics}")
        }
        return null
    }

    private inline fun structuralResolveFrom(
        label: String,
        read: () -> HostBytecodeIndex.Index,
        log: (String) -> Unit,
    ): Structural? {
        val started = System.currentTimeMillis()
        val index = runCatching { read() }.getOrElse { failure ->
            log("host structural index failed for $label: ${failure::class.java.name}: ${failure.message}")
            lastDiagnostics = "structural index failed ($label): ${failure.message}"
            return null
        }
        val indexMs = System.currentTimeMillis() - started
        val bodies = index.bodies.size
        log("host structural index: $label: $bodies method bodies (${indexMs}ms)")

        val discovery = runCatching { HostMenuDiscovery.discover(index) }.getOrElse { failure ->
            val message = failure.message ?: failure::class.java.name
            log("host structural discovery failed for $label: $message")
            lastDiagnostics = "structural ($label): $message"
            return null
        }

        val menu = adaptMenu(discovery.menu)
        if (!validateMenu(menu)) {
            log("host structural candidate failed validation: ${menu.menuClass}.${menu.addItemsMethod} " +
                "(${menu.shortSignature}) scope=${menu.scopeClass}.${menu.scopeBridge}")
            lastDiagnostics = "structural candidate failed validation: ${menu.menuClass}.${menu.addItemsMethod}"
            return null
        }
        val paletteTarget = discovery.palette?.let(::adaptPalette)?.takeIf { validatePalette(it) }
        if (paletteTarget == null) {
            log("host structural palette unresolved; the Folia item falls back to its constant colour")
        }

        // Cross-check against the built-in profile: on a known build both paths must agree exactly,
        // and on a new build the profile simply no longer validates (so there is nothing to compare).
        val baseline = PROFILES.firstOrNull { validateMenu(it) }
        if (baseline != null) {
            val sameNames = baseline.menuClass == menu.menuClass &&
                baseline.addItemsMethod == menu.addItemsMethod &&
                baseline.scopeClass == menu.scopeClass &&
                baseline.scopeBridge == menu.scopeBridge &&
                baseline.popupStateClass == menu.popupStateClass &&
                baseline.popupDismiss == menu.popupDismiss
            val sameIndices = baseline.scopeParameter == menu.scopeParameter &&
                baseline.popupParameter == menu.popupParameter
            if (sameNames && sameIndices) {
                log("host structural matches regression baseline ${baseline.origin}")
            } else {
                log(
                    "WARNING: structural discovery disagrees with ${baseline.origin}: " +
                        "structural=${menu.menuClass}.${menu.addItemsMethod} " +
                        "scope=${menu.scopeClass}.${menu.scopeBridge} popup=${menu.popupStateClass}/${menu.popupDismiss} " +
                        "indices=${menu.scopeParameter}/${menu.popupParameter} vs " +
                        "baseline=${baseline.menuClass}.${baseline.addItemsMethod} " +
                        "scope=${baseline.scopeClass}.${baseline.scopeBridge} popup=${baseline.popupStateClass}/${baseline.popupDismiss} " +
                        "indices=${baseline.scopeParameter}/${baseline.popupParameter}; trusting structural"
                )
            }
        }

        log(
            "host menu structural: ${menu.menuClass}.${menu.addItemsMethod}(${menu.shortSignature}) " +
                "scope=${menu.scopeClass}.${menu.scopeBridge} (${indexMs}ms, $bodies bodies)"
        )
        paletteTarget?.let {
            log("host palette structural: ${it.paletteClass}.${it.colorMethod}() via ${it.accessorClass}.${it.accessorMethod}")
        }

        val counts = discovery.candidateCounts.entries.joinToString(",") { "${it.key}=${it.value}" }
        val report = StructuralReport(indexMs, bodies, discovery.candidateCounts, discovery.diagnostics)
        val diagnostics = "structural(indexMs=$indexMs bodies=$bodies candidates=[$counts]) " +
            discovery.diagnostics.joinToString("; ")
        return Structural(menu, paletteTarget, report, diagnostics)
    }

    /** `HostMenuDiscovery.MenuTarget` → this file's target, tagging the origin and indices. */
    private fun adaptMenu(target: HostMenuDiscovery.MenuTarget): MenuTarget = MenuTarget(
        menuClass = target.menuClass,
        addItemsMethod = target.addItemsMethod,
        addItemsParams = target.addItemsParams,
        scopeClass = target.scopeClass,
        scopeBridge = target.scopeBridge,
        popupStateClass = target.popupStateClass,
        popupDismiss = target.popupDismiss,
        scopeParameter = target.scopeParameter,
        popupParameter = target.popupParameter,
        labelMethod = target.labelMethod,
        origin = "structural",
    )

    private fun adaptPalette(target: HostMenuDiscovery.PaletteTarget): PaletteTarget = PaletteTarget(
        accessorClass = target.accessorClass,
        accessorMethod = target.accessorMethod,
        paletteClass = target.paletteClass,
        colorMethod = target.colorMethod,
        origin = "structural",
    )

    // -------------------------------------------------------------- validation ----

    private fun validateMenu(target: MenuTarget): Boolean = runCatching {
        // The hook indexes the callback arguments with these, so an out-of-range index is just as
        // unusable as a wrong class name — reject it before anything is registered.
        if (target.scopeParameter !in target.addItemsParams.indices) return false
        if (target.popupParameter !in target.addItemsParams.indices) return false
        if (target.addItemsParams[target.scopeParameter] != target.scopeClass) return false

        val menuClass = Class.forName(target.menuClass)
        menuClass.declaredMethods.firstOrNull { m ->
            m.name == target.addItemsMethod &&
                m.parameterTypes.map { it.name } == target.addItemsParams
        } ?: return false

        val scopeClass = Class.forName(target.scopeClass)
        if (!scopeClass.isInterface) return false
        val bridge = scopeClass.declaredMethods.firstOrNull { m ->
            m.name == target.scopeBridge &&
                java.lang.reflect.Modifier.isStatic(m.modifiers) &&
                m.parameterTypes.size == 3 &&
                m.parameterTypes[0] == scopeClass &&
                m.parameterTypes[1].name == FUNCTION0 &&
                m.parameterTypes[2].name == FUNCTION2
        } ?: return false
        bridge.returnType == Void.TYPE
    }.getOrDefault(false)

    private fun validatePalette(target: PaletteTarget): Boolean = runCatching {
        val accessor = Class.forName(target.accessorClass)
        val method: Method = accessor.declaredMethods.firstOrNull { m ->
            m.name == target.accessorMethod &&
                java.lang.reflect.Modifier.isStatic(m.modifiers) &&
                m.parameterTypes.size == 1 &&
                m.parameterTypes[0].name == COMPOSER
        } ?: return false
        method.returnType.name == target.paletteClass &&
            method.returnType.declaredMethods.any {
                it.name == target.colorMethod && it.parameterCount == 0 &&
                    it.returnType == Long::class.javaPrimitiveType
            }
    }.getOrDefault(false)

    // ---------------------------------------------------------------- the scan ----

    /**
     * Walks `java.class.path` looking for the flyout helper.
     *
     * The zip **entry names of the SPW jar cannot be trusted** (several entries are aliased under a
     * name that differs from the class they contain), so every candidate is identified by the
     * value parsed out of the class file itself, never by its path.
     */
    private fun scan(log: (String) -> Unit): MenuTarget? {
        val classPath = System.getProperty("java.class.path").orEmpty()
        val roots = classPath.split(File.pathSeparatorChar).filter { it.isNotBlank() }
        log("host scan: ${roots.size} classpath entr(y/ies) [${roots.joinToString()}], matching by shape")

        val menuHits = ArrayList<MenuTarget>()
        val paletteHits = ArrayList<PaletteTarget>()
        var scanned = 0
        var parsed = 0

        fun consider(bytes: ByteArray) {
            scanned++
            val text = String(bytes, Charsets.ISO_8859_1)
            val maybeMenu = text.contains("com/xuncorp/voxzen/data/entity/Track")
            val maybePalette = text.contains(MUTABLE_STATE)
            val maybeAccessor = text.contains("(L$COMPOSER;)Landroidx/compose/ui/")
            if (!maybeMenu && !maybePalette && !maybeAccessor) return
            val cls = runCatching { parseClass(bytes) }.getOrNull() ?: return
            parsed++
            if (maybeMenu) menuHits += menuCandidates(cls)
            if (maybePalette) paletteColour(cls)?.let { paletteHits += it }
            if (maybeAccessor) paletteAccessor(cls)?.let { paletteHits += it }
        }

        for (root in roots) {
            val file = File(root)
            when {
                file.isDirectory -> file.walkTopDown()
                    .filter { it.isFile && it.name.endsWith(".class") }
                    .forEach { entry -> runCatching { consider(entry.readBytes()) } }

                file.isFile -> runCatching {
                    ZipFile(file).use { zip ->
                        for (entry in zip.entries()) {
                            val name = entry.name
                            if (!name.endsWith(".class")) continue
                            if (name.startsWith("META-INF/versions/")) continue
                            if (name == "module-info.class") continue
                            val bytes = zip.getInputStream(entry).use { it.readBytes() }
                            runCatching { consider(bytes) }
                        }
                    }
                }
            }
        }

        if (palette == null) {
            palette = pickPalette(paletteHits)?.takeIf { validatePalette(it) }
            palette?.let { log("host palette scan: ${it.paletteClass}.${it.colorMethod}() via ${it.accessorClass}") }
        }

        lastDiagnostics = "(classes=$scanned parsed=$parsed menuHits=${menuHits.size} paletteHits=${paletteHits.size})"

        for (candidate in menuHits) {
            val resolved = resolveParts(candidate) ?: continue
            if (validateMenu(resolved)) return resolved
        }
        return null
    }

    /** Every 6-argument method that looks like the flyout's "add the four items" helper. */
    private fun menuCandidates(cls: ParsedClass): List<MenuTarget> {
        val out = ArrayList<MenuTarget>(1)
        for (method in cls.methods) {
            val params = parameterTypes(method.desc) ?: continue
            if (params.size != 6) continue
            if (params[0] != TRACK || params[1] != MEDIA_ITEM) continue
            if (params[3] != NAVIGATOR || params[4] != STATE) continue
            if (!params[2].startsWith("androidx.compose.ui.")) continue
            if (!params[5].startsWith("androidx.compose.ui.")) continue
            out += MenuTarget(
                // `ParsedClass.name` is the raw `this_class` value, i.e. the JVM *internal* form
                // with '/' separators (`androidx/compose/ui/ɦ`). Every consumer of `menuClass`
                // (validateMenu's Class.forName, the hook registrar, the cache file) expects the
                // binary dotted form, so convert here — before v0.4.4 this was passed through raw,
                // which made validateMenu throw ClassNotFoundException and the whole scan report
                // "found no flyout helper" on every unknown host build.
                menuClass = cls.name.replace('/', '.'),
                addItemsMethod = method.name,
                addItemsParams = params,
                scopeClass = "",
                scopeBridge = "",
                popupStateClass = null,
                popupDismiss = null,
                origin = "scan",
            )
        }
        return out
    }

    /**
     * Splits the two `androidx.compose.ui.*` parameters into (MenuFlyoutScope, PopupState) by
     * looking for the interface that carries the Kotlin default-argument item bridge.
     */
    private fun resolveParts(candidate: MenuTarget): MenuTarget? {
        val uiParams = listOf(candidate.addItemsParams[2], candidate.addItemsParams[5])
        for (name in uiParams) {
            val scopeClass = runCatching { Class.forName(name) }.getOrNull() ?: continue
            if (!scopeClass.isInterface) continue
            val bridge = scopeClass.declaredMethods.firstOrNull { m ->
                java.lang.reflect.Modifier.isStatic(m.modifiers) &&
                    m.returnType == Void.TYPE &&
                    m.parameterTypes.size == 3 &&
                    m.parameterTypes[0] == scopeClass &&
                    m.parameterTypes[1].name == FUNCTION0 &&
                    m.parameterTypes[2].name == FUNCTION2
            } ?: continue
            val other = uiParams.first { it != name }
            return candidate.copy(
                scopeClass = name,
                scopeBridge = bridge.name,
                popupStateClass = other,
                popupDismiss = resolveDismiss(other),
            )
        }
        return null
    }

    /**
     * `PopupState.dismiss()` — a no-arg void method. 1.19.x exposes two (`show`/`dismiss`), so the
     * known obfuscated name is preferred; when a build renames both we leave it unresolved rather
     * than invoke the wrong one (a flyout left open behind the fullscreen Folia window is cosmetic).
     */
    private fun resolveDismiss(popupClass: String): String? {
        val cls = runCatching { Class.forName(popupClass) }.getOrNull() ?: return null
        val candidates = cls.methods.filter {
            it.parameterCount == 0 && it.returnType == Void.TYPE &&
                !java.lang.reflect.Modifier.isStatic(it.modifiers)
        }
        if (candidates.isEmpty()) return null
        candidates.firstOrNull { it.name == "\u0529" }?.let { return it.name }
        return if (candidates.size == 1) candidates[0].name else null
    }

    // --------------------------------------------------------------- palette ----

    private fun paletteColour(cls: ParsedClass): PaletteTarget? {
        if (cls.mutableStateFields < 5) return null
        val getters = cls.methods.filter { it.desc == "()J" && !it.isStatic }
        if (getters.size < 5) return null
        // Content colour: the known 1.19.x accessor when present, else the second colour getter —
        // the palette's constructor order (background first, content second) has not changed
        // between 1.19.0 and 1.19.2, and this is only a fallback for unknown future builds.
        val content = getters.firstOrNull { it.name == "\u0528" } ?: getters.getOrNull(1) ?: return null
        return PaletteTarget(
            accessorClass = "",
            accessorMethod = "",
            paletteClass = cls.name,
            colorMethod = content.name,
            origin = "scan",
        )
    }

    private fun paletteAccessor(cls: ParsedClass): PaletteTarget? {
        val accessor = cls.methods.firstOrNull {
            it.isStatic && it.desc.startsWith("(L$COMPOSER;)Landroidx/compose/ui/") && it.desc.endsWith(";")
        } ?: return null
        val paletteClass = returnType(accessor.desc) ?: return null
        return PaletteTarget(
            accessorClass = cls.name,
            accessorMethod = accessor.name,
            paletteClass = paletteClass,
            colorMethod = "",
            origin = "scan",
        )
    }

    /** Pairs a scanned accessor with a scanned palette (they live in separate classes). */
    private fun pickPalette(hits: List<PaletteTarget>): PaletteTarget? {
        val cores = hits.filter { it.accessorClass.isEmpty() && it.colorMethod.isNotEmpty() }
        val accessors = hits.filter { it.accessorClass.isNotEmpty() }
        for (accessor in accessors) {
            val core = cores.firstOrNull { it.paletteClass == accessor.paletteClass } ?: continue
            return core.copy(
                accessorClass = accessor.accessorClass,
                accessorMethod = accessor.accessorMethod,
            )
        }
        return null
    }

    // ------------------------------------------------------------ class files ----

    private class ParsedMethod(val name: String, val desc: String, val isStatic: Boolean)

    private class ParsedClass(
        val name: String,
        val methods: List<ParsedMethod>,
        val mutableStateFields: Int,
    )

    /**
     * Minimal class-file reader: constant pool, this_class, fields (MutableState count) and
     * methods. Returns null for anything it does not fully understand — never throws.
     */
    private fun parseClass(bytes: ByteArray): ParsedClass? {
        if (bytes.size < 16 || u4(bytes, 0) != 0xCAFEBABE.toInt()) return null
        var i = 8
        val cpCount = u2(bytes, i)
        i += 2
        val utf = HashMap<Int, String>()
        val classRef = HashMap<Int, Int>()
        var index = 1
        while (index < cpCount) {
            when (val tag = bytes[i].toInt() and 0xFF) {
                1 -> {
                    val len = u2(bytes, i + 1)
                    utf[index] = String(bytes, i + 3, len, Charsets.UTF_8)
                    i += 3 + len
                }

                7 -> {
                    classRef[index] = u2(bytes, i + 1)
                    i += 3
                }

                8, 16, 19, 20 -> i += 3
                15 -> i += 4
                3, 4, 9, 10, 11, 12, 17, 18 -> i += 5
                5, 6 -> {
                    i += 9
                    index++
                }

                else -> return null
            }
            index++
        }

        val thisIndex = u2(bytes, i + 2)
        val nameIndex = classRef[thisIndex] ?: return null
        val className = utf[nameIndex] ?: return null
        i += 6
        val interfaces = u2(bytes, i)
        i += 2 + 2 * interfaces

        var mutableStates = 0
        val fieldCount = u2(bytes, i)
        i += 2
        repeat(fieldCount) {
            val descIndex = u2(bytes, i + 4)
            if (utf[descIndex] == MUTABLE_STATE) mutableStates++
            i += 6
            val attrs = u2(bytes, i)
            i += 2
            repeat(attrs) {
                val len = u4(bytes, i + 2)
                i += 6 + len
            }
        }

        val methods = ArrayList<ParsedMethod>(16)
        val methodCount = u2(bytes, i)
        i += 2
        repeat(methodCount) {
            val access = u2(bytes, i)
            val mName = utf[u2(bytes, i + 2)] ?: return null
            val mDesc = utf[u2(bytes, i + 4)] ?: return null
            val isStatic = access and 0x0008 != 0
            i += 6
            val attrs = u2(bytes, i)
            i += 2
            repeat(attrs) {
                val len = u4(bytes, i + 2)
                i += 6 + len
            }
            methods += ParsedMethod(mName, mDesc, isStatic)
        }
        return ParsedClass(className, methods, mutableStates)
    }

    private fun u2(b: ByteArray, at: Int): Int =
        ((b[at].toInt() and 0xFF) shl 8) or (b[at + 1].toInt() and 0xFF)

    private fun u4(b: ByteArray, at: Int): Int =
        ((b[at].toInt() and 0xFF) shl 24) or
            ((b[at + 1].toInt() and 0xFF) shl 16) or
            ((b[at + 2].toInt() and 0xFF) shl 8) or
            (b[at + 3].toInt() and 0xFF)

    private fun returnType(desc: String): String? {
        val close = desc.indexOf(')')
        if (close < 0 || close + 1 >= desc.length) return null
        val ret = desc.substring(close + 1)
        if (!ret.startsWith("L") || !ret.endsWith(";")) return null
        return ret.substring(1, ret.length - 1).replace('/', '.')
    }

    private fun parameterTypes(desc: String): List<String>? {
        if (!desc.startsWith("(")) return null
        val out = ArrayList<String>(8)
        var i = 1
        while (i < desc.length && desc[i] != ')') {
            when (desc[i]) {
                'L' -> {
                    val end = desc.indexOf(';', i)
                    if (end < 0) return null
                    out += desc.substring(i + 1, end).replace('/', '.')
                    i = end + 1
                }

                '[' -> {
                    val start = i
                    while (i < desc.length && desc[i] == '[') i++
                    if (i < desc.length && desc[i] == 'L') {
                        val end = desc.indexOf(';', i)
                        if (end < 0) return null
                        out += desc.substring(start, end + 1).replace('/', '.')
                        i = end + 1
                    } else if (i < desc.length) {
                        out += desc.substring(start, i + 1)
                        i++
                    } else {
                        return null
                    }
                }

                'Z', 'B', 'C', 'S', 'I', 'J', 'F', 'D' -> {
                    out += when (desc[i]) {
                        'Z' -> "boolean"
                        'B' -> "byte"
                        'C' -> "char"
                        'S' -> "short"
                        'I' -> "int"
                        'J' -> "long"
                        'F' -> "float"
                        else -> "double"
                    }
                    i++
                }

                else -> return null
            }
        }
        return if (i < desc.length) out else null
    }

    // ------------------------------------------------------------------ cache ----

    private const val CACHE_FILE = "host-targets.json"

    /**
     * Unique cache key for the resolved palette.
     *
     * Deliberately *not* `palette`: the structural diagnostics block also contains a `"palette"`
     * candidate count, and `Json.rawField` matches the first occurrence in the text, so the two
     * would collide when the diagnostic block is written before the palette.
     */
    private const val PALETTE_KEY = "paletteTarget"

    /** A cache hit: the target plus the palette the resolving layer paired with it (may be null). */
    private class Cached(val menu: MenuTarget, val palette: PaletteTarget?)

    /**
     * Reads `host-targets.json`. Both halves are returned as-is: the caller validates them by
     * reflection before use (a cache written by another host build or by a buggy release must never
     * be trusted on its own).
     */
    private fun readCache(pluginDir: File?, spwVersion: String): Cached? {
        val file = pluginDir?.let { File(it, CACHE_FILE) } ?: return null
        if (!file.isFile) return null
        return runCatching {
            val text = file.readText(Charsets.UTF_8)
            if (Json.stringField(text, "spwVersion") != spwVersion) return null
            val menuJson = Json.rawField(text, "menu") ?: return null
            val menuClass = Json.stringField(menuJson, "class") ?: return null
            val method = Json.stringField(menuJson, "method") ?: return null
            val paramsRaw = Json.rawField(menuJson, "params") ?: return null
            val scope = Json.stringField(menuJson, "scope") ?: return null
            val bridge = Json.stringField(menuJson, "bridge") ?: return null
            val params = paramsRaw.trim().removePrefix("[").removeSuffix("]")
                .split(""",""")
                .map { it.trim().trim('"') }
                .filter { it.isNotEmpty() }
            if (params.isEmpty()) return null
            val menuTarget = MenuTarget(
                menuClass = menuClass,
                addItemsMethod = method,
                addItemsParams = params,
                scopeClass = scope,
                scopeBridge = bridge,
                popupStateClass = Json.stringField(menuJson, "popup"),
                popupDismiss = Json.stringField(menuJson, "dismiss"),
                scopeParameter = Json.rawField(menuJson, "scopeParameter")?.trim()?.toIntOrNull() ?: 5,
                popupParameter = Json.rawField(menuJson, "popupParameter")?.trim()?.toIntOrNull() ?: 2,
                labelMethod = Json.stringField(menuJson, "label"),
                // The cache remembers *where* the target came from (`profile:1.19.3` / `structural`)
                // so the log still tells which layer produced it; the layer that reads it is "cache".
                origin = Json.stringField(menuJson, "origin") ?: "cache",
            )
            val paletteTarget = paletteField(text)?.let { paletteJson ->
                val accessor = Json.stringField(paletteJson, "accessor") ?: return@let null
                val accessorMethod = Json.stringField(paletteJson, "accessorMethod") ?: return@let null
                val paletteClass = Json.stringField(paletteJson, "palette") ?: return@let null
                val color = Json.stringField(paletteJson, "color") ?: return@let null
                PaletteTarget(
                    accessorClass = accessor,
                    accessorMethod = accessorMethod,
                    paletteClass = paletteClass,
                    colorMethod = color,
                    origin = Json.stringField(paletteJson, "origin") ?: "cache",
                )
            }
            Cached(menuTarget, paletteTarget)
        }.getOrNull()
    }

    /**
     * Locates the palette object in the cache text.
     *
     * `Json.rawField` returns the first textual match, which is not root-aware, and the structural
     * diagnostics block contains its own `"palette"` key (a candidate count inside
     * `candidateCounts`). The palette is therefore written under a unique key [PALETTE_KEY]; the
     * plain `"palette"` name is still read for cache files written by older releases, but only when
     * its value is actually an object (a bare number there is the candidate count, not the target).
     */
    private fun paletteField(text: String): String? {
        Json.rawField(text, PALETTE_KEY)?.let { return it }
        val legacy = Json.rawField(text, "palette") ?: return null
        return legacy.takeIf { it.trimStart().startsWith("{") }
    }

    /**
     * Writes `host-targets.json` for [spwVersion].
     *
     * [report] is only non-null for a structural result and adds the diagnostic numbers
     * (`indexMs`, `bodies`, `candidateCounts`, per-role `diagnostics`), so a support log or a later
     * cache hit can explain how the target was found without re-indexing the host.
     */
    private fun writeCache(
        pluginDir: File?,
        spwVersion: String,
        menu: MenuTarget,
        palette: PaletteTarget?,
        report: StructuralReport?,
    ) {
        val dir = pluginDir ?: return
        runCatching {
            dir.mkdirs()
            val params = menu.addItemsParams.joinToString(",") { Json.str(it) }
            val paletteJson = palette?.let {
                "{\"accessor\":${Json.str(it.accessorClass)}," +
                    "\"accessorMethod\":${Json.str(it.accessorMethod)}," +
                    "\"palette\":${Json.str(it.paletteClass)},\"color\":${Json.str(it.colorMethod)}," +
                    "\"origin\":${Json.str(it.origin)}}"
            } ?: "null"
            val reportJson = report?.let { numbers ->
                val counts = numbers.candidateCounts.entries
                    .joinToString(",") { "\"${it.key}\":${it.value}" }
                val lines = numbers.diagnostics.joinToString(",") { Json.str(it) }
                "\"structural\":{\"indexMs\":${numbers.indexMs},\"bodies\":${numbers.bodies}," +
                    "\"candidateCounts\":{$counts},\"diagnostics\":[$lines]},"
            } ?: ""
            val text = "{\"spwVersion\":${Json.str(spwVersion)}," +
                "\"menu\":{\"class\":${Json.str(menu.menuClass)}," +
                "\"method\":${Json.str(menu.addItemsMethod)},\"params\":[$params]," +
                "\"scope\":${Json.str(menu.scopeClass)},\"bridge\":${Json.str(menu.scopeBridge)}," +
                "\"popup\":${Json.str(menu.popupStateClass)},\"dismiss\":${Json.str(menu.popupDismiss)}," +
                "\"scopeParameter\":${menu.scopeParameter},\"popupParameter\":${menu.popupParameter}," +
                "\"label\":${Json.str(menu.labelMethod)},\"origin\":${Json.str(menu.origin)}}," +
                "$reportJson\"$PALETTE_KEY\":$paletteJson}"
            File(dir, CACHE_FILE).writeText(text, Charsets.UTF_8)
        }
    }

    /** Drops in-memory state (used when the host version changes at runtime / by tests). */
    fun reset() {
        synchronized(lock) {
            menu = null
            palette = null
            loadedFor = null
            lastDiagnostics = ""
        }
    }
}
