/* 歌词样式货架的**实时**实现：Folia 自己的渲染器小图 + 一层磁盘缓存。
 *
 * 这个模块只在「开关开」时被按需拉进来（见 `ShelfLive.tsx` 的 `React.lazy`），所以它可以把上游那
 * 整条链当静态依赖用；开关关的时候它连求值都不会发生，一个渲染器 chunk 也不会被下载。
 *
 * 上游原件的行为一条都没改：`LyricStylePicture` 画真渲染器，`LivePicture` 自己决定何时造图、
 * 何时跑；选中格不跑、指针停留 280ms 才跑、同一时刻只有一格在跑、造图串行 —— 全部来自上游。
 * 这个文件只补两件上游没有的事：
 *
 *  ① **磁盘缓存命中**：上游 `pictureImages` 那只 Map 是页内一级缓存；磁盘命中的静态图也注册进
 *     这只 Map（`keepImage`），于是 `LivePicture` 一上来就认为「这张图已经有了」：不排队造图、
 *     不拉渲染器 chunk、不起 rAF。指针停留时它照旧挂真渲染器跑 —— 那正是上游既有的
 *     `image → live` 路径，我们没改一行上游代码。
 *
 *  ② **把画好的图写回磁盘**：上游造完图会 `keepImage(key, 冻结元素)`，我们订阅 `subscribeImages`，
 *     看到新的冻结元素就压成纯静态 HTML 落盘（canvas → img）。
 *
 * 为什么用「订阅上游 Map」而不是自己造图：造图那一整套（何时造、串行、冻结时机、空舞台重试）
 * 是上游量化过的（pictureRule / pictureTurns / frozenPicture 注释里都有数字），复制一份必然走样。
 * 我们只做「同样的输入，换个地方存」。
 *
 * 为什么磁盘没查完之前不许造图：`LyricPreviewProvider` 有一个上游自己的 `making` 开关
 * （"Whether images may be made now"）。磁盘读是异步的，若一上来就允许造图，
 * `FIRST_IMAGE_REST_MS`（450ms）之后第一格就开造了，缓存命中就成了空话。所以开局
 * `making=false`，等这一轮的磁盘查询全部回来（另有 1.2s 兜底）再放开。命中则永远不用造。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PictureGrid, type PictureState } from '@/components/modal/settings/kit';
import LyricStylePicture from '@/components/visualizer/preview/LyricStylePicture';
import { LyricPreviewProvider, useLyricPreview, type LyricPreviewLook } from '@/components/visualizer/preview/LyricPreviewContext';
import { imageOf, keepImage, subscribeImages, stylePictureKey, type StylePictureShows } from '@/components/visualizer/preview/pictureImages';
import { runningPicture } from '@/components/visualizer/preview/pictureTurns';
import { usePreviewClock } from '@/components/visualizer/preview/usePreviewClock';
import { useVisualizerStyleAssets } from '@/components/visualizer/useVisualizerStyleAssets';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { Theme, VisualizerMode } from '@/types';
import { useFoliumVisualizerSettings } from '~/stubs/foliumVisualizers';
import { useFoliumTunings } from '~/stubs/foliumTunings';
import { useSettingsStore } from './settings';
import { IS_DAYLIGHT, PREVIEW_THEME } from './theme';
import { markRestored, resetTileDiskState, setTileKey } from './shelfDiskState';
import { RANDOM_VISUALIZER_CHOICE, SHELF_COLUMNS, RandomPicture, clampFontScale, type ShelfValue } from './shelfShared';
import { elementFromStaticHtml, readCachedPicture, staticPictureHtml, styleDiskKey, uploadsBlockCaching, writeCachedPicture } from './previewImageCache';

/** 开局最多等这么久磁盘，之后无论如何放开造图（缓存是优化，不能拿「打不开货架」换）。 */
const DISK_WAIT_MS = 1200;

/**
 * Draws one shelf tile exactly as Folia's own picker does. Defined outside the component because
 * PictureGrid re-renders every tile when the function itself is a new one.
 */
const drawLiveChoice = (value: ShelfValue, state: PictureState): React.ReactNode => (
    value === RANDOM_VISUALIZER_CHOICE
        ? <RandomPicture />
        : <LyricStylePicture mode={value as VisualizerMode} {...state} />
);

/* ------------------------------------------------------------------------------------------ */
/* 磁盘缓存：一格一实例                                                                         */
/* ------------------------------------------------------------------------------------------ */

interface DiskTileProps {
    /** 这格的样式 id。 */
    mode: string;
    /** 这一格的磁盘查询结束了（命中或不命中都算）。 */
    onSettled: () => void;
    /** 上传图在场时整条缓存关掉。 */
    blocked: boolean;
}

