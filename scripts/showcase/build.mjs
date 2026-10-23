/**
 * Captures the product in English and Chinese and writes the finished images to
 * docs/assets/showcase/<lang>/. The raw captures stay in a temporary directory.
 *
 *   node scripts/showcase/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
/** Whole product screens kept next to the composed images, for the screenshot tour. */
const screens = { 'desktop-dark': 'dark', domain: 'domain' };

for (const lang of ['en', 'zh-CN']) {
  const raw = await mkdtemp(path.join(os.tmpdir(), `cloud-harness-captures-${lang}-`));
  try {
    const out = path.join(repo, 'docs/assets/showcase', lang);
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    const run = (script, ...args) =>
      execFileSync(process.execPath, [path.join(here, script), '--lang', lang, ...args], {
        cwd: repo,
        stdio: 'inherit',
      });
    run('capture.mjs', '--out', raw);
    run('compose.mjs', '--raw', raw, '--out', out);
    for (const [from, to] of Object.entries(screens))
      await copyFile(path.join(raw, `${from}.png`), path.join(out, `${to}.png`));
  } finally {
    await rm(raw, { recursive: true, force: true });
  }
}
