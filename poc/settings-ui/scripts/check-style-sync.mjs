/**
 * 上游样式清单同步闸门：spw-folia 的样式清单 vs 上游 Folia 源码。
 *
 * 为什么需要它
 * ------------
 * 「加一个歌词样式」这件事本来要在本仓库改 6~9 个地方（settings 的联合类型 / 调参默认值 /
 * 调参键 / 货架顺序、styles.tsx 的 entry、透明兼容表、构建闸门的 id 列表、缩略图采集列表、
 * 宿主 HUD……）。0.7.22 → 0.7.25 那次跟进就漏了两处（`Overlay.js` 里还留着不存在的
 * `'window'`，`make-style-grid.mjs` 停在 15 项），而且这些漏项**都不会报错**，只是静默少画一个
 * 按钮 / 少一张图。人肉同步不可靠，所以把「上游有哪些样式」变成可执行的检查。
 *
 * 单一事实源（SSOT）是**上游源码**，不是本仓库里再抄一份：
 *   1. `work/folia/folia-major-main/src/types/visualizerModes.ts` → `BUILTIN_VISUALIZER_MODES`
 *      上游自己的权威 id 清单（它的 registry 初始化时会 assert 与 glob 出来的 entry 目录逐字相等）。
 *   2. 每个 `src/components/visualizer/<mode>/entry.tsx` → `mode` / `order` / `labelKey` /
 *      `labelFallback` / `beatEffects` / `ownFontSizeNoticeKey`。
 *   3. 每个 `<mode>/tuning.ts` 的 `settingsKey`（`still` 没有 tuning.ts，按约定兜底 `<mode>Tuning`）。
 *
 * 用法
 * ----
 *   node scripts/check-style-sync.mjs           # 等同 --check
 *   node scripts/check-style-sync.mjs --check   # 只校验；有差异 exit 1（CI / 发布前闸门）
 *   node scripts/check-style-sync.mjs --write   # 自动补齐「纯 id 列表」，人判断的部分仍然报差异
 *   node scripts/check-style-sync.mjs --verbose # 额外打印派生出的完整样式表
 *
 * `--write` 的边界（故意收窄）
 * ---------------------------
 * 只改**纯 id 列表**：`vite.config.ts` 的 `STYLE_MODES`、`make-thumbs.mjs` / `make-style-grid.mjs`
 * 的 `MODES`、`Overlay.js` 的 `MODES`。这些是「上游有什么就该有什么」，机器可以决定。
 *
 * **不**碰 `src/model/styles.tsx`、`settings.ts`、`transparencyCompat.ts`：那些要人判断
 * （用哪个 settings panel、缩略图怎么采、透明模式能不能用、调参默认值从哪 import）。脚本只把
 * 差异指出来，不改。
 *
 * 特意不校验的字段
 * ----------------
 * - `labelFallback`：上游多数样式写的是**英文**名（`Tempera` / `Claddagh` / `Still`…），本页是要
 *   显示的**中文**名（凝彩 / 回环 / 静止）。两边本来就不同，逐字比对只会制造假差异。
 * - `labelKey` 也不从 labelKey 反推 id：`cadenza` 的 key 是 `ui.visualizerCadenze`（少个 z），
 *   用 key 反推会把 id 推错。id 一律以上游 `mode:` 字面量为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(SETTINGS_ROOT, '..', '..');

/**
 * 上游源码树位置。默认是仓库里的 `work/folia/folia-major-main`（gitignored 的本地检出）。
 * `--upstream=<dir>` 可以指到别处 —— 主要是给「验证脚本能抓到上游新增样式」这类负向测试用：
 * 那样不需要往只读的 work/ 树里写东西（work/folia 约定只读，改它会让上游 diff 变脏）。
 */
const upstreamArg = process.argv.slice(2).find((a) => a.startsWith('--upstream='));
const FOLIA = upstreamArg
    ? path.resolve(REPO, upstreamArg.slice('--upstream='.length))
    : path.join(REPO, 'work/folia/folia-major-main');
