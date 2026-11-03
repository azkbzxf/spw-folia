/* 歌词样式货架两边（实时版 / 静态版）共用的常量与类型。
 *
 * 单独一个文件是**为了不让静态版碰到实时版那条 import 链**：`ShelfLive.tsx`（路由）与
 * `ShelfStatic.tsx`（只画图案）都从这里取，而这里只依赖 lucide 的一个图标（本来就在入口
 * chunk 里），不碰 `LyricStylePicture` / `pictureImages` / 任何渲染器。
 *
 * 为什么这么计较：开关关掉时必须**一个样式渲染器 chunk 都不新增**（真机验收按 resource entries
 * 比对）。只要静态路径上有静态 import 把 `LyricStylePicture` 拉进来，某些样式就可能被注册进
 * registry 并触发它自己的 import；把常量挪出来是最省事的断点。
 */
import React from 'react';
import { Shuffle } from 'lucide-react';
import type { StyleMode } from './settings';

/** Folia's picker choice for the random pool; mirrors `random/lyricStyleChoices.tsx`. */
export const RANDOM_VISUALIZER_CHOICE = '__random__';
/**
 * A shelf value: a real style, or the 随机 tile.
 *
 * 故意保留成联合类型而不是 `string`：`Stage.tsx` 把它交回 `onVisualizerModeChange(mode: StyleMode)`，
 * 放宽成 string 会在调用处丢类型安全（tsc 基线里一条都不许新增）。`import type` 在编译期被抹掉，
 * 不会在运行期把 `settings.ts` 拖进静态路径。
 */
export type ShelfValue = StyleMode | typeof RANDOM_VISUALIZER_CHOICE;

/** Folia's own shelf geometry (VisPlayground.tsx:123): 7 pictures in the wide window, 4 where it is one column. */
export const SHELF_COLUMNS = { wide: 7, narrow: 4 };

/** Folia's `clampFontScale` (VisPlayground.tsx:119): the pictures draw at the saved scale. */
export const clampFontScale = (value: number) => Math.min(1.4, Math.max(0.85, value));

/** The 随机 tile shares the 16:10 frame with a style picture, so it is just a centred glyph. */
export const RandomPicture: React.FC = () => (
    <span className="grid h-full w-full place-items-center text-[color:var(--st-accent)]">
        <Shuffle size={28} aria-hidden="true" />
    </span>
);
