#!/usr/bin/env node
// v0.4.16 验收：设置窗口「歌词样式预览动画」开关 + 预览小图持久缓存。
//
// 全部断言都跑在**真机 WebView2 宿主**里（不是 jsdom、不是 vite preview），驱动方式照抄
// verify-shelf-live.mjs / verify-playback-bar-switch.mjs：spawn 宿主、stdin 走 JSON 行协议、
// 页面内探针把异步结果写进 window 再同步读回（宿主的 eval 只回传返回值，返回 Promise 会丢）。
//
// 五组断言：
//   A. 默认（设置树不含 previewAnimation → 默认开）：货架是 live，17 格全部出图，pending 归零。
//   B. previewAnimation:false：货架是 static，一格渲染器都不挂，hover 也挂不上，
//      **打开设置不新增任何样式渲染器 chunk**（比 DOM 断言更硬的证据），窗口其余部分不受影响。
//   C. 跨进程缓存（核心）：同一个 --user-data profile 连跑两次进程。第一次造完图并写进
//      IndexedDB（库 spw-folia-preview / store pictures ≥ 17 条）；第二次启动 peakMaking === 0、
//      新增渲染器 chunk === 0、cached ≥ 17。**秒数只记录不断言**。
//   D. 热切换：运行中把 previewAnimation 改 false，500ms 内货架转 static；改回 true 又出图。
//   E. 回归：同页关掉再开设置窗口，peakMaking 仍为 0（页内 pictureImages Map 的老行为不许退化）。
//
// 为什么用这些判据而不是「秒数变小」：秒数会随机器负载漂，拿它当断言就是恒真式 ——
// 一台更快的机器即使完全没实现缓存也能「通过」。见 docs/postmortem-v0.4.13.md 的教训。
// 这里断言的都是**因果性事实**：有没有造图（peakMaking）、有没有加载渲染器（chunk delta）、
// 缓存里有没有记录（IndexedDB）。秒数只写进报告供人看。
//
// 反恒真：A 组额外断言「开关开时打开设置确实新增渲染器 chunk > 0」。
// 没有这条，B 组的「新增 0 个」可能是因为页面根本不按需加载渲染器而白过。
//
// Usage: node packaging/tools/verify-preview-animation-switch.mjs [--keep-profile] [--no-shot]
// Exit: 0 = PASS, 1 = FAIL, 2 = 缺真机产物（先跑构建）。
//
// 跑的是 poc/ 下的**开发产物**（poc/settings-ui/dist + poc/webview/host/build + poc/webview/dist/dist），
// 因为开关与缓存的实现就落在那里；packaging/ 里的副本要等 build-package.sh 重新打包才带上它。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'packaging', 'out', 'preview-animation-switch');
mkdirSync(OUT, { recursive: true });

const exe = join(ROOT, 'poc', 'webview', 'host', 'build', 'spw-folia-host.exe');
const bundle = join(ROOT, 'poc', 'webview', 'dist', 'dist');
const settingsDir = join(ROOT, 'poc', 'settings-ui', 'dist');
const settingsBundle = join(settingsDir, 'settings-ui.js');
const baseSettingsPath = join(ROOT, 'packaging', 'testdata', 'default-settings.json');

for (const required of [exe, settingsBundle, join(bundle, 'index.html'), baseSettingsPath]) {
    if (!existsSync(required)) {
        console.error('FAIL  missing real-host artifact: ' + required + '\nrebuild it first (poc/settings-ui: npx vite build; poc/webview/host: bash build.sh)');
        process.exit(2);
    }
}

const argv = process.argv.slice(2);
const flag = name => argv.includes('--' + name);
const takeShots = !flag('no-shot');

const baseSettings = JSON.parse(readFileSync(baseSettingsPath, 'utf8'));
if (typeof baseSettings.smartBeat === 'boolean') baseSettings.smartBeat = { enabled: baseSettings.smartBeat, effects: {} };

const NL = String.fromCharCode(10);
const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * 页内探针。它不是 node 模块，是被 eval 进页面的字符串，所以：不用模板字面量、不用反引号、
 * 不用 `${}`（它本身就在一个模板字符串里）。装一次，之后所有查询都同步返回。
 *
 * 两条取证通道同时开着，互相独立：
 *   ① DOM（[data-picture] 计数、[data-spw-shelf-mode]、格内 <img>/<canvas>）—— 不依赖页面探针；
 *   ② __SPW_SHELF_STATE__() 的 animated/cached/pending —— 页面向宿主承诺的状态。
 * 断言两边都要对，任一边撒谎都会 FAIL。
 */
