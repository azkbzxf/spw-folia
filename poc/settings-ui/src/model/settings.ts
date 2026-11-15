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
    type LyricRenderQuality,
    type SmartBeatSettings,
    type SubtitleOverlayLayout,
} from '@/types';
/* 0.7.25: the bottom subtitle's row layout. The default and the validator both live upstream
 * (`parseSubtitleOverlayLayout` is what a stored or imported value must go through), so the literal
 * 'translation' is never retyped here. */
import {
    DEFAULT_SUBTITLE_OVERLAY_LAYOUT,
    getSubtitleOverlayRows,
    parseSubtitleOverlayLayout,
    subtitleOverlayLayoutFromContentMode,
} from '@/utils/lyrics/subtitleOverlayLayout';
/* #929: the global lyric-canvas render tier lives in Folia's own settings store, whose own control
 * sits on 动画与性能 — a page this window does not inject (issue #22 item 1). The value is therefore
 * owned here, handed to the reused panels through the store stub, published materialised into each
 * style's tuning (`publisher/config.ts`) and mirrored into Folia's localStorage key. */
import { DEFAULT_LYRIC_RENDER_QUALITY, normalizeLyricRenderQuality } from '@/utils/lyricRenderQuality';
import { getStyleTransparencyCompat } from './transparencyCompat';
import { mergeTuningMap } from './mergeTuning';
import { systemPrefersLight } from './theme';
/* issue #23: 模组样式是**并列**类型，不进 `StyleMode`（见 modStyles.ts 文件头四处断言）。 */
import type { ModStyleMode } from './modStyles';
/* 0.7.22 花火's tuning defaults live with the style's own module, not in `src/types.ts` (unlike the
 * 14 older styles), so they are imported from there.
 * 0.7.25 町景 / 雾笺 follow the same convention: both keep their defaults next to the style. */
import { DEFAULT_HANABI_TUNING } from '@/components/visualizer/hanabi/types';
import { DEFAULT_MACHI_TUNING } from '@/components/visualizer/machi/types';
/* 0.7.26 町景: `quality` gained `revision` + the 跟随全局 preset values, and the migration lives in the
 * style's own `normalizeMachiQuality` — imported rather than reimplemented (see normalizeStyleTunings). */
import { normalizeMachiTuning } from '@/components/visualizer/machi/machiTuning';
import { DEFAULT_NEBBIA_TUNING } from '@/components/visualizer/nebbia/types';

export type StyleMode =
    | 'sonnet'
    | 'tempera'
    | 'lumiere'
    /** 0.7.22 花火: order 26, between 绘光 (25) and 古典 (30) on Folia's own shelf. */
    | 'hanabi'
    /** 0.7.25 町景: order 27, three.js miniature town dioramas; signs carry the lyrics. */
    | 'machi'
    /** 0.7.25 雾笺: order 29, writing the lyrics on a fogged-up bus window. */
    | 'nebbia'
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

/**
 * issue #22 item 2 — 歌词/字幕的文字颜色。
 *
 * 只影响**文字**（`Theme.primaryColor` / `accentColor` / `secondaryColor`），不影响背景与强调色之外的
 * 任何东西：`Theme.backgroundColor` 由封面色决定，改了会把画面本身的底色也翻过去。
 *
 * 三个取值的语义（不要按名字猜，按这一句读）：
 *  - `'light'` = **浅色文字**，适合深色画面（映射到 `themeFromSample` 的 `isLightOverride = false`，
 *    即深色主题）；
 *  - `'dark'`  = **深色文字**，适合浅色画面（`isLightOverride = true`，浅色主题）；
 *  - `'system'`= 维持引入这个设置之前的行为：不透明时由封面亮度决定，透明窗口时跟随系统配色方案。
 *
 * 默认 `'system'`，所以升级用户看到的样子不变。
 */
export type FontColorMode = 'light' | 'dark' | 'system';

export const FONT_COLOR_MODES = ['light', 'dark', 'system'] as const satisfies readonly FontColorMode[];

