// packaging/tools/lib/splash-gates.mjs
//
// Splash (`#app-splash`) invariants for the staged Folia bundle.
//
// Upstream v0.7.25 ships its branded first-paint splash *inside* index.html: one inline <style>, the
// `#app-splash` DOM block (深色底 + "Folia" 白色辉光词标 + 13 根波形竖条) and one inline <script>
// that randomises the waveform and the letter-font roulette. `src/utils/appSplash.ts#hideAppSplash()`
// fades it out (320 ms) after React mounts (src/components/AppSplashGate.tsx).
//
// spw-folia ships that same page as the player surface, so two things must hold for every staged
// bundle and neither is visible in a green build log:
//
//   1. `web/index.html` STILL carries the splash DOM. If it disappears (staging regex grows too
//      greedy, or upstream moves the splash into the JS bundle), the player opens on a black window
//      instead of the branded splash. Fail the package.
//   2. `web/preview.html` (设置页左栏的实时预览子帧, see docs/live-preview-iframe.md) must NOT carry
//      it. The preview shows lyrics, not an opening title card; the iframe is re-created on resize
//      and on the stale-SW self-heal retry, so a splash there flashes on every rebuild.
//
// Why (2) is a markup strip rather than upstream's own escape hatch: the splash is removed at
// runtime when the URL has `obs=1`, pathname is `/obs`, or `splash=0` — but that check lives in a
// script at the END of <body>, while the splash is inline CSS that paints with the very first frame.
// A parameter-guarded iframe can therefore still flash. Removing the markup makes the child document
// incapable of painting a splash, whatever URL LivePreview.tsx builds and whatever the PreviewShim
// does with the query string.
//
// Pure functions (no fs, no process): stage-web.mjs wires them into the build, and
// packaging/tools/verify-splash-gates.mjs drives the same code in both directions.

/** The splash element id used by upstream index.html / src/utils/appSplash.ts. */
export const SPLASH_ID = 'app-splash';
/** The waveform container class (13 bars in 0.7.25) — the visual half of the splash. */
export const SPLASH_WAVE_CLASS = 'app-splash-wave';
/** The wordmark container class. Reported, not required on its own (see assertIndexHtmlKeepsSplash). */
export const SPLASH_TITLE_CLASS = 'app-splash-title';
/** Class upstream adds right before removing the element (`hideAppSplash`). */
export const SPLASH_HIDING_CLASS = 'is-hiding';
/** Marker written into preview.html so a reader (and the gate) can tell the strip was deliberate. */
export const PREVIEW_NO_SPLASH_MARK =
  '<!-- spw-folia: first-paint splash removed for the settings live preview (packaging/tools/lib/splash-gates.mjs) -->';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How many times `#app-splash` / `app-splash` appears in a document. */
export function splashOccurrences(html) {
  if (typeof html !== 'string') return 0;
  return (html.match(/app-splash/g) || []).length;
}

/** True when the document declares the splash element (`id="app-splash"`). */
export function hasSplashElement(html) {
  return new RegExp(`\\bid\\s*=\\s*["']${escapeRe(SPLASH_ID)}["']`, 'i').test(html);
}

/**
 * Range of the element that carries `id="<id>"`, found by counting its own tag so nested markup
 * (the splash is <div><div><div>…</div><span></span>…</div></div>) is consumed whole.
 * Returns null when the element is absent.
 */
function findElementRange(html, id) {
  const openRe = new RegExp(`<([a-zA-Z][\\w:.-]*)\\b[^>]*\\bid\\s*=\\s*["']${escapeRe(id)}["'][^>]*>`, 'i');
  const open = openRe.exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  if (/\/\s*>$/.test(open[0])) return { start: open.index, end: open.index + open[0].length, tag };
  const tagRe = new RegExp(`<(/?)${escapeRe(tag)}\\b[^>]*?(/?)>`, 'gi');
  tagRe.lastIndex = open.index;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === '/') depth -= 1;
    else if (m[2] !== '/') depth += 1;
    if (depth === 0) return { start: open.index, end: tagRe.lastIndex, tag };
  }
  return null;
}

/** Ranges of `<script>` blocks without `src` whose body mentions `needle`. */
function findInlineScriptRanges(html, needle) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    if (!m[2].includes(needle)) continue;
    out.push({ start: m.index, end: re.lastIndex });
  }
  return out;
}

/**
 * Ranges of `<style>` blocks whose content styles the splash, plus the base paint rules worth
 * keeping from them. Upstream puts `html,body{background-color:#09090b}` in the SAME <style> as the
 * splash rules; dropping that rule makes the preview iframe flash white before React sets the page
 * background, so we carry it over into a replacement <style>.
 */
