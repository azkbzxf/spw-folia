#!/usr/bin/env node
// v0.4.10 acceptance: 配置 page 「显示播放条」 switch + the deleted 帧率 setting.
//
// Both promises are checked against the SHIPPED helper + SHIPPED settings island (no plugin, no
// SPW), i.e. the real WebView2 page the user sees:
//
//   A. The playback HUD is on by default (a settings tree without `showPlaybackBar` renders it).
//   B. With `showPlaybackBar: false` injected into the settings tree the HUD never mounts: no
//      `.spw-playback` element at all, not merely a hidden one (no pixels, no hit region).
//   C. A `visualizer_frame_rate` cap written by an older build is removed across a real restart,
//      so an upgrade cannot keep throttling invisibly.
//   D. The 配置 page declaration no longer offers 帧率 and does offer 显示播放条 (default on).
//
// Usage: node packaging/tools/verify-playback-bar-switch.mjs
// Exit code 0 = PASS, 1 = FAIL, 2 = missing packaged helper.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PKG = join(ROOT, 'packaging');
const OUT = join(PKG, 'out', 'playback-bar-switch');
mkdirSync(OUT, { recursive: true });

const exe = join(PKG, 'native', 'spw-folia-host.exe');
const settingsBundle = join(PKG, 'web', 'settings', 'settings-ui.js');
for (const p of [exe, join(PKG, 'web', 'index.html'), settingsBundle]) {
    if (!existsSync(p)) {
        console.error('FAIL  missing packaged file: ' + p + '\nrun: bash packaging/build-package.sh');
        process.exit(2);
    }
}

