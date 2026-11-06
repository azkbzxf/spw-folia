@file:OptIn(UnstableSpwWorkshopApi::class)

package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.config.ConfigHelper

/**
 * v0.5.0 一次性更新通知：**只在这个版本第一次运行时**弹一条成功 toast，之后永不再弹。
 *
 * ## 为什么是「一次性」而不是「每个版本都弹」
 *
 * 这个位置（SPW 主窗口底部）本来就有过一条启动成功提示，v0.3.2 按 issue #9 专门删掉了，理由写在
 * [FoliaPlugin.start] 的注释里：**每次启动都弹一条成功提示是纯噪音，用户会学会无视它**。
 *
 * 所以这次加回来的合法性只有一个来源 —— 它**只发生一次**。判定因此被拆成两层，缺一不可：
 *
 *  1. [shouldShow] 的第一个条件 `pluginVersion == NOTICE_VERSION`：通知只属于 [NOTICE_VERSION]
 *     这一个版本。0.5.1、0.6.0 上这段代码原样存在，但**永远不会弹** —— 将来真要再通知一次，
 *     改 [NOTICE_VERSION] 这一个常量即可，不会误触。
 *  2. 第二个条件 `noticedVersion != NOTICE_VERSION`：同一版本内只弹一次，标记持久化在插件的
 *     config store 里（键 [KEY_NOTICED_VERSION]），升级、重装、重启都记得。
 *
 * ## 为什么判定要单独成一个对象
 *
 * 这样它可以被单元测试直接驱动（`FoliaUpdateNoticeTest`），不必启动 SPW。真正的失败模式是
 * 「每个版本都弹」「同版本弹两次」这类判定错误，它们都不会在界面上暴露成崩溃，只会在下一次
 * 发布时悄悄变成噪音 —— 正是需要测试钉住的那类缺陷。
 */
internal object FoliaUpdateNotice {

    /**
     * 唯一会显示通知的插件版本。
     *
     * **不要**把它写成「每个版本都弹」的形式，也不要让它跟随 `PLUGIN_VERSION` 自动变化：
     * 它的全部意义就是「只有这一次」。
     */
    const val NOTICE_VERSION = "0.5.0"

    /**
     * 持久化标记键，存的是「上次为哪个版本弹过」。
     *
     * 和 `settingsJson` / `textureDefaultMigrated` 同一个 store（插件默认 config 文件）。存**版本号**
     * 而不是布尔值，是为了让将来「再来一次」的场景可以只改 [NOTICE_VERSION] 而不动存储格式。
     */
    const val KEY_NOTICED_VERSION = "updateNoticeShownVersion"

    /**
     * Whether this start should show the notice.
     *
     * @param pluginVersion the actually running build ([FoliaPlugin.PLUGIN_VERSION]).
     * @param noticedVersion the persisted marker, or null when the key is absent (fresh install).
     */
    fun shouldShow(pluginVersion: String, noticedVersion: String?): Boolean =
        pluginVersion == NOTICE_VERSION && noticedVersion?.trim() != NOTICE_VERSION

    /** The user-facing text. The version is interpolated so it can never disagree with the build. */
    fun message(pluginVersion: String): String =
        "模组spw-folia已更新至${pluginVersion}版本（重要更新）"

    // ------------------------------------------------------------------ storage ----

    /**
     * Reads the persisted marker from **disk**, not from the host's cached helper.
     *
     * ## Why disk (v0.5.0 hotfix, found on a real machine)
     *
     * The first implementation used `ConfigHelper.get(key, default)`. A restart with
     * `{"updateNoticeShownVersion":"0.5.0"}` already on disk **still showed the notice**: the host's
     * `createConfigManager().getConfig()` hands back a helper whose in-memory view can predate the
     * file (the same defect [FoliaConfigSync] was rewritten around in v0.4.12 — see its class doc:
     * "`getConfig()` 返回缓存"). A `get` that misses returns the default, which is indistinguishable
     * from "never shown".
     *
     * The file is the only reliable source, so this reads it the same way [FoliaConfigSync] does.
     * `ConfigHelper.getConfigPath()` still comes from the helper — it is the one thing that must be
     * asked of the host — but the VALUE is parsed from the raw JSON text.
     *
     * Never throws: a broken config layer must not be able to break plugin start-up.
     */
    fun readNoticedVersion(helper: ConfigHelper?): String? {
        val config = helper ?: return null
        return runCatching {
            val file = config.getConfigPath().toFile()
            if (!file.isFile) return null
            val text = file.readText(Charsets.UTF_8)
            if (text.isBlank()) return null
            // A flat root-level string member; Json.stringField is the same parser the line protocol
            // uses (it also validates escapes rather than returning a plausible-but-wrong value).
            Json.stringField(text, KEY_NOTICED_VERSION)?.takeIf { it.isNotBlank() }
        }.getOrNull()
    }

    /**
     * Writes the marker through the host helper (which owns the file) and **verifies it landed**.
     *
     * The read-back is not paranoia: the whole point of this feature is "exactly once", and a
     * `save()` that returns true while the value is not actually readable is precisely the failure
     * that shipped in the first 0.5.0 build. Verification goes through [readNoticedVersion], so it
     * checks the same path the next start-up will use.
     */
    fun writeNoticedVersion(helper: ConfigHelper?, version: String): Boolean {
        val config = helper ?: return false
        return runCatching {
            config.set(KEY_NOTICED_VERSION, version)
            if (!config.save()) return false
            // Confirm through the DISK path; a mismatch means the next start would show it again.
            readNoticedVersion(config) == version
        }.getOrDefault(false)
    }
}
