/* 歌词样式货架：Folia 自己的**实时**小图（不是截图）。
 *
 * 这里不再画 `thumbs/<mode>.jpg`。每一格都是上游 `components/visualizer/preview/` 的
 * `LyricStylePicture` —— 真实渲染器、真实小图机器（LivePicture / pictureRule / pictureTurns /
 * frozenPicture / previewScale），外面套上游自己的 `LyricPreviewProvider`，由
 * `usePreviewClock` 的合成样例时钟驱动（神文之诗，和 VisPlayground 的样例同一首歌）。选中的格子
 * 不跑、指针停留 280ms 后才跑、同一时刻只有一格在跑、造图串行 —— 全部来自上游模块本身，这里
 * 没有重新实现任何一条规则。
 *
 * 为什么用合成时钟而不是宿主真实的 `state`/`audio`：上游 VisPlayground 的小图就是用
 * `usePreviewClock`（VisPlayground.tsx:192）而不是大样例的 live feed；小图的 key、海报帧时刻、
 * 停顿延迟都按那套样例时轴算，换一套时钟会立刻偏离 1:1。大样例（LivePreview 的 iframe）继续
 * 镜像真实播放，两者互不影响 —— 和上游「大样例实时、小图合成」的分工一致。
 *
 * 主题取窗口自己的主题（PREVIEW_THEME + 用户字体），与 VisPlayground 的 `previewTheme`
 * 同构；不跟歌曲封面主题，因为本窗口的配色本来就是固定的（v0.3.x 决定），而封面主题每换歌
 * 都会变，会触发 17 格重造图。
 *
 * 性能规则原样保留（上游 pictureRule.ts 的注释量化过：14 格全跑 18.7–37.6 ms/帧；Chromium
 * 一页 16 个 WebGL context）：造图一次一格、跑图一次一格、选中格不跑、指针停顿 280ms 才跑、
 * 离开就停；舞台画完就冻结成图并把 WebGL context 交还（frozenPicture.followCanvases）。
 * 画不出来 / 渲染器抛错的样式由上游自己的 `PictureStageBoundary` + `afterTry` 落到 glyph ——
 * 这就是上游的降级，不是这里的补丁。
 */
import React, { useEffect, useMemo } from 'react';
import { Shuffle } from 'lucide-react';
import { PictureGrid, type PictureState } from '@/components/modal/settings/kit';
import LyricStylePicture from '@/components/visualizer/preview/LyricStylePicture';
import { LyricPreviewProvider, type LyricPreviewLook } from '@/components/visualizer/preview/LyricPreviewContext';
import { runningPicture } from '@/components/visualizer/preview/pictureTurns';
import { usePreviewClock } from '@/components/visualizer/preview/usePreviewClock';
import { useVisualizerStyleAssets } from '@/components/visualizer/useVisualizerStyleAssets';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { Theme, VisualizerMode } from '@/types';
import { useSettingsStore, type StyleMode } from './settings';
import { IS_DAYLIGHT, PREVIEW_THEME } from './theme';

/** Folia's picker choice for the random pool; mirrors `random/lyricStyleChoices.tsx`. */
export const RANDOM_VISUALIZER_CHOICE = '__random__';
/** A shelf value: a real style, or the 随机 tile. */
export type ShelfValue = StyleMode | typeof RANDOM_VISUALIZER_CHOICE;

/** Folia's own shelf geometry (VisPlayground.tsx:123): 7 pictures in the wide window, 4 where it is one column. */
export const SHELF_COLUMNS = { wide: 7, narrow: 4 };

/** Folia's `clampFontScale` (VisPlayground.tsx:119): the pictures draw at the saved scale, inside the panel's range. */
const clampFontScale = (value: number) => Math.min(1.4, Math.max(0.85, value));

/** The 随机 tile shares the 16:10 frame with a style picture, so it is just a centred glyph. */
const RandomPicture: React.FC = () => (
    <span className="grid h-full w-full place-items-center text-[color:var(--st-accent)]">
        <Shuffle size={28} aria-hidden="true" />
    </span>
);

/**
 * Draws one shelf tile exactly as Folia's own picker does (`random/lyricStyleChoices.tsx`):
 * the real live picture for a style, the shuffle glyph for 随机. Defined outside the component
 * because PictureGrid re-renders every tile when the function itself is a new one.
 */
const drawShelfChoice = (value: ShelfValue, state: PictureState): React.ReactNode => (
    value === RANDOM_VISUALIZER_CHOICE
        ? <RandomPicture />
        : <LyricStylePicture mode={value as VisualizerMode} {...state} />
);

interface LyricStyleShelfProps {
    /** The real chosen style; drives the preview clock's start offset even while 随机 is the shelf value. */
    mode: StyleMode;
    /** What the shelf shows as chosen (a style or 随机). */
    value: ShelfValue;
    options: ReadonlyArray<{ value: ShelfValue; label: string }>;
    onChange: (value: ShelfValue) => void;
    /** What the grid chooses, for a screen reader. */
    label: string;
    /** The stage's pause button: Folia pauses the sample's and the pictures' one clock together. */
    paused: boolean;
    /** Whether the window is on screen at all. A hidden overlay keeps no preview clock running. */
    active: boolean;
}