/** 存着/导入的取值读成合法值；认不得的一律回 `'system'`（保持现状，不改观感）。 */
export const normalizeFontColorMode = (value: unknown): FontColorMode =>
    (FONT_COLOR_MODES as readonly unknown[]).includes(value) ? value as FontColorMode : 'system';

/** Each style's tuning defaults, imported from Folia so its own panel shows Folia's values. */
export const STYLE_TUNING_DEFAULTS: Record<StyleMode, Record<string, unknown>> = {
    sonnet: { ...DEFAULT_SONNET_TUNING },
    tempera: { ...DEFAULT_TEMPERA_TUNING },
    lumiere: { ...DEFAULT_LUMIERE_TUNING },
    hanabi: { ...DEFAULT_HANABI_TUNING },
    machi: { ...DEFAULT_MACHI_TUNING },
    nebbia: { ...DEFAULT_NEBBIA_TUNING },
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
    machi: 'machiTuning',
    nebbia: 'nebbiaTuning',
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
    'sonnet', 'tempera', 'lumiere', 'hanabi', 'machi', 'nebbia', 'classic', 'cadenza', 'partita',
    'fume', 'tilt', 'claddagh', 'monet', 'pendolo', 'cappella', 'diorama', 'still',
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
    /** 0.7.25 副字幕行数/内容: the bottom subtitle's row layout ("current", "current+translation",
     *  "current+next+romanization", …). Upstream's own type; `parseSubtitleOverlayLayout` there is what
     *  validates a stored/id-synced value, and `DEFAULT_SUBTITLE_OVERLAY_LAYOUT` ('translation') is the
     *  default this store seeds — the literal is not retyped here on purpose. */
    subtitleOverlayLayout: SubtitleOverlayLayout;
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
    subtitleOverlayLayout: DEFAULT_SUBTITLE_OVERLAY_LAYOUT,
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

/** 「显示播放条」的默认值：与引入开关之前的版本行为一致（见 `useInjectedSwitch.ts` 的同名常量，
 *  两处必须一致 —— 那边是插件注入契约的镜像，这边是页面自己的持久化默认值）。
 *  v0.4.17 (issue #18 item 2): 所有权移到页面侧，所以这个值现在是**页面 store 的默认值**，
 *  不再是只读的注入成员。 */
export const DEFAULT_SHOW_PLAYBACK_BAR = true;

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

    /* issue #23 · 模组样式（`mod:<modId>:<vizId>`）的当前选择。
     *
     * 为什么单独一个字段而不是把 `mod:` 放进 `visualizerMode: StyleMode`：`StyleMode` 是上游闭集，
     * 并进 `mod:` 会让 `scripts/check-style-sync.mjs:479-483` 报「StyleMode 联合多成员」，而它已挂进
     * `vite build`。所以「当前画哪一样式」在这里是**两段**：
     *   - `visualizerMode`：内置样式（永远有一个合法值，卸载/禁用模组时回落到它）；
     *   - `modVisualizerMode`：模组样式，`null` 表示当前没选模组。
     * 真正发出去的 mode 由 `effectiveVisualizerMode()` 合成（模组在就取它，否则取内置）。
     *
     * 不持久化进 `SettingsSnapshot`：模组清单由插件拥有，页面若把它写进设置树，卸载模组后就会
     * 复活一个不存在的 mode（双写方，`docs/lessons.md:154-157`）。 */
    modVisualizerMode: ModStyleMode | null;
    /** 选一个模组样式（货架点了模组格时调用）。 */
    setModVisualizerMode: (mode: ModStyleMode) => void;
    /** 清掉模组选择（模组被卸载/禁用、或用户点了内置样式时）。 */
    clearModVisualizerMode: () => void;

    /** Folia's storage keys mirrored for round-trip fidelity (no control in this window yet). */
    lyricMotion: number;
    setLyricMotion: (value: number) => void;
    textureResolution: number;
    setTextureResolution: (value: number) => void;

    /** #929 / issue #22 item 1: the GLOBAL lyric-canvas render tier (分辨率 / 抗锯齿), read by the
     *  reused panels' `LyricRenderQualityRows` through `stubs/useVisualizerSettingsStore` — that stub
     *  aliases Folia's store to this one, and the rows call `formatLyricRenderScale(global.scale)`,
     *  which throws on `undefined`. Upstream keeps the tier in 「动画与性能」(GraphicsPage); this
     *  window does not inject that page, so `chrome/SpwRenderQualityGroup` is the control and this
     *  store owns the value.
     *
     *  Two consumers, and they need different things (see `publisher/config.ts`):
     *   - the published config: each style's `render.scale === 'global'` is materialised into this
     *     value, because the player page never reads the global tier from the config — it reads its
     *     own localStorage key;
     *   - Folia's own storage: `model/lyricRenderQualityStorage.ts` mirrors this value into
     *     `LYRIC_RENDER_QUALITY_STORAGE_KEY`, so a window opened later starts on the same tier. */
    lyricRenderQuality: LyricRenderQuality;
    handleSetLyricRenderQuality: (patch: Partial<LyricRenderQuality>) => void;

    /** issue #22 item 2: 歌词/字幕的文字颜色（不透明窗口时用的那一份）。 */
    fontColorMode: FontColorMode;
    setFontColorMode: (mode: FontColorMode) => void;
    /** issue #22 item 2: 透明窗口下的文字颜色。需求原文要求它单独一份，因为透明时没有封面底色，
     *  原来的策略（跟随系统配色）与不透明时（跟随封面）本来就不是一回事。 */
    transparentFontColorMode: FontColorMode;
    setTransparentFontColorMode: (mode: FontColorMode) => void;

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

    /** v0.4.16: effective theme lightness, mirrored from `useConfigPublisher` so the transparent
     *  window guard can tell whether lumiere's light-theme dark field floor applies. v0.3.0: the
     *  cover decides while the window is opaque, the system colour scheme while it is transparent.
     *  Not persisted. */
    isDaylightTheme: boolean;
    setIsDaylightTheme: (value: boolean) => void;

    /** v0.4.17 (issue #18 item 2): 「显示播放条」now belongs to this page's own settings tree instead
     *  of the plugin's 配置 page (see the contract in `.scratch/issue18-contract.md`). The player page
     *  reads it to decide whether `PlaybackBar` mounts at all (v0.4.10 behaviour: off means the bar and
     *  its hot zone are both gone). Persisted through the tree like every other page-owned setting;
     *  `applySnapshot` seeds it once from the plugin's legacy injected member so the value an existing
     *  user had in `config.json` survives the move. */
    showPlaybackBar: boolean;
    setShowPlaybackBar: (value: boolean) => void;

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

    /* issue #23: 模组样式的选择。两个 setter 都**不**写 `visualizerMode`：内置样式那份值必须一直
     * 保持合法（模组卸载后它就是回落目标），所以两者互不改写。 */
    modVisualizerMode: null,
    setModVisualizerMode: mode => set({ modVisualizerMode: mode, randomVisualizerModePerSong: false }),
    clearModVisualizerMode: () => set({ modVisualizerMode: null }),

    lyricMotion: DEFAULT_LYRIC_MOTION,
    setLyricMotion: lyricMotion => set({ lyricMotion }),
    textureResolution: DEFAULT_TEXTURE_RESOLUTION,
    setTextureResolution: textureResolution => set({ textureResolution }),

    // #929: same shape/default as Folia's `useVisualizerSettingsStore.lyricRenderQuality`
    // (DEFAULT_LYRIC_RENDER_QUALITY = { scale: 1, antialias: 'auto' } — 「各样式原来的样子」, so an
    // upgrading user's look does not change). The setter is named after Folia's
    // (`handleSetLyricRenderQuality`) and normalises exactly like it does.
    lyricRenderQuality: { ...DEFAULT_LYRIC_RENDER_QUALITY },
    handleSetLyricRenderQuality: patch =>
        set(state => {
            const next = normalizeLyricRenderQuality({ ...state.lyricRenderQuality, ...patch });
            const current = state.lyricRenderQuality;
            if (next.scale === current.scale && next.antialias === current.antialias) return {};
            return { lyricRenderQuality: next };
        }),

    // issue #22 item 2: `'system'` is the pre-existing behaviour in both windows (opaque = cover,
    // transparent = system scheme), so both default to it and an upgrading user sees no change.
    fontColorMode: 'system',
    setFontColorMode: fontColorMode => set({ fontColorMode: normalizeFontColorMode(fontColorMode) }),
    transparentFontColorMode: 'system',
    setTransparentFontColorMode: transparentFontColorMode =>
        set({ transparentFontColorMode: normalizeFontColorMode(transparentFontColorMode) }),

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

    // v0.4.17 (issue #18 item 2): page-owned 「显示播放条」. `applySnapshot` replaces this value from
    // the persisted tree (or seeds it from the plugin's legacy injected member exactly once).
    showPlaybackBar: DEFAULT_SHOW_PLAYBACK_BAR,
    setShowPlaybackBar: showPlaybackBar => set({ showPlaybackBar }),

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
    // 0.7.25 副字幕行数/内容: `setSubtitle` is the ONE way a layout enters the store, so the dead-row
    // sanitation lives here as well as in `applySnapshot`. It has to: upstream's rows setting turns
    // 单行 `'translation'` into `'current+translation+romanization'` when the user picks 三行
    // (`withSubtitleOverlayRowCount` fills the third row with romanization by itself), so without this
    // the 三行 button would do nothing at all in this window.
    setSubtitle: patch => set(state => ({
        subtitle: {
            ...state.subtitle,
            ...patch,
            ...(patch.subtitleOverlayLayout === undefined
                ? {}
                : { subtitleOverlayLayout: sanitizeSubtitleOverlayLayout(patch.subtitleOverlayLayout) }),
        },
    })),
    resetSubtitle: () => set({ subtitle: { ...DEFAULT_SUBTITLE_SETTINGS } }),
}));

