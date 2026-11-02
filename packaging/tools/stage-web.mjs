#!/usr/bin/env node
// Stage the complete Folia web bundle (OBS browser-source surface) into packaging/web/.
//
// IMPORTANT: the full dist/ tree must be shipped, not just the files loaded during a cold
// offline run: Folia lazy-loads per-style chunks (e.g. assets/VisualizerTempera-*.js) via dynamic
// import(), and an incomplete subset caused a black fullscreen window for non-default styles
// (release-artifact bug found by task-13). We therefore copy every dist file except the
// service-worker/PWA trio (not shipped) and local backup files.
//
// Usage: node packaging/tools/stage-web.mjs [--dist <dir>] [--out <dir>] [--report <file>]
//
// --report defaults to packaging/web-stage-report.json (the release pipeline reads it); local plugin
// staging passes a build/ path so a dev run cannot overwrite the production staging report.
import { existsSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Splash (#app-splash) invariants: the player page must keep upstream's first-paint splash, the
// settings live-preview child frame must not have it. Pure helpers so packaging/tools/
// verify-splash-gates.mjs can drive the same code forwards and backwards without a full staging run.
import {
  SPLASH_ID,
  assertIndexHtmlKeepsSplash,
  assertPreviewHtmlHasNoSplash,
  assertSplashTeardownInBundle,
  splashOccurrences,
  stripSplashFromHtml,
} from './lib/splash-gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const dist = resolve(ROOT, opt('dist', 'poc/webview/dist/dist'));
const out = resolve(ROOT, opt('out', 'packaging/web'));
const settingsSrc = resolve(ROOT, 'poc/settings-ui/dist');

if (!existsSync(dist)) throw new Error(`missing dist: ${dist}`);
if (!existsSync(settingsSrc)) throw new Error(`missing settings-UI dist: ${settingsSrc}`);

// Nothing from the PWA/service-worker layer is shipped (the host is a plain WebView2 page).
const skipFiles = new Set(['registerSW.js', 'sw.js', 'folia-cover-sw.js', 'manifest.webmanifest']);
const skipPatterns = [/^workbox-.*\.js$/, /^.*\.bak$/];

function walk(root, rel, acc) {
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, r, acc);
    else if (!skipFiles.has(ent.name) && !skipPatterns.some((re) => re.test(ent.name))) acc.push(r);
  }
  return acc;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const wanted = walk(dist, '', []).sort();
let copied = 0;
let bytes = 0;
const missing = [];
const copiedList = [];
for (const rel of wanted) {
  const src = join(dist, rel);
  if (!existsSync(src) || !statSync(src).isFile()) { missing.push(rel); continue; }
  const dst = join(out, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied++;
  bytes += statSync(dst).size;
  copiedList.push(rel);
  if (rel.startsWith('assets/') && /\.js$/.test(rel)) {
    // guard: lazy chunks must be included (task-13 regression)
    if (!existsSync(dst)) throw new Error(`failed to copy chunk ${rel}`);
  }
}
const hasLazyChunks = copiedList.some((r) => /^assets\/Visualizer/.test(r));
if (!hasLazyChunks) throw new Error('no per-style lazy chunks found in dist assets/ (incomplete dist?)');

// index.html is the only patched file: drop the PWA service-worker registration script (no SW is
// shipped, the tag would 404 on every load) and the manifest link (manifest not shipped).
const indexPath = join(out, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const before = html;
html = html.replace(/<script[^>]*vite-plugin-pwa:register-sw[^>]*><\/script>/g, '');
html = html.replace(/\s*<link rel="manifest"[^>]*>/g, '');
html = html.replace(/\s*<script[^>]*src="\.\/registerSW\.js"[^>]*><\/script>/g, '');
if (html !== before) writeFileSync(indexPath, html);

// HARD GATE 1 — the shipped player page must still carry upstream's first-paint splash
// (`#app-splash`: 深色底 + "Folia" 白色辉光词标 + 13 根波形竖条). It is inline CSS + inline script,
// so it paints on the very first frame, before any bundle loads — that is exactly what the host
// reveals on startup (task-2). Nothing else in the build would notice it going missing: the page
// would simply boot to a black window. Upstream v0.7.25 owns this markup; if it moves, this throws
// and points at the source tree instead of shipping a bundle without a splash.
const splashIndex = assertIndexHtmlKeepsSplash(html, `staged ${relative(ROOT, indexPath).replace(/\\/g, '/')}`);

// HARD GATE 3 — and something in the page bundle must still fade it out. `#app-splash` with no
// teardown covers the player forever, which looks identical to "splash works" in a screenshot.
// Both literals live in src/utils/appSplash.ts, so requiring them in the same chunk is stable.
const stagedJsText = readdirSync(join(out, 'assets'))
  .filter((name) => /\.js$/i.test(name))
  .map((name) => ({ name, text: readFileSync(join(out, 'assets', name), 'utf8') }));
const splashTeardownChunk = assertSplashTeardownInBundle(stagedJsText, 'staged assets/*.js');
// #app-splash occurrences carried by the shipped page (the DOM id, the inline <style> rules and the
// inline script all mention it; upstream 0.7.25 ships 9 on one line + references = 32 total matches).
// Recorded so a published .spmod can be audited for the "splash went missing" regression.
const splashIndexHits = splashOccurrences(html);

// Settings UI island: served by the host at https://spw-folia-settings.local/ (bundle subdir
// settings/ is auto-detected by --bundle). Copy the whole dist (settings-ui.js + styles/ + assets/).
const settingsOut = join(out, 'settings');
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else { copyFileSync(s, d); }
  }
}
copyTree(settingsSrc, settingsOut);
let settingsBytes = 0;
let settingsFiles = 0;
(function walk(p) {
  for (const ent of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, ent.name);
    if (ent.isDirectory()) walk(f);
    else { settingsFiles++; settingsBytes += statSync(f).size; }
  }
})(settingsOut);

