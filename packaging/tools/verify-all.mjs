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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    // v0.4.14: these three existed since v0.4.13 but were never wired in, so the "10/10" was
    // reported WITHOUT them — the very suites that encode the v0.4.12/0.4.13 line-protocol lesson.
    // An orphaned gate script is a check nobody runs.
    { name: 'settings tree survives the line protocol (singleLine)', file: 'verify-json-singleline.mjs' },
    { name: 'PRETTY dropped vs COLLAPSED applied', file: 'verify-playback-switches.mjs' },
    { name: 'live settings payload end-to-end', file: 'verify-live-settings-payload.mjs' },
    // v0.4.16: the 歌词样式预览动画 switch and the style shelf's cross-process picture cache.
    // NOTE: unlike the suites above, this one drives the DEV artifacts under poc/ (poc/settings-ui/
    // dist, poc/webview/…) instead of the packaged copies, because the switch and the cache are
    // implemented there. That is still a real WebView2 host running the shipped bundle for that
    // build — but it means this suite is only meaningful AFTER `npx vite build` in poc/settings-ui.
    // The script exits 2 (not 1) when those artifacts are absent, so a stale local build shows up
    // as "missing payload" rather than as a silent pass.
    { name: '歌词样式预览动画 switch + 小图缓存', file: 'verify-preview-animation-switch.mjs' },
    // v0.4.17 (issue #18 item 1): 「凝彩样式失效」. A settings tree persisted before Folia 0.7.25
    // carries no `depthOfField`/`depthPan`/`glyphDepth`; the old whole-object replacement kept it
    // that way and the renderer multiplied by `undefined` -> NaN -> no composition at all. This
    // suite loads the page's TypeScript sources directly (Node --experimental-transform-types,
    // self-re-exec'd), so unlike the browser suites above it needs NO packaged payload — which is
    // why it also runs under --static.
    { name: 'tuning merge: 默认值打底 + 持久化覆盖', file: 'verify-tuning-merge.mjs' },
    // v0.4.17 (issue #18 item 3): 「出现问题」must open the LOG folder. This one spawns a real
    // explorer.exe with the shape `FoliaDiagnostics.logFolderCommand` builds and reads the landing
    // back through Shell.Application (LocationURL + Document.SelectedItems()), with the shipped
    // v0.4.16 shape and the tempting hand-quoted "fix" as negative controls. It needs a real
    // interactive desktop, so it exits 2 (not 1) on a machine where Explorer cannot be driven.
    { name: '「出现问题」打开日志文件夹落点', file: 'verify-log-folder.mjs' },
];

// ---------------------------------------------------------------- 1f. hang guards ----

/**
 * Static guards against the v0.4.13 TERMINATED_HANG returning.
 *
 * That build shipped with 10/10 green gates because every suite drove a machine that HAD a
 * `config.json`, so the "config file unreadable" branch was never executed by a test — only by
 * real users, who got a frozen UI and a forced kill. The checks below make the specific SHAPE of
 * that defect impossible to reintroduce silently; the behavioural proof lives in the JVM tests
 * (`FoliaConfigSyncTest`), which also run in this gate.
 */