/**
 * 0.7.26: style-specific normalisation applied AFTER the defaults-first merge.
 *
 * Only 町景 needs it, and it is not optional: its `quality` is a nested object (every other tuning value
 * is a flat scalar or an array), so `mergeTuning`'s shallow rule keeps the stored `quality` whole — a
 * tree persisted before 0.7.26 keeps `renderScale: 1` / `antialias: 'smaa'` and no `revision`, which
 * upstream only migrates inside `normalizeMachiTuning` (legacy 100%/SMAA → 跟随全局). The panel and the
 * renderer both read that bag, and the machi panel computes the 「跟随全局」 preset from it, so the bag
 * this page publishes must already be normalised or the preset row shows 「自定义」 forever for existing
 * users.
 *
 * Every other style keeps the raw merged bag: running their `resolve()` here would be a second source
 * of truth for clamping, and `mergeTuning` is deliberately the only persistence-layer transform
 * (docs/settings-ui-impl.md §4.2).
 */
export const normalizeStyleTunings = (
    merged: Record<StyleMode, Record<string, unknown>>,
): Record<StyleMode, Record<string, unknown>> => ({
    ...merged,
    machi: normalizeMachiTuning(merged.machi) as unknown as Record<string, unknown>,
});

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
    lyricMotion: number;
    textureResolution: number;
    /** #929 / issue #22 item 1: 歌词画布的全局分辨率与抗锯齿挡位. Absent from every tree persisted by an
     *  older build — `applySnapshot` falls back to the upstream default (1× / 自动), which is exactly
     *  what those builds rendered with, so the upgrade is invisible. */
    lyricRenderQuality: LyricRenderQuality;
    /** issue #22 item 2: 歌词/字幕的文字颜色。Both default to `'system'` (= 引入前的行为). */
    fontColorMode: FontColorMode;
    transparentFontColorMode: FontColorMode;
    transparentPlayerBackground: boolean;
    mousePassthrough: boolean;
    /** v0.4.17 (issue #18 item 2): 「显示播放条」, page-owned since the 配置 page switch was retired.
     *  Absent from every tree persisted by an older build — `applySnapshot` seeds it from the
     *  plugin's legacy injected member `showPlaybackBarLegacy` in exactly that case. */
    showPlaybackBar: boolean;
}