// The style shelf renders one <img> per style, so every thumbnail must be in the staged island: a
// missing file is the browser's broken-image icon in the settings window (v0.4.7 report:
// “样式图片显示错误，乱码”). `poc/settings-ui/public/thumbs/` is gitignored build input, so a clean
// checkout that skipped `node scripts/make-thumbs.mjs` silently shipped broken tiles. Fail here
// instead of shipping a bundle that cannot render its own shelf. Checked *after* the dedupe pass
// below, because dedupe may drop or rewrite settings assets.
//
// NOTE: the style list is derived from the built settings bundle further down (see SETTINGS_BUNDLE),
// not hardcoded here — a literal list went stale when upstream v0.7.25 added machi + nebbia.

// Settings-island dedupe: Folia's style pictures and avatars are emitted twice — once by the page
// build (web/assets/<name>) and once by the settings-island build (web/settings/assets/<name>) —
// with byte-identical content. Both trees are served from the same origin, so rewrite the island's
// references to the absolute /assets/<name> URL and drop the duplicate file. This removes ~4 MB of
// incompressible images from the .spmod without touching either bundle's own code.
const settingsDedupe = { candidates: 0, rewrittenRefs: 0, removed: 0, savedBytes: 0, skipped: 0 };
{
  const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const assetsIndex = new Map(); // sha256 -> absolute-relative asset path
  for (const ent of readdirSync(join(out, 'assets'), { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const f = join(out, 'assets', ent.name);
    assetsIndex.set(sha(f), `assets/${ent.name}`);
  }
  const textFiles = [];
  (function collectText(p) {
    for (const ent of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, ent.name);
      if (ent.isDirectory()) collectText(f);
      else if (/\.(?:js|css|html)$/i.test(ent.name)) textFiles.push(f);
    }
  })(settingsOut);
  const texts = new Map(textFiles.map((f) => [f, readFileSync(f, 'utf8')]));
  const changed = new Set();
  const duplicates = [];
  (function collectDupes(p) {
    for (const ent of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, ent.name);
      if (ent.isDirectory()) { collectDupes(f); continue; }
      const target = assetsIndex.get(sha(f));
      if (target && target !== `settings/${relative(settingsOut, f).replace(/\\/g, '/')}`) {
        duplicates.push({ file: f, name: ent.name, target });
      }
    }
  })(settingsOut);
  settingsDedupe.candidates = duplicates.length;
  // A URL token that ends with "/<name>" (or equals it) is a reference to that asset; an absolute
  // path is already correct. Rewriting to /assets/<name> keeps working from any island subdir.
  const TOKEN = /[A-Za-z0-9._~/-]+/g;
  for (const dupe of duplicates) {
    let hits = 0;
    for (const [f, text] of texts) {
      if (!text.includes(dupe.name)) continue;
      const next = text.replace(TOKEN, (tok) => {
        if (tok === dupe.name || (tok.endsWith(`/${dupe.name}`) && !tok.startsWith('/'))) {
          hits++;
          return `/assets/${dupe.name}`;
        }
        return tok;
      });
      if (next !== text) { texts.set(f, next); changed.add(f); }
    }
    if (hits === 0) {
      settingsDedupe.skipped++;
      console.warn(`[stage-web] settings dedupe: kept ${dupe.name} (no reference found)`);
      continue;
    }
    const size = statSync(dupe.file).size;
    unlinkSync(dupe.file);
    settingsDedupe.removed++;
    settingsDedupe.savedBytes += size;
    settingsDedupe.rewrittenRefs += hits;
  }
  for (const f of changed) writeFileSync(f, texts.get(f));
  settingsFiles -= settingsDedupe.removed;
  settingsBytes -= settingsDedupe.savedBytes;
  if (settingsDedupe.removed > 0) {
    console.log(`[stage-web] settings dedupe: ${settingsDedupe.removed} duplicate file(s), `
      + `${(settingsDedupe.savedBytes / 1048576).toFixed(2)} MB, ${settingsDedupe.rewrittenRefs} reference(s) rewritten`);
  }
}

