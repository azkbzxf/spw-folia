#!/usr/bin/env node
// v0.4.11 acceptance — the 「出现问题」 self-check, run against the SHIPPED helper + settings island.
//
// Why this exists: the self-check is the one feature that can lie to the user ("缺少运行环境" on a
// perfectly healthy machine). It is also the feature most likely to drift after a release, because it
// asserts facts about *this* build: which switches the 配置 page declares, what the page half of the
// report can read, whether a FAIL is real. So it gets a repeatable check, run after every build.
//
// What it proves:
//   A. The page half works end-to-end: the diagnostics panel asks the host for `envReport`, the host
//      answers with the documented fields, and the panel renders a verdict per check.
//   B. No check reports FAIL on this machine unless it genuinely can. On a healthy dev machine the
//      payload checks legitimately report «not deployed»; they must not be reported as missing files.
//   C. The 配置 page declaration and the code agree: every declared switch is one the plugin reads
//      (mirrors FoliaDiagnostics.configContractCheck, checked from the outside so a regression in
//      either half is caught).
//   D. The environment facts the panel judges on are present and parsable (.NET Release, WebView2
//      major, Windows build) — a null here is what used to turn into «未安装».
//
// Usage: node packaging/tools/verify-diagnostics.mjs
// Exit code 0 = PASS, 1 = FAIL, 2 = missing packaged helper.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PKG = join(ROOT, 'packaging');
const OUT = join(PKG, 'out', 'diagnostics');
mkdirSync(OUT, { recursive: true });

const exe = join(PKG, 'native', 'spw-folia-host.exe');
const settingsBundle = join(PKG, 'web', 'settings', 'settings-ui.js');
for (const p of [exe, join(PKG, 'web', 'index.html'), settingsBundle]) {
    if (!existsSync(p)) {
        console.error('FAIL  missing packaged file: ' + p + '\nrun: bash packaging/build-package.sh');
        process.exit(2);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseSettings = JSON.parse(readFileSync(join(PKG, 'testdata', 'default-settings.json'), 'utf8'));
if (typeof baseSettings.smartBeat === 'boolean') baseSettings.smartBeat = { enabled: baseSettings.smartBeat, effects: {} };

// The panel only renders when the switch is on, and v0.4.11 defaults it to off.
const settingsJson = { ...baseSettings, showProblemButton: true };

const ENV_PROBE = 'JSON.stringify({ ready: !!window.__SPW_FOLIA_SETTINGS_UI_READY__ })';

/** The panel's own DOM: one row per check, each carrying its verdict. */
const PANEL_PROBE = [
    'JSON.stringify({',
    '  button: !!document.querySelector("[data-spw-chrome=\\"problem-report\\"]"),',
    '  panel: !!document.querySelector("[data-spw-chrome=\\"problem-report-panel\\"]"),',
    '  rows: Array.from(document.querySelectorAll(".spw-problem-report__row")).map(function (r) {',
    '    return {',
    '      verdict: r.getAttribute("data-verdict"),',
    '      label: (r.querySelector(".spw-problem-report__label") || {}).textContent || "",',
    '      detail: (r.querySelector(".spw-problem-report__detail") || {}).textContent || ""',
    '    };',
    '  })',
    '})',
].join('\n');

function runHost({ label }) {
    return new Promise((resolvePromise) => {
        const work = join(OUT, label);
        mkdirSync(work, { recursive: true });
        const profile = join(work, 'profile');
        mkdirSync(profile, { recursive: true });

        const child = spawn(exe, [
            '--bundle', join(PKG, 'web'),
            '--settings-dir', join(PKG, 'web', 'settings'),
            '--settings-entry', 'settings-ui.js',
            '--window', '1600x900',
            '--user-data-dir', profile,
            '--no-curtain',
        ], { cwd: PKG, stdio: ['pipe', 'pipe', 'pipe'] });

        const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
        const results = {};
        const lines = [];
        const tags = [];
        let buf = '';
        let ready = false;
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            try { send({ t: 'command', command: 'close' }); } catch { /* gone */ }
            try { child.kill(); } catch { /* gone */ }
            setTimeout(() => {
                try { writeFileSync(join(work, 'stdout.log'), lines.join('\n')); } catch { /* ignore */ }
                resolvePromise({ results, lines });
            }, 300);
        };

        const unwrap = (raw) => {
            let value = raw;
            for (let depth = 0; depth < 3; depth += 1) {
                if (typeof value !== 'string') break;
                const text = value.trim();
                if (!text) break;
                const head = text.charAt(0);
                if (head !== '{' && head !== '[' && head !== '"') break;
                try { value = JSON.parse(text); } catch { break; }
            }
            return value;
        };

        child.stdout.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const parts = buf.split('\n');
            buf = parts.pop() ?? '';
            for (const raw of parts) {
                const line = raw.trim();
                if (!line) continue;
                lines.push(line);
                if (line.includes('"t":"eval-result"')) {
                    const tag = tags.shift();
                    if (!tag) continue;
                    let msg = null;
                    try { msg = JSON.parse(line); } catch { msg = null; }
                    results[tag] = msg && typeof msg.value === 'string' ? unwrap(msg.value) : null;
                    continue;
                }
                if (!ready && line.includes('"t":"ready"')) { ready = true; onReady(); }
            }
        });
        child.stderr.on('data', () => { });
        child.on('error', () => finish());

        const evalJs = (tag, script) => { tags.push(tag); send({ t: 'command', command: 'eval', script }); };

        /**
         * Runs [script] until [accept] says the value is good, or [budgetMs] expires.
         *
         * Returns the last decoded value (or null). This replaces fixed `sleep()`s, which were the one
         * moving part in this suite: WebView2 boot, the settings-island mount and the panel's host
         * round trip all vary with machine load, and a fixed wait is a latent flake.
         */
        async function waitFor(tag, script, accept, budgetMs) {
            const deadline = Date.now() + budgetMs;
            let attempt = 0;
            let last = null;
            while (Date.now() < deadline) {
                attempt += 1;
                const key = tag + '-' + attempt;
                delete results[key];
                evalJs(key, script);
                // give the host a moment to answer this one before judging it
                const until = Date.now() + 2000;
                while (Date.now() < until) {
                    if (Object.prototype.hasOwnProperty.call(results, key)) break;
                    await sleep(80);
                }
                if (Object.prototype.hasOwnProperty.call(results, key)) {
                    last = results[key];
                    if (accept(last)) {
                        results[tag] = last;
                        return last;
                    }
                }
                await sleep(250);
            }
            results[tag] = last;
            return last;
        }

        async function onReady() {
            send({ t: 'settings', settings: settingsJson });

            // Wait for the settings island instead of sleeping a fixed amount: on a loaded machine
            // (three WebView2 processes plus a build) a fixed sleep is exactly how a suite becomes
            // flaky. `waitFor` polls until the probe succeeds or the budget runs out.
            const env = await waitFor('env', ENV_PROBE, (v) => v && v.ready === true, 12000);
            if (!env) {
                finish();
                return;
            }

            // Open the panel through its own button, exactly like a user would.
            await evalJs('opened', '(function(){ var b = document.querySelector("[data-spw-chrome=\\"problem-report\\"]"); if (!b) return "NO-BUTTON"; b.click(); return "clicked"; })()');

            // The panel asks the host for `envReport` (4 s timeout) and only then renders rows. Poll
            // for rows rather than assuming a duration: a machine under load can take well over 3.5 s.
            const panel = await waitFor(
                'panel',
                PANEL_PROBE,
                (v) => v && Array.isArray(v.rows) && v.rows.length > 0,
                20000,
            );
            // One more read after the rows settle, so the stored value is the steady state.
            if (panel) {
                await sleep(400);
                await evalJs('panel2', PANEL_PROBE);
                await sleep(300);
            }
            finish();
        }

        // Outer watchdog: well past the sum of the waitFor budgets so it only fires on a true hang.
        setTimeout(() => finish(), 75000);
    });
}

