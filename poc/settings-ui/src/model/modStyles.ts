/* issue #23 · 模组样式的「第二套并行清单」。
 *
 * ## 为什么必须有这个文件（而不是往 styles.tsx 里加几行）
 *
 * 上游 Folia 的样式清单在本仓库里被**四道**闸门同时钉住，任何一道被模组样式污染都会立刻炸：
 *
 *   1. `model/styles.tsx:318-333` —— 模块加载期 throw：`STYLE_ENTRIES` 与 `STYLE_MODE_SHELF_ORDER`
 *      必须一一对应且同序。只加一侧 ⇒ **打开设置页白屏**（岛没有 ErrorBoundary）；
 *   2. `scripts/check-style-sync.mjs:429-437 / :479-483` —— 会主动报错「styles.tsx 多出样式」
 *      「StyleMode 联合多成员」，而它已挂进 `vite build`（`vite.config.ts:159-193`）；
 *   3. `vite.config.ts:122-136` 的 `requireStyleThumbs` —— `STYLE_MODES` 每一项都要求
 *      `dist/thumbs/<id>.jpg` 存在，模组没有缩略图，构建直接 throw；
 *   4. `packaging/tools/verify-layout.mjs:263` —— 货架格数必须等于 `expectedStyles.length + 1`，
 *      而 `expectedStyles` 是 stage-web 用正则从 `STYLE_ENTRIES` 里抠出来的。
 *
 * 所以模组样式**一个字节都不碰**上面那四份清单，而是走这个文件：一份独立的、运行期才出现的
 * 清单，只由「已装且启用的模组 + 它们注册的 visualizer」决定。
 *
 * ## 数据从哪来
 *
 * 页面是**独立 bundle**，读不到播放页 bundle 里那个上游 registry 实例；模组的激活发生在播放页的
 * `Shim.js`（见 PLAN.md §5）。所以这里只读 Shim 维护的两个全局：
 *
 *   - `window.__SPW_FOLIA_MODS__`       —— 模组清单与错误（含 `visualizers` 字段，若 Shim 提供）；
 *   - `window.__SPW_FOLIA_MOD_VISUALIZERS__` —— 模组注册的 visualizer 条目数组。
 *
 * 两条都**宽容解析**（形状略有偏差也认），但**绝不伪造**：拿不到就返回空数组，货架就不出模组格。
 * 宁可少一格，也不要把一个不存在的 mode 画进货架、再让 publisher 发一个画不出来的
 * `visualizerMode` 出去。
 *
 * ## 与 `StyleMode` 的关系
 *
 * `ModStyleMode` 是**并列**类型，不是 `StyleMode` 的成员：`StyleMode` 是上游闭集（`settings.ts:55-75`），
 * 一旦并进 `mod:`，`check-style-sync.mjs` 立刻报「联合多成员」。两者在货架上并成 `ShelfValue`
 * （`shelfShared.tsx`），在 publisher 处由字符串直接通过（上游 `VisualizerMode` 本来就是开放 string，
 * `work/folia/folia-major-main/src/types.ts:141-142`）。
 */
import type { ShelfValue } from './shelfShared';

/** `mod:<modId>:<vizId>` —— 上游 `appendVisualizerEntry` 生成的 host mode 形态。 */
export type ModStyleMode = `mod:${string}`;

/** `mod:` 前缀的唯一拼写处（`check-style-sync.mjs` 之外只有这里能出现它）。 */
export const MOD_STYLE_PREFIX = 'mod:';

const MOD_STYLE_RE = /^mod:([^:]+):(.+)$/;

/** 货架上的一格模组样式。 */
export interface ModStyleEntry {
    /** `mod:<modId>:<vizId>`，直接当 `config.visualizerMode` 发出去。 */
    mode: ModStyleMode;
    modId: string;
    vizId: string;
    /** 货架上显示的名字。Shim 给了 label 就用它，否则退回 vizId。 */
    label: string;
    /** 模组自带 preview 图（绝对 URL 或站内相对路径由调用方决定）；null = 没有图。 */
    previewUrl: string | null;
    /** 用来给格子加 tooltip / 诊断。 */
    modVersion: string | null;
}

/** 是不是模组样式。**永远**用这个判断，不要各处写 `startsWith('mod:')`。 */
export const isModStyleMode = (value: unknown): value is ModStyleMode =>
    typeof value === 'string' && value.startsWith(MOD_STYLE_PREFIX);

/** `mod:<modId>:<vizId>` → `{ modId, vizId }`；不是这个形状返回 null。 */
export const parseModStyleMode = (value: unknown): { modId: string; vizId: string } | null => {
    if (typeof value !== 'string') return null;
    const match = MOD_STYLE_RE.exec(value);
    if (!match) return null;
    const modId = match[1].trim();
    const vizId = match[2].trim();
    if (!modId || !vizId) return null;
    return { modId, vizId };
};