const PAGE_PROBE = `
(() => {
    // 采样定时器的把手。挂在 window 上而不是闭包里：探针可能被装上两次（重开窗口不会重装，
    // 但保险起见还是共用同一个把手），重复装不能留下两个互相打架的 interval。
    var made = window.__PA_MADE__ || (window.__PA_MADE__ = { timer: null });

    window.__PA_PROBE__ = {
        state: function () {
            try { return typeof window.__SPW_SHELF_STATE__ === 'function' ? window.__SPW_SHELF_STATE__() : null; }
            catch (e) { return { error: String(e) }; }
        },
        overlay: function () {
            var node = document.querySelector('[data-spw-settings-ui]');
            if (!node) return { present: false, open: null, display: null };
            return { present: true, open: node.dataset.open || null, display: getComputedStyle(node).display };
        },
        dom: function () {
            var root = document.querySelector('[data-spw-shelf]');
            if (!root) return { shelf: false };
            var tiles = root.querySelectorAll('[data-value]');
            var values = [];
            var withImage = 0;
            var withCanvas = 0;
            for (var i = 0; i < tiles.length; i += 1) {
                values.push(tiles[i].dataset.value || '?');
                if (tiles[i].querySelector('img')) withImage += 1;
                if (tiles[i].querySelector('canvas')) withCanvas += 1;
            }
            return {
                shelf: true,
                mode: root.getAttribute('data-spw-shelf-mode'),
                tiles: tiles.length,
                pictures: root.querySelectorAll('[data-picture]').length,
                images: root.querySelectorAll('[data-picture="image"]').length,
                making: root.querySelectorAll('[data-picture="making"]').length,
                running: root.querySelectorAll('[data-picture="running"]').length,
                tileImages: withImage,
                tileCanvases: withCanvas,
                values: values
            };
        },
        /** 大预览是否有一个真的画面：iframe（LivePreview）或回退的静态 Ken Burns（StylePreview）。
         *  两者都是健康状态 —— LivePreview 的 ready 超时会退回静态图，那不是坏掉。 */
        bigPreview: function () {
            var pause = document.querySelector('[data-spw-settings-ui] button[aria-label*="暂停"], [data-spw-settings-ui] button[aria-label*="pause"], [data-spw-settings-ui] button[aria-label*="播放"], [data-spw-settings-ui] button[aria-label*="play"]');
            return {
                pauseButton: !!pause,
                iframe: document.querySelectorAll('iframe').length,
                stylePreview: document.querySelectorAll('[class*="spw-preview"]').length
            };
        },
        chrome: function () {
            return {
                windows: document.querySelectorAll('.st-window').length,
                tabs: document.querySelectorAll('[role="tab"]').length,
                sliders: document.querySelectorAll('input[type="range"]').length,
                switches: document.querySelectorAll('[role="switch"]').length,
                iframes: document.querySelectorAll('iframe').length,
                brokenImages: Array.prototype.filter.call(document.querySelectorAll('[data-spw-shelf] img'), function (img) { return img.naturalWidth === 0; }).length
            };
        },
        tileOf: function (value) {
            return document.querySelector('[data-spw-shelf] [data-value="' + value + '"]');
        },
        hover: function (value) {
            var tile = document.querySelector('[data-spw-shelf] [data-value="' + value + '"]');
            if (!tile) return 'no-tile:' + value;
            tile.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
            return 'hovered:' + value;
        },
        leaveGrid: function () {
            var grid = document.querySelector('[data-spw-shelf] [role="radiogroup"]');
            if (!grid) return 'no-grid';
            grid.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerId: 1, pointerType: 'mouse' }));
            return 'left';
        },
        /**
         * resource entries 里匹配 /Visualizer|ShelfLiveView/ 的脚本。这是「有没有加载动画/渲染器」
         * 的**核心证据**（shelf-cache 用无头 Edge 量过：previewAnimation=false 时 0 条，开时 6 条）。
         * DOM 上的格子数只是辅证 —— 它证明不了「渲染了但没显示」这种情形。
         *
         * 注意这里把两类分开算，别混：
         *   · 'renderers'（Visualizer*）：真正的样式渲染器，**只有 live 且真要造图时才拉**。
         *   · 'shelfShell'（ShelfLiveView*）：实时货架自己的 lazy shell。开关开时**一定会**拉
         *     （它里面就是 PictureGrid + 上游 preview 机器），开关关时一条都不该有。
         * 「关掉动画 = 0 条」说的是**两者合计**为 0；「重启进程命中缓存」说的是 **renderers 增量为 0**
         * （shell 还得加载，否则货架根本不存在）。
         */
        renderers: function () {
            var out = { renderers: [], shelfShell: [], both: [] };
            var entries = performance.getEntriesByType('resource') || [];
            for (var i = 0; i < entries.length; i += 1) {
                var name = entries[i].name || '';
                if (!/\\.js(\\?|$)/.test(name)) continue;
                var file = name.slice(name.lastIndexOf('/') + 1).split('?')[0];
                var isRenderer = /Visualizer/.test(file);
                var isShell = /ShelfLiveView/.test(file);
                if (!isRenderer && !isShell) continue;
                if (isRenderer) out.renderers.push(file);
                if (isShell) out.shelfShell.push(file);
                out.both.push(file);
            }
            out.renderers.sort();
            out.shelfShell.sort();
            out.both.sort();
            return out;
        },
        /** 打开设置**之前**的渲染器集合；之后用 renderersSince() 求差集。 */
        markRenderers: function () {
            window.__PA_RENDERERS_BEFORE__ = window.__PA_PROBE__.renderers();
            return window.__PA_RENDERERS_BEFORE__.both.length;
        },
        renderersSince: function () {
            var before = window.__PA_RENDERERS_BEFORE__ || { renderers: [], shelfShell: [], both: [] };
            var now = window.__PA_PROBE__.renderers();
            var diff = function (kind) {
                var was = before[kind] || [];
                var added = now[kind].filter(function (name) { return was.indexOf(name) < 0; });
                return { before: was.length, now: now[kind].length, added: added, addedCount: added.length };
            };
            // 'both' 是两者合计：「关掉动画」要说的是它一条都没有。
            var both = diff('both');
            return { both: both, renderers: diff('renderers'), shelfShell: diff('shelfShell'), addedCount: both.addedCount, added: both.added };
        },
        errors: function () {
            return {
                errors: (window.__PA_ERRORS__ || []).slice(),
                rejections: (window.__PA_REJECTIONS__ || []).slice()
            };
        },
        /**
         * 磁盘缓存现状。**先看 databases() 再决定要不要 open**：不带版本号的 open() 会把不存在的
         * 库创建出来，那就成了「探针自己造出了一个缓存库」的假证据。
         *
         * 每次调用都重新查一遍（startedAt 递增）：缓存是异步写的，装探针那一刻的快照之后还会变。
         * node 侧不能 await Promise（宿主 eval 会丢），所以用「发起 + 轮询 startedAt 变了没」。
         */
        idbSurvey: function () {
            var report = { supported: typeof indexedDB !== 'undefined' && !!indexedDB, exists: false, records: null, databases: [], error: null, startedAt: performance.now(), done: false };
            if (!report.supported) { report.error = 'no-indexeddb'; report.done = true; window.__PA_IDB__ = report; return report; }
            window.__PA_IDB__ = report;
            var finish = function () { report.done = true; return report; };
            var list = (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
            list.then(function (infos) {
                report.databases = (infos || []).map(function (info) { return info.name; }).filter(Boolean);
                if (report.databases.indexOf('spw-folia-preview') < 0) { report.records = 0; finish(); return; }
                report.exists = true;
                var request = indexedDB.open('spw-folia-preview');
                request.onerror = function () { report.error = 'open-failed'; finish(); };
                request.onblocked = function () { report.error = 'blocked'; finish(); };
                request.onsuccess = function () {
                    var db = request.result;
                    try {
                        var countRequest = db.transaction('pictures', 'readonly').objectStore('pictures').count();
                        countRequest.onsuccess = function () { report.records = countRequest.result; db.close(); finish(); };
                        countRequest.onerror = function () { report.error = 'count-failed'; db.close(); finish(); };
                    } catch (e) { report.error = String(e); db.close(); finish(); }
                };
            }).catch(function (e) { report.error = String(e); finish(); });
            return report.startedAt;
        },
        idb: function () { return window.__PA_IDB__ || null; },
        /**
         * 缓存恢复出来的静态图里还剩多少个 CSS/WAAPI 动画。
         *
         * 这是「静态图是真静态」的直接证据：freezeStage 只冻结**当时画出来的样子**，漏掉了
         * 「冻结时不在 running 列表里」的 CSS 动画（cappella 有几十个 char-fade），挂回新页面
         * 会从头重播。落盘前必须全部剥掉，恢复后动画数应当是 0。
         * 用 getAnimations({subtree:true}) 数，而不是看有没有 <canvas>：元素型的样式也能有动画。
         */
        animations: function () {
            var root = document.querySelector('[data-spw-shelf]');
            if (!root) return { shelf: false, total: 0, perTile: {} };
            var total = 0;
            var perTile = {};
            for (var tile of root.querySelectorAll('[data-value]')) {
                var value = tile.dataset.value || '?';
                var count = 0;
                try {
                    if (typeof tile.getAnimations === 'function') count = tile.getAnimations({ subtree: true }).length;
                } catch (e) { count = -1; }
                perTile[value] = count;
                if (count > 0) total += count;
            }
            return { shelf: true, total: total, perTile: perTile };
        },
        /** 16ms 采样：peakMaking 是「这一轮到底有没有造图」的硬指标，轮询 DOM 会漏掉短脉冲。 */
        arm: function (label) {
            var self = { label: label, t0: performance.now(), samples: 0, peakMaking: 0, peakPictures: 0, peakRunning: 0,
                tFirstImage: null, tAllImages: null, makingSeen: 0 };
            window.__PA_ROUND__ = self;
            if (made.timer) clearInterval(made.timer);
            var tick = function () {
                var dom = window.__PA_PROBE__.dom();
                if (!dom.shelf) return;
                var t = performance.now() - self.t0;
                self.samples += 1;
                if (dom.making > self.peakMaking) self.peakMaking = dom.making;
                if (dom.making > 0 && self.makingSeen === 0) self.makingSeen = t;
                if (dom.pictures > self.peakPictures) self.peakPictures = dom.pictures;
                if (dom.running > self.peakRunning) self.peakRunning = dom.running;
                var painted = dom.images + dom.tileImages;
                if (painted > 0 && self.tFirstImage === null) self.tFirstImage = t;
                if (dom.tiles >= 18 && painted >= 17 && dom.making === 0 && self.tAllImages === null) self.tAllImages = t;
            };
            made.timer = setInterval(tick, 16);
            tick();
            return 'armed:' + label;
        },
        stop: function () {
            if (made.timer) { clearInterval(made.timer); made.timer = null; }
            return 'stopped';
        },
        round: function () { return window.__PA_ROUND__ || null; }
    };

    // 页面错误钩子：一个 uncaught error / 未处理的 rejection 都不许吞掉。
    window.__PA_ERRORS__ = window.__PA_ERRORS__ || [];
    window.__PA_REJECTIONS__ = window.__PA_REJECTIONS__ || [];
    window.addEventListener('error', function (event) {
        window.__PA_ERRORS__.push(String(event.message) + ' @ ' + String(event.filename));
    });
    window.addEventListener('unhandledrejection', function (event) {
        window.__PA_REJECTIONS__.push(String(event.reason));
    });
    window.__PA_PROBE__.idbSurvey();
    return 'pa-probe-installed';
})()`;

