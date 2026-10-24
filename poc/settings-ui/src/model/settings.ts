/* The POC's configuration store. Field names and defaults mirror Folia's own settings store (its
 * `src/types.ts` defaults) so the reused settings panels can be handed the exact shape they expect;
 * only the persistence layer differs (memory + host bridge here). */
import { create } from 'zustand';
import {
    DEFAULT_CADENZA_TUNING,
    DEFAULT_CAPPELLA_TUNING,
    DEFAULT_CLADDAGH_TUNING,
    DEFAULT_CLASSIC_TUNING,
    DEFAULT_DIORAMA_TUNING,
    DEFAULT_FUME_TUNING,
    DEFAULT_LATENT_BACKGROUND_TUNING,
    DEFAULT_LUMIERE_TUNING,
    DEFAULT_MONET_BACKGROUND_TUNING,
    DEFAULT_MONET_TUNING,
    DEFAULT_NOMAND_BACKGROUND_TUNING,
    DEFAULT_PARTITA_TUNING,
    DEFAULT_PENDOLO_TUNING,
    DEFAULT_SMART_BEAT_SETTINGS,
    DEFAULT_SONNET_TUNING,
    DEFAULT_SORA_BACKGROUND_TUNING,
    DEFAULT_TEMPERA_TUNING,
    DEFAULT_TILT_TUNING,
    type SmartBeatSettings,
} from '@/types';
import { getStyleTransparencyCompat } from './transparencyCompat';
import { systemPrefersLight } from './theme';
/* 0.7.22 花火's tuning defaults live with the style's own module, not in `src/types.ts` (unlike the
 * 14 older styles), so they are imported from there. */
import { DEFAULT_HANABI_TUNING } from '@/components/visualizer/hanabi/types';

export type StyleMode =
    | 'sonnet'
    | 'tempera'
    | 'lumiere'
    /** 0.7.22 花火: order 26, between 绘光 (25) and 古典 (30) on Folia's own shelf. */
    | 'hanabi'
    | 'classic'
    | 'cadenza'
    | 'partita'
    | 'fume'
    | 'tilt'
    | 'claddagh'
    | 'monet'
    | 'pendolo'
    | 'cappella'
    | 'diorama'
    | 'still';

export type BackgroundMode = 'common' | 'monet' | 'nomand' | 'latent' | 'url' | 'sora';

export type SettingsSection = 'visualizer' | 'background' | 'common' | 'subtitle';

export type FontChoice = 'sans' | 'serif' | 'mono' | 'custom';

/** 预览文本 choices. `current` (v0.4.0) samples the song that is actually playing; it is the
 *  default so the font section previews the user's own lyrics, matching Folia 0.7.22. */
export type PreviewPlaceholderId = 'current' | 'default' | 'reserved';

/** Each style's tuning defaults, imported from Folia so its own panel shows Folia's values. */
export const STYLE_TUNING_DEFAULTS: Record<StyleMode, Record<string, unknown>> = {
    sonnet: { ...DEFAULT_SONNET_TUNING },
    tempera: { ...DEFAULT_TEMPERA_TUNING },
    lumiere: { ...DEFAULT_LUMIERE_TUNING },
    hanabi: { ...DEFAULT_HANABI_TUNING },
    classic: { ...DEFAULT_CLASSIC_TUNING },
    cadenza: { ...DEFAULT_CADENZA_TUNING },
    partita: { ...DEFAULT_PARTITA_TUNING },
    fume: { ...DEFAULT_FUME_TUNING },
    tilt: { ...DEFAULT_TILT_TUNING },
    claddagh: { ...DEFAULT_CLADDAGH_TUNING },
    monet: { ...DEFAULT_MONET_TUNING },
    pendolo: { ...DEFAULT_PENDOLO_TUNING },
    cappella: { ...DEFAULT_CAPPELLA_TUNING },
    diorama: { ...DEFAULT_DIORAMA_TUNING },
    still: {},
};

