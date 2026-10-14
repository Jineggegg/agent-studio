import type { FileEntry, FileListing, FileNameMatch } from '@agent-studio/protocol';

/**
 * The file tree as data. Folders are read one at a time, when they are first
 * opened; what was read stays while the folder is closed, so opening it again
 * is instant and a refresh can re-read exactly what is on show.
 *
 * Everything here is a pure function of the state: the panel only decides
 * when to ask the server.
 */
export interface FolderState {
  status: 'loading' | 'ready' | 'failed';
  /** What the server listed, folders first. Kept while a refresh is under way. */
  entries: readonly FileEntry[];
  /** The folder holds more entries than one listing returns. */
  truncated: boolean;
  error: unknown;
}

export interface TreeState {
  /** Folders that have been asked for, by project-relative path. `''` is the project folder. */
  folders: Readonly<Record<string, FolderState>>;
  /** Folders that are open. The project folder itself always is. */
  expanded: ReadonlySet<string>;
}

export const ROOT = '';

export const emptyTree = (): TreeState => ({ folders: {}, expanded: new Set() });

export const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? ROOT : path.slice(0, index);
};

export const joinPath = (folder: string, name: string): string => (folder === ROOT ? name : `${folder}/${name}`);

/** Every folder above `path`, outermost first: `a/b/c.ts` → `a`, `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) result.push(parts.slice(0, index).join('/'));
  return result;
}

/** A path as the server writes them: no leading `./`, no doubled or trailing slashes. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
}

const isInside = (path: string, folder: string): boolean => folder === ROOT || path === folder || path.startsWith(`${folder}/`);

export type TreeAction =
  | { type: 'requested'; path: string }
  | { type: 'loaded'; path: string; listing: FileListing }
  | { type: 'failed'; path: string; error: unknown }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string }
  | { type: 'collapse-all' }
  | { type: 'reveal'; path: string; includeSelf: boolean }
  | { type: 'forget'; path: string }
  | { type: 'reset' };

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case 'requested': {
      const current = state.folders[action.path];
      // A refresh keeps what is on screen; only a first read has nothing to show.
      const next: FolderState = current ? { ...current, status: current.status === 'failed' ? 'loading' : current.status, error: null } : { status: 'loading', entries: [], truncated: false, error: null };
      return { ...state, folders: { ...state.folders, [action.path]: next } };
    }
    case 'loaded': {
      const path = action.path;
      const folderPaths = new Set(action.listing.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path));
      // A folder that is no longer listed takes what was remembered beneath it, and its open state, with it.
      const survives = (key: string): boolean => {
        const child = childUnder(path, key);
        return child === null || folderPaths.has(child);
      };
      const folders: Record<string, FolderState> = {};
      for (const [key, value] of Object.entries(state.folders)) if (key === path || survives(key)) folders[key] = value;
      folders[path] = { status: 'ready', entries: action.listing.entries, truncated: action.listing.truncated, error: null };
      return { folders, expanded: new Set([...state.expanded].filter((key) => key === path || survives(key))) };
    }
    case 'failed': {
      const current = state.folders[action.path];
      return { ...state, folders: { ...state.folders, [action.path]: { status: 'failed', entries: current?.entries ?? [], truncated: current?.truncated ?? false, error: action.error } } };
    }
    case 'expand': {
      if (state.expanded.has(action.path)) return state;
      return { ...state, expanded: new Set([...state.expanded, action.path]) };
    }
    case 'collapse': {
      if (!state.expanded.has(action.path)) return state;
      const expanded = new Set(state.expanded);
      expanded.delete(action.path);
      return { ...state, expanded };
    }
    case 'collapse-all':
      return state.expanded.size === 0 ? state : { ...state, expanded: new Set() };
    case 'reveal': {
      const wanted = [...ancestorsOf(action.path), ...(action.includeSelf && action.path !== ROOT ? [action.path] : [])];
      if (wanted.every((path) => state.expanded.has(path))) return state;
      return { ...state, expanded: new Set([...state.expanded, ...wanted]) };
    }
    case 'forget': {
      const folders: Record<string, FolderState> = {};
      for (const [key, value] of Object.entries(state.folders)) if (key === ROOT || !isInside(key, action.path)) folders[key] = value;
      return { folders, expanded: new Set([...state.expanded].filter((key) => !isInside(key, action.path))) };
    }
    case 'reset':
      return emptyTree();
  }
}

/** The direct child of `folder` that `path` lies in (or is); null when `path` is not beneath `folder`. */
function childUnder(folder: string, path: string): string | null {
  if (path === folder) return null;
  if (folder !== ROOT && !path.startsWith(`${folder}/`)) return null;
  const first = (folder === ROOT ? path : path.slice(folder.length + 1)).split('/')[0];
  return first ? joinPath(folder, first) : null;
}

