import { promises as fs } from 'node:fs';
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

/** Project-relative form with forward slashes, for sending to clients. */
export function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}