/** Folia's settings keys for each style's tuning: `settings.<key>` is what a style's panel sees. */
export const STYLE_TUNING_KEYS: Record<StyleMode, string> = {
    sonnet: 'sonnetTuning',
    tempera: 'temperaTuning',
    lumiere: 'lumiereTuning',
    hanabi: 'hanabiTuning',
    classic: 'classicTuning',
    cadenza: 'cadenzaTuning',
    partita: 'partitaTuning',
    fume: 'fumeTuning',
    tilt: 'tiltTuning',
    claddagh: 'claddaghTuning',
    monet: 'monetTuning',
    pendolo: 'pendoloTuning',
    cappella: 'cappellaTuning',
    diorama: 'dioramaTuning',
    still: 'stillTuning',
};

export const BACKGROUND_TUNING_DEFAULTS: Record<'monet' | 'nomand' | 'latent' | 'sora', Record<string, unknown>> = {
    monet: { ...DEFAULT_MONET_BACKGROUND_TUNING },
    nomand: { ...DEFAULT_NOMAND_BACKGROUND_TUNING },
    latent: { ...DEFAULT_LATENT_BACKGROUND_TUNING },
    sora: { ...DEFAULT_SORA_BACKGROUND_TUNING },
};

/** The shelf order of `model/styles.tsx` (each entry's `order` ascending). Duplicated here because
 *  `styles.tsx` imports `StyleMode` from this module — a value import back would be a cycle.
 *  `styles.tsx` asserts the two lists agree at module load. */
export const STYLE_MODE_SHELF_ORDER: StyleMode[] = [
    'sonnet', 'tempera', 'lumiere', 'hanabi', 'classic', 'cadenza', 'partita', 'fume',
    'tilt', 'claddagh', 'monet', 'pendolo', 'cappella', 'diorama', 'still',
];

/** 0.7.22 随机歌词样式's default pool: every style ticked, in Folia's shelf order. */
export const DEFAULT_RANDOM_VISUALIZER_MODES: StyleMode[] = [...STYLE_MODE_SHELF_ORDER];

/** Keeps only known styles, in shelf order; an empty selection means "everything". */
export const normalizeRandomModes = (value: unknown): StyleMode[] => {
    const selected = new Set(Array.isArray(value) ? value : []);
    const modes = STYLE_MODE_SHELF_ORDER.filter(mode => selected.has(mode));
    return modes.length > 0 ? modes : [...STYLE_MODE_SHELF_ORDER];
};

/** Picks inside the pool, excluding the current style whenever another choice exists. */
export const pickRandomMode = (
    modes: readonly StyleMode[],
    current: StyleMode,
    random: () => number = Math.random,
): StyleMode => {
    const pool = normalizeRandomModes(modes);
    const alternatives = pool.filter(mode => mode !== current);
    const candidates = alternatives.length > 0 ? alternatives : pool;
    return candidates[Math.floor(random() * candidates.length)];
};

export interface CommonBackgroundSettings {
    opacity: number;
    useCoverColorBg: boolean;
    disableVignette: boolean;
    disableGeometricBackground: boolean;
}

export interface AppearanceSettings {
    fontStyle: FontChoice;
    fontScale: number;
    fontWeight: number | null;
    visualizerOpacity: number;
    customFontFamily: string | null;
    /** v0.4.0: fallback families for a custom font (Folia's `fontFamilyStack`), comma-separated list. */
    customFontStack: string | null;
    /** v0.4.0: which custom font source is in use — `null` when the built-in faces are selected. */
    customFontSource: CustomFontSource | null;
}

/** A user-chosen lyrics font. `system` picks one already installed on this machine (Chromium's
 *  Local Font Access API); `uploaded` is a font file the user imported, registered through the
 *  FontFace API and persisted in IndexedDB so it survives a page reload. */
export type CustomFontSource = 'system' | 'uploaded';

/** One uploaded font as the settings tree persists it (the Blob stays in IndexedDB, keyed by id). */
export interface UploadedFontDescriptor {
    id: string;
    label: string;
    family: string;
    createdAt: number;
}

