/* issue #23 · 播放条上的模组 slot 容器（React 侧）。
 *
 * 只做三件事：读注册表 → 为每个 `{id,slot}` 建一个空 `div` → 把模组的 `mount` 挂进去并管好卸载。
 *
 * ## 为什么挂载是命令式的
 *
 * 上游契约就是命令式的（`FoliumMount<Ctx> = (container, ctx) => void | FoliumDisposer | Promise<...>`，
 * `contract.ts:538`）：模组要自己画，React 不参与它内部的 DOM。所以这里只保证「容器在 React 树里、
 * 生命周期与播放条一致」，其余交给模组。
 *
 * ## 卸载顺序（照上游 `FoliumMountHost.tsx:92-96`）
 *
 * 先跑 disposer，再摘容器。mount 返回 Promise 时要**等它 resolve** 才拿得到 disposer —— 一个已经
 * 被摘掉的容器 + 一个还在跑的 rAF，是这类插件最典型的泄漏形态。
 *
 * ## 隔离
 *
 * 模组是第三方代码：它的 `mount` 抛错、返回垃圾、或者 Promise reject，都**只能让那一个按钮消失**，
 * 绝不能影响播放条本身（更不能让 React 的渲染抛出去）。所以每次调用都包 try/catch + `.catch()`。
 */
import React, { useEffect, useRef } from 'react';
import { bridgeOn } from '~/bridge';
import {
    createModProgressContext,
    readModProgressButtons,
    subscribeModProgress,
    type ModProgressButton,
    type ModProgressSlot,
} from './modProgress';
import type { PlaybackClock } from './playbackClock';

export interface ModSlotProps {
    slot: ModProgressSlot;
    /** 播放条根节点（取颜色、也用来判断是否还挂着）。 */
    rootRef: React.RefObject<HTMLDivElement | null>;
    /** 当前时钟（`createModProgressContext` 每帧读它）。 */
    clockRef: React.RefObject<PlaybackClock | null>;
    durationMs: number;
    /** 跳转（毫秒）。 */
    onSeekMs: (positionMs: number) => void;
}

/** 一个按钮的宿主：一个空 div，把 mount 挂进去。 */
const ModMount: React.FC<{
    button: ModProgressButton;
    rootRef: React.RefObject<HTMLDivElement | null>;
    clockRef: React.RefObject<PlaybackClock | null>;
    durationMs: number;
    onSeekMs: (positionMs: number) => void;
    onFailed: (id: string) => void;
}> = ({ button, rootRef, clockRef, durationMs, onSeekMs, onFailed }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    /** 最新的 durationMs / seek 回调，供 ctx 的闭包读（避免因为一次时长变化重挂模组）。 */
    const durationRef = useRef(durationMs);
    const seekRef = useRef(onSeekMs);
    durationRef.current = durationMs;
    seekRef.current = onSeekMs;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return undefined;
        const { ctx, dispose } = createModProgressContext({
            clock: () => clockRef.current,
            durationMs: () => durationRef.current,
            seekMs: positionMs => seekRef.current(positionMs),
            root: () => rootRef.current,
        });

        let cancelled = false;
        /** mount 的返回值（可能来自 Promise）；null = 还没有。 */
        let disposer: (() => void) | null = null;
        let sawSync = false;

        const runDisposer = (): void => {
            const fn = disposer;
            disposer = null;
            if (typeof fn !== 'function') return;
            try {
                fn();
            } catch (error) {
                console.warn('[spw-folia] mod progress disposer failed', button.id, error);
            }
        };

        try {
            const result = button.mount(container, ctx);
            if (typeof result === 'function') {
                sawSync = true;
                disposer = result;
            } else if (result && typeof (result as Promise<unknown>).then === 'function') {
                // 异步 mount：容器可能已经卸载了，所以 resolve 时要看 cancelled。
                void (result as Promise<void | (() => void)>).then(returned => {
                    if (typeof returned !== 'function') return;
                    if (cancelled) {
                        // 卸载已经发生过：立刻跑掉它，别让它在空气里活着。
                        try {
                            returned();
                        } catch {
                            /* ignore */
                        }
                        return;
                    }
                    disposer = returned;
                }).catch(error => {
                    console.warn('[spw-folia] mod progress mount rejected', button.id, error);
                    onFailed(button.id);
                });
            }
        } catch (error) {
            console.warn('[spw-folia] mod progress mount threw', button.id, error);
            onFailed(button.id);
        }
        void sawSync;

        return () => {
            cancelled = true;
            // 先跑 disposer（模组自己的清理），再让 React 摘掉容器。
            runDisposer();
            dispose();
        };
    }, [button, clockRef, rootRef, onFailed]);

    return (
        <div
            ref={containerRef}
            className="spw-playback-mod"
            data-spw-mod-slot-button={button.id}
            /* 点击不往上传给播放条的 hover/展开机制，也不触发画面上的点击分区
             * （上游同一条解法：`progress.tsx:106` 的 `keepClickInside`）。 */
            onMouseDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            onPointerDown={event => event.stopPropagation()}
        />
    );
};