function hangGuards() {
    const syncSrc = read('spw-folia/src/main/kotlin/dev/spw/folia/FoliaConfigSync.kt');

    // Guard 1: no call path inside the sync machinery may reach `sync(` again. v0.4.13's recursion
    // was `sync(reason = "$reason/retry")`; a JVM monitor is reentrant, so @Synchronized let it run.
    // Scope = the whole sync region (sync + syncInternal), because the retry could be moved into
    // either one by a future edit — checking only sync() would miss exactly that.
    const regionStart = syncSrc.indexOf('fun sync(reason: String)');
    const regionEnd = syncSrc.indexOf('private fun startWatcher');
    const region = regionStart >= 0 && regionEnd > regionStart
        ? syncSrc.slice(regionStart, regionEnd)
        : '';
    const regionWithoutDecl = region.replace('fun sync(reason: String)', '');
    const selfRecursive = /\bsync\s*\(\s*reason\s*=/.test(regionWithoutDecl);
    record('sync machinery never re-enters sync()', region.length > 0 && !selfRecursive,
        region.length === 0
            ? 'could not locate the sync region'
            : (selfRecursive ? 'found a recursive sync(reason=...) call' : ''));

    // Guard 2: the retry bound must be a const, not a resettable flag. v0.4.13 used an
    // AtomicBoolean that the retry path CLEARED before recursing, so "retry once" never ended.
    const hasConstBound = /const\s+val\s+EMPTY_RETRY_COUNT\s*=\s*[0-9]+/.test(syncSrc);
    const hasResetFlag = /retriedAfterEmpty/.test(syncSrc);
    record('retry bound is a constant, not a resettable flag', hasConstBound && !hasResetFlag,
        !hasConstBound ? 'EMPTY_RETRY_COUNT missing' : (hasResetFlag ? 'retriedAfterEmpty is back' : ''));

    // Guard 3: a re-entrancy backstop must exist, because @Synchronized cannot stop same-thread
    // re-entry — that is exactly WHY the recursion ran straight through the lock.
    record('sync has a re-entrancy depth backstop', /MAX_SYNC_DEPTH/.test(syncSrc), '');

    // Guard 4: every verify-* script on disk must be wired into this gate or explicitly excused.
    // An orphaned gate script is a check nobody runs — which is how three of them sat unused through
    // the v0.4.13 release while the notes claimed they ran.
    const wired = new Set([...SUITES.map((s) => s.file), 'verify-all.mjs']);
    const EXCUSED = new Set([
        // Manual-only: documented in docs/release.md as a separate step (needs a staged payload at
        // a specific DPI and takes minutes).
        'verify-layout.mjs',
        // Browser-flow suites that require a packaged WebView2 payload + specific host flags;
        // driven manually, not per-gate.
        'verify-splash-gates.mjs',
        'verify-splash-browser.mjs',
        // Legacy v0.3.0 suites for features since replaced; kept as documentation of past coverage.
        'verify-playback-controls.mjs',
        'verify-mouse-back.mjs',
        'verify-transparent-hud.mjs',
    ]);
    const present = readdirSync(HERE).filter((f) => /^verify-.*\.(mjs|py)$/.test(f));
    const orphaned = present.filter((f) => !wired.has(f) && !EXCUSED.has(f)).sort();
    record('no orphaned verify-* scripts', orphaned.length === 0, orphaned.join(','));

    // Guard 5: the settings island must refuse a SECOND mount. Its module is instantiated twice
    // because the host injects `settings-ui.js?v=<version>` while the lazily-loaded chunks import the
    // entry back by bare path (`from"../settings-ui.js"`, no query) and browsers key ES modules by
    // full URL. The second instance used to createRoot() the SAME container, which unmounted the live
    // tree and silently closed the panel the user had just opened — v0.4.14's
    // 「第一次打开设置，几秒钟后自动退出」. The guard must be on `window`, not module scope.
    const mountSrc = read('poc/settings-ui/src/mount.tsx');
    record('settings island guards a duplicate mount across module instances',
        /__SPW_FOLIA_SETTINGS_UI_MOUNTED__/.test(mountSrc) && /window/.test(mountSrc),
        /__SPW_FOLIA_SETTINGS_UI_MOUNTED__/.test(mountSrc) ? '' : 'per-instance `let root` only');
    record('settings controller refuses to be stolen by a second instance',
        /__SPW_FOLIA_SETTINGS_UI_OWNER__/.test(read('poc/settings-ui/src/bridge.ts')),
        '');
    // If a future build stops loading the entry twice, the two guards above stay harmless (they only
    // reject a duplicate). If it keeps loading twice without them, this gate fails.
    //
    // The back-import lives in the CHUNKS, not in the entry itself: the style-shelf/visualizer chunks
    // do `from"../settings-ui.js"` (no `?v=`), which is what mints the second module instance.
    const settingsAssets = join(PKG, 'web', 'settings', 'assets');
    if (existsSync(settingsAssets)) {
        let backImports = 0;
        for (const f of readdirSync(settingsAssets)) {
            if (!f.endsWith('.js')) continue;
            const text = readFileSync(join(settingsAssets, f), 'utf8');
            backImports += (text.match(/["']\.\.\/settings-ui\.js["']/g) || []).length;
        }
        const servedEntry = join(PKG, 'web', 'settings', 'settings-ui.js');
        const guarded = existsSync(servedEntry)
            && /__SPW_FOLIA_SETTINGS_UI_MOUNTED__/.test(readFileSync(servedEntry, 'utf8'));
        record('every chunk back-import of the entry is guarded',
            backImports === 0 || guarded,
            backImports === 0 ? 'no back-imports found' : `${backImports} back-import(s) — guarded=${guarded}`);
    }
}

/** Runs the JVM unit tests — the only suite that actually EXECUTES the config-failure branches. */
function runJvmTests() {
    const dir = join(ROOT, 'spw-folia');
    const gradlew = join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    if (!existsSync(gradlew)) return { ok: false, detail: 'gradlew missing', out: '' };
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
        out,
    };
}

function runSuite(file) {
    const script = join(HERE, file);
    if (!existsSync(script)) return { ok: false, detail: 'missing script ' + file, out: '' };
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const last = out.trim().split('\n').slice(-1)[0] || '';
    return { ok: r.status === 0, detail: last, out };
}

// ---------------------------------------------------------------- main ----

/**
 * Suites that do NOT need the packaged payload (they load the page's TypeScript sources / plain
 * JSON), so a `--static` run executes them too. Everything else in [SUITES] drives the real
 * WebView2 host and is skipped without a payload. Before v0.4.17 `--static` ran no suite at all,
 * which meant an unwired or rotted gate script stayed invisible until somebody ran the full gate.
 */
const SOURCE_ONLY_SUITES = new Set(['verify-tuning-merge.mjs']);

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

    console.log('\n== hang guards (v0.4.13 TERMINATED_HANG) ==');
    hangGuards();

    // The JVM suite is the only thing that actually EXECUTES the config-failure branches, so it runs
    // on every gate including --static. v0.4.13 shipped green precisely because no gate did.
    const jvm = runJvmTests();
    record('jvm unit tests (config failure paths)', jvm.ok, jvm.detail);

    // Source-only suites run in BOTH modes: they never touch the packaged payload, so `--static`
    // can and must execute them — an unwired gate script must not stay invisible.
    console.log('\n== source-only suites (no packaged payload needed) ==');
    for (const suite of SUITES) {
        if (!SOURCE_ONLY_SUITES.has(suite.file)) continue;
        const { ok, detail } = runSuite(suite.file);
        record(suite.name, ok, detail);
    }

    if (!STATIC_ONLY) {
        console.log('\n== real host + real WebView2 ==');
        for (const suite of SUITES) {
            if (SOURCE_ONLY_SUITES.has(suite.file)) continue; // already ran above
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