export interface SubtitleSettings {
    hideTranslationSubtitle: boolean;
    subtitleContentMode: 'translation' | 'romanization' | 'both' | 'none';
    subtitleOverlayOpacity: number;
    subtitleOverlayBackground: boolean;
    subtitleUpcomingLyricsBlur: boolean;
    showHarmonySubtitle: boolean;
    harmonySubtitleBackground: boolean;
    subtitleFontInheritsLyrics: boolean;
    subtitleFontStyle: FontChoice;
    subtitleFontWeight: number | null;
    subtitleFontScale: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
    fontStyle: 'sans',
    fontScale: 1,
    fontWeight: null,
    visualizerOpacity: 1,
    customFontFamily: null,
    customFontStack: null,
    customFontSource: null,
};

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
    hideTranslationSubtitle: false,
    subtitleContentMode: 'translation',
    subtitleOverlayOpacity: 0.6,
    subtitleOverlayBackground: true,
    subtitleUpcomingLyricsBlur: true,
    showHarmonySubtitle: true,
    harmonySubtitleBackground: true,
    subtitleFontInheritsLyrics: true,
    subtitleFontStyle: 'sans',
    subtitleFontWeight: null,
    subtitleFontScale: 1,
};

/** Mirrored Folia storage keys (canonical tree in packaging/testdata/default-settings.json). */
export const DEFAULT_LYRIC_MOTION = 0.8;
export const DEFAULT_TEXTURE_RESOLUTION = 1.0;

export const DEFAULT_COMMON_BACKGROUND: CommonBackgroundSettings = {
    opacity: 0.75,
    useCoverColorBg: false,
    disableVignette: false,
    disableGeometricBackground: false,
};

interface BeatEffectPatch {
    on?: boolean;
    strength?: number;
}

interface SettingsState {
    activeSection: SettingsSection;
    setActiveSection: (section: SettingsSection) => void;

    visualizerMode: StyleMode;
    /** `options.preserveRandom` (0.7.22): a per-song reroll must not switch 随机模式 back off. */
    setVisualizerMode: (mode: StyleMode, options?: { preserveRandom?: boolean; notify?: boolean }) => void;

    /** Folia's own method names. `stubs/useVisualizerSettingsStore.ts` aliases Folia's store to this
     *  one, so the reused RandomPoolGroup / lyricStyleChoices code calls these three directly. */
    handleSetVisualizerMode: (mode: StyleMode, options?: { notify?: boolean; preserveRandom?: boolean }) => void;
    handleToggleRandomVisualizerModePerSong: (enable: boolean, options?: { notify?: boolean }) => void;
    handleSetRandomVisualizerModes: (modes: readonly StyleMode[]) => void;

    /** 0.7.22 随机歌词样式: one style drawn per song from `randomVisualizerModes`. */
    randomVisualizerModePerSong: boolean;
    setRandomVisualizerModePerSong: (enabled: boolean) => void;
    randomVisualizerModes: StyleMode[];
    setRandomVisualizerModes: (modes: readonly StyleMode[]) => void;
    /** Another style from the pool for the song that is playing (never the current one). */
    rerollVisualizerMode: () => void;

    previewPlaceholderId: PreviewPlaceholderId;
    setPreviewPlaceholderId: (id: PreviewPlaceholderId) => void;

    /** Folia storage keys mirrored for round-trip fidelity (no control in this window yet). */
    lyricMotion: number;
    setLyricMotion: (value: number) => void;
    textureResolution: number;
    setTextureResolution: (value: number) => void;

    smartBeat: SmartBeatSettings;
    handleSetSmartBeat: (patch: { enabled?: boolean; effects?: Record<string, BeatEffectPatch> }) => void;

    styleTunings: Record<StyleMode, Record<string, unknown>>;
    setStyleTuning: (mode: StyleMode, patch: Record<string, unknown>) => void;
    resetStyleTuning: (mode: StyleMode) => void;

    /** Folia player-page transparent background: the host window goes colour-key transparent so the
     *  desktop shows through (v0.1.7). */
    transparentPlayerBackground: boolean;
    setTransparentPlayerBackground: (value: boolean) => void;

    /** v0.1.9: while the player background is transparent, let the mouse fall through to the desktop
     *  (the bottom-right round button and the top-right gear stay clickable). */
    mousePassthrough: boolean;
    setMousePassthrough: (value: boolean) => void;

    /** v0.2.0: effective theme lightness, mirrored from `useConfigPublisher` so the transparent
     *  window guard can tell whether lumiere's light-theme dark field floor applies. v0.3.0: the
     *  cover decides while the window is opaque, the system colour scheme while it is transparent.
     *  Not persisted. */
    isDaylightTheme: boolean;
    setIsDaylightTheme: (value: boolean) => void;