// Every style thumbnail must survive into the staged island (checked after dedupe, which may drop
// or rewrite settings assets).
//
// The list is DERIVED from the built settings bundle instead of being hardcoded here. It used to be
// a literal 15-entry array, which silently stopped guarding the two styles upstream v0.7.25 added
// (machi, nebbia): the settings `vite build` already hard-fails on a missing thumb (its own
// STYLE_MODES gate), so those two could only go missing between the two builds — exactly the case a
// stale hand-maintained copy would wave through.
//
// The signal is the shelf's own STYLE_ENTRIES table in the built bundle: every entry is emitted as
// `mode:\`<id>\`,order:<n>,labelKey:\`ui.<Label>\`…,thumb:<helper>(\`<thumbId>\`)`, so pairing the two
// literals gives exactly the ids the shelf renders. (Reading `thumbs/<id>.jpg` directly is not
// possible — the URL is built at runtime from the entry's own id — and the i18n label keys are NOT
// style ids: `cadenza` is labelled `ui.visualizerCadenze`, which a key-derived check misreads.)
const SETTINGS_BUNDLE = join(settingsOut, 'settings-ui.js');
let shelfStyles = [];
if (existsSync(SETTINGS_BUNDLE)) {
  const bundleText = readFileSync(SETTINGS_BUNDLE, 'utf8');
  const entryRe = /mode:`([a-z0-9_-]+)`,order:\d+,[^`]*`[^`]*`,labelFallback:`[^`]*`,thumb:[A-Za-z_$][\w$]*\(`([a-z0-9_-]+)`\)/g;
  const ids = new Set();
  for (const match of bundleText.matchAll(entryRe)) ids.add(match[2]);
  shelfStyles = [...ids].sort();
}
if (shelfStyles.length === 0) {
  throw new Error(
    `[stage-web] could not derive the style list from ${relative(ROOT, SETTINGS_BUNDLE).replace(/\\/g, '/')}:\n`
    + '  no `mode:<id>` + `thumb:<helper>(<id>)` pairs found in the built shelf table.\n'
    + '  The settings island would ship with an unverifiable style shelf, so the thumbnail gate below\n'
    + '  cannot run. Rebuild the settings bundle (`pnpm build` in poc/settings-ui); if the minifier\n'
    + '  reshaped STYLE_ENTRIES, update this matcher to match src/model/styles.tsx again.',
  );
}
// A shelf entry without a staged thumbnail is the browser's broken-image icon in the settings window
// (v0.4.7 report: “样式图片显示错误，乱码”). Both sides are reported so a missing thumbs run and a
// stale dist are distinguishable in the log.
const stagedThumbFiles = existsSync(join(settingsOut, 'thumbs'))
  ? readdirSync(join(settingsOut, 'thumbs')).filter((n) => /\.jpg$/i.test(n)).map((n) => n.replace(/\.jpg$/i, ''))
  : [];
const missingThumbs = shelfStyles.filter((mode) => !stagedThumbFiles.includes(mode));
if (missingThumbs.length > 0) {
  throw new Error(
    `[stage-web] settings island is missing ${missingThumbs.length} style thumbnail(s) for shelf entries\n`
    + `  [${missingThumbs.join(', ')}] (shelf has ${shelfStyles.length} styles, staged thumbs/: ${stagedThumbFiles.length}).\n`
    + `  Run \`node scripts/make-thumbs.mjs\` in poc/settings-ui (it captures the frames from the real Folia renderer)\n`
    + `  and rebuild the settings bundle (\`pnpm build\`) before staging.`,
  );
}

