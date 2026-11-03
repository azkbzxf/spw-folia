#!/usr/bin/env node
// 真机基线：设置窗口里 17 格歌词样式小图的**加载行为**与耗时。
//
// 这是「预览小图缓存」改动的基线，也是之后判断「缓存是否真的生效」的唯一依据。量三件事：
//
//   1. 冷启第一次打开设置窗口：从宿主 open-settings 到 17 格全部变成 [data-picture="image"] 的耗时，
//      逐格时刻表，以及期间 data-picture="making" 的峰值并发（上游串行造图，峰值应当是 1）。
//   2. 同一个页面生命周期里关掉再打开：是直接就有图，还是又造一遍。
//   3. 重启宿主进程（**同一个 --user-data profile**）：是不是又完整重造一遍。
//
// 为什么是这个形状：图片的冻结结果存在 `pictureImages` 这个 **页面生命周期** 的 Map 里
// （work/folia/.../preview/pictureImages.ts），所以「关窗再开」命中它、「重启进程」不命中它。
// 缓存改动要改善的正是第 3 条；第 1、2 条是必须不能被它弄坏的对照。
//
// 用法：
//   node scripts/measure-preview-cache.mjs [--dsf 1|1.8] [--out <dir>] [--no-shot] [--keep-profile]
//
// 退出码：0 = 三轮都拿到数据；1 = 某一轮失败/超时或有页面错误；2 = 缺前置产物。
//
// 两个坑（照抄 verify-shelf-live.mjs 的注释）：
//   a) 宿主的 eval 只回传「返回值」，返回 Promise 会序列化丢光。所以计时全在页面内跑
//      （preview-cache-probe-page.js 的 setInterval 采样），node 侧只做同步读 report()。
//   b) 注入的覆盖层是 display:none 而不是卸载，必须用宿主的 open-settings / close-settings 命令
//      驱动，不能只调页面 API（那样宿主侧 settingsOverlayOpen 不变，窗口留在 display:none 里）。
//
// 纪律：同一时刻只跑一个宿主进程；每次 --user-data 用本脚本自己的目录；一轮跑完确认进程退出再起下一个。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const SETTINGS_DIST = path.join(SETTINGS_ROOT, 'dist');

const NL = String.fromCharCode(10);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};
const flag = name => argv.includes('--' + name);

/** 生产 DSF 是 1.8（窄 4 列）；1 是宽 7 列，17 格在 3 行内全部可见，基线跑它更稳定。 */
const rawDsf = opt('dsf', '1');
const forceDsf = rawDsf === 'production' ? 1.8 : Number(rawDsf);
const OUT_ROOT = path.resolve(SETTINGS_ROOT, opt('out', path.join(WEBVIEW_ROOT, 'host', 'out', 'preview-cache-baseline')));
const PROFILE = path.join(OUT_ROOT, 'profile');
const takeShot = !flag('no-shot');

for (const required of [EXE, BUNDLE, path.join(SETTINGS_DIST, 'settings-ui.js')]) {
    if (!fs.existsSync(required)) {
        console.error('FAIL 缺少真机产物: ' + required);
        process.exit(2);
    }
}
fs.mkdirSync(OUT_ROOT, { recursive: true });
// 基线必须是冷启：上一轮的 profile 会带着 pictureImages 之外的 WebView2 缓存与 IndexedDB，
// 让「第一次」不再第一次。除非显式 --keep-profile。
if (!flag('keep-profile')) fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const PAGE_PROBE = fs.readFileSync(path.join(__dirname, 'preview-cache-probe-page.js'), 'utf8');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 宿主的 value 是被再序列化过的：字符串要多剥一层，对象/数组也可能被套成字符串。 */
const unwrap = raw => {
    let value = raw;
    for (let depth = 0; depth < 4; depth += 1) {
        if (typeof value !== 'string') break;
        const text = value.trim();
        if (!text) break;
        const head = text.charAt(0);
        if (head !== '{' && head !== '[' && head !== '"') break;
        try {
            value = JSON.parse(text);
        } catch {
            break;
        }
    }
    return value;
};

/**
 * 一个宿主进程会话。eval 严格串行（发一条、等它的 eval-result 再发下一条），所以不用打标签：
 * 只有一条在飞，回来的那条就是它的。
 */