    backgroundMode: BackgroundMode;
    setBackgroundMode: (mode: BackgroundMode) => void;
    backgroundTunings: Record<'monet' | 'nomand' | 'latent' | 'sora', Record<string, unknown>>;
    setBackgroundTuning: (mode: 'monet' | 'nomand' | 'latent' | 'sora', patch: Record<string, unknown>) => void;
    resetBackgroundTuning: (mode: 'monet' | 'nomand' | 'latent' | 'sora') => void;
    commonBackground: CommonBackgroundSettings;
    setCommonBackground: (patch: Partial<CommonBackgroundSettings>) => void;

    appearance: AppearanceSettings;
    setAppearance: (patch: Partial<AppearanceSettings>) => void;
    resetAppearance: () => void;

    /** v0.4.0: font files the user imported. The file itself lives in IndexedDB under `id`; only
     *  this descriptor list rides the settings tree (so import/export and sync carry the names). */
    uploadedFonts: UploadedFontDescriptor[];
    setUploadedFonts: (fonts: readonly UploadedFontDescriptor[]) => void;
    addUploadedFont: (descriptor: UploadedFontDescriptor) => void;
    removeUploadedFont: (id: string) => void;

    subtitle: SubtitleSettings;
    setSubtitle: (patch: Partial<SubtitleSettings>) => void;
    resetSubtitle: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
    activeSection: 'visualizer',
    setActiveSection: activeSection => set({ activeSection }),

    visualizerMode: 'sonnet',
    // v0.2.0: some styles paint a large semi-transparent plate (monet's portrait card, lumiere's
    // light-theme dark field) that the colour-key window would turn into a pink haze. Selecting one
    // of those turns the transparent window (and mouse pass-through) back off, so the style is
    // always usable — see `model/transparencyCompat.ts`.
    setVisualizerMode: (visualizerMode, options) =>
        set(state => {
            const compat = getStyleTransparencyCompat(visualizerMode, { isDaylight: state.isDaylightTheme });
            // 0.7.22: a reroll inside the random pool keeps 随机 on; a style the user picked by hand
            // while random was on means "play this one", so random switches itself off then.
            const randomPatch = options?.preserveRandom ? {} : { randomVisualizerModePerSong: false };
            if (compat !== 'unsupported') return { visualizerMode, ...randomPatch };
            if (!state.transparentPlayerBackground) return { visualizerMode, ...randomPatch };
            return { visualizerMode, ...randomPatch, transparentPlayerBackground: false, mousePassthrough: false };
        }),

    randomVisualizerModePerSong: false,
    setRandomVisualizerModePerSong: enabled =>
        set(state => {
            if (!enabled) return { randomVisualizerModePerSong: false };
            // Entering the pool draws a style at once, so the shelf and the shelf's first tab agree.
            const current = state.visualizerMode;
            const pool = normalizeRandomModes(state.randomVisualizerModes);
            const next = pool.length > 0 ? pickRandomMode(pool, current) : current;
            return { randomVisualizerModePerSong: true, visualizerMode: next };
        }),
    randomVisualizerModes: DEFAULT_RANDOM_VISUALIZER_MODES,
    setRandomVisualizerModes: modes => set({ randomVisualizerModes: normalizeRandomModes(modes) }),
    rerollVisualizerMode: () =>
        set(state => {
            const pool = normalizeRandomModes(state.randomVisualizerModes);
            const next = pickRandomMode(pool, state.visualizerMode);
            if (next === state.visualizerMode) return {};
            const compat = getStyleTransparencyCompat(next, { isDaylight: state.isDaylightTheme });
            const blocked = compat === 'unsupported' && state.transparentPlayerBackground;
            return blocked
                ? { visualizerMode: next, transparentPlayerBackground: false, mousePassthrough: false }
                : { visualizerMode: next };
        }),

    // Folia's names, forwarded to the implementations above so the reused panels (whose store import
    // is aliased to this one) can drive the pool. Kept as store fields so their identity is stable
    // across renders — `useRandomPool` selects them through `useShallow`.
    handleSetVisualizerMode: (mode, options) =>
        get().setVisualizerMode(mode, { preserveRandom: options?.preserveRandom }),
    handleToggleRandomVisualizerModePerSong: enable => get().setRandomVisualizerModePerSong(enable),
    handleSetRandomVisualizerModes: modes => get().setRandomVisualizerModes(modes),

    previewPlaceholderId: 'current',
    setPreviewPlaceholderId: previewPlaceholderId => set({ previewPlaceholderId }),

