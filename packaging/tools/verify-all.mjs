#!/usr/bin/env node
// Post-build gate. Run this after EVERY build, before packaging or releasing.
//
// ## Two rules this file follows, and why they are in the header
//
// 1. **Scope, don't blanket-run.** The gate is organised in scopes and only runs the scopes the
//    change actually touches. Running every suite on every release was how the gate grew to 24
//    checks, most of them re-proving areas that have not changed in ten versions: a slow,
//    noisy ritual that trains people to ignore it. A check earns its runtime by covering something
//    that can plausibly have broken.
//
// 2. **A skipped check is never a pass.** Anything not selected is printed as `SKIP` with the
//    reason, and the summary says how many checks were actually executed. "Green" always means
//    "this many checks ran and passed", never "nothing complained".
//
// ## Usage
//
//   node packaging/tools/verify-all.mjs                    # scopes inferred from the working diff
//   node packaging/tools/verify-all.mjs --all              # every scope (pre-release, slow)
//   node packaging/tools/verify-all.mjs --scopes=page,cli  # explicit
//   node packaging/tools/verify-all.mjs --static           # no browser, no packaged payload
//
// ## Scopes
//
//   core    version stamps, declaration ⇄ reader contract, and the JVM config-failure tests.
//           Cheap, and the failure mode users cannot recover from. Always runs.
//   page    the injected settings island: click zones / ghost layer, playback bar, problem button,
//           diagnostics self-check, live settings payload. Runs when poc/settings-ui/src or
//           poc/webview/** changed.
//   plugin  the Kotlin plugin side: log-folder landing, config sync. Runs when spw-folia/** changed.
//   layout  packaged-payload smoke test (real unpack, real host). Runs when packaging/** or a
//           release is being assembled (`--all`).
//
// Exit code 0 = PASS, 1 = FAIL, 2 = missing packaged payload (run bash packaging/build-package.sh).

import { spawnSync } from 'node:child_process';
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
const ALL = argv.includes('--all');
const scopeArg = (argv.find((a) => a.startsWith('--scopes=')) || '').replace('--scopes=', '');