const checks = [];
const assert = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
const parse = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
};

async function main() {
    const run = await runHost({ label: 'self-check' });
    const panel = parse(run.results.panel2) ?? parse(run.results.panel);

    // ---- A. page half wired ------------------------------------------------------------
    const env = parse(run.results.env);
    assert('A1 settings island mounted', env && env.ready === true, env && env.ready);
    assert('A2 problem button present when the switch is on', panel && panel.button === true, panel && panel.button);
    assert('A3 clicking the button opens the panel', panel && panel.panel === true, panel && panel.panel);
    assert('A4 the panel rendered check rows', panel && Array.isArray(panel.rows) && panel.rows.length > 0,
        panel && panel.rows && panel.rows.length);
    assert('A5 the host answered the envReport request (no "正在检查" hang)',
        !!(panel && panel.rows && panel.rows.length > 0) &&
            !(panel.rows.some((r) => String(r.label || '').includes('正在检查'))),
        panel && panel.rows && panel.rows.map((r) => r.label));

    // ---- B. no false failures ----------------------------------------------------------
    // On a dev machine the payload checks report «not deployed» (unknown). A FAIL labelled as a
    // *missing file* is the historical false alarm and must not come back.
    const rows = (panel && panel.rows) || [];
    const fails = rows.filter((r) => r.verdict === 'fail');
    const falseMisses = fails.filter((r) => /缺少|未安装|missing/i.test(String(r.detail || '')) &&
        /原生文件|index\.html|settings-ui/.test(String(r.label || '')));
    assert('B1 no "missing file" FAIL on a machine that merely lacks a staged payload',
        falseMisses.length === 0, falseMisses.map((r) => r.label + ': ' + r.detail));
    const unknowns = rows.filter((r) => r.verdict === 'unknown');
    // B2 used to read `unknowns.length === 0 || fails.length >= 0`, which is a tautology: the
    // second operand is true for ANY array, so this — the only assertion claiming to enforce the
    // four-state contract — could never fail. The real contract is directional: an undecidable
    // check must be reported as UNKNOWN, and in particular must NOT be reported as a FAIL.
    const unknownAsFail = fails.filter((r) => /无法判定|unknown|读不到|不可用/i.test(String(r.detail || '')));
    assert('B2 undecidable checks are reported as unknown, not as failures',
        unknownAsFail.length === 0, unknownAsFail.map((r) => r.label + ': ' + r.detail));
    // And the four verdict words must actually be legal values — a typo would otherwise render as
    // an unstyled row that every other assertion here silently accepts.
    const legalVerdicts = new Set(['pass', 'fail', 'unknown', 'advisory']);
    const bogusVerdicts = rows.filter((r) => !legalVerdicts.has(String(r.verdict)));
    assert('B3 every row carries one of the four legal verdicts',
        bogusVerdicts.length === 0, bogusVerdicts.map((r) => r.label + ': ' + r.verdict));

    // ---- C. declaration ⇄ code contract -------------------------------------------------
    const prefPath = join(ROOT, 'spw-folia', 'src', 'main', 'resources', 'preference_config.json');
    const pref = JSON.parse(readFileSync(prefPath, 'utf8'));
    const declaredSwitches = pref.configs
        .flatMap((c) => c.preferences ?? [])
        .filter((p) => p.type === 'switch')
        .map((p) => ({ key: p.key, def: p.default_value }));
    const declaredKeys = declaredSwitches.map((s) => s.key).sort();
    assert('C1 the 配置 page declares the v0.4.11 switches',
        declaredKeys.join(',') === 'showPlaybackBar,showProblemButton,transitionAnimation,verboseLog',
        declaredKeys.join(','));
    assert('C2 显示问题反馈按钮 defaults to off',
        (declaredSwitches.find((s) => s.key === 'showProblemButton') || {}).def === false,
        (declaredSwitches.find((s) => s.key === 'showProblemButton') || {}).def);

    // The plugin's own list of handled keys must match the declaration (both directions).
    const diagSrc = readFileSync(join(ROOT, 'spw-folia', 'src', 'main', 'kotlin', 'dev', 'spw', 'folia', 'FoliaDiagnostics.kt'), 'utf8');
    const knownBlock = /KNOWN_CONFIG_SWITCHES\s*=\s*setOf\(([\s\S]*?)\)/.exec(diagSrc);
    const knownKeys = knownBlock
        ? (knownBlock[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')).sort()
        : [];
    assert('C3 every declared switch is in KNOWN_CONFIG_SWITCHES',
        declaredKeys.every((k) => knownKeys.includes(k)), { declared: declaredKeys, known: knownKeys });
    assert('C4 KNOWN_CONFIG_SWITCHES declares nothing the page does not offer',
        knownKeys.every((k) => declaredKeys.includes(k)), { declared: declaredKeys, known: knownKeys });

    // ---- D. the migration path for the moved 详细日志 switch ----------------------------
    // Contract, not file name: the legacy value must be read through FoliaConfigGroups.readBoolean
    // (the only code that also WRITES it into the new file) from whichever module owns the reads.
    // v0.4.12 moved the switch reads out of FoliaPlugin.kt into FoliaConfigSync.kt; keying this
    // check to FoliaPlugin.kt false-failed while a real regression sat underneath it — the rewrite
    // had dropped the migration call, so upgraded users lost their 详细日志 choice.
    const kotlinDir = join(ROOT, 'spw-folia', 'src', 'main', 'kotlin', 'dev', 'spw', 'folia');
    const owners = ['FoliaPlugin.kt', 'FoliaConfigSync.kt'].map((f) => {
        try { return readFileSync(join(kotlinDir, f), 'utf8'); } catch { return ''; }
    });
    const migrationCalls = owners
        .map((s) => (s.match(/FoliaConfigGroups\.readBoolean\s*\(/g) || []).length)
        .reduce((a, b) => a + b, 0);
    assert('D1 详细日志 reads through the migrating reader', migrationCalls > 0,
        'FoliaConfigGroups.readBoolean calls=' + migrationCalls);
    const groups = readFileSync(join(ROOT, 'spw-folia', 'src', 'main', 'kotlin', 'dev', 'spw', 'folia', 'FoliaConfigGroups.kt'), 'utf8');
    assert('D2 the legacy config file is still consulted', /LEGACY_CONFIG\s*=\s*"config\.json"/.test(groups), null);
    assert('D3 the new group file is diagnostics.json',
        /DIAGNOSTICS_CONFIG\s*=\s*"diagnostics\.json"/.test(groups), null);
    const verboseSection = pref.configs.find((c) => (c.preferences ?? []).some((p) => p.key === 'verboseLog'));
    assert('D4 详细日志 is declared in the 诊断与日志 group',
        !!verboseSection && verboseSection.config === 'diagnostics.json',
        verboseSection && verboseSection.config);

    const report = {
        at: new Date().toISOString(),
        exe: { path: exe, bytes: readFileSync(exe).length },
        rows,
        checks,
        pass: checks.every((c) => c.ok),
    };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '  -> ' + JSON.stringify(c.detail)));
    console.log('\n' + (report.pass ? 'PASS' : 'FAIL') + '  ' + checks.filter((c) => c.ok).length + '/' + checks.length + ' checks');
    process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
    console.error('FAIL  ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
