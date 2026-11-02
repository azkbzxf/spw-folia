// Acceptance check for the v0.4.9 "no pink background" fix.
//
// User report: 「调试时，不要用粉色的背景」「粉色的背景很影响观感」.
//
// Root cause (docs/live-transparency.md §4.6): LWA_COLORKEY only punches out pixels that EXACTLY
// match the key colour. WebView2 composites its surface onto the window BackColor, which IS the key
// colour, so a page pixel with 0 < alpha < 1 becomes `alpha*page + (1-alpha)*KEY` — not an exact
// match, so it stays on screen tinted by the key. At rgb(255,0,255) a 50 % white edge became
// rgb(255,128,255): the pink haze. Only pixels that stay at BACKCOLOR (alpha 0, or a page that paints
// nothing at all) get punched out, so the tint was everywhere content actually was.
//
// This script measures the REAL screen (GDI), because CoreWebView2.CapturePreviewAsync — which the
// host's --screenshot uses — captures the WebView2 surface only and never shows the window background.
// That blind spot is why the existing screenshot-based checks never caught this.
//
// Usage: node poc/settings-ui/scripts/verify-colour-key.mjs
// Exit code 0 = PASS, 1 = FAIL.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const EXE = path.join(REPO, 'poc', 'webview', 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.join(REPO, 'poc', 'webview', 'dist', 'dist');
const OUT = path.join(REPO, '.tmp-colour-key');
const PY = 'C:/Users/24037/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/python/python.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Must stay in sync with HostForm.TransparencyKeyColor. */
const KEY = [1, 0, 1];
/** The colour users complained about; nothing may still land here. */
const OLD_KEY = [255, 0, 255];

if (!fs.existsSync(EXE)) throw new Error('missing host exe: ' + EXE + ' (run bash poc/webview/host/build.sh)');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const report = { checks: [], runs: [], failures: [] };
function check(name, ok, detail) {
    report.checks.push({ name, ok, detail });
    if (!ok) report.failures.push(name + ': ' + JSON.stringify(detail));
    console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' ' + (detail === undefined ? '' : JSON.stringify(detail)));
}