class Host {
    constructor({ label, profile }) {
        this.label = label;
        this.profile = profile;
        this.lines = [];
        this.hostErrors = [];
        this.pending = [];
        this.readyAt = null;
        this.buf = '';
        this.exited = null;
        this.exitCode = null;
        this.stderr = '';
        this.child = spawn(EXE, [
            '--bundle', BUNDLE,
            '--windowed', '--width', '1920', '--height', '1200',
            ...(forceDsf > 0 ? ['--force-dsf', String(forceDsf)] : []),
            '--settings-dir', SETTINGS_DIST,
            '--settings-entry', 'settings-ui.js',
            '--user-data', profile,
            '--title', 'preview cache baseline ' + label,
            // 合成样例时间轴：和 verify-shelf-live.mjs 跑通的那套配置一致。
            '--demo',
            '--no-topmost',
            // 开屏幕布只会给「第一次打开设置」加一段无关的启动噪声。
            '--no-curtain',
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });

        this.child.stdin.on('error', () => { /* 宿主先退出时的 EPIPE 是预期路径 */ });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', chunk => this.onData(chunk));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', chunk => { this.stderr += chunk; });
        this.exited = new Promise(resolve => {
            this.child.on('exit', code => {
                this.exitCode = code;
                for (const pending of this.pending.splice(0)) pending.resolve(null);
                resolve(code);
            });
        });
    }

    onData(chunk) {
        this.buf += chunk;
        let nl;
        while ((nl = this.buf.indexOf(NL)) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            this.lines.push(line);
            let msg = null;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.t === 'ready') this.readyAt = Date.now();
            else if (msg.t === 'eval-result') {
                const pending = this.pending.shift();
                if (pending) pending.resolve(unwrap(msg.value));
            } else if (msg.t === 'log' && msg.level === 'error') this.hostErrors.push(msg.msg);
        }
    }

    send(payload) {
        try {
            this.child.stdin.write(JSON.stringify(payload) + NL);
        } catch { /* 宿主已经不在了 */ }
    }

    /** 一条 eval 的往返；脚本抛错时宿主回 null。 */
    eval(script) {
        return new Promise(resolve => {
            this.pending.push({ resolve });
            this.send({ t: 'command', command: 'eval', script });
        });
    }

    async waitReady(timeoutMs = 30000) {
        const started = Date.now();
        while (!this.readyAt) {
            if (Date.now() - started > timeoutMs) throw new Error(this.label + ': 宿主 ' + timeoutMs + 'ms 内没有 ready');
            await sleep(50);
        }
        return Date.now() - started;
    }

    async close() {
        this.send({ t: 'command', command: 'close' });
        const graceful = await Promise.race([this.exited.then(() => true), sleep(6000).then(() => false)]);
        if (!graceful) {
            try {
                this.child.kill();
            } catch { /* 已经没了 */ }
            await Promise.race([this.exited, sleep(5000)]);
        }
        // 确保真的退了再让下一个进程用同一个 profile：WebView2 的一个 profile 不能被两个进程同时开。
        await Promise.race([this.exited, sleep(5000)]);
        fs.writeFileSync(path.join(OUT_ROOT, this.label + '-stdout.log'), this.lines.join(NL));
    }
}

/** 页面错误钩子（和 verify-shelf-live.mjs / host-eval.mjs 同一手法），装得越早越好。 */
const ERROR_HOOK = `(() => {
    window.__PC_ERRORS__ = [];
    window.__PC_REJECTIONS__ = [];
    window.addEventListener('error', event => window.__PC_ERRORS__.push(String(event.message) + ' @ ' + String(event.filename)));
    window.addEventListener('unhandledrejection', event => window.__PC_REJECTIONS__.push(String(event.reason)));
    return 'armed';
})()`;

/**
 * 跑一轮：arm 采样 → 打开设置 → 等 17 格全出图（或超时）→ 停表 → 读最终报告。
 * `armBefore` 为 false 时先打开窗口再 arm（重启场景要的是「打开就有图」，两者等价；
 * 统一 arm 在命令之前，t0 就是命令发出前一刻）。
 */
