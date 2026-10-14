import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { badRequest, forbidden } from './errors.js';

/** True when `candidate` is `root` itself or lies beneath it (purely lexical). */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Turns a client-supplied relative path into an absolute one that is
 * guaranteed to stay inside `root`, lexically. Absolute paths, NUL bytes and
 * `..` escapes are rejected. Symbolic links are not examined here — use
 * {@link confine} before touching the file system.
 */
export function resolveInside(root: string, requested: string): string {
  if (typeof requested !== 'string' || requested.includes('\0')) {
    throw badRequest('That path is not valid.', undefined, 'invalid_path');
  }
  if (path.isAbsolute(requested) || /^[a-zA-Z]:[\\/]/.test(requested)) {
    throw forbidden('Paths must be relative to the project.', 'path_outside_root');
  }
  const absolute = path.resolve(root, requested);
  if (!isInside(root, absolute)) {
    throw forbidden('That path is outside the project.', 'path_outside_root');
  }
  return absolute;
}

/**
 * Resolves `requested` inside `root` and follows symbolic links, so a link
 * that points out of the tree is refused. Works for paths that do not exist
 * yet: the deepest existing ancestor is what gets resolved.
 *
 * Returns the real absolute path to use for the file system call.
 */
export async function confine(root: string, requested: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const lexical = resolveInside(realRoot, requested);

  let existing = lexical;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (!isInside(realRoot, real)) {
        throw forbidden('That path leads outside the project.', 'path_outside_root');
      }
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        throw error;
      }
      // A dangling symbolic link "does not exist" for realpath, yet writing
      // through it would create its target wherever it points.
      const link = await fs.lstat(existing).catch(() => null);
      if (link?.isSymbolicLink()) {
        throw forbidden('That path leads outside the project.', 'path_outside_root');
      }
      const parent = path.dirname(existing);
      if (parent === existing) throw forbidden('That path is outside the project.', 'path_outside_root');
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Using a confined path without a gap
// ---------------------------------------------------------------------------
//
// `confine` checks a path; the file system call that follows uses it a moment
// later. Whoever can change the tree in between (an agent's command running
// in the project) can swap a directory on the way for a link to somewhere
// else. On Linux the kernel says where an open descriptor really is
// (/proc/self/fd), so the helpers below open first and check what was opened,
// and create or list entries only through a directory descriptor that was
// checked — a path through /proc/self/fd/N names that very directory, however
// the tree changes. Elsewhere they fall back to never following a link in the
// last step, which narrows the gap without closing it.

const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0 } = constants;
const FD_DIR = '/proc/self/fd';

export interface InsideOptions {
  /** Directories below the root that must not be reached either (the Studio's own data, when a project holds it). */
  readonly excluded?: readonly string[];
  /** Permissions of a file the call creates. */
  readonly mode?: number;
}

let descriptorsLocatable: Promise<boolean> | undefined;

/** Whether this system can say where an open descriptor is. */
function canLocateDescriptors(): Promise<boolean> {
  descriptorsLocatable ??= (async () => {
    if (process.platform !== 'linux') return false;
    try {
      const probe = await fs.open('/', O_RDONLY | O_DIRECTORY);
      try {
        return (await fs.readlink(`${FD_DIR}/${probe.fd}`)) === '/';
      } finally {
        await probe.close();
      }
    } catch {
      return false;
    }
  })();
  return descriptorsLocatable;
}

const outsideTheProject = () => forbidden('That path leads outside the project.', 'path_outside_root');

async function checkDescriptor(fd: number, realRoot: string, excluded: readonly string[]): Promise<void> {
  const actual = await fs.readlink(`${FD_DIR}/${fd}`);
  if (!isInside(realRoot, actual) || excluded.some((directory) => isInside(directory, actual))) throw outsideTheProject();
}

async function opened(handle: FileHandle, realRoot: string, excluded: readonly string[]): Promise<FileHandle> {
  try {
    await checkDescriptor(handle.fd, realRoot, excluded);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * A link in the last step is never followed; meeting one means the tree
 * changed under us. (Asked for a directory, Linux reports a link as "not a
 * directory" rather than as a link.)
 */
async function openNoFollow(file: string, flags: number, mode: number | undefined): Promise<FileHandle> {
  try {
    return await fs.open(file, flags | O_NOFOLLOW, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw outsideTheProject();
    if (code === 'ENOTDIR' && (await fs.lstat(file).catch(() => null))?.isSymbolicLink()) throw outsideTheProject();
    throw error;
  }
}

/**
 * Opens a path that {@link confine} returned, and refuses it unless what was
 * opened is inside `root` and outside every excluded directory. The last step
 * is opened through a checked descriptor of its directory, so a file is never
 * created or truncated anywhere else first.
 */
export async function openInside(root: string, real: string, flags: number, options: InsideOptions = {}): Promise<FileHandle> {
  if (!(await canLocateDescriptors())) return openNoFollow(real, flags, options.mode);
  const realRoot = await fs.realpath(root);
  const excluded = options.excluded ?? [];
  if (real === realRoot) return opened(await openNoFollow(real, flags, options.mode), realRoot, excluded);
  if (!isInside(realRoot, real)) throw outsideTheProject();
  const parent = await openNoFollow(path.dirname(real), O_RDONLY | O_DIRECTORY, undefined);
  try {
    await checkDescriptor(parent.fd, realRoot, excluded);
    return opened(await openNoFollow(path.join(`${FD_DIR}/${parent.fd}`, path.basename(real)), flags, options.mode), realRoot, excluded);
  } finally {
    await parent.close();
  }
}

/**
 * Runs `use` with a path that names the directory `real` — checked, like
 * {@link openInside}, to be inside `root` — for as long as `use` runs. Entries
 * reached through that path are entries of that directory, whatever happens
 * to the tree meanwhile.
 */
export async function withDirectoryInside<T>(
  root: string,
  real: string,
  use: (directory: string) => Promise<T>,
  options: InsideOptions = {},
): Promise<T> {
  if (!(await canLocateDescriptors())) return use(real);
  const handle = await openInside(root, real, O_RDONLY | O_DIRECTORY, options);
  try {
    return await use(`${FD_DIR}/${handle.fd}`);
  } finally {
    await handle.close();
  }
}

/** Creates `real` and its missing parents one step at a time, each inside a directory checked to be inside `root`. */
export async function mkdirInside(root: string, real: string, options: InsideOptions = {}): Promise<void> {
  if (!(await canLocateDescriptors())) {
    await fs.mkdir(real, { recursive: true });
    return;
  }
  const realRoot = await fs.realpath(root);
  if (!isInside(realRoot, real)) throw outsideTheProject();
  let current = realRoot;
  for (const step of path.relative(realRoot, real).split(path.sep).filter(Boolean)) {
    await withDirectoryInside(
      root,
      current,
      async (directory) => {
        await fs.mkdir(path.join(directory, step)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      },
      options,
    );
    current = path.join(current, step);
  }
}

/** Project-relative form with forward slashes, for sending to clients. */
export function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}
