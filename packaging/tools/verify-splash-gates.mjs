#!/usr/bin/env node
// Three-way verification for the splash gates wired into packaging/tools/stage-web.mjs.
//
// The gates exist because both failure modes are invisible in a green build log:
//   * `web/index.html` losing `#app-splash`  → the player boots to a black window (no branded splash);
//   * `web/preview.html` keeping `#app-splash` → the settings stage flashes an opening title card
//     over the lyrics on every iframe rebuild.
// A gate that only ever runs in the passing direction proves nothing, so each one is driven here in
// both directions against the real staged bundle:
//
//   1. clean   : packaged web/ still satisfies index + preview + teardown gates  -> PASS
//   2. index   : splash markup deleted from index.html                          -> gate 1 throws
//   3. preview : splash injected back into preview.html                          -> gate 2 throws
//   4. teardown: the bundle stops fading the splash out                          -> gate 3 throws
//   5. end-to-end: stage-web.mjs itself, run against a source tree whose index.html has no splash
//      -> the real build fails with the gate's message (not a partial/quiet success).
//
// Nothing under packaging/web/ is modified for good: cases 2–4 work on copies in a temp dir, and
// case 5 builds into a temp --out. Run: node packaging/tools/verify-splash-gates.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIndexHtmlKeepsSplash,
  assertPreviewHtmlHasNoSplash,
  assertSplashTeardownInBundle,
} from './lib/splash-gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'packaging', 'web');
const STAGE = join(ROOT, 'packaging', 'tools', 'stage-web.mjs');
const DIST = join(ROOT, 'poc', 'webview', 'dist', 'dist');

const results = [];
const expectOk = (name, fn) => {
  try {
    const value = fn();
    results.push({ case: name, outcome: 'PASS', detail: typeof value === 'object' ? JSON.stringify(value) : String(value) });
    return true;
  } catch (error) {
    results.push({ case: name, outcome: 'FAIL', detail: `expected the gate to pass, but it threw: ${error.message.split('\n')[0]}` });
    return false;
  }
};
const expectThrow = (name, fn, mustMatch) => {
  try {
    fn();
    results.push({ case: name, outcome: 'FAIL', detail: 'expected the gate to throw, but it accepted the input' });
    return false;
  } catch (error) {
    const message = String(error?.message || error);
    if (mustMatch && !mustMatch.test(message)) {
      results.push({ case: name, outcome: 'FAIL', detail: `threw, but the message did not match ${mustMatch}: ${message.split('\n')[0]}` });
      return false;
    }
    results.push({ case: name, outcome: 'PASS', detail: `threw as expected: ${message.split('\n')[0]}` });
    return true;
  }
};

if (!existsSync(join(WEB, 'index.html')) || !existsSync(join(WEB, 'preview.html'))) {
  console.error(`[verify-splash-gates] missing staged bundle in ${WEB} — run: node packaging/tools/stage-web.mjs`);
  process.exit(2);
}

const indexHtml = readFileSync(join(WEB, 'index.html'), 'utf8');
const previewHtml = readFileSync(join(WEB, 'preview.html'), 'utf8');
const stagedJs = () => readdirSync(join(WEB, 'assets'))
  .filter((name) => /\.js$/i.test(name))
  .map((name) => ({ name, text: readFileSync(join(WEB, 'assets', name), 'utf8') }));

// 1. The shipped bundle as-built.
expectOk('clean / index.html keeps the splash', () => assertIndexHtmlKeepsSplash(indexHtml));
expectOk('clean / preview.html has no splash', () => assertPreviewHtmlHasNoSplash(previewHtml));
let js = stagedJs();
expectOk('clean / bundle still fades the splash out', () => assertSplashTeardownInBundle(js));

