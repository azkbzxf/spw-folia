#!/usr/bin/env node
// Overlay the committed image overrides onto a freshly staged web tree.
//
//   node packaging/tools/apply-image-overrides.mjs [--web packaging/web] [--overrides packaging/image-overrides]
//
// Stage order matters: `stage-web.mjs` must have written `packaging/web` first (it
// copies the untouched upstream dist and performs the settings-asset dedupe, which
// matches files by sha/name), then this pass replaces the heavy illustrations with
// the palette-PNG / q88-JPEG variants. `build-package.sh` wires the two together.
//
// The override files keep the upstream file names and formats, so no URL/token
// rewriting is involved and dynamic asset lookups keep working. Missing targets are
// reported instead of failing: after a Folia upgrade the content hashes change and
// `make-image-overrides.py` has to be re-run.

import { copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

function fail(message) {
  console.error(`[images] ${message}`);
  process.exit(2);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a path`);
  return value;
}

const root = resolve(import.meta.dirname, '..', '..');
const webDir = resolve(root, option('--web', 'packaging/web'));
const overridesDir = resolve(root, option('--overrides', 'packaging/image-overrides'));

function walk(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full, base));
    } else if (entry.isFile() && entry.name !== 'MANIFEST.md') {
      files.push(relative(base, full).split(sep).join('/'));
    }
  }
  return files;
}

let overrides;
try {
  overrides = walk(overridesDir);
} catch (error) {
  fail(`cannot read override directory ${overridesDir}: ${error.message}`);
}

let applied = 0;
let before = 0;
let after = 0;
const missing = [];

for (const rel of overrides) {
  if (!rel.startsWith('assets/') && !rel.startsWith('preview/')) {
    fail(`unexpected override path (only assets/ and preview/ are allowed): ${rel}`);
  }
  const source = join(overridesDir, rel);
  const target = join(webDir, rel);
  let targetSize;
  try {
    targetSize = statSync(target).size;
  } catch {
    missing.push(rel);
    continue;
  }
  const sourceSize = statSync(source).size;
  if (sourceSize >= targetSize) {
    console.warn(`[images] skip ${rel}: override is not smaller (${sourceSize} >= ${targetSize})`);
    continue;
  }
  copyFileSync(source, target);
  applied += 1;
  before += targetSize;
  after += sourceSize;
}

const mebibyte = 1024 * 1024;
const saved = (before - after) / mebibyte;
console.log(
  `[images] overlaid ${applied}/${overrides.length} file(s): ${(before / mebibyte).toFixed(2)} MB -> ` +
    `${(after / mebibyte).toFixed(2)} MB (saved ${saved.toFixed(2)} MB)`,
);
if (missing.length > 0) {
  console.warn(
    `[images] WARNING ${missing.length} override(s) matched nothing in the staged tree ` +
      `(upstream assets changed? re-run packaging/tools/make-image-overrides.py)`,
  );
  for (const rel of missing) console.warn(`[images]   missing target: ${rel}`);
}
