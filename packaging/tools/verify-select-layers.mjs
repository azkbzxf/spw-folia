#!/usr/bin/env node
// Gate: issue #21 — every kit dropdown in the injected settings window must be USABLE, not merely
// present.
//
// ## What broke
//
// The injected island is one stacking context (`#spw-settings-ui-root`). Folia portals its floating
// layers to `<body>` as SIBLINGS of the island — `CustomSelect`'s option menu and `Sheet` at
// `z-[200]` (`components/shared/CustomSelectMenu.tsx`, `components/shared/Sheet.tsx`), kit
// `Tooltip` at `z-[210]`, `PonderStage` at `z-[220]`, the debug window at `z-[300]`. A sibling
// paints above the island only when its own z-index is larger, so while the island sat at
// 2147483000 EVERY ONE of those layers rendered BEHIND the settings window. The user-reported
// symptom was the narrowest one: 字幕 → 底部字幕行数 = 三行 → 第二行/第三行 的下拉「点了没反应」.
// The menu really opened (`aria-expanded` flipped, the listbox mounted) — it just painted under the
// window, so `elementFromPoint` over it returned the trigger of the row BEHIND it and the press
// never reached an option.
//
// ## What this asserts (and why each can fail)
//
// "the listbox exists" is deliberately NOT the assertion: it always existed, which is exactly why
// every previous check stayed green through this bug.
//
//   1. ISLAND BELOW THE POPUPS   island z-index < 200 — the level the menu itself uses
//   2. MENU IS ON TOP            elementFromPoint over the menu's centre is INSIDE the menu
//   3. OPTION IS HITTABLE        elementFromPoint over an option IS that option
//   4. VALUE ACTUALLY CHANGES    a real press on 下一句 moves 第二行 off 翻译
//   5. VALUE REACHES THE CONFIG  the published subtitleOverlayLayout starts with `current+`
//
//   node packaging/tools/verify-select-layers.mjs [--rebuild] [--keep]
//
// Exit 0 = PASS, 1 = FAIL, 2 = missing payload (`bash packaging/build-package.sh`).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'packaging');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);

const OUT = join(PKG, 'out', 'select-layers');
const exe = join(PKG, 'native', 'spw-folia-host.exe');
const SHIPPED_BUNDLE = join(PKG, 'web');
const ISLAND_DIST = join(PKG, 'web', 'settings');
const BUNDLE = join(OUT, 'bundle');

for (const p of [exe, join(SHIPPED_BUNDLE, 'index.html'), join(ISLAND_DIST, 'settings-ui.js')]) {
    if (!existsSync(p)) {
        console.error(`missing ${p}\n  run: bash packaging/build-package.sh`);
        process.exit(2);
    }
}
mkdirSync(OUT, { recursive: true });

/* The host serves `--settings-dir` same-origin only when it lives inside `--bundle`
 * (HostForm.cs, settingsInsideBundle), so assemble that tree exactly like the release does. */
