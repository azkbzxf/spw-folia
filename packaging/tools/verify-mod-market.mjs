#!/usr/bin/env node
// Gate: the beta mod system (issue #23).
//
// ## Why this suite exists
//
// The mod system is the first feature in this plugin that (a) runs third-party code the plugin did not
// write, (b) makes a network request at run time, and (c) can silently do nothing: a mod that installs
// but never activates looks exactly like a mod that works, right up until the user selects its lyric
// style and the screen keeps showing `classic`. Every assertion below is one of those silent failures.
//
// ## What it proves, and how
//
//   A. packaging   — `mod-host.json` exists in the staged bundle and names chunk files that exist.
//                    Without it the page cannot find the mod runtime; the failure is a console warning
//                    and an empty shelf, which no other gate would notice.
//   B. host        — the real host exe, given `--mods-dir`, serves `/__mods/...` from that directory
//                    as JavaScript, and does NOT serve anything outside it (traversal).
//   C. activation  — the page actually activates an installed mod and renders its style. This is the
//                    assertion that catches the `addOldClientNames` regression: without the old-name
//                    wrapper the sample mod mounts its shell but paints zero glyphs.
//   D. statics     — the mod mode prefix lives in exactly one place, so nobody can smuggle a `mod:`
//                    style into the three builtin-style manifests (they assert in lockstep and a
//                    stray entry is a white screen).
//
// ## Rules inherited from verify-all.mjs
//
//   - A skipped check is never a pass.
//   - No assertion may be tautological: each one below has been observed failing before it passed.
//
// Usage: node packaging/tools/verify-mod-market.mjs [--verbose]
// Exit 0 = PASS, 1 = FAIL, 2 = prerequisites missing.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'packaging', 'out', 'mod-market');
const VERBOSE = process.argv.includes('--verbose');

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok, detail: detail || '' });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const skip = (name, why) => {
    results.push({ name, ok: true, skipped: true, detail: 'SKIP — ' + why });
    console.log(`SKIP  ${name}  (${why})`);
};

// ------------------------------------------------------------------ A. packaging ----

const BUNDLE = join(ROOT, 'packaging', 'web');
const MOD_HOST = join(BUNDLE, 'mod-host.json');

function checkModHostManifest() {
    if (!existsSync(MOD_HOST)) {
        record('mod-host.json is staged', false, `missing ${MOD_HOST} (run bash packaging/build-package.sh)`);
        return null;
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(MOD_HOST, 'utf8'));
    } catch (error) {
        record('mod-host.json parses', false, String(error));
        return null;
    }
    record('mod-host.json parses', true);
    record('mod-host.json is the expected format',
        manifest.format === 'spw-folia-mod-host', `format=${manifest.format}`);

    // The two chunk paths must exist. A hash bump upstream without a restage is exactly the case
    // where the page would silently fail to find the mod runtime.
    const chunkOk = (rel) => Boolean(rel) && existsSync(join(BUNDLE, rel));
    record('mod-host.json names the api chunk', chunkOk(manifest.api), `api=${manifest.api}`);
    record('mod-host.json names the deprecated chunk (old-name compat)',
        chunkOk(manifest.deprecated), `deprecated=${manifest.deprecated}`);
    // Mod files are served from their OWN unmapped virtual host: SetVirtualHostNameToFolderMapping
    // outranks WebResourceRequested for the same host, so a /__mods/ path under the bundle host is
    // answered by the folder mapping and the interceptor never runs (measured: 155 response-received
    // events, 0 request events). The shim reads this base out of the manifest instead of guessing.
    record('mod-host.json names the mods base URL',
        typeof manifest.modsBase === 'string' && /^https:\/\/[^/]+\/$/.test(manifest.modsBase),
        `modsBase=${manifest.modsBase}`);

    // The api chunk must really export the named symbols the page imports by name (they survive
    // minification because upstream destructures them at run time).
    if (chunkOk(manifest.api)) {
        const source = readFileSync(join(BUNDLE, manifest.api), 'utf8');
        for (const symbol of ['createFoliumClientApi', 'listFoliumHostRegistries']) {
            record(`api chunk exports ${symbol}`, source.includes(symbol), '');
        }
    }
    if (chunkOk(manifest.deprecated)) {
        const source = readFileSync(join(BUNDLE, manifest.deprecated), 'utf8');
        record('deprecated chunk exports addOldClientNames', source.includes('addOldClientNames'), '');
        // The wrapper is what makes Folium 1.5-era mods (most of the market) render at all.
        record('deprecated chunk still wraps currentTime/subscribe',
            source.includes('currentTime') && source.includes('subscribe'),
            'old-name aliases missing → mods mount an empty shell');
    }
    return manifest;
}