/** `mod:<modId>:<vizId>` 的归一化构造：`mod:${modId}:${vizId}`（id 里的冒号会被剔掉）。 */
export const makeModStyleMode = (modId: string, vizId: string): ModStyleMode | null => {
    const id = modId.replace(/:/g, '').trim();
    const viz = vizId.replace(/:/g, '').trim();
    if (!id || !viz) return null;
    return `mod:${id}:${viz}` as ModStyleMode;
};

/** Shim 报来的 visualizer 条目：字段名几种写法都认（见文件头的「宽容解析」）。 */
interface RawVisualizerEntry {
    mode?: unknown;
    id?: unknown;
    vizId?: unknown;
    name?: unknown;
    label?: unknown;
    modId?: unknown;
    preview?: unknown;
    previewUrl?: unknown;
}

/** Shim 报来的模组清单条目：只要 id/version/previewEntry 三个字段有用。 */
interface RawModEntry {
    id?: unknown;
    version?: unknown;
    enabled?: unknown;
    previewEntry?: unknown;
    previewUrl?: unknown;
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * issue #23（第二轮）：把模组的预览图文件名变成**能加载的绝对地址**。
 *
 * `FoliaModStore.toJson` 给的是 `previewEntry`，即**相对模组目录的文件名**（`preview.jpg`）。
 * 直接塞进 `<img src>` 会被当成站内相对路径，解析成 `https://spw-folia.local/preview.jpg` → 404，
 * 货架上就是一个破图格子。模组文件真正的来源是 `mod-host.json` 的 `modsBase`
 * （`https://spw-folia-mods.local/`，由 `packaging/tools/stage-web.mjs` 写入、Shim 挂在
 * `window.__SPW_FOLIA_MODS__.host.modsBase` 上），拼法必须与 Shim 激活时一致：
 * `modsBase + <modId>/ + <file>`（`Shim.js` 的 `modsBase() + mod.id + '/' + mod.clientEntry`）。
 *
 * 绝对 URL（`http(s)://` / `data:`）原样返回：将来的 CDN 变体不用改这里。拿不到 base 时返回 null，
 * 让格子退回图标 + 名字 —— **绝不猜一个地址**（猜错就是一个必然 404 的破图）。
 */
const absolutiseModAsset = (raw: string, modId: string): string | null => {
    if (raw === '') return null;
    if (/^(?:https?:|data:)/i.test(raw)) return raw;
    const base = modsBase();
    if (base === null || modId === '') return null;
    const root = base.endsWith('/') ? base : `${base}/`;
    return `${root}${modId}/${raw.replace(/^\.?\//, '')}`;
};

/** `modsBase` 从 Shim 的全局读；读不到返回 null（dev.html / 模组运行时没起来的页面）。 */
const modsBase = (): string | null => {
    if (typeof window === 'undefined') return null;
    const host = window as Window & { __SPW_FOLIA_MODS__?: { host?: { modsBase?: unknown } } };
    const value = host.__SPW_FOLIA_MODS__?.host?.modsBase;
    return typeof value === 'string' && value !== '' ? value : null;
};

/** 一条原始条目 → `ModStyleEntry`；认不出返回 null（绝不猜 mode）。 */
const normalizeOne = (raw: RawVisualizerEntry, owner: RawModEntry | null): ModStyleEntry | null => {
    const ownerId = str(raw.modId) || str(owner?.id);
    // 优先用条目自己给的完整 mode：那是 Shim 从上游 `appendVisualizerEntry` 的返回值上抄下来的，
    // 比我们用字符串拼出来的更权威。
    const declared = str(raw.mode);
    const parsed = parseModStyleMode(declared);
    const mode = parsed
        ? makeModStyleMode(parsed.modId, parsed.vizId)
        : makeModStyleMode(ownerId, str(raw.vizId) || str(raw.id));
    if (!mode) return null;
    const ids = parsed ?? parseModStyleMode(mode);
    if (!ids) return null;
    const label = str(raw.label) || str(raw.name) || str(raw.id) || str(raw.vizId) || ids.vizId;
    // 优先条目自己给的绝对地址；否则拿模组的 previewEntry（裸文件名）拼成 modsBase 下的绝对地址。
    const declaredPreview = str(raw.previewUrl) || str(raw.preview) || str(owner?.previewUrl);
    const previewUrl = declaredPreview !== ''
        ? absolutiseModAsset(declaredPreview, ids.modId)
        : absolutiseModAsset(str(owner?.previewEntry), ids.modId);
    return {
        mode,
        modId: ids.modId,
        vizId: ids.vizId,
        label,
        previewUrl,
        modVersion: str(owner?.version) || null,
    };
};

/**
 * 把两个全局的原始内容归一成货架清单（**纯函数**，探针与单测都直接驱动它）。
 *
 * - 只保留 `enabled !== false` 的模组：禁用的模组即使还报着 visualizer，也不该出现在货架上
 *   （否则用户会选中一个画不出来、且没有提示的样式）；
 * - 按 `modId` + `vizId` 去重（重复的 mods 消息/重复激活是安全的）；
 * - 顺序稳定：先按模组在清单里的顺序，再按条目在 Shim 数组里的顺序。
 */
export const normalizeModStyles = (
    visualizers: unknown,
    mods: unknown,
): ModStyleEntry[] => {
    const modList: RawModEntry[] = Array.isArray(mods)
        ? mods.filter((item): item is RawModEntry => !!item && typeof item === 'object')
        : [];
    const byId = new Map<string, RawModEntry>();
    for (const mod of modList) {
        const id = str(mod.id);
        if (id) byId.set(id, mod);
    }
    // `enabled` 缺省算启用：插件第一次装完就该立刻可选（PLAN.md §1 的语义）。
    const disabled = new Set<string>();
    for (const [id, mod] of byId) {
        if (mod.enabled === false) disabled.add(id);
    }

    const entries = Array.isArray(visualizers)
        ? visualizers.filter((item): item is RawVisualizerEntry => !!item && typeof item === 'object')
        : [];
    const seen = new Set<string>();
    const out: ModStyleEntry[] = [];
    for (const raw of entries) {
        const ownerId = str(raw.modId);
        const owner = ownerId ? byId.get(ownerId) ?? null : null;
        const entry = normalizeOne(raw, owner);
        if (!entry) continue;
        if (disabled.has(entry.modId)) continue;
        if (seen.has(entry.mode)) continue;
        seen.add(entry.mode);
        out.push(entry);
    }
    return out;
};

/** 一个模组是否已装且启用（`missingEntries` 桩据此判断「选了但用不了」）。 */
export const modIsUsable = (modId: string, mods: unknown): boolean => {
    if (!Array.isArray(mods)) return false;
    for (const mod of mods) {
        if (!mod || typeof mod !== 'object') continue;
        const candidate = mod as RawModEntry;
        if (str(candidate.id) !== modId) continue;
        return candidate.enabled !== false;
    }
    return false;
};

/** 模组是否已装（不管启用与否）。 */
export const modIsInstalled = (modId: string, mods: unknown): boolean => {
    if (!Array.isArray(mods)) return false;
    for (const mod of mods) {
        if (!mod || typeof mod !== 'object') continue;
        if (str((mod as RawModEntry).id) === modId) return true;
    }
    return false;
};

/** `ShelfValue` 是不是模组格（货架两版共用的判断，避免各处重复写 `isModStyleMode`）。 */
export const isModShelfValue = (value: ShelfValue): value is ModStyleMode => isModStyleMode(value);

/* --------------------------------------------------------------------------------------------- */
/* 「存着的模组样式，但那个模组现在用不了」                                                        */
/* --------------------------------------------------------------------------------------------- */

/**
 * 与上游 `mods/runtime/missingEntries.ts` 的 `MissingFoliumSelection` 同形
 * （`stubs/foliumMissingEntries.ts` 被 `vite.config.ts:39` 的 STUB_RULES 顶到那个模块路径上，
 * 所以类型必须能顶替它）。
 */
export interface MissingFoliumSelection {
    kind: 'visualizer' | 'background';
    mode: string;
    modId: string;
}

const NO_MISSING: MissingFoliumSelection[] = [];

/**
 * 从「当前选择」与「已装清单」推出缺失项（**纯函数**）。
 *
 * 判据：选了 `mod:<id>:<viz>`，而那个 id **不在**「已装且启用」的清单里 ⇒ 报缺失。
 *
 * 为什么**不能**反过来判「这个 mode 有没有注册」：设置岛是独立 bundle，读不到播放页那个上游
 * registry 实例，页面里根本没有「注册表」这个概念。用模组清单判定既准确又不依赖跨 bundle 状态。
 *
 * 只报 `visualizer`：v2 不涉及模组背景，`background` 一条永远不会出现。
 */
export const readMissingFoliumSelections = (mode: unknown, mods: unknown): MissingFoliumSelection[] => {
    const parsed = parseModStyleMode(mode);
    if (!parsed) return NO_MISSING;
    if (modIsUsable(parsed.modId, mods)) return NO_MISSING;
    return [{ kind: 'visualizer', mode: String(mode), modId: parsed.modId }];
};

/** 给调用方复用的空数组引用（上游那些 `useMemo` 依赖每次渲染都变会失效）。 */
export const EMPTY_MISSING_SELECTIONS = NO_MISSING;