const runRound = async (host, label, { timeoutMs }) => {
    const armed = await host.eval(`window.__PC_PROBE__.arm(${JSON.stringify(label)})`);
    if (armed !== 'armed:' + label) {
        // 探针不在就是硬失败：不能把「没装上探针」当成「0 秒」。
        return { label, error: 'probe-not-installed', armedResult: armed };
    }
    host.send({ t: 'command', command: 'open-settings' });

    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        await sleep(200);
        const report = await host.eval('window.__PC_PROBE__.report()');
        if (!report || typeof report !== 'object') continue;
        last = report;
        if (report.done) break;
    }
    const finalReport = await host.eval('window.__PC_PROBE__.report()');
    await host.eval('window.__PC_PROBE__.stop()');
    const errors = await host.eval('JSON.stringify({ errors: window.__PC_ERRORS__ || [], rejections: window.__PC_REJECTIONS__ || [] })');
    return {
        label,
        report: finalReport || last,
        pageErrors: typeof errors === 'string' ? unwrap(errors) : errors,
        wallMs: Date.now() - started,
    };
};

/** 同一页面里关窗（等它真的关掉）再交给下一轮重新打开。 */
const closeSettings = async host => {
    host.send({ t: 'command', command: 'close-settings' });
    const started = Date.now();
    while (Date.now() - started < 6000) {
        await sleep(150);
        const open = await host.eval('window.__PC_PROBE__ ? window.__PC_PROBE__.overlayOpen() : null');
        if (open === false) return true;
    }
    return false;
};

const shot = async (host, name) => {
    if (!takeShot) return null;
    const target = path.join(OUT_ROOT, name);
    host.send({ t: 'command', command: 'screenshot', path: target });
    await sleep(1200);
    return fs.existsSync(target) ? target : null;
};

const ms = value => (value === null || value === undefined ? '—' : value.toFixed(1) + 'ms');
const pad = (text, width) => String(text).padEnd(width);

const printRound = round => {
    const r = round.report;
    if (!r) {
        console.log(`  ${round.label}: 无数据 (${round.error ?? 'unknown'})`);
        return;
    }
    console.log(`  轮次 ${round.label}（采样 ${r.samples} 次，墙钟 ${round.wallMs}ms）`);
    console.log(`    窗口可见 ${ms(r.tOpened)} | 货架挂载 ${ms(r.tShelf)} | 18 格齐 ${ms(r.tTiles)}`);
    console.log(`    第一个 stage ${ms(r.tFirstPicture)} | 第一格出图 ${ms(r.tFirstImage)} | 17 格全部出图 ${ms(r.tAllImages)}`);
    console.log(`    当前 images=${r.images}/${r.styleTiles} pictures=${r.pictures} making=${r.making} running=${r.running}`
        + ` | 峰值 making=${r.peakMaking} pictures=${r.peakPictures}`);
    console.log(`    本轮新加载渲染器 chunk ${r.chunks.count} 个 / ${r.chunks.bytes === null ? '体积未知' : (r.chunks.bytes / 1024).toFixed(0) + 'KB'}`
        + ` | 长任务 ${r.longTasks.count} 次，最长 ${r.longTasks.maxMs}ms，阻塞累计 ${r.longTasks.blockingMs}ms`);
    if (r.indexedDb) console.log('    IndexedDB: ' + describeIndexedDb(r.indexedDb));
    if (round.pageErrors && ((round.pageErrors.errors || []).length || (round.pageErrors.rejections || []).length)) {
        console.log('    页面错误: ' + JSON.stringify(round.pageErrors));
    }
};

/** IndexedDB 现状一行话：基线应当是「没有库」；缓存落地后应当列出库/store/记录数。 */
const describeIndexedDb = value => {
    if (!value.supported) return '不支持（' + (value.error ?? '?') + '）';
    if (value.databases === null) return '读取中/失败（' + (value.error ?? 'not-yet') + '）';
    if (value.databases.length === 0) return '没有任何库';
    return value.databases
        .map(database => (database.error
            ? `${database.name} (${database.error})`
            : `${database.name} v${database.version} {${(database.stores || []).map(store => store + '=' + (database.counts[store] ?? '?')).join(', ')}}`))
        .join(' | ');
};