/**
 * 一个 slot 的全部模组按钮。注册表为空时**什么都不渲染**（没有多余节点、不影响播放条的布局与
 * `verify-click-zones.mjs` 数的那些 class）。
 */
const ModSlot: React.FC<ModSlotProps> = ({ slot, rootRef, clockRef, durationMs, onSeekMs }) => {
    const [buttons, setButtons] = React.useState<ModProgressButton[]>(() => readModProgressButtons().filter(item => item.slot === slot));
    const [failed, setFailed] = React.useState<ReadonlySet<string>>(() => new Set());

    useEffect(() => {
        let alive = true;
        const refresh = (): void => {
            if (!alive) return;
            const next = readModProgressButtons().filter(item => item.slot === slot);
            setButtons(current => {
                // 同一个 id 集合就别换引用：换引用会让每个 mount 重跑一遍（等于把模组重挂一次）。
                if (current.length === next.length && current.every((item, index) => item.id === next[index].id && item.mount === next[index].mount)) {
                    return current;
                }
                return next;
            });
        };
        const off = subscribeModProgress(refresh);
        /* v0.5.3: 也要订阅 `modsReady` 桥事件。
         *
         * 只订阅全局数组的 `subscribe` 是不够的：那个 `subscribe` 由 Shim 的 `makeSubscribable` 挂在
         * 数组上，**数组被整体替换时**（`refreshModVisualizers` / `publishGlobal` 都会新建一个）订阅者
         * 会被带到新数组上，但**激活过程中**的「按钮已经注册了」这一拍不一定有人通知到设置岛 —— 设置岛
         * 是独立 bundle，激活发生在播放页那一侧。
         *
         * 实测症状：`__SPW_FOLIA_MOD_PROGRESS__` 里明明有一条 `{slot:'trailing', mount:function}`，
         * 播放条上却一个 slot 都没有（`[data-spw-mod-slot]` 数 = 0），因为 ModSlot 只在挂载时读了一次、
         * 之后 10 秒轮询窗口内没等到，而激活恰好发生在窗口关闭之后。`modsReady` 是 Shim 收敛完所有
         * 激活后必发的那一条，是这里唯一可靠的「现在可以读了」信号。 */
        const offReady = bridgeOn<unknown>('modsReady', refresh);
        refresh();
        const timer = window.setInterval(refresh, 250);
        const stop = window.setTimeout(() => window.clearInterval(timer), 10_000);
        return () => {
            alive = false;
            off();
            offReady();
            window.clearInterval(timer);
            window.clearTimeout(stop);
        };
    }, [slot]);

    const onFailed = React.useCallback((id: string) => {
        setFailed(current => {
            if (current.has(id)) return current;
            const next = new Set(current);
            next.add(id);
            return next;
        });
    }, []);

    const visible = buttons.filter(button => !failed.has(button.id));
    /* 诊断锚点：**永远**渲染一个空 span，把「读到了几条 / 为什么没画」写进属性。
     *
     * 这条是为 v0.5.3 加的，起因是一个只在一半链路上复现的 bug：`__SPW_FOLIA_MOD_PROGRESS__` 里明明
     * 有一条 `{slot:'trailing', mount:function}`（探针读得到），播放条上却一个 slot 都没有
     * （`[data-spw-mod-slot]` 数 = 0）。返回 `null` 时页面上什么都不留，于是「没读到」和「读到了但被
     * 过滤掉」在外部看起来完全一样 —— 那正是这类问题最难查的地方。
     *
     * 属性里不写函数或大对象，只写数字和 id，所以对 DOM 体积没有影响；`verify-click-zones` 数的是
     * `.spw-playback-*` 那些 class，这个空 span 不会被它当成控件。 */
    if (visible.length === 0) {
        return (
            <span
                className="spw-playback-mod-slot"
                data-spw-mod-slot={slot}
                data-spw-mod-slot-count="0"
                data-spw-mod-slot-seen={buttons.length}
                data-spw-mod-slot-failed={failed.size}
            />
        );
    }

    return (
        <span className="spw-playback-mod-slot" data-spw-mod-slot={slot} data-spw-mod-slot-count={visible.length}>
            {visible.map(button => (
                <ModMount
                    key={button.id}
                    button={button}
                    rootRef={rootRef}
                    clockRef={clockRef}
                    durationMs={durationMs}
                    onSeekMs={onSeekMs}
                    onFailed={onFailed}
                />
            ))}
        </span>
    );
};

export default ModSlot;