/**
 * 宿主把 value 再序列化一层：字符串要多剥，对象/数组也可能被套成字符串。
 *
 * 还有一个坑：`ExecuteScriptAsync` 对 JS 的 `true` 回的是**字符串** "true"（JSON 字面量），
 * 不是布尔。所以 `=== true` / `=== false` 的断言拿到的是字符串，会莫名其妙地 FAIL。
 * 这里把裸字面量（true/false/null/数字）也归一成 JS 值，否则 A1 这类布尔断言永远对不上。
 */
const unwrap = raw => {
    let value = raw;
    for (let depth = 0; depth < 4; depth += 1) {
        if (typeof value !== 'string') break;
        const text = value.trim();
        if (!text) break;
        const head = text.charAt(0);
        const literal = text === 'true' || text === 'false' || text === 'null' || /^-?\d+(\.\d+)?$/.test(text);
        if (head !== '{' && head !== '[' && head !== '"' && !literal) break;
        try {
            value = JSON.parse(text);
        } catch {
            break;
        }
    }
    return value;
};

/** 一个宿主会话。eval 严格串行（发一条等一条），所以回来的结果必然属于刚发的那条。 */
class Host {
    constructor({ label, profile }) {
        this.label = label;
        this.lines = [];
        this.hostErrors = [];
        this.pending = [];
        this.readyAt = null;
        this.buf = '';
        this.stderr = '';
        this.child = spawn(exe, [
            '--bundle', bundle,
            '--windowed', '--width', '1920', '--height', '1200',
            '--force-dsf', '1',
            '--settings-dir', settingsDir,
            '--settings-entry', 'settings-ui.js',
            '--user-data', profile,
            '--title', 'preview animation switch ' + label,
            '--demo',
            '--no-topmost',
            '--no-curtain',
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
        this.exited = new Promise(done => this.child.on('exit', code => {
            this.exitCode = code;
            for (const waiter of this.pending.splice(0)) waiter(null);
            done(code);
        }));
        this.child.stdin.on('error', () => { /* 宿主先退出时的 EPIPE 是预期路径 */ });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', chunk => this.onData(chunk));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', chunk => { this.stderr += chunk; });
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
                const waiter = this.pending.shift();
                if (waiter) waiter(unwrap(msg.value));
            } else if (msg.t === 'log' && msg.level === 'error') this.hostErrors.push(msg.msg);
        }
    }

    send(payload) {
        try {
            this.child.stdin.write(JSON.stringify(payload) + NL);
        } catch { /* 进程没了 */ }
    }

    eval(script) {
        return new Promise(done => {
            this.pending.push(done);
            this.send({ t: 'command', command: 'eval', script });
        });
    }

    async waitReady(timeoutMs = 30000) {
        const started = Date.now();
        while (!this.readyAt) {
            if (Date.now() - started > timeoutMs) throw new Error(this.label + ': host did not send ready within ' + timeoutMs + 'ms');
            await sleep(50);
        }
    }

    async close() {
        this.send({ t: 'command', command: 'close' });
        const graceful = await Promise.race([this.exited.then(() => true), sleep(6000).then(() => false)]);
        if (!graceful) {
            try { this.child.kill(); } catch { /* gone */ }
        }
        // 必须等进程真的退了：同一个 --user-data profile 不能被两个 WebView2 进程同时打开。
        await Promise.race([this.exited, sleep(6000)]);
        writeFileSync(join(OUT, this.label + '-stdout.log'), this.lines.join(NL));
    }
}