const printTiles = round => {
    const r = round.report;
    if (!r || !r.perTile) return;
    console.log(`  ${pad('轮次', 16)}${pad('格', 14)}${pad('首个 stage', 14)}${pad('首次 making', 14)}${pad('首次出图', 14)}造过图? canvas`);
    for (const tile of r.perTile) {
        console.log(`  ${pad(round.label, 16)}${pad(tile.value, 14)}${pad(ms(tile.firstPictureMs), 14)}`
            + `${pad(ms(tile.firstMakingMs), 14)}${pad(ms(tile.firstImageMs), 14)}`
            + `${pad(tile.stageBeforeImage ? '是' : '否', 7)} ${tile.canvas ? 'y' : 'n'}`);
    }
};

const main = async () => {
    const rounds = [];
    const hosts = [];
    let failure = null;

    // ---- 第 1、2 轮：同一个进程内，冷启打开 / 关窗再打开
    const first = new Host({ label: 'run1-cold', profile: PROFILE });
    hosts.push(first);
    try {
        const readyMs = await first.waitReady();
        // 设置岛在导航之后才挂载；这段等待让「冷启」量的是打开设置，不是等页面。
        await sleep(2600);
        await first.eval(ERROR_HOOK);
        const installed = await first.eval(PAGE_PROBE);
        if (installed !== 'preview-cache-probe-installed') {
            throw new Error('页面内探针没装上: ' + JSON.stringify(installed));
        }
        const cold = await runRound(first, 'cold-open', { timeoutMs: 90000 });
        cold.readyMs = readyMs;
        cold.shot = await shot(first, 'cold-open.png');
        rounds.push(cold);

        // 关窗：等覆盖层真的 display:none（shelf 随之卸载）再重开。
        const closed = await closeSettings(first);
        if (!closed) console.log('  ! 关窗在 6s 内没有反映成 overlayOpen=false，仍继续（重开仍会带上该状态）');
        await sleep(600);
        const reopen = await runRound(first, 'warm-reopen', { timeoutMs: 45000 });
        reopen.closedCleanly = closed;
        reopen.shot = await shot(first, 'warm-reopen.png');
        rounds.push(reopen);
    } catch (error) {
        failure = String(error && error.stack ? error.stack : error);
    }
    await first.close();

    // ---- 第 3 轮：新进程、同一个 profile
    if (!failure) {
        await sleep(1200);
        const second = new Host({ label: 'run2-restart', profile: PROFILE });
        hosts.push(second);
        try {
            const readyMs = await second.waitReady();
            await sleep(2600);
            await second.eval(ERROR_HOOK);
            const installed = await second.eval(PAGE_PROBE);
            if (installed !== 'preview-cache-probe-installed') {
                throw new Error('重启后页面内探针没装上: ' + JSON.stringify(installed));
            }
            const restart = await runRound(second, 'restart-open', { timeoutMs: 90000 });
            restart.readyMs = readyMs;
            restart.shot = await shot(second, 'restart-open.png');
            rounds.push(restart);
        } catch (error) {
            failure = String(error && error.stack ? error.stack : error);
        }
        await second.close();
    }

    // ---- 汇总
    const byLabel = label => (rounds.find(round => round.label === label) || {}).report || null;
    const cold = byLabel('cold-open');
    const warm = byLabel('warm-reopen');
    const restart = byLabel('restart-open');

    const summary = {
        measuredAt: new Date().toISOString(),
        exe: EXE,
        bundle: BUNDLE,
        settings: SETTINGS_DIST,
        forceDsf,
        profile: PROFILE,
        coldOpen: cold,
        warmReopen: warm,
        restartOpen: restart,
        verdict: {
            /** 冷启要现场造 17 张图：出现 making 且逐格有首个 stage */
            coldMakesPictures: Boolean(cold && cold.peakMaking > 0),
            coldAllImagesMs: cold ? cold.tAllImages : null,
            coldLongTaskBlockingMs: cold ? cold.longTasks.blockingMs : null,
            /** 同页重开是否直接有图（不再造） */
            warmReusesPageCache: Boolean(warm && warm.tAllImages !== null && warm.peakMaking === 0),
            warmAllImagesMs: warm ? warm.tAllImages : null,
            /** 重启进程后是否又完整重造一遍（这就是缓存改动要改善的那一格） */
            restartRemakesEverything: Boolean(restart && restart.tAllImages !== null && restart.peakMaking > 0),
            restartAllImagesMs: restart ? restart.tAllImages : null,
            restartLongTaskBlockingMs: restart ? restart.longTasks.blockingMs : null,
            /** 基线里页面是否已经有预览缓存的 IndexedDB 库（应当没有） */
            baselineIndexedDb: cold ? describeIndexedDb(cold.indexedDb || { supported: false }) : null,
        },
        rounds,
        failure,
    };

    // 失败的那次**不许**覆盖已经测好的基线：坏产物/坏探针跑一轮会把 measure.json 冲成一份
    // 只有 failure 的空壳，下一个人就看不出基线是多少了。失败的落 measure-failed.json。
    const outputName = failure ? 'measure-failed.json' : 'measure.json';
    fs.writeFileSync(path.join(OUT_ROOT, outputName), JSON.stringify(summary, null, 2));

    console.log('');
    console.log('=== 基线：设置窗口 17 格样式小图的加载行为 ===');
    console.log('宿主 ' + EXE);
    console.log('DSF ' + forceDsf + ' | profile ' + PROFILE);
    console.log('');
    for (const round of rounds) printRound(round);
    console.log('');
    console.log('=== 逐格时刻表（相对本轮 open-settings 命令发出前一刻的 t0）===');
    for (const round of rounds) printTiles(round);
    console.log('');
    console.log('=== 结论 ===');
    console.log('  IndexedDB（基线的缓存现状）: ' + summary.verdict.baselineIndexedDb);
    console.log('  首次打开（冷启）到 17 格全部出图: ' + ms(summary.verdict.coldAllImagesMs)
        + '（峰值同时造图 ' + (cold ? cold.peakMaking : '—') + ' 格，长任务阻塞累计 ' + ms(summary.verdict.coldLongTaskBlockingMs) + '）');
    console.log('  同页关掉再打开: ' + ms(summary.verdict.warmAllImagesMs)
        + '，是否又造图: ' + (warm ? (warm.peakMaking > 0 ? '是（peakMaking=' + warm.peakMaking + '）' : '否（making 全程为 0）') : '—'));
    console.log('  重启进程后: ' + ms(summary.verdict.restartAllImagesMs)
        + '，是否又完整重造: ' + (restart ? (restart.peakMaking > 0 ? '是（peakMaking=' + restart.peakMaking + '）' : '否（making 全程为 0）') : '—'));
    console.log('');
    console.log('报告: ' + path.join(OUT_ROOT, outputName));

    const hostErrors = hosts.flatMap(host => host.hostErrors.map(message => host.label + ': ' + message));
    const pageErrors = rounds.flatMap(round => {
        const errors = round.pageErrors || {};
        return [
            ...((errors.errors || []).map(message => round.label + ': error: ' + message)),
            ...((errors.rejections || []).map(message => round.label + ': rejection: ' + message)),
        ];
    });
    if (hostErrors.length || pageErrors.length) {
        console.log('');
        console.log('=== 错误 ===');
        for (const line of hostErrors.concat(pageErrors)) console.log('  ' + line);
    }

    // 断言禁止恒真：三轮都必须真的拿到「17 格全部出图」的时刻，否则这次测量没有意义。
    const incomplete = rounds.filter(round => !round.report || !round.report.done).map(round => round.label);
    if (failure) {
        console.log('\nFAIL ' + failure);
        process.exit(1);
    }
    if (incomplete.length) {
        console.log('\nFAIL 这些轮次没有等到 17 格全部出图: ' + incomplete.join(', '));
        process.exit(1);
    }
    if (hostErrors.length || pageErrors.length) {
        console.log('\nFAIL 有宿主/页面错误');
        process.exit(1);
    }
    console.log('\nPASS 三轮都拿到了完整数据');
    process.exit(0);
};

main().catch(error => {
    console.error('FAIL ' + String(error && error.stack ? error.stack : error));
    process.exit(1);
});
