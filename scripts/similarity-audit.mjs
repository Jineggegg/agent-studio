#!/usr/bin/env node
// Mechanical comparison of two source trees, used to check that this code base
// shares no copied code with another one. It reports numbers and locations in
// *our* tree; it never prints the other tree's content.
//
//   node scripts/similarity-audit.mjs --ours . --theirs /path/to/other [--json report.json]
//
// Three measures, from coarse to strict:
//   1. identical significant lines  — after whitespace normalisation, ignoring
//      imports, short lines and punctuation-only lines;
//   2. shared windows of 6 consecutive significant lines — the classic sign of
//      copy-and-paste; isolated identical lines are common between any two
//      TypeScript projects, six in a row are not;
//   3. for each of our files, the best-matching file on the other side by
//      overlap of 3-line windows.
// It also counts long, distinctive identifiers declared here that appear there.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const ours = option('ours');
const theirs = option('theirs');
if (!ours || !theirs) {
  console.error('Usage: node scripts/similarity-audit.mjs --ours <dir> --theirs <dir> [--json <file>] [--ext ts,tsx,js,jsx,mjs,cjs,css,html]');
  process.exit(2);
}
const extensions = new Set(option('ext', 'ts,tsx,js,jsx,mjs,cjs,css,html').split(',').map((ext) => `.${ext}`));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', 'build', 'coverage', '.git', '.vite', 'playwright-report', 'test-results', '.next', 'out', 'vendor']);
const SKIP_FILES = /(\.min\.(js|css)$|\.d\.ts$|package-lock\.json$|\.map$)/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name)) && !SKIP_FILES.test(entry.name)) {
      if (statSync(full).size <= 2 * 1024 * 1024) yield full;
    }
  }
}

const IMPORT = /^(import\b|export\s+(\*|\{[^}]*\})\s+from\b|const\s+\{?[\w\s,{}:]*\}?\s*=\s*require\()/;
function significantLines(text) {
  const result = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const normalised = lines[index].trim().replace(/\s+/g, ' ');
    if (normalised.length < 30) continue;
    if (IMPORT.test(normalised)) continue;
    if (!/[A-Za-z]{3}/.test(normalised)) continue;
    result.push({ text: normalised, line: index + 1 });
  }
  return result;
}
const hash = (text) => createHash('sha1').update(text).digest('base64').slice(0, 16);

function index(root) {
  const files = [];
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    const lines = significantLines(text);
    files.push({ file: path.relative(root, file), lines, text });
  }
  return files;
}

const windows = (lines, size) => {
  const result = [];
  for (let start = 0; start + size <= lines.length; start += 1) {
    result.push({ key: hash(lines.slice(start, start + size).map((entry) => entry.text).join('\n')), line: lines[start].line });
  }
  return result;
};

console.error('Indexing…');
const mine = index(path.resolve(ours));
const other = index(path.resolve(theirs));

// 1. identical significant lines
const otherLines = new Set();
for (const file of other) for (const entry of file.lines) otherLines.add(entry.text);
const myUnique = new Map();
for (const file of mine) for (const entry of file.lines) if (!myUnique.has(entry.text)) myUnique.set(entry.text, `${file.file}:${entry.line}`);
const sharedLines = [...myUnique.entries()].filter(([text]) => otherLines.has(text));

// 2. shared six-line windows
const otherSix = new Set();
for (const file of other) for (const window of windows(file.lines, 6)) otherSix.add(window.key);
const sharedWindows = [];
for (const file of mine) {
  let run = null;
  for (const window of windows(file.lines, 6)) {
    if (otherSix.has(window.key)) {
      if (run && window.line - run.last <= 12) run.last = window.line;
      else sharedWindows.push((run = { file: file.file, first: window.line, last: window.line }));
    }
  }
}

