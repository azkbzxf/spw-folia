/* issue #23 · 「已装模组清单」的只读订阅，以及货架用的模组样式清单。
 *
 * ## 谁是真相源
 *
 * 模组文件夹、装了哪些、启用与否 —— **只有插件（Kotlin）知道**（它是唯一有文件系统的一方；WebView2
 * 页面只有虚拟主机）。所以清单和 `systemFonts` 完全同构：作为**设置树顶层注入成员** `mods` 下发，
 * 页面只读、只发动作请求，从不自己改本地清单（单写者，见 `docs/lessons.md:154-157` 与
 * `useInjectedSwitch.ts` 文件头那两段判据）。
 *
 * 结果回流：插件执行完装/卸/启停后**重新推一次设置树**（含新的 `mods`），页面靠 `settings` 事件
 * 自动跟上。页面**不维护第二份清单真相**，因此这里没有任何 setter。
 *
 * ## 为什么照 `useInjectedSwitch.ts` 的读取顺序
 *
 * 先挂监听、再读 `getSettings()` 快照：两次读之间到达的那条事件不会丢（`useInjectedSwitch.ts:112-120`
 * 的注释解释了竞态）。`mods` 是数组而不是布尔，所以不能复用 `useInjectedSwitch`（它只认
 * `=== true` / `=== false`），但读取顺序与「不带该键的 payload 不改变已有值」这两条语义逐字照抄。
 *
 * ## 货架的两份输入
 *
 * 货架上的模组格需要两样东西：① 哪些模组**已装且启用**（= 注入成员 `mods`）；② 这些模组注册了
 * **哪些 visualizer**（= Shim 激活模组后维护的 `window.__SPW_FOLIA_MOD_VISUALIZERS__`）。
 * ① 走桥；② 只能走 window 全局（上游 registry 实例活在播放页 bundle 里，设置岛是独立 bundle，
 * 读不到它）。两路都刷新时才重算 `useModStyles()`。
 */
import { useEffect, useState } from 'react';
import { bridgeOn, getBridge } from '~/bridge';
import {
    normalizeModStyles,
    type ModStyleEntry,
} from './modStyles';

/** 插件下发的注入成员名（与 `FoliaPlugin` 的 `MODS_KEY` 同一拼写）。 */
export const MODS_KEY = 'mods';

/** 一条已装模组。字段名与插件侧 `InstalledMod` 的 JSON 一致。 */
export interface InjectedMod {
    id: string;
    name: string;
    version: string;
    author: string;
    permissions: string[];
    /** 缺省算启用：插件第一次装完就该立刻可用（PLAN.md §1）。 */
    enabled: boolean;
    /** 相对模组目录的入口文件名（`client.mjs`），没有客户端入口时为 null。 */
    clientEntry: string | null;
    /** 相对模组目录的预览图文件名（`preview.jpg`），没有时为 null。 */
    previewEntry: string | null;
    /** 扫描/激活失败的说明；非空时市场页把这张卡标成「有问题」。 */
    error: string | null;
}

type SettingsObject = Record<string, unknown>;

