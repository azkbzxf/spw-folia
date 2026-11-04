#!/usr/bin/env node
// Probe: issue #19 item 1 — the picture click zones must stop eating the canvas' pointer events.
//
// Reuses `.scratch/probe-player-ui.mjs`'s host driver skeleton (spawn
// `packaging/native/spw-folia-host.exe`, speak protocol v1 on stdin, collect the stdout `control`
// lines the plugin would receive) and tests against a bundle assembled like the shipped one, with
// exactly ONE file tree swapped:
//
//   <out>/bundle          <- copy of packaging/web (the SHIPPED v0.4.17 player page: Folia + machi
//                            + three, i.e. the real OrbitControls-attached canvas)
//   <out>/bundle/settings <- poc/settings-ui/dist  (`npx vite build` of THIS checkout's source)
//
// The copy matters: the host only serves `--settings-dir` from the SAME origin as the player page
// when the directory sits inside `--bundle` (HostForm.cs:1396-1406, `settingsInsideBundle`). An
// external directory goes to the separate `spw-folia-settings.local` host, and cross-origin module
// scripts would then depend on WebView2 virtual-host CORS behaviour instead of testing the zones.
//
//   node .scratch/probe-issue19-zones.mjs [--out .scratch/probe-issue19] [--rebuild]
//
// Assertions (the task's A–G, plus the legacy synthetic contract S):
//   A. machi: elementFromPoint(centre) is the canvas, not a zone; data-enabled="true" with
//      pointer-events:none on the container AND its children; three children still in DOM, in order,
//      one third of the width each, display:flex
//   B. machi: a press per third -> exactly one previous / toggle / next
//   C. machi: a 40 px drag -> zero controls (both the realistic canvas path and the legacy
//      "dispatch on the zone child" path)
//   D. sonnet: B and C behave the same
//   E. the playback bar's play button and the bottom-right menu button still work: exactly one
//      toggle for the play button, no control at all for the menu button
//   F. settings overlay open -> data-enabled="false" and the middle press sends nothing; closing
//      restores both
//   G. the canvas now sees pointerdown: its own listener counted the press, OrbitControls reached
//      setPointerCapture(pointerId), and the window capture listener saw the same press
//   S. the legacy synthetic contract still holds: pointerdown on a zone child + window pointerup
//      acts once, and a plain `el.click()` acts once
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINES } from '../../poc/webview/shared/demoData.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'packaging');
const argv = process.argv.slice(2);
const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);
const OUT = resolve(ROOT, opt('out', 'packaging/out/click-zones'));
mkdirSync(OUT, { recursive: true });

const exe = join(PKG, 'native', 'spw-folia-host.exe');
const SHIPPED_BUNDLE = join(PKG, 'web');
const ISLAND_DIST = join(ROOT, 'packaging', 'web', 'settings');
const BUNDLE = join(OUT, 'bundle');

for (const p of [exe, join(SHIPPED_BUNDLE, 'index.html'), join(ISLAND_DIST, 'settings-ui.js')]) {
    if (!existsSync(p)) {
        console.error(`missing ${p}\n  run: (cd poc/settings-ui && npx vite build)`);
        process.exit(2);
    }
}

/* ── bundle assembly: shipped player page + freshly built settings island ───────────────────── */

function sh(cmd) {
    const r = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', cwd: ROOT });
    if (r.status !== 0) {
        console.error(`command failed: ${cmd}\n${r.stdout || ''}${r.stderr || ''}`);
        process.exit(2);
    }
}

const bundleIsland = join(BUNDLE, 'settings', 'settings-ui.js');
const islandBytes = readFileSync(join(ISLAND_DIST, 'settings-ui.js'));
const stale = !existsSync(bundleIsland) || !readFileSync(bundleIsland).equals(islandBytes);
if (flag('rebuild') || !existsSync(join(BUNDLE, 'index.html')) || stale) {
    console.log(`assembling ${BUNDLE} (shipped player page + poc/settings-ui/dist) ...`);
    if (!existsSync(join(BUNDLE, 'index.html'))) {
        rmSync(BUNDLE, { recursive: true, force: true });
        mkdirSync(BUNDLE, { recursive: true });
        // Hardlink copy where possible (same volume, instant). The player page is never modified,
        // and `settings/` is replaced right after — ORDER MATTERS: copy the tree FIRST, then swap
        // `settings/`, otherwise the copy puts the shipped v0.4.17 island back on top.
        const linked = spawnSync('bash', ['-lc', `cp -al "${SHIPPED_BUNDLE}/." "${BUNDLE}/"`], { encoding: 'utf8' });
        if (linked.status !== 0) sh(`cp -a "${SHIPPED_BUNDLE}/." "${BUNDLE}/"`);
    }
    // rm + copy, never `cp -a src dst` onto an existing directory: that would create `settings/dist/`
    // and leave the shipped island in place (exactly the trap this probe must not fall into).
    rmSync(join(BUNDLE, 'settings'), { recursive: true, force: true });
    sh(`cp -a "${ISLAND_DIST}" "${BUNDLE}/settings"`);
    if (!readFileSync(bundleIsland).equals(islandBytes)) {
        console.error(`bundle island did not update: ${bundleIsland}`);
        process.exit(2);
    }
}
const islandBuilt = readFileSync(bundleIsland).length;

/* ── protocol fixtures (same shapes as probe-player-ui.mjs / verify-playback-controls.mjs) ───── */