const bundleIsland = join(BUNDLE, 'settings', 'settings-ui.js');
const islandBytes = readFileSync(join(ISLAND_DIST, 'settings-ui.js'));
const stale = !existsSync(bundleIsland) || !readFileSync(bundleIsland).equals(islandBytes);
if (flag('rebuild') || !existsSync(join(BUNDLE, 'index.html')) || stale) {
    console.log(`assembling ${BUNDLE} (shipped player page + packaged island) ...`);
    if (!existsSync(join(BUNDLE, 'index.html'))) {
        rmSync(BUNDLE, { recursive: true, force: true });
        mkdirSync(BUNDLE, { recursive: true });
        const linked = spawnSync('bash', ['-lc', `cp -al "${SHIPPED_BUNDLE}/." "${BUNDLE}/"`], { encoding: 'utf8' });
        if (linked.status !== 0) spawnSync('bash', ['-lc', `cp -a "${SHIPPED_BUNDLE}/." "${BUNDLE}/"`], { cwd: ROOT });
    }
    // rm + copy: `cp -a src dst` onto an existing directory would nest it and keep the old island.
    rmSync(join(BUNDLE, 'settings'), { recursive: true, force: true });
    const copied = spawnSync('bash', ['-lc', `cp -a "${ISLAND_DIST}" "${BUNDLE}/settings"`], { encoding: 'utf8' });
    if (copied.status !== 0) {
        console.error(`could not stage the island: ${copied.stderr || ''}`);
        process.exit(2);
    }
    if (!readFileSync(bundleIsland).equals(islandBytes)) {
        console.error(`bundle island did not update: ${bundleIsland}`);
        process.exit(2);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The host writes `{"t":"eval-result","value":"<escaped>"}` and WebView2 encodes the page's return
 *  value once more, so peel until a plain value comes out. */
const unwrap = (raw) => {
    let value = raw;
    for (let depth = 0; depth < 4; depth += 1) {
        if (typeof value !== 'string') break;
        const text = value.trim();
        if (!text) break;
        const head = text.charAt(0);
        if (head !== '{' && head !== '[' && head !== '"') break;
        try { value = JSON.parse(text); } catch { break; }
    }
    return value;
};

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + JSON.stringify(detail === undefined ? null : detail)}`);
    return !!ok;
};
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

const work = join(OUT, 'run');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const child = spawn(exe, [
    '--bundle', BUNDLE,
    '--settings-dir', join(BUNDLE, 'settings'),
    '--settings-entry', 'settings-ui.js',
    '--window', '1600x1000',
    '--user-data-dir', join(work, 'profile'),
    '--no-curtain',
    '--no-colour-key',
    '--open-settings',
    '--verbose-log',
    '--log-file', join(work, 'host.jsonl'),
], { cwd: PKG, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.on('error', () => {});

let buf = '';
let ready = false;
const waiters = new Map();
let evalSeq = 0;
const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };

/** Tagged eval so this probe's answers cannot be confused with the host's own evals. */
const evaluate = (body) => new Promise((r) => {
    evalSeq += 1;
    const tag = evalSeq;
    waiters.set(tag, r);
    const script = `(function(){ try { return { __probe: ${tag}, value: (function(){ ${body} })() }; } catch (e) { return { __probe: ${tag}, value: 'PROBE-ERROR: ' + (e && e.message) }; } })()`;
    send({ t: 'command', command: 'eval', script });
    setTimeout(() => { if (waiters.has(tag)) { waiters.delete(tag); r('PROBE-TIMEOUT'); } }, 15000);
});

child.stderr.on('data', () => {});
child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.t === 'ready' && !ready) {
            ready = true;
            void run();
        } else if (msg.t === 'eval-result') {
            const value = unwrap(msg.value);
            const tagged = value && typeof value === 'object' && typeof value.__probe === 'number' ? value : null;
            if (tagged) {
                const waiter = waiters.get(tagged.__probe);
                if (waiter) { waiters.delete(tagged.__probe); waiter(tagged.value); }
            }
        } else if (msg.t === 'log' && msg.level === 'error') {
            console.log(`[error] ${msg.msg}`);
        }
    }
});

const finish = (code) => {
    try { send({ t: 'command', command: 'close' }); } catch { /* gone */ }
    setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        if (!flag('keep')) {
            /* Best effort, and NEVER fatal. WebView2 keeps handles in the profile directory open for
             * a moment after the window closes; under `rmSync` that surfaces as ENOTEMPTY and, thrown
             * from this timer, it killed the process with exit 1 AFTER all 11 checks had passed —
             * a green run reported as red. The work directory is scratch inside packaging/out/ and is
             * erased on the next run anyway, so a leftover costs nothing; a false FAIL costs trust in
             * the gate. */
            try {
                rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
            } catch {
                console.log(`note  could not remove ${work} (still open); it is scratch, next run replaces it`);
            }
        }
        const failed = results.filter((r) => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        process.exit(code);
    }, 700);
};

/* Driving the page is done from Node in single, non-awaiting evals: `ExecuteScriptAsync` returns the
 * script's value as-is, so an in-page `await` comes back as a pending Promise and cannot be read.
 * Each step is its own eval with a settle delay between them, the same shape verify-click-zones.mjs
 * uses.
 *
 * The steps: open 字幕, switch 底部字幕行数 to 三行 (the per-row selects only exist then), scroll the
 * 第二行 row into view and let that scroll settle (a compact menu closes when the page under it
 * scrolls), then open the menu. */
const STEP_OPEN_TAB = `
    const tab = Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find((b) => (b.textContent || '').trim() === '字幕');
    if (!tab) return 'no 字幕 tab';
    tab.click();
    return 'ok';
`;

const STEP_THREE_ROWS = `
    const three = Array.from(document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="radio"]'))
        .find((b) => (b.textContent || '').trim() === '三行');
    if (!three) return 'no 三行 option';
    three.click();
    return 'ok';
`;

const STEP_SCROLL_ROW = `
    const rows = Array.from(document.querySelectorAll('[role="dialog"] [role="combobox"]'));
    if (rows.length < 1) return 'no rows to choose';
    rows[0].scrollIntoView({ block: 'center' });
    return 'ok';
`;

const STEP_OPEN_MENU = `
    const rows = Array.from(document.querySelectorAll('[role="dialog"] [role="combobox"]'));
    if (rows.length < 1) return 'no rows to choose';
    rows[0].click();
    return 'ok';
`;

/* Measure with elementFromPoint — "what would a real press hit here", which is the exact question
 * the old layering got wrong. The press on 下一句 happens here too, at the option's own point. */
const MEASURE = `
    const island = document.getElementById('spw-settings-ui-root');
    const menu = document.querySelector('[role="listbox"]');
    const rows = Array.from(document.querySelectorAll('[role="dialog"] [role="combobox"]'));
    const out = {
        islandZ: island ? getComputedStyle(island).zIndex : null,
        islandIsBodyChild: !!island && island.parentElement === document.body,
        rows: rows.map((e) => (e.textContent || '').trim()),
        menu: !!menu,
    };
    if (!menu) return JSON.stringify(out);
    const r = menu.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    out.menuRect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    out.menuZ = getComputedStyle(menu).zIndex;
    out.menuParentIsBody = menu.parentElement === document.body;
    out.hitInsideMenu = !!hit && menu.contains(hit);
    out.hitAtCentre = hit
        ? (hit.getAttribute('role') || hit.tagName) + ':' + (hit.textContent || '').replace(/\\s+/g, ' ').slice(0, 24)
        : null;
    const opts = Array.from(menu.querySelectorAll('[role="option"]'));
    out.options = opts.map((o) => (o.textContent || '').trim());
    const next = opts.find((o) => (o.textContent || '').trim() === '下一句');
    if (next) {
        const nr = next.getBoundingClientRect();
        const nx = Math.round(nr.left + nr.width / 2);
        const ny = Math.round(nr.top + nr.height / 2);
        const nhit = document.elementFromPoint(nx, ny);
        out.optionHittable = !!nhit && next.contains(nhit);
        out.optionHitAt = nhit ? (nhit.getAttribute('role') || nhit.tagName) : null;
        if (out.optionHittable) {
            ['mousedown', 'mouseup', 'click'].forEach((type) => nhit.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window, clientX: nx, clientY: ny,
            })));
        }
    }
    return JSON.stringify(out);