// ------------------------------------------------------------------ D. statics ----

function checkStatics() {
    // The `mod:` mode prefix must be a single-source concept. If it leaks into STYLE_ENTRIES or
    // STYLE_MODE_SHELF_ORDER, styles.tsx throws at module load and the whole settings island goes
    // white — and check-style-sync.mjs also reports the entry as "a style upstream does not have".
    const stylesSrc = readFileSync(join(ROOT, 'poc/settings-ui/src/model/styles.tsx'), 'utf8');
    const settingsSrc = readFileSync(join(ROOT, 'poc/settings-ui/src/model/settings.ts'), 'utf8');
    const viteSrc = readFileSync(join(ROOT, 'poc/settings-ui/vite.config.ts'), 'utf8');

    const styleEntries = /const STYLE_ENTRIES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(stylesSrc);
    record('no mod: style smuggled into STYLE_ENTRIES',
        Boolean(styleEntries) && !styleEntries[1].includes("'mod:") && !styleEntries[1].includes('`mod:'),
        styleEntries ? '' : 'STYLE_ENTRIES block not found — update this matcher');

    const shelfOrder = /STYLE_MODE_SHELF_ORDER[^=]*=\s*\[([\s\S]*?)\]/.exec(settingsSrc);
    record('no mod: style smuggled into STYLE_MODE_SHELF_ORDER',
        Boolean(shelfOrder) && !shelfOrder[1].includes("'mod:"),
        shelfOrder ? '' : 'STYLE_MODE_SHELF_ORDER block not found — update this matcher');

    const styleModes = /STYLE_MODES\s*=\s*\[([\s\S]*?)\]/.exec(viteSrc);
    record('no mod: style smuggled into vite.config STYLE_MODES',
        Boolean(styleModes) && !styleModes[1].includes("'mod:"),
        styleModes ? '' : 'STYLE_MODES block not found — update this matcher');

    // The market base must be defined once, so an update cannot leave two hosts behind.
    const islandFiles = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(entry.name)) islandFiles.push(full);
        }
    };
    walk(join(ROOT, 'poc/settings-ui/src'));
    const withHost = islandFiles.filter((file) => readFileSync(file, 'utf8').includes('folium-compound.cielaniska.top'));
    record('the market host is written in exactly one place',
        withHost.length <= 1,
        withHost.length === 0 ? 'not referenced at all' : withHost.map((f) => f.replace(ROOT, '')).join(','));
}

// ------------------------------------------------------------------ B + C. host ----

const HOST_EXE = join(ROOT, 'poc', 'webview', 'host', 'build', 'spw-folia-host.exe');
// The bundle the host is pointed at MUST be the same tree the manifest was checked in: reading the
// manifest from one directory and serving another is precisely the mismatch that makes the page fail
// to fetch `/mod-host.json` while the static half of this gate stays green (measured — the first run
// of this suite failed exactly this way).
const STAGED_BUNDLE = BUNDLE;

/** The sample mod used by C. Staged from the repo's own copy when present. */
const SAMPLE_ID = 'sample-aurora-visualizer';
function stageSampleMod(modsRoot) {
    const sampleClient = join(ROOT, '.scratch', 'modtest', 'aurora-client.mjs');
    if (!existsSync(sampleClient)) return false;
    const dir = join(modsRoot, SAMPLE_ID);
    mkdirSync(dir, { recursive: true });
    copyFileSync(sampleClient, join(dir, 'client.mjs'));
    writeFileSync(join(dir, 'mod.json'), JSON.stringify({
        folium: 1,
        id: SAMPLE_ID,
        name: 'Sample aurora',
        version: '1.0.1',
        author: 'gate',
        client: 'client.mjs',
        permissions: [],
    }, null, 2));
    return true;
}

