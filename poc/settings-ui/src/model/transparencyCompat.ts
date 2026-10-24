/* v0.2.0: per-style compatibility with the transparent (colour-key) player window.
 *
 * The player window is made transparent with a colour key: every pixel the page draws with
 * alpha < 1 gets mixed with the key colour (pure magenta) and shows up as a pink haze in the
 * real window. A style is only usable while the window is transparent when what it paints is
 * either fully opaque (glyphs, line art) or fully transparent — large semi-transparent plates
 * are not.
 *
 * Measured with the alpha probes (docs/archive/verification-v0.2.0.md):
 *  - `native`: the style leaves nothing but glyphs / line art on screen once Folia's own
 *    background renderer is switched off by `background.transparent` (alpha coverage < 24%).
 *  - `tuned`: the style has a full-screen or otherwise large semi-transparent layer that can be
 *    removed through its own tuning (or a scoped CSS rule for `still`). While the window is
 *    transparent the published config carries an extra tuning override; the player's stored
 *    settings are untouched, so the original look comes back as soon as transparency is off.
 *  - `unsupported`: no tuning can remove the layer (monet paints the portrait plate, which is
 *    part of the style's identity; lumiere forces a 94% dark field on light themes). Selecting
 *    the style turns the transparent window off (see `useSettingsStore`).
 *
 * 0.7.22 花火 (order 26) is `tuned`: it paints a night-sky gradient over the whole canvas at
 * `tuning.sky` (default 0.85), and its collage draws a full-bleed dot tiling (120% x 120% of the
 * stage) plus film/lace rails on top. Both are removable through the style's own tuning keys, so
 * transparency stays usable and the window keeps a lyric-only hanabi instead of switching the
 * transparent window off. See the `case 'hanabi'` below for the exact derivation.
 */
import type { StyleMode } from './settings';

export type TransparencyCompat = 'native' | 'tuned' | 'unsupported';

export interface TransparencyCompatContext {
    /** True when the effective theme is light: cover-derived while the window is opaque, the system
     *  colour scheme while it is transparent (v0.3.0, `deriveTheme.ts`/`themeFromSample`). */
    isDaylight: boolean;
}

const STYLE_COMPAT: Record<StyleMode, TransparencyCompat> = {
    sonnet: 'native',
    tempera: 'tuned',
    lumiere: 'tuned',
    hanabi: 'tuned',
    classic: 'native',
    cadenza: 'native',
    partita: 'native',
    fume: 'native',
    tilt: 'native',
    claddagh: 'native',
    monet: 'unsupported',
    pendolo: 'tuned',
    cappella: 'native',
    diorama: 'native',
    still: 'tuned',
};

export const getStyleTransparencyCompat = (
    mode: StyleMode,
    context?: TransparencyCompatContext,
): TransparencyCompat => {
    // 绘光's dark field keeps a 94% alpha floor on light themes (lumiereDarkField.ts), so no
    // tuning can make it transparent there — the plate would cover the whole keyed window.
    if (mode === 'lumiere' && context?.isDaylight === true) return 'unsupported';
    return STYLE_COMPAT[mode] ?? 'native';
};

export const isTransparencySupported = (mode: StyleMode, context?: TransparencyCompatContext): boolean =>
    getStyleTransparencyCompat(mode, context) !== 'unsupported';

/* ---------------------------------------------------------------------------------------------
 * Render-only overrides applied while the player window is transparent. They are merged into the
 * published `visualizerTunings` bundle (`publisher/config.ts`), never into the settings store, so
 * the user's own values survive and come back when transparency is switched off.
 * ------------------------------------------------------------------------------------------- */

/** Extra tuning for one style that removes its large semi-transparent layers. */
export const transparentStyleTuning = (
    mode: StyleMode,
    context: TransparencyCompatContext,
): Record<string, unknown> | null => {
    if (getStyleTransparencyCompat(mode, context) !== 'tuned') return null;
    switch (mode) {
        case 'tempera':
            // 35% paper wash + screentone dots (`temperaSceneBuilder.ts`), plus the post-process
            // grain/vignette that are painted over the whole canvas.
            return { showBlocks: false, postProcessGrain: 0, postProcessVignette: 0 };
        case 'lumiere':
            // 75% dark field (`lumiereDarkField.ts`) + the light field / dust / line art groups.
            return { darkField: 0, textOnly: true };
        case 'pendolo':
            // The centre radial gradient is a ~72%-alpha disc across the watch face.
            return { showCenterGradient: false };
        case 'hanabi':
            // 花火's two full-bleed layers, both read straight from `hanabiTuning` (no rebuild of the
            // already-published config needed, `sky`/`collage` are plain tuning fields):
            //  - `sky` (default 0.85) is hanabiSky.ts's whole-canvas night gradient: `update()` sets
            //    `view.visible = alpha > 0.002`, so 0 removes the layer instead of drawing it at 0
            //    alpha (createHanabiPixiRuntime.ts:314 also forces 0 while `textOnly`).
            //  - `collage` (default 1) gates scene.ts:254 `collageOn = graphicsOn && tuning.collage > 0`,
            //    which builds collage/unitCollage.ts's full-stage dot tiling (120% x 120%, alpha
            //    0.05..0.08) plus the film/lace rails, and the shot collages. At 0 none are created.
            // `textOnly` is deliberately NOT set: it also drops the fireworks, ornaments and ambient
            // dust (scene.ts:183 `graphicsOn = !tuning.textOnly`), which are small bright marks that
            // key out fine — the brief's target look is glyphs + fireworks, not glyphs alone.
            // Left as-is: bloom (a threshold-0.5 glow around bright pixels, not a plate) and the small
            // overlay frame (overlay.ts: seal letters, corner marks — a few unit-percent, like sonnet).
            return { sky: 0, collage: 0 };
        default:
            return null;
    }
};