/**
 * The shelf as Folia draws it: `PictureGrid` around live pictures, with one `LyricPreviewProvider`
 * (one clock, one theme, one `look`) over the whole grid.
 */
export const LyricStyleShelf: React.FC<LyricStyleShelfProps> = ({ mode, value, options, onChange, label, paused, active }) => {
    const appearance = useSettingsStore(state => state.appearance);
    const styleTunings = useSettingsStore(state => state.styleTunings);
    // 群唱's emoji/avatar and 莫奈's portrait: none are uploaded in this page, so these are the
    // empty shapes Folia's renderer takes (stubbed asset store), exactly as upstream's window passes them.
    const styleAssets = useVisualizerStyleAssets();
    const wide = useMediaQuery('(min-width: 1024px)');

    // VisPlayground.tsx:253-259: the window's theme with the user's font choices.
    const theme = useMemo<Theme>(() => {
        const stack = appearance.customFontStack
            ? appearance.customFontStack.split(',').map(part => part.trim()).filter(Boolean)
            : undefined;
        return {
            ...PREVIEW_THEME,
            fontStyle: appearance.fontStyle === 'custom' ? PREVIEW_THEME.fontStyle : appearance.fontStyle,
            fontFamily: appearance.customFontFamily ?? undefined,
            fontFamilyStack: stack,
            fontWeight: appearance.fontWeight ?? undefined,
        };
    }, [appearance.customFontFamily, appearance.customFontStack, appearance.fontStyle, appearance.fontWeight]);

    // VisPlayground.tsx:281-285: the pictures draw with what is **saved**, not with a slider's draft,
    // and with the tunings keyed by mode — the exact bundle `applyVisualizerTuning` expects.
    const look = useMemo<LyricPreviewLook>(() => ({
        visualizerTunings: styleTunings as unknown as LyricPreviewLook['visualizerTunings'],
        lyricsFontScale: clampFontScale(appearance.fontScale),
        ...styleAssets,
    }), [styleTunings, appearance.fontScale, styleAssets]);

    // VisPlayground.tsx:192: one synthesized sample clock for the big sample and every small picture.
    // `paused` follows the stage's pause button; `!active` is the injected page's extra: the overlay is
    // never unmounted when hidden (docs/protocol.md §7.5), so the shelf is — exactly as upstream's own
    // window unmounts when it closes. That way nothing runs and no rAF loop survives behind
    // `display:none`; the images themselves live in `pictureImages`, a page-lifetime cache, so
    // reopening paints them at once instead of making them again.
    const clock = usePreviewClock({ mode, placeholderId: 'default', paused: paused || !active });

    if (!active) {
        return null;
    }

    return (
        <LyricPreviewProvider clock={clock} theme={theme} isDaylight={IS_DAYLIGHT} look={look}>
            {/* data-spw-shelf: the host probe's anchor (see `useShelfProbe` below); the grid itself is
                Folia's own component and takes no extra attributes. */}
            <div data-spw-shelf="">
                <PictureGrid<ShelfValue>
                    value={value}
                    options={options}
                    picture={drawShelfChoice}
                    columns={wide ? SHELF_COLUMNS.wide : SHELF_COLUMNS.narrow}
                    onChange={onChange}
                    label={label}
                    maxHeight={250}
                    className="-mx-4"
                />
            </div>
        </LyricPreviewProvider>
    );
};

/**
 * 货架自检（宿主探针用）：这一刻货架在画什么。
 *
 * 读的是上游自己打在舞台上的标记 —— `data-picture="image"`（已冻结成图）、`"making"`（正在造图）、
 * `"running"`（正在跑）—— 以及 `pictureTurns.runningPicture()`。验证脚本据此断言「有图、正在跑的
 * 只有一格、选中的那格从不跑」，不需要往 DOM 里加私有标记。挂在 window 上而不是导出，是因为
 * 宿主探针只能 eval 字符串。
 */
const exposeShelfState = () => {
    const read = () => {
        const root = document.querySelector('[data-spw-shelf]');
        const runningNode = root?.querySelector<HTMLElement>('[data-picture="running"]');
        const tileOf = (node: HTMLElement | null | undefined) => node?.closest<HTMLElement>('[data-value]')?.dataset.value ?? null;
        return {
            tiles: root?.querySelectorAll('[data-value]').length ?? 0,
            pictures: root?.querySelectorAll('[data-picture]').length ?? 0,
            images: root?.querySelectorAll('[data-picture="image"]').length ?? 0,
            making: root?.querySelectorAll('[data-picture="making"]').length ?? 0,
            running: root?.querySelectorAll('[data-picture="running"]').length ?? 0,
            runningValue: tileOf(runningNode),
            runningPicture: runningPicture(),
            glyphs: root?.querySelectorAll('.opacity-50').length ?? 0,
            chosen: root?.querySelector('[aria-checked="true"]')?.getAttribute('data-value') ?? null,
        };
    };
    (window as Window & { __SPW_SHELF_STATE__?: () => unknown }).__SPW_SHELF_STATE__ = read;
    return () => {
        delete (window as Window & { __SPW_SHELF_STATE__?: () => unknown }).__SPW_SHELF_STATE__;
    };
};

/** Installs the probe hook once for the page's life. */
export const useShelfProbe = (): void => {
    useEffect(() => exposeShelfState(), []);
};

export default LyricStyleShelf;
