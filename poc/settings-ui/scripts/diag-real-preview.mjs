// Functional check of the v0.4.1 真实预览 contract inside the real host:
//
//   * the stage iframe receives the *same* config the publisher pushed to the player
//     (real demo song, real lyrics, real background — no placeholder song, no preset theme colour);
//   * the child shim runs in `live` mode: the parent forwards the host's real clock/audio, so
//     `__SPW_FOLIA_PREVIEW__.clockMs` tracks `__SPW_FOLIA__.inputs.state.posMs`;
//   * the transparent-playback flag reaches both the parent stage (checkerboard) and the iframe config;
//   * pause freezes the child clock (no synthetic timeline keeps running).
//
//   node scripts/diag-real-preview.mjs [stagedBundleDir]
//
// Requires a staged bundle with preview.html + _host/preview-shim.js; by default the lead's
// `.tmp-verify/web` staging (node packaging/tools/stage-web.mjs --out .tmp-verify/web) is used.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(SETTINGS_ROOT, '..', '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.resolve(REPO, process.argv[2] ?? '.tmp-verify/web');
const OUT = path.join(WEBVIEW_ROOT, 'host', 'out', 'real-preview');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

if (!fs.existsSync(EXE)) throw new Error(`missing host exe: ${EXE}`);
if (!fs.existsSync(path.join(BUNDLE, 'preview.html'))) throw new Error(`missing preview.html in bundle: ${BUNDLE}`);

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--windowed', '--width', '1760', '--height', '1100',
    '--force-dsf', '1',
    '--settings-dir', path.join(BUNDLE, 'settings'), '--settings-entry', 'settings-ui.js',
    '--duration', '40000',
    '--user-data', path.join(OUT, 'profile'),
    '--title', 'real preview check',
    '--demo', '--no-topmost',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });

const waiters = [];
const logs = [];
const errors = [];
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { logs.push(line); continue; }
        if (msg.t === 'log' && msg.level === 'error') errors.push(String(msg.msg));
        if (msg.t === 'eval-result') {
            const waiter = waiters.shift();
            if (waiter) waiter(String(msg.value));
        }
    }
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', d => stderr.push(d));

