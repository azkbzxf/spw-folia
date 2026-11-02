// Diagnose why the live-preview child renders only a top strip: dump the child's canvas CSS rects,
// the size chain above each canvas, and the values ObsBrowserSourceApp derives from the viewport.
//
//   node scripts/probe-child-size.mjs <bundleDir> <userDataDir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = process.argv[2];
const PROFILE = process.argv[3];
const OUT = path.join(WEBVIEW_ROOT, 'host', 'out', 'probe-child-size');
fs.mkdirSync(OUT, { recursive: true });

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--fullscreen',
    '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '45000',
    '--user-data', PROFILE,
    '--title', 'child size probe',
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
setInterval(pin, 100);
pin();
await sleep(4000);

const out = await evalValue(`(function(){
  var box = document.querySelector('[data-spw-live-preview]');
  var frame = box.querySelector('iframe');
  var w = frame.contentWindow;
  var doc = w.document;
  var describe = function (el, depth) {
    if (!el || depth > 4) return null;
    var r = el.getBoundingClientRect();
    var cs = w.getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 50),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      css: { width: cs.width, height: cs.height, position: cs.position, display: cs.display, zoom: cs.zoom },
    };
  };
  var chain = function (el) {
    var rows = [];
    var cur = el;
    for (var i = 0; i < 6 && cur; i++) { rows.push(describe(cur, i)); cur = cur.parentElement; }
    return rows;
  };
  var canvases = [].slice.call(doc.querySelectorAll('canvas'));
  return {
    childViewport: {
      docClientW: doc.documentElement.clientWidth,
      docClientH: doc.documentElement.clientHeight,
      innerW: w.innerWidth,
      innerH: w.innerHeight,
      dpr: w.devicePixelRatio,
    },
    obsRoot: describe(doc.querySelector('#root') || doc.body.firstElementChild, 0),
    canvases: canvases.map(function (c) {
      var r = c.getBoundingClientRect();
      return {
        attr: c.width + 'x' + c.height,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        chain: chain(c.parentElement),
      };
    }),
  };
})()`);
console.log(JSON.stringify(out, null, 2));

child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
await sleep(1200);
try { child.kill(); } catch { /* done */ }
process.exit(0);
