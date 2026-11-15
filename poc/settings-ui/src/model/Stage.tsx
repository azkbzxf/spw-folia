/* The window's left stage: the live sample of the chosen style and the 17-picture style shelf plus
 * the 随机 tile, laid out exactly like VisPlayground.tsx:425-530. StudioWindow already wraps this in
 * the stage <section>, so this component renders the two children only.
 *
 * 0.7.22 随机歌词样式: the last tile is Folia's `__random__` picker choice, never a renderer id.
 * v0.4.12 实时货架: the tiles are no longer `thumbs/<mode>.jpg` stills — each one is Folia's own
 * `LyricStylePicture`, i.e. the real renderer with upstream's image/hover-turn machine
 * (model/ShelfLive.tsx). The random tile stays a Shuffle glyph, drawn by the same function.
 *
 * v0.4.1 真实预览: the sample is no longer a simulation. The stage renders the *exact* config the
 * player page received (`usePlayerConfig`): the song that is playing, its
 * lyrics, the user's theme/background choices and — when enabled — the transparent-playback flag.
 * The same-origin `preview.html` iframe runs Folia's real renderer against that config and the
 * parent forwards the host's real clock/audio events into it (docs/live-preview-iframe.md), so the
 * window shows what the player window shows, including the transparent background (drawn as the
 * standard checkerboard here). If the iframe never reports ready (older bundle without preview.html,
 * missing child shim) Stage falls back to the captured-frame sample (StylePreview, Ken Burns) — the
 * pause button drives whichever sample is showing. */
