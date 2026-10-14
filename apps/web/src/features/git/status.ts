import { GIT_ERROR_CODES, type GitBranch, type GitBranches, type GitErrorCode, type GitFileStatus, type GitStatus } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';

/**
 * What the Git panel derives from the server's status: which group a changed
 * file is listed under, which sync actions make sense, and what to offer
 * after a refusal. Pure functions; the server stays the judge of what
 * actually happens.
 */

// ---- changed files -----------------------------------------------------------------

export type ChangeGroup = 'conflicted' | 'staged' | 'unstaged' | 'untracked';
export const CHANGE_GROUPS: readonly ChangeGroup[] = ['conflicted', 'staged', 'unstaged', 'untracked'];

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface Change {
  /** Unique among all rows: a file that is partly staged appears in two groups. */
  key: string;
  group: ChangeGroup;
  file: GitFileStatus;
  kind: ChangeKind;
  /** The one-letter mark git users know: M A D R C T U, and ! for a conflict. */
  letter: string;
}

const KIND: Record<string, { kind: ChangeKind; letter: string }> = {
  added: { kind: 'added', letter: 'A' },
  modified: { kind: 'modified', letter: 'M' },
  deleted: { kind: 'deleted', letter: 'D' },
  renamed: { kind: 'renamed', letter: 'R' },
  copied: { kind: 'added', letter: 'C' },
  type_changed: { kind: 'modified', letter: 'T' },
  untracked: { kind: 'untracked', letter: 'U' },
};

/**
 * Sorts every changed file into the groups it belongs to. A conflicted file
 * is only ever "conflicted" — never staged, whatever the index says. A file
 * with some changes staged and others not is listed in both groups, because
 * that is the truth of the index and each half has its own diff.
 */
export function groupChanges(files: readonly GitFileStatus[], locale?: string): Record<ChangeGroup, Change[]> {
  const groups: Record<ChangeGroup, Change[]> = { conflicted: [], staged: [], unstaged: [], untracked: [] };
  for (const file of files) {
    if (file.conflicted) {
      groups.conflicted.push({ key: `conflicted:${file.path}`, group: 'conflicted', file, kind: 'conflicted', letter: '!' });
      continue;
    }
    if (file.index !== null) groups.staged.push({ key: `staged:${file.path}`, group: 'staged', file, ...KIND[file.index]! });
    if (file.worktree === 'untracked') groups.untracked.push({ key: `untracked:${file.path}`, group: 'untracked', file, ...KIND.untracked! });
    else if (file.worktree !== null) groups.unstaged.push({ key: `unstaged:${file.path}`, group: 'unstaged', file, ...KIND[file.worktree]! });
  }
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  for (const group of CHANGE_GROUPS) groups[group].sort((a, b) => collator.compare(a.file.path, b.file.path));
  return groups;
}

/** How many files changed, counting a partly staged file once. */
export const changedFileCount = (status: Pick<GitStatus, 'files'> | undefined): number => status?.files.length ?? 0;

// ---- sync ---------------------------------------------------------------------------

export interface SyncOffers {
  /** There is a remote to talk to at all. */
  remote: string | null;
  fetch: boolean;
  /** Offered when the branch has an upstream; the count is what would arrive (as of the last fetch). */
  pull: { count: number } | null;
  push: { count: number } | null;
  /** The branch exists only here: pushing it creates it on the remote and remembers where it went. */
  publish: boolean;
}

/** Which of fetch, pull, push and publish make sense right now. With no remote configured, none does. */
export function syncOffers(status: Pick<GitStatus, 'branch' | 'defaultRemote' | 'remotes' | 'hasCommits'>): SyncOffers {
  const remote = status.defaultRemote ?? status.remotes[0] ?? null;
  if (remote === null) return { remote: null, fetch: false, pull: null, push: null, publish: false };
  const branch = status.branch;
  if (!branch || branch.detached || branch.name === null) return { remote, fetch: true, pull: null, push: null, publish: false };
  if (branch.upstream === null) return { remote, fetch: true, pull: null, push: null, publish: status.hasCommits };
  return { remote, fetch: true, pull: { count: branch.behind ?? 0 }, push: { count: branch.ahead ?? 0 }, publish: false };
}

/**
 * Whether "undo the last commit" is worth offering. The server refuses for a
 * commit that was already pushed and for a merge; what can be known here is
 * only whether there is an unpushed commit on a branch at all.
 */
export function undoOffer(status: Pick<GitStatus, 'branch' | 'hasCommits'>): { offered: boolean; reason: 'none' | 'no-commits' | 'detached' | 'pushed' } {
  if (!status.hasCommits || !status.branch || status.branch.oid === null) return { offered: false, reason: 'no-commits' };
  if (status.branch.detached) return { offered: false, reason: 'detached' };
  if (status.branch.upstream !== null && (status.branch.ahead ?? 0) === 0) return { offered: false, reason: 'pushed' };
  return { offered: true, reason: 'none' };
}

// ---- refusals ------------------------------------------------------------------------

