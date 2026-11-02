// Unit-level checks for dev.spw.folia.Json.singleLine — the function the v0.4.13 fix relies on.
//
// It must remove ONLY whitespace between JSON tokens. Spaces inside string literals, escaped
// sequences and non-ASCII text must survive byte for byte, because the settings tree carries
// user-visible data (custom font stacks, colours, uploaded-font names) and is replayed verbatim.
//
// Run: node packaging/tools/verify-json-singleline.mjs
// Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import path from 'node:path';

/** Exact port of Json.singleLine (string-literal aware). */
function singleLine(json) {
    let inString = false, escaped = false, out = '';
    for (const c of json) {
        if (inString) {
            out += c;
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
        out += c;
    }
    return out;
}

/** Exact port of Json.needsCollapsing. */
function needsCollapsing(json) {
    let inString = false, escaped = false;
    for (const c of json) {
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '\n' || c === '\r') return true;
    }
    return false;
}

const cases = [];
const check = (label, fn) => {
    try {
        fn();
        cases.push({ label, ok: true });
        console.log('PASS  ' + label);
    } catch (e) {
        cases.push({ label, ok: false, error: String(e) });
        console.log('FAIL  ' + label + '\n        ' + String(e));
    }
};
const eq = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error((what || 'value') + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
    }
};

// ---- 1. whitespace inside strings is preserved -------------------------------------------
check('spaces inside a string literal survive', () => {
    const s = '{"a":  "  keep   me  "  ,  "b": 1}';
    const out = singleLine(s);
    eq(out, '{"a":"  keep   me  ","b":1}');
    eq(JSON.parse(out).a, '  keep   me  ', 'string value');
});

check('escaped quote inside a string does not end it', () => {
    const s = '{"a": "say \\"hi\\" now", "b": 2}';
    const out = singleLine(s);
    eq(JSON.parse(out).a, 'say "hi" now', 'string value');
    eq(JSON.parse(out).b, 2, 'second key');
});

check('escaped backslash before a quote is handled', () => {
    const s = '{"a": "back\\\\", "b": 3}';
    const out = singleLine(s);
    eq(JSON.parse(out).a, 'back\\', 'string value');
    eq(JSON.parse(out).b, 3, 'second key');
});

check('newline escape (\\n) inside a string is not treated as whitespace', () => {
    const s = '{"a": "line1\\nline2", "b": 4}';
    const out = singleLine(s);
    eq(out.indexOf('\n'), -1, 'no real newline in output');
    eq(JSON.parse(out).a, 'line1\nline2', 'decoded value keeps the newline');
});

check('non-ASCII text survives', () => {
    const s = '{"标题": "我的 歌 单", "emoji": "🎵 🎶"}';
    const out = singleLine(s);
    eq(JSON.parse(out)['标题'], '我的 歌 单', 'CJK with spaces');
    eq(JSON.parse(out).emoji, '🎵 🎶', 'emoji');
});

check('custom font stack with spaces survives', () => {
    const s = '{"customFontStack": "Segoe UI, Microsoft YaHei, sans-serif"}';
    const out = singleLine(s);
    eq(JSON.parse(out).customFontStack, 'Segoe UI, Microsoft YaHei, sans-serif');
});

// ---- 2. structure is preserved -------------------------------------------------------------
check('nested objects and arrays stay valid', () => {
    const s = '{\n  "a": {\n    "b": [1, 2, {\n      "c": true\n    }]\n  }\n}';
    const out = singleLine(s);
    eq(out, '{"a":{"b":[1,2,{"c":true}]}}');
    eq(JSON.parse(out), { a: { b: [1, 2, { c: true }] } });
});

check('numbers, booleans and null are untouched', () => {
    const s = '{ "n": 1.5, "i": -42, "t": true, "f": false, "z": null }';
    const out = singleLine(s);
    eq(out, '{"n":1.5,"i":-42,"t":true,"f":false,"z":null}');
    eq(JSON.parse(out), JSON.parse(s));
});

check('already-compact input is returned unchanged', () => {
    const s = '{"a":1,"b":"x y"}';
    eq(singleLine(s), s);
    eq(needsCollapsing(s), false, 'needsCollapsing');
});

// ---- 3. the real bundled tree ---------------------------------------------------------------
const TREE = 'D:/输出目录/spw-folia/packaging/testdata/default-settings.json';
check('the bundled default-settings.json collapses to valid, equivalent JSON', () => {
    const pretty = fs.readFileSync(TREE, 'utf8').trim();
    if (!needsCollapsing(pretty)) throw new Error('expected the bundled tree to be pretty-printed');
    const out = singleLine(pretty);
    if (needsCollapsing(out)) throw new Error('output still contains a bare newline');
    eq(JSON.parse(out), JSON.parse(pretty), 'parsed tree');
    if (out.length >= pretty.length) throw new Error('expected the collision to shrink the payload');
    // Every string value must be identical, not merely "equal after JSON.parse".
    const walk = (a, b, where) => {
        if (typeof a === 'string' && a !== b) throw new Error('string differs at ' + where);
        if (a && typeof a === 'object') for (const k of Object.keys(a)) walk(a[k], b[k], where + '.' + k);
    };
    walk(JSON.parse(pretty), JSON.parse(out), '$');
});

const failed = cases.filter((c) => !c.ok).length;
const outDir = path.join('C:/tmp/trayverify/json-singleline');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(cases, null, 2));
console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED') + '  (' + cases.length + ' checks)');
process.exit(failed === 0 ? 0 : 1);