/**
 * issue #23: 真正要发出去（`config.visualizerMode`）与要画出来（舞台/预览）的那一个 mode。
 *
 * 规则只有一条：**选了模组样式就用它，否则用内置样式**。模组样式是开放 string，上游
 * `VisualizerMode` 本来就是 `BuiltinVisualizerMode | (string & {})`
 * （`work/folia/folia-major-main/src/types.ts:141-142`），publisher 不需要任何改动。
 *
 * 为什么要有这个函数：内置样式那一份 `visualizerMode` 必须**永远是合法值**（它是模组样式消失后的
 * 回落目标），所以两份值分开存、在这里合成，绝不互相覆盖。
 */
export const effectiveVisualizerMode = (state: Pick<SettingsState, 'visualizerMode' | 'modVisualizerMode'>): StyleMode | ModStyleMode =>
    state.modVisualizerMode ?? state.visualizerMode;

export const snapshotFromState = (state: SettingsState): SettingsSnapshot => ({    version: 1,
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
    lyricMotion: state.lyricMotion,
    textureResolution: state.textureResolution,
    lyricRenderQuality: state.lyricRenderQuality,
    fontColorMode: state.fontColorMode,
    transparentFontColorMode: state.transparentFontColorMode,
    transparentPlayerBackground: state.transparentPlayerBackground,
    mousePassthrough: state.mousePassthrough,
    showPlaybackBar: state.showPlaybackBar,
});