const send = payload => child.stdin.write(JSON.stringify(payload) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sendEval = script => new Promise(resolve => {
    waiters.push(resolve);
    send({ t: 'command', command: 'eval', script });
});

/** Evaluate a JSON-producing snippet in the top page; always resolves to a parsed value. */
const evalParent = async script => {
    const raw = await sendEval(`(function(){ try { return JSON.stringify((function(){${script}})()); } catch (e) { return JSON.stringify({ __error: String(e && (e.stack || e.message) || e) }); } })()`);
    // The host's `eval-result.value` is itself the JSON text of what ExecuteScriptAsync returned,
    // and our snippet already returns a JSON string — so decode twice.
    try {
        const once = JSON.parse(raw);
        return typeof once === 'string' ? JSON.parse(once) : once;
    } catch {
        try { return JSON.parse(raw); } catch { return { __raw: raw }; }
    }
};

const stageScript = `var box = document.querySelector('[data-spw-live-preview]');
    var frame = box ? box.querySelector('iframe') : null;
    var summary = null;
    if (frame && frame.contentWindow && frame.contentWindow.__SPW_FOLIA_PREVIEW__) {
        summary = JSON.parse(JSON.stringify(frame.contentWindow.__SPW_FOLIA_PREVIEW__));
    }
    var bridge = window.__SPW_FOLIA__;
    var lastConfig = bridge && bridge.lastConfig ? bridge.lastConfig() : null;
    var bodyBg = frame && frame.contentDocument ? frame.contentDocument.body.style.backgroundColor : null;
    return {
        overlayOpen: !!document.querySelector('[data-spw-settings-overlay="true"]'),
        hasStage: !!box,
        ready: box ? box.getAttribute('data-live-preview-ready') : null,
        wrapperClass: box && box.parentElement ? String(box.parentElement.className || '') : '',
        chip: (function(){ var e = box && box.parentElement ? box.parentElement.querySelector('span') : null; return e ? String(e.textContent || '') : null; })(),
        iframeBodyBg: bodyBg,
        summary: summary,
        publishHistory: Array.isArray(window.__spwFoliaPublishHistory) ? window.__spwFoliaPublishHistory.slice(-8) : null,
        bridgeTrack: bridge && bridge.inputs ? (bridge.inputs.track ? { id: bridge.inputs.track.id, title: bridge.inputs.track.title } : null) : 'no-bridge',
        hostState: bridge && bridge.inputs ? bridge.inputs.state : null,
        publishedConfig: lastConfig ? {
            song: lastConfig.song || null,
            hasLyrics: !!(lastConfig.lyrics && lastConfig.lyrics.lines && lastConfig.lyrics.lines.length),
            lyricLines: lastConfig.lyrics && lastConfig.lyrics.lines ? lastConfig.lyrics.lines.length : 0,
            transparent: !!(lastConfig.background && lastConfig.background.transparent),
            backgroundMode: lastConfig.background ? lastConfig.background.mode : null,
        } : null,
    };`;

const clickPauseScript = `var box = document.querySelector('[data-spw-live-preview]');
    if (!box) return 'no-stage';
    var btn = box.parentElement && box.parentElement.querySelector('button');
    if (!btn) return 'no-button';
    btn.click();
    return String(btn.getAttribute('aria-label') || 'clicked');`;

const buttonScript = `var box = document.querySelector('[data-spw-live-preview]');
    var btns = box && box.parentElement ? box.parentElement.querySelectorAll('button') : [];
    return {
        count: btns.length,
        labels: Array.prototype.map.call(btns, function (b) { return String(b.getAttribute('aria-label') || ''); }),
        stageCount: document.querySelectorAll('[data-spw-live-preview]').length,
        overlayOpen: !!document.querySelector('[data-spw-settings-overlay="true"]'),
    };`;

const fontTabScript = `var target = Array.prototype.filter.call(document.querySelectorAll('button,[role="tab"]'), function (el) {
    return el.textContent && el.textContent.trim() === '字体';
})[0];
    if (target) target.click();
    return {
        found: !!target,
        hasPreviewText: (document.body.innerText || '').indexOf('预览文本') >= 0,
        tabLabels: Array.prototype.map.call(document.querySelectorAll('[data-spw-settings-overlay] button,[data-spw-settings-overlay] [role="tab"]'), function (e) { return (e.textContent || '').trim(); }).filter(function (s) { return s.length > 0 && s.length < 6; }),
    };`;

const results = [];
const record = (name, value) => { results.push({ name, value }); console.log(`\n[${name}]`, JSON.stringify(value, null, 2)); };

try {
    await sleep(4000);
    // Emulate the SPW plugin: a real track + its lyrics arrive as plugin bridge messages. The demo
    // host embeds its own demo config, but a production page only gets track/lyrics from the plugin.
    send({
        t: 'track',
        id: 'spike-song',
        title: 'Spike Track',
        artist: 'Folia',
        album: 'POC',
        coverUrl: null,
    });
    send({
        t: 'lyrics',
        lines: [
            { startMs: 17000, endMs: 21000, main: '静かな夜に', sub: '在寂静的夜里' },
            { startMs: 21000, endMs: 25000, main: '光が満ちて', sub: '光芒洒满' },
            { startMs: 25000, endMs: 29000, main: '君の声が', sub: '你的声音' },
            { startMs: 29000, endMs: 33000, main: '遠くへ響く', sub: '响彻远方' },
            { startMs: 33000, endMs: 37000, main: '夜を越えて', sub: '越过黑夜' },
            { startMs: 37000, endMs: 41000, main: '朝を待って', sub: '等待清晨' },
            { startMs: 41000, endMs: 45000, main: 'また会える', sub: '终会重逢' },
            { startMs: 45000, endMs: 49000, main: 'この場所で', sub: '在这个地方' },
        ],
    });
    await sleep(1500);
    send({ t: 'command', command: 'open-settings' });
    await sleep(2200);

    const first = await evalParent(stageScript);
    record('stage-open', first);
    await sleep(1600);
    const second = await evalParent(stageScript);
    record('stage-live', second);

    send({ t: 'command', command: 'screenshot', path: path.join(SHOTS, 'preview-live.png') });
    await sleep(600);

    // Transparent playback: the same switch the UI uses (defined by the settings island).
    await evalParent(`window.__spwFoliaSetTransparent(true); return 'ok';`);
    await sleep(1600);
    const transparent = await evalParent(stageScript);
    record('stage-transparent', transparent);
    send({ t: 'command', command: 'screenshot', path: path.join(SHOTS, 'preview-transparent.png') });
    await sleep(600);

    // Back to opaque, then prove the pause button freezes the child clock.
    await evalParent(`window.__spwFoliaSetTransparent(false); return 'ok';`);
    await sleep(900);
    record('buttons-before-pause', await evalParent(buttonScript));
    record('pause-click', await evalParent(clickPauseScript));
    await sleep(200);
    record('buttons-after-pause', await evalParent(buttonScript));
    await sleep(900);
    const pausedA = await evalParent(stageScript);
    const pausedB = await (async () => { await sleep(1400); return evalParent(stageScript); })();

    record('resume-click', await evalParent(clickPauseScript));
    await sleep(120);
    record('buttons-after-resume', await evalParent(buttonScript));
    record('resumed-immediate', await evalParent(stageScript));
    record('paused-a', pausedA);
    record('paused-b', pausedB);

    await sleep(1600);
    record('resumed', await evalParent(stageScript));

    // The font tab: the removed “预览文本” control must be gone, and the stage must keep previewing.
    await evalParent(fontTabScript);
    await sleep(1000);
    record('font-tab', await evalParent(fontTabScript));
    record('font-tab-stage', await evalParent(stageScript));
    send({ t: 'command', command: 'screenshot', path: path.join(SHOTS, 'preview-fonts.png') });
    await sleep(600);
} catch (error) {
    console.error('probe failed', error);
} finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(500);
}

