import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTree, directorySize, hashTree, scanTree } from './tree.js';

let root: string;
let plugin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'plugin-tree-'));
  plugin = path.join(root, 'plugin');
  await mkdir(path.join(plugin, 'server'), { recursive: true });
  await mkdir(path.join(plugin, 'panel'));
  await writeFile(path.join(plugin, 'plugin.json'), '{"id":"demo"}');
  await writeFile(path.join(plugin, 'server', 'index.js'), 'export {};\n');
  await writeFile(path.join(plugin, 'panel', 'index.html'), '<!doctype html>');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanTree', () => {
  it('lists files with forward slashes, sorted, and leaves version-control data out', async () => {
    await mkdir(path.join(plugin, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(plugin, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nrm -rf ~');
    await writeFile(path.join(plugin, '.gitignore'), 'node_modules\n');
    expect((await scanTree(plugin)).map((file) => file.path)).toEqual(['.gitignore', 'panel/index.html', 'plugin.json', 'server/index.js']);
  });

  it('refuses symbolic links, wherever they point', async () => {
    await symlink('/etc/passwd', path.join(plugin, 'server', 'passwd'));
    await expect(scanTree(plugin)).rejects.toMatchObject({ code: 'invalid_plugin_files', message: expect.stringContaining('server/passwd') });
    await rm(path.join(plugin, 'server', 'passwd'));
    await symlink('index.js', path.join(plugin, 'server', 'alias.js'));
    await expect(scanTree(plugin)).rejects.toMatchObject({ code: 'invalid_plugin_files' });
    await rm(path.join(plugin, 'server', 'alias.js'));
    await symlink(os.homedir(), path.join(plugin, 'home'));
    await expect(scanTree(plugin)).rejects.toMatchObject({ code: 'invalid_plugin_files' });
    await rm(path.join(plugin, 'home'));
    await symlink('/nowhere/at/all', path.join(plugin, 'dangling'));
    await expect(scanTree(plugin)).rejects.toMatchObject({ code: 'invalid_plugin_files' });
  });

  it('refuses too many files, too many bytes, and folders nested too deeply', async () => {
    await expect(scanTree(plugin, { maxFiles: 2, maxBytes: 1024 })).rejects.toThrow(/at most 2 files/);
    await writeFile(path.join(plugin, 'big.bin'), Buffer.alloc(4096));
    await expect(scanTree(plugin, { maxFiles: 100, maxBytes: 1024 })).rejects.toThrow(/MiB/);
    let deep = plugin;
    for (let i = 0; i < 14; i += 1) deep = path.join(deep, 'd');
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, 'x.js'), '');
    await expect(scanTree(plugin)).rejects.toThrow(/nested too deeply/);
  });

  it('refuses file names with control characters or backslashes', async () => {
    await writeFile(path.join(plugin, 'a\\b.js'), '');
    await expect(scanTree(plugin)).rejects.toThrow(/name that is not allowed/);
    await rm(path.join(plugin, 'a\\b.js'));
    await writeFile(path.join(plugin, 'line\nbreak.js'), '');
    await expect(scanTree(plugin)).rejects.toThrow(/name that is not allowed/);
  });
});

describe('hashTree', () => {
  it('is stable across runs, copies, file times and modes', async () => {
    const first = await hashTree(plugin);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await hashTree(plugin)).toBe(first);
    await utimes(path.join(plugin, 'plugin.json'), new Date(0), new Date(0));
    await chmod(path.join(plugin, 'server', 'index.js'), 0o755);
    expect(await hashTree(plugin)).toBe(first);
    const copy = path.join(root, 'copy');
    await copyTree(plugin, copy);
    expect(await hashTree(copy)).toBe(first);
  });

  it('changes when a byte, a name or the set of files changes', async () => {
    const original = await hashTree(plugin);
    const seen = new Set([original]);
    const changed = async () => {
      const hash = await hashTree(plugin);
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    };
    await writeFile(path.join(plugin, 'server', 'index.js'), 'export {};\n ');
    await changed();
    await writeFile(path.join(plugin, 'server', 'extra.js'), '');
    await changed();
    await rename(path.join(plugin, 'server', 'extra.js'), path.join(plugin, 'server', 'other.js'));
    await changed();
    await rename(path.join(plugin, 'server', 'other.js'), path.join(plugin, 'other.js'));
    await changed();
    await mkdir(path.join(plugin, 'empty'));
    // An empty folder holds no code and is not part of the identity.
    expect(seen.has(await hashTree(plugin))).toBe(true);
    await rm(path.join(plugin, 'other.js'));
    await writeFile(path.join(plugin, 'server', 'index.js'), 'export {};\n');
    expect(await hashTree(plugin)).toBe(original);
  });

  it('cannot be fooled by moving bytes between a name and its content', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    await writeFile(path.join(a, 'ab'), 'c');
    await writeFile(path.join(b, 'a'), 'bc');
    expect(await hashTree(a)).not.toBe(await hashTree(b));
  });

  it('refuses to hash a tree that has acquired a symbolic link', async () => {
    await symlink('/etc/passwd', path.join(plugin, 'server', 'index2.js'));
    await expect(hashTree(plugin)).rejects.toMatchObject({ code: 'invalid_plugin_files' });
  });
});

describe('copyTree', () => {
  it('copies ordinary files for the server account only, never version-control data', async () => {
    await mkdir(path.join(plugin, '.git'));
    await writeFile(path.join(plugin, '.git', 'config'), '[core]\n\tsshCommand = evil');
    await chmod(path.join(plugin, 'server', 'index.js'), 0o777);
    const target = path.join(root, 'installed');
    await copyTree(plugin, target);
    expect((await readdir(target)).sort()).toEqual(['panel', 'plugin.json', 'server']);
    expect(await readFile(path.join(target, 'server', 'index.js'), 'utf8')).toBe('export {};\n');
    expect((await stat(path.join(target, 'server', 'index.js'))).mode & 0o777).toBe(0o600);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it('copies the bytes of a hard link rather than the link', async () => {
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'shared bytes');
    await link(outside, path.join(plugin, 'linked.txt'));
    const target = path.join(root, 'installed');
    await copyTree(plugin, target);
    await writeFile(path.join(target, 'linked.txt'), 'changed in the copy', { mode: 0o600 });
    expect(await readFile(outside, 'utf8')).toBe('shared bytes');
  });

  it('refuses a tree with a symbolic link and a destination that already exists', async () => {
    const target = path.join(root, 'installed');
    await mkdir(target);
    await expect(copyTree(plugin, target)).rejects.toThrow();
    await rm(target, { recursive: true });
    await symlink('/etc', path.join(plugin, 'etc'));
    await expect(copyTree(plugin, target)).rejects.toMatchObject({ code: 'invalid_plugin_files' });
  });
});

describe('directorySize', () => {
  it('adds up file sizes, counts links without following them, and gives up politely on huge folders', async () => {
    await writeFile(path.join(plugin, 'data.bin'), Buffer.alloc(5000));
    await symlink('/usr', path.join(plugin, 'usr'));
    const measured = await directorySize(plugin);
    expect(measured.complete).toBe(true);
    expect(measured.bytes).toBeGreaterThanOrEqual(5000);
    expect(measured.bytes).toBeLessThan(20_000);
    expect((await directorySize(plugin, 2)).complete).toBe(false);
    expect(await directorySize(path.join(root, 'missing'))).toEqual({ bytes: 0, complete: true });
  });
});
