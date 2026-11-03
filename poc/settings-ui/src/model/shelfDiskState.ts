/* 货架的**磁盘缓存登记表**：一格一格的键、以及「这一格显示的是磁盘恢复的图吗」。
 *
 * 为什么要单独一张表而不是把状态塞进货架组件的 state：
 *   - 宿主探针（`__SPW_SHELF_STATE__`）要**同步**读出 `cached` / `pending`，而它挂在 window 上、
 *     只能 eval 字符串，读不到 React 内部；
 *   - 磁盘读是异步的、每格独立，谁先回来谁登记，用一张 Map 最直接。
 *
 * ## 为什么表挂在 window 上而不是模块作用域（v0.4.16 的真机 bug）
 *
 * 这个文件被**两个 chunk** 引用：
 *   - `ShelfLive.tsx`（入口 chunk，同步）import 了 `restoredCount` 给探针用；
 *   - `ShelfLiveView.tsx`（`React.lazy` 拆出去的独立 chunk）import 了 `setTileKey` / `markRestored` 去写。
 *
 * 打包器会把每个 chunk 各自留一份模块实例，所以**写的那份和读的那份不是同一个 Map**：
 * 真机表现就是 IDB 里明明 17 条、二次启动 457ms、`cached` 却恒 0。同一个坑在 `runningPicture`
 * 上已经踩过一次（那里用 `window.__SPW_SHELF_RUNNING__` 绕开），这里同样把它挂到 window。
 *
 * 顺带一提 `window` 本身也更贴合这张表的语义：它描述的是**整页**的货架状态，不是某个模块的私有状态。
 *
 * 这张表只是一个**旁路观察**：货架该怎么画完全由上游的 `pictureImages` 决定，这张表坏了也不影响
 * 画面（只是探针数字不准）。所以这里没有任何容错代码 —— 全是内存里的同步 Map 操作。
 */

interface TileDiskState {
    /** 这一格当前算出来的磁盘键（缓存键变了就是新键）。 */
    key: string;
    /** 这张图是从磁盘恢复的（而不是本页造出来的）。 */
    restored: boolean;
}

/** 全页唯一的登记表。多份模块实例共用它，读与写因此看得到彼此。 */
const STORE_KEY = '__SPW_SHELF_DISK_TILES__';

const store = (): Map<string, TileDiskState> => {
    const host = window as Window & { [STORE_KEY]?: Map<string, TileDiskState> };
    const existing = host[STORE_KEY];
    if (existing instanceof Map) return existing;
    const created = new Map<string, TileDiskState>();
    host[STORE_KEY] = created;
    return created;
};

/** 一格算好了自己的磁盘键。 */
export const setTileKey = (value: string, key: string): void => {
    const tiles = store();
    const before = tiles.get(value);
    tiles.set(value, { key, restored: before?.key === key ? before.restored : false });
};

/** 这一格从磁盘恢复了。 */
export const markRestored = (key: string): void => {
    store().forEach((state) => {
        if (state.key === key) state.restored = true;
    });
};

/**
 * 显示着磁盘恢复图的格子数。
 *
 * 签名保持不变（探针直接调它）；内部读的是 window 上那张共享表，所以入口 chunk 里调用也能看到
 * lazy chunk 写入的登记。
 */
export const restoredCount = (): number => {
    let count = 0;
    store().forEach((state) => {
        if (state.restored) count += 1;
    });
    return count;
};

/** 页面/窗口卸载时清空，免得下一次打开读到上一轮的陈旧标记。 */
export const resetTileDiskState = (): void => {
    store().clear();
};