/** `getSettings()` 正常给对象，但宿主 shim 各版本也可能塞 JSON 字符串；两种都吃。 */
const parseSettingsPayload = (payload: unknown): SettingsObject | null => {
    if (!payload) return null;
    if (typeof payload === 'string') {
        const text = payload.trim();
        if (!text.startsWith('{')) return null;
        try {
            const parsed: unknown = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? (parsed as SettingsObject) : null;
        } catch {
            return null;
        }
    }
    return typeof payload === 'object' ? (payload as SettingsObject) : null;
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const strOrNull = (value: unknown): string | null => {
    const text = str(value);
    return text === '' ? null : text;
};

/** 一条原始条目 → `InjectedMod`；没有 `id` 的条目丢弃（没有 id 就无法对它发任何动作）。 */
const normalizeOne = (raw: unknown): InjectedMod | null => {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const id = str(source.id);
    if (!id) return null;
    const permissions = Array.isArray(source.permissions)
        ? source.permissions.filter((item): item is string => typeof item === 'string')
        : [];
    return {
        id,
        name: str(source.name) || id,
        version: str(source.version),
        author: str(source.author),
        permissions,
        enabled: source.enabled !== false,
        clientEntry: strOrNull(source.clientEntry),
        previewEntry: strOrNull(source.previewEntry),
        error: strOrNull(source.error),
    };
};

/**
 * 从一份 `settings` payload 里抽出 `mods` 数组。
 *
 * 返回 `null` 表示**这份 payload 没带这个键** —— 调用方必须保留手上已有的值，不能当成「模组全没了」。
 * 页面自己发出的设置回显（`setSettings` 的浅合并结果）里没有 `mods`，那不是「用户把它们卸光了」的意思。
 */
export const extractInjectedMods = (payload: unknown): InjectedMod[] | null => {
    const source = parseSettingsPayload(payload);
    if (!source) return null;
    // 顶层 `mods`，以及（容错）快照里再嵌一层的 `settings.mods`。
    const candidates: unknown[] = [source[MODS_KEY]];
    const nested = parseSettingsPayload(source.settings);
    if (nested && nested !== source) candidates.push(nested[MODS_KEY]);
    for (const candidate of candidates) {
        if (candidate === undefined) continue;
        if (!Array.isArray(candidate)) return [];   // 带了键但不是数组：明确当作空清单
        return candidate
            .map(normalizeOne)
            .filter((item): item is InjectedMod => item !== null);
    }
    return null;
};

/** 直接从桥里读一次；桥不在（dev）或读失败都返回空清单，绝不抛。 */
export const readInjectedModsFromBridge = (): InjectedMod[] => {
    try {
        return extractInjectedMods(getBridge()?.getSettings?.()) ?? [];
    } catch {
        return [];
    }
};

/**
 * 订阅式读取已装模组清单。一次初始快照 + 之后每次 `settings` 事件（不轮询）。
 *
 * 这是页面知道的**唯一**清单真相；市场页与货架都从这里取，绝不各读一份。
 */
export const useInjectedMods = (): InjectedMod[] => {
    const [value, setValue] = useState<InjectedMod[]>(readInjectedModsFromBridge);

    useEffect(() => {
        let alive = true;
        const apply = (payload: unknown): void => {
            if (!alive) return;
            const next = extractInjectedMods(payload);
            if (next === null) return;              // 不带该键：保留当前值
            setValue(next);
        };

        // 先挂监听再读快照：两次读之间到达的那一条事件不会丢。
        const offSettings = bridgeOn<unknown>('settings', apply);
        /* Shim 激活完模组会 `emitLocal('modsReady')`：它不携带清单（清单走 settings），只当刷新信号用
         * —— 因为「哪些 visualizer 注册上了」是在激活之后才确定的，而激活不会带来新的 settings。 */
        const offReady = bridgeOn<unknown>('modsReady', () => {
            if (alive) setValue(current => [...current]);
        });
        apply(readInjectedModsFromBridgeSafe());

        return () => {
            alive = false;
            offSettings();
            offReady();
        };
    }, []);

    return value;
};

const readInjectedModsFromBridgeSafe = (): unknown => {
    try {
        return getBridge()?.getSettings?.() ?? null;
    } catch {
        return null;
    }
};

/* --------------------------------------------------------------------------------------------- */
/* 模组注册的 visualizer 清单（window 全局，由 Shim 维护）                                        */
/* --------------------------------------------------------------------------------------------- */

/** Shim 存这份清单的全局名（`PLAN.md` §5 / HOST-REPORT）。 */
export const MOD_VISUALIZERS_GLOBAL = '__SPW_FOLIA_MOD_VISUALIZERS__';
/** Shim 的总入口（清单/错误/visualizers 都可能挂在这里）。 */
export const MODS_GLOBAL = '__SPW_FOLIA_MODS__';

interface ListHost {
    /** 数组本身可能挂了订阅函数（`subscribe(fn)` 返回 dispose）。 */
    subscribe?: (listener: () => void) => () => void;
}

type ModGlobalWindow = Window & {
    __SPW_FOLIA_MOD_VISUALIZERS__?: unknown;
    __SPW_FOLIA_MODS__?: unknown;
};

/**
 * 把「一个全局」解释成一份数组。
 *
 * 宽容两种形状（谁先落地都能跑，不用改这边）：数组本身，或对象里挂
 * `visualizers|items|slots|buttons|entries|list` 之一。**认不出就是空清单** —— 绝不从别处猜。
 * `subscribe` 由 `subscribeModVisualizers` 单独处理（它要拿到那个对象本身当 receiver）。
 */
const readListHost = (raw: unknown): { list: unknown[] } => {
    if (Array.isArray(raw)) return { list: raw };
    if (!raw || typeof raw !== 'object') return { list: [] };
    for (const key of ['visualizers', 'items', 'slots', 'buttons', 'entries', 'list']) {
        const candidate = (raw as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return { list: candidate };
    }
    return { list: [] };
};

/** 读一次当前的模组 visualizer 原始清单（未归一）。 */
const readRawModVisualizers = (): unknown[] => {
    const host = window as ModGlobalWindow;
    const direct = readListHost(host[MOD_VISUALIZERS_GLOBAL]);
    if (direct.list.length > 0) return direct.list;
    const bag = host[MODS_GLOBAL];
    if (bag && typeof bag === 'object') {
        return readListHost(bag).list;
    }
    return [];
};

/** 订阅那个全局的 `subscribe`（若 Shim 提供了）；没有就返回 no-op。 */
const subscribeModVisualizers = (listener: () => void): (() => void) => {
    const host = window as ModGlobalWindow;
    const candidates: unknown[] = [host[MOD_VISUALIZERS_GLOBAL], host[MODS_GLOBAL]];
    const offs: Array<() => void> = [];
    for (const candidate of candidates) {
        const subscribe = (candidate as ListHost | undefined)?.subscribe;
        if (typeof subscribe !== 'function') continue;
        try {
            const off = subscribe.call(candidate, listener);
            if (typeof off === 'function') offs.push(off);
        } catch {
            /* 订阅失败不影响读取本身 */
        }
    }
    return () => {
        for (const off of offs) {
            try {
                off();
            } catch {
                /* ignore */
            }
        }
    };
};

/**
 * 货架用的模组样式清单：`mods`（清单/启用状态）× 模组注册的 visualizer。
 *
 * 任一输入变化都重算；两个输入都没到位时是空数组，货架因此**不出现**模组格（而不是出现一格画不
 * 出来的东西）。`modVisualizersEpoch` 是「全局那份数组变了」的代理值：`subscribe` 可用时靠它，
 * 否则靠 `modsReady` 桥事件（见 `useInjectedMods`）。
 */
export const useModStyles = (mods: InjectedMod[]): ModStyleEntry[] => {
    const [rawVisualizers, setRawVisualizers] = useState<unknown[]>(readRawModVisualizers);
    const [epoch, setEpoch] = useState(0);

    useEffect(() => {
        let alive = true;
        const refresh = (): void => {
            if (!alive) return;
            setRawVisualizers(readRawModVisualizers());
            setEpoch(current => current + 1);
        };
        const offGlobal = subscribeModVisualizers(refresh);
        // 没有 subscribe 的兜底：Shim 激活/停用后一定会发 modsReady；另外定时器只做一次轻量重读，
        // 覆盖「激活比监听晚」的那一小段窗口（250ms 一次，页面关掉就停）。
        const offReady = bridgeOn<unknown>('modsReady', refresh);
        const timer = window.setInterval(refresh, 250);
        refresh();
        // 只跑 10 秒：避免长期轮询（清单稳定后由 settings/modsReady 驱动）。
        const stop = window.setTimeout(() => window.clearInterval(timer), 10_000);
        return () => {
            alive = false;
            offGlobal();
            offReady();
            window.clearInterval(timer);
            window.clearTimeout(stop);
        };
    }, []);

    // `epoch` 只是「重新算」的触发器：结果完全由两个输入决定，所以直接在这里算，不缓存。
    void epoch;
    return normalizeModStyles(rawVisualizers, mods);
};

export default useInjectedMods;
