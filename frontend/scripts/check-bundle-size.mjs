#!/usr/bin/env node
// scripts/check-bundle-size.mjs
// B-19 — gzipped bundle budget gate (Section 2.8).
//
// Vite's own chunkSizeWarningLimit measures RAW kB and is a warning only; it
// was being raised from 200 to 250 while the entry sat at 266 KB *gzipped*,
// which silenced the symptom without moving the metric. This script enforces
// the real budget and fails CI.
//
// Usage:  node scripts/check-bundle-size.mjs [distDir]
// Exit 0 = within budget, exit 1 = over budget (CI fails).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const ASSETS = join(DIST, 'assets');

const ENTRY_BUDGET_KB = 200; // everything index.html loads on a cold cache, gzipped
const CHUNK_BUDGET_KB = 150; // any single chunk, gzipped

// V04 fix: the kit version picked entry files by name (index-*, vendor-react-*),
// so a shared chunk loaded at startup under any other name was not counted and
// the gate under-reported the initial load. The entry set is now exactly what
// index.html loads: its module script plus every modulepreload (Vite lists the
// entry's transitive static imports there).
function initialLoadFiles() {
  const html = join(DIST, 'index.html');
  if (!existsSync(html)) {
    console.error(`check-bundle-size: no ${html} — cannot determine the initial load.`);
    process.exit(1);
  }
  const src = readFileSync(html, 'utf8');
  const refs = [
    ...src.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g),
    ...src.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g),
  ].map((m) => m[1].split('/').pop());
  if (refs.length === 0) {
    console.error('check-bundle-size: index.html loads no module script — refusing to pass.');
    process.exit(1);
  }
  return new Set(refs);
}
const ENTRY_FILES = initialLoadFiles();

if (!existsSync(ASSETS)) {
  console.error(`check-bundle-size: no build output at ${ASSETS} — run the build first.`);
  process.exit(1);
}

const gzKb = (file) => gzipSync(readFileSync(join(ASSETS, file))).length / 1024;

const jsFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
if (jsFiles.length === 0) {
  console.error(`check-bundle-size: no .js files in ${ASSETS}.`);
  process.exit(1);
}

let entryKb = 0;
const failures = [];
const report = [];

for (const f of jsFiles.sort()) {
  const kb = gzKb(f);
  const isEntry = ENTRY_FILES.has(f);
  if (isEntry) entryKb += kb;

  report.push(`  ${kb.toFixed(2).padStart(8)} KB gz  ${f}${isEntry ? '   [entry]' : ''}`);

  if (kb > CHUNK_BUDGET_KB) {
    failures.push(`chunk ${f}: ${kb.toFixed(2)} KB gz > ${CHUNK_BUDGET_KB} KB`);
  }
}

if (entryKb > ENTRY_BUDGET_KB) {
  failures.push(`entry bundle: ${entryKb.toFixed(2)} KB gz > ${ENTRY_BUDGET_KB} KB`);
}

console.log('Bundle sizes (gzipped):');
console.log(report.join('\n'));
console.log(`\nEntry total: ${entryKb.toFixed(2)} KB gz (budget ${ENTRY_BUDGET_KB} KB)`);

if (failures.length > 0) {
  console.error('\nBUNDLE BUDGET EXCEEDED:');
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(
    '\nReduce the bundle (route-splitting, dynamic imports, per-icon imports, ' +
      'dayjs locale trimming). Do NOT raise the budget to make this pass.',
  );
  process.exit(1);
}

console.log('\nBundle budget OK.');
