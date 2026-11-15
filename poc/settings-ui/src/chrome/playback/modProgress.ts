/* issue #23 · 播放条的模组 slot（**我们自己的**，不是上游 `folium.registries.progressButtons`）。
 *
 * ## 为什么不能复用上游那套注册表（三条硬事实，见 `.scratch/issue23/repo-report.md` §5.3）
 *
 * 1. **我们的 surface 根本不渲染 `ProgressBar`。** `ObsBrowserSourceApp.tsx:189-247` 只有
 *    `<VisualizerRenderer>` 与 `<ObsNowPlayingCard>`（`:229` 还写死 `isPlayerChromeHidden={true}`），
 *    而 `FoliumProgressButtons/Layers` 的消费者是 Electron 侧的 `FloatingPlayerControls` /
 *    `LatticePlaybackControls`。那两套注册表在我们这个页面里一次都不会被求值。
 * 2. **注册表要由模组 client 填充，而 client loader 需要 `window.electron.mods`**
 *    （`mods/runtime/clientLoader.ts:255-263` + `mods/ipc.ts:21-23`）。
 * 3. **我们的播放条有独立的 DOM 契约**（`docs/playback-controls.md` §4 + `PlaybackBar.tsx:30-41`）：
 *    改 `.spw-playback-play` / `.spw-playback-step` / `.spw-playback-icon` 会让
 *    `verify-click-zones.mjs` FAIL —— 那是门禁，不是建议。
 *
 * ⇒ 播放条自己持有一张**同形状**的本地 slot 表，只读 Shim 转发过来的
 * `window.__SPW_FOLIA_MOD_PROGRESS__`（`{id,slot,order,mount}` 数组 + 订阅者）。
 *
 * ## 与上游契约的对齐（`work/folia/…/src/mods/folium/contract.ts:952-1006`）
 *
 * 上游的 ctx 字段名是 `playbackTime`（一个 clock 对象，不是 number）、`onPlaybackTime`、
 * `getDuration()`、`timeToRatio()`、`seek()`、`getColors()`。这里**逐字给全** —— 模组代码是按那份
 * 契约写的，少一个字段就是 `TypeError`，而模组在自己的 try/catch 里静默吞掉之后，用户看到的只是
 * 「按钮没出现」。
 *
 * slot 只有两个（上游 `progress.tsx:23` 的 `BUTTON_SLOTS` 是 `['progress.leading','progress.trailing']`），
 * Shim 会把它映射成 `'leading' | 'trailing'` 再放进那个全局。这里两种拼写都认（映射万一没做）。
 *
 * ## 卸载语义（照 `FoliumMountHost.tsx:92-96`）
 *
 * `mount(container, ctx)` 返回 `void | (() => void) | Promise<...>`。容器卸载时必须**先跑 disposer**
 * （mount 返回 Promise 就等它 resolve 再拿），再 `container.remove()`。顺序反了会让模组在已经
 * 被摘掉的节点上继续跑 rAF / 事件监听。
 */
import { clockPosition, type PlaybackClock } from './playbackClock';

/** 上游的两个 slot，映射后的名字。 */
export type ModProgressSlot = 'leading' | 'trailing';

/** 上游 ctx 的形状（`contract.ts:952-1006`）。模组代码按这个写，**一个字段都不能少**。 */
export interface ModProgressContext {
    /** 播放时钟：`get()` 取当前秒数，`on(cb)` 订阅（返回 dispose）。上游叫 `playbackTime`。 */
    playbackTime: { get: () => number; on: (listener: (seconds: number) => void) => () => void };
    /** 同上的直接形式（上游另有一份 `onPlaybackTime`）。 */
    onPlaybackTime: (listener: (seconds: number) => void) => () => void;
    /** 总时长（秒）；未知为 0。 */
    getDuration: () => number;
    /** 秒 → 0..1；时长未知时返回 0。 */
    timeToRatio: (seconds: number) => number;
    /** 跳到某个秒数（由我们转成 `seek` 控制消息发给插件）。 */
    seek: (seconds: number) => void;
    /** 播放条当前的颜色（从真实 DOM 算出来，不是硬编码）。 */
    getColors: () => { fill: string; track: string; text: string };
}

