/* 歌词样式货架：**按开关在模块加载层面二选一**（`previewAnimation`）。
 *
 * 这个文件是货架唯一的入口（`Stage.tsx` 只认它），它自己必须保持极轻：只 import 路由用的
 * `React.lazy`、探针、静态版（`ShelfStatic.tsx`，只画图案），**绝不静态 import 实时版**。
 *
 * 为什么这么写：真机验收要求在开关关闭时「**不得新增任何样式渲染器 chunk**」。样式渲染器是
 * 上游 registry 用 `import.meta.glob` 按目录懒加载的 chunk，但整条上游链（`LyricStylePicture` →
 * `LivePicture` → 上游 registry → 每个样式入口的 `render`）只要被**求值**就可能牵出它们。
 * 所以实时版被拆成 `ShelfLiveView.tsx`，这里用 `React.lazy(() => import(...))` 按需拉：
 *
 *   - 开关关：`lazy` 的工厂函数一次都不会被调用 → 那块 chunk 不下载 → 渲染器链完全不存在。
 *     静态版是同步 import 的，路径上只有 `modeGlyphs`（按 id 查字符串集合取字形，不碰 renderer）。
 *   - 开关开：`Suspense` 挂起极短一瞬，等实时版 chunk 到位，行为与改动前**逐字一致**（上游那套
 *     造图/冻结/hover 跑图规则原样保留）。
 *
 * 开关热更新（配置页改完 → 宿主 `settings` 事件）会让开关值翻转：关 → 开时 lazy 工厂才第一次
 * 被调用；开 → 关时实时版被卸载，它挂着的渲染器、rAF、WebGL context 全部按上游自己的 cleanup
 * 释放（`followCanvases` / `usePreviewClock` 的 effect 清理）。两条方向都不需要重开窗口。
 *
 * 磁盘缓存只在实时版里（`previewImageCache.ts` 被 `ShelfLiveView.tsx` 独占引用）：开关关时不读不写。
 */
import React, { Suspense, useEffect } from 'react';
import { usePreviewAnimation } from './useInjectedSwitch';
import { StaticShelf } from './ShelfStatic';
import { restoredCount } from './shelfDiskState';
import type { StyleMode } from './settings';
import { RANDOM_VISUALIZER_CHOICE, type ShelfValue } from './shelfShared';

/** 实时版按需拉取：开关关的时候这个工厂一次都不会跑，那块 chunk 也就不下载。 */
const LiveShelf = React.lazy(() => import('./ShelfLiveView'));

export { RANDOM_VISUALIZER_CHOICE, SHELF_COLUMNS, type ShelfValue } from './shelfShared';

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
 * 货架。开关开着走实时版（上游渲染器 + 磁盘缓存），关着走静态版（只画简约图案）。
 *
 * `data-spw-shelf-mode` 是给宿主探针的：`"live"` / `"static"`，契约固定，别改字面量。
 * 关窗时整棵货架卸载（`return null`）—— 与改动前一致，探针在窗口关闭时读不到格子。
 */
export const LyricStyleShelf: React.FC<LyricStyleShelfProps> = ({ mode, value, options, onChange, label, paused, active }) => {
    const animated = usePreviewAnimation();

    if (!active) {
        return null;
    }

    return (
        <div data-spw-shelf="" data-spw-shelf-mode={animated ? 'live' : 'static'}>
            {animated
                ? (
                    <Suspense fallback={<ShelfPlaceholder value={value} options={options} onChange={onChange} label={label} active={active} />}>
                        <LiveShelf
                            mode={mode}
                            value={value}
                            options={options}
                            onChange={onChange}
                            label={label}
                            paused={paused}
                            active={active}
                        />
                    </Suspense>
                )
                : <StaticShelf value={value} options={options} onChange={onChange} label={label} active={active} />}
        </div>
    );
};

/**
 * 实时版 chunk 还在下载时的占位：画面就是静态版本身。
 *
 * 这样「开关开着但 chunk 还没到」的瞬间不会白一块 —— 用户看到的是同一批图案，chunk 一到就被
 * 真实小图替换掉。这条路径只在开关开时走，所以不违反「关掉时不加载渲染器」的约束。
 */
const ShelfPlaceholder: React.FC<Omit<LyricStyleShelfProps, 'mode' | 'paused'>> = ({ value, options, onChange, label, active }) => (
    <StaticShelf value={value} options={options} onChange={onChange} label={label} active={active} />
);