// Tailwind utilities must actually exist in the staged page CSS. The Folia bundle is built with
// `@import "tailwindcss"` in src/index.css, which only compiles when the Folia source tree carries
// its two PostCSS/Tailwind inputs (postcss.config.js + tailwind.config.js). If either is missing,
// `npx vite build` still exits 0 and silently emits CSS that keeps the literal directive
// `@layer utilities{@tailwind utilities;}` while every utility class (.h-full / .relative / .flex …)
// is absent — the settings live-preview then renders as a 270 px strip instead of filling the
// 1080 px viewport (v0.4.7 report: "预览框显示不全"). A missing build input must break the package
// here, not the user's settings window.
const CSS_FIX_HINT = 'The Folia source tree is missing its build inputs:\n'
  + '  Copy both files from upstream `chthollyphile/folia-major` tag v0.7.22 into the Folia source dir:\n'
  + '    postcss.config.js   (export default { plugins: { \'@tailwindcss/postcss\': {}, autoprefixer: {} } })\n'
  + '    tailwind.config.js\n'
  + '  then rerun `npx vite build` there and re-copy dist/ to poc/webview/dist/dist before staging.';
const stagedAssets = join(out, 'assets');
const stagedCss = existsSync(stagedAssets)
  ? readdirSync(stagedAssets).filter((n) => /\.css$/i.test(n))
  : [];
if (stagedCss.length === 0) {
  throw new Error(`[stage-web] no CSS found in ${relative(ROOT, stagedAssets)}/ — the staged bundle has no page stylesheet`);
}
const cssText = new Map(
  stagedCss.map((name) => [name, readFileSync(join(stagedAssets, name), 'utf8')]),
);
const unprocessedCss = [...cssText].filter(([, text]) => text.includes('@tailwind')).map(([name]) => name);
if (unprocessedCss.length > 0) {
  throw new Error(
    `[stage-web] staged CSS still contains the literal @tailwind directive (unprocessed by PostCSS):\n`
    + `  ${unprocessedCss.join(', ')}\n`
    + `  Every Tailwind utility class is therefore missing, and the settings live-preview collapses to\n`
    + `  a 270 px strip. ${CSS_FIX_HINT}`,
  );
}
// `.h-full{height:100%}` is the canary: it is the rule the preview iframe's layout 100%-height chain
// depends on, and it disappears with the rest of the utilities when the config inputs are lost.
if (![...cssText.values()].some((text) => /\.h-full\{height:100%\}/.test(text))) {
  throw new Error(
    `[stage-web] staged CSS has no .h-full{height:100%} rule — the Tailwind utility layer is missing\n`
    + `  (checked ${stagedCss.length} file(s) in ${relative(ROOT, stagedAssets)}/).\n`
    + `  ${CSS_FIX_HINT}`,
  );
}

