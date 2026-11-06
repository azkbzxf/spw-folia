#!/usr/bin/env node
// Post-build gate. Run this before packaging or releasing.
//
// ## What this is, and what it deliberately is not
//
// Three host suites plus a small block of static checks. Each entry is the only automated check for
// something that can plausibly break in a release:
//
//   core                 version stamps agree in all three places; every declared switch has a
//                        reader and vice versa; no duplicate switch keys; no orphaned verify-*
//                        scripts; the JVM config-failure tests. Cheap, and the failure modes users
//                        cannot recover from. Always runs.
//   verify-click-zones   the click-zone / ghost-layer contract (issue #19). The thing that actually
//                        breaks when the settings island is touched.
//   verify-layout        does the packaged payload boot and paint? Catches a broken .spmod, which
//                        nothing else can.
//   verify-diagnostics   the self-check is the one feature that can lie to users about their
//                        machine. 3 s.
//
// Everything else was deleted rather than kept: gates for areas that have been stable for several
// versions were a slow, noisy ritual that trains people to ignore a red gate. Notably
// verify-log-folder spawned a real explorer.exe on every run — it opened a folder window each time
// the gate ran — and was the slowest check in the suite. All deleted scripts are recoverable from
// git history (`git show v0.4.18:packaging/tools/<name>`).
//
// ## Rules that must survive any future edit
//
// 1. **A skipped check is never a pass.** Anything not run prints `SKIP` with a reason and is
//    excluded from the count; "green" means "this many checks ran and passed".
// 2. **A killed suite is reported as killed.** `spawnSync` returns `status: null` when the timeout
//    fires; treating that as a normal failure and quoting the last `PASS` line as the reason is how
//    a half-finished run reads as a product regression.
// 3. **No assertion may be tautological.** If a check cannot fail, it is not a check.
// 4. **Every verify-*.mjs on disk must be wired into REMAINING_SUITES**, or the orphan guard fails.
//
// ## Usage
//
//   node packaging/tools/verify-all.mjs            # everything (needs packaged payload)
//   node packaging/tools/verify-all.mjs --static   # static checks only, no browser
//
// Exit code 0 = PASS, 1 = FAIL, 2 = missing packaged payload (run bash packaging/build-package.sh).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PKG = join(ROOT, 'packaging');
const OUT = join(PKG, 'out');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const STATIC_ONLY = argv.includes('--static');

