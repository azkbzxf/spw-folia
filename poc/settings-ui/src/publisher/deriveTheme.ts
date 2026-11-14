/* Cover → Theme derivation, done in the page from the cover data URL (protocol §4): the host only
 * hands over bytes, the page picks the colours with a canvas so the palette matches the artwork. */
import type { Theme } from '@/types';

const DARK_FALLBACK: Theme = {
    name: 'Midnight Default',
    backgroundColor: '#09090b',
    primaryColor: '#f4f4f5',
    accentColor: '#f4f4f5',
    secondaryColor: '#71717a',
    fontStyle: 'sans',
    animationIntensity: 'normal',
};

/* v0.3.0: the transparent window follows the *system* colour scheme, so a light system needs a
 * light fallback for covers that fail to load (the cover still decides the hue when it loads). */
const LIGHT_FALLBACK: Theme = {
    name: 'Daylight Default',
    backgroundColor: '#fafafa',
    primaryColor: '#18181b',
    accentColor: '#18181b',
    secondaryColor: '#71717a',
    fontStyle: 'sans',
    animationIntensity: 'normal',
};

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** The sampled colours of one cover: the canvas average plus its most saturated bucket. */
export interface CoverSample {
    average: Rgb;
    accent: Rgb;
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const toHex = ({ r, g, b }: Rgb) =>
    `#${clampByte(r).toString(16).padStart(2, '0')}${clampByte(g).toString(16).padStart(2, '0')}${clampByte(b).toString(16).padStart(2, '0')}`;

const luminance = ({ r, g, b }: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const saturation = ({ r, g, b }: Rgb) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
};

const mix = (a: Rgb, b: Rgb, amount: number): Rgb => ({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
});

const scale = (color: Rgb, factor: number): Rgb => ({ r: color.r * factor, g: color.g * factor, b: color.b * factor });

/** The average colour of a canvas' pixels, plus its most saturated bucket (the accent). */
const sampleColors = (canvas: HTMLCanvasElement): { average: Rgb; accent: Rgb } => {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { average: { r: 9, g: 9, b: 11 }, accent: { r: 244, g: 244, b: 245 } };
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    const buckets = new Map<string, { sum: Rgb; n: number; sat: number }>();
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
        r += color.r;
        g += color.g;
        b += color.b;
        count += 1;
        const key = `${color.r >> 5}-${color.g >> 5}-${color.b >> 5}`;
        const bucket = buckets.get(key) ?? { sum: { r: 0, g: 0, b: 0 }, n: 0, sat: 0 };
        bucket.sum.r += color.r;
        bucket.sum.g += color.g;
        bucket.sum.b += color.b;
        bucket.n += 1;
        buckets.set(key, bucket);
    }
    if (count === 0) return { average: { r: 9, g: 9, b: 11 }, accent: { r: 244, g: 244, b: 245 } };
    const average = { r: r / count, g: g / count, b: b / count };
    let accent = average;
    let best = -1;
    for (const bucket of buckets.values()) {
        const mean = { r: bucket.sum.r / bucket.n, g: bucket.sum.g / bucket.n, b: bucket.sum.b / bucket.n };
        const score = saturation(mean) * Math.log2(bucket.n + 2);
        if (score > best) {
            best = score;
            accent = mean;
        }
    }
    return { average, accent };
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('cover image failed to load'));
        image.src = src;
    });

/** v0.3.0: a system-driven palette must keep every text colour on the scheme's own side of the
 *  contrast line, or a dark cover accent would stay unreadable over the desktop. */
const ensureContrast = (color: Rgb, isLight: boolean): Rgb => {
    const level = luminance(color);
    if (isLight) {
        // light system → dark text: pull below the 0.45 lightness ceiling.
        return level <= 0.45 ? color : mix(color, { r: 0, g: 0, b: 0 }, (level - 0.45) / Math.max(level, 1e-6));
    }
    // dark system → light text: push above the 0.55 lightness floor.
    return level >= 0.55 ? color : mix(color, { r: 255, g: 255, b: 255 }, (0.55 - level) / Math.max(1 - level, 1e-6));
};

