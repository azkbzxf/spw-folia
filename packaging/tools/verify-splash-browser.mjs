#!/usr/bin/env node
// Real-browser check for the two splash invariants (pairs with packaging/tools/verify-splash-gates.mjs,
// which only inspects the staged markup).
//
//   preview.html  → loading it must NOT paint `#app-splash`: the element must not exist, and the
//                   document must not get dark-veiled before React mounts. This is the settings
//                   stage's child frame (docs/live-preview-iframe.md), re-created on resize and on
//                   the stale-SW self-heal retry — a splash here flashes a title card over lyrics.
//   index.html    → loading it WITHOUT the runtime escape hatch (`obs=1`/`splash=0`) must paint the
//                   splash immediately, before the bundle runs, and the bundle must then fade it out.
//                   This is what the host reveals on startup (task-2); if the markup or the inline
//                   style drifts, the player boots to a black window or a stuck logo.
//
// The bundled page depends on a virtual host + bridge that only the WebView2 host provides, so the
// app itself does not boot here — the splash is pure HTML/CSS/inline-script and is fully observable
// before that. Console errors from the boot path are therefore ignored; only splash state is asserted.
//
// Usage: node packaging/tools/verify-splash-browser.mjs [--web <staged web dir>] [--keep-shots]
// Requires Microsoft Edge (present on Windows 11) and puppeteer-core from poc/settings-ui.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const WEB = resolve(ROOT, opt('web', 'packaging/web'));
const SHOTS = join(ROOT, 'packaging', 'out', 'splash');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

for (const p of [join(WEB, 'index.html'), join(WEB, 'preview.html')]) {
  if (!existsSync(p)) {
    console.error(`[verify-splash-browser] missing ${p} — run: node packaging/tools/stage-web.mjs`);
    process.exit(2);
  }
}
if (!EDGE) {
  console.error('[verify-splash-browser] Microsoft Edge not found; install it or skip this check (markup gates still run)');
  process.exit(2);
}

// puppeteer-core lives in the settings-ui package; resolve it from there without touching cwd.
const requireFromSettings = createRequire(join(ROOT, 'poc', 'settings-ui', 'package.json'));
const puppeteerPath = requireFromSettings.resolve('puppeteer-core');
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 720 },
});

/** Load `file` and report splash state at document_start-ish, then after the bundle had time. */
async function probe(name, file, query) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error?.message || error)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const url = `${pathToFileURL(file).href}${query || ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Sampled in the same task as DOMContentLoaded: the inline <style> + markup are already parsed and
  // the inline <script> at the end of <body> has run (it is synchronous), the module entry has not.
  const early = await page.evaluate(() => {
    const splash = document.getElementById('app-splash');
    const inner = splash && splash.querySelector('.app-splash-inner');
    const firstBar = splash && splash.querySelector('.app-splash-wave span');
    return {
      hasElement: Boolean(splash),
      bars: splash ? splash.querySelectorAll('.app-splash-wave span').length : 0,
      bg: getComputedStyle(document.body).backgroundColor,
      // Static bars: the inline script assigns --peak/-w per bar before first paint.
      firstBarVar: firstBar ? getComputedStyle(firstBar).getPropertyValue('--w').trim() : '',
      innerOpacity: inner ? getComputedStyle(inner).opacity : null,
    };
  });
  // Give the module entry a chance to mount and call hideAppSplash() (320 ms fade + React boot).
  await new Promise((r) => setTimeout(r, 3500));
  const late = await page.evaluate(() => {
    const splash = document.getElementById('app-splash');
    return {
      hasElement: Boolean(splash),
      hiding: splash ? splash.classList.contains('is-hiding') : null,
      bg: getComputedStyle(document.body).backgroundColor,
    };
  });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
  await page.close();
  return { early, late, consoleErrors };
}

mkdirSync(SHOTS, { recursive: true });

// 1. The settings live-preview child frame: no splash at all, and no dark veil before React.
{
  const { early, late } = await probe('preview', join(WEB, 'preview.html'), '?obs=1&preview=1');
  check('preview.html has no #app-splash element', !early.hasElement, JSON.stringify(early));
  check('preview.html still paints Folia\'s dark base (#09090b) instead of white', early.bg === 'rgb(9, 9, 11)', early.bg);
  check('preview.html has no splash after the bundle boots', !late.hasElement, JSON.stringify(late));
}

// 2. The shipped player page: splash paints with the first frame, then the bundle removes it.
//    Loaded without `obs=1`/`splash=0`, i.e. the way the host opens it for the branded greeting.
{
  const { early, late } = await probe('index-splash', join(WEB, 'index.html'), '');
  check('index.html paints #app-splash on the first frame', early.hasElement, JSON.stringify(early));
  check('index.html splash has the 13 waveform bars', early.bars === 13, `bars=${early.bars}`);
  check('index.html splash bars were randomised before paint', /px$/.test(early.firstBarVar.trim()), `--w="${early.firstBarVar}"`);
  check('index.html base background is #09090b', early.bg === 'rgb(9, 9, 11)', early.bg);
  // The boot path needs the WebView2 bridge, so the page cannot mount here: the element staying put
  // is the expected outcome. Only report it — the teardown CODE is asserted by verify-splash-gates.mjs.
  check('index.html splash teardown is bundle-side only (no inline removal without obs/splash=0)',
    late.hasElement === true, `late=${JSON.stringify(late)} (expected: stays without a WebView2 bridge)`);
}

// 3. Upstream's own escape hatch still works on the player page: `splash=0` removes it inline.
{
  const { early } = await probe('index-splash-0', join(WEB, 'index.html'), '?splash=0');
  check('index.html?splash=0 removes the splash inline (upstream escape hatch intact)', !early.hasElement, JSON.stringify(early));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length === 0 ? 0 : 1);