const results = [];
const record = (suite, ok, detail) => {
    results.push({ suite, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite}${ok || detail ? '  ' + (detail || '') : ''}`);
};
const skip = (suite, reason) => {
    results.push({ suite, ok: true, skipped: true, detail: 'SKIP — ' + reason });
    console.log(`SKIP  ${suite}  (${reason})`);
};

// ---------------------------------------------------------------- 0. which scopes run ----

const SUITES = {
    core: [],           // filled by runCore(); listed here so the summary is uniform
    page: [
        { name: 'click zones / ghost layer (issue #19)', file: 'verify-click-zones.mjs' },
        { name: '显示播放条 switch', file: 'verify-playback-bar-switch.mjs' },
        { name: '显示问题反馈按钮 switch', file: 'verify-problem-button-switch.mjs' },
        { name: 'live settings payload end-to-end', file: 'verify-live-settings-payload.mjs' },
    ],
    plugin: [
        { name: 'self-check (出现问题)', file: 'verify-diagnostics.mjs' },
        { name: '「出现问题」打开日志文件夹落点', file: 'verify-log-folder.mjs' },
    ],
    layout: [
        { name: 'packaged layout smoke', file: 'verify-layout.mjs' },
    ],
};

/** Files touched since the last tag, or the working diff when there is no tag. */
function changedFiles() {
    const attempts = [
        ['git', ['diff', '--name-only', 'HEAD']],
        ['git', ['diff', '--name-only', '--cached']],
        ['git', ['diff', '--name-only', 'HEAD~1']],
    ];
    const seen = new Set();
    for (const [cmd, args] of attempts) {
        const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
        if (r.status !== 0) continue;
        for (const line of (r.stdout || '').split('\n')) {
            const f = line.trim();
            if (f) seen.add(f.replace(/\\/g, '/'));
        }
    }
    return [...seen].sort();
}

/**
 * Map changed paths onto scopes. Deliberately conservative in one direction only: an unknown path
 * widens the scope rather than narrowing it, because a check that did not need to run is cheap while
 * a check that should have run and did not is how releases break.
 */
function scopesFor(files) {
    const scopes = new Set(['core']);
    for (const f of files) {
        if (f.startsWith('poc/settings-ui/src/') || f.startsWith('poc/webview/') || f.startsWith('poc/settings-ui/scripts/')) scopes.add('page');
        else if (f.startsWith('spw-folia/src/') || f.startsWith('spw-folia/build.gradle.kts')) scopes.add('plugin');
        else if (f.startsWith('packaging/')) scopes.add('layout');
        else if (f.startsWith('work/')) scopes.add('page'); // upstream Folia tree feeds the page
    }
    // The page and the plugin both own part of the packaged payload, so either one implies a
    // layout check whenever a payload exists.
    if ((scopes.has('page') || scopes.has('plugin')) && existsSync(join(PKG, 'web', 'settings', 'settings-ui.js'))) {
        scopes.add('layout');
    }
    return scopes;
}

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
    const wired = new Set(Object.values(SUITES).flat().map((s) => s.file).concat('verify-all.mjs'));
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

function runSuite(file) {
    const script = join(HERE, file);
    if (!existsSync(script)) return { ok: false, detail: 'missing script ' + file };
    // 300 s was too tight for the click-zone suite (three style sessions, ~90 s each on a cold
    // WebView2 profile); 420 s keeps a real hang distinguishable from a slow machine.
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 420000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 2) return { ok: false, detail: 'missing payload — ' + (out.trim().split('\n').slice(-1)[0] || '') };

    /* The detail line is for a human scanning the gate, so prefer what the suite says about itself.
     * Some suites end with a `PASS …` / `ALL PASS` summary; others (verify-layout.mjs) only print a
     * JSON report, where "the last line" is a bare `}`. Fall back to the suite's own json field
     * rather than reporting a closing brace as the reason a check passed. */
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const summary = [...lines].reverse().find((l) => /^(PASS|FAIL|ALL PASS|SKIP)\b/i.test(l));
    let detail = summary || '';
    if (!detail) {
        const passMatch = /"pass":\s*(true|false)/.exec(out);
        const checksMatch = /(\d+)\s*\/\s*(\d+)\s+checks/i.exec(out);
        detail = passMatch
            ? `pass=${passMatch[1]}${checksMatch ? ` (${checksMatch[1]}/${checksMatch[2]} checks)` : ''}`
            : 'exit ' + r.status;
    }
    return { ok: r.status === 0, detail };
}

// ---------------------------------------------------------------- 3. main ----

function main() {
    const files = ALL ? [] : changedFiles();
    let scopes = ALL ? new Set(['core', 'page', 'plugin', 'layout']) : scopesFor(files);
    if (scopeArg) scopes = new Set(['core', ...scopeArg.split(',').map((s) => s.trim()).filter(Boolean)]);

    console.log(`== scope: ${[...scopes].join(', ')}` +
        (ALL ? ' (--all)' : ` (inferred from ${files.length} changed file(s))`));
    if (!ALL && files.length) console.log('   files: ' + files.slice(0, 8).join(', ') + (files.length > 8 ? ` … +${files.length - 8}` : ''));

    if (!STATIC_ONLY) {
        const needPayload = [...scopes].some((s) => s !== 'core');
        if (needPayload) {
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
    }

    console.log('\n== core ==');
    runCore();

    for (const scope of ['page', 'plugin', 'layout']) {
        const suites = SUITES[scope];
        if (!scopes.has(scope)) {
            for (const s of suites) skip(s.name, `scope "${scope}" not touched by this change`);
            continue;
        }
        if (STATIC_ONLY) {
            for (const s of suites) skip(s.name, '--static');
            continue;
        }
        console.log(`\n== ${scope} ==`);
        for (const s of suites) {
            const { ok, detail } = runSuite(s.file);
            record(s.name, ok, detail);
        }
    }

    const executed = results.filter((r) => !r.skipped);
    const passed = executed.filter((r) => r.ok).length;
    const report = {
        at: new Date().toISOString(),
        staticOnly: STATIC_ONLY,
        all: ALL,
        scopes: [...scopes],
        changedFiles: files,
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

main();