const baseSettings = JSON.parse(readFileSync(join(PKG, 'testdata', 'default-settings.json'), 'utf8'));
if (typeof baseSettings.smartBeat === 'boolean') baseSettings.smartBeat = { enabled: baseSettings.smartBeat, effects: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The HUD probe.
 *
 * v0.4.17 (issue #18 item 2): `showPlaybackBar` is no longer a plugin-owned injected member, so
 * `legacy` now reads the MIGRATION hint (`showPlaybackBarLegacy`) instead — that is the only
 * showPlaybackBar-shaped member the page still receives from the plugin. `menuBtn` / `menuOpen` /
 * `rowChecked` describe the switch NEW home: the bottom-right player-page menu.
 */
const HUD_PROBE = [
    'JSON.stringify({',
    '  present: !!document.querySelector(".spw-playback"),',
    '  bar: !!document.querySelector(".spw-playback-bar"),',
    '  settingsUiReady: !!window.__SPW_FOLIA_SETTINGS_UI_READY__,',
    '  storage: (() => { try { return localStorage.getItem("visualizer_frame_rate"); } catch (e) { return "ERR"; } })(),',
    '  capped: typeof window.__foliaNativeRequestAnimationFrame === "function",',
    '  legacy: (() => { try { const b = window.__SPW_FOLIA__; const s = b && b.getSettings ? b.getSettings() : null; if (!s) return "NO-BRIDGE"; const v = s.showPlaybackBarLegacy; return v === undefined ? "ABSENT" : v; } catch (e) { return "ERR"; } })(),',
    "  menuBtn: !!document.querySelector('[data-spw-chrome=\"player-background\"]'),",
    "  menuOpen: (() => { const p = document.querySelector('[data-spw-chrome=\"player-background-panel\"]'); return p ? p.getAttribute(\"data-open\") : null; })(),",
    "  rowChecked: (() => { const r = document.querySelector('[data-spw-chrome=\"playback-bar-row\"]'); return r ? r.getAttribute(\"aria-checked\") : null; })(),",
    '})',
].join('\n');

/** Clicks the bottom-right menu button, opening (or closing) the player-page panel. */
const MENU_TOGGLE_PROBE =
    "(function(){ var b = document.querySelector('[data-spw-chrome=\"player-background\"]'); if (b) b.click(); " +
    'return JSON.stringify({ clicked: !!b }); })()';

/** Clicks the 「显示播放条」 row inside the panel and reports the resulting HUD state. */
const ROW_TOGGLE_PROBE =
    "(function(){ var r = document.querySelector('[data-spw-chrome=\"playback-bar-row\"]'); " +
    'if (!r) return JSON.stringify({ clicked: false, present: !!document.querySelector(".spw-playback") }); ' +
    'var before = !!document.querySelector(".spw-playback"); r.click(); ' +
    'return JSON.stringify({ clicked: true, before: before, checked: r.getAttribute("aria-checked") }); })()';

/**
 * Runs one host session. `settings` is the tree the plugin would have pushed for this launch.
 * When `seedFrameRate` is set the session only seeds that localStorage key; a following session
 * reuses the same profile, so the removal happens across a genuine process restart.
 */
function runHost({ label, settings, userData, seedFrameRate = null, driveMenu = false }) {
    return new Promise((resolvePromise) => {
        const work = join(OUT, label);
        mkdirSync(work, { recursive: true });
        const profile = userData ?? join(work, 'profile');
        mkdirSync(profile, { recursive: true });

        const args = [
            '--bundle', join(PKG, 'web'),
            '--settings-dir', join(PKG, 'web', 'settings'),
            '--settings-entry', 'settings-ui.js',
            '--window', '1600x900',
            '--user-data-dir', profile,
            '--fps-log', join(work, 'fps.log'),
            '--no-curtain',
        ];
        const child = spawn(exe, args, { cwd: PKG, stdio: ['pipe', 'pipe', 'pipe'] });
        const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };

        const results = {};
        const tags = [];
        const lines = [];
        let buf = '';
        let ready = false;
        let finished = false;

        const finish = (code) => {
            if (finished) return;
            finished = true;
            try { send({ t: 'command', command: 'close' }); } catch { /* gone */ }
            try { child.kill(); } catch { /* gone */ }
            setTimeout(() => {
                try { writeFileSync(join(work, 'stdout.log'), lines.join('\n')); } catch { /* ignore */ }
                resolvePromise({ results, lines, code });
            }, 300);
        };

        // The host writes {"t":"eval-result","value":"<escaped>"}; a probe returns
        // JSON.stringify(...), so the decoded value is a JSON *string* holding JSON. Parsing the
        // whole line with JSON.parse handles every escaping level for us, and unwrap() then peels
        // the inner string(s) until a plain object comes out.
        const unwrap = (raw) => {
            let value = raw;
            for (let depth = 0; depth < 3; depth += 1) {
                if (typeof value !== 'string') break;
                const text = value.trim();
                if (!text) break;
                const head = text.charAt(0);
                if (head !== '{' && head !== '[' && head !== '"') break;
                try { value = JSON.parse(text); } catch { break; }
            }
            return value;
        };

        const takeResult = (line) => {
            const tag = tags.shift();
            if (!tag) return;
            let msg = null;
            try { msg = JSON.parse(line); } catch { msg = null; }
            if (!msg || typeof msg.value !== 'string') { results[tag] = null; return; }
            results[tag] = unwrap(msg.value);
        };
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const parts = buf.split('\n');
            buf = parts.pop() ?? '';
            for (const raw of parts) {
                const line = raw.trim();
                if (!line) continue;
                lines.push(line);
                if (line.includes('"t":"eval-result"')) { takeResult(line); continue; }
                if (!ready && line.includes('"t":"ready"')) { ready = true; onReady(); }
            }
        });
        child.stderr.on('data', () => { });
        child.on('error', () => finish(1));

        const evalJs = (tag, script) => { tags.push(tag); send({ t: 'command', command: 'eval', script }); };

        async function onReady() {
            // the settings island mounts after navigation and the plugin pushes its tree right after
            // `hello`; 2.2 s covers first paint + the queue/state replays on this machine.
            send({ t: 'settings', settings });
            await sleep(2200);
            if (seedFrameRate !== null) {
                await evalJs('seed', '(function(){ localStorage.setItem("visualizer_frame_rate", "' + seedFrameRate + '"); return "seeded"; })()');
                await sleep(600);
                await evalJs('seedBack', 'JSON.stringify({ storage: (function(){ try { return localStorage.getItem("visualizer_frame_rate"); } catch (e) { return "ERR"; } })() })');
                await sleep(600);
            } else if (driveMenu) {
                // v0.4.17: the switch lives in the player page's bottom-right menu now, so drive it
                // through the UI the way a user would: open the panel, click the row, re-read.
                await evalJs('probe', HUD_PROBE);
                await sleep(500);
                await evalJs('menuOpen', MENU_TOGGLE_PROBE);
                await sleep(500);
                await evalJs('menuState', HUD_PROBE);
                await evalJs('rowClick', ROW_TOGGLE_PROBE);
                await sleep(700);
                await evalJs('afterToggle', HUD_PROBE);
                await evalJs('rowClickBack', ROW_TOGGLE_PROBE);
                await sleep(700);
                await evalJs('restored', HUD_PROBE);
                await sleep(300);
            } else {
                await evalJs('probe', HUD_PROBE);
                await sleep(700);
                await evalJs('probe2', HUD_PROBE);
                await sleep(400);
            }
            finish(0);
        }

        setTimeout(() => finish(0), 30000);
    });
}

