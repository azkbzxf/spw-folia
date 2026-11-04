#!/usr/bin/env node
// v0.4.17 acceptance (issue #18 item 3): 「出现问题」must open the LOG folder, not Documents.
//
// THE BUG
//   FoliaDiagnostics.openLogFolder built ONE argument, `"/select," + path`. Java's ProcessBuilder
//   quotes an argument only when it contains a space, and then wraps the WHOLE argument — it does
//   NOT escape quotes inside it. The child received
//       explorer.exe "/select,C:\...\Salt Player for Windows\...\spw-folia.log"
//   i.e. one argument whose literal text starts with `"`. explorer.exe does not recognise the
//   switch, ignores it, and falls back to its default start location: Documents.
//
// WHY THIS GATE LOOKS LIKE THIS
//   Asserting the argv list alone would be a tautology (it would "pass" for any shape we chose).
//   The claim under test is what EXPLORER does with it, so this gate spawns a real explorer.exe
//   with the shape `FoliaDiagnostics.logFolderCommand` produces and then reads back, through
//   Shell.Application, both the folder (LocationURL) and the selection (Document.SelectedItems()).
//
//   Two traps this gate is built to avoid, both of which produced a wrong "PASS" while this
//   defect was being investigated:
//     1. Stale windows. An earlier probe ran several shapes in a row without closing the windows
//        between them, so a window opened by a PREVIOUS shape was read back and attributed to the
//        current one. Every run here closes all Explorer windows first and re-checks that none
//        are left before spawning.
//     2. Checking the folder but not the selection. `explorer.exe "<dir>"` lands in the right
//        folder too, so a folder-only assertion cannot tell the fix from a downgrade that stops
//        selecting the log file.
//
//   Negative controls (both must FAIL — they prove the gate can go red):
//     - the shipped v0.4.16 shape `["explorer.exe", "/select," + path]`      -> lands in Documents
//     - the tempting "fix"   `["explorer.exe", "/select,\"" + path + "\""]`  -> lands in Documents
//
// Requires a real interactive Windows session with explorer.exe (it is a real desktop window test).
// Exit: 0 = PASS, 1 = FAIL, 2 = cannot run here (no explorer / not Windows).
//
// Usage: node packaging/tools/verify-log-folder.mjs [--keep-windows]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'packaging', 'out', 'log-folder');
mkdirSync(OUT, { recursive: true });

if (process.platform !== 'win32') {
    console.error('SKIP  verify-log-folder only runs on Windows (needs explorer.exe + Shell.Application)');
    process.exit(2);
}

const diagKt = join(ROOT, 'spw-folia', 'src', 'main', 'kotlin', 'dev', 'spw', 'folia', 'FoliaDiagnostics.kt');
if (!existsSync(diagKt)) {
    console.error('FAIL  missing source: ' + diagKt);
    process.exit(1);
}
const src = readFileSync(diagKt, 'utf8');

const checks = [];
const assert = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

// ---------------------------------------------------------------- static: the argv shape ----

/**
 * The shape the plugin builds, read out of the source — NOT re-implemented here. Re-implementing it
 * would let the gate pass while the plugin still shipped the bug (the classic "test asserts the test"
 * failure). We require the three-argument form and forbid any string concatenation into the switch.
 */
const shapeFn = /internal fun logFolderCommand\([\s\S]*?\n\s{4}\}/.exec(src);
const shapeBody = shapeFn ? shapeFn[0] : '';
assert('FoliaDiagnostics exposes logFolderCommand (the testable argv shape)', !!shapeFn, shapeBody ? 'found' : 'missing');
assert('switch and path are SEPARATE arguments',
    /listOf\(\s*"explorer\.exe"\s*,\s*"\/select,"\s*,/.test(shapeBody),
    shapeBody.match(/listOf\([^)]*\)/g)?.join(' | ') ?? null);
