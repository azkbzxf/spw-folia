// Regression test for the v0.4.12 → v0.4.13 fix「三个配置开关全部不生效」.
//
// The bug: `sendSettings()` embeds the settings tree RAW into a newline-terminated line
//      {"t":"settings","settings":<tree>}
// while the helper reads with ReadLine(). The bundled default-settings.json is PRETTY-PRINTED
// (7188 bytes / 268 newlines), so the push was shredded into invalid fragments and dropped. The
// page kept stale values and echoed them back, which is why the switches looked dead.
//
// This test drives the SHIPPED host exe + SHIPPED settings island, and compares the two payload
// shapes the plugin can now emit:
//   PRETTY  - the raw pretty tree (what used to be sent; must be BROKEN)
//   COLLAPSED - Json.singleLine(tree) (what v0.4.13 sends; must WORK)
//
// Exit 0 = the fix holds (COLLAPSED applies, PRETTY demonstrably does not).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/输出目录/spw-folia';
const EXE = path.join(REPO, 'packaging', 'native', 'spw-folia-host.exe');
const BUNDLE = path.join(REPO, 'packaging', 'web');
const TREE_SRC = path.join(REPO, 'packaging', 'testdata', 'default-settings.json');
const OUT = 'C:/tmp/trayverify/switches-v0413';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pretty = fs.readFileSync(TREE_SRC, 'utf8').trim();
const base = JSON.parse(pretty);

/** Same whitespace-collapse rule as dev.spw.folia.Json.singleLine (string-literal aware). */
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

/** Injects the two switches the way Json.withBoolMember does: text surgery before the last `}`. */
function inject(tree, bar, problem) {
    const trimmed = tree.trimEnd();
    const tail = trimmed.slice(-1);
    if (tail !== '}') throw new Error('tree must end with }');
    const body = trimmed.slice(0, -1);
    return body + ',"showPlaybackBar":' + bar + ',"showProblemButton":' + problem + '}';
}

function runHost() {
    const child = spawn(EXE, [
        '--bundle', BUNDLE, '--windowed', '--width', '1280', '--height', '800',
        '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
        '--duration', '90000', '--user-data', path.join(OUT, 'profile'), '--title', 'switches-v0413',
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
    const pushRaw = (tree) => child.stdin.write('{"t":"settings","settings":' + tree + '}\n');
    return { child, evaluate, pushRaw };
}

const PROBE = `JSON.stringify((function(){
  var s = window.__SPW_FOLIA__ && window.__SPW_FOLIA__.getSettings ? window.__SPW_FOLIA__.getSettings() : null;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch(e) {} }
  var has = function(k){ return s && typeof s === 'object' && Object.prototype.hasOwnProperty.call(s,k); };
  return {
    hasBar: has('showPlaybackBar'), barVal: s && s.showPlaybackBar,
    hasProblem: has('showProblemButton'), problemVal: s && s.showProblemButton,
    barNodes: document.querySelectorAll('.spw-playback').length,
    problemBtn: document.querySelectorAll('[data-spw-chrome="problem-report"]').length,
  };
})())`;

const results = [];
const record = (label, expect, got) => {
    const ok = JSON.stringify(expect) === JSON.stringify(got);
    results.push({ label, expect, got, ok });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    if (!ok) console.log('        expect ' + JSON.stringify(expect) + ' got ' + JSON.stringify(got));
    return ok;
};

const { child, evaluate, pushRaw } = runHost();
const stateTimer = setInterval(() => {
    child.stdin.write(JSON.stringify({ t: 'state', posMs: 31000, durationMs: 245000, playing: true, rate: 1, tsMs: Date.now() }) + '\n');
}, 100);

try {
    await sleep(3500);
    console.log('pretty tree = ' + pretty.length + ' bytes, ' + (pretty.match(/\n/g) || []).length + ' newlines');
    console.log('collapsed   = ' + singleLine(pretty).length + ' bytes, 0 newlines\n');

    // 1. BASELINE: what v0.4.12 actually sent — a pretty tree. Mark it with bar=false/problem=true.
    // The point is that the page is NOT updated by it; it keeps whatever it had. Normalise the
    // undefined-vs-present distinction with String() so the record is readable.
    pushRaw(inject(pretty, 'false', 'true'));
    await sleep(2500);
    let v = JSON.parse(JSON.parse(await evaluate(PROBE)));
    record('A PRETTY tree is DROPPED by the line protocol (the v0.4.12 regression)',
        { barVal: 'undefined', problemVal: 'undefined' },
        { barVal: String(v.barVal), problemVal: String(v.problemVal) });

    // 2. THE FIX: same content, collapsed to a single line.
    pushRaw(singleLine(inject(pretty, 'false', 'true')));
    await sleep(2500);
    v = JSON.parse(JSON.parse(await evaluate(PROBE)));
    record('B COLLAPSED tree is APPLIED — bar=false hides the HUD, problem=true shows the button',
        { barVal: false, problemVal: true, barNodes: 0, problemBtn: 1 },
        { barVal: v.barVal, problemVal: v.problemVal, barNodes: v.barNodes, problemBtn: v.problemBtn });

    // 3. And the inverse, so this is not "stuck on one value".
    pushRaw(singleLine(inject(pretty, 'true', 'false')));
    await sleep(2500);
    v = JSON.parse(JSON.parse(await evaluate(PROBE)));
    record('C COLLAPSED tree flips back — bar=true shows the HUD, problem=false hides the button',
        { barVal: true, problemVal: false, barNodes: 1, problemBtn: 0 },
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
