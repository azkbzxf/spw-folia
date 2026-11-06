// Compose docs/images/style-grid.png — the "all lyric styles at a glance" grid used by both READMEs —
// from the 17 canonical style frames in `public/thumbs/<mode>.jpg`.
//
//   node scripts/make-style-grid.mjs                 # write docs/images/style-grid.png
//   node scripts/make-style-grid.mjs --out=<file>    # write somewhere else (iterating without touching the asset)
//
// Requires: poc/settings-ui/node_modules (puppeteer-core) and poc/settings-ui/public/thumbs/*.jpg
// (run `node scripts/make-thumbs.mjs` first).
//
// ── Why this COMPOSES instead of screenshotting the live shelf ────────────────────────────────────
// It used to shoot the running settings island and clip the shelf. That cannot work, for two reasons
// that are structural, not timing bugs:
//
//  1. The shelf tiles are not `<img>` any more (since v0.4.12, 8ba12eb): each tile is Folia's own
//     `LyricStylePicture`, i.e. a live renderer frozen into a canvas. So a gate that waits for
//     `img[src*="/thumbs/"]` images to be complete is satisfied by the ONE stage thumbnail in the left
//     preview and resolves immediately — the lazy LiveShelf chunk has not even loaded. The clip then
//     walks up from the 「样式 N」 header to the first ancestor containing every tile, which is a
//     container that also holds the big left preview panel. That produced a 1688x1480 asset with the
//     preview in frame.
//
//  2. Even with the clip right, the tiles could never show what the product shows where it matters.
//     The shelf clock is pinned to Folia's synthetic sample song:
//         ShelfLiveView.tsx   usePreviewClock({ mode, placeholderId: 'default', ... })
//         usePreviewClock.ts  placeholder = VIS_PLAYGROUND_PREVIEW_PLACEHOLDERS[placeholderId]
//         PreviewPlaceholder  .default = 神文之诗 → 'Weave that prosaic divine poem…'
//     and `LyricStylePicture` draws `lines: clock.placeholder.lines`. The preview-cache key
//     (`pictureImages.stylePictureKey` → `model/previewImageCache.styleDiskKey`) only ever includes
//     `sample: placeholder.id`, never track or lyric data — so a warm disk cache or a real-host refill
//     cannot change the words either. A live capture is stuck showing placeholder poetry in a shipped
//     docs asset, and it additionally varies run to run (which tiles finished making their image).
//
// Composing from `public/thumbs/<mode>.jpg` fixes both: those are the SAME canonical frames
// docs/upstream-sync.md §4.5 derives the site images from (real renderer, real demo track, captured by
// `make-thumbs.mjs` against the host), and composition is deterministic — same bytes in, same bytes
// out. The frame, typography and colours still come from the product: `src/model/styles.tsx` is the
// shelf SSOT (mode + order + Chinese label) and the tile geometry/tokens below are Folia's own
// `PictureGrid` / `settingsTokens()` values.
//
// NOTE on that determinism: it is conditional on `public/thumbs/` NOT changing while this runs. Do not
// compose at the same time as `make-thumbs.mjs --force` (the captures land in that directory): two runs
// either side of a recapture legitimately differ, and blaming this script for it is a ghost chase —
// re-run once the thumbs have settled and the hashes match again.
//
// Do NOT "simplify" this back into a live screenshot of the shelf: see the two reasons above.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = resolve(HERE, '..');
const REPO = resolve(SETTINGS_ROOT, '..', '..');
const THUMBS = resolve(SETTINGS_ROOT, 'public/thumbs');

const outArg = process.argv.find(a => a.startsWith('--out='))?.slice('--out='.length);
const OUT = outArg ? resolve(REPO, outArg) : resolve(REPO, 'docs/images/style-grid.png');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/**
 * The 17 lyric modes in shelf order.
 *
 * Kept as a plain literal on purpose: `check-style-sync.mjs` treats it as one of the mechanical id
 * lists (it diffs it against upstream's BUILTIN_VISUALIZER_MODES and can `--write` it), so the exact
 * shape `const MODES = [...]` is a contract — do not rename it or derive it away. It doubles as an
 * independent cross-check: the order and labels actually drawn come from `src/model/styles.tsx`
 * (readShelf below), and the two lists must agree or this script refuses to write the asset.
 */