    lyricMotion: DEFAULT_LYRIC_MOTION,
    setLyricMotion: lyricMotion => set({ lyricMotion }),
    textureResolution: DEFAULT_TEXTURE_RESOLUTION,
    setTextureResolution: textureResolution => set({ textureResolution }),

    // The reference window (screenshot 1) has 智能动感模式 on, so the injected window starts the same
    // way. Folia's own stored default is `false` (src/types.ts DEFAULT_SMART_BEAT_SETTINGS); this is a
    // deliberate presentation choice, documented in docs/settings-ui-impl.md.
    smartBeat: { enabled: true, effects: {} } as SmartBeatSettings,
    handleSetSmartBeat: patch =>
        set(state => {
            const next: SmartBeatSettings = {
                enabled: patch.enabled ?? state.smartBeat.enabled,
                effects: { ...state.smartBeat.effects },
            };
            if (patch.effects) {
                for (const [id, effectPatch] of Object.entries(patch.effects)) {
                    const current = next.effects[id] ?? { on: true, strength: 1 };
                    next.effects[id] = { on: effectPatch.on ?? current.on, strength: effectPatch.strength ?? current.strength };
                }
            }
            return { smartBeat: next };
        }),

    styleTunings: JSON.parse(JSON.stringify(STYLE_TUNING_DEFAULTS)),
    setStyleTuning: (mode, patch) =>
        set(state => ({
            styleTunings: { ...state.styleTunings, [mode]: { ...state.styleTunings[mode], ...patch } },
        })),
    resetStyleTuning: mode =>
        set(state => ({
            styleTunings: { ...state.styleTunings, [mode]: { ...STYLE_TUNING_DEFAULTS[mode] } },
        })),

    transparentPlayerBackground: false,
    // v0.2.0: never let the colour key be switched on for a style that cannot render it. The panel
    // disables the switch already; this also covers the host hotkey (Ctrl+Alt+B) and the dev console.
    setTransparentPlayerBackground: transparentPlayerBackground =>
        set(state => {
            if (!transparentPlayerBackground) return { transparentPlayerBackground, mousePassthrough: false };
            // v0.3.0: while transparent the effective lightness is the *system* scheme, so the gate
            // must check that value (lumiere + a light system would paint the dark-field plate).
            const blocked = getStyleTransparencyCompat(state.visualizerMode, {
                isDaylight: systemPrefersLight(),
            }) === 'unsupported';
            return blocked
                ? { transparentPlayerBackground: false, mousePassthrough: false }
                : { transparentPlayerBackground };
        }),

    isDaylightTheme: false,
    // v0.2.0: `lumiere` only becomes unsupported once the effective theme turns out to be a light
    // one (cover-derived when opaque, system-derived while transparent since v0.3.0), which the
    // config publisher knows before the store does. Re-check here so neither a light cover nor a
    // light system can leave the window transparent with a 94%-opaque dark field behind it.
    setIsDaylightTheme: isDaylightTheme =>
        set(state => {
            if (!state.transparentPlayerBackground) return { isDaylightTheme };
            if (getStyleTransparencyCompat(state.visualizerMode, { isDaylight: isDaylightTheme }) !== 'unsupported') {
                return { isDaylightTheme };
            }
            return { isDaylightTheme, transparentPlayerBackground: false, mousePassthrough: false };
        }),

    mousePassthrough: false,
    setMousePassthrough: mousePassthrough => set({ mousePassthrough }),

    backgroundMode: 'latent',
    setBackgroundMode: backgroundMode => set({ backgroundMode }),
    backgroundTunings: JSON.parse(JSON.stringify(BACKGROUND_TUNING_DEFAULTS)),
    setBackgroundTuning: (mode, patch) =>
        set(state => ({
            backgroundTunings: { ...state.backgroundTunings, [mode]: { ...state.backgroundTunings[mode], ...patch } },
        })),
    resetBackgroundTuning: mode =>
        set(state => ({
            backgroundTunings: { ...state.backgroundTunings, [mode]: { ...BACKGROUND_TUNING_DEFAULTS[mode] } },
        })),
    commonBackground: { ...DEFAULT_COMMON_BACKGROUND },
    setCommonBackground: patch => set(state => ({ commonBackground: { ...state.commonBackground, ...patch } })),