function findStyleRanges(html, needle) {
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!m[2].includes(needle)) continue;
    const kept = (m[2].match(/\bhtml\s*,\s*body\s*\{[^}]*\}|\bhtml\s*\{[^}]*\}|\bbody\s*\{[^}]*\}/g) || [])
      .filter((rule) => !rule.includes(needle));
    out.push({ start: m.index, end: re.lastIndex, kept });
  }
  return out;
}

/** Apply non-overlapping ranges back-to-front so every range keeps its original indices. */
function applyEdits(html, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = html;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > floor) continue; // overlapping (outer range already applied) — skip the inner one
    out = out.slice(0, edit.start) + (edit.text ?? '') + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

/** Drop HTML comments that only explain the splash (they would dangle once the markup is gone). */
function stripSplashComments(html) {
  return html.replace(/[ \t]*<!--(?:(?!-->)[\s\S])*?-->[ \t]*(?:\r?\n)?/g, (comment) =>
    /首屏加载遮罩|app-splash/.test(comment) ? '' : comment);
}

/**
 * Produce the splash-free variant of the page (used for `preview.html`).
 *
 * Removes, from one pass over the ORIGINAL string (so ranges stay valid):
 *   1. the `#app-splash` DOM element (whole subtree),
 *   2. every inline `<script>` that references the splash (the waveform/letter roulette and the
 *      runtime escape hatch at the end of <body>),
 *   3. every `<style>` block that styles the splash — keeping its `html`/`body` base rules.
 * Then it drops the now-dangling explanatory comments and drops PREVIEW_NO_SPLASH_MARK into <head>
 * so the result explains itself to the next reader (and to assertPreviewHtmlHasNoSplash).
 *
 * @param {string} html
 * @param {{mark?: boolean}} [options] set `mark:false` to get the bare stripped text (tests only)
 * @returns {{html: string, changed: boolean, removed: {styleBlocks: number, elements: number, scripts: number, baseRulesKept: number}}}
 */
export function stripSplashFromHtml(html, options = {}) {
  const mark = options.mark !== false;
  const removed = { styleBlocks: 0, elements: 0, scripts: 0, baseRulesKept: 0 };
  if (typeof html !== 'string' || html.length === 0) {
    return { html, changed: false, removed };
  }

  const edits = [];
  for (const range of findStyleRanges(html, SPLASH_ID)) {
    removed.styleBlocks += 1;
    const baseRules = range.kept.join('');
    if (baseRules) removed.baseRulesKept += range.kept.length;
    edits.push({ start: range.start, end: range.end, text: baseRules ? `<style>${baseRules}</style>` : '' });
  }
  const element = findElementRange(html, SPLASH_ID);
  if (element) {
    removed.elements += 1;
    edits.push({ start: element.start, end: element.end, text: '' });
  }
  for (const range of findInlineScriptRanges(html, SPLASH_ID)) {
    removed.scripts += 1;
    edits.push({ start: range.start, end: range.end, text: '' });
  }

  let out = edits.length > 0 ? applyEdits(html, edits) : html;
  out = stripSplashComments(out);
  // Removing whole blocks leaves runs of indentation-only lines behind; collapse them so the result
  // reads like hand-written markup (the marker would otherwise sit above four empty lines).
  out = out.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n');
  const changed = out !== html;
  if (changed && mark && !out.includes(PREVIEW_NO_SPLASH_MARK)) {
    // Sit right after <head> so it survives any later head-prefix insertion (the PreviewShim tag)
    // and stays greppable in the shipped file. Do not swallow the following whitespace: the next
    // tag keeps its own indentation.
    out = /<head[^>]*>/i.test(out)
      ? out.replace(/(<head[^>]*>)/i, `$1\n    ${PREVIEW_NO_SPLASH_MARK}`)
      : `${PREVIEW_NO_SPLASH_MARK}\n${out}`;
  }
  return { html: out, changed, removed };
}

