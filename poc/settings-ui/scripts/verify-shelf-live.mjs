// 歌词样式货架「实时」验收探针：在真实 WebView2 宿主里打开设置窗口，然后断言
//
//   1. 18 格（17 样式 + 随机）全部画出真实图片（[data-picture="image"]），不是 JPEG、不是破图；
//   2. 指针停在某一格 280ms 后，那一格开始跑（[data-picture="running"] 恰好 1 个，且就是指针
//      所在的那格），且它的舞台在 700ms 内确实在变（DOM 变化数 + 两次画布指纹）；
//   3. 选中的那格从不跑；4. 指针离开后 running 回到 0；5. 换一格再 hover 也能跑；
//   6. 全程没有页面错误，窗口其它部分（tab / 滑块 / 开关 / 大预览 iframe）不受影响；
//   7. 截一张货架图（--shot），供人工核对 18 格画面。
//
//   node scripts/verify-shelf-live.mjs [--duration 45000]
//
// Requires: poc/settings-ui/dist built (npx vite build), poc/webview/host/build/spw-folia-host.exe,
// poc/webview/dist/dist (Folia OBS bundle).
//
// 为什么这样取证：静止截图不能证明「会动」。动起来由页面内证明 —— 上游自己把舞台标成
// data-picture="running"（LivePicture.tsx），__SPW_SHELF_STATE__（model/ShelfLive.tsx）把它们与
// pictureTurns.runningPicture() 读出来，再对 running 舞台挂 MutationObserver 数变化、读两次 canvas
// 指纹比较。截图只核对画面内容。
//
// 两个坑：
// a) 宿主的 eval 只回传「返回值」；返回 Promise 会序列化成 {}，异步结果全丢。所以异步步骤由页面内
//    runner（shelf-probe-page.js）顺序执行，结果写进 window.__SHELF_RESULTS__，node 侧只做同步读取。
// b) 注入的覆盖层是 display:none 而不是卸载。必须用宿主的 open-settings 命令；只调
//    window.__SPW_FOLIA__.ui.openSettings() 页面状态会变而宿主侧 settingsOverlayOpen 仍是 false，
//    窗口留在 display:none 里，几何全 0。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const OUT = path.join(WEBVIEW_ROOT, 'host', 'out', 'shelf-live');
fs.mkdirSync(OUT, { recursive: true });

/** A line break, spelled out: this file is edited through tools that mangle backslash escapes. */
const NL = String.fromCharCode(10);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};
const durationMs = Number(opt('duration', 45000));
/** Pixel ratio for the run: 1 exercises the wide 7-column shelf, 1.8 the production narrow one. */
const forceDsf = opt('dsf', '1');
const shotPath = path.join(OUT, opt('shot', 'shelf-live.png'));

/** Page-side probe + runner: it is page JavaScript, kept in its own file. */
const PAGE = fs.readFileSync(path.join(__dirname, 'shelf-probe-page.js'), 'utf8');

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--windowed', '--width', '1600', '--height', '1000',
    // Folia's shelf switches to its 7-column wide layout at min-width:1024px. The production DSF
    // (1.8) shrinks the CSS viewport to 848x515, i.e. the narrow 4-column shelf, so a verification
    // run pins DSF 1 to exercise the wide one; `--dsf 1.8` (or `--dsf production`) runs the real
    // production pixel ratio instead, which exercises the narrow layout.
    ...(forceDsf ? ['--force-dsf', String(forceDsf)] : []),
    '--settings-dir', path.join(SETTINGS_ROOT, 'dist'),
    '--settings-entry', 'settings-ui.js',
    '--duration', String(durationMs),
    '--user-data', path.join(OUT, 'profile'),
    '--title', 'shelf live check',
    '--demo', '--no-topmost',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });

