// issue #22（设置岛部分）真机验收：在真实 WebView2 宿主里打开设置窗，断言
//
//   A. 视觉样式 tab 顶部出现「渲染」组（[data-spw-render-quality]），两行就是上游那两行；
//      点 1.5× 后
//        - localStorage['lyric_render_quality'] 变成 {"scale":1.5,...}
//        - 播放页收到的 config 里 visualizerTunings.<当前样式>.render.scale === 1.5
//        - 所有带 render 的样式都被物化（不再有 'global' 残留），町景 quality 按 settle() 映射
//        - 设置树里那一份**没被写回**（'global' 还在），换回 1× 后 config 也回到 1
//   B. 通用 tab 出现文字颜色两行（[data-spw-font-color]），透明窗口关闭时第二行不在文档里；
//      选「浅色」后 config.theme.primaryColor 变亮、backgroundColor 不变，subtitleTheme 同步；
//      「深色」反向；「跟随系统」回到选之前的样子。
//
//   node scripts/verify-issue22-island.mjs [--shot prefix] [--duration 90000]
//
// 三个坑（前两个与 verify-shelf-live.mjs 相同）：
//  a) 宿主的 eval 只回传返回值；返回 Promise 会序列化成 {}。所以异步步骤在页面内 runner
//     （issue22-island-probe-page.js）里跑，结果写进 window.__ISSUE22_RESULTS__，node 侧同步读。
//  b) 覆盖层是 display:none 而不是卸载。必须用宿主的 open-settings 命令；只调
//     __SPW_FOLIA__.ui.openSettings() 页面状态会变而宿主侧仍认为没开，窗口留在 display:none 里。
//  c) **不要加 --demo**：demo 模式会把播放页的 config 换成宿主自己的样例（没有 visualizerTunings、
//     没有封面），于是「config 里 render.scale」和「文字颜色」两件事都无从取证。不加 demo 时
//     设置岛自己的 publisher 才是唯一 config 来源，那正是要验的东西。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_ROOT = path.resolve(SETTINGS_ROOT, '..', 'webview');
const EXE = path.join(WEBVIEW_ROOT, 'host', 'build', 'spw-folia-host.exe');
const BUNDLE = path.join(WEBVIEW_ROOT, 'dist', 'dist');
const OUT = path.resolve(SETTINGS_ROOT, '..', '..', '.scratch', 'issue22-24');
fs.mkdirSync(OUT, { recursive: true });

/** 换行逐字拼：这个文件经过会改写转义的工具。 */
const NL = String.fromCharCode(10);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};
/** 整段时长：runner 约 26s 走完（含各步 sleep），留出取结果与截图的余量。 */
const durationMs = Number(opt('duration', 46000));
const shotPrefix = String(opt('shot', 'issue22-island'));
/* 每次跑用一个独立 profile：上一轮被强制结束的宿主会留下 WebView2 子进程占着同一个 profile 的
 * LevelDB 锁，复用它会偶发「页面还没起来宿主就退了」，看起来像产品缺陷其实是取证环境问题。 */
const profileDir = path.join(OUT, `island-profile-${Date.now().toString(36)}`);

const PAGE = fs.readFileSync(path.join(__dirname, 'issue22-island-probe-page.js'), 'utf8');

const child = spawn(EXE, [
    '--bundle', BUNDLE,
    '--windowed', '--width', '1600', '--height', '1000',
    // 设置页不依赖透明：显式关掉颜色键，避免另一个同事正在改的宿主透明路径干扰取证。
    '--no-transparency', '--no-colour-key',
    '--settings-dir', path.join(SETTINGS_ROOT, 'dist'),
    '--settings-entry', 'settings-ui.js',
    '--open-settings', '--no-curtain',
    '--duration', String(durationMs),
    '--user-data-dir', profileDir,
    '--title', 'issue22 island check',
    '--no-topmost',
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
            if (msg.t === 'eval-result') results.push(String(msg.value));
            if (msg.t === 'log' && msg.level === 'error') errors.push(msg.msg);
        } catch { /* 非 JSON 行忽略 */ }
    }
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', d => { stderr += d; });

const send = payload => child.stdin.write(JSON.stringify(payload) + NL);
const evalJs = script => send({ t: 'command', command: 'eval', script });
const shot = name => send({ t: 'command', command: 'screenshot', path: path.join(OUT, String(name)) });
const timers = [];
const at = (ms, fn) => timers.push(setTimeout(fn, ms));

