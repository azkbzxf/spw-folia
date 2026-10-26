import com.xuncorp.spw.workshop.gradle.PluginPermission
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("java-library")
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.compose")
    // PF4J's annotation processor runs through kapt and generates META-INF/extensions.idx.
    // Without that index the host never instantiates @Extension classes (PlaybackExtensionPoint).
    id("org.jetbrains.kotlin.kapt")
    id("com.xuncorp.spw.workshop") version "0.1.0-dev23"
}

group = "dev.spw"
version = "0.4.3"

// A global init.gradle on this machine injects Aliyun mirrors into every project and
// thereby suppresses settings repos, so declare the repositories this build needs here.
repositories {
    maven("https://jitpack.io")
    mavenCentral()
    google()
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}

kotlin {
    jvmToolchain(25)

    compilerOptions {
        jvmTarget = JvmTarget.JVM_25
        freeCompilerArgs.add("-Xjvm-default=all")
    }
}

dependencies {
    // Host already provides the Kotlin stdlib: compile against it, never bundle it.
    compileOnly(kotlin("stdlib"))

    // SPW Workshop API (host provides the implementation at runtime).
    compileOnly("com.github.Moriafly.spw-workshop-api:spw-workshop-api:0.1.0-dev23")

    // PF4J annotations (@Extension); the host ships the PF4J runtime.
    compileOnly("org.pf4j:pf4j:3.12.0")
    // PF4J extension index generation (kapt) — required so the host discovers our @Extension.
    kapt("org.pf4j:pf4j:3.12.0")
    kapt("com.github.Moriafly.spw-workshop-api:spw-workshop-api:0.1.0-dev23")

    // Compose: the host process owns the Compose runtime and the androidx.compose.* classes.
    // compileOnly => nothing is packaged into lib/, so the plugin runs against SPW's Compose
    // (bundling a second runtime would break Composer/Function2 class identity in hooks).
    compileOnly("org.jetbrains.compose.runtime:runtime-desktop:1.12.1")
    compileOnly("org.jetbrains.compose.foundation:foundation-desktop:1.12.1")
    compileOnly("org.jetbrains.compose.ui:ui-desktop:1.12.1")
}

// The canonical Folia settings tree ships as a plugin resource so the helper always receives a
// complete tree on first run (the plugin persists whatever the settings UI sends afterwards).
tasks.processResources {
    from(rootDir.parentFile.resolve("packaging/testdata/default-settings.json"))
}

// Plugin metadata -> written into classes/META-INF/MANIFEST.MF of the .spmod
spmod {
    PluginClass = "dev.spw.folia.FoliaPlugin"
    PluginId = "dev.spw.folia"
    PluginName = "spw-folia"
    PluginDescription = "Folia fullscreen lyric mode for Salt Player for Windows"
    PluginVersion = "0.4.3"
    PluginProvider = "azkbzxf"
    // v0.4.0: preference_config.json declares the plugin's 配置 page (SPW 模组管理 → 配置),
    // which carries the 打开过渡动画 switch read by FoliaPlugin via ConfigManager.
    PluginHasConfig = true
    PluginOpenSourceUrl = "https://github.com/azkbzxf/spw-folia"
    // v0.3.2: KEY_BINDINGS backs the user-configurable open/close shortcut (SPW 快捷键管理).
    PluginPermissions = listOf(
        PluginPermission.CLASS_TRANSFORM,
        PluginPermission.LIBRARY_READ,
        PluginPermission.KEY_BINDINGS
    )
}

// ---------------------------------------------------------------------------------------------
// Local dev asset staging (task-7)
//
// The .spmod format only carries `classes/` + `lib/`, so the native helper and its web bundle are
// staged next to the plugin by scripts/install-local.sh:
//   <plugin dir>/host/spw-folia-host.exe + WebView2 dlls
//   <plugin dir>/web/index.html + assets + settings/settings-ui.js
//   <plugin dir>/web/default-settings.json
// Production packaging is a separate task; this task is the dev-only source of that layout.
// ---------------------------------------------------------------------------------------------
val repoRoot: File = rootDir.parentFile
val devHostDir = File(repoRoot, "poc/webview/host/build")
// packaging/native is re-staged by the host owner (task-9): prefer it over the dev checkout so
// local installs test exactly what ships.
val packagedNativeDir = File(repoRoot, "packaging/native")
val hostSrcDir = if (packagedNativeDir.isDirectory) packagedNativeDir else devHostDir
val devWebDir = File(repoRoot, "poc/webview/dist/dist")
val devSettingsDir = File(repoRoot, "poc/settings-ui/dist")
val devDefaultSettings = File(repoRoot, "packaging/testdata/default-settings.json")

// Local installs must ship the same web layout as the release package. A raw copy of
// poc/webview/dist/dist keeps the PWA service worker (its NavigationRoute answers any navigation,
// including /preview.html, with index.html) and has no generated preview.html / _host/preview-shim.js,
// so the settings-UI live preview iframe landed on the OBS page and stayed at 正在连接 Folia.
// Reuse the production stager instead of duplicating its index.html patching and preview generation.
val stageDevWeb by tasks.registering(Exec::class) {
    description = "Stages the Folia web bundle for local plugin installs (same layout as packaging/web)."
    group = "spw-folia"
    val stageRoot = layout.buildDirectory.dir("web-stage").get().asFile
    val stageWeb = stageRoot.resolve("web")
    val stageReport = stageRoot.resolve("report.json")
    workingDir = repoRoot
    inputs.dir(devWebDir)
    inputs.dir(devSettingsDir)
    inputs.file(File(repoRoot, "poc/webview/host/PreviewShim.js"))
    inputs.file(File(repoRoot, "poc/webview/host/Shim.js"))
    inputs.file(File(repoRoot, "poc/webview/host/Overlay.js"))
    outputs.dir(stageWeb)
    outputs.file(stageReport)
    commandLine(
        "node",
        File(repoRoot, "packaging/tools/stage-web.mjs").absolutePath,
        "--dist", devWebDir.absolutePath,
        "--out", stageWeb.absolutePath,
        "--report", stageReport.absolutePath
    )
}

val syncDevAssets by tasks.registering(Sync::class) {
    description = "Stages the native helper + Folia web bundle for local plugin installs."
    group = "spw-folia"
    dependsOn(stageDevWeb)
    into(layout.buildDirectory.dir("plugin-root"))
    from(hostSrcDir) {
        include(
            "spw-folia-host.exe",
            "spw-folia-host.exe.config",
            "WebView2Loader.dll",
            "Microsoft.Web.WebView2.Core.dll",
            "Microsoft.Web.WebView2.WinForms.dll"
        )
        into("host")
    }
    from(layout.buildDirectory.dir("web-stage/web").get().asFile) { into("web") }
    from(devDefaultSettings) { into("web") }
    onlyIf { hostSrcDir.isDirectory && devWebDir.isDirectory }
}

tasks.named("plugin") {
    dependsOn(syncDevAssets)
}
