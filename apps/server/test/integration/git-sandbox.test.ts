/**
 * An agent can write a repository's hooks and configuration, and the Git panel
 * runs git with them. Where the server has a sandbox, those programs run in the
 * agents' `mask` profile: they work as in a terminal but cannot see the
 * Studio's own data. Needs bubblewrap; where it is missing or unusable every
 * test here is skipped with the reason.
 */
import { existsSync } from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '@agent-studio/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGitSandbox, type GitSandbox } from '../../src/modules/git/testing/fixtures.js';
import { createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

let sandbox: GitSandbox;
let t: TestStudio;
let owner: TestClient;
let reason: string | null = null;

beforeEach(async (context) => {
  sandbox = await createGitSandbox();
  t = await createTestStudio({ config: { sandbox: 'auto' } });
  const status = t.studio.context.sandbox.status;
  reason = status.mode === 'bwrap' ? null : `bubblewrap is not usable here (${status.reason ?? 'unknown'})`;
  owner = await t.owner();
  if (reason !== null) context.skip(reason);
});
afterEach(async () => {
  await t.close();
  await sandbox.restore();
});

async function project(name: string): Promise<{ dir: string; url: (suffix: string) => string }> {
  const dir = path.join(t.workspace, name);
  await sandbox.repo(dir);
  const response = await owner.post<Project>('/api/projects', { name, rootDir: dir });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { dir: response.body.rootDir, url: (suffix) => `/api/projects/${response.body.id}/git/${suffix}` };
}

/** A shell script that records what it can see of the data directory. */
function snoop(marker: string): string {
  const data = t.dataDir;
  return `ls -A "${data}" > "${marker}" 2>&1; cat "${data}"/* >> "${marker}" 2>/dev/null; echo snoop-ran >> "${marker}"`;
}

async function secretsOnDisk(): Promise<string[]> {
  const names = await readdir(t.dataDir);
  expect(names.length).toBeGreaterThan(0);
  return names;
}

it('a commit hook planted in the repository runs, but cannot see the Studio data directory', async () => {
  const r = await project('hooked');
  const marker = path.join(sandbox.dir, 'hook-saw');
  const hook = path.join(r.dir, '.git/hooks/pre-commit');
  await writeFile(hook, `#!/bin/sh\n${snoop(marker)}\n`);
  await chmod(hook, 0o755);
  await writeFile(path.join(r.dir, 'a.txt'), 'change\n');

  const committed = await owner.post(r.url('commit'), { message: 'with a hook', paths: ['a.txt'] });
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);

  const seen = await readFile(marker, 'utf8');
  expect(seen).toContain('snoop-ran'); // hooks still run, as in a terminal
  for (const name of await secretsOnDisk()) expect(seen).not.toContain(name);
});

it('a content filter planted in the repository configuration cannot see the Studio data directory when staging', async () => {
  const r = await project('filtered');
  const marker = path.join(sandbox.dir, 'filter-saw');
  const script = path.join(sandbox.dir, 'filter.sh');
  await writeFile(script, `#!/bin/sh\n${snoop(marker)}\ncat\n`);
  await chmod(script, 0o755);
  await writeFile(path.join(r.dir, '.gitattributes'), '*.txt filter=snoop\n');
  const config = path.join(r.dir, '.git/config');
  await writeFile(config, `${await readFile(config, 'utf8')}[filter "snoop"]\n\tclean = ${script}\n`);
  await writeFile(path.join(r.dir, 'b.txt'), 'staged\n');

  const staged = await owner.post(r.url('stage'), { paths: ['b.txt'] });
  expect(staged.status, JSON.stringify(staged.body)).toBe(204);

  expect(existsSync(marker)).toBe(true);
  const seen = await readFile(marker, 'utf8');
  expect(seen).toContain('snoop-ran');
  for (const name of await secretsOnDisk()) expect(seen).not.toContain(name);
});