`;

/* `subtitleOverlayLayout` rides the published config as a TOP-LEVEL field (protocol §4; see
 * `buildConfig` in poc/settings-ui/src/publisher/config.ts) — the player page reads it from there,
 * not from a nested `subtitle` object. */
const READ_BACK = `
    const rows = Array.from(document.querySelectorAll('[role="dialog"] [role="combobox"]'));
    let config = null;
    try {
        const api = window.__SPW_FOLIA__;
        config = api && typeof api.lastConfig === 'function' ? api.lastConfig() : null;
    } catch (e) { /* no api */ }
    return JSON.stringify({
        rows: rows.map((e) => (e.textContent || '').trim()),
        layout: config ? config.subtitleOverlayLayout : null,
        publishes: (window.__spwFoliaPublishHistory || []).length,
    });
`;

async function run() {
    try {
        // Wait for the island to mount and the settings window to open.
        let mountedRaw = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
            await sleep(500);
            mountedRaw = await evaluate(`
                const island = document.getElementById('spw-settings-ui-root');
                return JSON.stringify({ island: !!island, dialog: document.querySelectorAll('[role="dialog"]').length });
            `);
            const seen = parse(mountedRaw);
            if (seen && seen.island && seen.dialog > 0) break;
        }
        const mountState = parse(mountedRaw);
        if (!record('settings window is open in the real host', Boolean(mountState) && mountState.dialog > 0, mountedRaw)) {
            return finish(1);
        }

        const step = async (label, script, settleMs) => {
            const answer = await evaluate(script);
            if (answer !== 'ok') return answer;
            await sleep(settleMs);
            return 'ok';
        };

        // The rows control is a Segmented, not a Select: the per-row dropdowns only exist once
        // 底部字幕行数 is 三行 (the shipped default layout is a single row).
        const opened = await step('tab', STEP_OPEN_TAB, 1600);
        if (!record('字幕 tab opens', opened === 'ok', opened)) return finish(1);
        const threeRows = await step('三行', STEP_THREE_ROWS, 2100);
        if (!record('底部字幕行数 = 三行 renders a 第二行 dropdown', threeRows === 'ok', threeRows)) return finish(1);
        // Scroll first, then open: a compact menu closes itself when the page under it scrolls.
        const scrolled = await step('scroll', STEP_SCROLL_ROW, 1000);
        if (!record('第二行 row can be scrolled into view', scrolled === 'ok', scrolled)) return finish(1);
        const menuOpened = await step('open', STEP_OPEN_MENU, 1100);
        if (!record('第二行 dropdown can be opened', menuOpened === 'ok', menuOpened)) return finish(1);

        const measured = parse(await evaluate(MEASURE));
        if (!record('the option menu is in the DOM', Boolean(measured) && measured.menu === true, measured)) {
            return finish(1);
        }

        // 1. The island must stay under Folia's portaled layers. 200 is the menu's own level, and
        //    being under it is the whole fix — so assert the number, not just "it works".
        const islandZ = Number(measured.islandZ);
        record(
            "island sits below Folia's portaled menus (z < 200)",
            Number.isFinite(islandZ) && islandZ < 200,
            { islandZ: measured.islandZ, menuZ: measured.menuZ, why: 'island > 200 paints every body-portaled menu behind the settings window' },
        );

        // 2. The menu must be the topmost thing at its own centre.
        record(
            'menu paints above the settings window and can be hit',
            measured.hitInsideMenu === true,
            { menuRect: measured.menuRect, hitAtCentre: measured.hitAtCentre, menuZ: measured.menuZ, islandZ: measured.islandZ },
        );

        // 3. An option must be the hit target at the option's own coordinates.
        record(
            'an option of the menu is the hit target',
            measured.optionHittable === true,
            { optionHitAt: measured.optionHitAt, options: measured.options },
        );

        // 4-5. The press happened inside MEASURE; read the result a tick later so React has committed.
        await sleep(1200);
        const after = parse(await evaluate(READ_BACK));
        record(
            'choosing 下一句 changes 第二行 off 翻译',
            Boolean(after) && Array.isArray(after.rows) && after.rows[0] === '下一句',
            { rowsBefore: measured.rows, rowsAfter: after && after.rows },
        );
        record(
            'the chosen rows reach the published config',
            Boolean(after) && typeof after.layout === 'string' && after.layout.startsWith('current+'),
            { layout: after && after.layout, publishes: after && after.publishes },
        );

        return finish(results.every((r) => r.ok) ? 0 : 1);
    } catch (error) {
        record('flow completed without throwing', false, String(error && error.stack ? error.stack : error));
        return finish(1);
    }
}

// The host never prints `ready` if the bundle cannot boot: fail loudly rather than hang forever.
setTimeout(() => {
    if (!ready) {
        record('host became ready', false, 'no {"t":"ready"} within 30 s — the bundle did not boot');
        finish(1);
    }
}, 30000);
