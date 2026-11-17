/* issue #23 · 市场 catalog 的取数（一次请求 + 5 分钟内存缓存 + 明确的失败态）。
 *
 * ## 为什么页面**只**取 catalog，不取 zip
 *
 * 实测（repo-report §7.2）：`/catalog.json` 带 `access-control-allow-origin: *`，而 `/downloads/*.zip`
 * 与 `/previews/*.jpg` **都没有**。所以：
 *   - catalog：页面 `fetch()` 可以拿（有 CORS）；
 *   - zip：页面**拿不到字节**（CORS 会拦 `arrayBuffer()`）⇒ 下载/校验/解包**只能由插件做**
 *     （`mods:modAction` 的 action=`install`，见 `bridge.ts`）；
 *   - preview 图：`<img src>` 可以显示（图片不受 CORS 限制，只是不能读像素）。
 *
 * ## 四态而不是两态
 *
 * `loading` / `ready` / `offline` / `empty`。**「离线」绝不能等于「没有模组」** —— 那是两种完全不同的
 * 事实，混在一起会让用户在断网时以为市场是空的（`docs/lessons.md` 对「无法判定 ≠ 失败」的同一条纪律，
 * 见 `chrome/ProblemReportPanel.tsx` 的四态判决）。`empty` 只用于「catalog 拿到了、但没有可显示的条目」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    MOD_CATALOG_URL,
    parseModCatalog,
    type ModCatalog,
} from './modCatalog';

/** 内存缓存的有效期。5 分钟与市场自己的 `cache-control: max-age=300` 一致。 */
export const CATALOG_CACHE_MS = 5 * 60 * 1000;

/** 一次请求的超时：市场是外网，卡住时不能让面板一直转圈。 */
const CATALOG_TIMEOUT_MS = 10_000;

export type CatalogStatus = 'loading' | 'ready' | 'offline' | 'empty';

export interface CatalogState {
    status: CatalogStatus;
    /** 解析成功的 catalog；`offline` / `empty` 时为 null。 */
    catalog: ModCatalog | null;
    /** 给人看的原因（离线时是网络错误摘要，永远不带 token/URL 参数）。 */
    reason: string | null;
    /** 这份数据是缓存命中的（面板据此显示「来自缓存」而不是重新请求）。 */
    fromCache: boolean;
    /**
     * 屏幕上已经有一份缓存，后台正在取新的一份。
     *
     * 与 `status` 正交：`status` 描述**手上有什么**（ready 就是有清单可画），`refreshing` 描述
     * **还在做什么**。把它们合成一个状态会退回到「缓存命中也要先转圈」——那正是要修的问题。
     */
    refreshing: boolean;
}

interface CacheEntry {
    catalog: ModCatalog;
    at: number;
}

/** 模块级缓存：**整个页面生命周期只请求一次**（除非过了 5 分钟或调用 `refresh`）。 */
let cache: CacheEntry | null = null;
/** 同一个 tick 里多个组件挂载时只发一次请求。 */
let inFlight: Promise<CatalogState> | null = null;

/* ---------------------------------------------------------------------------------------------
 * issue #23（第二轮）：磁盘缓存，让「每次打开市场都要等加载」不再发生。
 *
 * ## 为什么是 localStorage 而不是插件落盘或 Cache API
 *
 * - 页面是设置岛，由宿主注入到 **固定虚拟主机** 上
 *   （`https://spw-folia.local/<settings>/settings-ui.js`，`HostForm.cs` 的 `settings-inject`），
 *   而 WebView2 的 profile 目录是稳定的（`%LOCALAPPDATA%\spw-folia\webview`，或 `--user-data`），
 *   所以这个 origin 的 localStorage 跨进程重启存活 —— 用户关掉 Folia 再开，市场仍然是热的。
 * - 让插件落盘并把清单塞进设置树会多出**第六个注入成员**（要同步 `stripInjectedMembers`），
 *   每次推树都搬 ~97 KB，而且插件并不拥有这份数据（市场自己发 `cache-control: max-age=300`）。
 * - Cache API / IndexedDB 都对，但都是异步的：首帧仍然要等一个微任务，而这个仓库里
 *   service worker 是被主动清掉的，走 Cache API 属于给一个已经拆掉的机制重新上电。
 *
 * ## 它不是第二份「真相」
 *
 * 存的是**市场自己那份 catalog 的副本**，不是「装了哪些模组」（那只有插件知道，见
 * `docs/mod-system.md` §2 的单写者铁律）。命中缓存只是让首帧有东西可画，`mods` 仍然只来自插件。
 *
 * ## 纪律
 *
 * 读回来的字节**必须重新过一遍 `parseModCatalog`**：磁盘上的东西和网络来的一样不可信（版本升级
 * 后字段可能变、用户可能手改）。所有出入口都 `try/catch`，失败就是「没有缓存」，绝不抛 ——
 * 与 `model/previewImageCache.ts` 同一套规则。
 * ------------------------------------------------------------------------------------------- */

