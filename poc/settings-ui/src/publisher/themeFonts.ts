/* v0.1.3: maps the 字体 / 字幕字体 controls onto Folia's derived Theme.
 *
 * Before this module the settings page showed 字体族 / 字重 controls but the derived theme always
 * hard-coded `fontStyle: 'sans'` and never set `fontWeight`, so the visualizer ignored them (they
 * were listed in docs/known-inert-settings.md group C). Folia's renderer resolves the concrete font
 * stack from `Theme.fontStyle` / `Theme.fontWeight` / `Theme.fontFamily` /
 * `Theme.fontFamilyStack` (see work/folia/folia-major-main/src/utils/fontStacks.ts
 * `resolveThemeFontStack`, and components/app/presentation/buildVisualizerTheme.ts, which builds the
 * renderer theme from exactly those four values), so applying the selected values to the theme is
 * enough — no renderer change is needed.
 *
 * v0.4.0: custom fonts are offered again, so a `'custom'` choice no longer degrades to 'sans'. The
 * renderer types `Theme['fontStyle']` as the three built-ins only; a custom face is expressed the way
 * Folia itself expresses it (buildVisualizerTheme.ts:44-45): keep a built-in style as the base and
 * carry the chosen family in `fontFamily`, with the user's fallback list in `fontFamilyStack`. */
import type { Theme } from '@/types';

export interface ThemeFontInputs {
    /** `FontChoice`: 'sans' | 'serif' | 'mono' | 'custom'. */
    fontStyle?: string | null;
    fontWeight?: number | null;
    /** The custom face's family (`lyricsCustomFontFamily`); only used with a 'custom' style. */
    customFontFamily?: string | null;
    /** Fallback families to append after the custom face (`lyricsFontFallbackFamilies`). */
    customFontStack?: readonly string[] | string | null;
}

const BUILTIN_FONT_STYLES: Theme['fontStyle'][] = ['sans', 'serif', 'mono'];

/** `'a, "B C", D'` → `['a', 'B C', 'D']` — matches Folia's `normalizeFontFamilyStack` input shape. */
export const parseFontFamilyStack = (value: readonly string[] | string | null | undefined): string[] => {
    if (Array.isArray(value)) {
        return value.map(family => String(family).trim()).filter(Boolean);
    }
    if (typeof value !== 'string') return [];
    return value
        .split(/[,\n]/)
        .map(family => family.trim().replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
};

/** The base style a custom face is layered on top of (Folia keeps a built-in style as the base). */
export const normalizeFontStyle = (value: string | null | undefined): Theme['fontStyle'] =>
    BUILTIN_FONT_STYLES.includes(value as Theme['fontStyle']) ? (value as Theme['fontStyle']) : 'sans';

/**
 * Returns a copy of `theme` with the selected font family, fallback stack and weight applied.
 * A 'custom' choice keeps a built-in base style and sets `fontFamily`; every other choice clears
 * the custom family, so a stale one can never override the tile the user just picked.
 */
export const applyThemeFonts = (theme: Theme, inputs: ThemeFontInputs): Theme => {
    const customFamily = inputs.customFontFamily?.trim() ? inputs.customFontFamily.trim() : null;
    const useCustom = inputs.fontStyle === 'custom' && customFamily !== null;
    const next: Theme = { ...theme, fontStyle: normalizeFontStyle(inputs.fontStyle) };

    if (useCustom) {
        next.fontFamily = customFamily;
        const stack = parseFontFamilyStack(inputs.customFontStack);
        if (stack.length > 0) {
            next.fontFamilyStack = Array.from(new Set(stack.filter(family => family !== customFamily)));
        } else {
            delete next.fontFamilyStack;
        }
    } else {
        // The renderer resolves the stack from fontStyle when no explicit family is set; keeping a
        // stale custom family here would override the selection.
        delete next.fontFamily;
        delete next.fontFamilyStack;
    }

    if (typeof inputs.fontWeight === 'number' && Number.isFinite(inputs.fontWeight)) {
        next.fontWeight = inputs.fontWeight;
    } else {
        delete next.fontWeight;
    }
    return next;
};