// 2. Splash removed from the player page (the regression the gate is for).
{
  const broken = indexHtml
    .replace(/<div id="app-splash"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '')
    .replace(/app-splash-wave/g, '')
    .replace(/app-splash/g, '');
  expectThrow('broken / index.html without splash is rejected', () => assertIndexHtmlKeepsSplash(broken), /lost Folia's first-paint splash/);
  // Only the element gone, style+script intact: still rejected (the id is what hideAppSplash looks up).
  const noElement = indexHtml.replace(/\bid="app-splash"/, 'id="app-splash-renamed"');
  expectThrow('broken / index.html with a renamed splash id is rejected', () => assertIndexHtmlKeepsSplash(noElement), /missing the element/);
}

// 3. Splash leaking into the settings live-preview child frame.
{
  const leaked = previewHtml.replace('<body>', '<body>\n    <div id="app-splash"><div class="app-splash-wave"></div></div>');
  expectThrow('broken / preview.html with splash is rejected', () => assertPreviewHtmlHasNoSplash(leaked), /must render lyrics only/);
  // Unstripped page: preview.html built from index.html without the strip step.
  expectThrow('broken / preview.html that is a plain index.html copy is rejected', () => assertPreviewHtmlHasNoSplash(indexHtml), /must render lyrics only/);
  // Strip that ate the app instead of the splash must not pass either.
  const gutted = previewHtml.replace(/\bid="root"/, 'id="root-renamed"');
  expectThrow('broken / preview.html without #root is rejected', () => assertPreviewHtmlHasNoSplash(gutted), /no #root mount point/);
}

// 4. The bundle stops fading the splash out (splash would cover the player forever).
{
  const noTeardown = js.filter((entry) => !(entry.text.includes('app-splash') && entry.text.includes('is-hiding')));
  expectThrow('broken / bundle without hideAppSplash() is rejected', () => assertSplashTeardownInBundle(noTeardown), /no .* chunk fades out the splash/);
  expectThrow('broken / empty bundle is rejected', () => assertSplashTeardownInBundle([]), /no .* chunk fades out the splash/);
}

// 5. End to end: the real build must refuse a splash-less source tree. Staged against a temp copy of
//    dist whose index.html has the splash surgically removed — the rest of the tree is reused by
//    link-free copy, so this stays cheap.
let scratch = null;
try {
  scratch = mkdtempSync(join(tmpdir(), 'spw-splash-gate-'));
  const fakeDist = join(scratch, 'dist');
  const out = join(scratch, 'web');
  // Copy only what stage-web needs to reach the index.html gate: index.html + assets/ (js + css).
  const fs = await import('node:fs');
  fs.cpSync(DIST, fakeDist, {
    recursive: true,
    filter: (src) => !/[\\/](?:manifest\.webmanifest|registerSW\.js|sw\.js|workbox-[^\\/]*\.js|folia-cover-sw\.js)$/.test(src),
  });
  const distIndex = join(fakeDist, 'index.html');
  const stripped = readFileSync(distIndex, 'utf8').replace(/\bid="app-splash"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');
  writeFileSync(distIndex, stripped);
  const run = spawnSync(process.execPath, [STAGE, '--dist', fakeDist, '--out', out, '--report', join(scratch, 'report.json')], {
    encoding: 'utf8',
    timeout: 300000,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const rejected = run.status !== 0 && /lost Folia's first-paint splash/.test(output);
  results.push({
    case: 'end-to-end / stage-web.mjs rejects a dist without splash',
    outcome: rejected ? 'PASS' : 'FAIL',
    detail: `exit ${run.status}: ${(output.match(/\[stage-web\][^\n]*/) || ['<no stage-web error>'])[0]}`,
  });
} catch (error) {
  results.push({ case: 'end-to-end / stage-web.mjs rejects a dist without splash', outcome: 'FAIL', detail: String(error?.message || error) });
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => r.outcome !== 'PASS');
for (const r of results) console.log(`${r.outcome === 'PASS' ? 'PASS' : 'FAIL'}  ${r.case}\n      ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