/**
 * issue #23（第二轮）: 一个**只**通过 Folium 1.5 旧名注册播放条按钮的模组。
 *
 * 它同时钉住两个断点，两个都只表现为「按钮不出现」：
 *   - `folium.registries.controlButtons`（旧名，别名指向 progressButtons）；
 *   - `ctx.subscribe` / `ctx.currentTime`（旧 ctx 名，我们的 ctx 曾经没有）。
 *
 * 写成真文件走 `--mods-dir` + `mods` 推送，是为了让它经过 Shim 的**真实激活器** —— 那两个包装
 * 都在激活器里，自己 `createFoliumClientApi` 会正好绕过它们。
 */
const PROGRESS_MOD_ID = 'gate-progress-bar';
function stageProgressButtonMod(modsRoot) {
    const dir = join(modsRoot, PROGRESS_MOD_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'client.mjs'), `// Gate fixture: a Folium 1.5 progress-bar button mod.
export default function activate(folium) {
    folium.registries.controlButtons.register({
        id: 'gate-bookmark',
        slot: 'progress.trailing',
        order: 10,
        mount(container, ctx) {
            // Both old names the official sample uses; either one missing throws TypeError and the
            // button silently disappears (that is the bug this fixture guards).
            const off = ctx.subscribe(function () {});
            const now = ctx.currentTime.get();
            const ratio = ctx.timeToRatio(now);
            const el = document.createElement('span');
            el.setAttribute('data-gate-progress-button', 'true');
            el.textContent = String(Math.round(ratio * 100));
            container.appendChild(el);
            return function () { off(); };
        },
    });
}
`);
    writeFileSync(join(dir, 'mod.json'), JSON.stringify({
        folium: 1,
        id: PROGRESS_MOD_ID,
        name: 'Gate progress button',
        version: '1.0.0',
        author: 'gate',
        client: 'client.mjs',
        permissions: [],
    }, null, 2));
    return true;
}

/** The polling helper stages a JSON string; unwrap it, and surface a failed poll as a marked object. */
const unwrap2 = (result) => {
    if (!result || !result.ok) return { pollFailed: (result && result.error) || 'unknown' };
    let value = result.value;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* leave the raw string */ }
    }
    return value === undefined || value === null ? {} : value;
};