const MODES = [
    'sonnet', 'tempera', 'lumiere', 'hanabi', 'machi', 'nebbia', 'classic', 'cadenza',
    'partita', 'fume', 'tilt', 'claddagh', 'monet', 'pendolo', 'cappella', 'diorama', 'still',
];

/** Folia's own kit values (components/modal/settings/kit): the tile frame, the grid, the header. */
const KIT = {
    /** `settingsTokens(false)` — the dark settings window this asset has always been shot in. */
    windowBg: '#1a1a1d',
    tileBg: '#151517',       // --st-pv (dark)
    textPrimary: '#f4f4f5',
    labelColor: '#a1a1aa',   // --st-t2 (62% of #f4f4f5 on the window surface)
    countColor: '#6b6b74',   // --st-t3 (42%)
    columns: 7,              // PictureGrid in the wide window
    gapPx: 12,               // gap-3
    padPx: 4,                // p-1
    radiusPx: 8,             // rounded-lg
    surfacePadPx: 12,        // breathing room around the composed block
    /**
     * Composed width in CSS px. Chosen so the written asset lands at ~1600 px wide at 2x, the
     * footprint the README layout has always had (the previous committed file was 1592x612), which
     * also keeps a 7-column row of tiles at ~197x123 px — the same tile size readers are used to.
     */
    surfaceWidth: 800,
};

/**
 * The shelf, verbatim from its SSOT: `src/model/styles.tsx` `STYLE_ENTRIES` (`mode`, `order`,
 * `labelFallback`), sorted by `order` the way the shelf renders them. Parsed rather than duplicated so
 * a style added upstream cannot be silently missing here — the same reason `check-style-sync.mjs`
 * treats that file as authoritative for the style list.
 */
const readShelf = () => {
    const file = resolve(SETTINGS_ROOT, 'src/model/styles.tsx');
    if (!existsSync(file)) throw new Error(`missing ${file}`);
    const text = readFileSync(file, 'utf8');
    const block = text.match(/export const STYLE_ENTRIES: StyleEntry\[\] = \[([\s\S]*?)\n\];/);
    if (!block) {
        throw new Error(
            'could not parse STYLE_ENTRIES from src/model/styles.tsx — if the table changed shape, '
            + 'update readShelf() in scripts/make-style-grid.mjs',
        );
    }
    const entries = [];
    for (const chunk of block[1].split(/\n    \{\n/).slice(1)) {
        const mode = chunk.match(/^\s*mode:\s*'([^']+)'/m);
        const order = chunk.match(/^\s*order:\s*(\d+)/m);
        const fallback = chunk.match(/^\s*labelFallback:\s*'([^']+)'/m);
        if (mode) {
            entries.push({
                mode: mode[1],
                order: order ? Number(order[1]) : 0,
                label: fallback ? fallback[1] : mode[1],
            });
        }
    }
    if (entries.length === 0) throw new Error('parsed 0 style entries from src/model/styles.tsx');
    return entries.sort((a, b) => a.order - b.order);
};

const shelf = readShelf();

// The two lists must agree, in order: `MODES` is what check-style-sync diffs against upstream, the
// parsed shelf is what actually gets drawn (Chinese labels + shelf order). If someone adds a style to
// one and not the other, fail here instead of shipping a grid that silently disagrees with the shelf.
const parsedModes = shelf.map(entry => entry.mode);
if (parsedModes.join(',') !== MODES.join(',')) {
    throw new Error(
        'src/model/styles.tsx STYLE_ENTRIES and this script\'s MODES disagree\n'
        + `  styles.tsx (by order): ${parsedModes.join(',')}\n`
        + `  MODES                : ${MODES.join(',')}\n`
        + '  Fix whichever is behind (check-style-sync.mjs --write keeps MODES in step with upstream).',
    );
}

