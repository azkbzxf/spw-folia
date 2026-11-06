// Regenerate the 17 settings-UI style thumbnails from the real Folia renderer.
//
// The settings island shows a captured frame per style (src/model/assetBase.ts → `thumbs/<mode>.jpg`).
// Those frames are build inputs, not source: `poc/settings-ui/public/thumbs/` is gitignored, and a
// clean checkout has no `public/` at all — so a plain `vite build` produces a bundle that references
// 17 images it never emitted, and the shelf renders broken images (浏览器显示成乱码/破图).
//
// This script drives the real host (WebView2 + Folia OBS surface + demo track), asks it for one
// 3200x2000 frame per style, centre-crops to 16:10 and writes 1440x900 JPEG q82 into
// poc/settings-ui/public/thumbs/<mode>.jpg, so `vite build` copies them to dist/thumbs/.
//
//   node scripts/make-thumbs.mjs [--force]
//
// Requires: poc/webview/host/build/spw-folia-host.exe, poc/webview/dist/dist (Folia OBS bundle),
// Pillow on PATH (python -m PIL) for the crop/resize step.
//
// ── 为什么不用 `--shot-at`（0.7.25 修掉的坑）───────────────────────────────────────────────────
// 旧实现让宿主在 `--shot-at 6500` 自己截一帧，结果 17 张图**大部分是灰雾 + 看不清的歌词**：
// 那一刻画面还停在「歌曲开场标题卡」（大字 Spike Track + 光束），歌词根本没进正常展示态。
//
// 根因不是「6500 这个数字偏小」，而是 **`--shot-at` 量的是宿主 tick 时钟，不是歌词时间轴**：
// 宿主没收到插件的 `{t:"state"}` 时走 free-running 分支（HostForm.PostState 的 `freePosMs +=
// elapsed`，日志里 `statesReceived=0`），而页面要从 navigation-done 之后再等 React 挂载 +
// 渲染器初始化 + 标题卡动画，实机时钟和墙钟对不上，且**每次运行漂移量不同**。
// 实测：6500ms 与 13000ms 拍到的是同一张标题卡；把 9000/12000/15000 都试一遍也一样。
//
// 所以现在**不猜时间**：脚本自己在 `--keep-alive` 下按 10 Hz 往宿主 stdin 发 `{t:"state"}`，
// 把播放位置**钉**在一个已知的 posMs 上（HostForm.ApplyState 收到 fresh state 就走锚点分支，
// 不再自由计时）。`state` 超过 500ms 就视为过期并回落到 free-running，因此必须持续重发 ——
// 这就是下面的 `startPinning()`。
//
// 截图点取自 DefaultConfig.json 自己的歌词时间轴，取每行 78% 处（词全部落位、还没开始淡出，
// 下一行还暗着）。不同样式取不同行（`LINE_ROTATION`），免得 17 张图全是同一句话。
//
// 验证方法（重采后必做）：把 17 张缩略图拼成 contact sheet 逐张看 —— 每张都要能一眼认出是哪个
// 样式，且**歌词清晰可读**。只跑脚本不看图的「成功」没有意义。见 docs/upstream-sync.md §4。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(SETTINGS_ROOT, '..', '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const OUT_DIR = path.join(SETTINGS_ROOT, 'public', 'thumbs');
const RAW_DIR = path.join(REPO, '.tmp-thumbs', 'raw');
const PROFILE = path.join(REPO, '.tmp-thumbs', 'profile');
/** The demo timeline the host plays (`--demo`): the ONLY source of truth for where a lyric line is. */
const DEMO_CONFIG = path.join(WEBVIEW_ROOT, 'host', 'DefaultConfig.json');

/** Folia's 17 visualizer modes in shelf order (mirrors src/model/styles.tsx).
 *  0.7.25 added machi (町景, order 27) and nebbia (雾笺, order 29): both sit between hanabi (26)
 *  and classic (30) in the shelf, so they are listed in that same position here. */
const MODES = [
    'sonnet', 'tempera', 'lumiere', 'hanabi', 'machi', 'nebbia', 'classic', 'cadenza', 'partita',
    'fume', 'tilt', 'claddagh', 'monet', 'pendolo', 'cappella', 'diorama', 'still',
];

/** Target: the Folia settings shelf tile is 16:10; the sample frame is 1440x900 (q82). */
const THUMB_W = 1440;
const THUMB_H = 900;
/** How far into a line to shoot: every word has landed, the line has not started fading, and the
 *  following line is still dim. 0.78 is past the last word's `endTime` for the demo timeline's
 *  five-syllable lines (each word ends at 0.76·len·4/5 for these evenly split lines). */
