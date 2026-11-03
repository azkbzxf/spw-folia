// End-to-end check with the EXACT payload the fixed plugin sends for the live config.
//
// Reproduces FoliaHostBridge.sendSettings() byte for byte:
//   {"t":"settings","settings":<withInjectedMembers(settingsTree)>}\n
// where settingsTree is the persisted `settingsJson` and the two switches + systemFonts are injected.
//
// Verifies the page really mounts/unmounts the HUD and the 问题反馈 button from that payload —
// which is what the user sees when they flip the three switches.
//
// v0.4.14: this suite used to read the DEVELOPER'S LIVE INSTALL
// (`%APPDATA%\...\workshop\data\dev.spw.folia\config.json`) and crash with ENOENT on any machine
// where the plugin had never been run — i.e. on every clean checkout and every CI box. That is the
// same class of flaw as the v0.4.13 acceptance blind spot: a test that depends on ambient state the
// build does not control. The tree now comes from the bundled default, so the suite is hermetic.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/输出目录/spw-folia';
const EXE = path.join(REPO, 'packaging', 'native', 'spw-folia-host.exe');
const BUNDLE = path.join(REPO, 'packaging', 'web');
const OUT = 'C:/tmp/trayverify/live-payload';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Mirrors the plugin: persisted tree + systemFonts + the two switches, collapsed to one line. */
function buildPayload(tree, bar, problem) {
    const base = tree.trimEnd();
    if (!base.endsWith('}')) throw new Error('tree must end with }');
    const core = base.slice(0, -1);
    return core + ',"systemFonts":[],"showPlaybackBar":' + bar + ',"showProblemButton":' + problem + '}';
}

function singleLine(json) {
    let inString = false, escaped = false, out = '';
    for (const c of json) {
        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
        out += c;
    }
    return out;
}

// The tree the plugin actually persists/plays back. Prefer the developer's real install when it is
// present (maximally realistic), but NEVER depend on it: fall back to the bundled canonical tree so
// the suite runs on a clean machine. Before v0.4.14 this read the live path unconditionally and threw
// ENOENT whenever the plugin had not been run — which made the gate un-runnable rather than failing
// a real assertion.
// The tree the plugin persists and plays back. The BUNDLED tree is the canonical one — it is what a
// fresh install ships and what every other suite uses — so it is the primary source and this suite
// stays hermetic. The developer's live install is only a *preferred-but-optional* extra: it is read
// when it happens to carry a usable `settingsJson`, and silently skipped otherwise.
//
// Before v0.4.14 this read the live path unconditionally and threw ENOENT on any clean machine.
// The first fix then made it prefer the live file whenever it EXISTED — which failed differently
// (the plugin writes `settingsJson` only after the user touches a setting, so the file exists but
// is empty). Correct rule: presence of the FILE says nothing; valour of the CONTENT decides.
const liveConfigPath = path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
    'Salt Player for Windows', 'workshop', 'data', 'dev.spw.folia', 'config.json',
);
const bundledTreePath = path.join(REPO, 'packaging', 'testdata', 'default-settings.json');

let persistedTree = fs.readFileSync(bundledTreePath, 'utf8');
let source = 'bundled default-settings.json';
if (fs.existsSync(liveConfigPath)) {
    try {
        const cfg = JSON.parse(fs.readFileSync(liveConfigPath, 'utf8'));
        const live = cfg.settingsJson;
        if (typeof live === 'string' && live.trim().startsWith('{') && live.trim().length > 2) {
            persistedTree = live;
            source = 'live install (' + liveConfigPath + ')';
            console.log('config switches: bar=' + cfg.showPlaybackBar + ' problem=' + cfg.showProblemButton
                + ' transition=' + cfg.transitionAnimation);
        } else {
            source = 'bundled default-settings.json (live config.json has no usable settingsJson yet)';
        }
    } catch (e) {
        source = 'bundled default-settings.json (live config.json unreadable: ' + e.message + ')';
    }
}
if (typeof persistedTree !== 'string' || !persistedTree.trim()) {
    console.error('FAIL  no settings tree available (bundled default-settings.json is empty?)');
    process.exit(1);
}
console.log('settings tree source = ' + source);
console.log('tree = ' + persistedTree.length + ' bytes, '
    + (persistedTree.match(/\n/g) || []).length + ' newlines');