/** 一条模组注册的进度按钮。 */
export interface ModProgressButton {
    id: string;
    slot: ModProgressSlot;
    order: number;
    mount: (container: HTMLElement, ctx: ModProgressContext) => void | (() => void) | Promise<void | (() => void)>;
}

interface RawProgressButton {
    id?: unknown;
    slot?: unknown;
    order?: unknown;
    mount?: unknown;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 上游的两个 slot id（`progress.tsx:23`）。Shim 一般已经映射过，这里两种都认。 */
const normalizeSlot = (value: unknown): ModProgressSlot | null => {
    const text = str(value);
    if (text === 'leading' || text === 'progress.leading') return 'leading';
    if (text === 'trailing' || text === 'progress.trailing') return 'trailing';
    return null;
};

/** 一条原始条目 → `ModProgressButton`；没有 `mount` 函数的一律丢弃（上游 `validate` 同一条规则）。 */
const normalizeOne = (raw: unknown): ModProgressButton | null => {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as RawProgressButton;
    if (typeof source.mount !== 'function') return null;
    const slot = normalizeSlot(source.slot);
    if (!slot) return null;
    const id = str(source.id);
    if (!id) return null;
    const order = typeof source.order === 'number' && Number.isFinite(source.order) ? source.order : 0;
    return {
        id,
        slot,
        order,
        mount: source.mount as ModProgressButton['mount'],
    };
};

/** Shim 存这份清单的全局名。 */
export const MOD_PROGRESS_GLOBAL = '__SPW_FOLIA_MOD_PROGRESS__';

/** 把全局的两个形状（数组本身 / 带 `subscribe` 的对象或数组）解释成条目数组。 */
const readRaw = (): unknown => {
    const host = window as Window & { __SPW_FOLIA_MOD_PROGRESS__?: unknown };
    return host[MOD_PROGRESS_GLOBAL] ?? null;
};

const listOf = (raw: unknown): unknown[] => {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return [];
    for (const key of ['buttons', 'items', 'slots', 'progress', 'entries', 'list']) {
        const candidate = (raw as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return candidate;
    }
    return [];
};

/**
 * 读一次当前注册的进度按钮（**纯解析**，探针可以直接驱动）。
 *
 * 按 `slot` 分开并按 `order` 稳定排序：`order` 相同就按注册顺序（`Array.sort` 在 V8 里是稳定的）。
 */
export const readModProgressButtons = (): ModProgressButton[] => {
    const raw = readRaw();
    const out: ModProgressButton[] = [];
    const seen = new Set<string>();
    for (const item of listOf(raw)) {
        const button = normalizeOne(item);
        if (!button) continue;
        if (seen.has(button.id)) continue;
        seen.add(button.id);
        out.push(button);
    }
    out.sort((left, right) => left.order - right.order);
    return out;
};

/** 订阅那个全局的 `subscribe`（Shim 提供时）；没有就返回 no-op。 */
export const subscribeModProgress = (listener: () => void): (() => void) => {
    const raw = readRaw() as ({ subscribe?: unknown } | null);
    const subscribe = raw && typeof raw === 'object' ? raw.subscribe : null;
    if (typeof subscribe !== 'function') return () => undefined;
    try {
        const off = (subscribe as (fn: () => void) => unknown).call(raw, listener);
        return typeof off === 'function' ? off as () => void : () => undefined;
    } catch {
        return () => undefined;
    }
};

/* --------------------------------------------------------------------------------------------- */
/* ctx 的构造                                                                                     */
/* --------------------------------------------------------------------------------------------- */

/** 播放条颜色：读真实 DOM（内联/CSS 变量都算），拿不到才用兜底值。 */
const FALLBACK_COLORS = { fill: 'rgba(255, 255, 255, 0.9)', track: 'rgba(255, 255, 255, 0.28)', text: 'rgba(255, 255, 255, 0.6)' };

/**
 * 从播放条的真实节点上读三色。
 *
 * 「不要硬编码两个色值」是这条的由来：`.spw-playback-fill` / `.spw-playback-track` / `.spw-playback-time`
 * 的背景与文字色由 `app.css` 决定，而 `data-flat='true'`（透明窗口）下它们并不相同。所以这里**问 DOM**，
 * 让模组画出来的东西与条本身一致。
 */
export const readPlaybackColors = (root: HTMLElement | null): { fill: string; track: string; text: string } => {
    if (!root) return { ...FALLBACK_COLORS };
    const pick = (selector: string, property: 'backgroundColor' | 'color', fallback: string): string => {
        const node = root.querySelector(selector);
        if (!(node instanceof HTMLElement)) return fallback;
        const value = window.getComputedStyle(node)[property];
        return typeof value === 'string' && value !== '' && value !== 'rgba(0, 0, 0, 0)' ? value : fallback;
    };
    return {
        fill: pick('.spw-playback-fill', 'backgroundColor', FALLBACK_COLORS.fill),
        track: pick('.spw-playback-track', 'backgroundColor', FALLBACK_COLORS.track),
        text: pick('.spw-playback-time', 'color', FALLBACK_COLORS.text),
    };
};

export interface ModProgressContextSources {
    /** 当前播放时钟（`clockPosition()` 的输入）；可能还没收到第一条 `state`。 */
    clock: () => PlaybackClock | null;
    /** 总时长毫秒（`meta.durationMs` 与时钟的较大值）。 */
    durationMs: () => number;
    /** 跳转（毫秒）。由 PlaybackBar 转成 `seek` 控制消息。 */
    seekMs: (positionMs: number) => void;
    /** 播放条根节点（取颜色用）。 */
    root: () => HTMLElement | null;
}

/**
 * 造一个 ctx。
 *
 * `currentTime` 的**推送**用 rAF：上游的 `playbackTime` 是 motion value 的语义（`get()` 随时可读、
 * `on()` 每次变化回调），而我们从桥拿到的 `state` 是 10 Hz 的稀疏快照 —— 直接转发 `state` 会让
 * 模组画出来的进度一跳一跳。rAF 读 `clockPosition()` 的插值结果，正好是播放条自己画进度用的那条曲线。
 */
export const createModProgressContext = (sources: ModProgressContextSources): {
    ctx: ModProgressContext;
    dispose: () => void;
} => {
    const listeners = new Set<(seconds: number) => void>();
    let frame = 0;
    let lastReported = -1;

    const seconds = (): number => {
        const clock = sources.clock();
        return clock ? Math.max(0, clockPosition(clock) / 1000) : 0;
    };

    const durationSeconds = (): number => Math.max(0, sources.durationMs()) / 1000;

    const tick = (): void => {
        const value = seconds();
        // 只在真的变了才回调：模组那边往往会 setTextContent/style，60 Hz 全量写是白烧 CPU。
        if (Math.abs(value - lastReported) >= 0.05) {
            lastReported = value;
            for (const listener of listeners) {
                try {
                    listener(value);
                } catch {
                    /* 模组的回调自己炸不能影响播放条 */
                }
            }
        }
        frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);

    const on = (listener: (value: number) => void): (() => void) => {
        if (typeof listener !== 'function') return () => undefined;
        listeners.add(listener);
        // 立即补一次当前值：模组一般在 mount 里就画第一帧。
        try {
            listener(seconds());
        } catch {
            /* ignore */
        }
        return () => {
            listeners.delete(listener);
        };
    };

    const playbackTime = { get: seconds, on };

    const ctx: ModProgressContext = {
        playbackTime,
        onPlaybackTime: on,
        getDuration: durationSeconds,
        timeToRatio: (seconds_) => {
            const duration = durationSeconds();
            if (!(duration > 0) || !Number.isFinite(seconds_)) return 0;
            return Math.min(1, Math.max(0, seconds_ / duration));
        },
        seek: (seconds_) => {
            if (!Number.isFinite(seconds_)) return;
            sources.seekMs(Math.max(0, seconds_ * 1000));
        },
        getColors: () => readPlaybackColors(sources.root()),
    };

    return {
        ctx,
        dispose: () => {
            listeners.clear();
            if (frame) window.cancelAnimationFrame(frame);
            frame = 0;
        },
    };
};
