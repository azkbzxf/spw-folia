// Repro: a service worker left behind by an older install (raw Folia dist with sw.js) keeps
// controlling https://spw-folia.local/ and intercepts the /preview.html navigation, so the live
// preview iframe loads index.html instead of preview.html (no child shim → no `ready`).
//
// Step 1: run the raw Folia dist (registers sw.js) against a scratch profile.
// Step 2: run the packaged bundle (no sw.js shipped) against the same profile and inspect what the
//         preview iframe actually loaded.
//
//   node scripts/repro-stale-sw.mjs <packagedWebDir> <profileDir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(SETTINGS_ROOT, '..', '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const RAW_DIST = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const PACKAGED = process.argv[2];
const PROFILE = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startHost(args) {
    const child = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
    const waiters = [];
    let buffer = '';
    const logs = [];
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
            logs.push(msg);
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
        logs,
        evalValue: async script => decode(await evalRaw(script)),
        close: async () => {
            try { child.stdin.write(JSON.stringify({ t: 'command', command: 'close' }) + '\n'); } catch { /* closed */ }
            await sleep(1500);
            try { child.kill(); } catch { /* done */ }
        },
    };
}

fs.rmSync(PROFILE, { recursive: true, force: true });

// ---- step 1: older raw dist registers sw.js ------------------------------------------------
console.log('\n[1] priming profile with the raw Folia dist (registers sw.js)');
const prime = startHost([
    '--bundle', RAW_DIST,
    '--windowed', '--width', '1200', '--height', '800', '--force-dsf', '1',
    '--duration', '20000', '--user-data', PROFILE, '--title', 'prime sw', '--no-topmost',
]);
await sleep(9000);
console.log('registrations:', JSON.stringify(await prime.evalValue(`
  navigator.serviceWorker.getRegistrations().then(list => list.map(r => ({ scope: r.scope, active: r.active && r.active.scriptURL }))).then(v => JSON.stringify(v))
`)));
console.log('controller:', JSON.stringify(await prime.evalValue(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null`)));
await prime.close();

// ---- step 2: packaged bundle against the same profile --------------------------------------
console.log('\n[2] packaged bundle against the same profile');
const run = startHost([
    '--bundle', PACKAGED,
    '--fullscreen',
    '--settings-dir', path.join(PACKAGED, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '30000', '--user-data', PROFILE, '--title', 'stale sw', '--demo', '--no-topmost',
]);
await sleep(7000);
console.log('controller before open:', JSON.stringify(await run.evalValue(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null`)));
run.child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');
await sleep(6000);

const childState = await run.evalValue(`(function(){
  var box = document.querySelector('[data-spw-live-preview]');
  var frame = box && box.querySelector('iframe');
  var child = frame && frame.contentWindow;
  var doc = child && child.document;
  return {
    ready: box ? box.getAttribute('data-live-preview-ready') : null,
    staticFallback: !!document.querySelector('.spw-preview-drift'),
    childHref: child ? child.location.href : null,
    childHasShim: !!(child && child.__SPW_FOLIA_PREVIEW__),
    childScripts: doc ? Array.prototype.map.call(doc.querySelectorAll('script[src]'), function (s) { return s.src; }).slice(0, 6) : null,
    childSplash: doc ? (doc.body ? doc.body.innerText.slice(0, 120) : null) : null,
  };
})()`);
console.log('\n=== preview child after open ===');
console.log(JSON.stringify(childState, null, 2));

const warnings = run.logs.filter(m => m.t === 'log' && (m.level === 'warn' || m.level === 'error')).map(m => String(m.msg).slice(0, 220));
console.log('\nwarnings:', JSON.stringify(warnings, null, 2));
await run.close();
process.exit(0);