// Fail loudly on a missing frame: a docs asset with a broken tile is worse than no asset, and this is
// the same class of silent degradation the build's requireStyleThumbs gate exists to catch.
if (!existsSync(EDGE)) throw new Error(`Edge not found: ${EDGE}`);
const missing = MODES.filter(mode => !existsSync(resolve(THUMBS, `${mode}.jpg`)));
if (missing.length > 0) {
    throw new Error(
        `missing ${missing.length} thumbnail(s) in public/thumbs: ${missing.join(', ')}`
        + ' — run `node scripts/make-thumbs.mjs` first',
    );
}
for (const entry of shelf) {
    const bytes = readFileSync(resolve(THUMBS, `${entry.mode}.jpg`));
    // A JPEG starts FF D8 FF; anything else is a truncated/failed capture we must not ship.
    if (bytes.length < 1024 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
        throw new Error(`public/thumbs/${entry.mode}.jpg is not a readable JPEG (${bytes.length} bytes)`);
    }
}

/** The 随机 tile has no captured frame; Folia draws its Shuffle glyph there (lucide-react `shuffle`). */
const RANDOM_TILE = { mode: '__random__', label: '随机', glyph: true };
const SHUFFLE_PATHS = [
    'm18 14 4 4-4 4',
    'm18 2 4 4-4 4',
    'M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22',
    'M2 6h1.972a4 4 0 0 1 3.6 2.2',
    'M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45',
];

/**
 * The document the grid is composed in. Standalone on purpose: nothing from the app bundle is loaded,
 * so module load order, lazy chunks and renderer timing cannot influence the bytes. Its only inputs are
 * the 17 JPEGs (inlined below) and the strings above.
 */
