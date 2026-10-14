import { constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confine, isInside, mkdirInside, openInside, resolveInside, withDirectoryInside } from './paths.js';

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'studio-paths-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, 'src', 'a.txt'), 'a');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(outside, path.join(root, 'escape'));
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  await symlink(path.join(outside, 'not-yet'), path.join(root, 'dangling'));
  await symlink(path.join(root, 'src'), path.join(root, 'inner'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('accepts paths inside the root', () => {
    expect(resolveInside(root, 'src/a.txt')).toBe(path.join(root, 'src', 'a.txt'));
    expect(resolveInside(root, '')).toBe(root);
    expect(resolveInside(root, 'src/../src/a.txt')).toBe(path.join(root, 'src', 'a.txt'));
  });

  it.each(['../outside/secret.txt', 'src/../../outside', '/etc/passwd', 'C:\\Windows', 'a\0b', '..'])(
    'rejects %j',
    (requested) => {
      expect(() => resolveInside(root, requested)).toThrow();
    },
  );

  it('is not fooled by a sibling whose name starts with the root name', () => {
    expect(isInside(root, root + '-evil/file')).toBe(false);
    expect(isInside(root, path.join(root, 'x'))).toBe(true);
  });
});

describe('confine', () => {
  it('returns the real path for files inside', async () => {
    expect(await confine(root, 'src/a.txt')).toBe(path.join(root, 'src', 'a.txt'));
  });

  it('allows paths that do not exist yet', async () => {
    expect(await confine(root, 'src/new/deep/file.txt')).toBe(path.join(root, 'src', 'new', 'deep', 'file.txt'));
  });

  it('follows links that stay inside', async () => {
    expect(await confine(root, 'inner/a.txt')).toBe(path.join(root, 'src', 'a.txt'));
  });

  it.each(['escape/secret.txt', 'escape', 'link.txt', 'escape/new-file.txt', 'dangling'])(
    'refuses %s, which leads outside through a link',
    async (requested) => {
      await expect(confine(root, requested)).rejects.toMatchObject({ code: 'path_outside_root' });
    },
  );
});

// The gap between checking a path and using it: these swap a directory for a link to the outside after `confine`
// approved the path, as a command running in the project could. Linux only: elsewhere the helpers can protect the
// last step alone.
describe.runIf(process.platform === 'linux')('using a confined path without a gap', () => {
  const READ = constants.O_RDONLY;
  const CREATE = constants.O_WRONLY | constants.O_CREAT;

  /** Checks `work/<name>` while `work` is a real directory, then puts a link to the outside in its place. */
  async function swapAfterCheck(name: string): Promise<{ real: string; restore: () => Promise<void> }> {
    const work = path.join(root, 'work');
    await mkdir(work, { recursive: true });
    await writeFile(path.join(work, 'secret.txt'), 'inside');
    const real = await confine(root, `work/${name}`);
    await rename(work, path.join(root, 'work-moved'));
    await symlink(outside, work);
    return {
      real,
      restore: async () => {
        await rm(work);
        await rm(path.join(root, 'work-moved'), { recursive: true, force: true });
      },
    };
  }

  it('opens, lists and creates what is inside', async () => {
    const handle = await openInside(root, path.join(root, 'src', 'a.txt'), READ);
    expect(await handle.readFile('utf8')).toBe('a');
    await handle.close();
    expect(await withDirectoryInside(root, path.join(root, 'src'), (directory) => readdir(directory))).toContain('a.txt');
    await mkdirInside(root, path.join(root, 'made', 'deeper'));
    const created = await openInside(root, path.join(root, 'made', 'deeper', 'new.txt'), CREATE, { mode: 0o600 });
    await created.writeFile('new');
    await created.close();
    expect(await readFile(path.join(root, 'made', 'deeper', 'new.txt'), 'utf8')).toBe('new');
  });

  it('refuses to read through a directory swapped for a link', async () => {
    const { real, restore } = await swapAfterCheck('secret.txt');
    try {
      await expect(openInside(root, real, READ)).rejects.toMatchObject({ code: 'path_outside_root' });
    } finally {
      await restore();
    }
  });

  it('refuses to read through a directory further up that was swapped for a link', async () => {
    await mkdir(path.join(root, 'upper', 'lower'), { recursive: true });
    await writeFile(path.join(root, 'upper', 'lower', 'file.txt'), 'inside');
    await mkdir(path.join(outside, 'lower'), { recursive: true });
    await writeFile(path.join(outside, 'lower', 'file.txt'), 'outside');
    const real = await confine(root, 'upper/lower/file.txt');
    await rename(path.join(root, 'upper'), path.join(root, 'upper-moved'));
    await symlink(outside, path.join(root, 'upper'));
    try {
      await expect(openInside(root, real, READ)).rejects.toMatchObject({ code: 'path_outside_root' });
    } finally {
      await rm(path.join(root, 'upper'));
      await rm(path.join(root, 'upper-moved'), { recursive: true, force: true });
      await rm(path.join(outside, 'lower'), { recursive: true, force: true });
    }
  });

  it('refuses to create through a directory swapped for a link, and creates nothing out there', async () => {
    const { real, restore } = await swapAfterCheck('planted.txt');
    try {
      await expect(openInside(root, real, CREATE, { mode: 0o600 })).rejects.toMatchObject({ code: 'path_outside_root' });
      expect(existsSync(path.join(outside, 'planted.txt'))).toBe(false);
      await expect(mkdirInside(root, path.join(real, '..', 'deeper'))).rejects.toMatchObject({ code: 'path_outside_root' });
      expect(existsSync(path.join(outside, 'deeper'))).toBe(false);
    } finally {
      await restore();
    }
  });

  it('refuses to list a directory swapped for a link', async () => {
    const work = path.join(root, 'work');
    await mkdir(work, { recursive: true });
    const real = await confine(root, 'work');
    await rm(work, { recursive: true });
    await symlink(outside, work);
    try {
      await expect(withDirectoryInside(root, real, (directory) => readdir(directory))).rejects.toMatchObject({ code: 'path_outside_root' });
    } finally {
      await rm(work);
    }
  });

  it('never follows a link in the last step, and keeps out of excluded directories', async () => {
    await expect(openInside(root, path.join(root, 'inner'), READ)).rejects.toMatchObject({ code: 'path_outside_root' });
    await expect(openInside(root, path.join(root, 'src', 'a.txt'), READ, { excluded: [path.join(root, 'src')] })).rejects.toMatchObject({
      code: 'path_outside_root',
    });
    await expect(openInside(root, path.join(outside, 'secret.txt'), READ)).rejects.toMatchObject({ code: 'path_outside_root' });
  });
});
