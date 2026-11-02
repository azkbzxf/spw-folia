// Capture docs/images/style-grid.png — the "all lyric styles at a glance" grid used by both
// READMEs — from the real settings UI, so it always shows the current shelf (15 styles + 随机).
//
// The previous file was a v0.3.x screenshot with 14 tiles: it predates Folia 0.7.22's 花火
// (hanabi), so the README showed a grid that could not match the product. Re-shooting from the
// running settings island is the only way to keep the tile order, labels and thumbnails honest.
//
//   node scripts/make-style-grid.mjs [--keep]
//
// Requires: poc/settings-ui/node_modules (vite + puppeteer-core), Edge, and
// poc/settings-ui/public/thumbs/*.jpg (run `node scripts/make-thumbs.mjs` first).
// Output: ../../docs/images/style-grid.png
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = resolve(HERE, '..');
const REPO = resolve(SETTINGS_ROOT, '..', '..');
const OUT = resolve(REPO, 'docs/images/style-grid.png');
const THUMBS = resolve(SETTINGS_ROOT, 'public/thumbs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 18097;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MODES = [
    'sonnet', 'tempera', 'lumiere', 'hanabi', 'machi', 'nebbia', 'classic', 'cadenza',
    'partita', 'fume', 'tilt', 'claddagh', 'monet', 'pendolo', 'cappella', 'diorama', 'still',
];

if (!existsSync(EDGE)) throw new Error(`Edge not found: ${EDGE}`);
for (const mode of MODES) {
    if (!existsSync(resolve(THUMBS, `${mode}.jpg`))) {
        throw new Error(`missing thumbnail: public/thumbs/${mode}.jpg — run \`node scripts/make-thumbs.mjs\` first`);
    }
}

// The dev server serves public/ at the dev-origin root, which is where assetBase.ts falls back to
// (dev.html has no injected <script src="/settings-ui.js"> for it to read a base from).
const vite = spawn(process.execPath, [resolve(SETTINGS_ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: SETTINGS_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
});
const viteErr = [];
vite.stderr.on('data', d => viteErr.push(String(d)));
const stop = () => { try { vite.kill(); } catch { /* ignore */ } };
process.on('exit', stop);

const started = Date.now();
for (;;) {
    try {
        const res = await fetch(`http://localhost:${PORT}/dev.html`);
        if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - started > 90000) {
        stop();
        throw new Error(`vite dev server did not start on :${PORT}\n${viteErr.join('')}`);
    }
    await sleep(300);
}

const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=2'],
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

await page.goto(`http://localhost:${PORT}/dev.html`, { waitUntil: 'networkidle0' });

// The overlay opens by default in dev; the shelf lives below the preview.
await page.waitForSelector('[role="tab"]', { timeout: 30000 });

// Wait for every shelf thumbnail to actually decode — a screenshot taken before the JPEGs resolve
// would bake broken-image icons into a docs asset.
const thumbsReady = await page.waitForFunction(
    () => {
        const imgs = [...document.querySelectorAll('img')].filter(i => /\/thumbs\/[^/]+\.jpg/.test(i.getAttribute('src') || i.src));
        return imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0) ? imgs.length : false;
    },
    { timeout: 30000, polling: 200 },
).then(h => h.jsonValue()).catch(() => 0);
if (!thumbsReady) {
    throw new Error(`style thumbnails never finished loading (pageErrors: ${pageErrors.join(' | ') || 'none'})`);
}
console.log(`[style-grid] ${thumbsReady} shelf thumbnails decoded`);

// Seal the layout: the block that carries the "样式 N" header *and* the tiles. Selecting the
// smallest ancestor of all 15 images lands on the inner scroll grid and loses the header above it,
// so find the header element first and use the container that owns both.
const shelf = await page.evaluateHandle(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => /\/thumbs\/[^/]+\.jpg/.test(i.src));
    if (imgs.length === 0) return null;
    // The header is a short text node starting with 样式 and followed by the tile count.
    const header = [...document.querySelectorAll('div,span,h2,h3,p')]
        .filter(el => el.children.length <= 2 && /^样式\s*\d+/.test((el.textContent || '').trim()))
        .pop();
    if (header) {
        // Nearest ancestor that also contains every tile.
        let node = header;
        while (node && node.parentElement) {
            node = node.parentElement;
            if (imgs.every(img => node.contains(img))) return node;
        }
    }
    // Fallback: smallest ancestor of all tiles (header may be clipped, but the grid is intact).
    let node = imgs[0];
    while (node && node.parentElement) {
        node = node.parentElement;
        if (imgs.every(img => node.contains(img))) return node;
    }
    return null;
});
if (!shelf.asElement()) throw new Error('could not locate the style shelf container');
const box = await shelf.asElement().boundingBox();
if (!box) throw new Error('could not measure the style shelf');

// A little padding so the rounded tile corners and the row labels are not clipped.
const PAD = 12;
const clip = {
    x: Math.max(0, box.x - PAD),
    y: Math.max(0, box.y - PAD),
    width: Math.min(1600 - Math.max(0, box.x - PAD), box.width + PAD * 2),
    height: Math.min(1000 - Math.max(0, box.y - PAD), box.height + PAD * 2),
};
console.log(`[style-grid] shelf box ${Math.round(box.width)}x${Math.round(box.height)} -> clip ${Math.round(clip.width)}x${Math.round(clip.height)}`);

mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, clip });
await browser.close();
stop();

if (pageErrors.length) console.warn(`[style-grid] page errors during capture: ${pageErrors.join(' | ')}`);
console.log(`[style-grid] wrote ${OUT}`);