const page_html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
    :root { color-scheme: dark; }
    html, body { margin: 0; }
    body {
        background: ${KIT.windowBg};
        padding: ${KIT.surfacePadPx}px;
        font-family: 'Inter', "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans JP", sans-serif;
        -webkit-font-smoothing: antialiased;
    }
    .head {
        display: flex; align-items: center; min-height: 24px;
        padding: 0 4px; margin-bottom: 8px;
        font-size: 13px; font-weight: 600; line-height: 20px; color: ${KIT.labelColor};
    }
    .count { margin-left: 6px; font-weight: 400; color: ${KIT.countColor}; }
    .grid {
        display: grid; gap: ${KIT.gapPx}px; padding: ${KIT.padPx}px;
        grid-template-columns: repeat(${KIT.columns}, minmax(0, 1fr));
    }
    .tile { display: flex; min-width: 0; flex-direction: column; }
    .frame {
        position: relative; display: block; width: 100%; aspect-ratio: 16 / 10;
        border-radius: ${KIT.radiusPx}px; overflow: hidden; background: ${KIT.tileBg};
    }
    .frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .ring {
        position: absolute; inset: 0; border-radius: ${KIT.radiusPx}px; pointer-events: none;
        box-shadow: inset 0 0 0 1px rgba(244, 244, 245, 0.08);
    }
    .label {
        display: block; width: 100%; margin-top: 6px; text-align: center;
        font-size: 12px; line-height: 18px; color: ${KIT.labelColor};
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .glyph { position: absolute; inset: 0; display: grid; place-items: center; color: ${KIT.textPrimary}; }
    .glyph svg { width: 28px; height: 28px; }
</style></head>
<body>
    <div class="head"><span>样式</span><span class="count">${shelf.length}</span></div>
    <div class="grid" id="grid"></div>
    <script>
        const TILES = ${JSON.stringify([]).replace('[]', '__TILES__')};
        const SHUFFLE = ${JSON.stringify(SHUFFLE_PATHS)};
        const grid = document.getElementById('grid');
        for (const tile of TILES) {
            const el = document.createElement('div');
            el.className = 'tile';
            const frame = document.createElement('span');
            frame.className = 'frame';
            if (tile.thumb) {
                const img = document.createElement('img');
                img.src = tile.thumb;
                img.alt = tile.label;
                img.draggable = false;
                frame.appendChild(img);
            } else {
                const glyph = document.createElement('span');
                glyph.className = 'glyph';
                glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
                    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                    + SHUFFLE.map(d => '<path d="' + d + '"/>').join('') + '</svg>';
                frame.appendChild(glyph);
            }
            const ring = document.createElement('span');
            ring.className = 'ring';
            frame.appendChild(ring);
            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = tile.label;
            el.append(frame, label);
            grid.appendChild(el);
        }
        window.__GRID_READY__ = (async () => {
            const imgs = [...document.images];
            await Promise.all(imgs.map(img => img.decode().catch(() => {})));
            // decode() gives us the bitmap; naturalWidth proves it is not a broken image.
            const broken = imgs.filter(img => !img.naturalWidth).map(img => img.src.slice(0, 40));
            return { total: imgs.length, broken };
        })();
    </script>
</body></html>`;

const tiles = [
    ...shelf.map(entry => ({
        label: entry.label,
        // Inlined so the output depends only on the JPEG bytes: no server, no port, no fetch.
        thumb: `data:image/jpeg;base64,${readFileSync(resolve(THUMBS, `${entry.mode}.jpg`)).toString('base64')}`,
    })),
    { label: RANDOM_TILE.label, thumb: null },
];
const html = page_html.replace('__TILES__', JSON.stringify(tiles));

const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=2'],
    defaultViewport: { width: 1600, height: 1200, deviceScaleFactor: 2 },
});
try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));

    await page.setContent(html, { waitUntil: 'load' });
    const ready = await page.evaluate(() => window.__GRID_READY__);
    if (ready.total !== shelf.length) {
        throw new Error(`grid rendered ${ready.total} frames, expected ${shelf.length}`);
    }
    if (ready.broken.length > 0) {
        throw new Error(`unreadable thumbnails: ${ready.broken.join(', ')}`);
    }
    console.log(`[style-grid] composed ${shelf.length} style frames + 随机 from public/thumbs`);

    // Fixed width, so the asset's dimensions do not depend on the headless window size: 17 tiles in
    // 7 columns at this width reproduce the layout and footprint the README has always shown.
    // Height is measured from the content (header + grid), never inherited from the viewport: a tall
    // viewport would otherwise be baked in as empty surface below the last row.
    const pad = KIT.surfacePadPx;
    await page.setViewport({ width: KIT.surfaceWidth + pad * 2, height: 400, deviceScaleFactor: 2 });
    const block = await page.evaluate(() => {
        const head = document.querySelector('.head').getBoundingClientRect();
        const grid = document.querySelector('.grid').getBoundingClientRect();
        return {
            height: Math.ceil(Math.max(head.bottom, grid.bottom) - Math.min(head.top, grid.top)),
            width: Math.ceil(grid.right - Math.min(head.left, grid.left)),
        };
    });
    await page.setViewport({
        width: block.width + pad * 2,
        height: block.height + pad * 2,
        deviceScaleFactor: 2,
    });
    // Re-measure after the resize: the 7 columns reflow to the new width.
    const final = await page.evaluate(() => ({
        width: Math.ceil(document.documentElement.scrollWidth),
        height: Math.ceil(document.documentElement.scrollHeight),
    }));
    mkdirSync(dirname(OUT), { recursive: true });
    await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: final.width, height: final.height } });
    console.log(`[style-grid] wrote ${OUT} (${final.width}x${final.height} CSS px @2x -> ${final.width * 2}x${final.height * 2} px)`);

    if (pageErrors.length > 0) {
        throw new Error(`page errors during composition: ${pageErrors.join(' | ')}`);
    }
} finally {
    await browser.close();
}
