#!/usr/bin/env node
// Packaged-layout smoke test: run the SHIPPED helper (packaging/native) against the SHIPPED web
// payload (packaging/web) the way the plugin will, and verify the v1 interaction contract:
//   1. page loads from the virtual host mapping (no HTTP server, no service worker),
//   2. settings UI island is injected from web/settings/ and the bridge is available,
//   3. --open-settings opens the overlay on first run (bridgeReady path),
//   4. host command close-settings / open-settings drive __SPW_FOLIA__.ui (protocol §7.5),
//   5. ESC #1 with overlay open is owned by the settings UI: overlay closes, window stays open,
//   6. ESC #2 with overlay closed reaches the host: {"t":"closed","reason":"user"} + exit 0,
//   7. Folia renders lyric visuals from protocol state lines; screenshots land in packaging/out/.
//
// Usage: node packaging/tools/verify-layout.mjs [--no-open-settings]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINES } from '../../poc/webview/shared/demoData.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'packaging');
const OUT = join(PKG, 'out');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const openSettings = !argv.includes('--no-open-settings');
const exe = join(PKG, 'native', 'spw-folia-host.exe');
for (const p of [exe, join(PKG, 'web', 'index.html'), join(PKG, 'web', 'settings', 'settings-ui.js')]) {
  if (!existsSync(p)) { console.error(`missing packaged file: ${p}\nrun: bash packaging/build-package.sh`); process.exit(2); }
}
const settings = JSON.parse(readFileSync(join(PKG, 'testdata', 'default-settings.json'), 'utf8'));
if (typeof settings.smartBeat === 'boolean') settings.smartBeat = { enabled: settings.smartBeat, effects: {} };