/**
 * 一格的磁盘读写。不渲染任何可见节点；每格一个固定实例（17 个），所以 hook 数量稳定。
 *
 * **必须挂在 `LyricPreviewProvider` 里面**：它用 `useLyricPreview()` 拿 stage / theme / isDaylight /
 * look —— 就是 Provider 交给 `LyricStylePicture` 的同一批对象。自己拼一份（读 17 次 window.innerWidth
 * 之类）迟早会跟 Provider 的 `useWindowSize` 差一帧，键就对不上了。
 *
 * 键必须与 `LyricStylePicture` 内部算出来的完全一致，否则命中不了：
 * 那个组件用 `{ mode, stage, theme(已归一), isDaylight, sample: clock.placeholder.id,
 * fontScale: look.lyricsFontScale, tuning: look.visualizerTunings[mode], modSettings, modTunings }`
 * 加三个上传图去拼键。这里逐字段照抄；`modSettings`/`modTunings` 走与它相同的两个 hook
 * （本页是空桩，但将来装了 folium 时键会自动跟着变，不用改这里）。
 */
const DiskTile: React.FC<DiskTileProps> = ({ mode, onSettled, blocked }) => {
    const preview = useLyricPreview();
    const modSettings = useFoliumVisualizerSettings(mode);
    const modTunings = useFoliumTunings(mode);

    const shows = useMemo<StylePictureShows>(() => ({
        mode,
        stage: preview.stage,
        // Provider 里已经是 themeForPictures(theme) 的结果，别再归一一次（两次归一结果相同，但省掉一次）
        theme: preview.theme,
        isDaylight: preview.isDaylight,
        sample: preview.clock.placeholder.id,
        fontScale: preview.look.lyricsFontScale,
        tuning: (preview.look.visualizerTunings as Record<string, unknown> | undefined)?.[mode],
        modSettings,
        modTunings,
    }), [mode, preview, modSettings, modTunings]);

    const { upstream, disk } = useMemo(() => ({
        // 上游键带上「上传图对象」，与 `LyricStylePicture` 传的是同一批引用，`markOf` 序号因此一致。
        upstream: stylePictureKey(
            shows,
            preview.look.cappellaCustomEmojiImages,
            preview.look.cappellaCustomAvatarImages,
            preview.look.monetPortraitImage,
        ),
        // 磁盘键只留纯数据：上传图对象的序号跨进程不稳定，不能进磁盘键。
        disk: styleDiskKey(shows),
    }), [shows, preview.look]);

    /** 这一格当前的磁盘键，探针按它统计「有多少格显示的是磁盘恢复的图」。 */
    useEffect(() => {
        setTileKey(mode, disk);
    }, [mode, disk]);

    /** 从磁盘恢复的图（按上游键记）：它们不再回写磁盘，否则每次启动都重写一遍。 */
    const restored = useRef(new Set<string>());
    /** 已经落过盘的图（按上游键记）。 */
    const written = useRef(new Set<string>());

    // ① 查磁盘。键变了（主题/字号/尺寸/tuning 变了）就重来一次。
    useEffect(() => {
        if (blocked || !disk) {
            onSettled();
            return undefined;
        }
        let cancelled = false;
        void (async () => {
            const record = await readCachedPicture(disk);
            if (!cancelled && record) {
                const element = elementFromStaticHtml(record.html);
                // 上游 Map 已经有值（本页刚造的，或另一格算出同一把键）就不动它：本页的真图更权威。
                if (element && imageOf(upstream) === undefined) {
                    keepImage(upstream, element);
                    restored.current.add(upstream);
                    markRestored(disk);
                }
            }
            if (!cancelled) onSettled();
        })();
        return () => {
            cancelled = true;
        };
    }, [disk, upstream, blocked, mode, onSettled]);

    // ② 写磁盘。订阅回调拿不到「是哪个键变了」，但每格只关心自己那一把键，判断很便宜。
    useEffect(() => {
        if (blocked) return undefined;
        return subscribeImages(() => {
            if (restored.current.has(upstream) || written.current.has(upstream)) return;
            const image = imageOf(upstream);
            if (image === undefined || image === null) return;
            written.current.add(upstream);
            const html = staticPictureHtml(image);
            if (html) void writeCachedPicture(disk, html);
        });
    }, [blocked, upstream, disk]);

    return null;
};

/* ------------------------------------------------------------------------------------------ */
/* 货架                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface LiveShelfProps {
    /** The real chosen style; drives the preview clock's start offset even while 随机 is the shelf value. */
    mode: string;
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

/** 参与磁盘缓存的格子：除随机格以外的样式。 */
const styleModesOf = (options: ReadonlyArray<{ value: ShelfValue }>): string[] =>
    options.map(option => option.value).filter(item => item !== RANDOM_VISUALIZER_CHOICE);

/**
 * The shelf as Folia draws it: `PictureGrid` around live pictures, with one `LyricPreviewProvider`
 * (one clock, one theme, one `look`) over the whole grid.
 */
