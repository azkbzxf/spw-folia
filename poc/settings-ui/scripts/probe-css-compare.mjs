// Compare the top (player) document and the preview child document: stylesheet lists, whether
// Tailwind utility classes resolve, and the OBS wrapper geometry. Tells apart "preview.html is
// missing CSS" (child-only) from "the whole bundle has no utilities" (global).
//
//   node scripts/probe-css-compare.mjs <bundleDir> <userDataDir>
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = process.argv[2];
const PROFILE = process.argv[3];

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--fullscreen',
    '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '40000',
    '--user-data', PROFILE,
    '--title', 'css compare',
    '--demo', '--no-topmost',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });

const waiters = [];
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.t === 'eval-result') {
            const waiter = waiters.shift();
            if (waiter) waiter(String(msg.value));
        }
    }
});
child.stderr.on('data', d => process.stderr.write(d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const evalRaw = script => new Promise(resolve => {
    waiters.push(resolve);
    child.stdin.write(JSON.stringify({ t: 'command', command: 'eval', script }) + '\n');
});
const decode = raw => {
    let value = raw;
    for (let i = 0; i < 3; i++) {
        if (typeof value !== 'string') break;
        try { value = JSON.parse(value); } catch { break; }
    }
    return value;
};
const evalValue = async script => decode(await evalRaw(script));

const pin = () => child.stdin.write(JSON.stringify({
    t: 'state', posMs: 1500, durationMs: 16000, playing: true, rate: 1, tsMs: Date.now(),
}) + '\n');

await sleep(7000);
setInterval(pin, 100);
pin();
await sleep(2500);
child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');
await sleep(4500);

const out = await evalValue(`(function(){
  var probeDoc = function (doc, win) {
    var test = doc.createElement('div');
    test.className = 'relative w-full h-full';
    doc.body.appendChild(test);
    var cs = win.getComputedStyle(test);
    var result = { position: cs.position, height: cs.height, width: cs.width };
    test.remove();
    var sheets = [].slice.call(doc.styleSheets).map(function (s) {
      var n = -1;
      try { n = s.cssRules ? s.cssRules.length : -1; } catch (e) { n = -2; }
      return { href: (s.href || 'inline').split('/').pop(), rules: n };
    });
    // Does any rule mention .h-full?
    var hasHFull = false;
    try {
      for (var i = 0; i < doc.styleSheets.length; i++) {
        var rules = doc.styleSheets[i].cssRules || [];
        for (var j = 0; j < rules.length; j++) {
          if (String(rules[j].cssText || '').indexOf('.h-full') >= 0) { hasHFull = true; break; }
        }
        if (hasHFull) break;
      }
    } catch (e) { /* cross-origin */ }
    return { utilityProbe: result, sheets: sheets, hasHFullRule: hasHFull };
  };
  var top = probeDoc(document, window);
  var frame = document.querySelector('[data-spw-live-preview] iframe');
  var childDoc = frame && frame.contentWindow ? frame.contentWindow.document : null;
  var childRes = childDoc ? probeDoc(childDoc, frame.contentWindow) : null;
  return { top: top, child: childRes };
})()`);
console.log(JSON.stringify(out, null, 2));

child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
await sleep(1200);
try { child.kill(); } catch { /* done */ }
process.exit(0);
