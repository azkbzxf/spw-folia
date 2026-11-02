#!/usr/bin/env node
// v0.4.11 acceptance — 配置 page 「显示问题反馈按钮」 switch (default OFF).
//
// The switch decides whether the 救生圈 diagnostics button exists on the player page. Default is off,
// so the *absence* is the case that matters most: it must be a real unmount (no element, therefore no
// hit region and no ESC owner), not a CSS-hidden button that could still swallow clicks.
//
//   A. Default tree (no `showProblemButton`) -> the button is GONE (v0.4.11 default flipped to off).
//   B. `showProblemButton: true` -> the button is there and clickable.
//   C. `showProblemButton: false` -> gone again, and the settings gear is still reachable (the switch
//      must not take any other chrome with it).
//
// Usage: node packaging/tools/verify-problem-button-switch.mjs
// Exit code 0 = PASS, 1 = FAIL, 2 = missing packaged helper.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PKG = join(ROOT, 'packaging');
const OUT = join(PKG, 'out', 'problem-button-switch');
mkdirSync(OUT, { recursive: true });

const exe = join(PKG, 'native', 'spw-folia-host.exe');
const settingsBundle = join(PKG, 'web', 'settings', 'settings-ui.js');
for (const p of [exe, join(PKG, 'web', 'index.html'), settingsBundle]) {
    if (!existsSync(p)) {
        console.error('FAIL  missing packaged file: ' + p + '\nrun: bash packaging/build-package.sh');
        process.exit(2);
    }
}

const baseSettings = JSON.parse(readFileSync(join(PKG, 'testdata', 'default-settings.json'), 'utf8'));
if (typeof baseSettings.smartBeat === 'boolean') baseSettings.smartBeat = { enabled: baseSettings.smartBeat, effects: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = [
    'JSON.stringify({',
    '  ready: !!window.__SPW_FOLIA_SETTINGS_UI_READY__,',
    '  problemButton: !!document.querySelector("[data-spw-chrome=\\"problem-report\\"]"),',
    '  problemPanel: !!document.querySelector("[data-spw-chrome=\\"problem-report-panel\\"]"),',
    // the two pieces of chrome that must survive regardless of this switch
    '  gear: !!document.querySelector("[data-spw-chrome=\\"settings\\"]"),',
    '  playerPanel: !!document.querySelector("[data-spw-chrome=\\"player-background\\"]"),',
    '  injected: (function () { try { var b = window.__SPW_FOLIA__; var s = b && b.getSettings ? b.getSettings() : null; if (!s) return "NO-BRIDGE"; var v = s.showProblemButton; return v === undefined ? "ABSENT" : v; } catch (e) { return "ERR"; } })()',
    '})',
].join('\n');

function runHost({ label, settings }) {
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

        async function onReady() {
            send({ t: 'settings', settings });
            await sleep(2400);
            await evalJs('probe', PROBE);
            await sleep(700);
            await evalJs('probe2', PROBE);
            await sleep(400);
            finish();
        }

        setTimeout(() => finish(), 30000);
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
    // A. default (member absent) -> off
    const a = await runHost({ label: 'a-default', settings: { ...baseSettings } });
    const pa = parse(a.results.probe2) ?? parse(a.results.probe);
    assert('A1 settings island mounted', pa && pa.ready === true, pa && pa.ready);
    assert('A2 default hides the problem button', pa && pa.problemButton === false, pa && pa.problemButton);
    assert('A3 the whole panel is unmounted too', pa && pa.problemPanel === false, pa && pa.problemPanel);
    assert('A4 the settings gear survives', pa && pa.gear === true, pa && pa.gear);

    // B. explicitly on
    const b = await runHost({ label: 'b-on', settings: { ...baseSettings, showProblemButton: true } });
    const pb = parse(b.results.probe2) ?? parse(b.results.probe);
    assert('B1 switching it on shows the button', pb && pb.problemButton === true, pb && pb.problemButton);
    assert('B2 the page read the injected value as true', pb && pb.injected === true, pb && pb.injected);

    // C. explicitly off
    const c = await runHost({ label: 'c-off', settings: { ...baseSettings, showProblemButton: false } });
    const pc = parse(c.results.probe2) ?? parse(c.results.probe);
    assert('C1 switching it off removes the button', pc && pc.problemButton === false, pc && pc.problemButton);
    assert('C2 the page read the injected value as false', pc && pc.injected === false, pc && pc.injected);
    assert('C3 other chrome unaffected', pc && pc.gear === true && pc.playerPanel === true,
        pc && { gear: pc.gear, playerPanel: pc.playerPanel });

    const report = {
        at: new Date().toISOString(),
        exe: { path: exe, bytes: readFileSync(exe).length },
        runs: { defaultOff: pa, explicitOn: pb, explicitOff: pc },
        checks,
        pass: checks.every((x) => x.ok),
    };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

    for (const c2 of checks) console.log((c2.ok ? 'PASS' : 'FAIL') + '  ' + c2.name + (c2.ok ? '' : '  -> ' + JSON.stringify(c2.detail)));
    console.log('\n' + (report.pass ? 'PASS' : 'FAIL') + '  ' + checks.filter((x) => x.ok).length + '/' + checks.length + ' checks');
    process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
    console.error('FAIL  ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