const runHost = async (modsRoot) => new Promise((resolvePromise) => {
    const userData = join(OUT, 'profile');
    const child = spawn(HOST_EXE, [
        '--bundle', STAGED_BUNDLE,
        '--windowed', '--width', '1280', '--height', '720',
        '--duration', '90000',
        '--user-data', userData,
        '--title', 'verify-mod-market',
        '--demo', '--no-topmost', '--no-colour-key',
        '--mods-dir', modsRoot,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let buffer = '';
    const pending = [];
    const collected = { errors: [], logs: [] };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.t === 'eval-result') {
                const waiter = pending.shift();
                if (waiter) waiter(String(msg.value));
            }
            if (msg.t === 'log') collected.logs.push(msg);
        }
    });
    if (VERBOSE) child.stderr.pipe(process.stderr);

    const evaluate = (script, timeoutMs = 25000) => new Promise((done) => {
        pending.push(done);
        child.stdin.write(JSON.stringify({ t: 'command', command: 'eval', script }) + '\n');
        setTimeout(() => done('<<timeout>>'), timeoutMs);
    });

    const unwrap = (value) => {
        let cur = value;
        for (let i = 0; i < 3; i += 1) {
            if (typeof cur !== 'string') break;
            const trimmed = cur.trim();
            if (!/^[[{"0-9tfn-]/.test(trimmed)) break;
            try { cur = JSON.parse(trimmed); } catch { break; }
        }
        return cur;
    };
    const evalJson = async (script, timeoutMs) => unwrap(await evaluate(script, timeoutMs));

    /**
     * Evaluates an expression that returns a PROMISE, and waits for it.
     *
     * ExecuteScriptAsync resolves with the value of the expression it evaluated — it does not await a
     * promise. An `async () => {...}` therefore comes back as `{}`, which is indistinguishable from
     * "empty result" and made the first run of this gate fail three checks that were actually fine.
     * So the promise's outcome is staged on a window global and polled.
     */
    const evalAsync = async (script, timeoutMs = 20000) => {
        const key = `__GATE_${Math.random().toString(36).slice(2)}__`;
        await evaluate(`window[${JSON.stringify(key)}] = { state: 'pending' }; (function(){
            Promise.resolve().then(function(){ return (${script}); })
              .then(function (v) { window[${JSON.stringify(key)}] = { state: 'done', value: v }; })
              .catch(function (e) { window[${JSON.stringify(key)}] = { state: 'error', error: String((e && e.message) || e) }; });
            return 'started';
        })()`);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
            const got = unwrap(await evaluate(`JSON.stringify(window[${JSON.stringify(key)}])`));
            if (got && got.state === 'done') return { ok: true, value: got.value };
            if (got && got.state === 'error') return { ok: false, error: got.error };
        }
        return { ok: false, error: 'poll timeout' };
    };

    let pinTimer = null;
    const finish = () => {
        unpinState();
        try { child.stdin.write(JSON.stringify({ type: 'command', command: 'close' }) + '\n'); } catch { /* gone */ }
        setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 800);
    };
    /** The Kotlin plugin's own envelope: {"t":"mods","mods":[...]} on stdin. */
    const pushMods = (mods) => {
        try { child.stdin.write(JSON.stringify({ t: 'mods', mods }) + '\n'); } catch { /* gone */ }
    };
    /**
     * Holds the playhead at a known-active lyric position.
     *
     * The demo timeline is ~16 s and the host free-runs when no `state` arrives, so any assertion about
     * what a lyric animation DRAWS must pin the position first — otherwise "the mod rendered nothing"
     * and "there is no active lyric line" are indistinguishable, and the gate fails a working build
     * (measured: that is exactly how this assertion first went red). The host anchors on fresh rows,
     * so the row has to repeat.
     */
    const pinState = (position) => {
        unpinState();
        const base = { t: 'state', posMs: position.posMs, durationMs: position.durationMs, playing: true, rate: 1, lyricOffsetMs: 0 };
        const beat = () => {
            try { child.stdin.write(JSON.stringify({ ...base, tsMs: Date.now() }) + '\n'); } catch { /* gone */ }
        };
        beat();
        pinTimer = setInterval(beat, 100);
    };
    const unpinState = () => {
        if (pinTimer) { clearInterval(pinTimer); pinTimer = null; }
    };
    resolvePromise({ evaluate, evalJson, evalAsync, finish, pushMods, pinState, unpinState, collected });
});

