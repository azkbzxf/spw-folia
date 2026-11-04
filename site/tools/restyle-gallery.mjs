#!/usr/bin/env node
/* Replace the promo site's 17 style stills with the plugin's OWN shelf thumbnails.

   Source: packaging/web/settings/thumbs/<id>.jpg  (1440x900, painted by the shipped renderer and
   what the user actually sees in the 「歌词样式」 shelf).
   Target: site/assets/styles/<id>.jpg (960x540) and site/assets/styles/large/<id>.jpg (1600x900).

   The shelf frames are 16:10, the site is 16:9, so this keeps the centre 810 of 900 rows (45/45).
   Re-run with:  node site/tools/restyle-gallery.mjs
*/
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'packaging/web/settings/thumbs');
const SMALL = join(ROOT, 'site/assets/styles');
const LARGE = join(ROOT, 'site/assets/styles/large');

// ffmpeg with libx264: the Playwright-managed build is on this machine, PATH may have none.
const FF = process.env.FFMPEG
    || [
        'C:/Users/24037/AppData/Local/ms-playwright/ffmpeg-1013/ffmpeg-win64.exe',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
    ].find(p => existsSync(p))
    || 'ffmpeg';

// Folia's shelf order. Must match the STYLES table in site/main.js.
const IDS = [
    'sonnet', 'tempera', 'lumiere', 'hanabi', 'machi', 'nebbia', 'classic', 'cadenza', 'partita',
    'fume', 'tilt', 'claddagh', 'monet', 'pendolo', 'cappella', 'diorama', 'still',
];

// The shelf is 1440x900; crop to 16:9 then scale. Height 900 -> 810 (drop 45 top and bottom).
const CROP = 'crop=1440:810:0:45';
const WEBP = [
    ['large', LARGE, 'scale=1600:900:flags=lanczos', 3],
    ['small', SMALL, 'scale=960:540:flags=lanczos', 4],
];

if (!existsSync(SRC)) {
    console.error(`missing ${SRC} — run: bash packaging/build-package.sh (it stages settings/thumbs/)`);
    process.exit(2);
}
const present = new Set(readdirSync(SRC).filter(n => n.endsWith('.jpg')).map(n => n.replace(/\.jpg$/, '')));
const missing = IDS.filter(id => !present.has(id));
if (missing.length) {
    console.error(`shelf thumbs missing for: ${missing.join(', ')}`);
    process.exit(2);
}

let written = 0;
for (const [label, outDir, scale, quality] of WEBP) {
    mkdirSync(outDir, { recursive: true });
    for (const id of IDS) {
        const out = join(outDir, `${id}.jpg`);
        execFileSync(FF, [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', join(SRC, `${id}.jpg`),
            '-vf', `${CROP},${scale}`,
            '-q:v', String(quality),
            out,
        ], { stdio: 'inherit' });
        written += 1;
        process.stdout.write(`  ${label.padEnd(5)} ${id.padEnd(9)} ${statSync(out).size.toString().padStart(7)} B\n`);
    }
}

console.log(`\n${written} files written from ${IDS.length} shelf thumbnails (${CROP}).`);
