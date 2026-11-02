#!/usr/bin/env node
// Post-build gate (v0.4.11): run this after EVERY build, before packaging or releasing.
//
// The self-check is the one feature that can lie to users about their machine, and it is also the
// part that silently rots after a release: it asserts facts about *this* build (which switches the
// 配置 page declares, what the page half can read, whether a FAIL is real). So the project needs one
// command that fails loudly when any of that drifts.
//
// What it does, in order:
//   1. static contract checks that need no browser (declaration ⇄ KNOWN_CONFIG_SWITCHES, group files,
//      version stamps agree in all three places),
//   2. the three real-host suites (self-check, problem-button switch, playback-bar switch) that drive
//      the shipped helper + shipped settings island in real WebView2,
//   3. a summary, exiting non-zero if anything failed.
//
// Usage:
//   node packaging/tools/verify-all.mjs            # full gate (needs packaged payload)
//   node packaging/tools/verify-all.mjs --static   # contract checks only, no browser (CI-lite)
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

const STATIC_ONLY = process.argv.includes('--static');
const results = [];
const record = (suite, ok, detail) => {
    results.push({ suite, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite}${ok || detail ? '  ' + (detail || '') : ''}`);
};

// ---------------------------------------------------------------- 1. static contract ----

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function staticChecks() {
    // 1a. the three version stamps must agree (this drifted for six versions once)
    const gradle = read('spw-folia/build.gradle.kts');
    const pluginKt = read('spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt');
    const gradleVersion = (gradle.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || null;
    const gradlePluginVersion = (gradle.match(/PluginVersion\s*=\s*"([^"]+)"/) || [])[1] || null;
    const ktVersion = (pluginKt.match(/const val PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || null;
    const stamps = { 'build.gradle.kts version': gradleVersion, 'PluginVersion': gradlePluginVersion, 'PLUGIN_VERSION': ktVersion };
    const consistent = gradleVersion && gradleVersion === gradlePluginVersion && gradlePluginVersion === ktVersion;
    record('version stamps agree in all three places', consistent, JSON.stringify(stamps));

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

    // 1c. every group points at a distinct config file declared in the JSON itself
    const groups = pref.configs.map((c) => ({ title: c.title, file: c.config, n: (c.preferences ?? []).length }));
    const files = groups.map((g) => g.file);
    record('each 配置 group has its own file', new Set(files).size === files.length, JSON.stringify(groups));

    // 1d. the moved 详细日志 switch must still have its migration path in place.
    //
    // The check asserts the CONTRACT, not a file name: the legacy constant must still point at
    // config.json AND some module must actually call FoliaConfigGroups.readBoolean (the only code
    // that moves a legacy value into the new file). It used to look in FoliaPlugin.kt only, which
    // false-failed the moment v0.4.12 moved the switch reads into FoliaConfigSync.kt — and that
    // false failure was hiding a REAL regression at the same time: the rewrite had dropped the
    // migration call entirely, so upgraded users silently lost their 详细日志 choice.
    const groupsSrc = read('spw-folia/src/main/kotlin/dev/spw/folia/FoliaConfigGroups.kt');
    const verboseGroup = pref.configs.find((c) => (c.preferences ?? []).some((p) => p.key === 'verboseLog'));
    record('详细日志 moved to diagnostics.json', verboseGroup && verboseGroup.config === 'diagnostics.json',
        verboseGroup && verboseGroup.config);
    const sweep = ['FoliaPlugin.kt', 'FoliaConfigSync.kt', 'FoliaConfigGroups.kt']
        .map((f) => read('spw-folia/src/main/kotlin/dev/spw/folia/' + f))
        .join('\n');
    // Count CALLS, not the doc comment that also names the function.
    const migrationCalls = (sweep.match(/FoliaConfigGroups\.readBoolean\s*\(/g) || []).length;
    record('legacy config.json fallback still wired',
        /LEGACY_CONFIG\s*=\s*"config\.json"/.test(groupsSrc) && migrationCalls > 0,
        'calls=' + migrationCalls);

    // 1e. no setting may be offered twice (a duplicate key would silently split its storage)
    const dupes = declared.filter((k, i) => declared.indexOf(k) !== i);
    record('no duplicate switch keys across groups', dupes.length === 0, dupes.join(','));
}

// ---------------------------------------------------------------- 2. real-host suites ----

const SUITES = [
    { name: 'self-check (出现问题)', file: 'verify-diagnostics.mjs' },
    { name: '显示问题反馈按钮 switch', file: 'verify-problem-button-switch.mjs' },
    { name: '显示播放条 switch', file: 'verify-playback-bar-switch.mjs' },
];

function runSuite(file) {
    const script = join(HERE, file);
    if (!existsSync(script)) return { ok: false, detail: 'missing script ' + file, out: '' };
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const last = out.trim().split('\n').slice(-1)[0] || '';
    return { ok: r.status === 0, detail: last, out };
}

// ---------------------------------------------------------------- main ----

function main() {
    if (!STATIC_ONLY) {
        const exe = join(PKG, 'native', 'spw-folia-host.exe');
        const web = join(PKG, 'web', 'index.html');
        const island = join(PKG, 'web', 'settings', 'settings-ui.js');
        if (!existsSync(exe) || !existsSync(web) || !existsSync(island)) {
            console.error('FAIL  packaged payload missing (need packaging/native + packaging/web)');
            console.error('      run: bash packaging/build-package.sh');
            process.exit(2);
        }
    }

    console.log('== static contract ==');
    staticChecks();

    if (!STATIC_ONLY) {
        console.log('\n== real host + real WebView2 ==');
        for (const suite of SUITES) {
            const { ok, detail } = runSuite(suite.file);
            record(suite.name, ok, detail);
        }
    }

    const passed = results.filter((r) => r.ok).length;
    const report = {
        at: new Date().toISOString(),
        staticOnly: STATIC_ONLY,
        results,
        pass: results.every((r) => r.ok),
    };
    writeFileSync(join(OUT, 'verify-all.json'), JSON.stringify(report, null, 2));

    console.log('\n' + (report.pass ? 'PASS' : 'FAIL') + `  ${passed}/${results.length} gate checks`);
    if (!report.pass) {
        console.log('\nFailed:');
        for (const r of results.filter((x) => !x.ok)) console.log('  - ' + r.suite + (r.detail ? ': ' + r.detail : ''));
    }
    process.exit(report.pass ? 0 : 1);
}

main();
