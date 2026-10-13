#!/usr/bin/env node
// Supply-chain guard: every package in the lockfile must come from the public
// npm registry over https and carry an integrity hash. A pull request that
// points a dependency at a tarball URL or a git repository fails here.
import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const problems = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (location === '' || entry.link) continue;
  if (!location.includes('node_modules/')) continue; // a workspace package
  if (!entry.resolved?.startsWith('https://registry.npmjs.org/')) problems.push(`${location}: resolved from ${entry.resolved ?? 'nowhere'}`);
  if (!entry.integrity?.startsWith('sha512-')) problems.push(`${location}: missing sha512 integrity`);
  if (entry.hasInstallScript && !entry.optional && !entry.dev) problems.push(`${location}: a runtime dependency with an install script`);
}
if (problems.length > 0) {
  console.error('Lockfile problems:\n' + problems.map((problem) => `  - ${problem}`).join('\n'));
  process.exit(1);
}
console.log(`Lockfile OK: ${Object.keys(lock.packages).length - 1} entries, all from registry.npmjs.org with integrity hashes.`);