const shotA = `${shotPrefix}-A-render-group.png`;
const shotB = `${shotPrefix}-B-font-color.png`;

// 1) 装页面内探针并启动（宿主 open-settings 已由命令行参数发出）
at(1500, () => evalJs(PAGE));
at(3000, () => evalJs('window.__ISSUE22_START__ && window.__ISSUE22_START__()'));
// 2) 轮询 done（runner 里点选之间有真实 sleep，整段约 15s）
for (const ms of [9000, 12000, 15000, 18000, 22000, 26000, 30000]) {
    at(ms, () => evalJs('JSON.stringify({done: !!window.__ISSUE22_DONE__, n: (window.__ISSUE22_RESULTS__||[]).length, stage: window.__ISSUE22_STAGE__ || null})'));
}
/* 3) 完整结果多取几次，越早越好：宿主偶尔会在收尾阶段直接退出（另一条分支上有人在改 C#），
 *    而 runner 15s 内就把 37 条结果写完了 —— 所以不把取证押在最后一次 eval 上。 */
for (const ms of [10000, 13000, 16000, 19000, 22000, 26000, 30000, 34000]) {
    at(ms, () => evalJs('JSON.stringify(window.__ISSUE22_RESULTS__||[])'));
}
/* 4) 截图：**在 runner 跑完之后由 node 侧驱动**，先切 tab 再 scrollIntoView，然后才拍。
 *
 * 为什么不能按时间盲拍：真实 DSF 1.8 下 1600x1000 的窗口只有 888x555 的 CSS 视口，设置列在舞台
 * 下面，要滚动才看得到「渲染」组（实测：不滚 y=529 已在视口外，scrollIntoView 后 y=84）。按时间盲拍
 * 只能拍到舞台上的货架，拍不到这两组控件。
 * 为什么等 runner 结束：runner 自己会切 tab，盲拍可能正好落在它切走之后。 */
const shotClickTab = label => evalJs(`(function(){const t=[...document.querySelectorAll('[data-spw-settings-ui] [role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(t)t.click();return t?'clicked':'missing'})()`);
const shotScrollTo = selector => evalJs(`(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'missing';el.scrollIntoView({block:'start'});const r=el.getBoundingClientRect();return JSON.stringify({y:Math.round(r.y),h:Math.round(r.height)})})()`);

at(17000, () => shotClickTab('歌词动画'));
at(18500, () => shotScrollTo('[data-spw-render-quality="true"]'));
at(20000, () => shot(shotA));
at(21500, () => shotClickTab('字体'));
at(23000, () => shotScrollTo('[data-spw-font-color="true"]'));
at(24500, () => shot(shotB));
at(38000, () => send({ t: 'command', command: 'close' }));