/**
 * v0.4.17 (issue #18 item 2): the plugin used to own 「显示播放条」 and inject it as a top-level
 * boolean in the settings tree. Ownership moved to this page, so the plugin now ships the old
 * `config.json` value under a different name — `showPlaybackBarLegacy` — and it is only ever read to
 * SEED a tree that has no `showPlaybackBar` of its own (a user upgrading from a build where the
 * switch lived in the 配置 page). Once the tree carries the key, the tree wins forever: that is what
 * "the page owns it" means, and it is also what stops an old plugin from resurrecting a value the
 * user has since changed here.
 *
 * Strict boolean, like `useInjectedSwitch.extractInjectedSwitch`: only `true` / `false` count, so a
 * missing or stringly-typed member falls back to [DEFAULT_SHOW_PLAYBACK_BAR] rather than flipping.
 */
export const LEGACY_SHOW_PLAYBACK_BAR_KEY = 'showPlaybackBarLegacy';

/** Reads the plugin's legacy injected member; `null` when the payload does not carry it. */
export const readLegacyShowPlaybackBar = (snapshot: unknown): boolean | null => {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const value = (snapshot as Record<string, unknown>)[LEGACY_SHOW_PLAYBACK_BAR_KEY];
    return value === true ? true : value === false ? false : null;
};

/**
 * The value 「显示播放条」should take when hydrating from [snapshot]:
 * a `showPlaybackBar` key in the tree always wins; otherwise the legacy injected member seeds it;
 * otherwise the default. Exported so the gate script can drive the migration rule directly.
 */
export const resolveShowPlaybackBar = (snapshot: Partial<SettingsSnapshot> | null | undefined): boolean => {
    if (!snapshot || typeof snapshot !== 'object') return DEFAULT_SHOW_PLAYBACK_BAR;
    const stored = (snapshot as Record<string, unknown>).showPlaybackBar;
    if (typeof stored === 'boolean') return stored;
    return readLegacyShowPlaybackBar(snapshot) ?? DEFAULT_SHOW_PLAYBACK_BAR;
};

