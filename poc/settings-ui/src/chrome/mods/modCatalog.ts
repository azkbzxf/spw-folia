/* issue #23 · folium 市场 catalog 的解析（**纯函数**，门禁可以直接驱动）。
 *
 * ## 为什么是纯函数
 *
 * `scripts/**` 与探针只能 eval 字符串/跑 node，不能渲染 React。把「HTTP 响应 → 归一的条目数组」
 * 全部收在这里，门禁就能在**没有 WebView2、没有网络**的条件下断言：坏 JSON 不炸、缺 sha256 的条目
 * 不带安装按钮、相对路径被拼成绝对地址。市场页只负责渲染与动作。
 *
 * ## 实测事实（`.scratch/issue23/repo-report.md` §7.1-7.2，2026-11-15 本机 node fetch）
 *
 * - `GET https://folium-compound.cielaniska.top/catalog.json` → 200，**`access-control-allow-origin: *`**，
 *   59 条 mods。**页面可以直接 fetch 这个文件**。
 * - `download.url` / `preview.url` 都是**站内相对路径**（例：`/downloads/xxx.zip`），必须用 catalog
 *   的 URL 作 base 拼绝对地址。
 * - `/downloads/*.zip` 与 `/previews/*.jpg` **没有** `access-control-allow-origin`
 *   ⇒ **页面绝不能 fetch 模组 zip**（CORS 会拦 `arrayBuffer()`）；下载只能由插件做。
 *   `<img src>` 不受这条限制（图片能显示，只是不能读像素），所以 preview 图直接给绝对 URL 即可。
 *
 * ## 该信任什么、不该信任什么
 *
 * catalog 是**外部数据**：它可能缺字段、类型不对、`mods` 不是数组、甚至整个响应是 HTML（CDN 错误页）。
 * 这里逐条判、认不出就丢掉那一条并计数，绝不让一条坏数据打断整页渲染 —— 但也**绝不猜**：缺失的字段
 * 就是 `null`，缺 `download.sha256` 的条目 `canInstall` 为 false（我们要求校验，宁可不给按钮）。
 */

/**
 * 市场基址 —— **全仓唯一的拼写处**。
 *
 * 只在这里出现是为了两件事：
 *  1. `stage-web.mjs` 的审计（「市场地址只有一个源」）能从产物里反查这个 host；
 *  2. 将来换域名/加镜像只改一行。
 * 页面里任何其它地方都**不要**再写这个 host（用 `MOD_CATALOG_URL`）。
 */
export const MOD_MARKET_BASE = 'https://folium-compound.cielaniska.top';

/** catalog 的绝对地址（由 `MOD_MARKET_BASE` 派生，不要再写字面量）。 */
export const MOD_CATALOG_URL = `${MOD_MARKET_BASE}/catalog.json`;

/** catalog 的 `format` 标记：不是这个值就当整份响应无效。 */
export const MOD_CATALOG_FORMAT = 'folium-market-catalog';

/** 三个分组，顺序即页面上的分组顺序（官方优先）。 */
export const MOD_ORIGINS = ['official', 'community', 'beta'] as const;
export type ModOrigin = (typeof MOD_ORIGINS)[number];

export const isModOrigin = (value: unknown): value is ModOrigin =>
    typeof value === 'string' && (MOD_ORIGINS as readonly string[]).includes(value);

/** 一条归一的 catalog 条目。**所有**可缺字段都是 `null`，不用 `undefined`（渲染层只要判 null）。 */
export interface ModCatalogEntry {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    origin: ModOrigin;
    permissions: string[];
    /** 需求的 Folia 版本范围（catalog 的 `folia`，形如 `>=0.7.22`）；null = 没有要求。 */
    foliaRange: string | null;
    /** 绝对下载地址（站内相对路径已按 catalog URL 展开）；null = catalog 没给。 */
    downloadUrl: string | null;
    /** 期望的 SHA-256（十六进制小写）；null = 没给 ⇒ **不显示安装按钮**（我们要求校验）。 */
    downloadSha256: string | null;
    /** 下载文件名（插件的临时文件名用它）。 */
    downloadFileName: string | null;
    /** 包大小（字节）；null = 没给。 */
    downloadSize: number | null;
    /** 绝对 preview 图地址（`<img src>` 直接能用；图片不受 CORS 限制）。 */
    previewUrl: string | null;
    /** 能不能显示「安装」：只有**校验信息齐全**（url + sha256 + fileName）才可以。 */
    canInstall: boolean;
    /** 附加诊断，供卡片上的小字用（`channel` / `experimental` / `hasClient`）。 */
    channel: string | null;
    hasClient: boolean;
    experimental: string[];
}