const LINE_PROGRESS = 0.78;
/** Re-send cadence for the pinned position: `ApplyState` treats a state older than 500 ms as stale
 *  and falls back to the free-running clock, so 10 Hz leaves a comfortable margin. */
const PIN_INTERVAL_MS = 100;
/** First burst frame. Placed just after the title card is gone (measured: the opening 曲目 title card
 *  occupies roughly the first 2 s; the `page first-frame` log lands at ~1500 ms) and just after the
 *  scene has been built. */
const SETTLE_MS = 2400;
/** Belt and braces for the chrome: the idle timers are a race, so also hard-hide the spw player
 *  chrome by CSS right before the shot. It targets only spw-folia's own injected chrome, never
 *  Folia's renderer. */
const HIDE_CHROME_SCRIPT = `(function(){
  if (document.getElementById('spw-thumb-nochrome')) return 'already';
  var s = document.createElement('style');
  s.id = 'spw-thumb-nochrome';
  // The gear / exit button / background switch carry data-spw-chrome. The playback HUD's ROOT is
  // .spw-playback (PlaybackBar.tsx:412) — .spw-playback-bar is only its expanded inner bar, so
  // selecting that alone left the pill/time readout visible. Both are injected spw chrome, never
  // part of Folia's renderer.
  s.textContent = '[data-spw-chrome],[class^="spw-playback"],[class*=" spw-playback"]{display:none!important}';
  document.head.appendChild(s);
  return 'hidden';
})()`;
/** Poll budget for the PNG to appear and stop growing. */
const POLL_MS = 250;
const MIN_PNG_BYTES = 200_000;
/** How many candidate frames to sample per style, and how far apart.
 *
 *  The lyric layer's visibility window is NOT the same for every style — measured: one full pass
 *  settled at 2650 ms produced crisp lyrics for tilt/partita/cappella but staff-only frames for
 *  sonnet/diorama/classic, while a pass settled at 3400 ms had exactly the opposite outcome. Rather
 *  than tune a per-style constant (17 styles x trial and error), sample ACROSS the whole measured
 *  window and let the ink score pick: 6 frames from 2400 ms every 600 ms covers [2400, 5400], which
 *  brackets every confirmed-good frame seen in calibration. Past ~5400 the capture itself starts
 *  coming back empty on some styles, hence the upper bound. */
const SHOT_ATTEMPTS = 3;
const SHOT_GAP_MS = 600;
/** Settle time after moving the pin to a different lyric line, before sampling that line. The style
 *  re-lays-out its line (and several animate the new line in), so a frame taken too soon shows the
 *  previous line fading out. */
const POSITION_SETTLE_MS = 1200;

const force = process.argv.includes('--force');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait until the host has written `file` completely: the capture is asynchronous on its UI thread,
 *  so the path can exist at 0 bytes for a while. Polls until the size is plausible AND stable. */
async function waitForPng(file) {
    const deadline = Date.now() + 15000;
    let lastSize = -1;
    while (Date.now() < deadline) {
        await sleep(POLL_MS);
        let size = 0;
        try { size = fs.statSync(file).size; } catch { continue; }
        if (size >= MIN_PNG_BYTES && size === lastSize) return true;
        lastSize = size;
    }
    return false;
}

if (!fs.existsSync(EXE)) throw new Error(`missing host exe: ${EXE}`);
if (!fs.existsSync(BUNDLE)) throw new Error(`missing Folia OBS bundle: ${BUNDLE}`);
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * The screenshot position for each style, derived from the demo timeline itself.
 *
 * Reading the positions out of `DefaultConfig.json` (rather than hardcoding 6500) is the whole point:
 * when the demo track or its lyrics change upstream, the thumbnails follow automatically instead of
 * silently shooting a title card again.
 */
const lineShots = (() => {
    const config = JSON.parse(fs.readFileSync(DEMO_CONFIG, 'utf8'));
    const lines = config?.lyrics?.lines;
    if (!Array.isArray(lines) || lines.length === 0) {
        throw new Error(
            `[make-thumbs] ${path.relative(REPO, DEMO_CONFIG).replace(/\\/g, '/')} has no lyrics.lines —`
            + ' cannot pin a thumbnail position to a lyric line.\n'
            + '  The demo timeline is what the pinned clock aims at; restore it or update LINE_ROTATION below.',
        );
    }
    return lines.map((line) => ({
        id: line.id,
        text: line.fullText,
        posMs: Math.round((line.startTime + (line.endTime - line.startTime) * LINE_PROGRESS) * 1000),
    }));
})();

