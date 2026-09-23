// Documentation link check (plan §7, commit 11). Every relative Markdown link
// in the maintained documentation must point at a file that exists and, when it
// has a #fragment, at a heading that exists in that file (GitHub slug rules).
// External links are not fetched. docs/reference/ is the verbatim specification
// and is not ours to edit, so it is a link target but not checked itself.
//
//   node scripts/check-docs.mjs        exit 0 = all links resolve, 1 = broken links listed

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'README.md',
  'ops/backup/README.md',
  ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
];

/** Text outside fenced code blocks and inline code, where links are real. */
function prose(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** GitHub heading anchors: lower case, drop punctuation, each space → "-", duplicates get -1, -2 … Inline-code backticks are dropped, their words kept. */
function headingAnchors(file) {
  const seen = new Map();
  const out = new Set();
  const text = readFileSync(file, 'utf8').replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const base = m[1].replace(/`/g, '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const cache = new Map();
const anchorsOf = (file) => {
  if (!cache.has(file)) cache.set(file, headingAnchors(file));
  return cache.get(file);
};

const broken = [];
let checked = 0;
for (const src of SOURCES) {
  const path = join(ROOT, src);
  if (!existsSync(path)) { broken.push(`${src}: listed source is missing`); continue; }
  const text = prose(readFileSync(path, 'utf8'));
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    checked += 1;
    const [file, fragment] = target.split('#');
    const resolved = file ? resolve(dirname(path), decodeURI(file)) : path;
    const where = `${src}: (${target})`;
    if (!existsSync(resolved)) { broken.push(`${where} — no such file`); continue; }
    if (fragment === undefined || fragment === '') continue;
    if (statSync(resolved).isDirectory() || !resolved.endsWith('.md')) { broken.push(`${where} — anchor on a non-Markdown target`); continue; }
    if (!anchorsOf(resolved).has(decodeURIComponent(fragment))) broken.push(`${where} — no heading #${fragment} in ${relative(ROOT, resolved)}`);
  }
}

if (broken.length) {
  console.error(`Broken documentation links (${broken.length}):\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`Documentation links OK: ${checked} links in ${SOURCES.length} files.`);
