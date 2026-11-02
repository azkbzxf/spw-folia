// Why is the child renderer 270px tall in a 1080px viewport? Dump every child of the OBS root with
// its layout role (flex parent / item, height, position) — 270 = 1080/4 smells like four h-full
// siblings shrinking inside a flex column.
//
//   node scripts/probe-child-flex.mjs <bundleDir> <userDataDir>
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
    '--title', 'child flex probe',
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
  var info = function (el) {
    var r = el.getBoundingClientRect();
    var cs = w.getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 80),
      inline: (el.getAttribute('style') || '').slice(0, 140),
      h: Math.round(r.height), w: Math.round(r.width), y: Math.round(r.top),
      css: { display: cs.display, flexDirection: cs.flexDirection, flex: cs.flex,
             height: cs.height, position: cs.position, overflow: cs.overflow },
    };
  };
  // The OBS wrapper is the element with an explicit pixel height set inline.
  var all = [].slice.call(doc.querySelectorAll('div'));
  var wrapper = all.filter(function (d) {
    return /height: 1080px/.test(d.getAttribute('style') || '');
  })[0];
  if (!wrapper) return { error: 'wrapper not found' };
  var kids = [].slice.call(wrapper.children).map(info);
  return {
    wrapper: info(wrapper),
    childCount: wrapper.children.length,
    children: kids,
    wrapperRect: wrapper.getBoundingClientRect().height,
    styleSheets: doc.styleSheets.length,
    cssVars: {
      root: w.getComputedStyle(doc.documentElement).height,
      body: w.getComputedStyle(doc.body).height,
      bodyDisplay: w.getComputedStyle(doc.body).display,
      rootDisplay: w.getComputedStyle(doc.documentElement).display,
    },
  };
})()`);
console.log(JSON.stringify(out, null, 2));

child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
await sleep(1200);
try { child.kill(); } catch { /* done */ }
process.exit(0);