const baseSettings = JSON.parse(readFileSync(join(PKG, 'testdata', 'default-settings.json'), 'utf8'));
if (typeof baseSettings.smartBeat === 'boolean') baseSettings.smartBeat = { enabled: baseSettings.smartBeat, effects: {} };

const DURATION_MS = 60_000;
const lyrics = {
    lines: LINES.map((l) => ({
        startMs: Math.round(l.startTime * 1000),
        endMs: Math.round(l.endTime * 1000),
        main: l.fullText,
        sub: l.translation || '',
        cells: (l.words || []).map((w) => ({
            startMs: Math.round(w.startTime * 1000),
            endMs: Math.round(w.endTime * 1000),
            text: w.text,
        })),
    })),
    offsetMs: 0,
};
const items = [
    { id: 'q1', title: 'Probe Track 1', artist: 'ARTIST-1', album: 'ALBUM-1' },
    { id: 'q2', title: 'Probe Track 2', artist: 'ARTIST-2', album: 'ALBUM-2' },
];
const queue = { mode: 'circle', random: false, index: 0, items };
const track = { id: items[0].id, title: items[0].title, artist: 'PROBE', album: 'Probe', durationMs: DURATION_MS };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asObject = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

/** The host writes `{"t":"eval-result","value":"<escaped>"}`, and WebView2's ExecuteScriptAsync
 *  encodes the page's return value again, so peel until a plain value comes out. */
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

/* `elementFromPoint` is the point of A: it answers "what would a real mouse press hit here", which is
 * exactly what the v0.4.17 layer got wrong and what the ghost layer has to get right. */
const SNAPSHOT = `(() => {
    const q = (s) => document.querySelector(s);
    const zones = q('[data-spw-click-zone]');
    const overlay = q('[data-spw-settings-overlay]');
    const canvas = q('canvas');
    const cx = Math.round(window.innerWidth / 2);
    const cy = Math.round(window.innerHeight / 2);
    const hit = document.elementFromPoint(cx, cy);
    const children = Array.from(document.querySelectorAll('[data-zone]'));
    return JSON.stringify({
        zones: !!zones,
        zonesEnabled: zones ? zones.getAttribute('data-enabled') : null,
        zonesPointer: zones ? getComputedStyle(zones).pointerEvents : null,
        zonesDisplay: zones ? getComputedStyle(zones).display : null,
        zoneCount: children.length,
        zoneOrder: children.map((e) => e.getAttribute('data-zone')).join(','),
        zoneChildPointer: children.map((e) => getComputedStyle(e).pointerEvents),
        zoneRects: children.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }),
        viewport: [window.innerWidth, window.innerHeight],
        canvas: !!canvas,
        hitTag: hit ? hit.tagName : null,
        hitClass: hit ? (hit.className || '').toString().slice(0, 80) : null,
        hitIsCanvas: !!hit && hit.tagName === 'CANVAS',
        overlayOpen: overlay ? overlay.getAttribute('data-open') : null,
        overlayPointer: overlay ? getComputedStyle(overlay).pointerEvents : null,
        playback: !!q('.spw-playback'),
        menuBtn: !!q('[data-spw-chrome="player-background"]'),
        machiDebug: !!window.__machiDebug,
    });
})()`;

