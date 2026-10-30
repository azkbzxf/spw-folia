package dev.spw.folia

import java.io.File
import java.io.IOException
import java.lang.classfile.ClassFile
import java.lang.classfile.instruction.FieldInstruction
import java.lang.classfile.instruction.InvokeInstruction
import java.net.JarURLConnection
import java.net.URISyntaxException
import java.net.URL
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.Collections
import java.util.jar.JarFile

/**
 * Read-only call-graph index over the host's own bytecode.
 *
 * Why this file exists
 * --------------------
 * SPW is R8-obfuscated and every release renames the Compose classes behind the "更多" flyout, so
 * the name-based profiles in [HostTargets] have to be re-pinned per build (see the 1.19.3 rename
 * `घ`/`ะ`/`Ը` → `ɦ`/`ל`/`त`). This index replaces guessing names with *structure*: parse the host
 * archive once, then let callers discover targets by shape (owner/descriptor/callee relationships)
 * instead of by obfuscated identifiers.
 *
 * Design notes
 * ------------
 *  - Parsing uses `java.lang.classfile` (JDK 25), i.e. the JDK's own class-file API; the host runs
 *    on a bundled JRE 25, so no third-party bytecode library is needed or packaged.
 *  - Host classes are never loaded or initialized: only their bytes are read, which keeps the
 *    index usable for classes the plugin must not touch yet (and avoids class-initializer side
 *    effects on the host UI thread).
 *  - The archive entry *name* cannot be trusted: several entries in `ffmpeg-x64.dll` disagree with
 *    the `this_class` of the class inside them, so the owner always comes from `this_class`.
 *  - A cheap prefilter (constant-pool substring probe) skips non-Compose classes before paying for
 *    a full parse; on the 1.19.3 host this cuts the parse count to roughly 27k method bodies in
 *    ~1.4 s.
 *  - Nothing here throws on malformed input: an unparsable class is skipped, and only the
 *    *locating* step reports `IOException` (in Chinese, matching the project's log messages).
 *  - Cancellation is cooperative: [read] polls `isCancelled` (by default the thread interrupt flag)
 *    and aborts with `IOException`, so a background discovery thread can be stopped mid-scan.
 */
internal object HostBytecodeIndex {

    /** A method reference in JVM internal form: `com/xuncorp/...`, `(L...;)V`. */
    data class MethodRef(val owner: String, val name: String, val descriptor: String)

    /** A field reference in JVM internal form: `com/xuncorp/...`, `L...;`. */
    data class FieldRef(val owner: String, val name: String, val descriptor: String)

    /** One method body: its own identity, access flags, and the calls / field accesses it makes. */
    data class Body(
        val method: MethodRef,
        val flags: Int,
        val calls: List<MethodRef>,
        val fields: List<FieldRef>,
    )

    /** One indexed type and the fields it declares itself (inherited fields are not merged). */
    data class TypeInfo(val name: String, val fields: List<FieldRef>)

    /**
     * Immutable snapshot of the index. Lookups are by exact [MethodRef] / internal type name, which
     * is intentional: discovery walks the graph rather than pattern-matching obfuscated strings.
     */
    class Index internal constructor(bodies: Collection<Body>, types: Collection<TypeInfo>) {

        private val byMethod: Map<MethodRef, Body>

        /** Every indexed method body, in discovery order. */
        val bodies: Collection<Body>

        private val byName: Map<String, TypeInfo>

        init {
            val methods = LinkedHashMap<MethodRef, Body>(bodies.size)
            for (body in bodies) methods[body.method] = body
            byMethod = Collections.unmodifiableMap(methods)
            this.bodies = byMethod.values

            val named = LinkedHashMap<String, TypeInfo>(types.size)
            for (type in types) named[type.name] = type
            byName = Collections.unmodifiableMap(named)
        }

        /** `null` when the method is not indexed (no code, or filtered out by the prefilter). */
        fun body(method: MethodRef): Body? = byMethod[method]

        /** `null` when the type was not indexed (absent, or filtered out by the prefilter). */
        fun type(name: String): TypeInfo? = byName[name]

        /** Same contents as [bodies]; kept for call sites that phrase it as a graph query. */
        fun methods(): Collection<Body> = byMethod.values
    }

    private const val CANCELLED = "宿主 UI 字节码索引已取消"

    // --------------------------------------------------------------------- locating ----

    /**
     * Index the archive/directory that contains [hostClass], resolved from its code source.
     *
     * @throws IOException when the host's own bytes cannot be located.
     */
    @Throws(IOException::class)
    fun read(hostClass: Class<*>): Index = read(source(hostClass))

    /**
     * Locate the code source of [hostClass] and index it.
     *
     * `CodeSource.location` is the normal path, but the host's `java.class.path` has exactly one
     * entry (`app/ffmpeg-x64.dll` — a zip renamed to dll) and the location may be absent, so fall
     * back to the class resource: a `jar:` URL yields the archive, a `file:` URL is walked up to the
     * package root.
     */
    private fun source(host: Class<*>): File {
        val name = host.name.replace('.', '/') + ".class"
        val location: URL? = host.protectionDomain?.codeSource?.location
        var resource: URL? = null
        try {
            if (location != null && location.protocol == "file") return Paths.get(location.toURI()).toFile()
            // Class resources stay usable when the host omits its CodeSource location.
            resource = host.getResource("/$name")
            if (resource != null && resource.protocol == "jar") {
                val archive = (resource.openConnection() as JarURLConnection).jarFileURL
                if (archive.protocol == "file") return Paths.get(archive.toURI()).toFile()
            }
            if (resource != null && resource.protocol == "file") {
                var root: Path? = Paths.get(resource.toURI())
                for (segment in name.split('/')) {
                    root = root?.parent
                    if (root == null) break
                }
                if (root != null) return root.toFile()
            }
            throw IOException(
                "无法定位宿主代码来源：" + host.name +
                    " (source=" + (location?.protocol ?: "none") +
                    ", resource=" + (resource?.protocol ?: "none") + ")",
            )
        } catch (error: URISyntaxException) {
            throw IOException("宿主代码来源 URL 无法转换为本地路径：" + host.name, error)
        }
    }