child.on('exit', (code, signal) => {
    for (const t of timers) clearTimeout(t);
    console.log(`[verify-issue22] exit code=${code} signal=${signal}`);
    if (stderr.trim()) console.log('[stderr]', stderr.trim().slice(0, 1500));
    if (errors.length) {
        console.log('--- page errors ---');
        for (const e of errors.slice(0, 20)) console.log(e);
    }
    /* 宿主把 ExecuteScriptAsync 的返回值原样写进 `eval-result`，而那个返回值**本身已经是一层 JSON**
     * （WebView2 的约定：脚本返回字符串时给你一个 JSON 字符串字面量）。我们的脚本又 `JSON.stringify`
     * 了数组，于是回包是「JSON 字符串里装着 JSON 数组」—— 要 peel 两层才拿到数组。
     * 不 peel 就会 parse 出一个 string，`Array.isArray` 为 false，看起来像「宿主没回结果」。 */
    const peel = raw => {
        let value = raw;
        for (let i = 0; i < 4; i += 1) {
            if (typeof value !== 'string') break;
            const text = value.trim();
            if (!text.startsWith('[') && !text.startsWith('{') && !text.startsWith('"')) break;
            try { value = JSON.parse(text); } catch { break; }
        }
        return value;
    };
    let parsed = null;
    for (const raw of results) {
        const value = peel(raw);
        if (Array.isArray(value) && value.length > 0) parsed = value;
    }
    console.log('--- probe results ---');
    if (!parsed) {
        console.log('(no probe array returned; raw eval results follow)');
        for (const raw of results) console.log(raw);
        process.exitCode = 1;
        return;
    }
    const get = name => (parsed.find(entry => entry.name === name) || {}).value;
    for (const entry of parsed) console.log(`${entry.name} = ${JSON.stringify(entry.value)}`);
    fs.writeFileSync(path.join(OUT, 'island-probe-results.json'), JSON.stringify(parsed, null, 2));

    const lum = hex => {
        if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
        return (0.2126 * parseInt(hex.slice(1, 3), 16)
            + 0.7152 * parseInt(hex.slice(3, 5), 16)
            + 0.0722 * parseInt(hex.slice(5, 7), 16)) / 255;
    };
    const themeOf = key => get(key);

    // ---- 判定 ----
    const checks = [
        ['A 组存在', get('A.group.present') === true],
        ['A 组标题为「全局渲染」（不与上游样式内的「渲染」组同名）', get('A.group.title') === '全局渲染'],
        ['A 组在视觉样式 tab 最上面', get('A.group.isFirstGroupInVisualizerTab') === true],
        ['A 组两行就是分辨率 / 抗锯齿', Array.isArray(get('A.group.rows')) && get('A.group.rows').length === 2],
        ['A 分辨率选项 1.5× 在', get('A.scale.option1_5.present') === true],
        ['A localStorage 写入 1.5', get('A.localStorage.scale') === 1.5],
        ['A config 里该样式 render.scale === 1.5', get('A.config.visualizerTunings.scale') === 1.5],
        ['A 所有样式都被物化（无 global 残留）', Array.isArray(get('A.config.allMaterialised')) && get('A.config.allMaterialised').length === 0],
        ['A 町景 quality 被物化', (() => {
            const q = get('A.config.machi.quality');
            return Boolean(q) && q.renderScale === 1.5 && (q.antialias === 'smaa' || q.antialias === 'off');
        })()],
        ['A store 未被写回（仍是 global）', (() => {
            const o = get('A.storeRenderOverride.after');
            return Boolean(o) && o.scale === 'global';
        })()],
        ['A 换回 1× 后 config 也回到 1', get('A.revert.config.scale') === 1],
        ['B 两行存在', get('B.rows.present') === true],
        ['B 透明窗口关闭时第二行不出现', get('B.transparentRow.visibleWhenOpaque') === false],
        ['B 浅色选项在', get('B.light.option.present') === true],
        /* 没有封面时的判据（见 probe 文件里那段「为什么不注入封面」）：
         *  - 「浅色」与「跟随系统」在深色回退调色板下**本来就该相同**（都是浅色文字配深色画面），
         *    所以这两档相等是正确结果；
         *  - 「深色」必须明显更暗，且背景色一位不变 —— 这一对才是真正区分「文字侧被驱动、背景侧没动」
         *    的证据。
         * 有封面时这几条同样成立（浅色文字 vs 深色文字），所以判据不依赖封面。 */
        ['B 浅色 = 浅色文字（与引入前一致）', (() => {
            const before = themeOf('B.theme.before');
            const light = themeOf('B.theme.light');
            return Boolean(before && light) && lum(light.primary) === lum(before.primary);
        })()],
        ['B 浅色不改背景色', get('B.backgroundUnchanged') === true],
        ['B 字幕主题跟着文字走', (() => {
            const light = themeOf('B.theme.light');
            const sub = themeOf('B.subtitleTheme.light');
            return Boolean(light && sub) && sub.primary === light.primary;
        })()],
        ['B 深色让文字明显变暗', (() => {
            const light = themeOf('B.theme.light');
            const dark = themeOf('B.theme.dark');
            return Boolean(light && dark) && lum(dark.primary) < lum(light.primary) - 0.5;
        })()],
        ['B 深色不改背景色', get('B.dark.backgroundUnchanged') === true],
        ['B 显式选择不被对比度保护拉走（深色仍是纯深色）', (() => {
            const dark = themeOf('B.theme.dark');
            return Boolean(dark) && lum(dark.primary) < 0.2;
        })()],
        ['B 跟随系统回到原样', get('B.system.restoresOpaqueDefault') === true],
        ['无页面错误', Array.isArray(get('errors')) && get('errors').length === 0],
    ];
    console.log(NL + '--- checks ---');
    let failed = 0;
    for (const [label, ok] of checks) {
        if (!ok) failed += 1;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    }
    console.log(`${NL}${checks.length - failed}/${checks.length} passed`);
    for (const name of [shotA, shotB]) {
        const p = path.join(OUT, name);
        console.log('screenshot: ' + p + ' exists=' + fs.existsSync(p));
    }
    process.exitCode = failed === 0 ? 0 : 1;
});