/** Open folders that have never been asked for: what the panel must read next. */
export function foldersToLoad(state: TreeState): string[] {
  const wanted = [ROOT, ...state.expanded];
  return wanted.filter((path) => state.folders[path] === undefined && isReachable(state, path));
}

/** A folder can only be read once everything above it is known to be open (or is being revealed). */
function isReachable(state: TreeState, path: string): boolean {
  return ancestorsOf(path).every((ancestor) => state.expanded.has(ancestor));
}

/** Folders on show right now: what a refresh re-reads. */
export function foldersOnShow(state: TreeState): string[] {
  return [ROOT, ...[...state.expanded].filter((path) => isReachable(state, path))].filter((path) => state.folders[path] !== undefined);
}

/** Of the folders on show, the ones a change to `paths` can have touched. */
export function foldersTouchedBy(state: TreeState, paths: readonly string[]): string[] {
  const shown = new Set(foldersOnShow(state));
  const touched = new Set<string>();
  for (const path of paths) {
    const clean = normalizePath(path);
    for (const folder of [parentOf(clean), clean, ...ancestorsOf(clean)]) if (shown.has(folder)) touched.add(folder);
  }
  return [...touched];
}

// ---- what is drawn -----------------------------------------------------------------

export type TreeRow =
  | { kind: 'entry'; key: string; entry: FileEntry; depth: number; expandable: boolean; expanded: boolean; busy: boolean }
  | { kind: 'loading'; key: string; path: string; depth: number }
  | { kind: 'failed'; key: string; path: string; depth: number; error: unknown }
  | { kind: 'empty'; key: string; path: string; depth: number }
  | { kind: 'truncated'; key: string; path: string; depth: number; shown: number };

/** The tree flattened into the rows on show, in order, each with how deep it sits. */
export function visibleRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (path: string, depth: number) => {
    const folder = state.folders[path];
    if (!folder || (folder.status === 'loading' && folder.entries.length === 0)) {
      rows.push({ kind: 'loading', key: `loading:${path}`, path, depth });
      return;
    }
    if (folder.status === 'failed' && folder.entries.length === 0) {
      rows.push({ kind: 'failed', key: `failed:${path}`, path, depth, error: folder.error });
      return;
    }
    if (folder.entries.length === 0 && path !== ROOT) rows.push({ kind: 'empty', key: `empty:${path}`, path, depth });
    for (const entry of folder.entries) {
      const expandable = entry.kind === 'directory';
      const expanded = expandable && state.expanded.has(entry.path);
      const child = state.folders[entry.path];
      rows.push({ kind: 'entry', key: entry.path, entry, depth, expandable, expanded, busy: expanded && child?.status === 'loading' && child.entries.length > 0 });
      if (expanded) walk(entry.path, depth + 1);
    }
    if (folder.truncated) rows.push({ kind: 'truncated', key: `truncated:${path}`, path, depth, shown: folder.entries.length });
    if (folder.status === 'failed') rows.push({ kind: 'failed', key: `failed:${path}`, path, depth, error: folder.error });
  };
  walk(ROOT, 0);
  return rows;
}

// ---- the name filter -----------------------------------------------------------------

export interface FilterRow {
  key: string;
  path: string;
  name: string;
  isFolder: boolean;
  depth: number;
  /** The name itself matched; otherwise the row is only the way to one that did. */
  matched: boolean;
}

interface FilterNode {
  name: string;
  path: string;
  isFolder: boolean;
  matched: boolean;
  children: Map<string, FilterNode>;
}

/**
 * The server's name matches drawn as the branches that lead to them: every
 * folder on the way is shown, open, and nothing else is. Folders come first,
 * then names in the reader's alphabet.
 */
export function filterRows(matches: readonly FileNameMatch[], locale?: string): FilterRow[] {
  const root: FilterNode = { name: '', path: ROOT, isFolder: true, matched: false, children: new Map() };
  for (const match of matches) {
    const parts = normalizePath(match.path).split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: joinPath(node.path, part), isFolder: !last || match.kind === 'directory', matched: false, children: new Map() };
        node.children.set(part, child);
      }
      if (last) {
        child.matched = true;
        child.isFolder = child.isFolder || match.kind === 'directory';
      } else child.isFolder = true;
      node = child;
    });
  }
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const rows: FilterRow[] = [];
  const walk = (node: FilterNode, depth: number) => {
    const children = [...node.children.values()].sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || collator.compare(a.name, b.name));
    for (const child of children) {
      rows.push({ key: child.path, path: child.path, name: child.name, isFolder: child.isFolder, depth, matched: child.matched });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Where a new item would be created relative to a row: inside a folder, beside a file. */
export const folderFor = (entry: Pick<FileEntry, 'path' | 'kind'> | null): string => (entry === null ? ROOT : entry.kind === 'directory' ? entry.path : parentOf(entry.path));