/**
 * 0.7.25 副字幕行数/内容 — the rows this page can actually fill.
 *
 * The plugin sends each line's `main` text and its `sub` translation and **nothing else**: there is no
 * romanization in the payload at all (Kotlin's `FoliaPlaybackExtension` writes `"main"` / `"sub"` only),
 * which is also why 副字幕内容 has been pinned to 翻译 since v0.1.3. In the player overlay a
 * `romanization` row resolves to `resolveLyricAlternateText(line, 'romanization')` → `null` and is
 * dropped, so the user would set a row and never see anything in it — a dead control, which this
 * project does not ship (docs/known-inert-settings.md: 「无法生效的控件不再展示」).
 *
 * Two things are therefore done, and they have to be done together:
 *  1. `vite.config.ts` strips the 罗马音 choices out of the rows setting (marker-checked SETTINGS_SURGERY),
 *     so the pickers cannot offer a row that can never fill.
 *  2. This function rewrites a layout that still names such a row into the closest working one, because
 *     upstream's own `withSubtitleOverlayRowCount` **adds** `romanization` by itself when going from one
 *     row to three (`'translation'` → `'current+translation+romanization'`) and a stored tree may
 *     predate this build. Without (2) the 三行 button would look dead (the store would snap back to two
 *     rows) and row 3 would show an option the picker no longer lists.
 *
 * Mapping: a follow-row `romanization` becomes `next` — a row that does work, and the third row of
 * `current+translation+next` is exactly what a two-row layout is meant to grow into (two `next` rows
 * are legal and show the next two lines, per `resolveVisualizerSubtitleOverlayContent`). A single-row
 * `romanization` becomes `translation`. Duplicate non-`next` rows left over by the substitution are
 * dropped. The row count is preserved wherever the result is still a valid layout.
 *
 * Exported so a gate script can drive this rule directly.
 */
export const sanitizeSubtitleOverlayLayout = (layout: SubtitleOverlayLayout): SubtitleOverlayLayout => {
    const rows = getSubtitleOverlayRows(layout);
    if (!rows.includes('romanization')) return layout;
    const mapped = rows.map(row => (row === 'romanization' ? (rows.length === 1 ? 'translation' : 'next') : row));
    const deduped = mapped.filter((row, index) => row === 'next' || mapped.indexOf(row) === index);
    if (deduped.length === 0) return DEFAULT_SUBTITLE_OVERLAY_LAYOUT;
    return parseSubtitleOverlayLayout(deduped.join('+')) ?? DEFAULT_SUBTITLE_OVERLAY_LAYOUT;
};

/**
 * The 副字幕行数/内容 layout a tree should hydrate to.
 *
 * A tree this build persisted carries `subtitle.subtitleOverlayLayout` — `parseSubtitleOverlayLayout`
 * (upstream's own validator) decides whether it is one, and anything else is ignored rather than
 * trusted. A tree persisted before the field existed (v0.4.18 and older) has only
 * `subtitle.subtitleContentMode`; for a legacy `none` (whose overlay previewed the coming lyrics) the
 * first read derives `current+next`, matching what Folia's own `readStoredSubtitleOverlayLayout`
 * migrates a content mode into. Every other legacy mode keeps the default: `romanization` / `both` are
 * normalised to 翻译 by App.tsx at load anyway, and deriving rows from them would resurrect exactly the
 * dead romanization rows [sanitizeSubtitleOverlayLayout] removes.
 * Exported so a gate script can drive the migration rule directly.
 */
