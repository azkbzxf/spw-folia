// Reproduce the reported screenshot exactly: the *shipped* 0.4.6.1 web tree (which has no
// settings/thumbs at all) running against a profile that still carries the older install's
// service worker. Expected: preview never becomes ready → Stage falls back to StylePreview →
// that fallback <img> 404s too → the stage is an empty black box, and the shelf shows 15 broken
// images. One root cause chain, both reported symptoms.
//
//   node scripts/repro-reported.mjs <shippedWebDir> <profileDir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const RAW_DIST = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const SHIPPED = process.argv[2];
const PROFILE = process.argv[3];
const OUT = path.join(WEBVIEW_ROOT, 'host', 'out', 'repro-reported');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startHost(args) {
    const child = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
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
    return {
        child,
        evalValue: async script => decode(await evalRaw(script)),
        shot: name => child.stdin.write(JSON.stringify({ t: 'command', command: 'screenshot', path: path.join(OUT, name) }) + '\n'),
        close: async () => {
            try { child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n'); } catch { /* closed */ }
            await sleep(1500);
            try { child.kill(); } catch { /* done */ }
        },
    };
}

fs.rmSync(PROFILE, { recursive: true, force: true });

console.log('[1] priming profile with the raw Folia dist (registers sw.js)');
const prime = startHost([
    '--bundle', RAW_DIST,
    '--windowed', '--width', '1200', '--height', '800', '--force-dsf', '1',
    '--duration', '20000', '--user-data', PROFILE, '--title', 'prime', '--no-topmost',
]);
await sleep(9000);
console.log('controller:', JSON.stringify(await prime.evalValue(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null`)));
await prime.close();

console.log('\n[2] SHIPPED 0.4.6.1 tree (no thumbs, no SW purge in that host build) against the same profile');
const run = startHost([
    '--bundle', SHIPPED,
    '--fullscreen',
    '--no-sw-purge',
    '--settings-dir', path.join(SHIPPED, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '40000', '--user-data', PROFILE, '--title', 'reported repro', '--demo', '--no-topmost',
]);
await sleep(8000);
run.child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');
await sleep(10000);

const state = await run.evalValue(`(function(){
  var box = document.querySelector('[data-spw-live-preview]');
  var frame = box && box.querySelector('iframe');
  var child = frame && frame.contentWindow;
  var imgs = [].slice.call(document.querySelectorAll('img'));
  var thumbs = imgs.filter(function (i) { return /\\/thumbs\\//.test(i.src); });
  var fallback = document.querySelector('.spw-preview-drift');
  return {
    stageReady: box ? box.getAttribute('data-live-preview-ready') : null,
    staticFallback: !!fallback,
    fallbackImgs: fallback ? [].slice.call(fallback.querySelectorAll('img')).map(function (i) {
      return { src: i.src.split('/').pop(), naturalW: i.naturalWidth };
    }) : null,
    thumbCount: thumbs.length,
    thumbsLoaded: thumbs.filter(function (i) { return i.naturalWidth > 0; }).length,
    childHasShim: !!(child && child.__SPW_FOLIA_PREVIEW__),
  };
})()`);
console.log('\n=== state (this is the reported screenshot) ===');
console.log(JSON.stringify(state, null, 2));

run.shot('repro-reported.png');
await sleep(1500);
console.log(`screenshot: ${path.join(OUT, 'repro-reported.png')}`);
await run.close();
process.exit(0);