/** Per-style lyric line to pin, as an index into the demo timeline's lines.
 *
 *  Rotating the line matters: the pin position decides which line is "current", and some styles
 *  animate a line in over its first second — a pin that lands exactly on a line boundary can catch the
 *  entry animation instead of the settled line. Spreading the 17 styles over the four demo lines also
 *  keeps the thumbnails from all showing the same sentence. */
const LINE_ROTATION = {
    sonnet: 1, tempera: 0, lumiere: 2, hanabi: 3, machi: 1, nebbia: 2, classic: 2, cadenza: 2,
    partita: 1, fume: 2, tilt: 1, claddagh: 0, monet: 2, pendolo: 3, cappella: 1, diorama: 2, still: 2,
};

/** Secondary positions tried when the primary one yields no lyric ink. Each entry is a line index;
 *  the burst below re-samples the time axis at each of them before giving up on the style. This is
 *  what makes the capture robust against the per-style flakiness measured during calibration: the
 *  same style at the same pinned position can render the lyric layer in one session and omit it in
 *  the next, so a single position is not enough — vary both position and moment, then score. */
const FALLBACK_LINES = [1, 0, 3, 2];

/** The shot position for a style: `{ lineIndex, posMs, text }`. `lineIndex` is returned so the
 *  sampling loop can walk the other lines and report which one was actually used. */
const shotPositionFor = (mode, lineIndex = null) => {
    const index = lineIndex ?? LINE_ROTATION[mode] ?? Math.min(2, lineShots.length - 1);
    const clamped = Math.min(index, lineShots.length - 1);
    return { ...lineShots[clamped], lineIndex: clamped };
};

const missing = (only ? only.split(',') : MODES)
    .filter(mode => !MODES.includes(mode) ? (() => { throw new Error(`--only= unknown mode ${mode}`); })() : true)
    .filter(mode => force || !fs.existsSync(path.join(OUT_DIR, `${mode}.jpg`)));
if (missing.length === 0) {
    console.log(`[make-thumbs] all ${MODES.length} thumbnails already present (use --force to redo)`);
    process.exit(0);
}

console.log(`[make-thumbs] capturing ${missing.length}/${MODES.length}: ${missing.join(', ')}`);
console.log(`[make-thumbs] pinned lyric lines: ${lineShots.map(l => `${l.id}@${l.posMs}ms "${l.text}"`).join(' · ')}`);