const results = [];
const errors = [];
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf(NL)) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.t === 'eval-result') {
                const value = normalise(String(msg.value));
                results.push(value);
                // 轮询标记：HOLD 表示 runner 已进入 motion-hold（某格正在跑），CHOSEN 表示选中的那格
                // 已经被 hover 过（它不跑，用来做「静止」对照）。
                if (value.includes('HOLD')) armMotionShots();
                if (value.includes('PAUSED')) armPausedShots();
                if (value.includes('CHOSEN')) armStillShots();
            }
            if (msg.t === 'log' && msg.level === 'error') errors.push(msg.msg);
        } catch { /* non-JSON host line */ }
    }
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', d => stderr.push(d));

/**
 * The host re-serialises what the page returned, so a string result arrives double-encoded
 * ("\"{\\"done\\":...}\"") and a bare number arrives as "42". One JSON.parse layer, when it
 * yields a string, is the page's own text; anything else is kept as it came.
 */
const normalise = raw => {
    try {
        const once = JSON.parse(raw);
        return typeof once === 'string' ? once : raw;
    } catch {
        return raw;
    }
};

const send = payload => child.stdin.write(JSON.stringify(payload) + NL);
const evalAt = (delay, script) => setTimeout(() => send({ t: 'command', command: 'eval', script }), delay);

// 页面错误钩子（和 host-eval.mjs 同一手法），装得越早越好。
evalAt(900, `(() => { window.__SPW_PROBE_ERRORS__ = []; window.addEventListener('error', e => window.__SPW_PROBE_ERRORS__.push(String(e.message) + ' @ ' + String(e.filename))); window.__SPW_PROBE_REJECTIONS__ = []; window.addEventListener('unhandledrejection', e => window.__SPW_PROBE_REJECTIONS__.push(String(e.reason))); return 'armed'; })()`);
// 探针先装，再让宿主打开窗口（宿主会向页面发 ui/open-settings）。runner 自己等窗口可见
// （页面内 start() 会反复调 ui.openSettings 直到 display 不是 none），所以这里不掐时间点。
evalAt(1400, PAGE);
setTimeout(() => send({ t: 'command', command: 'open-settings' }), 1600);
setTimeout(() => send({ t: 'command', command: 'eval', script: 'window.__SHELF_PROBE__.start()' }), 2800);

// 周期性同步读页面内结果（不受 Promise 序列化影响）。
const READ = 'JSON.stringify({done: !!(window.__SHELF_RESULTS__ && window.__SHELF_RESULTS__.some(r => r.name === "done")), rows: window.__SHELF_RESULTS__ || [], errors: window.__SPW_PROBE_ERRORS__ || [], rejections: window.__SPW_PROBE_REJECTIONS__ || []})';
for (const delay of [12000, 20000, 28000, 36000]) evalAt(delay, READ);
evalAt(durationMs - 9000, READ);

// 截图走宿主自己的 screenshot 命令（不是 eval 字符串）。
setTimeout(() => evalAt(0, `(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, clientY: 700, bubbles: true })); return 'shot-ready'; })()`), durationMs - 8400);
setTimeout(() => send({ t: 'command', command: 'screenshot', path: shotPath }), durationMs - 8000);

/**
 * 「它真的在动」的最终证据：页面内 runner 让某一格跑起来并保持 2.4s（motion-hold 窗口），
 * 这里在这个窗口里让宿主连拍两张整屏 PNG。node 侧把两张图裁到 running 那格的矩形上做像素差 ——
 * 同一条命令下 DOM 标了 running、画面上像素又确实变了，才算证明。
 */
const MOTION_SHOTS = [
    shotPath.replace(/\.png$/, '-motion-a.png'),
    shotPath.replace(/\.png$/, '-motion-b.png'),
];
/**
 * 动起来的那一格截图取证：runner 在 motion-hold 前后各记一行，这里等到 hold 开始后连拍两张。
 * 两次截图相隔 700ms；node 侧把两张图裁到 running 那格的矩形上做像素差（diffFrames）。
 */
