/* 歌词样式货架的**静态**实现：只画「简约图案」，一个渲染器都不加载。
 *
 * 这是 `previewAnimation` 开关关闭时的路径。它存在的理由不是「省点 CPU」，而是**在模块加载层面
 * 断链**：这个文件只 import 上游的 `modeGlyphs.tsx`（24×24 线性字形，注册表在它内部按 id 取字形）
 * 与本页的样式清单，绝不 import `LyricStylePicture` / `LivePicture` / `LyricPreviewProvider` /
 * `usePreviewClock` / `pictureImages` / 任何 `entry.tsx`。
 *
 * 为什么必须做到这个程度（真机验收会查）：样式渲染器是上游 registry 用 `import.meta.glob`
 * 按目录懒加载的 chunk，只有 `getVisualizerRegistryEntry(mode).render(...)` 真的被调用时才会去
 * 下载。只要这条链上任何一环被求值，就可能拉下一个样式的 renderer；所以静态路径连「Provider 挂个
 * 空壳」都不做 —— 它连 Provider 这个概念都不认识。
 *
 * 代价（有意接受）：开关关闭时**没有 hover 动画**。契约写得很清楚——第 3 条（模块级断链）优先。
 * 开关开着的时候完整保留上游那套「造图 → 静态 → hover 才跑」的体验（见 ShelfLiveView.tsx）。
 */
import React from 'react';
import { PictureGrid, type PictureState } from '@/components/modal/settings/kit';
import { VisualizerModeGlyph } from '@/components/visualizer/modeGlyphs';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { VisualizerMode } from '@/types';
import { RANDOM_VISUALIZER_CHOICE, SHELF_COLUMNS, ModPicture, RandomPicture, type ShelfValue } from './shelfShared';
import { isModStyleMode, parseModStyleMode, type ModStyleEntry } from './modStyles';

/**
 * 一格的图案：真实样式的线性字形（与上游降级时画的是同一个），随机格仍是 Shuffle。
 *
 * issue #23: 模组格同样走 `<img>`（模组自带的 preview 图）。虽然上游 `VisualizerModeGlyph` 对认不得
 * 的 mode 会**正确**回落成通用字形（`modeGlyphs.tsx:38-42`），但那样货架两版对同一格画的东西不一样
 * （实时版是 preview 图、静态版是通用字形），切开关时看起来像换了批模组。统一走 preview 图。
 */
const drawStaticChoice = (value: ShelfValue, _state: PictureState): React.ReactNode => {
    if (value === RANDOM_VISUALIZER_CHOICE) return <RandomPicture />;
    if (isModStyleMode(value)) {
        const entry = staticModTable.get(value);
        return <ModPicture previewUrl={entry?.previewUrl ?? null} label={entry?.label ?? (parseModStyleMode(value)?.vizId ?? 'mod')} />;
    }
    return (
        <span className="grid h-full w-full place-items-center text-[color:var(--st-t2)]">
            <VisualizerModeGlyph mode={value as VisualizerMode} size={22} />
        </span>
    );
};

/** 与 `ShelfLiveView` 同一套做法：模块级表，让 `drawStaticChoice` 的引用保持稳定。 */
let staticModTable: ReadonlyMap<string, ModStyleEntry> = new Map();

const setStaticModTable = (entries: readonly ModStyleEntry[]): void => {
    if (entries.length === 0 && staticModTable.size === 0) return;
    const next = new Map<string, ModStyleEntry>();
    for (const entry of entries) next.set(entry.mode, entry);
    staticModTable = next;
};

export interface StaticShelfProps {
    value: ShelfValue;
    options: ReadonlyArray<{ value: ShelfValue; label: string }>;
    onChange: (value: ShelfValue) => void;
    /** What the grid chooses, for a screen reader. */
    label: string;
    /** Whether the window is on screen at all. Kept in the signature so both shelves are interchangeable. */
    active: boolean;
    /** issue #23: 模组格（图 + 名字）。 */
    modEntries?: readonly ModStyleEntry[];
}

/**
 * 货架的静态版。结构、列数、标签、键盘行为与实时版完全一致（同一个 `PictureGrid`），
 * 只有「格子里画什么」不同 —— 于是切开关时布局不跳。
 */
export const StaticShelf: React.FC<StaticShelfProps> = ({ value, options, onChange, label, active, modEntries = [] }) => {
    const wide = useMediaQuery('(min-width: 1024px)');
    setStaticModTable(modEntries);
    if (!active) {
        return null;
    }
    return (
        <PictureGrid<ShelfValue>
            value={value}
            options={options}
            picture={drawStaticChoice}
            columns={wide ? SHELF_COLUMNS.wide : SHELF_COLUMNS.narrow}
            onChange={onChange}
            label={label}
            maxHeight={250}
            className="-mx-4"
        />
    );
};

export default StaticShelf;
