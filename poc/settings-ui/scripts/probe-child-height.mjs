// Walk the live-preview child document from #root down to the visualizer shell and print every
// element's height plus what could be constraining it. Answers "why is the child renderer only
// 270px tall inside a 1080px viewport" (the 预览框显示不全 symptom).
//
//   node scripts/probe-child-height.mjs <bundleDir> <userDataDir>
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

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--fullscreen',
    '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '40000',
    '--user-data', PROFILE,
    '--title', 'child height probe',
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
  var frame = document.querySelector('[data-spw-live-preview] iframe');
  var w = frame.contentWindow;
  var doc = w.document;
  var rows = [];
  var el = doc.querySelector('#root') || doc.body.firstElementChild;
  var depth = 0;
  while (el && depth < 12) {
    var r = el.getBoundingClientRect();
    var cs = w.getComputedStyle(el);
    rows.push({
      depth: depth,
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 70),
      inlineStyle: (el.getAttribute('style') || '').slice(0, 120),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      css: { h: cs.height, minH: cs.minHeight, maxH: cs.maxHeight, zoom: cs.zoom, transform: cs.transform.slice(0, 40), position: cs.position },
    });
    // follow the largest child so we walk the main column, not a side panel
    var kids = [].slice.call(el.children);
    if (!kids.length) break;
    kids.sort(function (a, b) { return b.getBoundingClientRect().height - a.getBoundingClientRect().height; });
    el = kids[0];
    depth++;
  }
  return {
    viewport: { w: w.innerWidth, h: w.innerHeight, dpr: w.devicePixelRatio,
                docW: doc.documentElement.clientWidth, docH: doc.documentElement.clientHeight },
    chain: rows,
  };
})()`);
console.log(JSON.stringify(out, null, 2));

child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
await sleep(1200);
try { child.kill(); } catch { /* done */ }
process.exit(0);
