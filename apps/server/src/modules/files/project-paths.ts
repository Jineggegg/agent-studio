import { promises as fs } from 'node:fs';
import path from 'node:path';
import { badRequest, forbidden, notFound } from '../../kernel/errors.js';
import { confine, isInside, resolveInside, toRelative } from '../../kernel/paths.js';

/**
 * Path rules shared by the features that work inside a project folder (files
 * and git). They all start from the kernel's `confine`; what is added here is
 * the distinction between *the thing a path names* and *what that thing points
 * to*, and the protection of the repository's own metadata.
 */

/** The project's real folder, or 404 when it is gone. */
export async function projectRoot(rootDir: string): Promise<string> {
  try {
    const real = await fs.realpath(rootDir);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory');
    return real;
  } catch {
    throw notFound("The project's folder no longer exists on the server.", 'project_folder_missing');
  }
}

/** `.git` in any letter case: on case-insensitive file systems they are the same folder. */
const isGitName = (name: string): boolean => name.toLowerCase() === '.git';

/** True when a project-relative path is, or lies inside, the repository's metadata. */
export function isGitInternal(relative: string): boolean {
  return relative.split('/').some(isGitName);
}

export function refuseGitInternal(relative: string): void {
  if (isGitInternal(relative)) {
    throw forbidden("The repository's own data (.git) cannot be read or changed through the Studio's file tools.", 'protected_path');
  }
}

/** `confine`, with the file system's own objections turned into answers a client can act on. */
async function confined(root: string, requested: string): Promise<string> {
  try {
    return await confine(root, requested);
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case 'ENAMETOOLONG':
        throw badRequest('That name is too long.', undefined, 'invalid_name');
      case 'ELOOP':
        throw badRequest('That path goes round in circles through links.', undefined, 'invalid_path');
      case 'EACCES':
      case 'EPERM':
        throw forbidden('The server is not permitted to look at that path.', 'permission_denied');
      default:
        throw error;
    }
  }
}

/** Normalises what a client sent: "" and "." both mean the project folder. */
function normaliseRequest(requested: string): string {
  if (requested.includes('\0')) throw badRequest('That path is not valid.', undefined, 'invalid_path');
  return requested === '.' || requested === './' ? '' : requested;
}

export interface ResolvedPath {
  /** The project's real folder. */
  readonly root: string;
  /** Real absolute path to use for the file-system call. */
  readonly absolute: string;
  /** Project-relative form of `absolute`, forward slashes; "" for the project folder. */
  readonly relative: string;
}

/**
 * Resolves a path whose *content* is about to be used: links are followed,
 * and a link that leaves the project is refused — for reading as for writing.
 * Works for paths that do not exist yet.
 */
export async function resolveTarget(rootDir: string, requested: string): Promise<ResolvedPath> {
  const root = await projectRoot(rootDir);
  const wanted = normaliseRequest(requested);
  // The request is judged as written first, so that ".git/../x" tricks and absolute paths never get further.
  refuseGitInternal(toRelative(root, resolveInside(root, wanted)));
  const absolute = await confined(root, wanted);
  const relative = toRelative(root, absolute);
  // …and again as resolved: a link inside the project may lead into .git.
  refuseGitInternal(relative);
  return { root, absolute, relative };
}

/**
 * Resolves a path that names *an entry itself* — the thing to rename, delete,
 * stage or list — without following a link in its last component. The folder
 * that contains the entry is resolved with links followed and must lie inside
 * the project, so the entry really is a child of the project; what the entry
 * points to is irrelevant because it is never dereferenced.
 */
export async function resolveEntry(rootDir: string, requested: string): Promise<ResolvedPath> {
  const root = await projectRoot(rootDir);
  const wanted = normaliseRequest(requested);
  const lexical = resolveInside(root, wanted);
  const lexicalRelative = toRelative(root, lexical);
  refuseGitInternal(lexicalRelative);
  if (lexical === root) return { root, absolute: root, relative: '' };
  const parent = await confined(root, path.dirname(lexicalRelative));
  const absolute = path.join(parent, path.basename(lexical));
  if (!isInside(root, absolute)) throw forbidden('That path is outside the project.', 'path_outside_root');
  const relative = toRelative(root, absolute);
  refuseGitInternal(relative);
  return { root, absolute, relative };
}

export function refuseProjectRoot(resolved: ResolvedPath): void {
  if (resolved.relative === '') {
    throw forbidden('The project folder itself cannot be changed here.', 'project_root');
  }
}

/** Characters that are trouble in a file name on at least one platform a project may be copied to. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Why `name` cannot be given to a new file or folder, or null when it can. */
export function nameProblem(name: string): string | null {
  if (name.length === 0 || name.trim().length === 0) return 'A name cannot be blank.';
  if (Buffer.byteLength(name) > 255) return 'That name is too long.';
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) return 'A name cannot contain < > : " / \\ | ? * or control characters.';
  if (/^\.+$/.test(name)) return 'A name cannot consist of dots only.';
  if (name !== name.trim()) return 'A name cannot start or end with a space.';
  if (RESERVED_DEVICE_NAMES.test(name)) return 'That name is reserved by some operating systems.';
  if (isGitName(name)) return 'That name is reserved for the repository.';
  return null;
}

export function assertEntryName(name: string): string {
  const problem = nameProblem(name);
  if (problem) throw badRequest(problem, undefined, 'invalid_name');
  return name;
}
