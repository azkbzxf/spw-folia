// Verify the *in-app* self-heal path: run the packaged bundle against a profile that still has an
// older install's service worker, with the host's startup purge disabled (--no-sw-purge), so only
// the page-level recovery can save the preview (Shim.js purge + LivePreview retry).
//
//   node scripts/probe-heal.mjs <packagedWebDir> <profileDir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
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
        child, logs,
        evalValue: async script => decode(await evalRaw(script)),
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
    '--duration', '20000', '--user-data', PROFILE, '--title', 'prime sw', '--no-topmost',
]);
await sleep(9000);
console.log('controller:', JSON.stringify(await prime.evalValue(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null`)));
await prime.close();

console.log('\n[2] packaged bundle, host startup purge DISABLED (--no-sw-purge)');
const run = startHost([
    '--bundle', PACKAGED,
    '--fullscreen',
    '--no-sw-purge',
    '--settings-dir', path.join(PACKAGED, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '45000', '--user-data', PROFILE, '--title', 'heal', '--demo', '--no-topmost',
]);
await sleep(8000);
console.log('controller at start:', JSON.stringify(await run.evalValue(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null`)));
run.child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');

// The page-level recovery needs: first ready timeout (4 s) + purge + reload + child boot.
await sleep(14000);

const state = await run.evalValue(`(function(){
  var box = document.querySelector('[data-spw-live-preview]');
  var frame = box && box.querySelector('iframe');
  var child = frame && frame.contentWindow;
  var shim = child && child.__SPW_FOLIA_PREVIEW__;
  return {
    ready: box ? box.getAttribute('data-live-preview-ready') : null,
    staticFallback: !!document.querySelector('.spw-preview-drift'),
    iframeSrc: frame ? frame.src : null,
    childHref: child ? child.location.href : null,
    childHasShim: !!shim,
    frames: shim ? shim.frames : null,
    controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
  };
})()`);
console.log('\n=== preview state after self-heal ===');
console.log(JSON.stringify(state, null, 2));

const interesting = run.logs
    .filter(m => m.t === 'log' && /preview|service|purge|sw/i.test(String(m.msg)))
    .map(m => `${m.level}: ${String(m.msg).slice(0, 200)}`);
console.log('\nrelevant log lines:', JSON.stringify(interesting, null, 2));

await run.close();
process.exit(0);