const scheduleMotionShots = (startAt, gapMs) => {
    for (let i = 0; i < MOTION_SHOTS.length; i += 1) {
        setTimeout(() => send({ t: 'command', command: 'screenshot', path: MOTION_SHOTS[i] }), startAt + i * gapMs);
    }
};
/**
 * 等页面内 runner 真的进入 motion-hold 再拍，而不是掐绝对时间：造图阶段（data-picture="making"）
 * 自己也在动，掐时间拍到的会是正在造图的格子，不是被 hover 的那格。每 250ms 同步读一次结果行，
 * 看到 running-rect + motion-hold:'start' 就立刻连拍两张（hold 有 2.4s，够）。
 */
const holdState = { armed: false, shot: false };
const watchHold = setInterval(() => {
    send({
        t: 'command',
        command: 'eval',
        script: `(() => {
            const rows = window.__SHELF_RESULTS__ || [];
            const holding = rows.some(r => r.name === 'motion-hold' && r.value === 'start') && rows.some(r => r.name === 'running-rect');
            const paused = rows.some(r => r.name === 'paused-hold' && r.value === 'start') && rows.some(r => r.name === 'paused-rect');
            const chosenDone = rows.some(r => r.name === 'chosen-hover');
            return (holding ? 'HOLD ' : '') + (paused ? 'PAUSED ' : '') + (chosenDone ? 'CHOSEN' : '');
        })()`,
    });
}, 250);
const motionShotDelays = [0, 700];
const armMotionShots = () => {
    if (holdState.armed) return;
    holdState.armed = true;
    scheduleMotionShots(0, 0);
    setTimeout(() => send({ t: 'command', command: 'screenshot', path: MOTION_SHOTS[1] }), motionShotDelays[1]);
};
/**
 * 对照：**选中的**那格不跑，所以它的矩形在两次截图里应当一像素都不差。runner 在 chosen-hover
 * 之后留 800ms 空窗，这里等到那一行出现就连拍两张，用来证明「只有跑起来的那格在变」。
 */
const PAUSED_SHOTS = [
    shotPath.replace(/\.png$/, '-paused-a.png'),
    shotPath.replace(/\.png$/, '-paused-b.png'),
];
const pausedState = { armed: false };
const armPausedShots = () => {
    if (pausedState.armed) return;
    pausedState.armed = true;
    send({ t: 'command', command: 'screenshot', path: PAUSED_SHOTS[0] });
    setTimeout(() => send({ t: 'command', command: 'screenshot', path: PAUSED_SHOTS[1] }), 700);
};
const CONTROL_SHOTS = [
    shotPath.replace(/\.png$/, '-still-a.png'),
    shotPath.replace(/\.png$/, '-still-b.png'),
];
const stillState = { armed: false };
const armStillShots = () => {
    if (stillState.armed) return;
    stillState.armed = true;
    send({ t: 'command', command: 'screenshot', path: CONTROL_SHOTS[0] });
    setTimeout(() => send({ t: 'command', command: 'screenshot', path: CONTROL_SHOTS[1] }), 700);
};

setTimeout(() => child.stdin.write('{"type":"command","command":"close"}' + NL), durationMs - 2000);

/**
 * 把两张整屏 PNG 裁到 running 那格的矩形上，比较像素：返回差了多少像素、最大通道差、是否算「在动」。
 * 裁切用 running-rect（CSS px）乘 DSF 1（本脚本 --force-dsf 1），四边各留 2px 给取整误差。
 * 阈值：任一通道差 > 8 的像素占比超过 0.5% 即判为「画面变了」——静态 JPEG 在同一个矩形上应当
 * 差 0 像素（同一张图被同一路径渲染两次）。
 */
const diffFrames = (fileA, fileB, rect) => {
    const script = path.join(__dirname, 'shelf-frame-diff.py');
    // The rect is CSS px; the host screenshot is device px. Scale by the run's DSF before cropping.
    const scale = Number(forceDsf) || 1;
    const scaled = {
        left: rect.left * scale,
        top: rect.top * scale,
        width: rect.width * scale,
        height: rect.height * scale,
    };
    const result = spawnSync('python', [script, fileA, fileB, String(scaled.left), String(scaled.top), String(scaled.width), String(scaled.height)], { encoding: 'utf8' });
    if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || '').slice(-500) };
    try {
        return { ok: true, ...JSON.parse(result.stdout.trim()) };
    } catch (error) {
        return { ok: false, error: 'unparsable: ' + (result.stdout || '').slice(-200) };
    }
};