// 3. best-matching file by three-line windows
const otherThree = other.map((file) => ({ file: file.file, keys: new Set(windows(file.lines, 3).map((window) => window.key)) }));
const inverted = new Map();
otherThree.forEach((file, position) => {
  for (const key of file.keys) {
    let list = inverted.get(key);
    if (!list) inverted.set(key, (list = []));
    list.push(position);
  }
});
const fileMatches = [];
for (const file of mine) {
  const keys = new Set(windows(file.lines, 3).map((window) => window.key));
  if (keys.size < 8) continue;
  const counts = new Map();
  for (const key of keys) for (const position of inverted.get(key) ?? []) counts.set(position, (counts.get(position) ?? 0) + 1);
  let best = { position: -1, shared: 0 };
  for (const [position, shared] of counts) if (shared > best.shared) best = { position, shared };
  if (best.shared > 0) {
    const theirKeys = otherThree[best.position].keys.size;
    fileMatches.push({
      file: file.file,
      windows: keys.size,
      shared: best.shared,
      containment: best.shared / keys.size,
      jaccard: best.shared / (keys.size + theirKeys - best.shared),
      bestMatch: otherThree[best.position].file,
    });
  }
}
fileMatches.sort((a, b) => b.containment - a.containment);

// 4. distinctive identifiers
const DECLARATION = /\b(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]{13,})/g;
const myIdentifiers = new Map();
for (const file of mine) for (const match of file.text.matchAll(DECLARATION)) if (!myIdentifiers.has(match[1])) myIdentifiers.set(match[1], file.file);
const otherText = other.map((file) => file.text).join('\n');
const otherWords = new Set(otherText.match(/[A-Za-z_$][\w$]{13,}/g) ?? []);
const sharedIdentifiers = [...myIdentifiers.entries()].filter(([name]) => otherWords.has(name));

const count = (files) => files.reduce((total, file) => total + file.lines.length, 0);
const report = {
  generatedAt: new Date().toISOString(),
  ours: { files: mine.length, significantLines: count(mine), uniqueSignificantLines: myUnique.size },
  theirs: { files: other.length, significantLines: count(other) },
  identicalLines: { count: sharedLines.length, shareOfOurs: sharedLines.length / Math.max(1, myUnique.size) },
  sharedSixLineWindows: { regions: sharedWindows.length, locations: sharedWindows },
  filesWithHighestOverlap: fileMatches.slice(0, 25),
  filesOverTenPercentContainment: fileMatches.filter((match) => match.containment >= 0.1).length,
  distinctiveIdentifiers: { declaredHere: myIdentifiers.size, alsoThere: sharedIdentifiers.length, names: sharedIdentifiers.map(([name, file]) => ({ name, file })) },
  identicalLineSamples: sharedLines.slice(0, 400).map(([text, where]) => ({ where, text })),
};

const jsonPath = option('json');
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const percent = (value) => `${(value * 100).toFixed(2)}%`;
console.log(`Ours:   ${report.ours.files} files, ${report.ours.uniqueSignificantLines} unique significant lines`);
console.log(`Theirs: ${report.theirs.files} files, ${report.theirs.significantLines} significant lines`);
console.log(`Identical significant lines:        ${report.identicalLines.count} (${percent(report.identicalLines.shareOfOurs)} of ours)`);
console.log(`Regions sharing 6+ consecutive lines: ${report.sharedSixLineWindows.regions}`);
for (const region of sharedWindows.slice(0, 40)) console.log(`    ${region.file}:${region.first}-${region.last + 5}`);
console.log(`Files with ≥10% of their 3-line windows found in one file there: ${report.filesOverTenPercentContainment}`);
for (const match of fileMatches.slice(0, 10)) console.log(`    ${percent(match.containment).padStart(7)}  ${match.file}  (${match.shared}/${match.windows} windows)`);
console.log(`Distinctive identifiers declared here that also occur there: ${report.distinctiveIdentifiers.alsoThere} of ${report.distinctiveIdentifiers.declaredHere}`);
for (const { name, file } of report.distinctiveIdentifiers.names.slice(0, 40)) console.log(`    ${name}  (${file})`);
