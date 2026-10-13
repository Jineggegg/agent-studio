import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { PLUGIN_LIMITS } from '@agent-studio/protocol';
import { unprocessable } from '../../kernel/errors.js';

/**
 * A plugin's files, looked at without trusting them.
 *
 * A plugin folder may contain only ordinary files and folders. Symbolic links
 * are refused outright: Node's permission model checks the path a program asks
 * for, not where a link leads, so a link inside a plugin would be a way out of
 * it. Devices, sockets and pipes have no business there either.
 */

export interface TreeFile {
  /** Relative to the plugin folder, with forward slashes. */
  readonly path: string;
  readonly size: number;
}

export interface TreeLimits {
  readonly maxBytes: number;
  readonly maxFiles: number;
}

const DEFAULT_LIMITS: TreeLimits = { maxBytes: PLUGIN_LIMITS.maxTreeBytes, maxFiles: PLUGIN_LIMITS.maxTreeFiles };
const MAX_DEPTH = 12;
const MAX_NAME_BYTES = 200;
/** Version-control data is never part of a plugin: it is not copied, hashed or served. */
const SKIPPED_AT_TOP = new Set(['.git']);

const refuse = (message: string) => unprocessable(message, 'invalid_plugin_files');

// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\u0000-\u001f\u007f\\]/;

/**
 * Lists every file of a plugin folder, or throws when the folder holds
 * something a plugin may not contain or is larger than allowed.
 */
export async function scanTree(root: string, limits: TreeLimits = DEFAULT_LIMITS): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  let total = 0;
  let entries = 0;

  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw refuse('The plugin folder is nested too deeply.');
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      if (depth === 0 && SKIPPED_AT_TOP.has(name)) continue;
      entries += 1;
      if (entries > limits.maxFiles * 2) throw refuse(`A plugin may contain at most ${limits.maxFiles} files.`);
      const relativePath = relative === '' ? name : `${relative}/${name}`;
      if (UNSAFE_NAME.test(name) || Buffer.byteLength(name) > MAX_NAME_BYTES) {
        throw refuse(`The plugin contains a file with a name that is not allowed (in "${relative || '.'}").`);
      }
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw refuse(`"${relativePath}" is a symbolic link. A plugin may contain only ordinary files.`);
      if (stat.isDirectory()) {
        await walk(absolute, relativePath, depth + 1);
      } else if (stat.isFile()) {
        total += stat.size;
        if (files.length >= limits.maxFiles) throw refuse(`A plugin may contain at most ${limits.maxFiles} files.`);
        if (total > limits.maxBytes) throw refuse(`A plugin may be at most ${Math.floor(limits.maxBytes / (1024 * 1024))} MiB.`);
        files.push({ path: relativePath, size: stat.size });
      } else {
        throw refuse(`"${relativePath}" is not an ordinary file.`);
      }
    }
  };

  await walk(root, '', 0);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Opens a file only if it is an ordinary one — never through a link swapped in since the scan. */
async function readOrdinaryFile(file: string, expectedMax: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw refuse('The plugin changed while it was being read.');
    if (stat.size > expectedMax) throw refuse('The plugin changed while it was being read.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * A hash that identifies exactly these files: their relative paths and their
 * bytes. Renaming, adding, removing or changing any file changes it; file
 * times, owners and modes do not.
 */
export async function hashTree(root: string, limits: TreeLimits = DEFAULT_LIMITS): Promise<string> {
  const files = await scanTree(root, limits);
  const outer = createHash('sha256');
  outer.update('agent-studio-plugin-tree-v1\n');
  for (const file of files) {
    const content = await readOrdinaryFile(path.join(root, ...file.path.split('/')), limits.maxBytes);
    const digest = createHash('sha256').update(content).digest('hex');
    // Length-prefixed, so no choice of file names can make two trees read alike.
    outer.update(`${Buffer.byteLength(file.path)}:${file.path}:${content.length}:${digest}\n`);
  }
  return `sha256:${outer.digest('hex')}`;
}

/**
 * Copies a scanned plugin folder to `destination`, which must not exist yet.
 * Files are written for the server's account only; nothing is ever executed.
 */
export async function copyTree(source: string, destination: string, limits: TreeLimits = DEFAULT_LIMITS): Promise<TreeFile[]> {
  const files = await scanTree(source, limits);
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  for (const file of files) {
    const segments = file.path.split('/');
    const target = path.join(destination, ...segments);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const content = await readOrdinaryFile(path.join(source, ...segments), limits.maxBytes);
    await fs.writeFile(target, content, { mode: 0o600, flag: 'wx' });
  }
  return files;
}

/** Bytes used below a folder, counting at most `maxEntries` entries. Links are counted, never followed. */
export async function directorySize(root: string, maxEntries = 20_000): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  let seen = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      seen += 1;
      if (seen > maxEntries) return { bytes, complete: false };
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) pending.push(absolute);
      else bytes += stat.size;
    }
  }
  return { bytes, complete: true };
}
