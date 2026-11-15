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
}

interface CacheEntry {
    catalog: ModCatalog;
    at: number;
}

/** 模块级缓存：**整个页面生命周期只请求一次**（除非过了 5 分钟或调用 `refresh`）。 */
let cache: CacheEntry | null = null;
/** 同一个 tick 里多个组件挂载时只发一次请求。 */
let inFlight: Promise<CatalogState> | null = null;

/** 只给探针/单测用：清掉缓存。 */
export const resetCatalogCache = (): void => {
    cache = null;
    inFlight = null;
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

const OFFLINE: CatalogState = { status: 'offline', catalog: null, reason: '离线', fromCache: false };

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
            return { status: 'offline', catalog: null, reason: `HTTP ${response.status}`, fromCache: false };
        }
        const text = await response.text();
        const catalog = parseModCatalog(text);
        if (!catalog) {
            return { status: 'offline', catalog: null, reason: '响应格式不认识', fromCache: false };
        }
        cache = { catalog, at: Date.now() };
        if (catalog.entries.length === 0) {
            return { status: 'empty', catalog, reason: null, fromCache: false };
        }
        return { status: 'ready', catalog, reason: null, fromCache: false };
    } catch (error) {
        return { status: 'offline', catalog: null, reason: describeFailure(error), fromCache: false };
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
 */
export const useModCatalog = (open: boolean): CatalogState & { refresh: () => void } => {
    const [state, setState] = useState<CatalogState>({ status: 'loading', catalog: null, reason: null, fromCache: false });
    const alive = useRef(true);
    const requested = useRef(false);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const run = useCallback((force: boolean) => {
        setState(current => (current.catalog ? { ...current, reason: null } : { status: 'loading', catalog: null, reason: null, fromCache: false }));
        void fetchModCatalog(force).then(next => {
            if (!alive.current) return;
            setState(next);
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

const cacheExpired = (): boolean => !cache || Date.now() - cache.at >= CATALOG_CACHE_MS;

export { OFFLINE };