function startHost(label, settings, extra) {
    const settingsPath = path.join(OUT, 'settings-' + label + '.json');
    if (settings) fs.writeFileSync(settingsPath, JSON.stringify({ settings }));
    const args = [
        '--bundle', BUNDLE, '--fullscreen', '--demo', '--no-overlay',
        '--user-data', path.join(OUT, 'profile'),
        '--keep-alive',
    ];
    if (settings) args.push('--dev-settings', settingsPath);
    const child = spawn(EXE, args.concat(extra || []), {
        cwd: path.join(REPO, 'poc', 'webview'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const log = [];
    const waiters = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        log.push(chunk);
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('{')) continue;
            let m; try { m = JSON.parse(line); } catch { continue; }
            if (m.t === 'eval-result') { const w = waiters.shift(); if (w) w(String(m.value)); }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { });
    const evaluate = (script) => new Promise((resolve) => {
        waiters.push(resolve);
        try { child.stdin.write(JSON.stringify({ t: 'command', command: 'eval', script }) + '\n'); } catch { resolve('null'); }
    });
    return {
        child, log, evaluate,
        lines: () => log.join('').split('\n').map((l) => l.trim()).filter(Boolean),
        stop: async () => {
            try { child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n'); } catch { /* gone */ }
            await sleep(1100);
            try { child.kill(); } catch { /* gone */ }
        },
    };
}

/** Real full-screen capture through GDI (the only path that includes the window background). */
function captureScreen(file) {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save('${file.replace(/\//g, '\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`], { encoding: 'utf8' });
}

/** Pixel stats: sampled points plus the magenta-family share of the whole frame. */
function analyse(file, extraPoints) {
    const py = `
import json, sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
px = list(im.getdata())
n = len(px)
key = tuple(int(x) for x in sys.argv[2].split(','))
old = tuple(int(x) for x in sys.argv[3].split(','))
points = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {}
def pct(pred):
    return round(100.0 * sum(1 for r, g, b in px if pred(r, g, b)) / n, 3)
out = {
  'size': [w, h],
  'pinkFamilyPct': pct(lambda r, g, b: r > 60 and b > 60 and g < min(r, b) * 0.75),
  'strongPinkPct': pct(lambda r, g, b: r > 150 and b > 150 and g < min(r, b) * 0.55),
  'oldKeyPct': pct(lambda r, g, b: (r, g, b) == old),
  'newKeyPct': pct(lambda r, g, b: (r, g, b) == key),
}
for name, (fx, fy) in points.items():
    out[name] = list(im.getpixel((int(w * fx), int(h * fy))))
print(json.dumps(out))
`;
    return JSON.parse(execFileSync(PY, ['-c', py, file, KEY.join(','), OLD_KEY.join(','), JSON.stringify(extraPoints || {})], { encoding: 'utf8' }).trim());
}

// The page must be driven into a REAL transparent compositing state. `--demo` runs the OBS page
// without the settings island, so nothing calls __spwFoliaSetTransparent and the page keeps painting
// its own background. Clearing every painted background reproduces exactly the surface a transparent
// session hands to the key: alpha-0 everywhere except the marks.
const MAKE_TRANSPARENT = `(function(){
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    if (e.id === 'spw-alpha-50' || e.id === 'spw-alpha-25' || e.id === 'spw-opaque-band') continue;
    var tag = e.tagName;
    if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IMG') { e.style.display = 'none'; continue; }
    e.style.background = 'transparent';
    e.style.backgroundColor = 'transparent';
    e.style.backdropFilter = 'none';
    e.style.boxShadow = 'none';
  }
  return 'cleared';
})()`;

const ADD_MARKS = `(function(){
  var a = document.createElement('div');
  a.id = 'spw-alpha-50';
  a.style.cssText = 'position:fixed;left:8%;top:12%;width:36%;height:30%;z-index:2147483001;background:rgba(255,255,255,0.5)';
  document.body.appendChild(a);
  var b = document.createElement('div');
  b.id = 'spw-alpha-25';
  b.style.cssText = 'position:fixed;left:52%;top:12%;width:36%;height:30%;z-index:2147483001;background:rgba(255,255,255,0.25)';
  document.body.appendChild(b);
  return 'marks';
})()`;

// ---------------------------------------------------------------- run 1: key live, new colour
console.log('\n=== run 1: transparent session, colour key live (new key colour) ===');
{
    const host = startHost('key', { transparentPlayerBackground: true, mousePassthrough: false });
    await sleep(4500);
    await host.evaluate(MAKE_TRANSPARENT);
    await host.evaluate(ADD_MARKS);
    await sleep(1500);
    const shot = path.join(OUT, 'key-live.png');
    captureScreen(shot);
    await host.stop();

    const stats = analyse(shot, { mark50: [0.26, 0.27], mark25: [0.70, 0.27], outside: [0.5, 0.85] });
    console.log('pixel stats:', JSON.stringify(stats));
    report.runs.push({ name: 'key-live', shot, stats });

    // 50 % white over the key: old key => (255,128,255) pink; new key => ~128 grey.
    const m50 = stats.mark50;
    check('50 %-alpha page pixels are not tinted magenta',
        m50[0] > 100 && m50[1] > 100 && m50[2] > 100 && Math.abs(m50[0] - m50[2]) < 12, m50);
    check('no magenta-family pixels anywhere in the frame', stats.pinkFamilyPct === 0, stats.pinkFamilyPct);
    check('the old magenta key never appears', stats.oldKeyPct === 0, stats.oldKeyPct);
    // "outside" is page alpha 0 -> BackColor -> the key. It stays the key colour only where the key
    // does not punch through (WebView2 surface); either way it must be the new near-black value.
    check('the window background is the new near-black key',
        stats.outside[0] <= 2 && stats.outside[1] <= 2 && stats.outside[2] <= 2, stats.outside);
    report.run1 = stats;
}

// ---------------------------------------------------------------- run 2: --no-colour-key
console.log('\n=== run 2: --no-colour-key (debug capture path) ===');
{
    const host = startHost('nokey', { transparentPlayerBackground: true, mousePassthrough: false }, ['--no-colour-key']);
    await sleep(4500);
    await host.evaluate(MAKE_TRANSPARENT);
    await host.evaluate(ADD_MARKS);
    await sleep(1500);
    const shot = path.join(OUT, 'key-off.png');
    captureScreen(shot);
    await host.stop();

    const lines = host.lines();
    const offLine = lines.find((l) => l.includes('colour-key=off')) || '';
    const opaqueLine = lines.find((l) => l.includes('keeping the page opaque')) || '';
    const stats = analyse(shot, { mark50: [0.26, 0.27], outside: [0.5, 0.85] });
    console.log('pixel stats:', JSON.stringify(stats));
    console.log('log:', offLine, '|', opaqueLine);
    report.runs.push({ name: 'key-off', shot, stats });

    check('host reports the colour key as disabled', !!offLine, offLine || '(none)');
    check('host keeps the page opaque instead of keyed', !!opaqueLine, opaqueLine || '(none)');
    check('no pink in the debug capture', stats.pinkFamilyPct === 0 && stats.oldKeyPct === 0,
        { pink: stats.pinkFamilyPct, oldKey: stats.oldKeyPct });
    check('window background is plain black, not the key colour',
        stats.outside[0] === 0 && stats.outside[1] === 0 && stats.outside[2] === 0, stats.outside);
    report.run2 = { stats, offLine, opaqueLine };
}

// ---------------------------------------------------------------- run 3: the page never paints the key
// Real Folia styles rendered normally (opaque capture: CapturePreviewAsync, so window background cannot
// contaminate the result). A page pixel equal to the key would be punched into a hole, so this is the
// check that the new key is safe to keep permanently.
console.log('\n=== run 3: the page itself never paints the key colour ===');
{
    const styles = ['sonnet', 'tempera', 'lumiere', 'classic', 'monet', 'claddagh'];
    const findings = [];
    for (const style of styles) {
        const shot = path.join(OUT, 'page-' + style + '.png');
        const child = spawn(EXE, [
            '--bundle', BUNDLE, '--mode', style, '--fullscreen', '--demo', '--no-overlay', '--no-topmost',
            '--no-curtain', '--no-colour-key',
            '--user-data', path.join(OUT, 'profile-page'),
            '--screenshot', shot, '--shot-at', '4000', '--keep-alive',
        ], { cwd: path.join(REPO, 'poc', 'webview'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        child.stdout.on('data', () => { });
        child.stderr.on('data', () => { });
        const deadline = Date.now() + 25000;
        let stable = -1;
        while (Date.now() < deadline) {
            await sleep(300);
            let size = 0;
            try { size = fs.statSync(shot).size; } catch { continue; }
            if (size > 50000 && size === stable) break;
            stable = size;
        }
        try { child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n'); } catch { /* gone */ }
        await sleep(900);
        try { child.kill(); } catch { /* gone */ }
        if (!fs.existsSync(shot)) { findings.push({ style, error: 'no screenshot' }); continue; }
        const stats = analyse(shot, {});
        findings.push({ style, exactKey: stats.newKeyPct, size: stats.size });
        console.log('  ' + style.padEnd(10) + ' newKeyPct=' + stats.newKeyPct + '%  ' + JSON.stringify(stats.size));
    }
    report.runs.push({ name: 'page-key-scan', findings });
    const offenders = findings.filter((f) => f.error || f.exactKey > 0);
    check('no Folia style paints the key colour (nothing would be punched out)', offenders.length === 0, offenders);
    report.run3 = findings;
}

fs.writeFileSync(path.join(OUT, 'colour-key-report.json'), JSON.stringify(report, null, 2));
console.log('\nreport:', path.join(OUT, 'colour-key-report.json'));
if (report.failures.length) {
    console.error('\n' + report.failures.length + ' FAILED check(s):');
    report.failures.forEach((f) => console.error('  - ' + f));
    process.exit(1);
}
console.log('\nall checks passed');