/* ------------------------------------------------------------------------------------------ */
/* 宿主探针                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * 货架自检：这一刻货架在画什么。
 *
 * 读的是上游自己打在舞台上的标记 —— `data-picture="image"`（已冻结成图）、`"making"`（正在造图）、
 * `"running"`（正在跑）。验证脚本据此断言「有图、正在跑的只有一格、选中的那格从不跑」，不需要往
 * DOM 里加私有标记。挂在 window 上而不是导出，是因为宿主探针只能 eval 字符串。
 *
 * 契约字段（一个都不能少，见 task-1）：
 *   `tiles, pictures, images, making, running, runningValue, runningPicture, glyphs, chosen,
 *    animated, cached, pending`
 *   - `animated`：货架是不是实时版（读 `data-spw-shelf-mode`）；
 *   - `cached`：当前显示「磁盘恢复的图」的格子数（`shelfDiskState`）；
 *   - `pending`：还没有图、也还没在造图的**样式格**数 —— 也就是「还在等」的格子。
 *
 * `pending` 的两条口径（都是刻意的）：
 *   ① **static 模式下恒 0**：这个模式不承诺有图，每格画的是图案。若照实报 17，同一个字段在两种
 *      模式下含义就不同了，「已就绪」这个信号会永远为假，探针没法用统一判据。
 *   ② **随机格不算**：随机格永远不会有图（它画的是 Shuffle 图案），算进来会让「全部就绪」永远差 1。
 *
 * 注意一个格子可能**同时**有 `image` 与 `making` 节点（LivePicture 在造新图时仍显示旧图），
 * 所以 `pending` 不能由 `tiles - images - making` 算，必须逐格看。
 */
const readShelfState = () => {
    const root = document.querySelector('[data-spw-shelf]');
    const tiles = root ? [...root.querySelectorAll<HTMLElement>('[data-value]')] : [];
    const runningNode = root?.querySelector<HTMLElement>('[data-picture="running"]') ?? null;
    const animated = root?.getAttribute('data-spw-shelf-mode') === 'live';

    /** 一格里面有没有某种舞台标记。 */
    const has = (tile: HTMLElement, kind: string): boolean => tile.querySelector(`[data-picture="${kind}"]`) !== null;
    /** 一格已经有图了（冻结图，或正在跑的真实渲染器）。 */
    const hasPicture = (tile: HTMLElement): boolean => has(tile, 'image') || has(tile, 'running');

    return {
        tiles: tiles.length,
        pictures: root?.querySelectorAll('[data-picture]').length ?? 0,
        images: root?.querySelectorAll('[data-picture="image"]').length ?? 0,
        making: root?.querySelectorAll('[data-picture="making"]').length ?? 0,
        running: root?.querySelectorAll('[data-picture="running"]').length ?? 0,
        runningValue: runningNode?.closest<HTMLElement>('[data-value]')?.dataset.value ?? null,
        // 从上游模块直接读（实时版装载时把这个 getter 挂上去），而不是从 DOM 反推。
        runningPicture: runningPictureSafe(),
        // 上游把「画不出来」的格画成 glyph，那层是 `opacity-50`。
        glyphs: root?.querySelectorAll('.opacity-50').length ?? 0,
        chosen: root?.querySelector('[aria-checked="true"]')?.getAttribute('data-value') ?? null,
        /** 契约字段：货架是实时版还是静态版。 */
        animated,
        /** 契约字段：显示着磁盘恢复图的格子数（static 模式没有图，自然是 0）。 */
        cached: restoredCount(),
        /**
         * 契约字段：还没有图、也还没在造图的样式格数（随机格不算）。
         * static 模式下恒 0 —— 这个模式不承诺有图。
         */
        pending: animated
            ? tiles.filter(tile => tile.dataset.value !== RANDOM_VISUALIZER_CHOICE && !hasPicture(tile) && !has(tile, 'making')).length
            : 0,
    };
};

/**
 * `pictureTurns.runningPicture()` 的**按需**读取。
 *
 * 这个文件不能静态 import `pictureTurns`：那会把 `pictureRule`（→ kit/motion → framer-motion）
 * 连同上游 preview 目录一起拖进入口 chunk，等于给静态路径留了半条渲染器链。探针只在实时版下
 * 才有意义，而实时版一定已经把 `pictureTurns` 载入 —— 由它把 getter 挂到 window 上（见
 * `ShelfLiveView.tsx` 末尾）。没装（静态版 / 实时版还没到）时返回 null，与上游「没有格子在跑」
 * 的返回值一致。
 */
const runningPictureSafe = (): string | null => {
    const getter = (window as Window & { __SPW_SHELF_RUNNING__?: () => string | null }).__SPW_SHELF_RUNNING__;
    try {
        return typeof getter === 'function' ? getter() : null;
    } catch {
        return null;
    }
};

/** Installs the probe hook once for the page's life. */
export const useShelfProbe = (): void => {
    useEffect(() => {
        const host = window as Window & { __SPW_SHELF_STATE__?: () => unknown };
        host.__SPW_SHELF_STATE__ = readShelfState;
        return () => {
            delete host.__SPW_SHELF_STATE__;
        };
    }, []);
};

export default LyricStyleShelf;
