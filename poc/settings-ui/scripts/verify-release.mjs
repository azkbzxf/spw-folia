// End-to-end acceptance against the REAL release .spmod (not the staging tree): unpack it, run the
// host from the package's own native/ + web/ exactly as the plugin does, then verify both reported
// symptoms are gone — 15/15 style tiles load, and the live preview renders (no static fallback).
//
// Also primes the profile with the older install's service worker first, so the check covers the
// upgrade path that produced the bug report.
//
//   node scripts/verify-release.mjs <release.spmod> <workDir>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const RAW_DIST = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const DEV_HOST = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const SPMod = process.argv[2];
const WORK = process.argv[3];
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// Unpack with Python's zipfile: the repo has no unzip dependency and PowerShell is not guaranteed.
execFileSync('C:/Users/24037/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/python/python.exe',
  ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', SPMod, WORK],
  { stdio: 'inherit' });
const WEB = path.join(WORK, 'web');
const NATIVE = path.join(WORK, 'native');
if (!fs.existsSync(path.join(WEB, 'index.html'))) throw new Error('unpacked package has no web/index.html');
if (!fs.existsSync(path.join(NATIVE, 'spw-folia-host.exe'))) throw new Error('unpacked package has no native/spw-folia-host.exe');

function startHost(exe, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
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

const PROFILE = path.join(WORK, 'profile');

// 1) Prime the profile with the older install's service worker (the upgrade path from the report).
console.log('[1] priming profile with the raw Folia dist (registers sw.js)');
const prime = startHost(DEV_HOST, [
  '--bundle', RAW_DIST, '--windowed', '--width', '1200', '--height', '800', '--force-dsf', '1',
  '--duration', '20000', '--user-data', PROFILE, '--title', 'prime', '--no-topmost',
]);
await sleep(9000);
console.log('    controller:', JSON.stringify(await prime.evalValue(`navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null`)));
await prime.close();

// 2) Run the PACKAGE's own host binary against the PACKAGE's own web tree.
console.log('[2] running the packaged host against the packaged web tree');
const run = startHost(path.join(NATIVE, 'spw-folia-host.exe'), [
  '--bundle', WEB,
  '--fullscreen',
  '--settings-dir', path.join(WEB, 'settings'), '--settings-entry', 'settings-ui.js',
  '--duration', '45000', '--user-data', PROFILE, '--title', 'release verify', '--demo', '--no-topmost',
]);
await sleep(9000);
run.child.stdin.write(JSON.stringify({ t: 'command', command: 'open-settings' }) + '\n');

// Poll until the preview settles (ready or fallback), up to 30 s.
let state = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  state = await run.evalValue(`(function(){
    var box = document.querySelector('[data-spw-live-preview]');
    if (!box) return null;
    var frame = box.querySelector('iframe');
    var child = frame && frame.contentWindow;
    var imgs = [].slice.call(document.querySelectorAll('img')).filter(function (i) { return /\\/thumbs\\//.test(i.src); });
    return {
      ready: box.getAttribute('data-live-preview-ready'),
      staticFallback: !!document.querySelector('.spw-preview-drift'),
      childHasShim: !!(child && child.__SPW_FOLIA_PREVIEW__),
      thumbsTotal: imgs.length,
      thumbsLoaded: imgs.filter(function (i) { return i.naturalWidth > 0; }).length,
      canvases: document.querySelectorAll('canvas').length,
    };
  })()`);
  if (state && (state.ready === 'true' || state.staticFallback)) break;
}
await sleep(1200);

const shot = path.join(WORK, 'release-verify.png');
run.child.stdin.write(JSON.stringify({ t: 'command', command: 'screenshot', path: shot }) + '\n');
await sleep(1500);

console.log('\n=== release acceptance ===');
console.log(JSON.stringify(state, null, 2));

const warnLines = run.logs.filter(m => m.t === 'log' && (m.level === 'warn' || m.level === 'error'))
  .map(m => String(m.msg).slice(0, 200));
console.log('warnings:', JSON.stringify(warnLines, null, 2));

const purgeLines = run.logs.filter(m => m.t === 'log' && /sw-purge/.test(String(m.msg)))
  .map(m => `${m.level}: ${String(m.msg)}`);
console.log('sw purge:', JSON.stringify(purgeLines, null, 2));

await run.close();

const pass = !!(state && state.ready === 'true' && state.staticFallback === false && state.childHasShim
  && state.thumbsTotal === 15 && state.thumbsLoaded === 15);
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}  (screenshot: ${shot})`);
process.exit(pass ? 0 : 1);