assert('no "/select,${...}" concatenation left in the command builder',
    !/"\/select,\s*\$\{/.test(shapeBody),
    /"\/select,\s*\$\{/.test(shapeBody) ? 'found "/select,${...}"' : '');

// ------------------------------------------------- real Kotlin callsite: the EXECUTED argv ----
//
// The regex above proves the source LOOKS right. This runs the compiled Kotlin and reads the argv
// it actually produces, because the defect being fixed was exactly a case where the source looked
// right and the process still got the wrong thing. `OpenLogFolderMain` calls the same
// `FoliaDiagnostics.openLogFolder` the 「出现问题」 button reaches and prints `ARGV=[...]` before it
// opens anything; the directory arrives through FOLIA_PLUGIN_DIR so spaces and CJK survive.
//
// Skipped (reported, not silently passed) when the JVM test classes have not been built yet — the
// gate's JVM step builds them, but this suite may run before it on a fresh checkout.
const gradlew = join(ROOT, 'spw-folia', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const jvmProbe = (() => {
    if (!existsSync(gradlew)) return { ran: false, reason: 'gradlew missing' };
    const gradleCwd = join(ROOT, 'spw-folia');
    const r = spawnSync(gradlew, ['--offline', '-q', 'testClasses', '--console=plain'], {
        cwd: gradleCwd,
        encoding: 'utf8',
        timeout: 600000,
        shell: process.platform === 'win32',
    });
    if (r.status !== 0) return { ran: false, reason: 'testClasses build failed: ' + `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-400) };

    // The runtime classpath has to come from Gradle: the plugin compiles against Kotlin's stdlib
    // without bundling it (the SPW host provides it at runtime), so a hand-built `-cp` with only the
    // classes dir dies with NoClassDefFoundError kotlin/jvm/internal/Intrinsics. Printing it is
    // cheaper and more honest than guessing the Gradle cache paths.
    //
    // `sourceSets` is reached through `extensions.findByName` rather than as a Kotlin/Java DSL
    // property: an init script (`-I`) is evaluated before this project's build script registers the
    // extension, so a plain `sourceSets.test` reference there fails.
    const cpScript = join(ROOT, 'packaging', 'out', 'log-folder', 'print-test-cp.gradle');
    writeFileSync(cpScript, [
        'allprojects {',
        '    tasks.register("printTestRuntimeClasspath") {',
        '        doLast {',
        '            def ss = project.extensions.findByName("sourceSets")',
        '            if (ss == null) { println("TEST_CP=NO_SOURCESETS"); return }',
        '            println("TEST_CP=" + ss.getByName("test").runtimeClasspath.asPath)',
        '        }',
        '    }',
        '}',
        '',
    ].join('\n'));
    const cpRun = spawnSync(gradlew, ['--offline', '-q', '-I', cpScript, 'printTestRuntimeClasspath', '--console=plain'], {
        cwd: gradleCwd,
        encoding: 'utf8',
        timeout: 600000,
        shell: process.platform === 'win32',
    });
    const cpText = `${cpRun.stdout || ''}${cpRun.stderr || ''}`;
    const cpMatch = /TEST_CP=(.+)/.exec(cpText);
    if (!cpMatch || cpMatch[1].trim() === 'NO_SOURCESETS') {
        return { ran: false, reason: 'could not resolve the test runtime classpath: ' + cpText.trim().slice(-300) };
    }

    const r2 = spawnSync('java', ['-cp', cpMatch[1].trim(), 'dev.spw.folia.OpenLogFolderMain'], {
        cwd: gradleCwd,
        encoding: 'utf8',
        timeout: 120000,
        env: {
            ...process.env,
            FOLIA_PLUGIN_DIR: join(ROOT, 'packaging', 'out', 'log folder probe dir'),
            // Print the argv, do NOT open a window: this suite must be safe to run unattended.
            FOLIA_OPEN_LOG_FOLDER_DRY_RUN: '1',
        },
    });
    const out = `${r2.stdout || ''}${r2.stderr || ''}`;
    // Gradle/JVM output is UTF-8 here, so the CJK/spaced path survives intact.
    const m = /^ARGV=\[(.*)\]$/m.exec(out);
    return { ran: true, argvLine: m ? m[1] : null, out: out.trim().slice(-800), status: r2.status };
})();

if (jvmProbe.ran && jvmProbe.argvLine) {
    // `ARGV=[explorer.exe, /select,, C:\...\spw-folia.log]` — split on the SEPARATOR ", " but keep
    // the switch token intact (it ends with a comma of its own, hence the double comma in the line).
    const argv = jvmProbe.argvLine.split(', ');
    assert('executed Kotlin callsite emits 3 argv entries', argv.length === 3, JSON.stringify(argv));
    assert('executed Kotlin callsite keeps the switch as its OWN argument', argv[1] === '/select,', JSON.stringify(argv[1]));
    assert('executed Kotlin callsite never embeds a quote in the switch', !(argv[1] || '').includes('"'), JSON.stringify(argv[1]));
    assert('executed Kotlin callsite passes the full path unchanged',
        /log folder probe dir[\\/]+spw-folia\.log$/.test(argv[2] || ''), JSON.stringify(argv[2]));
} else {
    assert('executed Kotlin callsite emits 3 argv entries', false,
        jvmProbe.ran ? 'no ARGV line: ' + jvmProbe.out : jvmProbe.reason);
}

// ------------------------------------------- dynamic: what explorer actually does with it ----

/**
 * Reads back every open Explorer window: its folder URL and the names of its selected items.
 * Returns [] when none are open. Any COM failure is reported, never swallowed into "none".
 *
 * The JSON is emitted Base64-encoded from UTF-8 bytes on purpose: this repo lives under a path with
 * CJK characters (`D:\输出目录\...`) and PowerShell's default console code page mangles them, which
 * silently broke the first version of this gate (the target directory never compared equal).
 */
const SNAPSHOT_PS = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$rows = @()
foreach ($w in @($shell.Windows())) {
    $url = $null
    try { $url = $w.LocationURL } catch { }
    if (-not $url) { continue }
    $sel = @()
    try { foreach ($i in @($w.Document.SelectedItems())) { if ($i) { $sel += [string]$i.Name } } } catch { }
    $rows += [pscustomobject]@{ Url = $url; Selected = ($sel -join '|') }
}
$json = $rows | ConvertTo-Json -Compress -Depth 4
if (-not $json) { $json = '[]' }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;

const CLOSE_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
foreach ($w in @($shell.Windows())) { try { $w.Quit() } catch { } }
Start-Sleep -Milliseconds 900
`;

const ps = (script) => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        timeout: 60000,
    });
    return { status: r.status, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}`.trim() };
};

/** Decodes the Base64/UTF-8 JSON envelope [SNAPSHOT_PS] prints. Throws on garbage on purpose. */
const decodeSnapshot = (base64) => {
    const text = Buffer.from(String(base64 || '').trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
};

const closeAll = () => {
    ps(CLOSE_PS);
    let rows;
    try {
        rows = decodeSnapshot(ps(SNAPSHOT_PS).out);
    } catch (err) {
        throw new Error('could not read the Explorer window list after closing windows: ' + err.message);
    }
    return rows.length;
};

const decodePath = (url) => {
    if (typeof url !== 'string') return '';
    if (!url.startsWith('file:///')) return url;
    let p = url.slice('file:///'.length);
    try {
        p = decodeURIComponent(p);
    } catch { /* keep raw */ }
    return p.replace(/\//g, '\\');
};

/**
 * Spawns explorer.exe with [args] (the shape under test), waits, and returns what Explorer shows.
 * Explorer windows are closed before AND after, so a leftover window can never be attributed here.
 */
const runShape = (label, args, targetDir, targetFile) => {
    const leftovers = closeAll();
    const res = spawnSync('explorer.exe', args, { timeout: 20000, windowsVerbatimArguments: false });
    // explorer.exe returns immediately; give the window time to appear and settle.
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 2600'], { timeout: 20000 });
    let rows;
    let probeErr = null;
    try {
        rows = decodeSnapshot(ps(SNAPSHOT_PS).out);
    } catch (err) {
        rows = [];
        probeErr = err.message;
    }
    closeAll();

    const windows = rows.map((r) => ({ path: decodePath(r.Url), selected: String(r.Selected || '') }));
    const landedDir = windows.some((w) => w.path.replace(/[\\]+$/, '').toLowerCase() === targetDir.replace(/[\\]+$/, '').toLowerCase());
    const landedFile = windows.some((w) => w.selected.split('|').includes(targetFile));
    const inDocuments = windows.some((w) => /\\Documents$/i.test(w.path));
    return { label, args, leftovers, spawnStatus: res.status, windows, landedDir, landedFile, inDocuments, probeErr };
};

const targetLog = join(ROOT, 'packaging', 'web', 'settings', 'settings-ui.js');
const fallback = join(ROOT, 'spw-folia', 'src', 'main', 'kotlin', 'dev', 'spw', 'folia', 'FoliaPlugin.kt');
const scenarioFile = existsSync(targetLog) ? targetLog : fallback;
const scenarioDir = dirname(scenarioFile);
const scenarioName = scenarioFile.split(/[\\/]/).pop();

// A path WITHOUT a space is the control the old code accidentally handled: the bug only bites when
// ProcessBuilder adds quotes. Both scenarios run so the report shows the asymmetry explicitly.
const spacedDir = join(ROOT, 'packaging', 'out', 'log folder probe dir');
mkdirSync(spacedDir, { recursive: true });
const spacedFile = join(spacedDir, 'spw-folia.log');
writeFileSync(spacedFile, 'probe\n');

const scenarios = [
    { id: 'real', dir: scenarioDir, file: scenarioName, filePath: scenarioFile },
    { id: 'with-space', dir: spacedDir, file: 'spw-folia.log', filePath: spacedFile },
];

const reports = [];
for (const sc of scenarios) {
    // The shape the plugin ships (three-argument form): must land + select.
    const good = runShape(`${sc.id}: plugin shape`, ['/select,', sc.filePath], sc.dir, sc.file);
    // Negative control 1: the shipped v0.4.16 bug.
    const bug = runShape(`${sc.id}: v0.4.16 shape`, [`/select,${sc.filePath}`], sc.dir, sc.file);
    // Negative control 2: the tempting "hand-quote the inside" non-fix.
    const quoted = runShape(`${sc.id}: hand-quoted shape`, [`/select,"${sc.filePath}"`], sc.dir, sc.file);
    reports.push({ scenario: sc.id, dir: sc.dir, file: sc.file, good, bug, quoted });

    assert(`[${sc.id}] plugin shape lands in the log folder`, good.landedDir, good.windows.map((w) => w.path).join(' ; ') || '(no window)');
    assert(`[${sc.id}] plugin shape selects the log file`, good.landedFile, good.windows.map((w) => w.selected).join(' ; '));
    assert(`[${sc.id}] plugin shape does not open Documents`, !good.inDocuments, good.windows.map((w) => w.path).join(' ; '));
}

// ------------------------------------------------------------------- negative controls ----

for (const r of reports) {
    if (r.scenario !== 'with-space') continue;
    // On a path containing a space the old shape must fail. If it "passes" here, the gate itself is
    // broken (probably a stale window) — that is a failure of this suite, not a success.
    assert('negative control: v0.4.16 shape FAILS on a path with a space', !r.bug.landedFile, r.bug.windows.map((w) => `${w.path} sel=${w.selected}`).join(' ; '));
    assert('negative control: hand-quoted shape FAILS on a path with a space', !r.quoted.landedFile, r.quoted.windows.map((w) => `${w.path} sel=${w.selected}`).join(' ; '));
    // The old shape must not land in the log folder. It falls back to Explorer's own start location,
    // which is 「文档」 on a default profile but 「桌面」/「快速访问」 when the user configured one —
    // so the assertion is "wrong folder", not "specifically Documents". Asserting Documents by name
    // would make this gate machine-dependent and start failing on a perfectly correct build.
    assert('negative control: v0.4.16 shape does NOT land in the log folder', !r.bug.landedDir, r.bug.windows.map((w) => w.path).join(' ; '));
}

const report = {
    at: new Date().toISOString(),
    source: diagKt,
    shapeBody,
    reports,
    checks,
    pass: checks.every((c) => c.ok),
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.ok ? '' : '  -> ' + JSON.stringify(c.detail)));
console.log('\n' + (report.pass ? 'PASS' : 'FAIL') + '  ' + checks.filter((c) => c.ok).length + '/' + checks.length + ' checks');
process.exit(report.pass ? 0 : 1);
