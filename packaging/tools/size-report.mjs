#!/usr/bin/env node
// Produce packaging/size-report.json + a human summary of the staged package tree.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'packaging');
const areas = ['web', 'native', 'licenses'];

function walk(dir) {
  const out = [];
  let bytes = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = walk(p);
      out.push(...sub.files);
      bytes += sub.bytes;
    } else {
      const s = statSync(p).size;
      out.push({ path: relative(PKG, p).replace(/\\/g, '/'), bytes: s });
      bytes += s;
    }
  }
  return { files: out, bytes };
}

const report = { generatedAt: new Date().toISOString(), areas: {}, totalBytes: 0, totalFiles: 0, biggest: [] };
for (const area of areas) {
  const dir = join(PKG, area);
  let r;
  try { r = walk(dir); } catch { r = { files: [], bytes: 0 }; }
  report.areas[area] = { files: r.files.length, bytes: r.bytes, mb: +(r.bytes / 1048576).toFixed(2) };
  report.totalBytes += r.bytes;
  report.totalFiles += r.files.length;
  report.biggest.push(...r.files);
}
report.biggest.sort((a, b) => b.bytes - a.bytes);
report.biggest = report.biggest.slice(0, 15);
report.totalMB = +(report.totalBytes / 1048576).toFixed(2);
// This measures the *staging directory* (uncompressed), which is ~2.2x the `.spmod` a user
// actually downloads (26.19 MB staging -> 11.89 MB zip at v0.4.7). It is a bloat tripwire, not a
// user-facing size: the 25 MB it used to carry was compared against a number that had been
// meaningful before settings-island dedupe, so a healthy package reported OVER (see P4-10).
// The budget that protects users is enforced on the shipped `.spmod` in assemble-release.py.
// Kept at 32 MB = current 26.19 MB + ~22% headroom: enough to catch a P4-8-style regression
// (+54% / +7 MB) on the first run, without flagging normal growth.
report.budgetMB = 32;
report.budgetScope = 'staging (uncompressed); the shipped .spmod budget lives in assemble-release.py';
report.withinBudget = report.totalMB <= report.budgetMB;
writeFileSync(join(PKG, 'size-report.json'), JSON.stringify(report, null, 2));

const lines = [];
lines.push(`staging size: ${report.totalMB} MB (${report.totalFiles} files) — tripwire ${report.budgetMB} MB: ${report.withinBudget ? 'OK' : 'OVER'}`);
lines.push(`  (uncompressed staging is ~2.2x the shipped .spmod; the user-facing budget is checked at assembly)`);
for (const area of areas) {
  const a = report.areas[area];
  lines.push(`  ${area.padEnd(9)} ${String(a.files).padStart(4)} files  ${String(a.mb).padStart(7)} MB`);
}
lines.push('top files:');
for (const f of report.biggest.slice(0, 8)) lines.push(`  ${(f.bytes / 1048576).toFixed(2).padStart(7)} MB  ${f.path}`);
console.log(lines.join('\n'));