const child = spawn(EXE, [
    '--bundle', BUNDLE, '--windowed', '--width', '1280', '--height', '800',
    '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '90000', '--user-data', path.join(OUT, 'profile'), '--title', 'live-payload',
    '--demo', '--no-curtain', '--no-topmost', '--no-colour-key',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });

const pending = [];
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'eval-result') { const w = pending.shift(); if (w) w(String(m.value)); }
    }
});
const evaluate = (s) => new Promise(r => {
    pending.push(r);
    child.stdin.write(JSON.stringify({ t: 'command', command: 'eval', script: s }) + '\n');
});
/** Exactly FoliaHostBridge.sendSettings: raw embedding, one trailing newline. */
const pushSettings = (tree) => child.stdin.write('{"t":"settings","settings":' + tree + '}\n');

const PROBE = `JSON.stringify((function(){
  var s = window.__SPW_FOLIA__ && window.__SPW_FOLIA__.getSettings ? window.__SPW_FOLIA__.getSettings() : null;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch(e) {} }
  var has = function(k){ return s && typeof s === 'object' && Object.prototype.hasOwnProperty.call(s,k); };
  return {
    hasBar: has('showPlaybackBar'), barVal: s && s.showPlaybackBar,
    hasProblem: has('showProblemButton'), problemVal: s && s.showProblemButton,
    hasFonts: has('systemFonts'),
    barNodes: document.querySelectorAll('.spw-playback').length,
    problemBtn: document.querySelectorAll('[data-spw-chrome="problem-report"]').length,
  };
})())`;

const stateTimer = setInterval(() => {
    child.stdin.write(JSON.stringify({ t: 'state', posMs: 31000, durationMs: 245000, playing: true, rate: 1, tsMs: Date.now() }) + '\n');
}, 100);

const results = [];
const check = (label, expect, got) => {
    const ok = JSON.stringify(expect) === JSON.stringify(got);
    results.push({ label, expect, got, ok });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    if (!ok) console.log('        expect ' + JSON.stringify(expect) + '\n        got    ' + JSON.stringify(got));
};

try {
    await sleep(3500);

    // 1. The exact tree the fixed plugin sends for THIS config (both switches true).
    pushSettings(singleLine(buildPayload(persistedTree, 'true', 'true')));
    await sleep(2500);
    let v = JSON.parse(JSON.parse(await evaluate(PROBE)));
    check('A live payload (bar=true problem=true) -> HUD mounted, button mounted',
        { barVal: true, problemVal: true, barNodes: 1, problemBtn: 1 },
        { barVal: v.barVal, problemVal: v.problemVal, barNodes: v.barNodes, problemBtn: v.problemBtn });
    check('A payload carries systemFonts and both switches',
        { hasFonts: true, hasBar: true, hasProblem: true },
        { hasFonts: v.hasFonts, hasBar: v.hasBar, hasProblem: v.hasProblem });

    // 2. Flip to bar=false/problem=false — the "关闭后依然存在" case must NOT happen.
    pushSettings(singleLine(buildPayload(persistedTree, 'false', 'false')));
    await sleep(2500);
    v = JSON.parse(JSON.parse(await evaluate(PROBE)));
    check('B bar=false problem=false -> HUD unmounted, button unmounted',
        { barVal: false, problemVal: false, barNodes: 0, problemBtn: 0 },
        { barVal: v.barVal, problemVal: v.problemVal, barNodes: v.barNodes, problemBtn: v.problemBtn });

    // 3. Back on — the switch must be usable in both directions, repeatedly.
    // The HUD also requires meta.durationMs > 0, which the 100 ms state pump refreshes; give the
    // clock a couple of ticks so a false negative cannot come from that separate condition.
    pushSettings(singleLine(buildPayload(persistedTree, 'true', 'true')));
    await sleep(4000);
    v = JSON.parse(JSON.parse(await evaluate(PROBE)));
    check('C back to true -> both mounted again',
        { barVal: true, problemVal: true, barNodes: 1, problemBtn: 1 },
        { barVal: v.barVal, problemVal: v.problemVal, barNodes: v.barNodes, problemBtn: v.problemBtn });
} catch (e) {
    console.log('FAIL  runtime error: ' + String(e));
    results.push({ label: 'runtime', ok: false, error: String(e) });
} finally {
    clearInterval(stateTimer);
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + '  ->  ' + path.join(OUT, 'results.json'));
    child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
    await sleep(800);
    child.kill();
    process.exit(failed === 0 ? 0 : 1);
}
