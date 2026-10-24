package dev.spw.folia

/**
 * v0.4.0: player-page transparency toggles driven by SPW's shortcut manager.
 *
 * The persisted settings tree is the single source of truth. A shortcut edits the two booleans and
 * hands the whole tree to the host ([FoliaHostBridge.sendSettings]) while a window is running: the
 * host owns the layered-window colour key, applies the mode and re-posts the tree to the page, whose
 * settings store applies it through `applySnapshot` — including the style-compatibility guard that
 * refuses the colour-key mode for styles without transparent rendering (e.g. `monet`, or `lumiere`
 * on a light theme). When the page refuses, it re-emits the corrected tree, which travels back to
 * the plugin and is persisted there (see `FoliaPlugin.onSettingsFromPage`).
 *
 * With no window running there is nothing to apply, so the tree is only persisted and the next open
 * starts in the new mode. The page is the one that resolves compatibility, never this object: the
 * compatibility table lives in the settings UI (`model/transparencyCompat.ts`) and must not be
 * duplicated on the plugin side.
 */
internal object FoliaTransparency {

    /** Settings-tree keys owned by the page's settings store (`model/settings.ts`). */
    const val TRANSPARENT_KEY = "transparentPlayerBackground"
    const val PASSTHROUGH_KEY = "mousePassthrough"

    /** The two flags as the page's settings store understands them. */
    data class Flags(val transparent: Boolean, val passthrough: Boolean)

    /** Reads the flags out of [tree]; a missing member means "off" (the store default). */
    fun read(tree: String): Flags = Flags(
        transparent = Json.boolField(tree, TRANSPARENT_KEY) ?: false,
        passthrough = Json.boolField(tree, PASSTHROUGH_KEY) ?: false
    )

    /** "透明背景" action: leaving transparency always leaves mouse passthrough too. */
    fun nextTransparentOnly(current: Flags): Flags =
        if (current.transparent) Flags(transparent = false, passthrough = false) else Flags(transparent = true, passthrough = false)

    /** "透明背景 + 鼠标穿透" action: turn both on, or both off when already fully on. */
    fun nextTransparentAndPassthrough(current: Flags): Flags =
        if (current.transparent && current.passthrough) {
            Flags(transparent = false, passthrough = false)
        } else {
            Flags(transparent = true, passthrough = true)
        }

    /** Writes [next] into [tree]; members that already carry the wanted value are left untouched. */
    fun apply(tree: String, current: Flags, next: Flags): String {
        var out = tree
        if (current.transparent != next.transparent) {
            out = Json.withBoolMember(out, TRANSPARENT_KEY, next.transparent)
        }
        if (current.passthrough != next.passthrough) {
            out = Json.withBoolMember(out, PASSTHROUGH_KEY, next.passthrough)
        }
        return out
    }

    /** One-line log form, e.g. `transparent=true passthrough=false`. */
    fun describe(flags: Flags): String = "transparent=${flags.transparent} passthrough=${flags.passthrough}"
}