/** 缓存键带 schema 版本：字段形状一变就换键，旧记录自然失效（不做迁移）。 */
export const CATALOG_STORAGE_KEY = 'spw-folia.modCatalog.v1';

/** 单份缓存的上限。真实 catalog ~97 KB；这条只挡「磁盘被塞爆」的意外。 */
const CATALOG_STORAGE_MAX_CHARS = 1_500_000;

const storage = (): Storage | null => {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        // 私密模式 / 策略禁用：访问器本身就抛。
        return null;
    }
};

/**
 * 读磁盘缓存；没有、坏了、太大都返回 null（绝不抛）。
 *
 * **存的是原始响应文本，不是归一化后的 `ModCatalog`。** 第一版存了后者，读回来又交给
 * `parseModCatalog` —— 而那个函数认的是**线上格式**（`format` + `mods` 数组），归一化对象里只有
 * `entries`，于是它永远返回 null，缓存从来没命中过（实测：两次运行都是 `fromCache:false`，因为
 * 每次都当成没有缓存重新请求）。存原文既修掉这一点，也让「读回来的字节必须重新解析」这条纪律
 * 真的成立：解析器只有一份，磁盘和网络走同一条路。
 */
export const readCachedCatalog = (): { catalog: ModCatalog; at: number } | null => {
    const store = storage();
    if (!store) return null;
    let text: string | null = null;
    try {
        text = store.getItem(CATALOG_STORAGE_KEY);
    } catch {
        return null;
    }
    if (!text || text.length > CATALOG_STORAGE_MAX_CHARS) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as { at?: unknown; body?: unknown };
        if (typeof record.body !== 'string') return null;
        const catalog = parseModCatalog(record.body);
        if (!catalog) return null;
        const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
        return { catalog, at };
    } catch {
        return null;
    }
};

/** 写磁盘缓存；写不进去就静默放弃（配额/私密模式不是错误，只是没有缓存）。 */
export const writeCachedCatalog = (body: string): void => {
    const store = storage();
    if (!store) return;
    try {
        const text = JSON.stringify({ at: Date.now(), body });
        if (text.length > CATALOG_STORAGE_MAX_CHARS) return;
        store.setItem(CATALOG_STORAGE_KEY, text);
    } catch {
        /* 配额满 / 被禁用：没有缓存可用而已 */
    }
};

/** 只给探针/单测用：清掉内存与磁盘缓存。 */
export const resetCatalogCache = (): void => {
    cache = null;
    inFlight = null;
    try {
        storage()?.removeItem(CATALOG_STORAGE_KEY);
    } catch {
        /* ignore */
    }
};

/** 把 fetch/解析的失败原因压成一句人话（不泄露 URL 参数，也不把整个对象塞进 UI）。 */
const describeFailure = (error: unknown): string => {
    if (error instanceof Error) {
        if (error.name === 'AbortError') return '请求超时';
        const message = error.message.trim();
        return message === '' ? error.name : message.slice(0, 160);
    }
    return '网络请求失败';
};

const OFFLINE: CatalogState = { status: 'offline', catalog: null, reason: '离线', fromCache: false, refreshing: false };

/**
 * 拉一次 catalog。四个结果都**不抛**：
 *   - 网络/HTTP 错误 → `offline` + 原因；
 *   - JSON 不合法 / `format` 不对 / `mods` 不是数组 → `offline` + 「响应格式不认识」；
 *   - 解析成功但没有条目 → `empty`；
 *   - 否则 `ready`。
 */
const loadCatalog = async (): Promise<CatalogState> => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), CATALOG_TIMEOUT_MS);
    try {
        const response = await fetch(MOD_CATALOG_URL, {
            method: 'GET',
            // 市场自己发 `cache-control: max-age=300`，这里显式 default 让浏览器缓存也参与；
            // 内存缓存另外算一层（见文件头），两者不冲突。
            cache: 'default',
            credentials: 'omit',
            signal: abort.signal,
        });
        if (!response.ok) {
            return { status: 'offline', catalog: null, reason: `HTTP ${response.status}`, fromCache: false, refreshing: false };
        }
        const text = await response.text();
        const catalog = parseModCatalog(text);
        if (!catalog) {
            return { status: 'offline', catalog: null, reason: '响应格式不认识', fromCache: false, refreshing: false };
        }
        cache = { catalog, at: Date.now() };
        // 顺手落到磁盘：下次打开市场时首帧就有卡片（见文件头的缓存一节）。
        // 存的是**原始响应文本**，不是 `catalog` —— 读回来要重新过同一个解析器。
        writeCachedCatalog(text);
        if (catalog.entries.length === 0) {
            return { status: 'empty', catalog, reason: null, fromCache: false, refreshing: false };
        }
        return { status: 'ready', catalog, reason: null, fromCache: false, refreshing: false };
    } catch (error) {
        return { status: 'offline', catalog: null, reason: describeFailure(error), fromCache: false, refreshing: false };
    } finally {
        window.clearTimeout(timer);
    }
};