const results = [];
const record = (suite, ok, detail) => {
    results.push({ suite, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite}${ok || detail ? '  ' + (detail || '') : ''}`);
};
const skip = (suite, reason) => {
    results.push({ suite, ok: true, skipped: true, detail: 'SKIP — ' + reason });
    console.log(`SKIP  ${suite}  (${reason})`);
};

// ---------------------------------------------------------------- 0. suite registry ----

/* The gate is deliberately short. Each entry below is the only automated check for something that
 * can plausibly break in a release; anything whose area has been stable for several versions was
 * deleted rather than kept on a slow, noisy ritual that trains people to ignore it. Deleted
 * 2026-11-04 at the user's direction: verify-log-folder (opened an Explorer window on every run and
 * was the slowest check), verify-playback-bar-switch, verify-problem-button-switch,
 * verify-live-settings-payload. All four are recoverable from git history
 * (`git show v0.4.18:packaging/tools/<name>`). */
const REMAINING_SUITES = [
    { name: 'click zones / ghost layer (issue #19)', file: 'verify-click-zones.mjs' },
    // issue #21: the island's stacking level decides whether Folia's body-portaled menus (the kit's
    // Select menu, Sheet, tooltips) can be clicked at all. Asserting only "the listbox exists" is
    // what let that ship green for a whole release, so this drives a real press through the menu.
    { name: 'kit dropdowns are clickable (issue #21)', file: 'verify-select-layers.mjs' },
    { name: 'self-check (出现问题)', file: 'verify-diagnostics.mjs' },
    { name: 'packaged layout smoke', file: 'verify-layout.mjs' },
];

// ---------------------------------------------------------------- 1. core ----

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function runCore() {
    // 1a. the three version stamps must agree (this drifted for six versions once)
    const gradle = read('spw-folia/build.gradle.kts');
    const pluginKt = read('spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt');
    const gradleVersion = (gradle.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || null;
    const gradlePluginVersion = (gradle.match(/PluginVersion\s*=\s*"([^"]+)"/) || [])[1] || null;
    const ktVersion = (pluginKt.match(/const val PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || null;
    const stamps = { 'build.gradle.kts version': gradleVersion, 'PluginVersion': gradlePluginVersion, 'PLUGIN_VERSION': ktVersion };
    record('version stamps agree in all three places',
        Boolean(gradleVersion) && gradleVersion === gradlePluginVersion && gradlePluginVersion === ktVersion,
        JSON.stringify(stamps));

    // 1b. declaration ⇄ the reader's known-key set, both directions
    const pref = JSON.parse(read('spw-folia/src/main/resources/preference_config.json'));
    const declared = pref.configs.flatMap((c) => (c.preferences ?? []).filter((p) => p.type === 'switch').map((p) => p.key));
    const diagSrc = read('spw-folia/src/main/kotlin/dev/spw/folia/FoliaDiagnostics.kt');
    const knownBlock = /KNOWN_CONFIG_SWITCHES\s*=\s*setOf\(([\s\S]*?)\)/.exec(diagSrc);
    const known = knownBlock ? (knownBlock[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')) : [];
    const missingReader = declared.filter((k) => !known.includes(k)).sort();
    const staleKnown = known.filter((k) => !declared.includes(k)).sort();
    record('declared switches all have a reader', missingReader.length === 0, missingReader.join(','));
    record('no reader for a switch the page does not offer', staleKnown.length === 0, staleKnown.join(','));
    const dupes = declared.filter((k, i) => declared.indexOf(k) !== i);
    record('no duplicate switch keys', dupes.length === 0, dupes.join(','));

    // 1c. every gate script on disk must be reachable from this file. An unwired gate is a check
    // nobody runs — the v0.4.13 failure mode.
    const wired = new Set(REMAINING_SUITES.map((s) => s.file).concat('verify-all.mjs'));
    const present = spawnSync('bash', ['-lc', `ls "${HERE}"/verify-*.mjs | xargs -n1 basename`], { encoding: 'utf8' })
        .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const orphans = present.filter((f) => !wired.has(f)).sort();
    record('no orphaned verify-* scripts', orphans.length === 0, orphans.join(','));

    // 1d. the JVM suite is the only thing that EXECUTES the config-failure branches, so it always
    // runs. `--rerun-tasks` is mandatory: without it Gradle reports UP-TO-DATE, prints no test
    // lines, and "0 passed / 0 failed" reads as a pass (v0.4.13 shipped green through exactly that).
    const jvm = runJvmTests();
    record('jvm unit tests (config failure paths)', jvm.ok, jvm.detail);
}

function runJvmTests() {
    const dir = join(ROOT, 'spw-folia');
    const gradlew = join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    if (!existsSync(gradlew)) return { ok: false, detail: 'gradlew missing' };
    // `--rerun-tasks` is required: Gradle marks the test task UP-TO-DATE when nothing changed, which
    // emits no per-test lines and would let this gate report "0 passed / 0 failed" as a PASS. A
    // vacuous pass in the release gate is exactly how v0.4.13 shipped — the check must prove it ran.
    const r = spawnSync(gradlew, ['--offline', 'test', '--rerun-tasks', '--console=plain'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 600000,
        shell: process.platform === 'win32',
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const passed = (out.match(/ PASSED/g) || []).length;
    const failed = (out.match(/ FAILED/g) || []).length;
    // A run that executed no tests is a FAILURE, not a pass: silence must never look like success.
    const ran = passed + failed > 0;
    return {
        ok: r.status === 0 && failed === 0 && ran,
        detail: ran ? `${passed} passed / ${failed} failed` : 'no tests were executed',
    };
}

// ---------------------------------------------------------------- 2. suites ----

/**
 * Run one suite, buffering its output.
 *
 * Output is buffered rather than streamed because suites run concurrently: six interleaved live
 * streams make a FAIL hard to spot, whereas one contiguous block per suite reads like the serial
 * version did. The buffer is flushed even on failure.
 */
function runSuiteBuffered(file, { timeoutMs = 420000 } = {}) {
    const script = join(HERE, file);
    if (!existsSync(script)) return Promise.resolve({ ok: false, detail: 'missing script ' + file, out: '', ms: 0 });
    const startedAt = Date.now();
    return new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [script], { cwd: ROOT });
        let out = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            resolvePromise({
                ok: false,
                out,
                ms: Date.now() - startedAt,
                detail: `killed after ${timeoutMs / 1000}s (timeout) — it did not finish`,
            });
        }, timeoutMs);
        child.stdout.on('data', (c) => { out += c.toString('utf8'); });
        child.stderr.on('data', (c) => { out += c.toString('utf8'); });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const ms = Date.now() - startedAt;
            if (code === null) {
                const lastLines = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' | ');
                return resolvePromise({
                    ok: false, out, ms,
                    detail: `killed by ${signal || 'a signal'} — it did not finish; last output: ${lastLines || '(nothing)'}`,
                });
            }
            if (code === 2) {
                const last = out.trim().split('\n').slice(-1)[0] || '';
                return resolvePromise({ ok: false, out, ms, detail: 'missing payload — ' + last });
            }
            const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
            if (code !== 0) {
                const fails = lines.filter((l) => /^FAIL\b/i.test(l));
                const reason = fails.length ? fails.slice(0, 3).join(' | ') : (lines.slice(-1)[0] || '');
                return resolvePromise({ ok: false, out, ms, detail: `exit ${code} — ${reason}` });
            }
            const summary = [...lines].reverse().find((l) => /^(PASS|ALL PASS)\b/i.test(l));
            let detail = summary || '';
            if (!detail) {
                const passMatch = /"pass":\s*(true|false)/.exec(out);
                const checksMatch = /(\d+)\s*\/\s*(\d+)\s+checks/i.exec(out);
                detail = passMatch
                    ? `pass=${passMatch[1]}${checksMatch ? ` (${checksMatch[1]}/${checksMatch[2]} checks)` : ''}`
                    : 'exit 0';
            }
            resolvePromise({ ok: true, out, ms, detail });
        });
    });
}

/** Run every suite of a scope concurrently, then print one contiguous block per suite. */
async function runSuitesConcurrently(scope, suites) {
    const startedAt = Date.now();
    const running = suites.map((s) => runSuiteBuffered(s.file).then((r) => ({ suite: s, ...r })));
    const done = await Promise.all(running);
    for (const r of done) {
        // Flush the suite's own output first, then its one-line verdict, so the log reads in the
        // same order a serial run would have produced it.
        const body = r.out.trim();
        if (body) console.log(body);
        record(r.suite.name, r.ok, `${r.detail}  [${(r.ms / 1000).toFixed(1)}s]`);
    }
    return Date.now() - startedAt;
}


// ---------------------------------------------------------------- 3. main ----

async function main() {
    console.log(`== gate: core + ${REMAINING_SUITES.length} host suites ==`);

    if (!STATIC_ONLY) {
        const missing = [
            ['native helper', join(PKG, 'native', 'spw-folia-host.exe')],
            ['web payload', join(PKG, 'web', 'index.html')],
            ['settings island', join(PKG, 'web', 'settings', 'settings-ui.js')],
        ].filter(([, p]) => !existsSync(p)).map(([label]) => label);
        if (missing.length) {
            console.error(`FAIL  packaged payload missing: ${missing.join(', ')}`);
            console.error('      run: bash packaging/build-package.sh');
            process.exit(2);
        }
    }

    console.log('\n== core ==');
    runCore();

    if (STATIC_ONLY) {
        for (const s of REMAINING_SUITES) skip(s.name, '--static');
    } else {
        console.log('\n== real host + real WebView2 ==');
        const suitesMs = await runSuitesConcurrently('host', REMAINING_SUITES);
        console.log(`   (${(suitesMs / 1000).toFixed(1)}s wall, ${REMAINING_SUITES.length} suites concurrent)`);
    }

    const executed = results.filter((r) => !r.skipped);
    const passed = executed.filter((r) => r.ok).length;
    const report = {
        at: new Date().toISOString(),
        staticOnly: STATIC_ONLY,
        results,
        executed: executed.length,
        skipped: results.filter((r) => r.skipped).length,
        pass: executed.every((r) => r.ok),
    };
    writeFileSync(join(OUT, 'verify-all.json'), JSON.stringify(report, null, 2));

    console.log(`\n${report.pass ? 'PASS' : 'FAIL'}  ${passed}/${executed.length} executed checks` +
        (report.skipped ? `  (${report.skipped} skipped)` : ''));
    if (!report.pass) {
        console.log('\nFailed:');
        for (const r of executed.filter((x) => !x.ok)) console.log('  - ' + r.suite + (r.detail ? ': ' + r.detail : ''));
    }
    process.exit(report.pass ? 0 : 1);
}

await main();