child.on('exit', (code, signal) => {
    console.log(`[verify-shelf-live] exit code=${code} signal=${signal}`);
    const reads = results.filter(line => line.startsWith('{"done"'));
    const last = reads.length ? JSON.parse(reads[reads.length - 1]) : null;
    if (!last) {
        console.log('--- raw eval results (no structured read landed) ---');
        for (const line of results) console.log(line.slice(0, 400));
    } else {
        console.log('--- shelf probe rows ---');
        for (const row of last.rows) console.log(`${row.name}: ${JSON.stringify(row.value)}`);
        console.log('--- page errors ---');
        console.log(JSON.stringify({ errors: last.errors, rejections: last.rejections }, null, 2));

        // 「画面上真的在动」：裁 running 那格，比两张截图；同时用**选中的那格**（不跑）做对照 ——
        // 它必须一像素不差，否则说明变的是整块区域（比如窗口在动）而不是那一格。
        clearInterval(watchHold);
        const rectRow = last.rows.find(row => row.name === 'running-rect');
        const rect = rectRow && rectRow.value;
        const chosenRectRow = last.rows.find(row => row.name === 'chosen-rect');
        const chosenRect = chosenRectRow && chosenRectRow.value;
        if (rect && fs.existsSync(MOTION_SHOTS[0]) && fs.existsSync(MOTION_SHOTS[1])) {
            last.motionDiff = diffFrames(MOTION_SHOTS[0], MOTION_SHOTS[1], rect);
            last.motionShots = MOTION_SHOTS;
        } else {
            last.motionDiff = { ok: false, error: 'screenshots missing' };
        }
        if (chosenRect && fs.existsSync(CONTROL_SHOTS[0]) && fs.existsSync(CONTROL_SHOTS[1])) {
            last.stillDiff = diffFrames(CONTROL_SHOTS[0], CONTROL_SHOTS[1], chosenRect);
            last.stillShots = CONTROL_SHOTS;
        } else {
            last.stillDiff = { ok: false, error: 'screenshots missing' };
        }
        // 暂停后的 hover：上游的时钟停了，所以这一格虽然 running，画面也不该变。
        const pausedRect = (last.rows.find(row => row.name === 'paused-rect') || {}).value;
        if (pausedRect && fs.existsSync(PAUSED_SHOTS[0]) && fs.existsSync(PAUSED_SHOTS[1])) {
            last.pausedDiff = diffFrames(PAUSED_SHOTS[0], PAUSED_SHOTS[1], pausedRect);
            last.pausedShots = PAUSED_SHOTS;
        } else {
            last.pausedDiff = { ok: false, error: 'screenshots missing' };
        }
        console.log('--- pixel diff: running / chosen(still) / paused ---');
        console.log(JSON.stringify({
            running: { rect, diff: last.motionDiff },
            still: { rect: chosenRect, diff: last.stillDiff },
            paused: { rect: pausedRect, diff: last.pausedDiff },
        }, null, 2));
        fs.writeFileSync(path.join(OUT, 'probe-rows.json'), JSON.stringify(last, null, 2));
    }
    console.log('--- host log errors ---');
    console.log(JSON.stringify(errors, null, 2));
    fs.writeFileSync(path.join(OUT, 'eval-results.txt'), results.join(NL + NL));
    fs.writeFileSync(path.join(OUT, 'page-errors.json'), JSON.stringify({ hostLogErrors: errors, stderr: stderr.join('') }, null, 2));
    console.log(`screenshot: ${shotPath}`);
    process.exitCode = errors.length > 0 ? 1 : 0;
});
