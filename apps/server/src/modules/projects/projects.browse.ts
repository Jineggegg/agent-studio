import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FolderEntry, FolderListing } from '@agent-studio/protocol';
import type { StudioConfig } from '../../kernel/config.js';
import { badRequest, forbidden, notFound } from '../../kernel/errors.js';
import { isInside } from '../../kernel/paths.js';

/** Folders nobody wants to pick as a project and that only clutter the picker. */
const CLUTTER = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'env',
  'lost+found',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

const SYSTEM_DIRECTORIES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/opt', '/proc', '/root', '/run', '/sbin', '/snap', '/sys', '/usr', '/var'];

/**
 * True for the file-system root, a system directory, and anything beneath a
 * system directory — unless the operator put a workspace root inside that
 * system directory (say /srv/work or /var/lib/studio), in which case what lies
 * inside that root is fair game.
 */
function isSystemPath(real: string, roots: readonly string[]): boolean {
  if (real === path.parse(real).root) return true;
  return SYSTEM_DIRECTORIES.some((system) => isInside(system, real) && !roots.some((root) => isInside(system, root) && isInside(root, real)));
}

export const MAX_FOLDER_ENTRIES = 2000;

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Lets the owner pick a project folder without typing a path. It only ever
 * shows directories, only inside the configured workspace roots (after
 * following links), and leaves out hidden folders, system folders and the
 * Studio's own data.
 */
export class FolderBrowser {
  readonly #config: StudioConfig;
  readonly #projectAt: (rootDir: string) => string | null;

  constructor(config: StudioConfig, projectAt: (rootDir: string) => string | null) {
    this.#config = config;
    this.#projectAt = projectAt;
  }

  async #roots(): Promise<string[]> {
    const roots: string[] = [];
    for (const configured of this.#config.workspaceRoots) {
      try {
        const real = await fs.realpath(configured);
        if ((await fs.stat(real)).isDirectory() && !roots.includes(real)) roots.push(real);
      } catch {
        /* a root that does not exist yet has nothing to browse */
      }
    }
    return roots;
  }

  #entry(absolute: string): FolderEntry {
    return { name: path.basename(absolute) || absolute, path: absolute, projectId: this.#projectAt(absolute) };
  }

  async list(requested: string | undefined): Promise<FolderListing> {
    const roots = await this.#roots();
    const rootEntries = roots.map((root) => this.#entry(root));
    let target: string;
    if (requested === undefined || requested.trim() === '') {
      if (roots.length !== 1) {
        return { path: null, parent: null, selectable: false, roots: rootEntries, entries: rootEntries, truncated: false };
      }
      target = roots[0]!;
    } else {
      if (requested.includes('\0')) throw badRequest('That path is not valid.', undefined, 'invalid_path');
      const expanded = expandHome(requested.trim());
      if (!path.isAbsolute(expanded)) throw badRequest('Give the full path of the folder.', undefined, 'invalid_path');
      // Membership of a workspace root is decided on the lexical path first, so that
      // nothing outside the roots is even looked at, and again on the real path.
      const lexical = path.resolve(expanded);
      const configured = this.#config.workspaceRoots.map((root) => path.resolve(root));
      if (![...roots, ...configured].some((root) => isInside(root, lexical))) {
        throw forbidden('Only folders inside an allowed workspace folder can be browsed.', 'outside_workspace');
      }
      try {
        target = await fs.realpath(lexical);
      } catch {
        throw notFound('That folder does not exist.', 'folder_missing');
      }
      if (!roots.some((root) => isInside(root, target))) {
        throw forbidden('Only folders inside an allowed workspace folder can be browsed.', 'outside_workspace');
      }
    }

    const dataDir = await fs.realpath(this.#config.dataDir).catch(() => path.resolve(this.#config.dataDir));
    if (isInside(dataDir, target)) throw forbidden("The Studio's own data cannot be browsed.", 'folder_not_allowed');
    const isRoot = roots.includes(target);
    // A root may be listed even when it is "/" itself; nothing else of the system may.
    if (!isRoot && isSystemPath(target, roots)) throw forbidden('System folders cannot be browsed.', 'folder_not_allowed');
    if (!(await fs.stat(target)).isDirectory()) throw badRequest('That path is a file, not a folder.', undefined, 'not_a_directory');

    let dirents;
    try {
      dirents = await fs.readdir(target, { withFileTypes: true });
    } catch {
      throw notFound('That folder cannot be read.', 'folder_unreadable');
    }

    const names: string[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.') || CLUTTER.has(dirent.name)) continue;
      const absolute = path.join(target, dirent.name);
      if (dirent.isDirectory()) {
        if (isSystemPath(absolute, roots) || isInside(dataDir, absolute)) continue;
        names.push(dirent.name);
      } else if (dirent.isSymbolicLink()) {
        // A link is offered only when it leads to a directory that is itself inside a workspace root.
        try {
          const real = await fs.realpath(absolute);
          if (!(await fs.stat(real)).isDirectory()) continue;
          if (!roots.some((root) => isInside(root, real)) || isSystemPath(real, roots) || isInside(dataDir, real)) continue;
          names.push(dirent.name);
        } catch {
          /* dangling link */
        }
      }
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    const truncated = names.length > MAX_FOLDER_ENTRIES;

    const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
    const parent = path.dirname(target);
    return {
      path: target,
      parent: parent !== target && roots.some((root) => isInside(root, parent)) ? parent : null,
      selectable: target !== home && !isSystemPath(target, roots) && !isInside(target, dataDir),
      roots: rootEntries,
      entries: names.slice(0, MAX_FOLDER_ENTRIES).map((name) => this.#entry(path.join(target, name))),
      truncated,
    };
  }
}
