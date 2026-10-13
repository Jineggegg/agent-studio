import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confine, isInside, resolveInside } from './paths.js';

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