// Host-injected scripts are embedded in the executable (C# resources) so they cannot go missing at
// runtime; keep byte-identical copies under web/_host/ for source-offer/audit purposes.
const hostSrc = resolve(ROOT, 'poc/webview/host');
const hostOut = join(out, '_host');
mkdirSync(hostOut, { recursive: true });
let hostScripts = 0;
for (const name of ['Shim.js', 'Overlay.js']) {
  const src = join(hostSrc, name);
  if (existsSync(src)) { copyFileSync(src, join(hostOut, name.toLowerCase())); hostScripts++; }
}

// Live preview (docs/live-preview-iframe.md): the settings overlay embeds preview.html in a
// same-origin iframe. PreviewShim.js is a classic script inside that iframe (NOT injected by the
// host) that replaces EventSource and synthesizes clock/audio locally.
let previewShimCopied = false;
const previewShimSrc = join(hostSrc, 'PreviewShim.js');
if (existsSync(previewShimSrc)) {
  copyFileSync(previewShimSrc, join(hostOut, 'preview-shim.js'));
  previewShimCopied = true;
} else {
  console.warn(`[stage-web] WARNING missing ${relative(ROOT, previewShimSrc)} — preview.html would break`);
}

// preview.html = the stripped index.html plus one classic script tag in <head>, placed before the
// first <script> so it runs before the deferred module entry (classic scripts execute immediately).
//
// WHY THE SPLASH IS STRIPPED FROM THE MARKUP (and not left to upstream's URL escape hatch):
// upstream removes `#app-splash` at runtime when the URL carries `obs=1` / `splash=0` (or the path is
// `/obs`) — but that check is an inline script at the END of <body>, while the splash is inline CSS
// that paints with the first frame. A parameter-guarded child frame can therefore still flash. The
// settings stage re-creates this iframe on every resize and on the stale-SW self-heal retry
// (LivePreview.tsx `key={attempt}`), so a single flash repeated is a visible product bug: the user is
// configuring a lyric style, not watching a second opening title card. Removing the markup (element
// + inline <style> + inline <script>) makes the child document *incapable* of painting a splash,
// independent of the query string LivePreview.tsx builds — which is also why LivePreview.tsx needs no
// change here. The strip keeps the `html,body{background-color:#09090b}` base rule so the child does
// not flash white before React sets the page background.
const PREVIEW_SHIM_TAG = '<script src="/_host/preview-shim.js"></script>';
let previewHtml = false;
const indexHtml = readFileSync(join(out, 'index.html'), 'utf8');
const stripped = stripSplashFromHtml(indexHtml);
const PREVIEW_SPLASH_FIX_HINT = '  If upstream redesigned the splash (different markup, or moved into\n'
  + '  the JS bundle), update stripSplashFromHtml() in packaging/tools/lib/splash-gates.mjs — the\n'
  + '  preview must keep rendering zero splash. Source of truth: work/folia/folia-major-main/index.html.';
if (!stripped.changed) {
  // An index.html without splash markup would have been caught by HARD GATE 1 above, so this only
  // fires if the strip stops matching (e.g. upstream renamed the classes). Fail loudly.
  throw new Error(
    `[stage-web] could not strip the splash from the live-preview page: no ${SPLASH_ID} markup matched.\n`
    + PREVIEW_SPLASH_FIX_HINT,
  );
}
const firstScript = stripped.html.indexOf('<script');
const previewSource = firstScript >= 0
  ? stripped.html.slice(0, firstScript) + PREVIEW_SHIM_TAG + '\n' + stripped.html.slice(firstScript)
  : stripped.html.replace('</head>', PREVIEW_SHIM_TAG + '\n</head>');
if (previewSource.indexOf(PREVIEW_SHIM_TAG) < 0) {
  throw new Error(
    `[stage-web] could not inject ${PREVIEW_SHIM_TAG} into preview.html — no <script> or </head> to hook.\n`
    + '  Without the shim the child frame never reports ready and the live preview silently falls back\n'
    + '  to the static Ken Burns image (docs/live-preview-iframe.md §子帧垫片).',
  );
}
// HARD GATE 2 — the settings live-preview child frame must render lyrics only. Checked on the exact
// bytes written, so a future edit to the injection path cannot reintroduce the splash.
const previewPath = join(out, 'preview.html');
writeFileSync(previewPath, previewSource);
const splashPreview = assertPreviewHtmlHasNoSplash(
  readFileSync(previewPath, 'utf8'),
  `staged ${relative(ROOT, previewPath).replace(/\\/g, '/')}`,
);
previewHtml = true;

