// Are the child document's stylesheets actually applied? A class like `relative` computing to
// `position: static` means the Tailwind sheet did not load/parse in preview.html, which would explain
// the renderer collapsing to a 270px strip (h-full unresolved).
//
//   node scripts/probe-child-css.mjs <bundleDir> <userDataDir>
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
    '--title', 'child css probe',
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
child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');
await sleep(2000);
const pinner = setInterval(pin, 100);
pin();
await sleep(4000);
clearInterval(pinner);

const out = await evalValue(`(function(){
  var frame = document.querySelector('[data-spw-live-preview] iframe');
  var w = frame.contentWindow;
  var doc = w.document;
  var sheets = [].slice.call(doc.styleSheets).map(function (s) {
    var rules = 0;
    try { rules = s.cssRules ? s.cssRules.length : -1; } catch (e) { rules = -2; }
    return { href: s.href, rules: rules, owner: s.ownerNode ? s.ownerNode.tagName + ':' + (s.ownerNode.getAttribute('href') || s.ownerNode.getAttribute('data-vite-dev-id') || '').slice(0, 60) : null };
  });
  var links = [].slice.call(doc.querySelectorAll('link[rel=stylesheet]')).map(function (l) { return l.href; });
  var test = doc.createElement('div');
  test.className = 'relative w-full h-full';
  test.style.cssText = 'width:100px;height:100px';
  doc.body.appendChild(test);
  var cs = w.getComputedStyle(test);
  var probe = { position: cs.position, height: cs.height, display: cs.display };
  test.remove();
  return {
    sheets: sheets,
    links: links,
    tailwindProbe: probe,
    rootHtml: doc.documentElement.outerHTML.slice(0, 400),
  };
})()`);
console.log(JSON.stringify(out, null, 2));

child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
await sleep(1200);
try { child.kill(); } catch { /* done */ }
process.exit(0);