    appearance: { ...DEFAULT_APPEARANCE },
    setAppearance: patch => set(state => ({ appearance: { ...state.appearance, ...patch } })),
    resetAppearance: () => set({ appearance: { ...DEFAULT_APPEARANCE } }),

    uploadedFonts: [],
    setUploadedFonts: fonts => set({ uploadedFonts: [...fonts] }),
    addUploadedFont: descriptor =>
        set(state => {
            const rest = state.uploadedFonts.filter(font => font.id !== descriptor.id);
            return { uploadedFonts: [...rest, descriptor] };
        }),
    removeUploadedFont: id => set(state => ({ uploadedFonts: state.uploadedFonts.filter(font => font.id !== id) })),

    subtitle: { ...DEFAULT_SUBTITLE_SETTINGS },
    setSubtitle: patch => set(state => ({ subtitle: { ...state.subtitle, ...patch } })),
    resetSubtitle: () => set({ subtitle: { ...DEFAULT_SUBTITLE_SETTINGS } }),
}));

/** The `VisualizerTuningSettings` bag handed to style panels: every tuning under its settings key. */
export const selectTuningSettings = (state: SettingsState): Record<string, unknown> => {
    const bag: Record<string, unknown> = {};
    for (const mode of Object.keys(STYLE_TUNING_KEYS) as StyleMode[]) {
        bag[STYLE_TUNING_KEYS[mode]] = state.styleTunings[mode];
    }
    bag.latentBackgroundTuning = state.backgroundTunings.latent;
    bag.monetBackgroundTuning = state.backgroundTunings.monet;
    bag.nomandBackgroundTuning = state.backgroundTunings.nomand;
    bag.soraBackgroundTuning = state.backgroundTunings.sora;
    bag.smartBeat = state.smartBeat;
    return bag;
};

/** Exactly what the UI persists through the host: Folia storage-key names, JSON-serialisable. */
export interface SettingsSnapshot {
    version: 1;
    styleId: StyleMode;
    /** 0.7.22 随机歌词样式: the pool and whether one style is drawn per song. */
    randomVisualizerModePerSong: boolean;
    randomVisualizerModes: StyleMode[];
    smartBeat: SmartBeatSettings;
    styleTunings: Record<StyleMode, Record<string, unknown>>;
    backgroundMode: BackgroundMode;
    backgroundTunings: Record<'monet' | 'nomand' | 'latent' | 'sora', Record<string, unknown>>;
    commonBackground: CommonBackgroundSettings;
    appearance: AppearanceSettings;
    /** v0.4.0: imported font descriptors (the files live in IndexedDB). */
    uploadedFonts: UploadedFontDescriptor[];
    subtitle: SubtitleSettings;
    previewPlaceholderId: PreviewPlaceholderId;
    lyricMotion: number;
    textureResolution: number;
    transparentPlayerBackground: boolean;
    mousePassthrough: boolean;
}

export const snapshotFromState = (state: SettingsState): SettingsSnapshot => ({
    version: 1,
    styleId: state.visualizerMode,
    randomVisualizerModePerSong: state.randomVisualizerModePerSong,
    randomVisualizerModes: state.randomVisualizerModes,
    smartBeat: state.smartBeat,
    styleTunings: state.styleTunings,
    backgroundMode: state.backgroundMode,
    backgroundTunings: state.backgroundTunings,
    commonBackground: state.commonBackground,
    appearance: state.appearance,
    uploadedFonts: state.uploadedFonts,
    subtitle: state.subtitle,
    previewPlaceholderId: state.previewPlaceholderId,
    lyricMotion: state.lyricMotion,
    textureResolution: state.textureResolution,
    transparentPlayerBackground: state.transparentPlayerBackground,
    mousePassthrough: state.mousePassthrough,
});