export interface ModCatalog {
    /** catalog 自己声明的版本（不是协议版本）；认不出是 0。 */
    version: number;
    /** 仓库/提交（诊断用）；认不出是 null。 */
    repository: string | null;
    commit: string | null;
    entries: ModCatalogEntry[];
    /** 解析时被丢弃的条目数（缺 id/name，或不是对象），供「部分失败」提示用。 */
    dropped: number;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const strOrNull = (value: unknown): string | null => {
    const text = str(value);
    return text === '' ? null : text;
};
const numOrNull = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

/** SHA-256 只看形状：64 个十六进制字符。形状不对就当没给（它唯一用途是被插件拿去比对）。 */
const normalizedSha256 = (value: unknown): string | null => {
    const text = str(value).toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
};

/**
 * 把 catalog 里的站内相对路径拼成绝对地址。
 *
 * - 已经是绝对 URL（`http://` / `https://` / `data:`）就原样返回（将来的 CDN 变体不用改这里）；
 * - 以 `/` 开头的站内绝对路径用 base 的 origin；
 * - 其它相对路径按 base 目录解析（`new URL(relative, base)`）；
 * - 拼不出来（空串、非法）返回 null —— **绝不编一个地址出来**。
 */
export const absoluteCatalogUrl = (raw: unknown, base: string = MOD_CATALOG_URL): string | null => {
    const text = str(raw);
    if (text === '') return null;
    if (/^(?:https?:|data:)/i.test(text)) {
        try {
            return new URL(text).toString();
        } catch {
            return null;
        }
    }
    try {
        return new URL(text, base).toString();
    } catch {
        return null;
    }
};

/** 一条原始条目 → `ModCatalogEntry`；没有 `id` 或 `name` 的条目无法展示/安装，返回 null。 */
const normalizeEntry = (raw: unknown, base: string): ModCatalogEntry | null => {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const id = str(source.id);
    if (!id) return null;
    const name = str(source.name) || id;

    const permissions = Array.isArray(source.permissions)
        ? source.permissions.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : [];
    const experimental = Array.isArray(source.experimental)
        ? source.experimental.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : [];

    const download = (source.download && typeof source.download === 'object')
        ? source.download as Record<string, unknown>
        : {};
    const preview = (source.preview && typeof source.preview === 'object')
        ? source.preview as Record<string, unknown>
        : {};

    const downloadUrl = absoluteCatalogUrl(download.url, base);
    const downloadSha256 = normalizedSha256(download.sha256);
    const downloadFileName = strOrNull(download.fileName);

    return {
        id,
        name,
        version: str(source.version),
        author: str(source.author),
        description: str(source.description),
        // 认不得的 origin 归到 community：分组里总得有一条（官方/贝塔是「更好的」分组，不能乱塞）。
        origin: isModOrigin(source.origin) ? source.origin : 'community',
        permissions,
        foliaRange: strOrNull(source.folia),
        downloadUrl,
        downloadSha256,
        downloadFileName,
        downloadSize: numOrNull(download.size),
        previewUrl: absoluteCatalogUrl(preview.url, base),
        // 缺一不可：下载地址、校验值、文件名。缺 sha256 就不给安装按钮（我们要求校验）。
        canInstall: !!(downloadUrl && downloadSha256 && downloadFileName),
        channel: strOrNull(source.channel),
        hasClient: source.hasClient === true,
        experimental,
    };
};

/**
 * 解析一份 catalog 响应体（已经 `JSON.parse` 过的值，或 JSON 文本都行）。
 *
 * 返回 `null` 表示**整份响应不可用**（不是 JSON、`format` 不对、`mods` 不是数组）—— 市场页据此显示
 * 「离线」，并退化成「只列已装模组」。单条坏数据只减少 `entries` 并让 `dropped` +1，不影响整份。
 */
export const parseModCatalog = (raw: unknown, base: string = MOD_CATALOG_URL): ModCatalog | null => {
    let value = raw;
    if (typeof value === 'string') {
        const text = value.trim();
        if (text === '') return null;
        try {
            value = JSON.parse(text);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object') return null;
    const source = value as Record<string, unknown>;
    if (source.format !== MOD_CATALOG_FORMAT) return null;
    if (!Array.isArray(source.mods)) return null;

    const entries: ModCatalogEntry[] = [];
    let dropped = 0;
    const seen = new Set<string>();
    for (const item of source.mods) {
        const entry = normalizeEntry(item, base);
        if (!entry) {
            dropped += 1;
            continue;
        }
        // 同一个 id 出现两次：保留第一条（catalog 里不该有，但外部数据不能假设）。
        if (seen.has(entry.id)) {
            dropped += 1;
            continue;
        }
        seen.add(entry.id);
        entries.push(entry);
    }

    return {
        version: numOrNull(source.version) ?? 0,
        repository: strOrNull(source.repository),
        commit: strOrNull(source.commit),
        entries,
        dropped,
    };
};

/** 按 origin 分组（顺序固定 official → community → beta，空组也返回，调用方自己判空）。 */
export const groupByOrigin = (entries: readonly ModCatalogEntry[]): Record<ModOrigin, ModCatalogEntry[]> => {
    const groups: Record<ModOrigin, ModCatalogEntry[]> = { official: [], community: [], beta: [] };
    for (const entry of entries) groups[entry.origin].push(entry);
    return groups;
};

/** 搜索：名称/作者/描述/id 的不区分大小写子串匹配；空查询返回原数组。 */
export const filterCatalog = (entries: readonly ModCatalogEntry[], query: string): ModCatalogEntry[] => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return [...entries];
    return entries.filter(entry =>
        entry.name.toLocaleLowerCase().includes(needle)
        || entry.author.toLocaleLowerCase().includes(needle)
        || entry.id.toLocaleLowerCase().includes(needle)
        || entry.description.toLocaleLowerCase().includes(needle));
};

/** 包大小的人类可读形式（市场卡片上就这一处格式化）。 */
export const formatBytes = (bytes: number | null): string | null => {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};