const checks = [];
const record = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
    return Boolean(ok);
};

const shot = async (host, name) => {
    if (!takeShots) return null;
    const target = join(OUT, name);
    host.send({ t: 'command', command: 'screenshot', path: target });
    await sleep(1200);
    return existsSync(target) ? target : null;
};

/**
 * 起一个会话、装探针、推设置树，然后交给 `body`。
 * 探针装不上是**硬失败**：以前踩过的坑是「断言对着 undefined 求值，全绿」。
 */
const session = async ({ label, profile, settings, body, freshProfile = false }) => {
    if (freshProfile) rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true });
    const host = new Host({ label, profile });
    const result = { label, settingsSent: settings, startedAt: new Date().toISOString() };
    try {
        await host.waitReady();
        // 设置岛在导航之后才挂载；页面先跑一会儿，探针才装得上。
        await sleep(2400);
        host.send({ t: 'settings', settings });
        await sleep(1600);
        const installed = await host.eval(PAGE_PROBE);
        if (installed !== 'pa-probe-installed') {
            throw new Error(label + ': page probe did not install (' + JSON.stringify(installed) + ') —— 不能当成「没有数据所以通过」');
        }
        result.body = await body(host);
    } finally {
        result.hostErrors = host.hostErrors;
        result.stderr = host.stderr.slice(-2000);
        await host.close();
    }
    return result;
};

/** 打开设置窗口：**必须走宿主的 open-settings 命令**（覆盖层是 display:none，不是卸载）。 */
const openSettings = async host => {
    host.send({ t: 'command', command: 'open-settings' });
};

/** 等到货架出现、并且 `ready(check)` 成立；超时返回最后一次观察到的东西（不假装成功）。 */
const waitFor = async (host, label, check, timeoutMs) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        const snapshot = await host.eval(`JSON.stringify({ dom: window.__PA_PROBE__.dom(), state: window.__PA_PROBE__.state(), round: window.__PA_PROBE__.round(), overlay: window.__PA_PROBE__.overlay() })`);
        last = typeof snapshot === 'string' ? unwrap(snapshot) : snapshot;
        try {
            if (last && check(last)) return { ok: true, waitedMs: Date.now() - started, last };
        } catch { /* 半截图（state 还没就绪）继续等 */ }
        await sleep(150);
    }
    return { ok: false, waitedMs: Date.now() - started, last, timeoutMs, label };
};

const stateOf = snapshot => (snapshot && snapshot.state) || null;
const domOf = snapshot => (snapshot && snapshot.dom) || {};

/**
 * 重新查一次 IndexedDB 并等它回来。缓存是**异步**写的（造完图才落盘，落盘还有事务），
 * 装探针那一刻的 `idb` 快照可能还看不见库。这里发起一次新查询、轮询 startedAt 变化，
 * 直到 done 或超时；超时就把最后一次观察原样交回（不假装成功）。
 */
const surveyIdb = async (host, timeoutMs = 8000) => {
    const started = await host.eval('window.__PA_PROBE__.idbSurvey()');
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        await sleep(200);
        last = await host.eval('window.__PA_PROBE__.idb()');
        if (last && last.done === true && last.startedAt === started) return last;
    }
    return last;
};

/**
 * 等到 `pictures` 的记录数达到 `want`（或超时）。
 *
 * 为什么要专门等：写盘是逐格异步的，A 组「17 格出图」那一刻磁盘上还是空的（实测刚出图查是 0 条，
 * 再等一会儿是 15 条）。断言如果卡在出图那一刻，测到的是「查得太早」而不是「缓存没实现」——
 * 那会给出一个假 FAIL，比假 PASS 好一点但同样是错的结论。
 *
 * 返回最后一次观察，外加 `reached` 标记。**超时不算 PASS**：调用方的断言照样会失败。
 */
const waitForCacheRecords = async (host, want, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let stableRounds = 0;
    while (Date.now() < deadline) {
        last = await surveyIdb(host, 4000);
        const records = last && typeof last.records === 'number' ? last.records : 0;
        if (records >= want) return { ...last, reached: true };
        // 记录数两轮没变就当成「写完了」，不必耗满超时。
        const unchanged = last && last.records === (last.previousRecords ?? null);
        stableRounds = unchanged ? stableRounds + 1 : 0;
        if (last) last.previousRecords = last.records;
        if (stableRounds >= 4 && records > 0) return { ...last, reached: false, settledAt: records };
        await sleep(700);
    }
    return { ...(last || {}), reached: false };
};