/** 取 catalog（带缓存与去重）。`force` 忽略缓存（面板的「重试」按钮用）。 */
export const fetchModCatalog = (force = false): Promise<CatalogState> => {
    if (!force && cache && Date.now() - cache.at < CATALOG_CACHE_MS) {
        const catalog = cache.catalog;
        return Promise.resolve({
            status: catalog.entries.length === 0 ? 'empty' : 'ready',
            catalog,
            reason: null,
            fromCache: true,
            refreshing: false,
        });
    }
    if (inFlight) return inFlight;
    inFlight = loadCatalog().finally(() => {
        inFlight = null;
    });
    return inFlight;
};

/**
 * 面板用的 hook。`open` 变为 true 时才请求（市场没打开就**不发任何网络请求** —— 打包后的页面
 * 平时仍然完全离线，见 `docs/release.md` §8）。
 *
 * ## 首帧先给磁盘缓存，再后台取新的（issue #23 第二轮）
 *
 * 用户的抱怨是「每次打开都要等待加载」。修法不是把网络请求去掉（清单会过期），而是让**首帧不等
 * 网络**：`useState` 的初始化函数直接读 localStorage，于是第一次渲染就已经有卡片；随后那次请求
 * 只是刷新，结果回来时若 `commit` 没变就只清掉 `refreshing`，卡片不会闪。
 *
 * 离线时因此变成一个**更诚实**的状态：有缓存 → 卡片照画 + 徽标「缓存」；无缓存 → 才显示离线。
 */
export const useModCatalog = (open: boolean): CatalogState & { refresh: () => void } => {
    const [state, setState] = useState<CatalogState>(fromDiskOrLoading);
    const alive = useRef(true);
    const requested = useRef(false);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const run = useCallback((force: boolean) => {
        setState(current => (current.catalog
            // 已经有东西可画：保持现状，只标记「正在更新」，绝不清空。
            ? { ...current, reason: null, refreshing: true }
            : { status: 'loading', catalog: null, reason: null, fromCache: false, refreshing: true }));
        void fetchModCatalog(force).then(next => {
            if (!alive.current) return;
            setState(current => mergeRefresh(current, next));
        });
    }, []);

    useEffect(() => {
        if (!open) return;
        // 已经请求过一次且仍在缓存期内：不要因为面板重开就再打一次。
        if (requested.current && !cacheExpired()) return;
        requested.current = true;
        run(false);
    }, [open, run]);

    const refresh = useCallback(() => {
        requested.current = true;
        run(true);
    }, [run]);

    return { ...state, refresh };
};

/** 首次渲染的状态：磁盘上有缓存就直接 `ready`（+ 标记后台会刷新），否则照旧的 `loading`。 */
const fromDiskOrLoading = (): CatalogState => {
    const disk = readCachedCatalog();
    if (!disk) return { status: 'loading', catalog: null, reason: null, fromCache: false, refreshing: false };
    // 顺手把磁盘那份填进内存缓存，`fetchModCatalog` 的 5 分钟窗口才知道它的时间戳。
    cache = { catalog: disk.catalog, at: disk.at };
    return {
        status: disk.catalog.entries.length === 0 ? 'empty' : 'ready',
        catalog: disk.catalog,
        reason: null,
        fromCache: true,
        // 打开就要再确认一次：缓存只负责首帧，不负责「永远不联网」。
        refreshing: true,
    };
};

/**
 * 一次刷新结果与当前状态的合并规则。
 *
 * 关键一条：**已经画出来的清单不能因为一次失败而消失**。用户在断网时打开市场，看到的应该是
 * 「缓存 + 离线提示」，而不是上一次明明能用的清单突然变空 —— 后者是「无法判定 ≠ 失败」那条纪律
 * 的反面（`docs/lessons.md`）。所以 `offline` 只在手上什么都没有时才成为状态；有缓存时它只是
 * `reason`，`status` 仍是 `ready`。
 */
const mergeRefresh = (current: CatalogState, next: CatalogState): CatalogState => {
    if (next.status === 'ready' || next.status === 'empty') {
        // 拿到了新数据：`fromCache` 只在 commit 未变时保留（否则徽标会谎报「缓存」）。
        const unchanged = current.catalog !== null
            && current.catalog.commit !== null
            && next.catalog !== null
            && current.catalog.commit === next.catalog.commit;
        return { ...next, fromCache: unchanged && current.fromCache, refreshing: false };
    }
    // 失败（offline）：手上有缓存就保留它，只记原因。
    if (current.catalog) {
        return { ...current, reason: next.reason, refreshing: false };
    }
    return next;
};

const cacheExpired = (): boolean => !cache || Date.now() - cache.at >= CATALOG_CACHE_MS;

export { OFFLINE };