/** Every code the server defines has a sentence under this key, in every language (a test holds this true). */
export const gitErrorKey = (code: GitErrorCode): MessageKey => `errors.${code}`;

export const isGitErrorCode = (code: string): code is GitErrorCode => (GIT_ERROR_CODES as readonly string[]).includes(code);

/**
 * What the panel offers after a refusal, when there is an honest next step.
 * Never a retry of the same thing with the safety taken off — each of these
 * is a different action the person must choose, and the destructive ones ask again.
 */
export type Recovery = 'pull-with-merge' | 'pull-first' | 'publish' | 'set-identity' | 'force-delete-branch' | 'force-remove-worktree';

export function recoveryFor(code: string, operation: 'pull' | 'push' | 'commit' | 'delete-branch' | 'remove-worktree' | 'other'): Recovery | null {
  if (code === 'git_identity_missing') return 'set-identity';
  if (operation === 'pull' && code === 'git_diverged') return 'pull-with-merge';
  if (operation === 'push' && code === 'git_push_rejected') return 'pull-first';
  if ((operation === 'push' || operation === 'pull') && code === 'git_no_upstream') return 'publish';
  if (operation === 'delete-branch' && code === 'git_branch_not_merged') return 'force-delete-branch';
  if (operation === 'remove-worktree' && code === 'git_worktree_dirty') return 'force-remove-worktree';
  return null;
}

// ---- branches -------------------------------------------------------------------------

/** Local branches, then remote branches that have no local counterpart yet; each filtered by `query`. */
export function listBranches(branches: GitBranches | undefined, query: string): { local: GitBranch[]; remote: GitBranch[] } {
  if (!branches) return { local: [], remote: [] };
  const needle = query.trim().toLowerCase();
  const matches = (branch: GitBranch) => needle === '' || branch.name.toLowerCase().includes(needle);
  const local = branches.branches.filter((branch) => branch.kind === 'local');
  const localNames = new Set(local.map((branch) => branch.name));
  const remote = branches.branches.filter((branch) => {
    if (branch.kind !== 'remote') return false;
    const short = branch.remote && branch.name.startsWith(`${branch.remote}/`) ? branch.name.slice(branch.remote.length + 1) : branch.name;
    // "origin/HEAD" is a pointer, not a branch anyone works on.
    return short !== 'HEAD' && !localNames.has(short);
  });
  return { local: local.filter(matches), remote: remote.filter(matches) };
}

/** The branch a comparison starts against: the repository's main line, unless that is where we are. */
export function defaultCompareBase(branches: GitBranches | undefined): string | null {
  if (!branches) return null;
  const others = branches.branches.filter((branch) => !branch.current);
  if (branches.defaultBranch && branches.defaultBranch !== branches.current && others.some((branch) => branch.name === branches.defaultBranch)) return branches.defaultBranch;
  const remoteDefault = others.find((branch) => branch.kind === 'remote' && branches.defaultBranch !== null && branch.name.endsWith(`/${branches.defaultBranch}`));
  return remoteDefault?.name ?? others.find((branch) => branch.kind === 'local')?.name ?? others[0]?.name ?? null;
}

export const shortOid = (oid: string | null | undefined): string => (oid ? oid.slice(0, 7) : '');

// ---- a commit's patch, file by file -------------------------------------------------------

export interface PatchPart {
  /** The file this piece is about: the one it leaves behind or, for a deletion, the one it removes. Empty when it could not be told. */
  path: string;
  patch: string;
}

/** Git quotes a path that holds unusual characters; a tab follows one that holds a space. */
function plainPath(raw: string): string {
  const text = raw.replace(/\t$/, '');
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return text;
}

function pathOfPiece(piece: string): string {
  const hunk = piece.search(/^@@ /m);
  const preamble = hunk < 0 ? piece : piece.slice(0, hunk);
  const after = /^\+\+\+ (.+)$/m.exec(preamble)?.[1];
  if (after !== undefined && plainPath(after) !== '/dev/null') return plainPath(after).replace(/^b\//, '');
  const before = /^--- (.+)$/m.exec(preamble)?.[1];
  if (before !== undefined && plainPath(before) !== '/dev/null') return plainPath(before).replace(/^a\//, '');
  const renamed = /^rename to (.+)$/m.exec(preamble)?.[1];
  if (renamed !== undefined) return plainPath(renamed);
  // No hunk and no rename (a mode change, a binary file): both names in the first line are the same.
  const both = /^diff --git a\/(.+) b\/(.+)$/m.exec(preamble);
  return both && both[1] === both[2] ? both[1]! : '';
}

/**
 * A patch of several files cut into one piece per file, in the patch's own
 * order. Content lines always begin with a space, `+` or `-`, so a line that
 * starts with `diff --git ` can only be the beginning of the next file.
 */
export function splitPatch(patch: string): PatchPart[] {
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) return patch.trim() === '' ? [] : [{ path: '', patch }];
  return starts.map((start, index) => {
    const piece = patch.slice(start, starts[index + 1] ?? patch.length);
    return { path: pathOfPiece(piece), patch: piece };
  });
}