    // ---------------------------------------------------------------------- reading ----

    /**
     * Index a class directory or a jar/zip archive.
     *
     * Directory sources are walked for `*.class`; archives are read through [JarFile] (which also
     * accepts the host's zip-in-a-dll). Multi-release copies (`META-INF/versions/`) and
     * `module-info.class` are skipped, matching the existing `HostTargets` scan convention.
     *
     * @throws IOException when [source] is neither a readable directory nor a readable archive,
     *   or when [isCancelled] trips.
     */
    @Throws(IOException::class)
    fun read(source: File): Index = read(source) { Thread.currentThread().isInterrupted }

    /**
     * Same as [read], but with an explicit cancellation probe so a background discovery thread can
     * abort without relying on interrupt semantics.
     */
    @Throws(IOException::class)
    fun read(source: File, isCancelled: () -> Boolean): Index {
        val bodies = ArrayList<Body>()
        val types = ArrayList<TypeInfo>()

        if (!source.exists()) throw IOException("宿主代码来源不存在：${source.absolutePath}")
        if (source.isDirectory) {
            val root = source.toPath()
            // Materialize the walk first: parsing happens after the stream is closed.
            val paths = ArrayList<Path>()
            Files.walk(root).use { entries ->
                entries.filter { path -> path.toString().endsWith(".class") }.forEach { path ->
                    val relative = root.relativize(path).toString().replace(File.separatorChar, '/')
                    if (!skipped(relative)) paths.add(path)
                }
            }
            for (path in paths) {
                if (isCancelled()) throw IOException(CANCELLED)
                val bytes = runCatching { Files.readAllBytes(path) }.getOrNull() ?: continue
                parse(bytes, bodies, types)
            }
        } else {
            JarFile(source).use { jar ->
                for (entry in Collections.list(jar.entries())) {
                    val name = entry.name
                    if (!name.endsWith(".class")) continue
                    if (skipped(name)) continue
                    if (isCancelled()) throw IOException(CANCELLED)
                    val bytes = runCatching { jar.getInputStream(entry).use { it.readBytes() } }.getOrNull()
                        ?: continue
                    parse(bytes, bodies, types)
                }
            }
        }
        return Index(bodies, types)
    }

    /** Multi-release / module descriptor entries are not host UI code and would duplicate types. */
    private fun skipped(name: String): Boolean =
        name.startsWith("META-INF/versions/") || name == "module-info.class"

    // ---------------------------------------------------------------------- parsing ----

    /**
     * Index one class file. Failures are swallowed on purpose: a single malformed or unexpected
     * class must not abort discovery of the rest of the host.
     *
     * The prefilter reads the raw bytes as ISO-8859-1 (lossless, cheap) and looks for Compose
     * runtime descriptors that any flyout-related class must reference. Classes relocated into
     * `androidx.compose.*` by R8 are covered because the probe only needs the *references*.
     */
    private fun parse(bytes: ByteArray, bodies: MutableList<Body>, types: MutableList<TypeInfo>) {
        val pool = String(bytes, StandardCharsets.ISO_8859_1)
        if (!pool.contains("androidx/compose/runtime/Composer") &&
            !pool.contains("androidx/navigation3/runtime/NavBackStack") &&
            !pool.contains("androidx/compose/runtime/MutableState") &&
            !pool.contains("androidx/compose/runtime/ProvidableCompositionLocal")
        ) {
            return
        }
        runCatching {
            val model = ClassFile.of().parse(bytes)
            // The entry name may disagree with the class it holds; `this_class` is the truth.
            val owner = model.thisClass().asInternalName()
            val ownFields = model.fields().map { field ->
                FieldRef(owner, field.fieldName().stringValue(), field.fieldType().stringValue())
            }
            types += TypeInfo(owner, ownFields)
            for (method in model.methods()) {
                val code = method.code().orElse(null) ?: continue
                val calls = ArrayList<MethodRef>()
                val fields = ArrayList<FieldRef>()
                for (element in code) {
                    if (element is InvokeInstruction) {
                        calls.add(
                            MethodRef(
                                element.owner().asInternalName(),
                                element.name().stringValue(),
                                element.type().stringValue(),
                            ),
                        )
                    } else if (element is FieldInstruction) {
                        fields.add(
                            FieldRef(
                                element.owner().asInternalName(),
                                element.name().stringValue(),
                                element.type().stringValue(),
                            ),
                        )
                    }
                }
                bodies += Body(
                    MethodRef(owner, method.methodName().stringValue(), method.methodType().stringValue()),
                    method.flags().flagsMask(),
                    calls,
                    fields,
                )
            }
        }
    }
}