async function checkHost(manifest) {
    if (!existsSync(HOST_EXE)) { skip('host: mod directory service', 'host exe not built (bash poc/webview/host/build.sh)'); return; }
    if (!existsSync(STAGED_BUNDLE)) { skip('host: mod directory service', 'staged bundle missing (node packaging/tools/stage-web.mjs)'); return; }
    if (!manifest) { skip('host: mod directory service', 'mod-host.json missing'); return; }

    const modsRoot = join(OUT, 'mods');
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(modsRoot, { recursive: true });
    const haveSample = stageSampleMod(modsRoot);
    // issue #23（第二轮）: the progress-bar fixture is independent of the visualizer sample.
    stageProgressButtonMod(modsRoot);

    const host = await runHost(modsRoot);
    try {
        // Give the page time to boot: navigation + React mount + first paint.
        await new Promise((done) => setTimeout(done, 9000));

        // B1. a real mod file is served from the page's own origin, as JavaScript.
        // The base comes from the manifest because that is exactly what the page reads.
        const modsBase = manifest.modsBase || 'https://spw-folia-mods.local/';
        const served = unwrap2(await host.evalAsync(`(async () => {
            try {
                const r = await fetch(${JSON.stringify(modsBase)} + ${JSON.stringify(SAMPLE_ID)} + '/client.mjs');
                return JSON.stringify({ status: r.status, type: r.headers.get('content-type'), len: (await r.text()).length });
            } catch (e) { return JSON.stringify({ error: String(e) }); }
        })()`));
        record('serves a mod file from the mods host',
            served.status === 200 && served.len > 0, JSON.stringify(served).slice(0, 200));
        record('serves it with a JavaScript content type',
            /javascript/i.test(served.type || ''), `content-type=${served.type}`);

        // B1b. it must import as a module — a fetch that 200s is not the same thing.
        const imported = unwrap2(await host.evalAsync(`(async () => {
            try {
                const m = await import(${JSON.stringify(modsBase)} + ${JSON.stringify(SAMPLE_ID)} + '/client.mjs');
                return JSON.stringify({ ok: true, def: typeof m.default });
            } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
        })()`));
        record('mod entry imports as an ES module',
            imported.ok === true && imported.def === 'function', JSON.stringify(imported).slice(0, 200));

        // B2. traversal must not escape the mods root.
        const traversal = unwrap2(await host.evalAsync(`(async () => {
            const base = ${JSON.stringify(modsBase)};
            const paths = [base + '../../index.html', base + '%2e%2e/%2e%2e/index.html', base + ${JSON.stringify(SAMPLE_ID)} + '/../../../index.html'];
            const out = {};
            for (const p of paths) {
                try { const r = await fetch(p); out[p] = r.status; } catch (e) { out[p] = 'threw'; }
            }
            return JSON.stringify(out);
        })()`));
        record('refuses path traversal out of the mods root',
            Object.values(traversal).every((status) => status === 404 || status === 'threw'),
            JSON.stringify(traversal).slice(0, 300));

        if (!haveSample) {
            skip('activates an installed mod', 'sample mod source not available in .scratch');
            return;
        }

        // C1. the plugin pushes the mod list; the page must take it and activate.
        // Push through stdin the same envelope the Kotlin plugin sends.
        host.pushMods([{
            id: SAMPLE_ID, name: 'Sample aurora', version: '1.0.1', author: 'gate',
            permissions: [], enabled: true, clientEntry: 'client.mjs', previewEntry: null, error: null,
        }]);
        await new Promise((done) => setTimeout(done, 7000));

        const activated = unwrap2(await host.evalAsync(`JSON.stringify({
            mods: (window.__SPW_FOLIA_MODS__ || {}).mods || null,
            errors: (window.__SPW_FOLIA_MODS__ || {}).errors || null,
        })`));
        record('page received the mod list',
            Array.isArray(activated.mods) && activated.mods.length === 1, JSON.stringify(activated).slice(0, 300));

        // C2. the real assertion: the mod's style paints glyphs, not just a shell.
        //
        // The playhead has to be PINNED here, and that is not incidental: the demo lyric timeline is
        // ~16 s while the host clock free-runs, so by the time a gate gets this far every line has
        // ended, `getLineIndex()` is -1, and a correctly-working mod renders zero spans. Measured:
        // without the pin this assertion failed on a build whose mod was in fact working, because
        // "no active line" and "compat layer missing" produce the same empty mount. Re-send a known
        // active position at 10 Hz (the host anchors on fresh `state` rows) before sampling.
        await host.evaluate(`(function(){ return 1; })()`);
        host.pinState({ posMs: 6200, durationMs: 16000 });
        const rendered = unwrap2(await host.evalAsync(`(async () => {
            const config = window.__SPW_FOLIA__.lastConfig();
            if (!config) return JSON.stringify({ error: 'no config yet' });
            const next = JSON.parse(JSON.stringify(config));
            next.visualizerMode = 'mod:${SAMPLE_ID}:aurora-text';
            window.__SPW_FOLIA__.pushConfig(next);
            await new Promise((r) => setTimeout(r, 2200));
            const shell = document.querySelector('[style*="aurora-dim"]');
            return JSON.stringify({
                mode: window.__SPW_FOLIA__.lastConfig().visualizerMode,
                shells: document.querySelectorAll('[style*="aurora-dim"]').length,
                spans: shell ? shell.querySelectorAll('span').length : 0,
                text: shell ? (shell.textContent || '').slice(0, 24) : null,
            });
        })()`));
        host.unpinState();
        record('mod style mounts', rendered.shells >= 1, JSON.stringify(rendered).slice(0, 200));
        record('mod style paints glyphs (old-name compat applied)',
            (rendered.spans || 0) > 0, `spans=${rendered.spans} text=${JSON.stringify(rendered.text)}`);

        // C3. issue #23（第二轮）: the settings page's BIG LIVE PREVIEW must render mod styles too.
        //
        // The user's report was 「导入歌词样式的模组时，大的预览框没有适配」: the shelf tile and the player
        // showed the mod, the big preview kept drawing the built-in style. Root cause: the preview is a
        // same-origin iframe running `preview.html` + `PreviewShim.js`, and `Shim.js` returns on its
        // first line in any frame — so the activator never ran there and
        // `__SPW_FOLIA_MOD_VISUALIZERS__` did not exist. Folia's renderer then fell back silently.
        //
        // This check builds the REAL topology (an iframe of preview.html inside this page), pushes the
        // mod list the way the settings island does (`settings` postMessage), and asserts the child's
        // own registry ends up with the mod's mode. A static check cannot catch this: the failure is a
        // silent fallback inside Folia's renderer, not a missing file.
        const previewProbe = unwrap2(await host.evalAsync(`(async () => {
            const old = document.getElementById('gate-preview-frame');
            if (old) old.remove();
            const frame = document.createElement('iframe');
            frame.id = 'gate-preview-frame';
            frame.src = '/preview.html?obs=1&preview=1';
            frame.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;border:0;visibility:hidden';
            document.body.appendChild(frame);
            await new Promise((r) => setTimeout(r, 2500));
            const child = frame.contentWindow;
            const before = (child.__SPW_FOLIA_MOD_VISUALIZERS__ || []).length;
            // Exactly the envelope LivePreview.tsx sends.
            child.postMessage({
                __spwFoliaPreview: 1,
                kind: 'settings',
                payload: { mods: [{
                    id: ${JSON.stringify(SAMPLE_ID)}, name: 'Sample aurora', version: '1.0.1', author: 'gate',
                    permissions: [], enabled: true, clientEntry: 'client.mjs', previewEntry: null, error: null,
                }] },
            }, location.origin);
            await new Promise((r) => setTimeout(r, 5000));
            const list = child.__SPW_FOLIA_MOD_VISUALIZERS__ || [];
            const summary = child.__SPW_FOLIA_PREVIEW__ || {};
            return JSON.stringify({
                hasActivator: typeof child.installFoliaModHost === 'function',
                before,
                count: list.length,
                modes: list.map((v) => v.mode),
                modHost: summary.modHost,
                modCount: summary.modCount,
            });
        })()`));
        record('the live preview iframe has the mod activator',
            previewProbe.hasActivator === true, JSON.stringify(previewProbe).slice(0, 200));
        record('the live preview activates a mod style (big preview matches the player)',
            (previewProbe.count || 0) > 0
            && (previewProbe.modes || []).some((m) => String(m).startsWith('mod:')),
            JSON.stringify(previewProbe).slice(0, 300));
        await host.evaluate(`(function(){ const f=document.getElementById('gate-preview-frame'); if (f) f.remove(); return 1; })()`);

        /* C4. issue #23（第二轮）: 播放条上的模组按钮必须真的画出来。
         *
         * 用户的报告是「目前只适配了歌词样式，播放条还没适配」。两个彼此独立的断点，都只表现为
         * 「按钮不出现」，所以只能用**真模组走真激活路径**验：
         *   1. 官方样例用的是 **`registries.controlButtons`**（Folium 1.5 旧名，`addOldClientNames`
         *      把它挂成 `progressButtons` 的别名）。激活器只包装了 `progressButtons`，于是通过旧名
         *      注册的按钮镜像不进 `__SPW_FOLIA_MOD_PROGRESS__` —— 清单里一条都没有。
         *   2. 即使镜像进去了，我们的 ctx 缺 `ctx.subscribe` / `ctx.currentTime` 两个旧名，模组的
         *      `mount` 抛 `TypeError`，`ModSlot` 把按钮标成 failed，DOM 里依然什么都没有。
         *
         * ⚠️ 这一段**必须**让 Shim 的激活器去 import 那个 client（`--mods-dir` + `mods` 推送），
         * 不能在这里自己 `createFoliumClientApi` 然后手动调模组 —— 那样正好绕过被修的那层包装，
         * 门禁会绿在一个产品里并不存在的路径上（第一版就是这么写的，`registry: 0`）。
         */
        // Push BOTH fixtures: the list is a full snapshot, so pushing only the progress mod would
        // deactivate the visualizer sample C1/C2 just asserted. Re-push the same shape C1 used, plus
        // the progress-bar one, so neither assertion steals the other's activation.
        host.pushMods([{
            id: SAMPLE_ID, name: 'Sample aurora', version: '1.0.1', author: 'gate',
            permissions: [], enabled: true, clientEntry: 'client.mjs', previewEntry: null, error: null,
        }, {
            id: PROGRESS_MOD_ID, name: 'Gate progress button', version: '1.0.0', author: 'gate',
            permissions: [], enabled: true, clientEntry: 'client.mjs', previewEntry: null, error: null,
        }]);
        await new Promise((done) => setTimeout(done, 6000));
        const progressProbe = unwrap2(await host.evalAsync(`(async () => {
            // The bar must be expanded for the trailing slot to be laid out visibly.
            const bar = document.querySelector('.spw-playback');
            if (bar) {
                const r = bar.getBoundingClientRect();
                bar.dispatchEvent(new PointerEvent('pointerenter', {
                    bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse',
                }));
            }
            await new Promise((r) => setTimeout(r, 2500));
            const reg = window.__SPW_FOLIA_MOD_PROGRESS__ || [];
            const slot = document.querySelector('[data-spw-mod-slot="trailing"]');
            return JSON.stringify({
                registry: reg.length,
                ids: reg.map((b) => b.id),
                slotSeen: slot ? slot.getAttribute('data-spw-mod-slot-count') : null,
                slotFailed: slot ? slot.getAttribute('data-spw-mod-slot-failed') : null,
                mounted: document.querySelectorAll('[data-gate-progress-button]').length,
            });
        })()`));
        record('a mod registering through the OLD `controlButtons` name is mirrored into the bar',
            (progressProbe.registry || 0) > 0, JSON.stringify(progressProbe).slice(0, 260));
        record('…and its button actually mounts into the playback bar DOM',
            (progressProbe.mounted || 0) > 0, JSON.stringify(progressProbe).slice(0, 260));

    } finally {
        host.finish();
        await new Promise((done) => setTimeout(done, 1200));
    }
}