/** Builds a Folia Theme from a sampled cover. `isLightOverride` (v0.3.0) forces the light/dark side
 *  instead of the cover's own darkness — the transparent window follows the system colour scheme,
 *  while the cover still supplies the hue.
 *
 *  issue #22 item 2: `options.textIsLight` forces the side of the **text** colours alone, leaving the
 *  background's own side (and therefore `isDaylight`, which the renderers branch on) where it was.
 *  That split is the whole point of the setting: 浅色/深色文字 is a statement about the TEXT, not about
 *  the picture. Reusing `isLightOverride` for it would have flipped `isDaylight` too, and every style
 *  that paints a different palette per side (绘光's dark field, 凝彩's tone ground, …) would have
 *  switched its whole composition — i.e. the background, which the issue explicitly says must not move.
 *  Omitted (or equal to the background side) it changes nothing: the text follows the background
 *  exactly as before. */
export const themeFromSample = (
    sample: CoverSample | null,
    name?: string,
    isLightOverride?: boolean,
    options?: { textIsLight?: boolean },
): { theme: Theme; isDaylight: boolean } => {
    const isLight = isLightOverride ?? (sample ? luminance(sample.average) > 0.55 : false);
    const textIsLight = options?.textIsLight ?? isLight;
    if (!sample) {
        // 没有封面色时用的是两套固定调色板；文字侧与背景侧不同时按文字侧选，背景色仍归背景侧。
        const fallback = textIsLight ? LIGHT_FALLBACK : DARK_FALLBACK;
        if (textIsLight === isLight) return { theme: fallback, isDaylight: isLight };
        return { theme: { ...fallback, backgroundColor: (isLight ? LIGHT_FALLBACK : DARK_FALLBACK).backgroundColor }, isDaylight: isLight };
    }
    const { average, accent } = sample;
    // 两侧各自的两个基色：背景按 `isLight` 选，文字按 `textIsLight` 选。`textIsLight === isLight` 时
    // 下面每一行都与引入这个选项之前逐字相同。
    const lightBase = mix(average, { r: 255, g: 255, b: 255 }, 0.45);
    const background = isLight ? lightBase : scale(average, 0.28);
    const primary = textIsLight ? scale(lightBase, 0.16) : mix(average, { r: 255, g: 255, b: 255 }, 0.9);
    const accentColor = saturation(accent) < 0.12 ? mix(primary, accent, 0.4) : mix(accent, { r: 255, g: 255, b: 255 }, 0.15);
    const secondary = mix(primary, background, 0.55);
    // Only the system-driven side re-checks contrast; the cover-driven palette (the non-transparent
    // window) must keep its exact v0.1.x colours. issue #22 item 2: an explicit 浅色/深色文字 choice
    // counts as system-driven for the same reason a system scheme does — the user named a side, so the
    // text has to be readable on it. This never pulls a colour the user picked (they pick a side, not a
    // value): it only clamps colours that would sit on the wrong side of the contrast line, i.e. the
    // cover's accent and the mid-tone secondary. A light-side primary (≈0.9 luminance) and a dark-side
    // one (≈0.16) are already inside the bound and come through untouched.
    const systemDriven = isLightOverride !== undefined || options?.textIsLight !== undefined;
    const font = (color: Rgb) => toHex(systemDriven ? ensureContrast(color, textIsLight) : color);
    const theme: Theme = {
        name: name ?? 'Cover Theme',
        backgroundColor: toHex(background),
        primaryColor: font(primary),
        accentColor: font(accentColor),
        secondaryColor: font(secondary),
        fontStyle: 'sans',
        animationIntensity: 'normal',
    };
    return { theme, isDaylight: isLight };
};

/** Samples a cover data URL through the 48×48 canvas (protocol §4). Null when it fails to load. */
export const sampleCover = async (coverUrl: string): Promise<CoverSample | null> => {
    try {
        const image = await loadImage(coverUrl);
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return sampleColors(canvas);
    } catch {
        return null;
    }
};

/** Builds a Folia Theme from a cover image; `isDaylight` says whether the result is a light theme.
 *  `options.isLight` (v0.3.0) overrides the cover's darkness — see `themeFromSample`. */
export const deriveThemeFromCover = async (
    coverUrl: string | null | undefined,
    name?: string,
    options?: { isLight?: boolean },
): Promise<{ theme: Theme; isDaylight: boolean }> => {
    if (!coverUrl) return themeFromSample(null, name, options?.isLight);
    return themeFromSample(await sampleCover(coverUrl), name, options?.isLight);
};

export const DEFAULT_THEME = DARK_FALLBACK;