/** One host run per style. The host is kept alive and told exactly where the playhead is. */
async function capture(mode) {
    const target = shotPositionFor(mode);

    const child = spawn(EXE, [
        '--bundle', BUNDLE,
        '--fullscreen',
        '--mode', mode,
        '--settings-dir', path.join(SETTINGS_ROOT, 'dist'),
        '--settings-entry', 'settings-ui.js',
        '--keep-alive',
        '--user-data', PROFILE,
        '--title', `thumb ${mode}`,
        '--demo', '--no-topmost', '--no-curtain',
        // v0.4.9: two independent guards so a thumbnail can never be captured through a colour-keyed
        // window. `--no-transparency` skips the transparency path entirely (this script never asked for
        // it, and a persisted setting from an earlier run could otherwise switch it on), while
        // `--no-colour-key` guarantees that even a transparent session keeps an opaque black window.
        // The key tints every page pixel whose alpha is between 0 and 1, so it must never be live here.
        '--no-transparency', '--no-colour-key',
        // The placeholder HUD would be baked into the thumbnail in the bottom-right corner.
        '--no-overlay',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let log = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { log += chunk; });

    const send = (payload) => { try { child.stdin.write(JSON.stringify(payload) + '\n'); } catch { /* closed */ } };

    // Pin the playhead. This is what makes the frame deterministic: without it the host runs its own
    // free clock and the shot lands wherever the title card happens to be (the 0.7.25 grey-thumbnail bug).
    // `pinnedPosMs` is what the timer keeps re-sending; the sampling loop below moves it.
    let pinnedPosMs = target.posMs;
    let pinning = true;
    const pinTimer = setInterval(() => {
        if (!pinning) return;
        send({
            t: 'state',
            posMs: pinnedPosMs,
            durationMs: 180000,
            playing: true,
            rate: 1,
            lyricOffsetMs: 0,
        });
    }, PIN_INTERVAL_MS);

    // Give the page time to mount the renderer before the first shot; the host logs `nav-done` at
    // ~0.6 s but the visualizers need a couple of seconds to build their scenes. SETTLE_MS also
    // sits just past the chrome's own idle-hide timers (see its comment).
    await sleep(SETTLE_MS);
    // ...and hide that chrome outright, because those timers are a race we do not want to depend on.
    send({ t: 'command', command: 'eval', script: HIDE_CHROME_SCRIPT });
    await sleep(350);

    // Warm-up frame, thrown away. The FIRST screenshot of a session can come back with the lyric
    // layer missing even though the very next one (same pinned position, nothing else changed) has
    // it — measured on `still`: shot #0 had no text at all, shot #1 1.2 s later was correct. The
    // compositor has simply not presented the text layer at the instant `CapturePreviewAsync` runs.
    // Taking and discarding one frame makes every style deterministic instead of "usually fine".
    const warmupShot = path.join(RAW_DIR, `${mode}.warmup.png`);
    try { fs.rmSync(warmupShot, { force: true }); } catch { /* ignore */ }
    send({ t: 'command', command: 'screenshot', path: warmupShot });
    await waitForPng(warmupShot);
    await sleep(900);   // let the renderer settle again after the discarded capture

    // Sample ACROSS both axes, then keep the best frame. Neither axis alone is reliable:
    //  - TIME: the lyric layer appears and disappears in the captured frames independent of the pinned
    //    position (same style, same posMs: text at 2.6 s, no text at 3.8 s, empty capture by 6 s).
    //  - POSITION: a pin on a line boundary catches the entry animation instead of the settled line,
    //    and which lines animate cleanly differs per style.
    // So walk a couple of lyric lines and burst several frames at each; the ink score below picks.
    // Measured on `classic`: same pinned position 10852, one session had crisp 君の声が and another had
    // only the staff — position+time sampling is what removes that coin flip.
    const candidates = [];
    const lineOrder = [target.lineIndex, ...FALLBACK_LINES.filter(i => i !== target.lineIndex)];
    for (const lineIndex of lineOrder) {
        const line = shotPositionFor(mode, lineIndex);
        send({ t: 'state', posMs: line.posMs, durationMs: 180000, playing: true, rate: 1, lyricOffsetMs: 0 });
        pinnedPosMs = line.posMs;
        await sleep(POSITION_SETTLE_MS);
        for (let attempt = 1; attempt <= SHOT_ATTEMPTS; attempt += 1) {
            const candidate = path.join(RAW_DIR, `${mode}.L${lineIndex}.${attempt}.png`);
            try { fs.rmSync(candidate, { force: true }); } catch { /* ignore */ }
            send({ t: 'command', command: 'screenshot', path: candidate });
            if (await waitForPng(candidate)) candidates.push(candidate);
            if (attempt < SHOT_ATTEMPTS) await sleep(SHOT_GAP_MS);
        }
    }
    if (candidates.length === 0) {
        pinning = false;
        clearInterval(pinTimer);
        throw new Error(`no usable screenshot for ${mode} at any tested position\n${log.slice(-1600)}`);
    }

    pinning = false;
    clearInterval(pinTimer);
    // Keep pinning once more so the page is not left on the free clock while it tears down.
    send({ t: 'command', command: 'close' });
    await new Promise(resolve => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* done */ } resolve(); }, 6000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
    });

    // v0.4.19 (task-4): validate the REAL captures, not a leftover path. The candidate refactor
    // (4b6378b) made every shot `RAW_DIR/<mode>.L<line>.<n>.png` but left a `RAW_DIR/<mode>.png`
    // "shot" local behind; this check then threw "no usable screenshot" AFTER a perfectly good
    // capture, and the log line below stat'ed the same dead path. It stayed hidden because the
    // default run only fills MISSING thumbs and public/thumbs/ predated the refactor. `waitForPng`
    // already guarantees size, but re-checking here keeps the contract local and explicit.
    const usable = candidates.filter(file => {
        try {
            return fs.existsSync(file) && fs.statSync(file).size >= MIN_PNG_BYTES;
        } catch {
            return false;
        }
    });
    if (usable.length === 0) {
        throw new Error(`no usable screenshot for ${mode}\n${log.slice(-1600)}`);
    }
    // `candidates` is handed back so the chooser below can pick the frame with the most lyric ink.
    return { target, candidates: usable };
}

const shots = [];
for (const mode of missing) {
    const { target, candidates } = await capture(mode);
    shots.push({ mode, target, candidates });
    console.log(
        `[make-thumbs] captured ${mode} @ ${target.posMs}ms "${target.text}"`
        + ` -> ${candidates.length} candidate(s) in ${path.relative(REPO, RAW_DIR)}, first ${fs.statSync(candidates[0]).size} B`,
    );
}