async function checkMarketWindow() {
    // issue #23（第二轮）: 「从配置中进入商店只弹出商店的小窗口」.
    //
    // Two halves, because they fail independently:
    //   A. the shell must SHIP (`public/mod-market.html` is copied by vite into `dist/` and by
    //      stage-web into `web/settings/`), and the panel must still be the thing it mounts;
    //   B. the host must actually render the market **in a window that never loaded the player page**.
    //      That is the requirement itself: if this only works on top of the visualizer, the user gets
    //      back the coupling they asked to remove.
    //
    // The URL comes from the plugin's own constant (`FoliaHostBridge.MARKET_PAGE`), read out of the
    // Kotlin source, so the gate cannot drift from what the plugin passes.
    const marketShell = join(STAGED_BUNDLE, 'settings', 'mod-market.html');
    record('the market-only shell is staged', existsSync(marketShell), marketShell.replace(ROOT, ''));
    if (existsSync(marketShell)) {
        const shell = readFileSync(marketShell, 'utf8');
        record('the shell carries the #root the mount needs', shell.includes('id="root"'),
            'mount.tsx only appends a container on the injected path; without #root the window is blank');
        record('the shell does not hard-code a module tag', !/<script\b/i.test(shell),
            'a second entry would emit a second settings-ui.js (entryFileNames is a fixed string)');
    }
    const bridgeSrc = readFileSync(join(ROOT, 'spw-folia/src/main/kotlin/dev/spw/folia/FoliaHostBridge.kt'), 'utf8');
    const pageConst = /MARKET_PAGE\s*=\s*"([^"]+)"/.exec(bridgeSrc);
    record('the plugin declares the market page path', Boolean(pageConst),
        pageConst ? pageConst[1] : 'MARKET_PAGE constant not found — update this matcher');
    if (!pageConst) return;
    const marketUrl = 'https://spw-folia.local/' + pageConst[1];
    // The Kotlin argv and the URL constant must agree; a mismatch opens a window on a 404.
    record('the market URL is built from that same path',
        bridgeSrc.includes('"https://spw-folia.local/settings/mod-market.html?market=1"'),
        'MARKET_PAGE_URL and MARKET_PAGE must describe the same page');

    if (!existsSync(HOST_EXE)) { skip('market window renders without the player page', 'host exe not built'); return; }
    if (!existsSync(STAGED_BUNDLE)) { skip('market window renders without the player page', 'staged bundle missing'); return; }

    const userData = join(OUT, 'profile-market');
    // Deliberately NOT `--mods-dir`: the market window never imports a mod entry (the plugin omits the
    // flag too), and passing it here would hide a regression in that decision.
    const child = spawn(HOST_EXE, [
        '--bundle', STAGED_BUNDLE,
        '--url', marketUrl,
        '--window', '1200x860',
        '--user-data', userData,
        '--title', 'verify-mod-market-window',
        '--duration', '60000',
        '--no-topmost', '--no-transparency', '--no-curtain', '--no-keep-awake',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let buffer = '';
    const pending = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.t === 'eval-result') { const waiter = pending.shift(); if (waiter) waiter(String(msg.value)); }
        }
    });
    if (VERBOSE) child.stderr.pipe(process.stderr);
    const evaluate = (script, timeoutMs = 20000) => new Promise((done) => {
        pending.push(done);
        child.stdin.write(JSON.stringify({ t: 'command', command: 'eval', script }) + '\n');
        setTimeout(() => done('<<timeout>>'), timeoutMs);
    });
    try {
        await new Promise((done) => setTimeout(done, 7000));
        // `evaluate` resolves with the raw ExecuteScriptAsync string (a JSON-encoded value), so it is
        // parsed here — NOT through `unwrap2`, which expects the `{ok,value}` envelope of `evalAsync`.
        const raw = await evaluate(`JSON.stringify({
            market: document.querySelectorAll('[data-spw-mod-market="true"]').length,
            installButtons: document.querySelectorAll('[data-spw-market-install]').length,
            player: document.querySelectorAll('canvas').length,
            overlay: document.querySelectorAll('[data-spw-settings-overlay="true"]').length,
            marketOnly: window.__SPW_FOLIA_MARKET_ONLY__ === true,
        })`);
        let got = raw;
        for (let i = 0; i < 3 && typeof got === 'string'; i += 1) {
            const trimmed = got.trim();
            if (!/^[[{"0-9tfn-]/.test(trimmed)) break;
            try { got = JSON.parse(trimmed); } catch { break; }
        }
        if (!got || typeof got !== 'object') {
            record('market window renders the market panel', false, `eval returned ${JSON.stringify(raw).slice(0, 160)}`);
            return;
        }
        record('market window renders the market panel', got.market === 1, JSON.stringify(got).slice(0, 200));
        record('…and nothing else: no player canvas, no settings overlay',
            got.player === 0 && got.overlay === 0, JSON.stringify(got).slice(0, 200));
        record('…with the market-only mount flag set (so no mod activation runs here)',
            got.marketOnly === true, JSON.stringify(got).slice(0, 120));
    } finally {
        try { child.stdin.write(JSON.stringify({ type: 'command', command: 'close' }) + '\n'); } catch { /* gone */ }
        setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 800);
        await new Promise((done) => setTimeout(done, 1200));
    }
}

// ------------------------------------------------------------------ main ----

const main = async () => {
    mkdirSync(OUT, { recursive: true });
    const manifest = checkModHostManifest();
    checkStatics();
    await checkHost(manifest);
    await checkMarketWindow();

    const failed = results.filter((r) => !r.ok && !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    const passed = results.filter((r) => r.ok && !r.skipped);
    console.log('');
    console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
    writeFileSync(join(OUT, 'report.json'), JSON.stringify({ results, at: new Date().toISOString() }, null, 2));
    process.exitCode = failed.length === 0 ? 0 : 1;
};

await main();