export const resolveSubtitleOverlayLayout = (
    snapshot: Partial<SettingsSnapshot> | null | undefined,
    fallback: SubtitleOverlayLayout = DEFAULT_SUBTITLE_OVERLAY_LAYOUT,
): SubtitleOverlayLayout => {
    if (!snapshot || typeof snapshot !== 'object') return fallback;
    const subtitle = (snapshot as { subtitle?: unknown }).subtitle;
    if (!subtitle || typeof subtitle !== 'object') return fallback;
    const stored = parseSubtitleOverlayLayout((subtitle as Record<string, unknown>).subtitleOverlayLayout);
    if (stored) return sanitizeSubtitleOverlayLayout(stored);
    const contentMode = (subtitle as Record<string, unknown>).subtitleContentMode;
    if (contentMode === 'none') return subtitleOverlayLayoutFromContentMode('none');
    return fallback;
};

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
            // v0.4.17 (issue #18 item 1): DEFAULTS FIRST, persisted values on top — never a whole-object
            // replacement. Folia's `defineVisualizerTuning.apply` does not run the style's own
            // `resolve()`, so a tuning key missing from the bag we publish reaches the renderer as
            // `undefined` and turns its maths into NaN (凝彩 lost its whole composition that way when
            // 0.7.25 added `depthOfField` / `depthPan` / `glyphDepth` and every older tree lacked them).
            // Merging per style also keeps the stored `layerImages` array intact, because mergeTuning
            // replaces a whole array instead of spreading it.
            //
            // 0.7.26 machi: `quality` is the ONE nested object in a tuning bag (`{renderScale,
            // antialias, shadows, reflections, glow, adaptive, revision}`), and the shallow merge keeps
            // whatever the tree stored — so a v0.4.18 tree (whose `quality` has no `revision` and still
            // says `renderScale: 1` / `antialias: 'smaa'`, the pre-跟随全局 defaults) would otherwise
            // reach the renderer un-migrated. Upstream's own `normalizeMachiTuning` is the authority for
            // that shape: it fills `revision`, reads the legacy 100%/SMAA pair as 跟随全局 and clamps
            // every field, so run it over the merged bag. It is pure (types + range helpers only), which
            // is why the store can import it; the renderer then receives the same bag Folia would build.
            styleTunings: normalizeStyleTunings(mergeTuningMap(STYLE_TUNING_DEFAULTS, snapshot.styleTunings, state.styleTunings)),
            backgroundMode: clean(snapshot.backgroundMode, state.backgroundMode),
            // The same rule for the background tunings; upstream owns their defaults too.
            backgroundTunings: mergeTuningMap(BACKGROUND_TUNING_DEFAULTS, snapshot.backgroundTunings, state.backgroundTunings),
            commonBackground: { ...state.commonBackground, ...clean(snapshot.commonBackground, {} as CommonBackgroundSettings) },
            appearance: { ...state.appearance, ...clean(snapshot.appearance, {} as AppearanceSettings) },
            uploadedFonts: Array.isArray(snapshot.uploadedFonts) ? snapshot.uploadedFonts : state.uploadedFonts,
            // 0.7.25 副字幕行数/内容: spread the stored subtitle first, then pin the layout through
            // `resolveSubtitleOverlayLayout` — an unparseable stored value (or one from a build that
            // never had the field) must not reach the panel, whose `getSubtitleOverlayRows(layout)`
            // splits on '+' with no default and would throw.
            subtitle: {
                ...state.subtitle,
                ...clean(snapshot.subtitle, {} as SubtitleSettings),
                subtitleOverlayLayout: resolveSubtitleOverlayLayout(snapshot, state.subtitle.subtitleOverlayLayout),
            },
            lyricMotion: clean(snapshot.lyricMotion, state.lyricMotion),
            textureResolution: clean(snapshot.textureResolution, state.textureResolution),
            // #929 / issue #22 item 1: `normalizeLyricRenderQuality` is upstream's own validator, so a
            // tree carrying `{scale: 3}` or `{antialias: 'yes'}` (hand-edited, or written by a build
            // whose option list was longer) hydrates to the default pair instead of reaching the
            // renderer as an unknown pixel density.
            lyricRenderQuality: normalizeLyricRenderQuality(clean(snapshot.lyricRenderQuality, state.lyricRenderQuality)),
            // issue #22 item 2: same rule for the two colour modes; an unknown string means "keep the
            // pre-existing behaviour" rather than a broken theme.
            fontColorMode: normalizeFontColorMode(clean(snapshot.fontColorMode, state.fontColorMode)),
            transparentFontColorMode: normalizeFontColorMode(
                clean(snapshot.transparentFontColorMode, state.transparentFontColorMode),
            ),
            transparentPlayerBackground: transparentBlocked
                ? false
                : clean(snapshot.transparentPlayerBackground, state.transparentPlayerBackground),
            mousePassthrough: transparentBlocked ? false : clean(snapshot.mousePassthrough, state.mousePassthrough),
            showPlaybackBar: resolveShowPlaybackBar(snapshot),
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