const checks = [];
const assert = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
// takeResult already unwrapped the payload into an object; older runs may hand back a string.
const parse = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
};

async function main() {
    // ---- A. default tree (no showPlaybackBar member) -> the HUD is there
    const a = await runHost({ label: 'a-default-on', settings: { ...baseSettings } });
    const pa = parse(a.results.probe2) ?? parse(a.results.probe);
    assert('A1 settings island mounted', pa && pa.settingsUiReady === true, pa && pa.settingsUiReady);
    assert('A2 default tree keeps the playback HUD', pa && pa.present === true, pa && pa.present);

    // ---- B. showPlaybackBar:false -> the HUD must not exist at all
    //
    // v0.4.17: the key reaches the page as the MIGRATION hint `showPlaybackBarLegacy`, not as the
    // plugin-owned `showPlaybackBar` member it used to be — the page owns the switch now. The page
    // seeds its own tree from the hint on the first launch that has no stored value, which is
    // exactly this case (a fresh profile + a tree that only carries the hint).
    const b = await runHost({ label: 'b-switch-off', settings: { ...baseSettings, showPlaybackBarLegacy: false } });
    const pb = parse(b.results.probe2) ?? parse(b.results.probe);
    assert('B1 settings island mounted', pb && pb.settingsUiReady === true, pb && pb.settingsUiReady);
    assert('B2 showPlaybackBarLegacy:false removes the HUD element', pb && pb.present === false, pb && pb.present);
    assert('B3 no .spw-playback-bar subtree left behind', pb && pb.bar === false, pb && pb.bar);
    assert('B4 bridge exposes the legacy hint as false', pb && pb.legacy === false, pb && pb.legacy);

    // ---- C. legacy cap removed across a real restart
    const profileDir = join(OUT, 'c-legacy-cap', 'profile');
    const seed = await runHost({ label: 'c-legacy-cap-seed', settings: { ...baseSettings }, userData: profileDir, seedFrameRate: '90' });
    const seeded = parse(seed.results.seedBack);
    assert('C1 legacy cap seeded in the profile', seeded && seeded.storage === '90', seeded && seeded.storage);
    const c = await runHost({ label: 'c-legacy-cap', settings: { ...baseSettings }, userData: profileDir });
    const pc = parse(c.results.probe2) ?? parse(c.results.probe);
    assert('C2 storage key cleared after restart', pc && pc.storage === null, pc && pc.storage);
    assert('C3 upstream limiter not installed (capped=false)', pc && pc.capped === false, pc && pc.capped);
    const cleared = c.lines.find((l) => l.includes('legacy frame-rate cap cleared'));
    assert('C4 host logged the legacy cap removal', !!cleared, cleared || null);

    // ---- D. the 配置 page declaration
    //
    // v0.4.17 (issue #18 item 2): the switch has MOVED OFF the 配置 page into the player page's own
    // bottom-right menu, so the declaration assertions are inverted on purpose. D3 is the important
    // one: a stale `showPlaybackBar` entry here would offer the user a second, competing writer for a
    // value the page now owns, and `verify-all.mjs`'s declaration ⇄ KNOWN_CONFIG_SWITCHES check would
    // fail on it anyway. Keeping the negative assertion here means the same drift is caught by the
    // suite that is specifically about this switch.
    const prefPath = join(ROOT, 'spw-folia', 'src', 'main', 'resources', 'preference_config.json');
    const pref = JSON.parse(readFileSync(prefPath, 'utf8'));
    const prefs = pref.configs.flatMap((cfg) => cfg.preferences ?? []);
    const keys = prefs.map((p) => p.key).filter(Boolean);
    assert('D1 preference_config has no frameRate entry', !prefs.some((p) => p.key === 'frameRate'), keys.join(','));
    assert('D2 preference_config has no list type left', !prefs.some((p) => p.type === 'list'), prefs.map((p) => p.type).join(','));
    assert('D3 preference_config no longer declares showPlaybackBar (moved to the player page)',
        !prefs.some((p) => p.key === 'showPlaybackBar'), keys.join(','));

    // ---- E. the switch's NEW home: the bottom-right player-page menu
    const e = await runHost({ label: 'e-menu-drive', settings: { ...baseSettings }, driveMenu: true });
    const pe0 = parse(e.results.probe);
    const peMenu = parse(e.results.menuState);
    const peToggled = parse(e.results.afterToggle);
    const peRestored = parse(e.results.restored);
    const rowClick = parse(e.results.rowClick);
    assert('E1 the bottom-right menu button is mounted', pe0 && pe0.menuBtn === true, pe0 && pe0.menuBtn);
    assert('E2 clicking it opens the panel', peMenu && peMenu.menuOpen === 'true', peMenu && peMenu.menuOpen);
    assert('E3 the panel carries a 「显示播放条」 switch row', peMenu && peMenu.rowChecked !== null, peMenu && peMenu.rowChecked);
    assert('E4 the row reads the live value (on by default)', peMenu && peMenu.rowChecked === 'true', peMenu && peMenu.rowChecked);
    assert('E5 clicking the row removes the HUD', rowClick && rowClick.clicked === true && peToggled && peToggled.present === false, peToggled && peToggled.present);
    assert('E6 the row now reads off', peToggled && peToggled.rowChecked === 'false', peToggled && peToggled.rowChecked);
    // The lock-out guard: with the bar gone the ONLY way back is this menu button, so it must still
    // be there. A build that unmounts the chrome together with the bar would strand the user here.
    assert('E7 the menu button SURVIVES the bar being off (no lock-out)', peToggled && peToggled.menuBtn === true, peToggled && peToggled.menuBtn);
    assert('E8 clicking the row again brings the HUD back', peRestored && peRestored.present === true, peRestored && peRestored.present);
    assert('E9 the row reads on again', peRestored && peRestored.rowChecked === 'true', peRestored && peRestored.rowChecked);

    // ---- F. the legacy migration hint (old config.json value, injected once)
    //
    // An upgrading user still has `showPlaybackBar: false` in config.json. The page stores the switch
    // in its own tree now, so the plugin forwards the old value as `showPlaybackBarLegacy` and the
    // page seeds its switch from it exactly once. Without this an upgrade would silently turn the
    // bar back on for everyone who had switched it off.
    const f = await runHost({ label: 'f-legacy-off', settings: { ...baseSettings, showPlaybackBarLegacy: false } });
    const pf = parse(f.results.probe2) ?? parse(f.results.probe);
    assert('F1 the legacy hint reaches the page', pf && pf.legacy === false, pf && pf.legacy);
    assert('F2 showPlaybackBarLegacy:false seeds the HUD off', pf && pf.present === false, pf && pf.present);
    assert('F3 the menu button is still there to switch it back on', pf && pf.menuBtn === true, pf && pf.menuBtn);

    const report = {
        at: new Date().toISOString(),
        exe: { path: exe, bytes: readFileSync(exe).length },
        settingsUi: { path: settingsBundle, bytes: readFileSync(settingsBundle).length },
        runs: { defaultOn: pa, switchOff: pb, legacyCap: pc, seeded, menu: pe0, menuOpen: peMenu, toggled: peToggled, restored: peRestored, legacyOff: pf },
        clearedLogLine: cleared || null,
        checks,
        pass: checks.every((c) => c.ok),
    };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '  -> ' + JSON.stringify(c.detail)));
    console.log('\n' + (report.pass ? 'PASS' : 'FAIL') + '  ' + checks.filter((c) => c.ok).length + '/' + checks.length + ' checks');
    process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
    console.error('FAIL  ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
