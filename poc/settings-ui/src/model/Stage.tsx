/* The window's left stage: the live sample of the chosen style and the 15-picture style shelf plus
 * the 随机 tile, laid out exactly like VisPlayground.tsx:425-530. StudioWindow already wraps this in
 * the stage <section>, so this component renders the two children only.
 *
 * 0.7.22 随机歌词样式: the last tile is Folia's `__random__` picker choice, never a renderer id. It is
 * drawn here (a Shuffle glyph) instead of through upstream's `drawLyricStyleChoice`, because that
 * helper pulls `LyricStylePicture` — and with it the whole renderer graph — into this bundle.
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
import { Pause, Play, Shuffle } from 'lucide-react';
import { PictureGrid } from '@/components/modal/settings/kit';
import { STYLE_COUNT, STYLE_ENTRIES, getStyleEntry, type StyleEntry } from './styles';
import StylePreview from './StylePreview';
import LivePreview from './LivePreview';
import { useSettingsStore, type StyleMode } from './settings';
import { usePlayerConfig } from '~/useConfigPublisher';

/** Folia's picker choice for the random pool; mirrors `random/lyricStyleChoices.tsx`. */
const RANDOM_VISUALIZER_CHOICE = '__random__';
/** A shelf value: a real style, or the 随机 tile. */
type ShelfValue = StyleMode | typeof RANDOM_VISUALIZER_CHOICE;

interface StageProps {
    t: (key: string) => string;
    visualizerMode: StyleMode;
    onVisualizerModeChange: (mode: StyleMode) => void;
    /** 0.7.22 随机池: whether the shelf should show the 随机 tile as chosen. */
    randomEnabled: boolean;
    onRandomChange: (enabled: boolean) => void;
}

const StylePicture: React.FC<{ mode: StyleMode; state: { visible: boolean } }> = ({ mode, state }) => (
    <img
        src={getStyleEntry(mode).thumb}
        alt={getStyleEntry(mode).labelFallback}
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover"
        style={{ opacity: state.visible ? 1 : 0 }}
    />
);

/** The 随机 tile shares the 16:10 frame with a style picture, so it is just a centred glyph. */
const RandomPicture: React.FC = () => (
    <span className="absolute inset-0 grid place-items-center bg-[var(--st-pv)] text-[color:var(--st-accent)]">
        <Shuffle size={28} aria-hidden="true" />
    </span>
);

const drawShelf = (value: ShelfValue, state: { visible: boolean }): React.ReactNode => (
    value === RANDOM_VISUALIZER_CHOICE ? <RandomPicture /> : <StylePicture mode={value} state={state} />
);

const Stage: React.FC<StageProps> = ({ t, visualizerMode, onVisualizerModeChange, randomEnabled, onRandomChange }) => {
    const [paused, setPaused] = useState(false);
    const [liveFailed, setLiveFailed] = useState(false);
    const settingsState = useSettingsStore();
    // The player's current config, verbatim: no placeholder song, no guessed theme, no preset
    // background. `null` only until the player page has received its first config.
    const config = usePlayerConfig();
    const transparent = config?.background?.transparent === true;

    return (
        <>
            {/* Big sample: Folia's real renderer in a scaled 1920x1080 iframe, showing the real song. */}
            <div
                className={`relative min-h-[160px] flex-1 overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--st-line)]${transparent ? ' st-stage-transparent' : ''}`}
            >
                {config != null && (liveFailed
                    ? <StylePreview mode={visualizerMode} paused={paused} />
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

            {/* Style shelf: 8 columns in the wide window (15 styles + 随机 = two clean rows), the
                count beside the heading. Choosing 随机 turns the pool on; choosing a style by hand
                turns it off again through the store's `setVisualizerMode`. */}
            <div className="flex shrink-0 flex-col">
                <h3 className="mb-2 flex min-h-6 items-center px-1 text-[13px] font-semibold leading-5 text-[color:var(--st-t2)]">
                    {t('options.lyricStyles')}
                    <span className="ml-1.5 font-normal text-[color:var(--st-t3)]">{STYLE_COUNT}</span>
                </h3>
                <PictureGrid<ShelfValue>
                    value={randomEnabled ? RANDOM_VISUALIZER_CHOICE : visualizerMode}
                    options={[
                        ...STYLE_ENTRIES.map((entry: StyleEntry) => ({
                            value: entry.mode as ShelfValue,
                            label: t(entry.labelKey) || entry.labelFallback,
                        })),
                        { value: RANDOM_VISUALIZER_CHOICE as ShelfValue, label: t('ui.visualizerRandom') },
                    ]}
                    picture={drawShelf}
                    columns={8}
                    onChange={value => {
                        if (value === RANDOM_VISUALIZER_CHOICE) onRandomChange(true);
                        else onVisualizerModeChange(value);
                    }}
                    label={t('ui.animationMode')}
                    maxHeight={250}
                    className="-mx-4"
                />
            </div>
        </>
    );
};

export default Stage;
