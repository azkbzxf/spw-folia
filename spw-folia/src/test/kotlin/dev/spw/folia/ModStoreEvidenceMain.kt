package dev.spw.folia

import java.io.File
import java.nio.file.Files
import java.util.zip.ZipFile

/**
 * One-shot evidence run for issue #23's Kotlin side: install the real sample archive and print the
 * resulting directory tree, so the "no extra directory level" claim can be checked by eye against the
 * filesystem rather than taken from a test assertion.
 *
 * Not a test and not part of any gate — run it by hand:
 * `gradlew runModStoreEvidence` (see build.gradle.kts) or through [main] with the jar on the classpath.
 */
object ModStoreEvidenceMain {

    @JvmStatic
    fun main(args: Array<String>) {
        val repoRoot = findRepoRoot() ?: error("run from inside the repo checkout")
        val sample = File(repoRoot, ".scratch/modtest/aurora.zip")
        require(sample.isFile) { "missing sample: ${sample.absolutePath}" }
        val work = Files.createTempDirectory("spw-folia-modstore-evidence-").toFile()
        work.deleteOnExit()
        val logLines = mutableListOf<String>()
        println("== input ==")
        println("archive      : ${sample.absolutePath} (${sample.length()} bytes)")
        val digest = FoliaModStore.sha256Of(sample)
        println("sha256       : $digest")

        println()
        println("== zip entries (the real market shape) ==")
        ZipFile(sample).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                println("  ${entry.name}  (${entry.size} B)")
            }
        }

        val store = FoliaModStore(work, { logLines.add(it) })
        println()
        println("== install ==")
        val archiveCopy = File(work, "aurora.zip")
        sample.copyTo(archiveCopy)
        val result = store.install(archiveCopy, digest)
        result.fold(
            onSuccess = { println("ok           : ${it.id} ${it.version} enabled=${it.enabled} client=${it.clientEntry} preview=${it.previewEntry}") },
            onFailure = { error("install failed: ${it.message}") },
        )

        println()
        println("== resulting tree under <pluginPath>/mods ==")
        walk(store.root).forEach { println("  $it") }

        println()
        println("== scan() as the page sees it ==")
        val mods = store.scan()
        println("modsJson     : ${FoliaModStore.toJson(mods)}")
        println("one line     : ${!Json.needsCollapsing(FoliaModStore.toJson(mods))}")

        println()
        println("== negative: sha256 mismatch ==")
        val second = File(work, "aurora-bad.zip")
        sample.copyTo(second)
        val bad = store.install(second, "0".repeat(64))
        println("rejected     : ${bad.isFailure}")
        println("reason       : ${bad.exceptionOrNull()?.message}")
        println("archive kept : ${second.exists()}")

        println()
        println("== negative: directory traversal entry ==")
        val evil = File(work, "evil.zip")
        java.util.zip.ZipOutputStream(evil.outputStream()).use { zip ->
            zip.putNextEntry(java.util.zip.ZipEntry("../escaped.txt"))
            zip.write("nope".toByteArray())
            zip.closeEntry()
            zip.putNextEntry(java.util.zip.ZipEntry("mod.json"))
            zip.write("""{"folium":1,"id":"evil","name":"Evil","version":"1.0.0","client":"client.mjs"}""".toByteArray())
            zip.closeEntry()
        }
        val evilResult = store.install(evil, null)
        println("rejected     : ${evilResult.isFailure}")
        println("reason       : ${evilResult.exceptionOrNull()?.message}")
        println("escaped file : ${File(work, "escaped.txt").exists()} (must be false)")
        println("evil mod dir : ${File(store.root, "evil").exists()} (must be false)")

        println()
        println("== log lines ==")
        logLines.forEach { println("  $it") }

        println()
        println("== cleanup ==")
        work.deleteRecursively()
        println("removed ${work.absolutePath}: ${!work.exists()}")
    }

    private fun walk(dir: File, prefix: String = ""): List<String> =
        (dir.listFiles() ?: emptyArray()).sortedBy { it.name }.flatMap { file ->
            val line = prefix + file.name + (if (file.isFile) "  (${file.length()} B)" else "/")
            if (file.isDirectory) listOf(line) + walk(file, "    ") else listOf(line)
        }

    private fun findRepoRoot(): File? {
        var directory: File? = File("").absoluteFile
        while (directory != null) {
            if (File(directory, ".scratch/modtest/aurora.zip").isFile) return directory
            directory = directory.parentFile
        }
        return null
    }
}
