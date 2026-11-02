// Evidence probe: are the style-shelf thumbnails actually loading? Checks every `img` in the style
// grid (naturalWidth/naturalHeight 0 = the browser's broken-image icon) and reports the resolved
// URLs, so "缩略图显示成乱码/破图" can be attributed to a 404 instead of a rendering bug.
//
//   node scripts/probe-thumbs.mjs <bundleDir> <userDataDir>
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = process.argv[2];
const PROFILE = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--windowed', '--width', '1760', '--height', '1100', '--force-dsf', '1',
    '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '30000', '--user-data', PROFILE, '--title', 'thumb probe',
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

await sleep(2500);
child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');
await sleep(5000);

const result = await evalValue(`(function(){
  var imgs = Array.prototype.slice.call(document.querySelectorAll('img')).filter(function (img) {
    return /\\/thumbs\\//.test(img.src) || /settings\\/thumbs/.test(img.currentSrc || '');
  });
  var all = Array.prototype.slice.call(document.querySelectorAll('img'));
  return {
    totalImages: all.length,
    thumbImages: imgs.length,
    loaded: imgs.filter(function (i) { return i.naturalWidth > 0; }).length,
    broken: imgs.filter(function (i) { return i.naturalWidth === 0; }).map(function (i) { return i.src; }),
    urls: imgs.slice(0, 4).map(function (i) { return { src: i.src, w: i.naturalWidth, h: i.naturalHeight }; }),
  };
})()`);

console.log(JSON.stringify(result, null, 2));

// What does the bundle host actually answer for one of those URLs?
const fetchResult = await evalValue(`(async function(){
  var sample = document.querySelector('img');
  var target = '/settings/thumbs/sonnet.jpg';
  var r = await fetch(target, { cache: 'no-store' });
  var text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type'), bytes: text.length, first: text.slice(0, 80) };
})()`);
await sleep(1500);
console.log('fetch ' + JSON.stringify(fetchResult, null, 2));

child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n');
await sleep(1200);
try { child.kill(); } catch { /* done */ }
process.exit(0);
