import type { GitChangedFile, GitFileStatus } from '@agent-studio/protocol';

/**
 * Parsers for git's machine-readable output. Everything here reads the
 * NUL-separated forms, in which file names appear verbatim — spaces, quotes,
 * line breaks and non-ASCII characters need no unquoting and cannot be
 * confused with separators.
 */

export interface ParsedStatus {
  /** Null before the first commit. */
  oid: string | null;
  /** Null when HEAD is detached. */
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileStatus[];
}

type IndexChange = GitFileStatus['index'];
type WorktreeChange = GitFileStatus['worktree'];

function indexChange(letter: string): IndexChange {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type_changed';
    default:
      return null;
  }
}

function worktreeChange(letter: string): WorktreeChange {
  switch (letter) {
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'T':
      return 'type_changed';
    // A path added with "intent to add", or a rename detected in the work tree: both are edits not yet staged.
    case 'A':
    case 'R':
    case 'C':
      return 'modified';
    default:
      return null;
  }
}

/** Splits off `count` space-separated fields; the remainder (which may contain spaces) is the last element. */
function fields(record: string, count: number): string[] | null {
  const parts: string[] = [];
  let position = 0;
  for (let i = 0; i < count; i += 1) {
    const space = record.indexOf(' ', position);
    if (space === -1) return null;
    parts.push(record.slice(position, space));
    position = space + 1;
  }
  parts.push(record.slice(position));
  return parts;
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(output: string): ParsedStatus {
  const status: ParsedStatus = { oid: null, head: null, detached: false, upstream: null, ahead: null, behind: null, files: [] };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.length === 0) continue;
    const kind = record[0];

    if (kind === '#') {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        status.detached = value === '(detached)';
        status.head = status.detached ? null : value;
      } else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }

    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = fields(record, 8);
      if (!parts) continue;
      const xy = parts[1]!;
      status.files.push({
        path: parts[8]!,
        originalPath: null,
        index: indexChange(xy[0]!),
        worktree: worktreeChange(xy[1]!),
        conflicted: false,
        submodule: parts[2]!.startsWith('S'),
      });
      continue;
    }

    if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const parts = fields(record, 9);
      const original = records[i + 1];
      i += 1;
      if (!parts || original === undefined || original.length === 0) continue;
      const xy = parts[1]!;
      status.files.push({
        path: parts[9]!,
        originalPath: original,
        index: indexChange(xy[0]!),
        worktree: worktreeChange(xy[1]!),
        conflicted: false,
        submodule: parts[2]!.startsWith('S'),
      });
      continue;
    }

    if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = fields(record, 10);
      if (!parts) continue;
      status.files.push({
        path: parts[10]!,
        originalPath: null,
        // A conflicted file is never "staged": it shows under changes until it is resolved.
        index: null,
        worktree: parts[1] === 'DD' || parts[1] === 'UD' || parts[1] === 'DU' ? 'deleted' : 'modified',
        conflicted: true,
        submodule: parts[2]!.startsWith('S'),
      });
      continue;
    }

    if (kind === '?') {
      status.files.push({ path: record.slice(2), originalPath: null, index: null, worktree: 'untracked', conflicted: false, submodule: false });
    }
    // "!" (ignored) entries are never requested.
  }
  return status;
}

// ---- name-status and numstat ---------------------------------------------------------

type ChangeLetter = GitChangedFile['status'];

const LETTERS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

/** Parses `--name-status -z`: `M\0path\0`, `R100\0old\0new\0`. Unmerged entries are reported as modified. */
export function parseNameStatus(output: string): Array<{ path: string; originalPath: string | null; status: ChangeLetter }> {
  const tokens = output.split('\0');
  const files: Array<{ path: string; originalPath: string | null; status: ChangeLetter }> = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    if (code.length === 0) {
      i += 1;
      continue;
    }
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from === undefined || to === undefined) break;
      files.push({ path: to, originalPath: from, status: letter });
      i += 3;
    } else {
      const file = tokens[i + 1];
      if (file === undefined) break;
      files.push({ path: file, originalPath: null, status: LETTERS.has(letter) ? (letter as ChangeLetter) : 'M' });
      i += 2;
    }
  }
  return files;
}

/** Parses `--numstat -z`: `12\t3\tpath\0`, or for renames `12\t3\t\0old\0new\0`. Binary files have `-` counts. */
export function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = output.split('\0');
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!match) {
      i += 1;
      continue;
    }
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    if (match[3] === '') {
      const to = tokens[i + 2];
      if (to !== undefined) counts.set(to, { additions, deletions });
      i += 3;
    } else {
      counts.set(match[3]!, { additions, deletions });
      i += 1;
    }
  }
  return counts;
}

// ---- worktrees -----------------------------------------------------------------------

export interface ParsedWorktree {
  path: string;
  oid: string | null;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain -z`. The first entry is the main worktree. */
export function parseWorktreeList(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;
  for (const line of output.split('\0')) {
    if (line.length === 0) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      if (current) worktrees.push(current);
      current = { path: value, oid: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') current.oid = value;
    else if (key === 'branch') current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/** `ahead 2, behind 1` / `ahead 3` / `behind 4` / `gone` / `` as printed by `%(upstream:track,nobracket)`. */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track === 'gone') return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false };
}

/** Whether diff text describes a binary change rather than text. */
export function isBinaryDiff(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff);
}