// ------------------------------------------------------------------ verdicts
const byName = Object.fromEntries(results.map(r => [r.name, r.value]));
const live = byName['stage-live'];
const openStage = byName['stage-open'];
const transparent = byName['stage-transparent'];
const pausedA = byName['paused-a'];
const pausedB = byName['paused-b'];
const resumed = byName['resumed'];
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const summary = live && live.summary;
const summaryA = pausedA && pausedA.summary;
const summaryB = pausedB && pausedB.summary;
const summaryR = resumed && resumed.summary;

const checks = [
    ['overlay opened', !!openStage?.overlayOpen],
    ['live preview iframe mounted', !!openStage?.hasStage],
    ['iframe fired ready', openStage?.ready === 'true'],
    ['config delivered to iframe', !!summary?.receivedConfig],
    ['shim in live mode', summary?.live === true],
    ['real song is configured', typeof summary?.songTitle === 'string' && summary.songTitle.length > 0],
    ['real lyrics are in the config', !!live?.publishedConfig?.hasLyrics && (live?.publishedConfig?.lyricLines ?? 0) > 3],
    ['iframe config equals published config', summary?.songTitle === live?.publishedConfig?.song?.name],
    ['real clock forwarded (clockMs tracks host posMs)', (() => {
        const clock = num(summary?.clockMs);
        const pos = num(live?.hostState?.posMs);
        return clock != null && pos != null && Math.abs(clock - pos) < 1200;
    })()],
    ['iframe is rendering frames', (summary?.frames ?? 0) > 0 && (summary?.canvases ?? 0) > 0],
    ['transparent flag reaches the parent stage', /st-stage-transparent/.test(transparent?.wrapperClass ?? '')],
    ['transparent flag reaches the iframe config', transparent?.summary?.configTransparent === true],
    ['checkerboard chip explains the transparency', (transparent?.chip ?? '').length > 0],
    ['pause freezes the child clock', summaryA?.paused === true && summaryB?.paused === true
        && Math.abs((num(summaryB?.clockMs) ?? 0) - (num(summaryA?.clockMs) ?? Infinity)) < 60],
    ['resume restores a moving clock', summaryR?.paused === false && (num(summaryR?.frames) ?? 0) > (num(summaryB?.frames) ?? 0)],
    ['font tab opened without the 预览文本 option', byName['font-tab']?.found === true && byName['font-tab']?.hasPreviewText === false],
    ['stage keeps previewing after tab switch', byName['font-tab-stage']?.ready === 'true'
        && Number(byName['font-tab-stage']?.summary?.frames ?? 0) > Number(summaryR?.frames ?? 0)],
];

let failed = 0;
console.log('\n================ real-preview verdicts ================');
for (const [name, ok] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (errors.length) console.log('\npage errors:', errors.slice(0, 6));
if (stderr.length) console.log('\nhost stderr:', stderr.slice(0, 4));
console.log(failed === 0 ? '\nAll real-preview checks passed.' : `\n${failed} check(s) failed.`);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks: Object.fromEntries(checks), results, errors }, null, 2));
process.exit(failed === 0 ? 0 : 1);