/** Terse context around the first match, for error messages that name a real line. */
function firstOffendingLine(html) {
  const line = html.split(/\r?\n/).find((l) => l.includes('app-splash'));
  if (!line) return '<no line contains app-splash>';
  const text = line.trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * Gate 1 — the shipped player page must keep upstream's own splash.
 *
 * Required: `id="app-splash"` and the waveform container (`app-splash-wave`). The wordmark container
 * is reported but not required on its own, because the wave is the half that breaks layout visibly
 * and the id is what `hideAppSplash()` looks up — a page with both can still only be "the splash".
 *
 * @returns {{hits: number, hasElement: boolean, hasWave: boolean, hasTitle: boolean}}
 */
export function assertIndexHtmlKeepsSplash(html, label = 'index.html') {
  const hits = splashOccurrences(html);
  const hasElement = hasSplashElement(html);
  const hasWave = typeof html === 'string' && html.includes(SPLASH_WAVE_CLASS);
  const hasTitle = typeof html === 'string' && html.includes(SPLASH_TITLE_CLASS);
  const problems = [];
  if (!hasElement) problems.push(`missing the element (\`id="${SPLASH_ID}"\`)`);
  if (!hasWave) problems.push(`missing the waveform container (\`${SPLASH_WAVE_CLASS}\`)`);
  if (problems.length > 0) {
    throw new Error(
      `[stage-web] ${label} lost Folia's first-paint splash: ${problems.join('; ')} `
      + `(found ${hits} "app-splash" occurrence(s)).\n`
      + `  The player surface opens on this exact page and the host reveals this splash on startup,\n`
      + `  so a staged bundle without it boots to a black window.\n`
      + `  Upstream owns the markup: compare work/folia/folia-major-main/index.html (source) with the\n`
      + `  freshly built poc/webview/dist/dist/index.html. Do NOT re-add splash markup by hand — if the\n`
      + `  splash moved (e.g. into the JS bundle), update this gate together with task-2's host logic.`,
    );
  }
  return { hits, hasElement, hasWave, hasTitle };
}

/**
 * Gate 3 — the page bundle must still fade the splash out.
 *
 * Upstream `AppSplashGate` calls `hideAppSplash()`, which adds `is-hiding` and removes the element
 * after 320 ms. A bundle where the splash element exists but nothing removes it would cover the
 * player forever, so require one staged JS chunk to reference BOTH the element id and that class.
 * (`app-splash` and `is-hiding` are literals of the same module, so they share a chunk.)
 *
 * @param {{name: string, text: string}[]} entries staged `assets/*.js` files
 * @returns {string} the chunk that carries the teardown code (recorded in the stage report)
 */
export function assertSplashTeardownInBundle(entries, label = 'assets/*.js') {
  const list = Array.from(entries || []);
  const hit = list.find((entry) => typeof entry?.text === 'string'
    && entry.text.includes(SPLASH_ID)
    && entry.text.includes(SPLASH_HIDING_CLASS));
  if (!hit) {
    const candidates = list.filter((entry) => typeof entry?.text === 'string' && entry.text.includes(SPLASH_ID));
    throw new Error(
      `[stage-web] no ${label} chunk fades out the splash (\`${SPLASH_ID}\` + \`${SPLASH_HIDING_CLASS}\`).\n`
      + `  ${candidates.length} chunk(s) mention "${SPLASH_ID}" but none carries hideAppSplash()\n`
      + `  (src/utils/appSplash.ts + src/components/AppSplashGate.tsx on the upstream side).\n`
      + `  A splash that is never removed covers the player permanently — fix the build, not this gate.`,
    );
  }
  return hit.name;
}

/**
 * Gate 2 — the settings live-preview child frame must not carry or paint the splash.
 *
 * Requires: zero `app-splash` occurrences, the deliberate-strip marker, and a page that is still a
 * Folia surface (`#root` + a module entry script) — i.e. the strip removed the splash, not the app.
 *
 * @returns {{hits: number, hasMarker: boolean, hasRoot: boolean}}
 */
export function assertPreviewHtmlHasNoSplash(html, label = 'preview.html') {
  const hits = splashOccurrences(html);
  const hasMarker = typeof html === 'string' && html.includes(PREVIEW_NO_SPLASH_MARK);
  const hasRoot = typeof html === 'string' && new RegExp(`\\bid\\s*=\\s*["']root["']`).test(html);
  const problems = [];
  if (hits > 0) problems.push(`${hits} "${SPLASH_ID}" occurrence(s) survived, e.g. ${firstOffendingLine(html)}`);
  if (!hasMarker) problems.push(`missing the "${PREVIEW_NO_SPLASH_MARK}" marker`);
  if (!hasRoot) problems.push('no #root mount point — the page is not a Folia surface any more');
  if (problems.length > 0) {
    throw new Error(
      `[stage-web] ${label} must render lyrics only, but: ${problems.join('; ')}.\n`
      + `  The settings stage embeds this page in a same-origin iframe and re-creates it on resize and\n`
      + `  on the stale-SW self-heal retry; a splash here flashes a dark "Folia" card over the lyrics.\n`
      + `  stripSplashFromHtml() in packaging/tools/lib/splash-gates.mjs is supposed to remove it —\n`
      + `  if upstream changed the splash markup, teach the strip the new shape.`,
    );
  }
  return { hits, hasMarker, hasRoot };
}