const main = async () => {
    const profileC = join(OUT, 'profile-cache');
    const profileB = join(OUT, 'profile-static');
    const runs = {};

    // ---------------------------------------------------------------- A + D + E（同一进程）
    runs.main = await session({
        label: 'a-de-main',
        profile: profileC,
        settings: { ...baseSettings },
        freshProfile: true,
        body: async host => {
            const out = {};

            // A 非恒真的前提：打开设置**之前**记下渲染器集合。
            out.renderersBefore = await host.eval('window.__PA_PROBE__.markRenderers()');
            out.islandReady = await host.eval('window.__SPW_FOLIA_SETTINGS_UI_READY__ === true');
            await host.eval('window.__PA_PROBE__.arm("a-default-on")');
            await openSettings(host);

            const settle = await waitFor(host, 'A: 17 格全部出图', snapshot => {
                const dom = domOf(snapshot);
                const state = stateOf(snapshot);
                return dom.shelf === true
                    && dom.tiles >= 18
                    && (dom.images + dom.tileImages) >= 17
                    && dom.making === 0
                    // pending 语义已定案：排除了 __random__ 字形格，所以 live 静止就绪时就是 0。
                    && state && state.pending === 0;
            }, 90000);
            out.settle = settle;
            out.overlayAfterOpen = (settle.last || {}).overlay || null;
            out.dom = domOf(settle.last);
            out.state = stateOf(settle.last);
            out.renderersAfter = await host.eval('window.__PA_PROBE__.renderersSince()');
            out.chrome = await host.eval('window.__PA_PROBE__.chrome()');
            out.bigPreview = await host.eval('window.__PA_PROBE__.bigPreview()');
            out.errors = await host.eval('window.__PA_PROBE__.errors()');
            out.roundA = await host.eval('window.__PA_PROBE__.round()');
            // 缓存是**逐格、异步**落盘的：每格造完图 → subscribeImages 回调 → staticPictureHtml
            // （canvas 转 PNG，几十 KB） → IndexedDB 事务。17 格串行造完要 20 秒以上，落盘再拖一截。
            // 刚出图就查 IDB 会看到 0 条（实测：立刻查 0 条，多等一会儿 15 条），那是查询太早，
            // 不是缓存没实现。等到「记录数不再增长」为止，最多 20 秒。
            out.idbAfterA = await waitForCacheRecords(host, 17, 20000);
            out.shotA = await shot(host, 'a-default-on.png');

            // ---- D 热切换：true -> false
            await host.eval('window.__PA_PROBE__.stop()');
            const turnedOff = Date.now();
            host.send({ t: 'settings', settings: { ...baseSettings, previewAnimation: false } });
            const toStatic = await waitFor(host, 'D: 转 static', snapshot => domOf(snapshot).mode === 'static', 5000);
            out.toStatic = { ...toStatic, latencyMs: Date.now() - turnedOff };
            out.domStatic = domOf(toStatic.last);
            // 转 static 之后：一格 [data-picture] 都不许剩。
            const staticClean = await waitFor(host, 'D: pictures 归零', snapshot => {
                const dom = domOf(snapshot);
                return dom.mode === 'static' && dom.pictures === 0 && dom.making === 0 && dom.running === 0;
            }, 3000);
            out.staticClean = staticClean;
            out.domStaticClean = domOf(staticClean.last);
            // 关掉之后 hover 也不许挂渲染器。冲一下指针停留时间（上游是 280ms）。
            const hoverTarget = (domOf(staticClean.last).values || []).find(value => value !== '__random__');
            out.staticHoverTarget = hoverTarget || null;
            out.staticHover = hoverTarget ? await host.eval(`window.__PA_PROBE__.hover(${JSON.stringify(hoverTarget)})`) : null;
            await sleep(900);
            out.domStaticHovered = await host.eval('window.__PA_PROBE__.dom()');
            out.stateStaticHovered = await host.eval('window.__PA_PROBE__.state()');
            await host.eval('window.__PA_PROBE__.leaveGrid()');
            out.shotStatic = await shot(host, 'd-hot-switch-static.png');

            // ---- D 改回 true：又出图
    // ---- D 改回 true：又出图。**必须显式带 previewAnimation:true** ——
    // useInjectedSwitch 的契约是「不带该键的 payload 不会把已有值改回默认」（页面自己的
    // 设置回显里没有这些键，那不是「用户把它关掉了」）。发一个不带该键的树，值会停在 false。
            host.send({ t: 'settings', settings: { ...baseSettings, previewAnimation: true } });
            const backToLive = await waitFor(host, 'D: 转回 live 并出图', snapshot => {
                const dom = domOf(snapshot);
                const state = stateOf(snapshot);
                return dom.mode === 'live'
                    && (dom.images + dom.tileImages) >= 17
                    && dom.making === 0
                    // pending 语义已定案：排除了 __random__ 字形格，所以 live 静止就绪时就是 0。
                    && state && state.pending === 0;
            }, 30000);
            out.backToLive = backToLive;
            out.domBackLive = domOf(backToLive.last);
            out.stateBackLive = stateOf(backToLive.last);

            // ---- E 回归：同页关掉再开，不许又造图
            host.send({ t: 'command', command: 'close-settings' });
            await waitFor(host, 'E: 关窗', snapshot => domOf(snapshot).shelf === false || (snapshot.overlay || {}).open === 'false', 6000);
            await sleep(400);
            await host.eval('window.__PA_PROBE__.markRenderers()');
            await host.eval('window.__PA_PROBE__.arm("e-reopen")');
            await openSettings(host);
            const reopen = await waitFor(host, 'E: 重开出图', snapshot => {
                const dom = domOf(snapshot);
                return dom.tiles >= 18 && (dom.images + dom.tileImages) >= 17 && dom.making === 0;
            }, 20000);
            out.reopen = reopen;
            out.domReopen = domOf(reopen.last);
            out.roundE = await host.eval('window.__PA_PROBE__.round()');
            out.renderersReopen = await host.eval('window.__PA_PROBE__.renderersSince()');
            out.errorsEnd = await host.eval('window.__PA_PROBE__.errors()');
            out.idbEnd = await surveyIdb(host);
            await host.eval('window.__PA_PROBE__.stop()');
            return out;
        },
    });

    // ---------------------------------------------------------------- B（全新 profile，开关关）
    runs.static = await session({
        label: 'b-static',
        profile: profileB,
        settings: { ...baseSettings, previewAnimation: false },
        freshProfile: true,
        body: async host => {
            const out = {};
            out.renderersBefore = await host.eval('window.__PA_PROBE__.markRenderers()');
            await host.eval('window.__PA_PROBE__.arm("b-static")');
            await openSettings(host);
            const ready = await waitFor(host, 'B: 货架挂成 static', snapshot => {
                const dom = domOf(snapshot);
                return dom.shelf === true && dom.tiles >= 18 && dom.mode === 'static';
            }, 20000);
            out.ready = ready;
            // 静态模式下不会再有别的事发生，等一段时间再取「稳定态」，别把过渡帧当结论。
            await sleep(2500);
            out.dom = await host.eval('window.__PA_PROBE__.dom()');
            out.state = await host.eval('window.__PA_PROBE__.state()');
            out.renderersAfter = await host.eval('window.__PA_PROBE__.renderersSince()');
            out.chrome = await host.eval('window.__PA_PROBE__.chrome()');
            out.bigPreview = await host.eval('window.__PA_PROBE__.bigPreview()');
            out.round = await host.eval('window.__PA_PROBE__.round()');
            out.errors = await host.eval('window.__PA_PROBE__.errors()');
            out.idb = await host.eval('window.__PA_PROBE__.idb()');

            // hover 一格：关掉动画之后，指针停留也不许把渲染器拉起来。
            const target = ((out.dom || {}).values || []).find(value => value !== '__random__');
            out.hoverTarget = target || null;
            out.hover = target ? await host.eval(`window.__PA_PROBE__.hover(${JSON.stringify(target)})`) : null;
            await sleep(1000);
            out.domHovered = await host.eval('window.__PA_PROBE__.dom()');
            out.stateHovered = await host.eval('window.__PA_PROBE__.state()');
            out.renderersAfterHover = await host.eval('window.__PA_PROBE__.renderersSince()');
            out.roundHover = await host.eval('window.__PA_PROBE__.round()');
            out.chromeHovered = await host.eval('window.__PA_PROBE__.chrome()');
            await host.eval('window.__PA_PROBE__.leaveGrid()');
            out.shot = await shot(host, 'b-switch-off.png');
            await host.eval('window.__PA_PROBE__.stop()');
            return out;
        },
    });

    // ---------------------------------------------------------------- C（同一 profile，第二次进程）
    runs.restart = await session({
        label: 'c-restart-cached',
        profile: profileC,
        settings: { ...baseSettings },
        body: async host => {
            const out = {};
            // 第二个进程开工前，磁盘上应该已经有上一轮写的记录（同一 --user-data profile）。
            out.idbBefore = await surveyIdb(host);
            out.renderersBefore = await host.eval('window.__PA_PROBE__.markRenderers()');
            await host.eval('window.__PA_PROBE__.arm("c-restart")');
            await openSettings(host);
            const settle = await waitFor(host, 'C: 第二次启动出图', snapshot => {
                const dom = domOf(snapshot);
                const state = stateOf(snapshot);
                return dom.shelf === true
                    && dom.tiles >= 18
                    && (dom.images + dom.tileImages) >= 17
                    && dom.making === 0
                    // 静止态：没有任何一格在跑。hover 会把 images 换成 running（上游行为），
                    // 所以必须在 running===0 时读，否则 17 会变成 16。
                    && dom.running === 0
                    // pending 语义已定案：排除了 __random__ 字形格，所以 live 静止就绪时就是 0。
                    && state && state.pending === 0;
            }, 90000);
            out.settle = settle;
            // 采完再确认一次静止：waitFor 可能在某个过渡帧刚好满足，这里落一个稳定读数。
            out.still = await waitFor(host, 'C: 稳定静止态', snapshot => {
                const dom = domOf(snapshot);
                return dom.running === 0 && dom.making === 0 && dom.images === 17;
            }, 8000);
            out.dom = domOf(out.still.last) || domOf(settle.last);
            out.state = stateOf(out.still.last) || stateOf(settle.last);
            out.round = await host.eval('window.__PA_PROBE__.round()');
            out.renderersAfter = await host.eval('window.__PA_PROBE__.renderersSince()');
            out.errors = await host.eval('window.__PA_PROBE__.errors()');
            out.idbAfter = await host.eval('window.__PA_PROBE__.idb()');
            // 从磁盘恢复出来的图必须是**真静态**：格内不许还有 CSS/WAAPI 动画在跑。
            out.animations = await host.eval('window.__PA_PROBE__.animations()');
            await host.eval('window.__PA_PROBE__.stop()');
            out.shot = await shot(host, 'c-restart-cached.png');
            return out;
        },
    });

    // ---------------------------------------------------------------- 断言
    const mainRun = runs.main.body || {};
    const staticRun = runs.static.body || {};
    const restartRun = runs.restart.body || {};
    const domA = mainRun.dom || {};
    const stateA = mainRun.state || {};
    const domB = staticRun.dom || {};
    const stateB = staticRun.state || {};
    const domC = restartRun.dom || {};
    const stateC = restartRun.state || {};
    const roundA = mainRun.roundA || {};
    const roundE = mainRun.roundE || {};
    const roundC = restartRun.round || {};
    const idbEndA = mainRun.idbEnd || {};
    const idbC = restartRun.idbBefore || {};

    const renderersAddedA = (mainRun.renderersAfter || {}).addedCount;
    const renderersAddedB = (staticRun.renderersAfter || {}).addedCount;
    const renderersAddedBHover = (staticRun.renderersAfterHover || {}).addedCount;
    // C（跨进程缓存）只看**渲染器**增量：lazy shell `ShelfLiveView` 在 live 模式下总要加载
    // （它就是货架本身的一部分），只有 Visualizer* 才是「为了造图而多拉的渲染器」。
    const styleRenderersAddedC = ((restartRun.renderersAfter || {}).renderers || {}).addedCount;
    const shellAddedC = ((restartRun.renderersAfter || {}).shelfShell || {}).addedCount;
    const renderersAddedE = (mainRun.renderersReopen || {}).addedCount;

    // ---- A
    // A1 用的是一条**独立于货架**的证据：设置岛自己挂的 ready 标志 + 覆盖层确实可见。
    // 不能拿「货架有没有属性」来当 A1 —— 那是 A2 的事，重复一遍只会显得检查很多。
    record('A1 settings island mounted and overlay visible',
        mainRun.islandReady === true && (mainRun.overlayAfterOpen || {}).open === 'true' && (mainRun.overlayAfterOpen || {}).display !== 'none',
        { islandReady: mainRun.islandReady, overlay: mainRun.overlayAfterOpen });
    record('A2 shelf reached live mode', domA.mode === 'live', domA.mode);
    record('A3 probe reports animated=true', stateA.animated === true, stateA.animated);
    record('A4 17 style pictures painted', (domA.images + domA.tileImages) >= 17 && domA.tiles >= 18, { images: domA.images, tileImages: domA.tileImages, tiles: domA.tiles });
    // A5：live 静止就绪时 pending 必须是 **0**。
    // 语义定案（**以实测为准**，逐格表见 diag-preview-cache-counter.mjs）：
    // `__random__` 是 Shuffle 字形格，永远没有 [data-picture]，而 ShelfLive.tsx 的 pending 计算
    // 已把它排除，所以「除随机格以外还在等图的样式格数」= 0。
    // 实测确认过：17 个样式格全部 hasImage=true，唯一无图的格子就是 __random__。
    record('A5 pending is zero once the live shelf has settled',
        stateA.pending === 0 && domA.values && domA.values.length === 18 && domA.images === 17,
        { pending: stateA.pending, images: domA.images, tiles: domA.tiles });
    record('A6 no page errors', ((mainRun.errors || {}).errors || []).length === 0 && ((mainRun.errors || {}).rejections || []).length === 0, mainRun.errors);
    // 非恒真的前提：开着动画时打开设置**确实**要拉渲染器。没有这条，B 的「0 个」可能白过。
    record('A7 opening the settings really does load style renderers (>0)', renderersAddedA > 0, mainRun.renderersAfter);

    // ---- D（热切换）
    record('D1 hot switch to false turns the shelf static', (mainRun.toStatic || {}).ok === true && (mainRun.toStatic || {}).latencyMs <= 5000,
        { ok: (mainRun.toStatic || {}).ok, latencyMs: (mainRun.toStatic || {}).latencyMs });
    record('D2 static: no [data-picture] at all', (mainRun.domStaticClean || {}).pictures === 0 && (mainRun.domStaticClean || {}).making === 0 && (mainRun.domStaticClean || {}).running === 0,
        mainRun.domStaticClean);
    record('D3 static: hovering mounts no renderer', (mainRun.domStaticHovered || {}).pictures === 0 && (mainRun.domStaticHovered || {}).running === 0 && (mainRun.domStaticHovered || {}).making === 0,
        { target: mainRun.staticHoverTarget, dom: mainRun.domStaticHovered, state: mainRun.stateStaticHovered });
    record('D4 hot switch back to true paints pictures again', (mainRun.backToLive || {}).ok === true && ((mainRun.domBackLive || {}).images || 0) + ((mainRun.domBackLive || {}).tileImages || 0) >= 17,
        { ok: (mainRun.backToLive || {}).ok, dom: mainRun.domBackLive });

    // ---- E（回归）
    record('E1 reopen same page makes no picture again (peakMaking=0)', roundE.peakMaking === 0, roundE);
    record('E2 reopen same page shows 17 pictures', ((mainRun.domReopen || {}).images || 0) + ((mainRun.domReopen || {}).tileImages || 0) >= 17, mainRun.domReopen);
    record('E3 reopen same page loads no style renderer', renderersAddedE === 0, mainRun.renderersReopen);

    // ---- B
    // 口径（shelf-cache 冻结）：static 模式**不承诺有图**，所以 pending 恒为 0、cached 恒为 0，
    // 两者都不能拿来当判据。判「关掉」的核心证据是 **resource entries 里 /Visualizer|ShelfLiveView/
    // 的条数 = 0**（无头 Edge 实测：off=0 条、on=6 条）；DOM 数量只是辅证，
    // 防的是「渲染了但不显示」这种 DOM 看不出来的情形。
    record('B1 shelf mode is static', domB.mode === 'static', domB.mode);
    record('B2 probe reports animated=false', stateB.animated === false, stateB.animated);
    record('B3 no [data-picture] node at all', domB.pictures === 0, { pictures: domB.pictures, tiles: domB.tiles });
    record('B4 nothing is making or running', domB.making === 0 && domB.running === 0, { making: domB.making, running: domB.running });
    record('B5 no picture was ever made this run (peakMaking=0)', (staticRun.round || {}).peakMaking === 0, staticRun.round);
    // static 下没有图，images 与 pending 都必须是 0（与 live 模式相反：那边 pending 是 1，剩随机格）。
    record('B6 static mode: images=0 and pending=0 (no picture promised)',
        domB.images === 0 && stateB.pending === 0, { images: domB.images, pending: stateB.pending, cached: stateB.cached });
    // 核心证据：一条渲染器/ShelfLiveView 的 resource entry 都不许有。
    record('B7 opening settings loads ZERO Visualizer|ShelfLiveView entries',
        renderersAddedB === 0 && ((staticRun.renderersAfter || {}).addedCount === 0),
        staticRun.renderersAfter);
    record('B8 hovering mounts no renderer', (staticRun.domHovered || {}).pictures === 0 && (staticRun.domHovered || {}).running === 0 && (staticRun.domHovered || {}).making === 0 && (staticRun.roundHover || {}).peakMaking === 0,
        { target: staticRun.hoverTarget, dom: staticRun.domHovered, state: staticRun.stateHovered, round: staticRun.roundHover });
    record('B9 hovering loads no Visualizer|ShelfLiveView entry either', renderersAddedBHover === 0, staticRun.renderersAfterHover);
    // B9 的真正命题是「关掉动画不动窗口的其它部分」。但不能拿 iframe 个数比 —— 大预览有两级
    // 实现（LivePreview 的 iframe / ready 超时后退回的静态 StylePreview），iframe 是 0 还是 1
    // 取决于子帧有没有及时 ready，那是竞态，不是本开关造成的。比的是「有没有大预览」这件事本身。
    const bigA = mainRun.bigPreview || {};
    const bigB = staticRun.bigPreview || {};
    record('B11 big sample + tabs + sliders all still there',
        bigB.pauseButton === true
        && (bigB.iframe > 0 || bigB.stylePreview > 0)
        && (staticRun.chrome || {}).tabs >= 4
        && (staticRun.chrome || {}).sliders > 0
        && (staticRun.chrome || {}).windows === (mainRun.chrome || {}).windows,
        { live: bigA, static: bigB, chromeLive: mainRun.chrome, chromeStatic: staticRun.chrome });
    record('B12 no page errors', ((staticRun.errors || {}).errors || []).length === 0 && ((staticRun.errors || {}).rejections || []).length === 0, staticRun.errors);

    // ---- C
    record('C1 first launch wrote >=17 records into IndexedDB spw-folia-preview/pictures', idbEndA.exists === true && (idbEndA.records || 0) >= 17, idbEndA);
    record('C2 second process sees the cache on disk', idbC.exists === true && (idbC.records || 0) >= 17, idbC);
    record('C3 second process is still in live mode', domC.mode === 'live', domC.mode);
    record('C4 second process never makes a picture (peakMaking=0)', roundC.peakMaking === 0, roundC);
    // C5：第二次启动不许再拉**任何**样式渲染器（Visualizer*）。
    // lazy shell `ShelfLiveView` 不算 —— 它就是实时货架的壳，live 模式下必然加载；
    // 缓存要省掉的是「为造 17 张图而动态 import 的渲染器」，基线里那是 19 个。
    record('C5 second process loads ZERO style renderer (Visualizer*) chunks',
        styleRenderersAddedC === 0 && (((restartRun.renderersAfter || {}).renderers || {}).now === ((restartRun.renderersAfter || {}).renderers || {}).before),
        { styleRenderers: (restartRun.renderersAfter || {}).renderers, shell: (restartRun.renderersAfter || {}).shelfShell, shellReloaded: shellAddedC });
    record('C6 second process shows 17 pictures', (domC.images + domC.tileImages) >= 17 && domC.tiles >= 18, { images: domC.images, tileImages: domC.tileImages, tiles: domC.tiles });
    // C7 与 A5 同一条道理：live 静止就绪态 pending === 0（随机格已被实现排除）。
    record('C7 second process settled with pending=0', stateC.pending === 0 && domC.images === 17,
        { pending: stateC.pending, images: domC.images });
    // C8 只看 live 模式的 cached（static 下恒 0，不是判据）。
    record('C8 second process reports cached >= 17', (stateC.cached || 0) >= 17, { cached: stateC.cached });
    // C9：磁盘恢复出来的图必须是**真静态**。`freezeStage` 只冻结当时画出来的样子，漏掉了
    // 「冻结时不在 running 列表里」的 CSS 动画（cappella 有几十个 char-fade），挂回新页面会从头重播。
    // 用 getAnimations({subtree:true}) 数，比「有没有 canvas」强：元素型样式也能带动画。
    const animationsC = restartRun.animations || {};
    record('C9 restored pictures carry zero running animations',
        animationsC.shelf === true && animationsC.total === 0,
        { total: animationsC.total, perTile: animationsC.perTile });

    // ---- 自我检查（防止「什么都没测到却全绿」）
    record('S1 all three host sessions completed', ['main', 'static', 'restart'].every(key => runs[key] && runs[key].body),
        { main: Boolean(runs.main.body), static: Boolean(runs.static.body), restart: Boolean(runs.restart.body) });
    record('S2 the shelf contract attribute exists', typeof domA.mode === 'string' && typeof domB.mode === 'string',
        { main: domA.mode, static: domB.mode });
    record('S3 the state probe carries the new fields', stateA && 'animated' in stateA && 'cached' in stateA && 'pending' in stateA,
        stateA);

    const measured = {
        baselineReference: {
            coldOpenMs: 24276,
            warmReopenMs: 48,
            restartOpenMs: 23010,
            note: 'poc/webview/host/out/preview-cache-baseline/measure.json（改动前的基线，秒数只作对比不断言）',
        },
        coldFirstOpenMs: roundA.tAllImages === null || roundA.tAllImages === undefined ? null : Math.round(roundA.tAllImages),
        warmReopenMs: roundE.tAllImages === null || roundE.tAllImages === undefined ? null : Math.round(roundE.tAllImages),
        restartWithCacheMs: roundC.tAllImages === null || roundC.tAllImages === undefined ? null : Math.round(roundC.tAllImages),
    };
    measured.ratioToBaselineOnRestart = (measured.restartWithCacheMs && measured.restartWithCacheMs > 0)
        ? Number((measured.baselineReference.restartOpenMs / measured.restartWithCacheMs).toFixed(1))
        : null;
    // 这个比值只有在 C 组（缓存真的生效）全绿时才有意义。缓存没实现时它大约是 1.0x ——
    // 那正是「秒数不是证据」的证明：一次没有缓存的运行也能得到接近 1 的比值。
    measured.ratioNote = '秒数只记录、不断言。C 组不看这个比值，看 peakMaking / chunk delta / IndexedDB 记录数。';

    const report = {
        at: new Date().toISOString(),
        exe: { path: exe, bytes: readFileSync(exe).length },
        settingsBundle: { path: settingsBundle, bytes: readFileSync(settingsBundle).length },
        checks,
        measured,
        runs: {
            main: mainRun,
            static: staticRun,
            restart: restartRun,
        },
        hostErrors: {
            main: runs.main.hostErrors,
            static: runs.static.hostErrors,
            restart: runs.restart.hostErrors,
        },
        pass: checks.every(check => check.ok),
    };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    for (const check of checks) {
        console.log((check.ok ? 'PASS' : 'FAIL') + '  ' + check.name + (check.ok ? '' : '  -> ' + JSON.stringify(check.detail)));
    }
    console.log('');
    console.log('measured: ' + JSON.stringify(measured, null, 2));
    console.log('');
    const passed = checks.filter(check => check.ok).length;
    console.log((report.pass ? 'PASS' : 'FAIL') + '  ' + passed + '/' + checks.length + ' checks');
    console.log('report: ' + join(OUT, 'report.json'));
    process.exit(report.pass ? 0 : 1);
};

main().catch(error => {
    // 异常路径也必须落一份报告：否则「为什么 FAIL」只能靠翻 stdout。
    try {
        writeFileSync(join(OUT, 'report.json'), JSON.stringify({
            at: new Date().toISOString(),
            checks,
            error: String(error && error.stack ? error.stack : error),
            pass: false,
        }, null, 2));
    } catch { /* 落盘失败也不改变退出码 */ }
    console.error('FAIL  ' + String(error && error.stack ? error.stack : error));
    process.exit(1);
});