const FOLIA_SRC = path.join(FOLIA, 'src');
const VIS = path.join(FOLIA_SRC, 'components/visualizer');

const argv = new Set(process.argv.slice(2));
const WRITE = argv.has('--write');
const VERBOSE = argv.has('--verbose');

/* ------------------------------------------------------------------ *
 * 1. 从上游派生权威样式表
 * ------------------------------------------------------------------ */

/** POSIX 化的相对路径，报告里统一用它，避免 Windows 反斜杠。 */
const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');

const readIfExists = (file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
};

/**
 * 上游的权威 id 清单。注意它是**字母序**（`cadenza, cappella, claddagh, …`），不是货架序 ——
 * 货架序来自每个 entry 的 `order`，两者不要混。
 */
const deriveUpstreamIds = () => {
    const file = path.join(FOLIA_SRC, 'types/visualizerModes.ts');
    const text = readIfExists(file);
    if (text === null) {
        throw new Error(
            `[style-sync] 找不到上游源码 ${rel(file)}\n`
            + '  work/folia/ 是本地 gitignored 的上游检出（按 docs/upstream-sync.md 放置），'
            + '先在仓库根跑一次上游源码树准备步骤。',
        );
    }
    const block = text.match(/export const BUILTIN_VISUALIZER_MODES\s*=\s*\[([\s\S]*?)\]/);
    if (!block) {
        throw new Error(
            `[style-sync] ${rel(file)} 里没有解析到 BUILTIN_VISUALIZER_MODES 数组。\n`
            + '  上游可能改了这份清单的写法；按新写法更新本脚本的 matcher 再跑。',
        );
    }
    const ids = [...block[1].matchAll(/['"]([a-z0-9_-]+)['"]/g)].map((m) => m[1]);
    if (ids.length === 0) throw new Error(`[style-sync] BUILTIN_VISUALIZER_MODES 解析出 0 个 id。`);
    return ids;
};

/**
 * 去掉注释，避免两件事：
 *  1. 注释里的 `mode: 'foo'` 之类的示例文本被当成真实声明；
 *  2. 注释里的分号（`… three.js; …`）把「抓到第一个 `;` 为止」的正则提前截断 ——
 *     `StyleMode` 的联合类型就踩过这个：注释里的 `three.js;` 让联合只解析出前 4 个成员。
 */
const stripComments = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/**
 * 从 `openIndex` 处的 `open` 字符开始，做括号配对，返回落在 `close` 上之后的下标（不含）。
 *
 * 为什么不用正则：`beatEffects` 在上游有**两种**写法，单条时是
 * `beatEffects: [{ … }],`（一行开一行合），多条时是 `beatEffects: [\n {…},\n {…},\n],`。
 * 任何「行首缩进的 `],`」式正则都只对其中一种成立，于是另一种会被静默解析成「没有 beatEffects」，
 * 进而报出一堆假的「上游没有、本地有」差异。逐字符配对对两种写法都成立，也顺带跳过字符串
 * 与模板串里的括号。
 */
const takeBalanced = (text, openIndex, open = '[', close = ']') => {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i += 1;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === open) depth += 1;
        else if (ch === close) {
            depth -= 1;
            if (depth === 0) return { body: text.slice(openIndex + 1, i), end: i + 1 };
        }
    }
    return null;
};

/**
 * 把一个 entry.tsx 里的声明读成结构化的一行。
 * 这些字段在上游都是对象字面量里的裸字段（`mode: 'machi',`），用锚定行首缩进的匹配足够稳，
 * 而且比正则化整个 JS 对象安全（entry 里有 JSX、`as const`、动态 import）。
 */
const parseEntry = (mode, entryFile) => {
    const code = stripComments(readIfExists(entryFile) ?? '');
    const pick = (field) => {
        const m = code.match(new RegExp(`^\\s*${field}:\\s*'([^']*)'`, 'm'));
        return m ? m[1] : null;
    };
    const orderText = code.match(/^\s*order:\s*(\d+)/m);
    if (!orderText) return null;

    // beatEffects：只取 `id: BEAT_EFFECT_IDS.<key>` 与紧随的 `source: '<src>'`，够比对「清单是否一致」。
    // parts 这类结构留给人工看（styles.tsx 的注释里有），脚本只做「条数 + id + source」的三元组比对。
    // 用括号配对而不是行式正则：上游单条时写成 `beatEffects: [{`，多条时写成 `beatEffects: [\n {`。
    const beatEffects = [];
    const beatAt = code.search(/^\s*beatEffects:\s*\[/m);
    if (beatAt >= 0) {
        const bracket = code.indexOf('[', beatAt);
        const balanced = bracket >= 0 ? takeBalanced(code, bracket) : null;
        if (balanced) {
            // 顶层对象按 `{` 配对切分，避免把一条 effect 的字段拆到两条里。
            let cursor = 0;
            while (cursor < balanced.body.length) {
                const open = balanced.body.indexOf('{', cursor);
                if (open < 0) break;
                const obj = takeBalanced(balanced.body, open, '{', '}');
                if (!obj) break;
                const idm = obj.body.match(/BEAT_EFFECT_IDS\.(\w+)/);
                const src = obj.body.match(/source:\s*'([a-z]+)'/);
                if (idm && src) beatEffects.push({ id: idm[1], source: src[1] });
                cursor = obj.end;
            }
        }
    }

    // settingsKey 来自同目录 tuning.ts；`still` 没有 tuning.ts，按上游约定兜底 <mode>Tuning。
    const tuningText = stripComments(readIfExists(path.join(VIS, mode, 'tuning.ts')) ?? '');
    const keyMatch = tuningText.match(/settingsKey:\s*'([^']+)'/);
    const tuningKey = keyMatch ? keyMatch[1] : `${mode}Tuning`;

    return {
        mode,
        order: Number(orderText[1]),
        labelKey: pick('labelKey'),
        labelFallback: pick('labelFallback'),
        ownFontSizeNoticeKey: pick('ownFontSizeNoticeKey'),
        beatEffects,
        tuningKey,
    };
};

const deriveUpstream = () => {
    const ids = deriveUpstreamIds();
    const rows = [];
    const missingEntry = [];
    for (const mode of ids) {
        const entryFile = path.join(VIS, mode, 'entry.tsx');
        const row = fs.existsSync(entryFile) ? parseEntry(mode, entryFile) : null;
        if (row) rows.push(row);
        else missingEntry.push(mode);
    }
    rows.sort((a, b) => a.order - b.order || a.mode.localeCompare(b.mode));
    return { ids, rows, missingEntry };
};

/* ------------------------------------------------------------------ *
 * 2. 本地各清单
 * ------------------------------------------------------------------ */

/** 从一个文件里按给定正则抓数组里的 id（用于「纯 id 列表」这类机械清单）。 */
const readIdList = (file, re) => {
    const text = readIfExists(file);
    if (text === null) return { present: false, ids: [] };
    const m = text.match(re);
    if (!m) return { present: true, matched: false, ids: [] };
    return { present: true, matched: true, ids: [...m[1].matchAll(/['"]([a-z0-9_-]+)['"]/g)].map((x) => x[1]) };
};

/** 纯 id 清单的登记表：既用于 --check 比对，也用于 --write 回写。
 *  回写时**沿用该文件自己的排版**（缩进 / 行尾逗号都从现有数组里嗅出来），
 *  这样 `--write` 的 diff 只会是「多了几个 id」，不会夹带整段重排。 */
const ID_LISTS = [
    {
        label: 'vite.config.ts STYLE_MODES',
        file: path.join(SETTINGS_ROOT, 'vite.config.ts'),
        re: /const STYLE_MODES = \[([\s\S]*?)\];/,
        why: 'requireStyleThumbs 的硬闸：产物缺任何一张 thumbs/<id>.jpg 就 throw。',
    },
    {
        label: 'make-thumbs.mjs MODES',
        file: path.join(SETTINGS_ROOT, 'scripts/make-thumbs.mjs'),
        re: /const MODES = \[([\s\S]*?)\];/,
        why: '缩略图采集列表：漏一个就少采一张，货架显示破图。',
    },
    {
        label: 'make-style-grid.mjs MODES',
        file: path.join(SETTINGS_ROOT, 'scripts/make-style-grid.mjs'),
        re: /const MODES = \[([\s\S]*?)\];/,
        why: 'docs/images/style-grid.png 的采集列表（README 里的样式总览图）。',
    },
    {
        label: 'Overlay.js MODES',
        file: path.join(REPO, 'poc/webview/host/Overlay.js'),
        re: /var MODES = \[([\s\S]*?)\];/,
        why: '宿主占位 HUD（--no-overlay 可关）：样式按钮列表。',
    },
];

/**
 * 从现有数组内容里读出它的排版风格，回写时沿用 —— 否则 --write 会把整个文件的行尾逗号、
 * 缩进宽度、结束括号位置全部重排一遍，diff 里出现一堆与「补齐一个 id」无关的噪声。
 */
const sniffArrayStyle = (inner, fallbackIndent = '    ') => {
    const lines = inner.split('\n');
    // 缩进：取第一行有内容的 id 行的前导空白。
    const first = lines.find((l) => /['"]/.test(l));
    const indent = first ? (first.match(/^[ \t]*/) ?? [''])[0] : fallbackIndent;
    // 行尾逗号：看最后一行 id 是否以逗号收尾。
    const lastId = [...lines].reverse().find((l) => /['"]/.test(l));
    const trailingComma = lastId ? /,\s*$/.test(lastId) : true;
    // 结束 `]` 自己的缩进：原始 inner 的最后一行是只有空白的行（`]` 前面的那截缩进）。
    // 不保留它，回写后 `]` 会掉到行首，diff 里又是无关噪声。
    const lastLine = lines[lines.length - 1];
    const closeIndent = /^[ \t]*$/.test(lastLine) ? lastLine : '';
    // 引号风格：python 那份用双引号，js 的用单引号；跟着文件走，别混着改。
    const quote = first && first.includes('"') && !first.includes("'") ? '"' : "'";
    return { indent: indent || fallbackIndent, trailingComma, closeIndent, quote };
};

/** 渲染数组的**内部内容**（不含外层方括号），供 --write 回写。
 *  注意：回写时替换的是正则捕获组（组里已经是去掉 `[` `]` 的内容），所以这里不能自带括号，
 *  否则会写成 `[[ … ]]`。 */
const renderArray = (ids, style = {}) => {
    const { indent = '    ', trailingComma = true, closeIndent = '', quote = "'" } = style;
    const quoted = ids.map((id) => `${quote}${id}${quote}`);
    const lines = [];
    let current = '';
    const LIMIT = 100;
    for (const [i, item] of quoted.entries()) {
        const isLast = i === quoted.length - 1;
        const piece = isLast && !trailingComma ? item : `${item},`;
        const candidate = current ? `${current} ${piece}` : `${indent}${piece}`;
        if (current && candidate.length > LIMIT) {
            lines.push(current);
            current = `${indent}${piece}`;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    // 末尾的空行 = 结束 `]` 之前的那截缩进（有的文件是 `  ];`，有的是 `];`）。
    return `\n${lines.join('\n')}\n${closeIndent}`;
};

/* ------------------------------------------------------------------ *
 * 3. 本地「人判断」清单（只校验，不改）
 * ------------------------------------------------------------------ */

/** styles.tsx 的 STYLE_ENTRIES：按 order 排好的 mode 序列 + 每个 entry 的字段摘要。 */
const readStyleEntries = () => {
    const file = path.join(SETTINGS_ROOT, 'src/model/styles.tsx');
    const text = readIfExists(file);
    if (text === null) return null;
    const block = text.match(/export const STYLE_ENTRIES: StyleEntry\[\] = \[([\s\S]*?)\n\];/);
    if (!block) return { matched: false, entries: [] };
    const entries = [];
    // 每个 entry 以 `{` 开头、`mode:` 定位；用 split 到下一个 `mode:` 粗切即可（entry 内部没有嵌套 mode:）。
    const chunks = block[1].split(/\n    \{\n/).slice(1);
    for (const chunk of chunks) {
        const mode = chunk.match(/^\s*mode:\s*'([^']+)'/m);
        if (!mode) continue;
        const order = chunk.match(/^\s*order:\s*(\d+)/m);
        const labelKey = chunk.match(/^\s*labelKey:\s*'([^']+)'/m);
        const thumb = chunk.match(/stylePreviewUrl\('([^']+)'\)/);
        const panelImport = chunk.match(/panel\((\w+)\)/);
        const beatIds = [...chunk.matchAll(/id:\s*BEAT_EFFECT_IDS\.(\w+)/g)].map((m) => m[1]);
        entries.push({
            mode: mode[1],
            order: order ? Number(order[1]) : null,
            labelKey: labelKey ? labelKey[1] : null,
            thumb: thumb ? thumb[1] : null,
            panel: panelImport ? panelImport[1] : null,
            beatIds,
        });
    }
    return { matched: true, entries };
};

/** settings.ts 的 STYLE_MODE_SHELF_ORDER / STYLE_TUNING_KEYS / StyleMode 联合。 */
const readSettingsTs = () => {
    const file = path.join(SETTINGS_ROOT, 'src/model/settings.ts');
    const text = readIfExists(file);
    if (text === null) return null;
    const shelf = text.match(/export const STYLE_MODE_SHELF_ORDER: StyleMode\[\] = \[([\s\S]*?)\];/);
    const keys = text.match(/export const STYLE_TUNING_KEYS: Record<StyleMode, string> = \{([\s\S]*?)\n\};/);
    // 联合类型不能用 `/;` 收尾：几条成员之间夹着中文注释，注释里会出现 `three.js;` 这种分号，
    // 会把联合提前截断（首轮实测只解析出 4 个成员）。改成「从 = 开始，取到第一行不以 | 或注释开头的行」。
    const unionMatch = text.match(/export type StyleMode =([\s\S]*?)(?=\n\S)/);
    const ids = (s) => [...s.matchAll(/['"]([a-z0-9_-]+)['"]/g)].map((m) => m[1]);
    return {
        shelfOrder: shelf ? ids(shelf[1]) : null,
        tuningKeys: keys
            ? Object.fromEntries([...keys[1].matchAll(/([a-z0-9_-]+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
            : null,
        // 联合的成员一定带引号；注释里偶有 `'…'`（如 'ui.visualizerCadenze' 之类）也不影响，
        // 因为下面只把它当「本地声明了哪些 id」的集合看，多出来的会在比对阶段报出来。
        union: unionMatch ? ids(unionMatch[1]) : null,
    };
};

/** transparencyCompat.ts 的 STYLE_COMPAT 键。 */
const readTransparencyCompat = () => {
    const file = path.join(SETTINGS_ROOT, 'src/model/transparencyCompat.ts');
    const text = readIfExists(file);
    if (text === null) return null;
    const block = text.match(/const STYLE_COMPAT: Record<StyleMode, TransparencyCompat> = \{([\s\S]*?)\n\};/);
    return block ? [...block[1].matchAll(/^\s*([a-z0-9_-]+):\s*'/gm)].map((m) => m[1]) : null;
};

/* ------------------------------------------------------------------ *
 * 4. 比对
 * ------------------------------------------------------------------ */

const problems = [];
const notes = [];

const fmt = (ids) => (ids.length ? ids.join(', ') : '（空）');

const deriveSeq = (rows) => rows.map((r) => r.mode);

/**
 * 纯 id 清单：要求**集合与顺序都一致**（这些清单本身就是货架序，顺序错了按钮就乱序）。
 * 这是 --write 能自动修的部分，所以差异文案里直接给命令。
 */
const checkIdList = (entry, expected) => {
    const got = readIdList(entry.file, entry.re);
    if (!got.present) {
        problems.push(`[缺文件] ${entry.label}：${rel(entry.file)} 不存在`);
        return;
    }
    if (got.matched === false) {
        problems.push(
            `[解析失败] ${entry.label}：${rel(entry.file)} 里没匹配到数组声明。\n`
            + '    上游/本地可能改了这份清单的写法；更新 check-style-sync.mjs 的 ID_LISTS 正则。',
        );
        return;
    }
    const missing = expected.filter((id) => !got.ids.includes(id));
    const extra = got.ids.filter((id) => !expected.includes(id));
    const drifted = missing.length === 0 && extra.length === 0
        && got.ids.join(',') !== expected.join(',');
    if (missing.length === 0 && extra.length === 0 && !drifted) return;

    problems.push(
        `[清单不同步] ${entry.label}（${rel(entry.file)}）\n`
        + `    上游 ${expected.length} 项 / 本地 ${got.ids.length} 项\n`
        + (missing.length ? `    上游有、本地缺：${fmt(missing)}\n` : '')
        + (extra.length ? `    本地多出（上游没有）：${fmt(extra)}\n` : '')
        + (drifted ? `    顺序不同：\n      上游 ${fmt(expected)}\n      本地 ${fmt(got.ids)}\n` : '')
        + `    作用：${entry.why}\n`
        + '    修复：node scripts/check-style-sync.mjs --write',
    );
};

const checkModelLayer = (upstreamRows) => {
    const expected = deriveSeq(upstreamRows);

    /* 4.1 styles.tsx —— entry 是否齐全、字段是否对得上 */
    const styles = readStyleEntries();
    if (styles === null) {
        problems.push('[缺文件] src/model/styles.tsx 不存在');
    } else if (!styles.matched) {
        problems.push(
            '[解析失败] src/model/styles.tsx：没匹配到 `STYLE_ENTRIES: StyleEntry[] = [...]`。\n'
            + '    如果你改了这份表的写法，同步更新 check-style-sync.mjs 的 readStyleEntries。',
        );
    } else {
        const localModes = styles.entries.map((e) => e.mode);
        const missing = expected.filter((id) => !localModes.includes(id));
        const extra = localModes.filter((id) => !expected.includes(id));
        if (missing.length) {
            problems.push(
                `[styles.tsx 缺样式] 上游有、STYLE_ENTRIES 没有：${fmt(missing)}\n`
                + '    每个 entry 还要人决定：用哪个 settings panel（renderSettingsPanel）、缩略图怎么采、\n'
                + '    beatEffects 怎么声明（照抄上游 entry.tsx）、ownFontSizeNoticeKey。脚本故意不代劳。',
            );
        }
        if (extra.length) {
            problems.push(`[styles.tsx 多出样式] STYLE_ENTRIES 有、上游没有：${fmt(extra)}（上游可能删了模式，或 id 打错）`);
        }
        for (const row of upstreamRows) {
            const local = styles.entries.find((e) => e.mode === row.mode);
            if (!local) continue;
            if (local.order !== row.order) {
                problems.push(`[order 不一致] ${row.mode}：上游 ${row.order} / styles.tsx ${local.order}（货架顺序会错位）`);
            }
            if (local.labelKey !== row.labelKey) {
                problems.push(`[labelKey 不一致] ${row.mode}：上游 ${row.labelKey} / styles.tsx ${local.labelKey}`);
            }
            if (local.thumb !== null && local.thumb !== row.mode) {
                problems.push(`[缩略图 id 不一致] ${row.mode}：stylePreviewUrl('${local.thumb}') 应为 stylePreviewUrl('${row.mode}')`);
            }
            const localBeat = local.beatIds.join(',');
            const upstreamBeat = row.beatEffects.map((b) => b.id).join(',');
            if (localBeat !== upstreamBeat) {
                problems.push(
                    `[beatEffects 不一致] ${row.mode}\n`
                    + `    上游 ${upstreamBeat || '（无）'}\n`
                    + `    本地 ${localBeat || '（无）'}\n`
                    + '    照上游 entry.tsx 的声明补/删（id、source、parts 都要一致）。',
                );
            }
        }
        // 货架顺序：styles.tsx 自身按 order 排出来的序列必须等于上游按 order 排出来的序列。
        const localByOrder = [...styles.entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => e.mode);
        if (localByOrder.join(',') !== expected.join(',')) {
            const at = localByOrder.findIndex((id, i) => id !== expected[i]);
            problems.push(
                `[货架顺序不一致] styles.tsx 按 order 排出：${fmt(localByOrder)}\n`
                + `    上游按 order 排出：${fmt(expected)}\n`
                + (at >= 0 ? `    第一处不同在第 ${at + 1} 位：本地 ${localByOrder[at]} / 上游 ${expected[at]}\n` : ''),
            );
        }
    }

    /* 4.2 settings.ts —— 联合类型 / 货架顺序 / 调参键 */
    const settings = readSettingsTs();
    if (settings === null) {
        problems.push('[缺文件] src/model/settings.ts 不存在');
    } else {
        if (settings.union) {
            const missing = expected.filter((id) => !settings.union.includes(id));
            const extra = settings.union.filter((id) => !expected.includes(id));
            if (missing.length) problems.push(`[StyleMode 联合缺成员] ${fmt(missing)}（缺了它 Record<StyleMode,…> 会少键）`);
            if (extra.length) problems.push(`[StyleMode 联合多成员] ${fmt(extra)}（上游没有这个模式）`);
        } else {
            problems.push('[解析失败] settings.ts：没匹配到 `export type StyleMode = ...`');
        }
        if (settings.shelfOrder) {
            if (settings.shelfOrder.join(',') !== expected.join(',')) {
                problems.push(
                    `[STYLE_MODE_SHELF_ORDER 不一致]\n`
                    + `    应为 ${fmt(expected)}\n`
                    + `    实为 ${fmt(settings.shelfOrder)}\n`
                    + '    这段顺序与 styles.tsx 按 order 排出来的序列必须逐项相等 —— styles.tsx 底部有模块加载期\n'
                    + '    断言，不一致会在加载时 throw（整个设置页白屏）。',
                );
            }
        } else {
            problems.push('[解析失败] settings.ts：没匹配到 STYLE_MODE_SHELF_ORDER');
        }
        if (settings.tuningKeys) {
            for (const row of upstreamRows) {
                const got = settings.tuningKeys[row.mode];
                if (got === undefined) {
                    problems.push(`[STYLE_TUNING_KEYS 缺键] ${row.mode}（应为 '${row.tuningKey}'）`);
                } else if (got !== row.tuningKey) {
                    problems.push(`[STYLE_TUNING_KEYS 键名不一致] ${row.mode}：上游 settingsKey '${row.tuningKey}' / 本地 '${got}'`);
                }
            }
            for (const id of Object.keys(settings.tuningKeys)) {
                if (!expected.includes(id)) problems.push(`[STYLE_TUNING_KEYS 多键] ${id}`);
            }
        } else {
            problems.push('[解析失败] settings.ts：没匹配到 STYLE_TUNING_KEYS');
        }
    }

    /* 4.3 transparencyCompat.ts —— Record<StyleMode, …> 必须每个样式都有 */
    const compat = readTransparencyCompat();
    if (compat === null) {
        problems.push('[解析失败] transparencyCompat.ts：没匹配到 STYLE_COMPAT');
    } else {
        const missing = expected.filter((id) => !compat.includes(id));
        const extra = compat.filter((id) => !expected.includes(id));
        if (missing.length) {
            problems.push(
                `[STYLE_COMPAT 缺键] ${fmt(missing)}（Record<StyleMode,…> 少键是类型错误，tsc 会报）\n`
                + '    分类要人判断：整屏自绘/大块半透明 → unsupported 或 tuned（见该文件头部的判据与实测记录）。',
            );
        }
        if (extra.length) problems.push(`[STYLE_COMPAT 多键] ${fmt(extra)}`);
    }
};

/* ------------------------------------------------------------------ *
 * 5. 主流程
 * ------------------------------------------------------------------ */

const main = () => {
    const upstream = deriveUpstream();

    if (upstream.missingEntry.length > 0) {
        problems.push(
            `[上游数据不全] BUILTIN_VISUALIZER_MODES 声明了但这些模式没有 src/components/visualizer/<mode>/entry.tsx：\n`
            + `    ${fmt(upstream.missingEntry)}\n`
            + '    上游自己会在 registry 初始化时 assert 这两份清单一致；先确认 work/folia/ 检出是否完整。',
        );
    }

    const expected = deriveSeq(upstream.rows);

    if (WRITE) {
        for (const entry of ID_LISTS) {
            const got = readIdList(entry.file, entry.re);
            if (!got.present) continue; // 缺文件不代劳
            if (got.matched === false) continue; // 解析失败时不盲写
            if (got.ids.join(',') === expected.join(',')) continue;
            const text = fs.readFileSync(entry.file, 'utf8');
            const current = text.match(entry.re);
            // 从现有数组内容嗅出行风格（缩进 / 行尾逗号），再回写：diff 里只应有「多了几个 id」。
            const style = sniffArrayStyle(current ? current[1] : '');
            // `inner` 是捕获组（方括号之间的内容）：只替换它，保留文件里原有的 `[` / `]`。
            const next = text.replace(entry.re, (whole, inner) => whole.replace(inner, renderArray(expected, style)));
            fs.writeFileSync(entry.file, next, 'utf8');
            console.log(`[style-sync] 已回写 ${entry.label}（${expected.length} 项，原 ${got.ids.length} 项）`);
        }
    }

    // 纯 id 清单：全部纳入校验（--write 之后再查，报的差异就是仍需人处理的）
    for (const entry of ID_LISTS) checkIdList(entry, expected);

    // 人判断层：只报差异
    checkModelLayer(upstream.rows);

    /* 报告 */
    if (VERBOSE) {
        console.log(`\n上游 ${upstream.ids.length} 个样式（按 order）：`);
        for (const row of upstream.rows) {
            console.log(
                `  ${String(row.order).padStart(4)}  ${row.mode.padEnd(10)} ${row.labelKey.padEnd(28)}`
                + ` tuning=${row.tuningKey.padEnd(16)} beats=${row.beatEffects.map((b) => `${b.id}(${b.source})`).join(',') || '-'}`
                + `${row.ownFontSizeNoticeKey ? ` notice=${row.ownFontSizeNoticeKey}` : ''}`,
            );
        }
        console.log('');
    }

    if (problems.length > 0) {
        console.error(`[style-sync] ✗ 发现 ${problems.length} 处与上游不一致：\n`);
        for (const [i, p] of problems.entries()) console.error(`${String(i + 1).padStart(2)}. ${p}\n`);
        console.error('  SSOT 是上游源码（work/folia/folia-major-main/src），不是本仓库里的任何一份副本。');
        console.error('  纯 id 列表可用 `node scripts/check-style-sync.mjs --write` 自动补齐；');
        console.error('  styles.tsx / settings.ts / transparencyCompat.ts 需要人判断，按上面每条提示改。');
        console.error('  完整步骤见 docs/upstream-sync.md。\n');
        process.exit(1);
    }

    console.log(
        `[style-sync] ✓ 上游 ${upstream.rows.length} 个样式（order ${upstream.rows[0].order} → `
        + `${upstream.rows[upstream.rows.length - 1].order}），本地清单与上游一致：\n`
        + `    ${fmt(expected)}\n`
        + '  已核对：STYLE_ENTRIES（order/labelKey/thumb/beatEffects）、StyleMode、STYLE_MODE_SHELF_ORDER、\n'
        + '          STYLE_TUNING_KEYS、STYLE_COMPAT、STYLE_MODES、make-thumbs MODES、make-style-grid MODES、\n'
        + '          Overlay.js MODES。',
    );
    if (notes.length > 0) for (const n of notes) console.log(`  · ${n}`);
};

main();