/** Hydrates the store from a snapshot the plugin persisted (unknown/missing keys keep defaults). */
export const applySnapshot = (snapshot: Partial<SettingsSnapshot> | null | undefined): void => {
    if (!snapshot || typeof snapshot !== 'object') return;
    const clean = <T>(value: T | undefined, fallback: T): T => (value === undefined || value === null ? fallback : value);
    useSettingsStore.setState(state => {
        const visualizerMode = clean(snapshot.styleId, state.visualizerMode);
        // v0.2.0: a persisted snapshot may pair a style that cannot run transparent with the
        // transparent window on (e.g. the persisted store predates the guard, or the persisted
        // style was changed elsewhere). Never hydrate that combination.
        const transparentBlocked =
            clean(snapshot.transparentPlayerBackground, state.transparentPlayerBackground) &&
            getStyleTransparencyCompat(visualizerMode, { isDaylight: state.isDaylightTheme }) === 'unsupported';
        return {
            visualizerMode,
            randomVisualizerModePerSong: clean(snapshot.randomVisualizerModePerSong, state.randomVisualizerModePerSong),
            randomVisualizerModes: snapshot.randomVisualizerModes === undefined
                ? state.randomVisualizerModes
                : normalizeRandomModes(snapshot.randomVisualizerModes),
            smartBeat: clean(snapshot.smartBeat, state.smartBeat),
            styleTunings: { ...state.styleTunings, ...clean(snapshot.styleTunings, {} as Record<StyleMode, Record<string, unknown>>) },
            backgroundMode: clean(snapshot.backgroundMode, state.backgroundMode),
            backgroundTunings: { ...state.backgroundTunings, ...clean(snapshot.backgroundTunings, {} as Record<'monet' | 'nomand' | 'latent' | 'sora', Record<string, unknown>>) },
            commonBackground: { ...state.commonBackground, ...clean(snapshot.commonBackground, {} as CommonBackgroundSettings) },
            appearance: { ...state.appearance, ...clean(snapshot.appearance, {} as AppearanceSettings) },
            uploadedFonts: Array.isArray(snapshot.uploadedFonts) ? snapshot.uploadedFonts : state.uploadedFonts,
            subtitle: { ...state.subtitle, ...clean(snapshot.subtitle, {} as SubtitleSettings) },
            previewPlaceholderId: clean(snapshot.previewPlaceholderId, state.previewPlaceholderId),
            lyricMotion: clean(snapshot.lyricMotion, state.lyricMotion),
            textureResolution: clean(snapshot.textureResolution, state.textureResolution),
            transparentPlayerBackground: transparentBlocked
                ? false
                : clean(snapshot.transparentPlayerBackground, state.transparentPlayerBackground),
            mousePassthrough: transparentBlocked ? false : clean(snapshot.mousePassthrough, state.mousePassthrough),
        };
    });
};

/** The `VisualizerBackgroundConfig` bag the background tab reads. */
export const selectBackgroundConfig = (state: SettingsState): Record<string, unknown> => ({
    mode: state.backgroundMode,
    common: state.commonBackground,
    monet: { tuning: state.backgroundTunings.monet },
    nomand: { tuning: state.backgroundTunings.nomand },
    latent: { tuning: state.backgroundTunings.latent },
    sora: { tuning: state.backgroundTunings.sora },
    url: { items: [], selectedId: null },
});

/** The `VisualizerBackgroundActions` bag: writes from the reused background cards. */
export const selectBackgroundActions = (state: SettingsState): Record<string, unknown> => ({
    onModeChange: state.setBackgroundMode,
    common: {
        onOpacityChange: (opacity: number) => state.setCommonBackground({ opacity }),
        onCoverColorChange: (useCoverColorBg: boolean) => state.setCommonBackground({ useCoverColorBg }),
        onDisableVignetteChange: (disableVignette: boolean) => state.setCommonBackground({ disableVignette }),
        onDisableGeometricChange: (disableGeometricBackground: boolean) =>
            state.setCommonBackground({ disableGeometricBackground }),
    },
    monet: {
        onTuningChange: (patch: Record<string, unknown>) => state.setBackgroundTuning('monet', patch),
        onResetTuning: () => state.resetBackgroundTuning('monet'),
    },
    nomand: {
        onTuningChange: (patch: Record<string, unknown>) => state.setBackgroundTuning('nomand', patch),
        onResetTuning: () => state.resetBackgroundTuning('nomand'),
    },
    latent: {
        onTuningChange: (patch: Record<string, unknown>) => state.setBackgroundTuning('latent', patch),
        onResetTuning: () => state.resetBackgroundTuning('latent'),
    },
    sora: {
        onTuningChange: (patch: Record<string, unknown>) => state.setBackgroundTuning('sora', patch),
        onResetTuning: () => state.resetBackgroundTuning('sora'),
    },
});
