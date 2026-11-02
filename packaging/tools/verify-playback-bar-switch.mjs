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

const HUD_PROBE = [
    'JSON.stringify({',
    '  present: !!document.querySelector(".spw-playback"),',
    '  bar: !!document.querySelector(".spw-playback-bar"),',
    '  settingsUiReady: !!window.__SPW_FOLIA_SETTINGS_UI_READY__,',
    '  storage: (() => { try { return localStorage.getItem("visualizer_frame_rate"); } catch (e) { return "ERR"; } })(),',
    '  capped: typeof window.__foliaNativeRequestAnimationFrame === "function",',
    '  injected: (() => { try { const b = window.__SPW_FOLIA__; const s = b && b.getSettings ? b.getSettings() : null; if (!s) return "NO-BRIDGE"; const v = s.showPlaybackBar; return v === undefined ? "ABSENT" : v; } catch (e) { return "ERR"; } })()',
    '})',
].join('\n');

/**
 * Runs one host session. `settings` is the tree the plugin would have pushed for this launch.
 * When `seedFrameRate` is set the session only seeds that localStorage key; a following session
 * reuses the same profile, so the removal happens across a genuine process restart.
 */
function runHost({ label, settings, userData, seedFrameRate = null }) {
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
    const b = await runHost({ label: 'b-switch-off', settings: { ...baseSettings, showPlaybackBar: false } });
    const pb = parse(b.results.probe2) ?? parse(b.results.probe);
    assert('B1 settings island mounted', pb && pb.settingsUiReady === true, pb && pb.settingsUiReady);
    assert('B2 showPlaybackBar:false removes the HUD element', pb && pb.present === false, pb && pb.present);
    assert('B3 no .spw-playback-bar subtree left behind', pb && pb.bar === false, pb && pb.bar);
    assert('B4 bridge exposes the injected switch as false', pb && pb.injected === false, pb && pb.injected);

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
    const prefPath = join(ROOT, 'spw-folia', 'src', 'main', 'resources', 'preference_config.json');
    const pref = JSON.parse(readFileSync(prefPath, 'utf8'));
    const prefs = pref.configs.flatMap((cfg) => cfg.preferences ?? []);
    const keys = prefs.map((p) => p.key).filter(Boolean);
    assert('D1 preference_config has no frameRate entry', !prefs.some((p) => p.key === 'frameRate'), keys.join(','));
    assert('D2 preference_config has no list type left', !prefs.some((p) => p.type === 'list'), prefs.map((p) => p.type).join(','));
    const bar = prefs.find((p) => p.key === 'showPlaybackBar');
    assert('D3 preference_config declares showPlaybackBar', !!bar, bar ? bar.type : null);
    assert('D4 it is a switch', !!bar && bar.type === 'switch', bar && bar.type);
    assert('D5 it defaults to on', !!bar && bar.default_value === true, bar && bar.default_value);

    const report = {
        at: new Date().toISOString(),
        exe: { path: exe, bytes: readFileSync(exe).length },
        settingsUi: { path: settingsBundle, bytes: readFileSync(settingsBundle).length },
        runs: { defaultOn: pa, switchOff: pb, legacyCap: pc, seeded },
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