// Centre-crop to 16:10 and downscale. Pillow is the only image dependency in this repo (site/tools
// uses it too), so the crop step (and the frame ranking) stays in Python instead of pulling a Node
// image library.
//
// Ranking: each style comes in with several burst candidates; keep the one that shows the most LYRICS.
// A naive bright-pixel count does not work — several styles (classic/partita/pendolo/cappella/
// diorama) draw a staff with note heads and thin rules, which scores as high as real text while
// containing no lyrics at all. The discriminator is glyph THICKNESS: a 5x5 erosion wipes out
// 1-2 px staff hairlines and rules but leaves the fat strokes of a large lyric character. So the
// score is "bright, then eroded, then counted" inside the band where the current line sits.
// It needs no OCR, and it fails safe: if every candidate scores near zero the pick is arbitrary but
// the run still completes, and the contact-sheet check catches it.
const py = `
import json, sys
from PIL import Image, ImageFilter, ImageStat
jobs = json.loads(sys.argv[1])
W, H = ${THUMB_W}, ${THUMB_H}

def lyric_ink(path):
    im = Image.open(path).convert('L')
    w, h = im.size
    # Two things keep the score about LYRICS rather than decoration:
    #  - a narrow central column: Folia draws the current line in the middle, while the staff / rules
    #    several styles draw span nearly the whole width and would otherwise dominate;
    #  - a 9x9 erosion: 1-2 px staff hairlines and rules are erased, fat lyric strokes survive.
    # The ratio between a text frame and a staff-only frame measures ~5-8x on this metric, so the
    # ranking is decisive rather than cosmetic (measured on sonnet's six candidates).
    band = im.crop((int(w * 0.28), int(h * 0.28), int(w * 0.72), int(h * 0.74)))
    # Brightnesses differ hugely per style (tempera is a light page, still is near-black), so the
    # threshold is relative to each frame's own median rather than absolute.
    med = ImageStat.Stat(band).median[0]
    bright = band.point(lambda p: 255 if p >= max(med + 30, 100) else 0)
    fat = bright.filter(ImageFilter.MinFilter(9))
    total = sum(bright.histogram()) or 1
    return sum(fat.histogram()[1:]) / total

for job in jobs:
    # candidates is always non-empty: capture() throws unless at least one real frame survived
    # validation. (A "job['candidates'] or [job['shot']]" fallback used to sit here; the shot path no
    # longer exists, so that branch could never fire and is gone.)
    candidates = job['candidates']
    scores = [(lyric_ink(c), c) for c in candidates]
    scores.sort(reverse=True)
    best_score, best = scores[0]
    im = Image.open(best).convert('RGB')
    w, h = im.size
    want = W / H
    if w / h > want:
        nw = int(h * want)
        im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w / want)
        im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    im = im.resize((W, H), Image.LANCZOS)
    im.save(job['out'], 'JPEG', quality=82, optimize=True, progressive=True)
    print('wrote', job['out'], im.size, 'ink=%.5f' % best_score, '(picked %d/%d)' % ([c for _, c in scores].index(best) + 1, len(candidates)))
`;
// Prefer a Python that actually has Pillow: the repo's own `python` may be a bare 3.x install, while
// the DSH runtime ships Pillow. Both are tried before giving up.
const pythonCandidates = [
    process.env.PYTHON,
    'python',
    'C:/Users/24037/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/python/python.exe',
].filter(Boolean);
const python = pythonCandidates.find(candidate => {
    const probe = spawnSync(candidate, ['-c', 'import PIL'], { encoding: 'utf8' });
    return probe.status === 0;
});
if (!python) throw new Error('no Python with Pillow found; set PYTHON=<path to python with Pillow>');
const jobs = shots.map(({ mode, candidates }) => ({
    candidates,
    out: path.join(OUT_DIR, `${mode}.jpg`),
}));
const result = spawnSync(python, ['-c', py, JSON.stringify(jobs)], { encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`thumbnail crop failed:\n${result.stdout}\n${result.stderr}`);
process.stdout.write(result.stdout);

// Every style must end up with a thumbnail: the shelf renders `<img src>` for all 17 tiles, so a
// missing file is a visible broken image in the settings window.
const absent = MODES.filter(mode => !fs.existsSync(path.join(OUT_DIR, `${mode}.jpg`)));
if (absent.length > 0) throw new Error(`thumbnails still missing after capture: ${absent.join(', ')}`);
console.log(`[make-thumbs] ${MODES.length} thumbnails ready in ${path.relative(REPO, OUT_DIR)}`);
