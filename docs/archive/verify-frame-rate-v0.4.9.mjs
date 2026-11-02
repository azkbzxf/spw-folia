// Acceptance check for the v0.4.9 帧率 setting (SPW 配置页 → 播放页 → 帧率).
//
// What is being proven:
//   1. `--frame-rate <off|120|90|60>` reaches Folia's own limiter. The marker is upstream's
//      `window.__foliaNativeRequestAnimationFrame`, which `installGlobalVisualizerFrameRateLimiter()`
//      only defines while a cap is installed — `'off'` calls `restoreGlobalVisualizerFrameRateLimiter()`
//      and leaves it undefined. That separates "no cap" from "cap at a rate the display already runs
//      at", which fps numbers alone cannot (the panel's refresh rate is a hard ceiling).
//   2. The value the shim put into `localStorage['visualizer_frame_rate']` is the requested one.
//   3. fps actually differs between the un-capped setting and the low caps.
//
// NOTE on 90: upstream's `shouldProcessFrameAtRate` computes `1000/90 - 1 = 10.11 ms`, which on a
// 120 Hz display (8.33 ms/frame) cannot be met every frame and therefore lands on every *second*
// frame = 60 fps. That is an upstream defect, documented in docs/upstream-sync.md §10.2 — this script
// asserts the setting REACHED upstream for 90 (capped=true), not that it produced 90 fps.
//
// Usage: node poc/settings-ui/scripts/verify-frame-rate.mjs [--quick]
// Exit code 0 = PASS, 1 = FAIL.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const EXE = path.join(REPO, 'poc', 'webview', 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.join(REPO, 'poc', 'webview', 'dist', 'dist');
const OUT = path.join(REPO, '.tmp-frame-rate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUICK = process.argv.includes('--quick');
const SAMPLE_MS = QUICK ? 7000 : 12000;

if (!fs.existsSync(EXE)) throw new Error('missing host exe: ' + EXE + ' (run bash poc/webview/host/build.sh)');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const report = { checks: [], runs: [], failures: [] };
function check(name, ok, detail) {
    report.checks.push({ name, ok, detail });
    if (!ok) report.failures.push(name + ': ' + JSON.stringify(detail));
    console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' ' + (detail === undefined ? '' : JSON.stringify(detail)));
}