import React, { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { STYLE_COUNT, STYLE_ENTRIES, type StyleEntry } from './styles';
import StylePreview from './StylePreview';
import LivePreview from './LivePreview';
import { effectiveVisualizerMode, useSettingsStore, type StyleMode } from './settings';
import { isModStyleMode, type ModStyleEntry, type ModStyleMode } from './modStyles';
import { useInjectedMods, useModStyles } from './useInjectedMods';
import { usePlayerConfig } from '~/useConfigPublisher';
import { LyricStyleShelf, RANDOM_VISUALIZER_CHOICE, useShelfProbe, type ShelfValue } from './ShelfLive';

interface StageProps {
    t: (key: string) => string;
    visualizerMode: StyleMode;
    onVisualizerModeChange: (mode: StyleMode) => void;
    /** 0.7.22 随机池: whether the shelf should show the 随机 tile as chosen. */
    randomEnabled: boolean;
    onRandomChange: (enabled: boolean) => void;
    /** Whether the settings window is on screen: the injected overlay is hidden, not unmounted, and
     *  the shelf's preview clock must not keep a frame loop alive behind `display:none`. */
    active: boolean;
}

/* The tiles themselves live in `./ShelfLive` (Folia's LyricStylePicture + its image/hover machine);
 * this component only places the grid under the big sample, as VisPlayground does. */

/** issue #23: 模组样式的 preview 图（给 `StylePreview` 的兜底路径用）；找不到就是 null。 */
const resolveModPreview = (mode: string, entries: readonly ModStyleEntry[]): string | null =>
    entries.find(entry => entry.mode === mode)?.previewUrl ?? null;

const Stage: React.FC<StageProps> = ({ t, visualizerMode, onVisualizerModeChange, randomEnabled, onRandomChange, active }) => {
    const [paused, setPaused] = useState(false);
    const [liveFailed, setLiveFailed] = useState(false);
    const settingsState = useSettingsStore();
    /* issue #23: 模组样式走「第二套并行清单」——一份只在运行期存在、绝不进 STYLE_ENTRIES 的清单。
     * `useInjectedMods()` 是已装清单（插件拥有的注入成员），`useModStyles()` 把它与「模组注册了哪些
     * visualizer」合成货架格。模组没装/没启用时这里是空数组，货架与计数完全与改动前一致。 */
    const injectedMods = useInjectedMods();
    const modEntries = useModStyles(injectedMods);
    const modStyleMode = settingsState.modVisualizerMode;
    /* 舞台大图与货架「选中格」都要用**真正在画的那个 mode**：选了模组样式时它必须是 `mod:`，
     * 否则大图会一直停在回落的内置样式上（看起来像「点了没反应」）。 */
    const effectiveMode = effectiveVisualizerMode(settingsState);
    // The player's current config, verbatim: no placeholder song, no guessed theme, no preset
    // background. `null` only until the player page has received its first config.
    const config = usePlayerConfig();
    const transparent = config?.background?.transparent === true;
    // The host probe reads the shelf through `window.__SPW_SHELF_STATE__` (see ShelfLive.tsx).
    useShelfProbe();

    return (
        <>
            {/* Big sample: Folia's real renderer in a scaled 1920x1080 iframe, showing the real song. */}
            <div
                className={`relative min-h-[160px] flex-1 overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--st-line)]${transparent ? ' st-stage-transparent' : ''}`}
            >
                {config != null && (liveFailed
                    ? <StylePreview mode={visualizerMode} paused={paused} thumbUrl={modStyleMode ? resolveModPreview(modStyleMode, modEntries) : null} />
                    : (
                        <LivePreview
                            paused={paused}
                            config={config}
                            uploadedFonts={settingsState.uploadedFonts}
                            onError={() => setLiveFailed(true)}
                        />
                    ))}
                {transparent && (
                    <span className="absolute bottom-3 left-3 z-40 rounded-full bg-black/45 px-2.5 py-1 text-[11px] leading-none text-white/90">
                        {t('options.transparentPlayerBackground')}
                    </span>
                )}
                <button
                    type="button"
                    aria-label={t(paused ? 'options.resumePreview' : 'options.pausePreview')}
                    title={t(paused ? 'options.resumePreview' : 'options.pausePreview')}
                    onClick={() => setPaused(previous => !previous)}
                    className="st-t-fast absolute right-3 top-3 z-40 grid h-8 w-8 place-items-center rounded-full bg-black/45 text-white hover:bg-black/65"
                >
                    {paused
                        ? <Play size={14} fill="currentColor" aria-hidden="true" />
                        : <Pause size={14} fill="currentColor" aria-hidden="true" />}
                </button>
            </div>

            {/* Style shelf: Folia's own 7-column grid of live pictures (4 where the window is one
                column), the count beside the heading. Choosing 随机 turns the pool on; choosing a
                style by hand turns it off again through the store's `setVisualizerMode`. */}
            <div className="flex shrink-0 flex-col">
                <h3 className="mb-2 flex min-h-6 items-center px-1 text-[13px] font-semibold leading-5 text-[color:var(--st-t2)]">
                    {t('options.lyricStyles')}
                    {/* 计数把模组格算进去：`STYLE_COUNT` 只数内置样式，模组格是本页新增的第二组。 */}
                    <span className="ml-1.5 font-normal text-[color:var(--st-t3)]" data-spw-style-count={STYLE_COUNT + modEntries.length}>
                        {STYLE_COUNT + modEntries.length}
                    </span>
                </h3>
                <LyricStyleShelf
                    mode={visualizerMode}
                    value={randomEnabled ? RANDOM_VISUALIZER_CHOICE : effectiveMode}
                    options={[
                        ...STYLE_ENTRIES.map((entry: StyleEntry) => ({
                            value: entry.mode as ShelfValue,
                            label: t(entry.labelKey) || entry.labelFallback,
                        })),
                        /* issue #23: 模组格是**第二组**，拼在内置样式之后、随机格之前。上游
                         * `PictureGrid` 只吃 `{value,label}[]`，所以这一步是安全的；而这批值
                         * **没有**进 `STYLE_ENTRIES` / `STYLE_MODE_SHELF_ORDER` / `STYLE_MODES`
                         * （那三处各有一条会炸的断言，见 modStyles.ts 文件头）。 */
                        ...modEntries.map((entry: ModStyleEntry) => ({
                            value: entry.mode as ShelfValue,
                            label: entry.label,
                        })),
                        { value: RANDOM_VISUALIZER_CHOICE as ShelfValue, label: t('ui.visualizerRandom') },
                    ]}
                    onChange={value => {
                        if (value === RANDOM_VISUALIZER_CHOICE) {
                            onRandomChange(true);
                            return;
                        }
                        if (isModStyleMode(value)) {
                            /* 模组样式：写进 store 的 `modVisualizerMode`，内置样式那份值原样保留
                             * （它是模组消失后的回落目标）。 */
                            settingsState.setModVisualizerMode(value as ModStyleMode);
                            return;
                        }
                        /* 手点一个内置样式 = 「就放这个」：模组选择必须一起清掉，否则大图还停在模组上，
                         * 用户会以为点击无效。 */
                        if (modStyleMode) settingsState.clearModVisualizerMode();
                        onVisualizerModeChange(value);
                    }}
                    label={t('ui.animationMode')}
                    paused={paused}
                    active={active}
                    modEntries={modEntries}
                />
            </div>
        </>
    );
};

export default Stage;