export const LiveShelf: React.FC<LiveShelfProps> = ({ mode, value, options, onChange, label, paused, active }) => {
    const appearance = useSettingsStore(state => state.appearance);
    const styleTunings = useSettingsStore(state => state.styleTunings);
    // 群唱's emoji/avatar and 莫奈's portrait: none are uploaded in this page, so these are the
    // empty shapes Folia's renderer takes (stubbed asset store), exactly as upstream's window passes them.
    const styleAssets = useVisualizerStyleAssets();
    const wide = useMediaQuery('(min-width: 1024px)');
    const styleModes = useMemo(() => styleModesOf(options), [options]);
    const modeCount = styleModes.length;

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

    // 上传图在场时整条磁盘缓存关掉（blob: 地址落盘就是破图，键也对不上）。
    const blocked = uploadsBlockCaching(look);

    // VisPlayground.tsx:192: one synthesized sample clock for the big sample and every small picture.
    // `paused` follows the stage's pause button; `!active` is the injected page's extra: the overlay is
    // never unmounted when hidden, so the shelf is — exactly as upstream's own window unmounts when it
    // closes. That way nothing runs and no rAF loop survives behind `display:none`.
    const clock = usePreviewClock({ mode: mode as VisualizerMode, placeholderId: 'default', paused: paused || !active });

    // `stage` 就是 Provider 内部 `useWindowSize()` 的值 —— 但这里不需要自己再算一遍：`DiskTile`
    // 在 Provider 里面读 `preview.stage`，天然与 `LyricStylePicture` 用的是同一个数。

    /**
     * 这一轮磁盘查询的批次：签名变了（主题/字号/tuning 变了）就归零重来。
     *
     * 用「渲染期调整 state」而不是在 effect 里重置：子组件的 effect 先于父组件的 effect 跑，
     * 若在父 effect 里清零，子组件刚报上来的「查完了」会被抹掉，货架就得干等 1.2s 兜底。
     */
    const signature = useMemo(() => JSON.stringify([theme, IS_DAYLIGHT, look.lyricsFontScale, styleTunings]), [theme, look.lyricsFontScale, styleTunings]);
    const [pass, setPass] = useState({ signature, done: 0, forced: false });
    if (pass.signature !== signature) {
        setPass({ signature, done: 0, forced: false });
    }

    /** 一格的磁盘查询回来了：计数 +1。 */
    const onSettled = useMemo(() => () => {
        setPass(before => (before.signature === signature ? { ...before, done: before.done + 1 } : before));
    }, [signature]);

    // 兜底：磁盘再慢也不能让货架一直不造图。
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setPass(before => (before.signature === signature ? { ...before, forced: true } : before));
        }, DISK_WAIT_MS);
        return () => window.clearTimeout(timer);
    }, [signature]);

    // 卸载（关窗）时清掉磁盘登记，免得下次打开读到上一轮的陈旧「已恢复」标记。
    useEffect(() => () => resetTileDiskState(), []);

    /**
     * 把上游 `pictureTurns.runningPicture()` 挂到 window 上，供 `ShelfLive.tsx` 的探针读取。
     *
     * 探针文件必须保持极轻（不能 import `pictureTurns`，否则整条 preview 链会进入口 chunk），
     * 而实时版一定已经把 `pictureTurns` 载入了 —— 由它装这个 getter 最自然。
     * 卸载时撤掉，避免关窗后探针读到上一轮的状态。
     */
    useEffect(() => {
        const host = window as Window & { __SPW_SHELF_RUNNING__?: () => string | null };
        host.__SPW_SHELF_RUNNING__ = runningPicture;
        return () => {
            delete host.__SPW_SHELF_RUNNING__;
        };
    }, []);

    /** 上游自己的「现在能不能造图」：这一轮磁盘还没查完就关着。 */
    const making = blocked || pass.forced || pass.done >= modeCount;

    if (!active) {
        return null;
    }

    return (
        <LyricPreviewProvider
            clock={clock}
            theme={theme}
            isDaylight={IS_DAYLIGHT}
            look={look}
            making={making}
        >
            <PictureGrid<ShelfValue>
                value={value}
                options={options}
                picture={drawLiveChoice}
                columns={wide ? SHELF_COLUMNS.wide : SHELF_COLUMNS.narrow}
                onChange={onChange}
                label={label}
                maxHeight={250}
                className="-mx-4"
            />
            {/* 每格一个磁盘读手；放在 Provider 里面，才能读到 `preview.stage/theme/look` ——
                与 `LyricStylePicture` 拿到的是同一批对象，键必然一致。 */}
            {styleModes.map(item => (
                <DiskTile key={item} mode={item} onSettled={onSettled} blocked={blocked} />
            ))}
        </LyricPreviewProvider>
    );
};

export default LiveShelf;