function median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Runs one host session at `mode` and returns the fps samples it logged plus the applied record. */
async function runMode(mode) {
    const fpsLogPath = path.join(OUT, 'fps-' + mode + '.log');
    const log = [];
    const child = spawn(EXE, [
        '--bundle', BUNDLE, '--window', '1600x900', '--demo', '--no-overlay', '--no-topmost',
        '--no-colour-key', '--no-curtain',
        '--frame-rate', mode,
        '--fps-log', fpsLogPath,
        '--keep-alive',
        '--user-data', path.join(OUT, 'profile-' + mode),
    ], { cwd: path.join(REPO, 'poc', 'webview'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => log.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { });

    await sleep(SAMPLE_MS);
    try { child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n'); } catch { /* gone */ }
    await sleep(1200);
    try { child.kill(); } catch { /* gone */ }

    const samples = [];
    const cappedFlags = [];
    const storedSeen = [];
    if (fs.existsSync(fpsLogPath)) {
        for (const raw of fs.readFileSync(fpsLogPath, 'utf8').split('\n')) {
            const t = raw.trim();
            if (!t.startsWith('{')) continue;
            let m; try { m = JSON.parse(t); } catch { continue; }
            if (m.t !== 'fps' && m.type !== 'fps') continue;
            if (typeof m.fps !== 'number') continue;
            samples.push(m.fps);
            if (typeof m.capped === 'boolean') cappedFlags.push(m.capped);
            storedSeen.push(m.frameRate === undefined ? null : m.frameRate);
        }
    }
    const steady = samples.slice(2);            // drop startup/first-paint windows
    return {
        mode,
        sampleCount: samples.length,
        median: median(steady),
        // Read on every tick; the last one is the settled state.
        capped: cappedFlags.length ? cappedFlags[cappedFlags.length - 1] : null,
        stored: storedSeen.length ? storedSeen[storedSeen.length - 1] : null,
        applied: (log.join('').split('\n').find((l) => l.indexOf('frame-rate applied') >= 0) || '').trim(),
        samples: steady,
    };
}

const MODES = ['off', '120', '90', '60'];
console.log('=== measuring ' + MODES.join(' / ') + ' (' + (SAMPLE_MS / 1000) + 's each) ===\n');
const runs = {};
for (const mode of MODES) {
    const r = await runMode(mode);
    runs[mode] = r;
    report.runs.push(r);
    console.log(mode.padEnd(4)
        + ' stored=' + String(r.stored).padEnd(5)
        + ' capped=' + String(r.capped).padEnd(6)
        + ' median=' + String(r.median).padStart(6)
        + '  (n=' + r.samples.length + ')');
}

console.log('\n=== assertions ===');
// Each mode must land in localStorage verbatim, or the setting never reached the page.
for (const mode of MODES) {
    check('storage carries "' + mode + '"', runs[mode].stored === mode, runs[mode].stored);
}
// `off` must LIFT the cap; every other value must INSTALL it. This is the setting-reached-upstream
// proof and the only reliable separator between 'off' and a cap equal to the display rate.
check('"off" leaves the visualizer uncapped', runs.off.capped === false, runs.off.capped);
for (const mode of ['120', '90', '60']) {
    check('"' + mode + '" installs the rAF cap', runs[mode].capped === true, runs[mode].capped);
}
// fps sanity: uncapped must beat the low caps clearly. 90 is excluded from any fps expectation on
// purpose — see the header note (upstream quantises it to the next vsync boundary).
check('uncapped fps is at least 1.5x the 60 cap',
    runs.off.median != null && runs['60'].median != null && runs.off.median >= runs['60'].median * 1.5,
    { off: runs.off.median, cap60: runs['60'].median });
check('120 cap does not drop below the 60 cap',
    runs['120'].median != null && runs['60'].median != null && runs['120'].median >= runs['60'].median,
    { cap120: runs['120'].median, cap60: runs['60'].median });
// A default that is not "off" would silently change behaviour for every existing user.
const prefsPath = path.join(REPO, 'spw-folia', 'src', 'main', 'resources', 'preference_config.json');
const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
const group = prefs.configs.find((c) => (c.preferences || []).some((p) => p.key === 'frameRate'));
const pref = group && group.preferences.find((p) => p.key === 'frameRate');
check('配置页 declares the 帧率 preference', !!pref, pref ? pref.type : '(missing)');
check('declared default is "off" (unchanged behaviour for existing users)',
    !!pref && pref.default_value === 'off', pref && pref.default_value);
check('entries and entry_values are parallel and consistent',
    !!pref && Array.isArray(pref.entries) && Array.isArray(pref.entry_values)
    && pref.entries.length === pref.entry_values.length
    && pref.entry_values.includes(pref.default_value)
    && pref.entry_values.every((v) => ['off', '120', '90', '60'].includes(v)),
    pref && { entries: pref.entries, entry_values: pref.entry_values });

// ---------------------------------------------------------------- negative paths
// Tolerance chain: preference_config entry_values → FoliaPlugin.normaliseFrameRate → Program.NormaliseFrameRate
// → the page's normaliseFrameRate. Every layer must map garbage to 'off', because 'off' is upstream's
// own default — so a broken setting degrades to "exactly like before this feature existed" rather than
// to an unexplained cap. The stale-value case matters most: the host writes the value unconditionally,
// so an earlier cap cannot survive a switch back to 无限制.
console.log('\n=== negative paths: garbage and stale values must all end up uncapped ===');

async function runRaw(argsExtra, label, waitMs) {
    const fpsLogPath = path.join(OUT, 'fps-' + label + '.log');
    try { fs.rmSync(fpsLogPath); } catch { /* none */ }
    const log = [];
    const child = spawn(EXE, [
        '--bundle', BUNDLE, '--window', '1600x900', '--demo', '--no-overlay', '--no-topmost',
        '--no-colour-key', '--no-curtain', '--fps-log', fpsLogPath, '--keep-alive',
        '--user-data', path.join(OUT, 'profile-negative'),
    ].concat(argsExtra), { cwd: path.join(REPO, 'poc', 'webview'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => log.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { });
    await sleep(waitMs || 9000);
    try { child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n'); } catch { /* gone */ }
    await sleep(1200);
    try { child.kill(); } catch { /* gone */ }
    let last = null;
    let count = 0;
    if (fs.existsSync(fpsLogPath)) {
        for (const raw of fs.readFileSync(fpsLogPath, 'utf8').split('\n')) {
            const t = raw.trim();
            if (!t.startsWith('{')) continue;
            let m; try { m = JSON.parse(t); } catch { continue; }
            if (m.t !== 'fps') continue;
            last = m;
            count += 1;
        }
    }
    const errored = log.join('').split('\n').some((l) => l.indexOf('"level":"error"') >= 0);
    return { count, last, errored };
}

for (const bad of ['abc', '30', '-1', '144', '无限制']) {
    const r = await runRaw(['--frame-rate', bad], 'bad-' + Buffer.from(bad).toString('hex'), 9000);
    check('garbage "' + bad + '" degrades to uncapped, without an error line',
        r.count > 0 && r.last && r.last.frameRate === 'off' && r.last.capped === false && !r.errored,
        r.last ? { frameRate: r.last.frameRate, capped: r.last.capped, errored: r.errored } : 'no samples');
}
{
    const r = await runRaw([], 'no-arg', 9000);
    check('omitting --frame-rate leaves the visualizer uncapped',
        r.count > 0 && r.last && r.last.capped === false,
        r.last ? { frameRate: r.last.frameRate, capped: r.last.capped } : 'no samples');
}
{
    // Same --user-data profile on purpose, so the second run inherits the first run's localStorage.
    const capped = await runRaw(['--frame-rate', '60'], 'stale-60', 9000);
    check('a 60 cap really installs before the stale-value test',
        capped.count > 0 && capped.last && capped.last.capped === true,
        capped.last ? { frameRate: capped.last.frameRate, capped: capped.last.capped } : 'no samples');
    const lifted = await runRaw(['--frame-rate', 'off'], 'stale-off', 9000);
    check('switching to "off" overwrites a previously stored cap and lifts the limiter',
        lifted.count > 0 && lifted.last && lifted.last.frameRate === 'off' && lifted.last.capped === false,
        lifted.last ? { frameRate: lifted.last.frameRate, capped: lifted.last.capped } : 'no samples');
}

report.summary = {
    modes: Object.fromEntries(MODES.map((m) => [m, { median: runs[m].median, capped: runs[m].capped, stored: runs[m].stored }])),
};
fs.writeFileSync(path.join(OUT, 'frame-rate-report.json'), JSON.stringify(report, null, 2));
console.log('\n--- median table ---');
for (const m of MODES) {
    console.log('  ' + m.padEnd(4) + ' ' + String(runs[m].median).padStart(6) + ' fps   capped=' + runs[m].capped + '   stored=' + runs[m].stored);
}
console.log('\nreport:', path.join(OUT, 'frame-rate-report.json'));
if (report.failures.length) {
    console.error('\n' + report.failures.length + ' FAILED check(s):');
    report.failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
}
console.log('\nall checks passed');