// Stable placeholder covers for the preview track (dist filenames carry content hashes).
const previewCovers = {};
const assetsOut = join(out, 'assets');
if (existsSync(assetsOut) && previewHtml) {
  const jpgs = readdirSync(assetsOut).filter((n) => /^placeholder_cover.*\.jpg$/i.test(n));
  const base = jpgs.find((n) => /^placeholder_cover-[^-]/.test(n) && !/^placeholder_cover-2-/.test(n)) || null;
  const reserved = jpgs.find((n) => /^placeholder_cover-2-/.test(n)) || null;
  const previewDir = join(out, 'preview');
  mkdirSync(previewDir, { recursive: true });
  if (base) { copyFileSync(join(assetsOut, base), join(previewDir, 'placeholder_cover.jpg')); previewCovers.placeholder_cover = `assets/${base}`; }
  if (reserved) { copyFileSync(join(assetsOut, reserved), join(previewDir, 'placeholder_cover-2.jpg')); previewCovers.placeholder_cover2 = `assets/${reserved}`; }
  if (!base) console.warn('[stage-web] WARNING no assets/placeholder_cover-*.jpg found; preview cover degrades to none');
  if (!reserved) console.warn('[stage-web] WARNING no assets/placeholder_cover-2-*.jpg found; reserved preview cover missing');
}

const summary = {
  generatedAt: new Date().toISOString(),
  out: relative(ROOT, out).replace(/\\/g, '/'),
  webFiles: copied,
  webBytes: bytes,
  hostScriptCopies: hostScripts,
  previewShimCopied,
  previewHtml,
  previewCovers,
  settingsFiles,
  settingsBytes,
  settingsDedupe,
  totalBytes: bytes + settingsBytes,
  excluded: { swTrio: ['registerSW.js', 'sw.js', 'workbox-*.js', 'folia-cover-sw.js', 'manifest.webmanifest'], reason: 'PWA/service-worker files are not needed for a single local page load; registerSW.js tag removed from index.html' },
  missingFromDist: missing,
  indexHtmlPatched: html !== before,
  // Recorded so a published .spmod can be audited for the missing-build-input regression (P4-14)
  // without re-extracting the archive: the canary rule must be present and no raw directive may be.
  css: {
    filesChecked: stagedCss.length,
    unprocessedTailwindDirective: unprocessedCss,
    hasTailwindUtilities: true,
  },
  // Splash audit (v0.7.25): the player page keeps upstream's first-paint splash, the live-preview
  // child frame never gets one, and the bundle that fades it out is named. A released .spmod can be
  // checked against these three numbers without re-running the build.
  splash: {
    indexHtml: {
      occurrences: splashIndexHits,
      hasElement: splashIndex.hasElement,
      hasWave: splashIndex.hasWave,
      hasTitle: splashIndex.hasTitle,
    },
    previewHtml: {
      occurrences: splashPreview.hits,
      stripped: stripped.removed,
      keptBaseStyle: stripped.removed.baseRulesKept > 0,
    },
    teardownChunk: splashTeardownChunk,
  },
  // Style-shelf audit: the list is derived from the built bundle, so a released .spmod can be checked
  // against exactly the styles this staging run intended to render.
  styleShelf: {
    styles: shelfStyles,
    thumbsStaged: stagedThumbFiles.length,
  },
  files: copiedList,
};
const reportFile = resolve(ROOT, opt('report', 'packaging/web-stage-report.json'));
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(reportFile, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ webFiles: copied, webBytes: bytes, settingsFiles, settingsBytes, settingsDedupe, totalBytes: bytes + settingsBytes, missing: missing.length, indexHtmlPatched: summary.indexHtmlPatched, previewShimCopied, previewHtml, previewCovers, splash: summary.splash }, null, 2));