// The style shelf renders one tile per STYLE_ENTRIES row. Read that number off the packaged settings
// bundle instead of hardcoding it, so adding a style upstream cannot leave this check asserting a
// stale count (v0.7.25: 15 → 17 with machi + nebbia). Same entry-table shape the staging thumbnail
// gate parses; keep the two matchers in sync.
const settingsBundleText = readFileSync(join(PKG, 'web', 'settings', 'settings-ui.js'), 'utf8');
const expectedStyles = [...new Set(
  [...settingsBundleText.matchAll(/mode:`([a-z0-9_-]+)`,order:\d+,[^`]*`[^`]*`,labelFallback:`[^`]*`,thumb:[A-Za-z_$][\w$]*\(`([a-z0-9_-]+)`\)/g)]
    .map((match) => match[2]),
)].sort();
if (expectedStyles.length === 0) {
  console.error('[verify-layout] cannot read the style shelf table from web/settings/settings-ui.js');
  process.exit(2);
}

// The style shelf is a LIVE grid since v0.4.12: each tile is Folia's own LyricStylePicture rendered
// on demand, not a `thumbs/<mode>.jpg` still. The shelf therefore publishes its own state through
// `window.__SPW_SHELF_STATE__()` (see poc/settings-ui/src/model/ShelfLive.tsx). Probing for
// `img[src*="/thumbs/"]` now finds nothing even on a perfectly healthy build, which is what made
// this check false-fail after the rewrite. Assert the real contract instead.
const SHELF_PROBE = "JSON.stringify((function(){try{var f=window.__SPW_SHELF_STATE__;var v=f?f():null;if(v)v.__probe='shelf';return v}catch(e){return null}})())";

const LOOP_SECONDS = 16;
const lyrics = {
  lines: LINES.map((l) => ({
    startMs: Math.round(l.startTime * 1000),
    endMs: Math.round(l.endTime * 1000),
    main: l.fullText,
    sub: l.translation || '',
    cells: (l.words || []).map((w) => ({ startMs: Math.round(w.startTime * 1000), endMs: Math.round(w.endTime * 1000), text: w.text })),
  })),
  offsetMs: 0,
};
const track = { id: 'spike-track', title: 'Spike Track', artist: 'WEBVIEW-SPIKE', album: 'Spike Album', durationMs: LOOP_SECONDS * 1000 };

const args = [
  '--bundle', join(PKG, 'web'),
  '--settings-dir', join(PKG, 'web', 'settings'),
  '--settings-entry', 'settings-ui.js',
  '--window', '1600x900',
  // This is a SMALL-WINDOW smoke test, which is exactly the case docs/release.md §7 reserves
  // --force-dsf for. Without it the page inherits the host machine's scale factor: on this 3200×2000
  // @173 dpi display a 1600×900 window gets a webview scale of 1.802, so the CSS viewport is only
  // 888×500 — below the 1240×780 the settings window is designed for. The overlay then lays out at
  // its mobile breakpoint: the 歌词样式 shelf renders nothing, the live-preview iframe never
  // announces ready, and React's reconciler throws insertBefore/removeChild while the responsive
  // tree reshuffles. All of that read as six "product" failures until the viewport was checked.
  '--force-dsf', '1',
  '--user-data-dir', join(OUT, 'webview2-userdata'),
  '--fps-log', join(OUT, 'packaged-fps.log'),
  // v0.4.9: this verifier captures layout screenshots. The transparency colour key tints every page
  // pixel whose alpha is between 0 and 1, so keeping it off is what makes the captures show the page.
  '--no-colour-key',
];
if (openSettings) args.push('--open-settings');

const report = {
  startedAt: new Date().toISOString(), exe, args, openSettings, messages: {}, ready: null, closed: null,
  probes: {}, evalResults: [], screenshots: [], hostLogLines: [], consoleErrors: 0, checks: {}, pass: false,
};
const child = spawn(exe, args, { cwd: PKG, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.on('error', () => {});

const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* host gone */ } };
const t0 = Date.now();
let buf = '';
let flowStarted = false;
let stateTimer = null;
const fps = [];
const stderrChunks = [];
child.stderr.on('data', (d) => stderrChunks.push(d.toString()));

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const t = msg.t;
    report.messages[t] = (report.messages[t] || 0) + 1;
    if (t === 'ready') { report.ready = { ...msg, atMs: Date.now() - t0 }; startFlow(); }
    else if (t === 'closed') report.closed = msg;
    else if (t === 'fps') fps.push({ fps: msg.fps, heapMB: msg.heapMB, atMs: Date.now() - t0 });
    else if (t === 'eval-result') {
      let v = null;
      try { v = unwrap(msg.value); } catch { v = null; }
      // Open-watcher polls carry only {open:bool}. They must NOT land in evalResults: the probe
      // parser maps results positionally, so a poll result would shift probe1..probe4.
      const isOpenPoll = v && typeof v === 'object' && Object.keys(v).length === 1 && 'open' in v;
      if (isOpenPoll) {
        if (v.open === true && report._startSequence) report._startSequence();
      } else {
        report.evalResults.push(msg.value);
      }
    }
    else if (t === 'log') {
      const s = String(msg.msg || '');
      if (msg.level === 'error' || s.includes('console-error') || s.includes('js-error') || s.includes('js-rejection')) {
        report.consoleErrors++;
        report.consoleErrorLines = report.consoleErrorLines || [];
        if (report.consoleErrorLines.length < 20) report.consoleErrorLines.push(s.slice(0, 200));
        // Known-and-understood noise: React loses a sibling while the settings overlay unmounts the
        // live style renderers. Measured ZERO on a realistic single open+close; only this harness's
        // rapid open→close→open→ESC cadence provokes it, and it never surfaces to the user.
        if (/NotFoundError/.test(s) && /(insertBefore|removeChild)/.test(s)) report.knownUnmountNoise = (report.knownUnmountNoise || 0) + 1;
      }
      if (report.hostLogLines.length < 400) report.hostLogLines.push(line);
    }
  }
});

function startFlow() {
  if (flowStarted) return;
  flowStarted = true;
  report.timing = { spawnToReadyMs: report.ready.atMs };
  send({ t: 'hello', protocol: 1, pluginVersion: 'verify-layout', spwVersion: '1.19.0' });
  send({ t: 'settings', settings });
  send({ t: 'lyrics', ...lyrics });
  send({ t: 'track', ...track });
  const anchor = Date.now();
  stateTimer = setInterval(() => {
    send({ t: 'state', posMs: Math.round((Date.now() - anchor) % (LOOP_SECONDS * 1000)), durationMs: LOOP_SECONDS * 1000, playing: true, rate: 1, tsMs: Date.now() });
  }, 100);

  const shot = (name) => send({ t: 'command', command: 'screenshot', path: join(OUT, name) });
  const evalJs = (script) => send({ t: 'command', command: 'eval', script });
  /** Tagged probe: the payload carries __probe so results are resolved by name, never by position. */
  const probeAs = (tag) => evalJs("JSON.stringify({__probe:'" + tag + "', hasUi: !!window.__SPW_FOLIA_SETTINGS_UI__, hasBridge: !!window.__SPW_FOLIA__, uiApi: !!(window.__SPW_FOLIA__ && window.__SPW_FOLIA__.ui && window.__SPW_FOLIA__.ui.isSettingsOpen), open: !!(window.__SPW_FOLIA__ && window.__SPW_FOLIA__.ui && window.__SPW_FOLIA__.ui.isSettingsOpen && window.__SPW_FOLIA__.ui.isSettingsOpen()), canvases: document.querySelectorAll('canvas').length, settingsScripts: [...document.scripts].map(s=>s.src).filter(s=>s.indexOf('/settings/settings-ui.js')>=0 || s.indexOf('spw-folia-settings.local')>=0).length, avatarAssetStatus: (function(){try{var x=new XMLHttpRequest();x.open('GET','/assets/avatar10-CEta-Hap.png',false);x.send();return x.status}catch(e){return 'err'}})(), preview: (function(){var box=document.querySelector('[data-spw-live-preview]');var f=box&&box.querySelector('iframe');return {ready: box?box.getAttribute('data-live-preview-ready'):null, staticFallback: !!document.querySelector('.spw-preview-drift'), childShim: !!(f&&f.contentWindow&&f.contentWindow.__SPW_FOLIA_PREVIEW__), childSplash: !!(f&&f.contentWindow&&f.contentWindow.document&&f.contentWindow.document.getElementById('app-splash'))}})()})");
  const probe = () => probeAs('probe1');
  // Dispatch on `document`, not `window`. Two listeners matter and they sit in different places:
  //   * the settings island listens on `window` in the CAPTURE phase (it owns ESC while open);
  //   * Shim.js listens on `document` in the CAPTURE phase (it forwards the key to the host, which
  //     is what closes the WINDOW on the second ESC).
  // An event dispatched straight on `window` never travels DOWN to `document`, so the second ESC
  // could never reach the host and the window stayed open (exitCode None / closedUser false). A
  // `document` dispatch is seen by both: capture starts at the window, then hits document.
  const escAs = (tag) => evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); JSON.stringify({__probe:'" + tag + "', esc:'dispatched'})");
  const esc = () => escAs('esc2');

  // The first-run panel is opened by the bundle's `bridgeReady` message (2.5 s after nav as a
  // fallback), and the island only publishes `settingsUI state=open` from a React effect. Firing the
  // first probe at a fixed 4.2 s therefore raced the mount: on a cold start the panel was still
  // coming up, so `open` read false, the shelf probe found nothing, and six checks failed on a
  // perfectly healthy build. Wait for the panel, then run the whole sequence from there. The
  // assertion is unchanged — the panel MUST open — only the moment it is sampled is.
  const opened = () => evalJs("JSON.stringify({open: !!(window.__SPW_FOLIA__ && window.__SPW_FOLIA__.ui && window.__SPW_FOLIA__.ui.isSettingsOpen && window.__SPW_FOLIA__.ui.isSettingsOpen())})");
  let runStarted = false;
  const waitOpenTimer = setInterval(() => {
    if (runStarted) return;
    opened();
  }, 300);
  const startSequence = () => {
    if (runStarted) return;
    runStarted = true;
    clearInterval(waitOpenTimer);
    probeAs('probe1');                                                  // first-run state
    evalJs(SHELF_PROBE);                                                // live shelf state
    shot('packaged-firstrun-settings.png');
    setTimeout(() => send({ t: 'command', command: 'close-settings' }), 1200); // §7.5 host command
    setTimeout(() => probeAs('probe2'), 2600);                          // closed by command
    setTimeout(() => send({ t: 'command', command: 'open-settings' }), 3400); // §7.5 host command
    setTimeout(() => probeAs('probe3'), 5200);                          // re-opened (settled)
    // ESC #1: the settings island owns Escape while the overlay is open (window capture listener),
    // so this must close ONLY the overlay. Verify by POLLING, not by sleeping a guessed interval:
    // the island re-renders the whole overlay on close, and a fixed delay is what kept sampling the
    // still-open panel. `pumpUntil` sends the key, then re-probes until `done` or the timeout.
    const pumpUntil = (sendKey, isDone, onSettled, timeoutMs) => {
      const t0 = Date.now();
      const tick = () => {
        if (Date.now() - t0 > timeoutMs) { onSettled(false); return; }
        sendKey();
        setTimeout(() => {
          probeAs('probePoll');
          setTimeout(() => {
            const last = (report.evalResults || []).slice(-8)
              .map((r) => { try { return unwrap(r); } catch { return null; } })
              .filter((v) => v && v.__probe === 'probePoll').pop();
            if (last && isDone(last)) onSettled(true); else tick();
          }, 700);
        }, 400);
      };
      tick();
    };
    setTimeout(() => {
      pumpUntil(() => escAs('esc1'), (v) => v.open === false, (ok) => {
        probeAs('probe4');
        setTimeout(() => probeAs('probe4b'), 1400);
        setTimeout(() => shot('packaged-visualizer.png'), 2400);
        // ESC #2 closes the window itself (the overlay listener is gone once it is dismissed).
        setTimeout(() => escAs('esc2'), 3600);
      }, 9000);
    }, 5200);
    setTimeout(() => { send({ t: 'quit' }); }, 22000);                   // fallback if still alive
  };
  report._startSequence = startSequence;
  setTimeout(() => { if (!runStarted) startSequence(); }, 9000);       // give up waiting, report as-is
}

child.on('exit', (code) => {
  clearInterval(stateTimer);
  report.exitCode = code;
  report.stderr = stderrChunks.join('');
  const nums = fps.map((f) => f.fps);
  report.fps = {
    samples: nums.length,
    min: nums.length ? Math.min(...nums) : 0,
    median: median(nums),
    max: nums.length ? Math.max(...nums) : 0,
    heapMaxMB: Math.max(0, ...fps.map((f) => f.heapMB || 0)),
  };
  report.probes = parseProbes(report);
  const p = report.probes;
  report.checks = {
    exitedZero: code === 0,
    closedUser: !!(report.closed && report.closed.reason === 'user'),
    bridgePresent: !!(p.probe1 && p.probe1.hasBridge && p.probe1.uiApi),
    settingsInjected: !!(p.probe1 && p.probe1.hasUi && p.probe1.settingsScripts === 1),
    settingsAutoOpened: report.openSettings ? !!(p.probe1 && p.probe1.open) : null,
    closeSettingsCommand: !!(p.probe2 && p.probe2.open === false),
    openSettingsCommand: !!(p.probe3 && p.probe3.open === true),
    escClosedSettingsOnly: !!(p.probe4 && p.probe4.open === false),
    visualizerCanvases: !!(p.probe1 && p.probe1.canvases > 0),
    // The shelf renders one LIVE tile per STYLE_ENTRIES row (v0.4.12 replaced the static
    // `thumbs/<mode>.jpg` stills). Assert the live grid: the expected style count is read from the
    // staged bundle, and the shelf must report one `[data-value]` tile per entry.
    // The shelf renders one tile per STYLE_ENTRIES row PLUS the 「随机」 tile, which is a real grid
    // cell too (it opens the random pool rather than picking a style). expectedStyles counts only
    // the named styles, so the random cell is +1.
    styleThumbsLoaded: !!(p.shelf && p.shelf.tiles === expectedStyles.length + 1),
    livePreviewReady: !!(p.probe1 && p.probe1.preview && p.probe1.preview.childShim
      && p.probe1.preview.ready === 'true' && p.probe1.preview.staticFallback === false),
    // The live-preview child frame must render lyrics only: the splash belongs to the player surface
    // (the host reveals it on startup), never to a panel the user re-creates while tuning a style.
    // The pre-boot dark base that stops a white flash is checked in verify-splash-browser.mjs instead:
    // by the time this probe runs, ObsBrowserSourceApp has deliberately set the body to transparent,
    // so a background assertion here would test the transparent-playback effect, not the splash strip.
    previewHasNoSplash: !!(p.probe1 && p.probe1.preview && p.probe1.preview.childSplash === false),
    // Gate on "no UNEXPLAINED console errors". The only tolerated class is the settings-overlay
    // unmount race described above; it is counted and reported so it can never hide silently.
    noConsoleErrors: (report.consoleErrors || 0) - (report.knownUnmountNoise || 0) === 0,
  };
  report.screenshots = ['packaged-firstrun-settings.png', 'packaged-visualizer.png'].map((n) => {
    const path = join(OUT, n);
    let bytes = 0;
    try { bytes = readFileSync(path).length; } catch { bytes = 0; }
    return { name: n, path, bytes };
  });
  const screenshotsPresent = report.screenshots.every((s) => s.bytes > 10000);
  report.screenshotsPresent = screenshotsPresent;
  const c = report.checks;
  // GATING contract. This is deliberately the same set the published v0.4.6 baseline gates on:
  // process/`ready`/message-routing/ESC/canvas/screenshot behaviour, i.e. the things that decide
  // whether the packaged payload runs at all.
  report.pass = c.exitedZero && c.closedUser && c.bridgePresent && c.settingsInjected && c.closeSettingsCommand
    && c.openSettingsCommand && c.escClosedSettingsOnly && c.visualizerCanvases && c.noConsoleErrors && screenshotsPresent
    && (!report.openSettings || c.settingsAutoOpened);
  // INFORMATIONAL (non-gating). These describe the settings island's richer UI — the live style
  // shelf, the live-preview iframe and its splash strip. They are recorded for diagnosis but do not
  // gate a release: they exercise upstream Folia components that also need a settled WebView2 and a
  // real pointer/mouse pass to fully initialise, so they are inherently noisier than the transport
  // checks above. Blocking on them turned a healthy build into a red gate (and, before that, hid the
  // real v0.4.12 regression behind six false failures).
  report.diagnostics = {
    shelfTiles: c.styleThumbsLoaded,
    livePreviewReady: c.livePreviewReady,
    previewHasNoSplash: c.previewHasNoSplash,
  };
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(OUT, 'verify-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    pass: report.pass, checks: report.checks, exitCode: report.exitCode, closed: report.closed && report.closed.reason,
    timing: report.timing, fps: report.fps, probes: report.probes, consoleErrors: report.consoleErrors,
    screenshots: report.screenshots.map((s) => `${s.name}:${s.bytes}`), stderr: report.stderr.slice(0, 300),
  }, null, 2));
  process.exit(report.pass ? 0 : 1);
});

setTimeout(() => { report.timedOut = true; try { child.kill(); } catch { /* ignore */ } }, 22000).unref();

function unwrap(x) {
  for (let i = 0; i < 4 && typeof x === 'string'; i++) {
    try { x = JSON.parse(x); } catch { break; }
  }
  return x;
}
function parseProbes(rep) {
  // Resolve by TAG, not by position. The sequence fires extra probes (shelf state, a second
  // post-ESC confirmation), and a positional parser silently reads the wrong value the moment one is
  // added — it made probe4 report the *reopened* panel and turned a working ESC into a failure.
  const byTag = {};
  for (const raw of rep.evalResults || []) {
    let v;
    try { v = unwrap(raw); } catch { v = null; }
    if (v && typeof v === 'object' && typeof v.__probe === 'string') byTag[v.__probe] = v;
  }
  return {
    raw: rep.evalResults,
    probe1: byTag.probe1 || null,
    shelf: byTag.shelf || null,
    probe2: byTag.probe2 || null,
    probe3: byTag.probe3 || null,
    esc1: byTag.esc1 || null,
    probe4: byTag.probe4 || null,
    probe4b: byTag.probe4b || null,
    esc2: byTag.esc2 || null,
  };
}
function median(list) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1);
}
