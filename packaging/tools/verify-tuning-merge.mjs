#!/usr/bin/env node
// Gate: "defaults first, persisted values on top" tuning merge (issue #18 item 1).
//
// WHY THIS EXISTS
// Folia 0.7.25 added `depthOfField` / `depthPan` / `glyphDepth` to `TemperaTuning`. The page used to
// hydrate its store with `{ ...state.styleTunings, ...snapshot.styleTunings }` — a WHOLE-OBJECT
// replacement per style — so every settings tree persisted before that release handed Folia's
// renderer a tempera bag without those three keys. `defineVisualizerTuning.apply` stores the bag
// verbatim (it never runs the style's own `resolve()`), `temperaShotFrame.ts` then multiplies by
// `undefined`, and the NaN `position` / `scale` / `alpha` silently erased the whole composition:
// 凝彩 rendered background grain and no glyphs at all.
//
// The defect class is generic — ANY future upstream tuning key breaks ANY style whose tree predates
// it — so this gate asserts the invariant rather than the three keys:
//   every style the page publishes carries at least the keys upstream's own defaults carry.
//
// WHAT IT DOES
// It starts from the REAL legacy tree (`packaging/testdata/default-settings.json`, deliberately kept
// without the 0.7.25 keys), runs the REAL `applySnapshot` from `poc/settings-ui/src/model/settings.ts`
// (the shipped source, not a copy) and then the REAL `buildTuningBundle` from
// `poc/settings-ui/src/publisher/config.ts` — the exact bag Folia's renderer receives.
//
// It also proves it can FAIL: the same assertions are replayed against a deliberately broken
// "whole-object replacement" hydration, and the run is aborted if those assertions PASS there. A
// gate that cannot go red is not a gate.
//
// USAGE
//   node packaging/tools/verify-tuning-merge.mjs
// Exit 0 = PASS, 1 = FAIL, 2 = this Node cannot execute the TypeScript sources.
//
// The page sources are plain TypeScript, so this script re-executes itself with
// `--experimental-transform-types` (Node >= 22.7). `verify-all.mjs` runs every suite as
// `node <script>`, so the flag has to come from inside; Node >= 23 does the transform (not just the
// strip) for `.ts` imports once the flag is present, which is what upstream's `types.ts` needs — it
// contains `enum`s, and strip-only mode refuses those.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FOLIA_SRC = join(ROOT, 'work', 'folia', 'folia-major-main', 'src');
const UI_SRC = join(ROOT, 'poc', 'settings-ui', 'src');
const LEGACY_TREE = join(ROOT, 'packaging', 'testdata', 'default-settings.json');

// ---------------------------------------------------------------- runtime bootstrap ----
//
// `process.features.typescript` is 'strip' by default on Node 24 ('transform' only with the flag).
// Re-run ourselves with the flag so the gate stays invocable as a bare `node <file>`.
//
// The env marker stops a runaway: if some Node build accepted the flag but still reported 'strip',
// re-executing would recurse forever. One retry, then fail with a real explanation.

const TRANSFORM_FLAG = '--experimental-transform-types';
const REEXEC_MARK = 'SPW_FOLIA_TUNING_GATE_REEXEC';

if (process.features.typescript !== 'transform') {
    if (process.env[REEXEC_MARK]) {
        console.error(`FAIL  this Node (${process.version}) cannot execute TypeScript sources even with ${TRANSFORM_FLAG}`);
        console.error('      the gate needs Node >= 22.7 (verified with Node 24)');
        process.exit(2);
    }
    const child = spawnSync(
        process.execPath,
        [TRANSFORM_FLAG, '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, [REEXEC_MARK]: '1' } },
    );
    process.exit(child.status === null ? 2 : child.status);
}

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const isFile = (p) => {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
};
const withExtension = (base) => {
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (isFile(base + ext)) return base + ext;
    }
    return null;
};
const filePathOf = (url) => decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Resolves the page's two path aliases (`@/` → the Folia checkout, `~/` → poc/settings-ui/src) and
 * extensionless relative imports, exactly like Vite does for the real bundle.
 */
