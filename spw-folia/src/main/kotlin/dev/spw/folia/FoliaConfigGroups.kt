package dev.spw.folia

import com.xuncorp.spw.workshop.api.UnstableSpwWorkshopApi
import com.xuncorp.spw.workshop.api.config.ConfigHelper
import com.xuncorp.spw.workshop.api.config.ConfigManager

/**
 * v0.4.11: 读取 配置 page 的开关，并处理**开关换组**带来的存储迁移。
 *
 * ## 为什么需要这一层
 *
 * SPW 的 `ConfigManager` 按 `preference_config.json` 里每个 config 的 `config` 文件名**分文件**
 * 存取（`getConfig(name)` → 各自一个 `ConfigHelper`）。而 v0.4.11 为了把设置分类理清，把
 * 「详细日志」从 `config.json` 那一组移到了新的 `diagnostics.json` 组。
 *
 * 对用户来说这只是「同一页面上换了个位置」，对存储却是**换了一个文件**：新文件里当然没有
 * `verboseLog`，直接 `get(key, false)` 会得到默认值 —— 用户明明开着详细日志，升级后静默变回关闭，
 * 而且界面上开关显示为关，看起来像是「设置被重置了」。
 *
 * 所以每次读新文件前先过一次 [readBooleanWithLegacy]：
 *
 *  1. 新文件里有这个键 → 以它为准（`present` 标记来自一个哨兵键探测，见下）；
 *  2. 新文件里没有 → 回退读旧文件（`config.json`）里的同名键；
 *  3. 真的读到了旧值 → **立刻写进新文件**，迁移只发生一次，之后以新文件为准。
 *
 * 第 3 步很重要：只回退不迁移的话，用户在**旧**位置上改值还会继续生效（旧文件仍是真源），
 * 两处都能改就永远说不清谁对。写一次之后旧键就彻底不再被读取。
 *
 * ## 怎么判断「新文件里有没有这个键」
 *
 * `ConfigHelper.get(key, default)` 无法区分「键不存在」和「键存在且等于默认值」，而 API 也没有
 * has/getRaw。因此用一个**不可能和真实键冲突的哨兵**做类型探测：`get(key, SENTINEL)` 返回的类型
 * 若不是 String，就说明键存在（返回值来自存储）；返回哨兵本身则说明键不存在。
 *
 * 这不是猜的：SPW 的默认值只在键缺失时使用，读取路径不会把一个真实布尔变成字符串。
 */
@OptIn(UnstableSpwWorkshopApi::class)
internal object FoliaConfigGroups {

    /** The group whose file every pre-v0.4.11 switch lived in. */
    const val LEGACY_CONFIG = "config.json"

    /** v0.4.11: new group for「排查问题才打开」的开关（当前只有 详细日志）。 */
    const val DIAGNOSTICS_CONFIG = "diagnostics.json"

    /** v0.4.11: 播放页组（观感相关），也是向后兼容的旧文件。 */
    const val PLAYER_CONFIG = LEGACY_CONFIG
    /**
     * Reads a boolean, falling back to [LEGACY_CONFIG] when [primary] has no such key.
     *
     * [configs] is the already-created manager; a null means the config layer is unavailable and the
     * caller should keep its current value. Never throws.
     *
     * @return the value plus whether it came from the legacy file (so the caller can log the
     *   migration instead of silently changing behaviour).
     */
    data class Migrated(val value: Boolean, val fromLegacy: Boolean, val migrated: Boolean)

    fun readBoolean(
        manager: ConfigManager?,
        primary: String,
        legacy: String,
        key: String,
        fallback: Boolean,
        log: (String) -> Unit,
    ): Migrated {
        if (manager == null) return Migrated(fallback, fromLegacy = false, migrated = false)

        val primaryHelper = helperOrNull(manager, primary, log)
        val primaryPresent = primaryHelper != null && hasKey(primaryHelper, key, log)
        if (primaryPresent) {
            val value = boolOrNull(primaryHelper!!, key, log) ?: fallback
            return Migrated(value, fromLegacy = false, migrated = false)
        }

        // Not in the new file: fall back to the old one, then move it across so both files cannot
        // disagree from here on.
        val legacyHelper = if (legacy == primary) null else helperOrNull(manager, legacy, log)
        if (legacyHelper == null || !hasKey(legacyHelper, key, log)) {
            return Migrated(fallback, fromLegacy = false, migrated = false)
        }
        val value = boolOrNull(legacyHelper, key, log) ?: return Migrated(fallback, fromLegacy = false, migrated = false)
        val wrote = runCatching {
            primaryHelper?.set(key, value)
            primaryHelper?.save() ?: false
        }.getOrElse { t ->
            log("config migrate $key failed: ${t::class.java.name}: ${t.message}")
            false
        }
        log(
            "config migrated $key=$value from $legacy to $primary" +
                (if (wrote) "" else " (write failed; will retry next read)")
        )
        return Migrated(value, fromLegacy = true, migrated = wrote)
    }

    private fun helperOrNull(manager: ConfigManager, name: String, log: (String) -> Unit): ConfigHelper? =
        runCatching { manager.getConfig(name) }.getOrElse { t ->
            log("config open $name failed: ${t::class.java.name}: ${t.message}")
            null
        }

    /**
     * True when [helper] actually holds [key].
     *
     * The API has no `hasKey`, and `get(key, default)` cannot distinguish "absent" from "present and
     * equal to the default". The trick that works is a **null default**: the host returns it only when
     * the key is missing, and every value this plugin stores is a Boolean, so a stored value is never
     * null either.
     *
     * The default's *type* matters: `get` is generic and the host casts the stored value to the type it
     * is asked for, so a `String` (or `Boolean`) sentinel would throw `ClassCastException` on a stored
     * value of the other type — which an earlier version of this function did, silently skipping the
     * migration for exactly the users it was written for. Passing `null` (type `Any?`) asks for no cast.
     */
    private fun hasKey(helper: ConfigHelper, key: String, log: (String) -> Unit): Boolean {
        val probe: Any? = runCatching { helper.get<Any?>(key, null) }.getOrElse { t ->
            // A throwing probe proves nothing either way; treat as absent so the caller falls back to
            // the legacy file, which is the safe direction for a migration.
            log("config probe $key failed: ${t::class.java.name}: ${t.message}")
            return false
        }
        return probe != null
    }

    private fun boolOrNull(helper: ConfigHelper, key: String, log: (String) -> Unit): Boolean? = runCatching {
        // The value must be taken as `Any?` *and stored in an `Any?` first*: the host casts the stored
        // value to the static type of the call, and Kotlin inserts that `checkcast` at the call site by
        // inference. Assigning to `Any?` keeps the cast out of the generated code, so a stored String
        // or a Number reaches the `when` below instead of throwing ClassCastException before it.
        val raw: Any? = helper.get<Any?>(key, null)
        when (raw) {
            is Boolean -> raw
            // A JSON round trip can turn a boolean into a string; treat only the two real spellings
            // as a value, so a hand-edited file cannot silently mean "on".
            is String -> when (raw.trim().lowercase()) {
                "true" -> true
                "false" -> false
                else -> null
            }
            else -> null
        }
    }.getOrElse { t ->
        log("config read $key failed: ${t::class.java.name}: ${t.message}")
        null
    }
}