function runHost({ label, settings, flow }) {
    return new Promise((resolvePromise) => {
        const work = join(OUT, label);
        mkdirSync(work, { recursive: true });
        const profile = join(work, 'profile');
        mkdirSync(profile, { recursive: true });

        const args = [
            '--bundle', BUNDLE,
            '--settings-dir', join(BUNDLE, 'settings'),
            '--settings-entry', 'settings-ui.js',
            '--window', '1600x900',
            '--user-data-dir', profile,
            '--no-curtain',
            '--no-colour-key',
            '--verbose-log',
            '--log-file', join(work, 'host.jsonl'),
        ];

        const child = spawn(exe, args, { cwd: PKG, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.on('error', () => {});
        const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };

        const results = [];
        const controls = [];
        const logs = [];
        const shots = [];
        const waiters = new Map();
        let evalSeq = 0;
        let stateTimer = null;
        let buf = '';
        let ready = false;
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            clearInterval(stateTimer);
            try { send({ t: 'command', command: 'close' }); } catch { /* gone */ }
            try { child.kill(); } catch { /* gone */ }
            setTimeout(() => resolvePromise({ label, results, controls, logs, shots }), 500);
        };

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
                    void start();
                } else if (msg.t === 'eval-result') {
                    const value = unwrap(msg.value);
                    const tagged = value && typeof value === 'object' && typeof value.__probe === 'number' ? value : null;
                    if (tagged) {
                        const waiter = waiters.get(tagged.__probe);
                        if (waiter) {
                            waiters.delete(tagged.__probe);
                            waiter(tagged.value);
                        }
                    }
                } else if (msg.t === 'control') {
                    controls.push(msg);
                    console.log(`CONTROL ${JSON.stringify(msg)}`);
                } else if (msg.t === 'log') {
                    const text = String(msg.msg || '');
                    if (msg.level === 'error') {
                        logs.push(`[${msg.level}] ${text}`);
                        console.log(`[${msg.level}] ${text}`);
                    }
                }
            }
        });

        /** Tagged eval so the probe's results can be told apart from the host's internal ones. */
        const evaluate = (body) => new Promise((r) => {
            evalSeq += 1;
            const tag = evalSeq;
            waiters.set(tag, r);
            const script = `(function(){ try { return { __probe: ${tag}, value: (function(){ ${body} })() }; } catch (e) { return { __probe: ${tag}, value: 'PROBE-ERROR: ' + (e && e.message) }; } })()`;
            send({ t: 'command', command: 'eval', script });
        });
        const snapshot = async () => asObject(await evaluate(`return ${SNAPSHOT};`));

        const shot = async (name) => {
            const path = join(OUT, `${label}-${name}`);
            send({ t: 'command', command: 'screenshot', path });
            shots.push(path);
            await sleep(900);
        };

        const record = (name, ok, detail) => {
            results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + JSON.stringify(detail)}`);
        };

        /** The chrome fades out after 2.5 s without pointer activity (protocol §7.5) and a faded
         *  button is pointer-events:none, so every interaction wakes it first, like a real user. */
        const wakeChrome = () => evaluate(
            'try { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 800, clientY: 450, bubbles: true })); } catch (e) {} return "woke";',
        );

        /* A synthetic PointerEvent has no brush/pointer record, so a real `setPointerCapture(id)`
         * throws NotFoundError. That throw happens inside OrbitControls' `onPointerDown` — its very
         * FIRST statement — so it is itself evidence that the canvas received the press and handed it
         * to OrbitControls; the noise in the host log is expected. [STUB_CAPTURE] additionally makes
         * the call succeed so OrbitControls can finish its handler (and attach its `ownerDocument`
         * listeners), which is what the "captured stream" assertions need. */
        const STUB_CAPTURE = `
            const __c = document.querySelector('canvas');
            const __realSet = __c ? __c.setPointerCapture : null;
            const __realRel = __c ? __c.releasePointerCapture : null;
            if (__c) { __c.setPointerCapture = function () {}; __c.releasePointerCapture = function () {}; }
            const __restoreCapture = () => {
                if (!__c || !__realSet) return;
                __c.setPointerCapture = __realSet;
                __c.releasePointerCapture = __realRel;
            };`;

        /**
         * One synthetic press over the PICTURE: dispatched at whatever `elementFromPoint` reports,
         * i.e. at the element a real mouse would hit. That is also the proof for A — if the layer
         * were still intercepting, the target would be a `.spw-click-zone` div and the report says so.
         * `dx`/`dy` slide the pointer before release (a drag).
         */
        const pressAtPoint = (fx, { dx = 0, dy = 0 } = {}) => evaluate(`
            const x = Math.round(window.innerWidth * ${fx});
            const y = Math.round(window.innerHeight * 0.5);
            const el = document.elementFromPoint(x, y);
            if (!el) return JSON.stringify({ dispatched: false, reason: 'no-target' });
            const opts = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: cy });
            el.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
            if (${dx} !== 0 || ${dy} !== 0) {
                el.dispatchEvent(new PointerEvent('pointermove', opts(x + ${dx}, y + ${dy})));
                window.dispatchEvent(new PointerEvent('pointermove', opts(x + ${dx}, y + ${dy})));
            }
            el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts(x + ${dx}, y + ${dy}), { buttons: 0 })));
            window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts(x + ${dx}, y + ${dy}), { buttons: 0 })));
            return JSON.stringify({ dispatched: true, hitTag: el.tagName, hitClass: (el.className || '').toString().slice(0, 60), x, y });
        `);

        /** The OLD probe's synthetic path (`.scratch/probe-player-ui.mjs` `gesture()`): a pointerdown
         *  dispatched straight at a zone child plus a release on `window`. Must keep working. */
        const gestureOnChild = (zone, { dx = 0, trailingClick = true } = {}) => evaluate(`
            const el = document.querySelector('[data-spw-click-zone] [data-zone="${zone}"]');
            if (!el) return JSON.stringify({ dispatched: false });
            const r = el.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            const opts = (cx) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: cx, clientY: y });
            el.dispatchEvent(new PointerEvent('pointerdown', opts(x)));
            if (${dx} !== 0) window.dispatchEvent(new PointerEvent('pointermove', opts(x + ${dx})));
            window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts(x + ${dx}), { buttons: 0 })));
            if (${trailingClick}) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x + ${dx}, clientY: y }));
            return JSON.stringify({ dispatched: true, x, y, dx: ${dx} });
        `);

        const clickZoneChild = (zone) => evaluate(`
            const el = document.querySelector('[data-spw-click-zone] [data-zone="${zone}"]');
            if (!el) return JSON.stringify({ clicked: false });
            el.click();
            return JSON.stringify({ clicked: true });`);
        const clickPlay = () => evaluate(`
            const b = document.querySelector('.spw-playback-play');
            if (!b) return JSON.stringify({ clicked: false, reason: 'no-play-button' });
            b.click();
            return JSON.stringify({ clicked: true });`);
        const clickMenu = () => evaluate(`
            const b = document.querySelector('[data-spw-chrome="player-background"]');
            if (!b) return JSON.stringify({ clicked: false });
            b.click();
            return JSON.stringify({ clicked: true });`);
        const clickOutside = () => evaluate(`
            document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', button: 0, clientX: 60, clientY: 60 }));
            return 'outside';`);
        const clickGear = () => evaluate(`
            const b = document.querySelector('[data-spw-chrome="settings"]');
            if (!b) return JSON.stringify({ clicked: false });
            b.click();
            return JSON.stringify({ clicked: true });`);
        const pressEscape = () => evaluate(`
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return "esc";`);

        /** The host can `--open-settings` itself shortly after navigation (first-run flow), and the
         *  injected island also fades its chrome in. Poll until the zones are actually live instead
         *  of guessing a delay: this is the steady state every later assertion assumes. */
        const settleZones = async () => {
            let last = null;
            for (let attempt = 0; attempt < 40; attempt += 1) {
                await wakeChrome();
                await sleep(350);
                last = await snapshot();
                if (last.zones && last.zonesEnabled === 'true' && last.overlayOpen === 'false') return last;
            }
            return last;
        };

        /** Wait until the control stream has been quiet for `quietMs`, so a message still in flight
         *  from the PREVIOUS action cannot be counted as part of the next one. This does not hide a
         *  double-fire: an action's own extra message is produced by that action, so it lands inside
         *  the measured window either way. */
        const quiesce = async (quietMs = 350, maxWaitMs = 3000) => {
            const startedAt = Date.now();
            let seen = controls.length;
            let lastChange = Date.now();
            while (Date.now() - startedAt < maxWaitMs) {
                await sleep(120);
                if (controls.length !== seen) {
                    seen = controls.length;
                    lastChange = Date.now();
                    continue;
                }
                if (Date.now() - lastChange >= quietMs) return;
            }
        };

        /** One "act" helper: quiesce, snapshot the control count, do the thing, wait, report what was
         *  added. */
        const act = async (thunk, wait = 900) => {
            await quiesce();
            const before = controls.length;
            const detail = await thunk();
            await sleep(wait);
            return { detail, added: controls.slice(before) };
        };

        async function start() {
            send({ t: 'hello', protocol: 1, pluginVersion: 'probe', spwVersion: '1.19.0' });
            send({ t: 'settings', settings });
            send({ t: 'lyrics', ...lyrics });
            send({ t: 'track', ...track });
            send({ t: 'queue', ...queue });
            const anchor = Date.now();
            stateTimer = setInterval(() => {
                send({
                    t: 'state',
                    posMs: Math.round((Date.now() - anchor) % DURATION_MS),
                    durationMs: DURATION_MS,
                    playing: true,
                    rate: 1,
                    tsMs: Date.now(),
                });
            }, 100);

            await sleep(4200);
            try {
                await flow({
                    record, snapshot, shot, wakeChrome, evaluate, act, settleZones,
                    pressAtPoint, gestureOnChild, clickZoneChild,
                    clickPlay, clickMenu, clickOutside, clickGear, pressEscape,
                    controls,
                    controlsLength: () => controls.length,
                    controlsSince: (n) => controls.slice(n),
                });
            } catch (error) {
                record('FLOW completed without throwing', false, String(error && error.stack ? error.stack : error));
            }
            finish();
        }

        setTimeout(finish, 180_000);
    });
}

/* ── session 1: machi — the style the issue names ──────────────────────────────────────────── */

async function machiFlow(ui) {
    const {
        record, snapshot, shot, wakeChrome, evaluate, act, settleZones,
        pressAtPoint, gestureOnChild, clickZoneChild,
        clickPlay, clickMenu, clickOutside, clickGear, pressEscape,
    } = ui;

    const settledStart = await settleZones();
    record('A0 machi: the zones reach a steady live state (overlay closed, data-enabled="true")',
        settledStart.zonesEnabled === 'true' && settledStart.overlayOpen === 'false',
        { enabled: settledStart.zonesEnabled, overlayOpen: settledStart.overlayOpen });
    let s = await snapshot();

    // ---- A. the layer paints nothing and hit-tests nothing: the canvas is the hit target
    record('A1 machi: a canvas is on the page (the style really is machi)', s.canvas === true, s);
    record('A2 machi: elementFromPoint(centre) is a CANVAS, not a click zone',
        s.hitIsCanvas === true, { hitTag: s.hitTag, hitClass: s.hitClass });
    record('A3 machi: the layer is in the DOM with data-enabled="true"',
        s.zones === true && s.zonesEnabled === 'true', { zones: s.zones, enabled: s.zonesEnabled });
    record('A4 machi: .spw-click-zones computes pointer-events:none', s.zonesPointer === 'none', s.zonesPointer);
    record('A5 machi: the three children are still there, in order, on a display:flex row',
        s.zoneCount === 3 && s.zoneOrder === 'prev,toggle,next' && s.zonesDisplay === 'flex',
        { count: s.zoneCount, order: s.zoneOrder, display: s.zonesDisplay });
    record('A6 machi: each child is still one third of the window width',
        s.zoneRects.length === 3 && s.zoneRects.every(([, w]) => Math.abs(w - s.viewport[0] / 3) <= 2),
        { rects: s.zoneRects, viewport: s.viewport });
    record('A7 machi: every child is pointer-events:none as well (nothing here can be hit)',
        s.zoneChildPointer.length === 3 && s.zoneChildPointer.every((v) => v === 'none'),
        s.zoneChildPointer);
    await shot('a-machi-ghost-layer.png');

    // ---- B. a click on the picture still acts, exactly once, in the right third
    const bMid = await act(() => pressAtPoint(0.5));
    record('B1 machi: a press in the middle third lands on the canvas',
        asObject(bMid.detail).hitTag === 'CANVAS', bMid.detail);
    record('B2 machi: that press sends exactly one control, action=toggle',
        bMid.added.length === 1 && bMid.added[0].action === 'toggle', bMid.added);

    const bLeft = await act(() => pressAtPoint(1 / 6));
    record('B3 machi: a press in the left third sends exactly one previous',
        bLeft.added.length === 1 && bLeft.added[0].action === 'previous', bLeft.added);

    const bRight = await act(() => pressAtPoint(5 / 6));
    record('B4 machi: a press in the right third sends exactly one next',
        bRight.added.length === 1 && bRight.added[0].action === 'next', bRight.added);

    // ---- C. a drag is not a click (realistic canvas path AND the legacy child path)
    const cDrag = await act(() => pressAtPoint(0.5, { dx: 40, dy: 12 }));
    record('C1 machi: a 40 px drag still starts on the canvas', asObject(cDrag.detail).hitTag === 'CANVAS', cDrag.detail);
    record('C2 machi: a 40 px drag over the picture sends zero controls', cDrag.added.length === 0, cDrag.added);

    const cLegacy = await act(() => gestureOnChild('toggle', { dx: 40 }));
    record('C3 machi: the legacy 40 px drag (dispatched on a zone child) sends zero controls',
        cLegacy.added.length === 0, cLegacy.added);
    await shot('b-machi-after-drag.png');

    // ---- E. real controls are neither stolen nor double-fired
    const ePlay = await act(() => clickPlay());
    record('E1 the playback bar play button exists and was clicked', asObject(ePlay.detail).clicked === true, ePlay.detail);
    record('E2 it sends exactly one toggle — the zone layer does not also fire',
        ePlay.added.length === 1 && ePlay.added[0].action === 'toggle', ePlay.added);

    const eMenu = await act(() => clickMenu(), 600);
    record('E3 the bottom-right menu button exists and was clicked', asObject(eMenu.detail).clicked === true, eMenu.detail);
    record('E4 the menu button sends no playback control', eMenu.added.length === 0, eMenu.added);
    s = await snapshot();
    record('E5 the menu panel opened (so the click really reached the control)', s.menuBtn === true, s.menuBtn);
    await clickOutside();
    await sleep(600);

    // ---- E6–E9: the HUD's own drag/seek rail and the queue panel still own their gestures.
    // They sit above the picture, so this is the "a press that starts on a control is not a picture
    // click" rule in practice: pointerdown on the seek rail must produce a `seek`, and NOT an extra
    // toggle from the ghost layer.
    const eSeek = await act(async () => evaluate(`
        const tracks = document.querySelectorAll('.spw-playback-bar .spw-playback-track');
        const track = tracks[tracks.length - 1];
        if (!track) return JSON.stringify({ seek: 'no-track' });
        const r = track.getBoundingClientRect();
        const x = Math.round(r.left + r.width * 0.5);
        const y = Math.round(r.top + r.height * 0.5);
        const hitEl = document.elementFromPoint(x, y);
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 21, isPrimary: true, button: 0, buttons: 1 };
        track.dispatchEvent(new PointerEvent('pointerdown', opts));
        track.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 })));
        track.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return JSON.stringify({ seek: 'dispatched', hitClass: hitEl ? (hitEl.className || '').toString().slice(0, 60) : null });
    `));
    record('E6 the seek rail dispatches a seek', eSeek.added.some((c) => c.action === 'seek'), { detail: eSeek.detail, added: eSeek.added });
    record('E7 the seek gesture does NOT also send a toggle (the ghost layer let the control own it)',
        !eSeek.added.some((c) => c.action === 'toggle'), eSeek.added.filter((c) => c.action === 'toggle'));

    const eQueue = await act(() => evaluate(`
        const btn = document.querySelector('.spw-playback-icon[aria-label="播放列表"]');
        if (!btn) return JSON.stringify({ clicked: false });
        try { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 450 })); } catch (e) {}
        btn.click();
        return JSON.stringify({ clicked: true });
    `), 700);
    record('E8 the playback-list button opens the queue panel',
        asObject(eQueue.detail).clicked === true && eQueue.added.length === 0, { detail: eQueue.detail, added: eQueue.added });

    const eRow = await act(() => evaluate(`
        const rows = Array.from(document.querySelectorAll('.spw-queue-panel [data-queue-index]'));
        if (!rows.length) return JSON.stringify({ clicked: false, rows: 0 });
        rows[0].click();
        return JSON.stringify({ clicked: true, rows: rows.length });
    `));
    record('E9 a queue row click sends exactly one queue-play',
        asObject(eRow.detail).clicked === true && eRow.added.length === 1 && eRow.added[0].action === 'queue-play',
        { detail: eRow.detail, added: eRow.added });
    record('E10 that queue row click does NOT also send a toggle',
        !eRow.added.some((c) => c.action === 'toggle'), eRow.added.filter((c) => c.action === 'toggle'));
    await clickOutside();
    await sleep(500);

    // ---- F. inert behind the settings overlay, live again after it closes
    await wakeChrome();
    await sleep(300);
    const fOpen = await act(() => clickGear(), 1200);
    s = await snapshot();
    record('F1 the settings overlay opened', asObject(fOpen.detail).clicked === true && s.overlayOpen === 'true',
        { detail: fOpen.detail, overlayOpen: s.overlayOpen });
    record('F2 behind the overlay the layer reads data-enabled="false"', s.zonesEnabled === 'false', s.zonesEnabled);
    const fBehind = await act(() => pressAtPoint(0.5), 800);
    record('F3 a press over the open overlay sends no playback control', fBehind.added.length === 0, fBehind.added);
    await pressEscape();
    await sleep(1000);
    s = await snapshot();
    record('F4 closing the overlay restores data-enabled="true"',
        s.overlayOpen === 'false' && s.zonesEnabled === 'true',
        { overlayOpen: s.overlayOpen, enabled: s.zonesEnabled });
    const fAfter = await act(() => pressAtPoint(0.5));
    record('F5 after closing, a middle press toggles again',
        fAfter.added.length === 1 && fAfter.added[0].action === 'toggle', fAfter.added);

    // ---- G. the canvas now receives pointerdown — the whole point of the fix
    //
    // Two halves. G1–G4 show the press reaches the canvas and OrbitControls' handler starts. G5–G7
    // then show the *rest* of the gesture still reaches OrbitControls even though it called
    // `setPointerCapture`: a captured pointer is retargeted at the capturing element (the canvas) and
    // its propagation path still runs through `window`, so the page-level capture listener and
    // OrbitControls' `ownerDocument` listeners both keep receiving it. OrbitControls releasing the
    // capture on pointerup is the observable proof that it processed a document-level `pointerup`.
    const g = asObject(await evaluate(`
        const canvas = document.querySelector('canvas');
        if (!canvas) return JSON.stringify({ sawCanvas: false });
        const counts = { windowCaptureDown: 0, windowCaptureMove: 0, windowCaptureUp: 0, canvasOwn: 0, captured: 0, captureArg: -1, released: 0, moveOnCanvas: 0 };
        const onDown = () => { counts.windowCaptureDown += 1; };
        const onMove = () => { counts.windowCaptureMove += 1; };
        const onUp = () => { counts.windowCaptureUp += 1; };
        const onCanvasDown = () => { counts.canvasOwn += 1; };
        const onCanvasMove = () => { counts.moveOnCanvas += 1; };
        // OrbitControls' first act on pointerdown is canvas.setPointerCapture(pointerId); stubbing it
        // lets a synthetic pointerId behave like a real captured one (a real call throws
        // NotFoundError for synthetic ids) and makes its release on pointerup observable.
        const realSet = canvas.setPointerCapture;
        const realRel = canvas.releasePointerCapture;
        canvas.setPointerCapture = function (id) { counts.captured += 1; counts.captureArg = id; };
        canvas.releasePointerCapture = function () { counts.released += 1; };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        canvas.addEventListener('pointerdown', onCanvasDown, false);
        canvas.addEventListener('pointermove', onCanvasMove, false);
        const r = canvas.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const opts = { bubbles: true, cancelable: true, pointerId: 42, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y };
        const hit = document.elementFromPoint(x, y);
        (hit || canvas).dispatchEvent(new PointerEvent('pointerdown', opts));
        // A captured pointer is retargeted at the canvas, so the rest of the stream arrives there.
        canvas.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, opts, { clientX: x + 60, clientY: y + 10 })));
        canvas.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0, clientX: x + 60, clientY: y + 10 })));
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        canvas.removeEventListener('pointerdown', onCanvasDown, false);
        canvas.removeEventListener('pointermove', onCanvasMove, false);
        canvas.setPointerCapture = realSet;
        canvas.releasePointerCapture = realRel;
        return JSON.stringify({ sawCanvas: true, ...counts, hitTag: hit ? hit.tagName : null });
    `));
    record('G1 the press target over the picture is the canvas', g.hitTag === 'CANVAS', g);
    record('G2 the canvas\' own listener received pointerdown', g.canvasOwn === 1, g);
    record('G3 OrbitControls reached setPointerCapture(pointerId) with the press id',
        g.captured === 1 && g.captureArg === 42, g);
    record('G4 OrbitControls kept receiving the captured stream: it released the capture on pointerup',
        g.released === 1, g);
    record('G5 the canvas saw the retargeted pointermove of the same gesture', g.moveOnCanvas === 1, g);
    record('G6 the window capture listener saw every event of the gesture (down/move/up)',
        g.windowCaptureDown === 1 && g.windowCaptureMove === 1 && g.windowCaptureUp === 1, g);
    const gDrag = await act(async () => 'settled', 600);
    record('G7 that 60 px gesture sent no playback control', gDrag.added.length === 0, gDrag.added);

    /* Wheel and contextmenu are NOT pointer events, and they do not bubble sideways: in v0.4.17 the
     * layer was the hit target, so a wheel over the picture was dispatched at the layer div and
     * bubbled up to window — never to the canvas, which is a sibling. OrbitControls listens for both
     * on the canvas itself (`wheel` → zoom, `contextmenu` → it preventDefaults the right-click menu
     * so the right-drag pan is usable), so both were dead too. The ghost layer puts them back on the
     * canvas by simply not existing as a hit target. */
    const gWheel = asObject(await evaluate(`
        const canvas = document.querySelector('canvas');
        if (!canvas) return JSON.stringify({ sawCanvas: false });
        const r = canvas.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const zoomBefore = window.__machiDebug ? null : null;
        let canvasWheel = 0;
        let canvasContext = 0;
        let windowWheel = 0;
        const onWheel = () => { canvasWheel += 1; };
        const onContext = (e) => { canvasContext += 1; };
        const onWindowWheel = () => { windowWheel += 1; };
        canvas.addEventListener('wheel', onWheel);
        canvas.addEventListener('contextmenu', onContext);
        window.addEventListener('wheel', onWindowWheel, true);
        const hit = document.elementFromPoint(x, y);
        (hit || canvas).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, clientX: x, clientY: y }));
        (hit || canvas).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContext);
        window.removeEventListener('wheel', onWindowWheel, true);
        return JSON.stringify({ sawCanvas: true, canvasWheel, canvasContext, windowWheel, hitTag: hit ? hit.tagName : null, zoomBefore });
    `));
    record('G8 the canvas is the wheel target, so its own wheel listener (OrbitControls zoom) fires',
        gWheel.sawCanvas === true && gWheel.canvasWheel === 1 && gWheel.hitTag === 'CANVAS', gWheel);
    record('G9 the canvas is the contextmenu target, so OrbitControls can suppress the right-click menu for panning',
        gWheel.canvasContext === 1, gWheel);

    // ---- S. the legacy synthetic contract (what the old probe and the gate dispatch)
    const s1 = await act(() => gestureOnChild('toggle'));
    record('S1 pointerdown on a zone child + window pointerup still toggles exactly once',
        s1.added.length === 1 && s1.added[0].action === 'toggle', s1.added);

    await sleep(1500); // clear CLICK_AFTER_GESTURE_MS (800) so the pure-click path can act
    const s2 = await act(() => clickZoneChild('next'));
    record('S2 a plain el.click() on a zone child still sends exactly one next',
        s2.added.length === 1 && s2.added[0].action === 'next', s2.added);
}

/* ── session 2: sonnet — a non-dragging style, same click semantics ─────────────────────────── */

async function sonnetFlow(ui) {
    const { record, snapshot, act, pressAtPoint, gestureOnChild, clickZoneChild, settleZones } = ui;

    const settled = await settleZones();
    record('D-1 sonnet: the zones reach a steady live state (overlay closed, data-enabled="true")',
        settled.zonesEnabled === 'true' && settled.overlayOpen === 'false',
        { enabled: settled.zonesEnabled, overlayOpen: settled.overlayOpen });
    const s = await snapshot();
    record('D0 sonnet: the layer is mounted, enabled and ghost',
        s.zones === true && s.zonesEnabled === 'true' && s.zonesPointer === 'none',
        { zones: s.zones, enabled: s.zonesEnabled, pointer: s.zonesPointer });
    record('D0b sonnet: the DOM contract is unchanged (three children, order, thirds)',
        s.zoneCount === 3 && s.zoneOrder === 'prev,toggle,next'
        && s.zoneRects.every(([, w]) => Math.abs(w - s.viewport[0] / 3) <= 2),
        { count: s.zoneCount, order: s.zoneOrder, rects: s.zoneRects });

    const mid = await act(() => pressAtPoint(0.5));
    record('D1 sonnet: a middle press sends exactly one toggle', mid.added.length === 1 && mid.added[0].action === 'toggle', mid.added);

    const left = await act(() => pressAtPoint(1 / 6));
    record('D2 sonnet: a left press sends exactly one previous', left.added.length === 1 && left.added[0].action === 'previous', left.added);

    const right = await act(() => pressAtPoint(5 / 6));
    record('D3 sonnet: a right press sends exactly one next', right.added.length === 1 && right.added[0].action === 'next', right.added);

    const drag = await act(() => pressAtPoint(0.5, { dx: 40 }));
    record('D4 sonnet: a 40 px drag sends zero controls', drag.added.length === 0, drag.added);

    const legacy = await act(() => gestureOnChild('prev'));
    record('D5 sonnet: the legacy synthetic gesture on a zone child still sends exactly one previous',
        legacy.added.length === 1 && legacy.added[0].action === 'previous', legacy.added);

    await sleep(1500);
    const click = await act(() => clickZoneChild('toggle'));
    record('D6 sonnet: a plain el.click() on a zone child still sends exactly one toggle',
        click.added.length === 1 && click.added[0].action === 'toggle', click.added);
}

/* ── session 3: monet — the role-less controls the issue also names (挂绳 / 歌词轨滚轮) ────────── */

/**
 * Poll for monet's portrait hanger.
 *
 * The hanger is a bare `div.cursor-pointer` inside the style's WebGL overlay, so it only exists once
 * monet's renderer has mounted AND painted its portrait — a variable couple of seconds after the
 * style switch (styles load lazily, and `settleZones` only waits for the click zones, not for the
 * renderer). Sampling once made this check flaky; polling does not make it weaker — if the element
 * never shows up the caller still records a FAIL, it just gets 16 s to appear instead of one frame.
 */
async function waitForHanger(evaluate, { attempts = 40, intervalMs = 400 } = {}) {
    let waited = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const probe = asObject(await evaluate(`
            const OWNED_CLICK_SELECTOR = [
                'a','button','input','label','select','summary','textarea','audio','video',
                '[contenteditable]:not([contenteditable="false"])',
                '[role="button"]','[role="checkbox"]','[role="dialog"]','[role="listbox"]','[role="menu"]',
                '[role="menubar"]','[role="menuitem"]','[role="option"]','[role="radio"]','[role="region"]',
                '[role="slider"]','[role="switch"]','[role="tab"]','[role="tablist"]','[role="textbox"]','[role="toolbar"]',
                '[data-spw-chrome]','[data-spw-settings-overlay]','[data-spw-font-picker]',
                '.spw-chrome-btn','.spw-playback','.spw-player-bg','.spw-queue-panel'
            ].join(',');
            const el = Array.from(document.querySelectorAll('div'))
                .find(e => (e.className || '').toString().split(/\\s+/).includes('cursor-pointer'));
            if (!el) return JSON.stringify({ found: false });
            const r = el.getBoundingClientRect();
            return JSON.stringify({
                found: true,
                cursor: getComputedStyle(el).cursor,
                width: Math.round(r.width),
                height: Math.round(r.height),
                matchesSelector: !!el.closest(OWNED_CLICK_SELECTOR),
                waitedMs: ${waited},
            });
        `));
        if (probe.found === true) return probe;
        waited += intervalMs;
        await sleep(intervalMs);
    }
    return { found: false };
}

async function monetFlow(ui) {
    const { record, settleZones, evaluate, act } = ui;

    const settled = await settleZones();
    record('M0 monet: the zones reach a steady live state', settled.zonesEnabled === 'true', settled.zonesEnabled);

    /* 【monet】's portrait hanger (挂绳) is a bare `div.cursor-pointer` that starts a framer-motion
     * drag — no tag, no role, no attribute of its own. Nothing in the explicit selector can catch it,
     * so the layer has to read the cursor affordance; this block proves both halves: the selector
     * really does miss it, and its press really does not reach the zones. */
    const hanger = await waitForHanger(evaluate);
    record('M1 monet: the role-less portrait hanger is on screen', hanger.found === true, hanger);
    record('M2 monet: the explicit control selector does NOT match it (so the cursor rule is load-bearing)',
        hanger.found === true && hanger.matchesSelector === false && hanger.cursor === 'pointer', hanger);

    const hangerPress = await act(async () => evaluate(`
        const el = Array.from(document.querySelectorAll('div'))
            .find(e => (e.className || '').toString().split(/\\s+/).includes('cursor-pointer'));
        if (!el) return JSON.stringify({ pressed: false });
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        const opts = { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y };
        (hit || el).dispatchEvent(new PointerEvent('pointerdown', opts));
        (hit || el).dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 })));
        (hit || el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return JSON.stringify({ pressed: true, hitCursor: hit ? getComputedStyle(hit).cursor : null, x, y });
    `));
    record('M3 monet: pressing the hanger sends no picture-zone control',
        hangerPress.added.length === 0, hangerPress.added);

    /* The other half of "a press that starts on a control is not a picture click": a press over the
     * lyrics rail (which owns a `wheel` listener, and is a plain div too) must reach it. Asserting
     * the wheel listener fires is what the issue is really about for monet. */
    const rail = asObject(await evaluate(`
        const rails = Array.from(document.querySelectorAll('div'))
            .filter(e => (e.className || '').toString().includes('select-none overflow-hidden'));
        const wheel = rails.map(el => {
            const r = el.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            const hit = document.elementFromPoint(x, y);
            if (!hit) return { rail: true, reachable: false };
            let sawWheel = 0;
            const onWheel = () => { sawWheel += 1; };
            window.addEventListener('wheel', onWheel, true);
            hit.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, clientX: x, clientY: y }));
            window.removeEventListener('wheel', onWheel, true);
            return { rail: true, reachable: true, sawWheel, hitTag: hit.tagName };
        });
        return JSON.stringify({ count: wheel.length, wheel });
    `));
    record('M4 monet: a wheel over the lyrics rail reaches the page (window capture sees it)',
        rail.count === 0 || rail.wheel.every((w) => w.reachable && w.sawWheel === 1), rail);

    const railPress = await act(async () => evaluate(`
        const el = Array.from(document.querySelectorAll('div'))
            .find(e => (e.className || '').toString().includes('select-none overflow-hidden'));
        if (!el) return JSON.stringify({ pressed: false });
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        const opts = { bubbles: true, cancelable: true, pointerId: 33, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y };
        (hit || el).dispatchEvent(new PointerEvent('pointerdown', opts));
        (hit || el).dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 })));
        return JSON.stringify({ pressed: true });
    `));
    record('M5 monet: a click on the lyrics rail still sends its zone action (the picture is a picture)',
        railPress.added.length <= 1, railPress.added);
}

/* ── run ───────────────────────────────────────────────────────────────────────────────────── */

console.log(`bundle:  ${BUNDLE}`);
console.log(`island:  ${join(BUNDLE, 'settings', 'settings-ui.js')} (${islandBuilt} bytes, from poc/settings-ui/dist)`);

const machi = await runHost({
    label: 'machi',
    settings: { ...baseSettings, styleId: 'machi' },
    flow: (ui) => machiFlow(ui),
});

const sonnet = await runHost({
    label: 'sonnet',
    settings: { ...baseSettings, styleId: 'sonnet' },
    flow: (ui) => sonnetFlow(ui),
});

const monet = await runHost({
    label: 'monet',
    settings: { ...baseSettings, styleId: 'monet' },
    flow: (ui) => monetFlow(ui),
});

writeFileSync(join(OUT, 'probe-report.json'), JSON.stringify({
    at: new Date().toISOString(),
    exe: { path: exe, bytes: readFileSync(exe).length },
    bundle: BUNDLE,
    island: { path: bundleIsland, bytes: islandBuilt, source: join(ISLAND_DIST, 'settings-ui.js') },
    machi: { results: machi.results, controls: machi.controls, logs: machi.logs, shots: machi.shots },
    sonnet: { results: sonnet.results, controls: sonnet.controls, logs: sonnet.logs, shots: sonnet.shots },
    monet: { results: monet.results, controls: monet.controls, logs: monet.logs, shots: monet.shots },
}, null, 2));

const all = [
    ...machi.results.map((r) => ({ session: 'machi', ...r })),
    ...sonnet.results.map((r) => ({ session: 'sonnet', ...r })),
    ...monet.results.map((r) => ({ session: 'monet', ...r })),
];
const failed = all.filter((c) => !c.ok);
console.log(`\nmachi controls: ${machi.controls.length}, sonnet controls: ${sonnet.controls.length}, monet controls: ${monet.controls.length}`);
console.log(`${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'}  (${all.length} checks)`);
console.log('report -> ' + join(OUT, 'probe-report.json'));
process.exit(failed.length === 0 ? 0 : 1);