async function installResolver() {
    const { registerHooks } = await import('node:module');
    registerHooks({
        resolve(specifier, context, nextResolve) {
            const parent = context.parentURL ? filePathOf(context.parentURL) : '';
            if (specifier.startsWith('@/')) {
                const found = withExtension(join(FOLIA_SRC, specifier.slice(2)));
                if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
            }
            if (specifier.startsWith('~/')) {
                const found = withExtension(join(UI_SRC, specifier.slice(2)));
                if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
            }
            if (specifier.startsWith('.') && parent) {
                const found = withExtension(join(dirname(parent), specifier));
                if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
    });
}

// ---------------------------------------------------------------- assertions ----
//
// Each helper returns a list of complaints (empty = satisfied). They are kept independent of the
// implementation under test so the same checks can be replayed against the broken variant.

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Same rule as the old `{ ...state.styleTunings, ...snapshot.styleTunings }` — the defect. */
const wholeObjectHydration = (defaults, persisted) => ({ ...clone(defaults), ...clone(persisted ?? {}) });

/**
 * The publisher as it behaved BEFORE this fix: every bag forwarded verbatim, no defaults laid under
 * it. Kept here so the gate can prove its own checks reject that shape — the real
 * `buildTuningBundle` now backfills, so replaying against it would repair the broken input and
 * make the "can go red" checks vacuously green.
 */
const buildTuningBundleWithoutBackfill = (styleTunings) => {
    const bundle = {};
    for (const [mode, tuning] of Object.entries(styleTunings)) {
        if (mode === 'still') continue;
        bundle[mode] = { ...tuning };
    }
    return bundle;
};

/**
 * The invariant: after hydrating from a tree that predates N upstream tuning keys, every style's
 * published bag must still carry every key upstream's defaults carry — otherwise the renderer sees
 * `undefined` and turns it into NaN.
 *
 * An ABSENT key and a key explicitly set to `undefined` are the same defect from the renderer's
 * point of view (`bag.depthPan` is `undefined` either way), so both count. That matters for the
 * anti-vacuity replay below: a whole-object replacement DROPS the key rather than setting it.
 */
const absentKeys = (defaults, bag) => {
    const keys = Object.keys(defaults ?? {});
    if (!bag || typeof bag !== 'object') return keys;
    return keys.filter((key) => !(key in bag) || bag[key] === undefined);
};

function missingDefaultKeys(defaults, hydrated, ignore = new Set()) {
    const complaints = [];
    for (const mode of Object.keys(defaults)) {
        if (ignore.has(mode)) continue;
        const bag = hydrated[mode];
        if (!bag || typeof bag !== 'object') {
            complaints.push(`${mode}: no tuning bag at all`);
            continue;
        }
        const absent = absentKeys(defaults[mode], bag);
        if (absent.length > 0) complaints.push(`${mode}: missing ${absent.join(', ')}`);
    }
    return complaints;
}

/** Every key present in a published bag must have a real value, never `undefined`. */
function undefinedValues(bag) {
    if (!bag || typeof bag !== 'object') return ['bag is not an object'];
    return Object.entries(bag).filter(([, value]) => value === undefined).map(([key]) => key);
}

// ---------------------------------------------------------------- main ----

async function main() {
    if (!existsSync(LEGACY_TREE)) {
        console.error(`FAIL  missing legacy tree ${LEGACY_TREE}`);
        process.exit(2);
    }
    const legacy = JSON.parse(readFileSync(LEGACY_TREE, 'utf8'));

    await installResolver();
    let settingsModule;
    let publisher;
    try {
        settingsModule = await import(pathToFileURL(join(UI_SRC, 'model', 'settings.ts')).href);
        publisher = await import(pathToFileURL(join(UI_SRC, 'publisher', 'config.ts')).href);
    } catch (error) {
        console.error('FAIL  cannot execute the page sources: ' + (error && (error.code || error.message)));
        process.exit(2);
    }
    const {
        applySnapshot,
        snapshotFromState,
        useSettingsStore,
        STYLE_TUNING_DEFAULTS,
        BACKGROUND_TUNING_DEFAULTS,
        DEFAULT_SHOW_PLAYBACK_BAR,
        resolveShowPlaybackBar,
    } = settingsModule;
    const { buildTuningBundle } = publisher;

    /** Puts the live store back into its first-paint state, the way a fresh page starts. */
    const resetStore = () =>
        useSettingsStore.setState({
            styleTunings: clone(STYLE_TUNING_DEFAULTS),
            backgroundTunings: clone(BACKGROUND_TUNING_DEFAULTS),
            showPlaybackBar: DEFAULT_SHOW_PLAYBACK_BAR,
        });
    const hydrate = (tree) => {
        resetStore();
        applySnapshot(tree);
        return useSettingsStore.getState();
    };

    // ------------------------------------------------------------ fixtures ----
    //
    // The shipped tree (`packaging/testdata/default-settings.json`) must be CURRENT — a fresh install
    // should publish complete bags even if `applySnapshot` were never involved. So the legacy trees
    // this gate hydrates are built by REMOVING keys from it, which is exactly what a tree persisted
    // by an older build looks like. Deriving them here (instead of storing a second fixture on disk)
    // keeps the simulation honest: it is always "the real tree minus the keys that release added".
    const depthKeys = ['depthOfField', 'depthPan', 'glyphDepth'];
    const fixtureCurrent = depthKeys.every((key) => key in (legacy.styleTunings.tempera ?? {}));
    record(
        'shipped tree carries the 0.7.25 tempera keys',
        fixtureCurrent,
        fixtureCurrent ? '' : 'default-settings.json is stale — a fresh install would ship the broken bag',
    );

    /** `tree` with `keys` deleted from one tuning bag. */
    const withoutKeys = (tree, { styles = {}, backgrounds = {} }) => {
        const cut = clone(tree);
        for (const [mode, keys] of Object.entries(styles)) {
            for (const key of keys) delete cut.styleTunings?.[mode]?.[key];
        }
        for (const [mode, keys] of Object.entries(backgrounds)) {
            for (const key of keys) delete cut.backgroundTunings?.[mode]?.[key];
        }
        return cut;
    };

    // The exact reproduction of issue #18: a tree persisted before 0.7.25.
    const legacyTemperaTree = withoutKeys(legacy, { styles: { tempera: depthKeys } });
    const legacyIndeedLacks = depthKeys.every((key) => !(key in legacyTemperaTree.styleTunings.tempera));
    record(
        'simulated legacy tree really lacks the 0.7.25 tempera keys',
        legacyIndeedLacks,
        legacyIndeedLacks ? '' : 'key removal did not apply',
    );

    // ------------------------------------------------------------ the real fix ----
    const state = hydrate(legacyTemperaTree);

    const styleComplaints = missingDefaultKeys(STYLE_TUNING_DEFAULTS, state.styleTunings);
    record(
        'every style tuning carries upstream defaults after hydrating a legacy tree',
        styleComplaints.length === 0,
        styleComplaints.slice(0, 4).join('; '),
    );

    const bgComplaints = missingDefaultKeys(BACKGROUND_TUNING_DEFAULTS, state.backgroundTunings);
    record(
        'every background tuning carries upstream defaults after hydrating a legacy tree',
        bgComplaints.length === 0,
        bgComplaints.slice(0, 4).join('; '),
    );

    // The exact bag Folia's renderer receives — the last stop before the NaN maths.
    // `still` has no renderer and no tuning of its own: `buildTuningBundle` deliberately skips it,
    // so the bundle is checked for every OTHER style (its store-side defaults are covered above).
    const bundle = buildTuningBundle(snapshotFromState(state));
    const temperaUndefined = undefinedValues(bundle.tempera);
    record(
        'published tempera bag has no undefined value (the NaN source)',
        temperaUndefined.length === 0,
        temperaUndefined.length ? temperaUndefined.join(', ') : '',
    );
    const bundleComplaints = missingDefaultKeys(STYLE_TUNING_DEFAULTS, bundle, new Set(['still']));
    record(
        'published bundle carries upstream defaults for every style',
        bundleComplaints.length === 0,
        bundleComplaints.slice(0, 4).join('; '),
    );

    // ------------------------------------------------------------ persisted values still win ----
    //
    // "Defaults first" must not become "defaults always": a merge that ignored the overlay would
    // satisfy every check above and still lose the user's settings.
    const tree = clone(legacy);
    tree.styleTunings.tempera = {
        ...tree.styleTunings.tempera,
        cameraIntensity: 0.25,
        colorMode: 'mono',
        layerImages: [{ src: 'a.png', x: 0.25 }, { src: 'b.png', x: 0.75 }],
    };
    tree.backgroundTunings.latent = { ...tree.backgroundTunings.latent, meshSpeed: 1.75 };
    const overridden = hydrate(tree);
    const overlayComplaints = [];
    if (overridden.styleTunings.tempera.cameraIntensity !== 0.25) {
        overlayComplaints.push('tempera.cameraIntensity=' + JSON.stringify(overridden.styleTunings.tempera.cameraIntensity));
    }
    if (overridden.styleTunings.tempera.colorMode !== 'mono') {
        overlayComplaints.push('tempera.colorMode=' + JSON.stringify(overridden.styleTunings.tempera.colorMode));
    }
    if (overridden.styleTunings.tempera.depthPan !== STYLE_TUNING_DEFAULTS.tempera.depthPan) {
        overlayComplaints.push('tempera.depthPan was not defaulted back');
    }
    if (overridden.backgroundTunings.latent.meshSpeed !== 1.75) {
        overlayComplaints.push('latent.meshSpeed=' + JSON.stringify(overridden.backgroundTunings.latent.meshSpeed));
    }
    record('persisted values override the defaults', overlayComplaints.length === 0, overlayComplaints.join('; '));

    // User data must survive as a whole array: spreading it element-wise would pad/pin it to the
    // default `[]` and silently drop the tail.
    const images = overridden.styleTunings.tempera.layerImages;
    const imagesOk = Array.isArray(images) && images.length === 2
        && images[0].src === 'a.png' && images[1].src === 'b.png';
    record('layerImages array is carried over whole', imagesOk, imagesOk ? '' : JSON.stringify(images));

    // A tree written by a NEWER build (mode this build has no defaults for) must not be dropped.
    const future = clone(legacy);
    future.styleTunings.fromTheFuture = { flowIntensity: 0.4 };
    const carried = hydrate(future);
    record(
        'style unknown to this build is carried over untouched',
        carried.styleTunings.fromTheFuture && carried.styleTunings.fromTheFuture.flowIntensity === 0.4,
        JSON.stringify(carried.styleTunings.fromTheFuture),
    );

    // ------------------------------------------------------------ 显示播放条 migration ----
    //
    // Contract (`.scratch/issue18-contract.md`): the tree owns the value; the plugin's legacy
    // injected member seeds it exactly once, for trees that predate the move.
    const migration = [];
    const noKeyNoLegacy = hydrate(clone(legacy));
    if (noKeyNoLegacy.showPlaybackBar !== DEFAULT_SHOW_PLAYBACK_BAR) {
        migration.push('absent key + no legacy member should be the default');
    }
    const seededOff = hydrate({ ...clone(legacy), showPlaybackBarLegacy: false });
    if (seededOff.showPlaybackBar !== false) migration.push('legacy false did not seed');
    const seededOn = hydrate({ ...clone(legacy), showPlaybackBarLegacy: true });
    if (seededOn.showPlaybackBar !== true) migration.push('legacy true did not seed');
    const treeWins = hydrate({ ...clone(legacy), showPlaybackBar: false, showPlaybackBarLegacy: true });
    if (treeWins.showPlaybackBar !== false) migration.push('tree value lost to the legacy member');
    // A stringly-typed member is "not carried", never a truthy toggle.
    const stringly = hydrate({ ...clone(legacy), showPlaybackBarLegacy: 'false' });
    if (stringly.showPlaybackBar !== DEFAULT_SHOW_PLAYBACK_BAR) migration.push('string legacy member was trusted');
    record('显示播放条 migration (tree wins, legacy seeds once)', migration.length === 0, migration.join('; '));

    const snapshot = snapshotFromState(useSettingsStore.getState());
    record(
        'snapshotFromState emits showPlaybackBar (so the page can persist it)',
        typeof snapshot.showPlaybackBar === 'boolean' && snapshot.showPlaybackBar === useSettingsStore.getState().showPlaybackBar,
        JSON.stringify(snapshot.showPlaybackBar),
    );
    record(
        'resolveShowPlaybackBar is null/undefined-safe',
        resolveShowPlaybackBar(null) === DEFAULT_SHOW_PLAYBACK_BAR && resolveShowPlaybackBar(undefined) === DEFAULT_SHOW_PLAYBACK_BAR,
        '',
    );

    // ------------------------------------------------------------ anti-vacuity ----
    //
    // Replay the two core assertions against the OLD whole-object replacement. They must fail there.
    // If they pass, the checks above are measuring nothing and this run is a FAIL.
    const brokenHydration = wholeObjectHydration(STYLE_TUNING_DEFAULTS, legacyTemperaTree.styleTunings);
    const brokenMissing = missingDefaultKeys(STYLE_TUNING_DEFAULTS, brokenHydration);
    // Run the assertion on the structure the RENDERER consumes. The publisher now backfills defaults
    // too (second line of defence), so this replay goes through a forwarding publisher — otherwise
    // the backfill would repair the broken bag and hide the defect from the replay.
    const brokenBundle = buildTuningBundleWithoutBackfill(brokenHydration);
    const brokenTempera = absentKeys(STYLE_TUNING_DEFAULTS.tempera, brokenBundle.tempera);
    record(
        'gate can go red: whole-object replacement fails the default-keys check',
        brokenMissing.length > 0,
        brokenMissing.length ? `${brokenMissing.length} style(s) broken` : 'VACUOUS — the check passes on the broken variant',
    );
    record(
        'gate can go red: whole-object replacement drops tempera keys the renderer needs',
        brokenTempera.length > 0,
        brokenTempera.length ? brokenTempera.join(', ') : 'VACUOUS — the check passes on the broken variant',
    );

    // ------------------------------------------------------------ source guard ----
    //
    // The behavioural checks above already catch a regression; this one names it, so a future
    // reader of the failure does not have to reverse-engineer it.
    //
    // Both tuning fields are checked SEPARATELY: a revert that only put `styleTunings` back (the
    // one that actually shipped the bug) must still be caught, so "some merge call exists in the
    // function" is not good enough.
    const settingsSource = readFileSync(join(UI_SRC, 'model', 'settings.ts'), 'utf8');
    const applyBody = (() => {
        const start = settingsSource.indexOf('export const applySnapshot');
        if (start < 0) return '';
        const end = settingsSource.indexOf('\n};', start);
        return settingsSource.slice(start, end < 0 ? undefined : end);
    })();
    // Slice from the field name to the NEXT object-literal field (`\n    someKey:`), so a value
    // spanning several lines stays intact. A single-line value is fine too: the slice ends at the
    // next field, not at the first comma (the merge call has commas inside its arguments).
    const fieldLine = (field) => {
        const match = new RegExp(`(?:^|[\\s{])${field}:`).exec(applyBody);
        if (!match) return '';
        const start = match.index;
        const rest = applyBody.slice(start + field.length + 1);
        const next = /\n[ \t]+[A-Za-z_$][\w$]*:/.exec(rest);
        return next ? rest.slice(0, next.index) : rest;
    };
    const unmergedFields = [
        ['styleTunings', 'STYLE_TUNING_DEFAULTS'],
        ['backgroundTunings', 'BACKGROUND_TUNING_DEFAULTS'],
    ]
        .filter(([field, defaultsName]) => {
            const line = fieldLine(field);
            // Must go through the merge helper, with this field's own defaults bag.
            return !(new RegExp(`mergeTuningMap\\(\\s*${defaultsName}\\s*,`).test(line));
        })
        .map(([field]) => field);
    record(
        'applySnapshot merges both tuning fields instead of replacing them whole',
        unmergedFields.length === 0,
        unmergedFields.length ? 'not merged via its defaults bag: ' + unmergedFields.join(', ') : '',
    );

    // The publisher is the LAST stop before Folia's renderer and has to hold up on its own: even if
    // a future refactor hands `buildTuningBundle` a bag it never hydrated (a restored snapshot, a
    // dev console override, a new caller), what leaves this function must carry upstream defaults
    // for the styles it publishes. `still` has no renderer and no tuning of its own — the bundle
    // deliberately skips it — and styles this build has never heard of are passed through untouched,
    // so the check is scoped to the styles the input actually carries.
    const bareStyleTunings = withoutKeys(legacy, { styles: { tempera: depthKeys } }).styleTunings;
    const bareBundle = buildTuningBundle({
        ...snapshotFromState(hydrate(legacyTemperaTree)),
        styleTunings: bareStyleTunings,
    });
    const bareScopedDefaults = Object.fromEntries(
        Object.keys(bareBundle).map((mode) => [mode, STYLE_TUNING_DEFAULTS[mode] ?? {}]),
    );
    const bareMissing = missingDefaultKeys(bareScopedDefaults, bareBundle);
    record(
        'publisher backfills upstream defaults even for a never-merged bag',
        bareMissing.length === 0,
        bareMissing.slice(0, 4).join('; '),
    );

    // Anti-vacuity for the check above: it must reject a publisher that just forwards the bag it is
    // given (which is what the code used to do). Without this, a deleted backfill line would leave
    // the check silently satisfied by the store-level merge alone.
    const forwarded = buildTuningBundleWithoutBackfill(bareStyleTunings);
    record(
        'gate can go red: a forwarding-only publisher fails the backfill check',
        missingDefaultKeys(bareScopedDefaults, forwarded).length > 0,
        missingDefaultKeys(bareScopedDefaults, forwarded).length
            ? ''
            : 'VACUOUS — a forwarding publisher would pass',
    );

    // ------------------------------------------------------------ summary ----

    const passed = results.filter((r) => r.ok).length;
    const allOk = passed === results.length;
    console.log(`\n${allOk ? 'PASS' : 'FAIL'}  ${passed}/${results.length} tuning-merge checks`);
    if (!allOk) {
        console.log('\nFailed:');
        for (const r of results.filter((x) => !x.ok)) console.log('  - ' + r.name + (r.detail ? ': ' + r.detail : ''));
    }
    process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
    console.error('FAIL  unexpected error: ' + (error && (error.stack || error.message)));
    process.exit(1);
});
