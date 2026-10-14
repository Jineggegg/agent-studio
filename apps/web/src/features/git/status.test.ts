import { GIT_ERROR_CODES, type GitBranch, type GitBranches, type GitFileStatus, type GitStatus } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/i18n';
import { en } from '@/i18n/en';
import { zhCN } from '@/i18n/zh-CN';
import { ApiError } from '@/data/http';
import { describeError } from '@/data/errors';
import { hunksOnly, problemOf } from '@/features/projects/tools/kit';
import { changedFileCount, defaultCompareBase, gitErrorKey, groupChanges, isGitErrorCode, listBranches, recoveryFor, shortOid, splitPatch, syncOffers, undoOffer } from './status';

const file = (path: string, index: GitFileStatus['index'], worktree: GitFileStatus['worktree'], extra: Partial<GitFileStatus> = {}): GitFileStatus => ({ path, originalPath: null, index, worktree, conflicted: false, submodule: false, ...extra });

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  state: 'ready',
  message: null,
  branch: { name: 'main', detached: false, oid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0 },
  hasCommits: true,
  remotes: ['origin'],
  defaultRemote: 'origin',
  operation: null,
  files: [],
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  truncated: false,
  ...overrides,
});

describe('grouping changed files', () => {
  const files = [
    file('src/zeta.ts', null, 'modified'),
    file('src/new.ts', 'added', null),
    file('gone.txt', null, 'deleted'),
    file('notes.md', null, 'untracked'),
    file('my file.txt', 'modified', null),
    file('src/renamed.ts', 'renamed', null, { originalPath: 'src/old.ts' }),
    file('src/half.ts', 'modified', 'modified'),
    file('src/both.ts', 'modified', 'modified', { conflicted: true }),
    file('link', 'type_changed', null),
    file('copy.ts', 'copied', null),
  ];
  const groups = groupChanges(files, 'en');
  const paths = (group: keyof typeof groups) => groups[group].map((change) => `${change.letter} ${change.file.path}`);

  it('puts each file in the group its state belongs to, with the letter git users know', () => {
    expect(paths('staged')).toEqual(['C copy.ts', 'T link', 'M my file.txt', 'M src/half.ts', 'A src/new.ts', 'R src/renamed.ts']);
    expect(paths('unstaged')).toEqual(['D gone.txt', 'M src/half.ts', 'M src/zeta.ts']);
    expect(paths('untracked')).toEqual(['U notes.md']);
    expect(paths('conflicted')).toEqual(['! src/both.ts']);
  });

  it('never lists a conflicted file as staged, whatever the index says', () => {
    expect(groups.staged.some((change) => change.file.path === 'src/both.ts')).toBe(false);
    expect(groups.unstaged.some((change) => change.file.path === 'src/both.ts')).toBe(false);
    expect(groups.conflicted[0]).toMatchObject({ kind: 'conflicted', group: 'conflicted' });
  });

  it('lists a partly staged file in both groups, each row with its own key', () => {
    const keys = [...groups.staged, ...groups.unstaged].filter((change) => change.file.path === 'src/half.ts').map((change) => change.key);
    expect(keys).toEqual(['staged:src/half.ts', 'unstaged:src/half.ts']);
    expect(new Set(Object.values(groups).flat().map((change) => change.key)).size).toBe(Object.values(groups).flat().length);
  });

  it('keeps a path with a space whole and a rename under its new path', () => {
    expect(groups.staged.find((change) => change.file.path === 'my file.txt')).toBeDefined();
    expect(groups.staged.find((change) => change.kind === 'renamed')?.file.originalPath).toBe('src/old.ts');
  });

  it('counts a file once however many groups it is in', () => {
    expect(changedFileCount(status({ files }))).toBe(files.length);
    expect(changedFileCount(undefined)).toBe(0);
  });

  it('has nothing in any group for a clean folder', () => {
    expect(groupChanges([])).toEqual({ conflicted: [], staged: [], unstaged: [], untracked: [] });
  });
});

describe('what to offer for the remote', () => {
  it('offers nothing without a remote', () => {
    expect(syncOffers(status({ remotes: [], defaultRemote: null, branch: { name: 'main', detached: false, oid: 'a', upstream: null, ahead: null, behind: null } }))).toEqual({ remote: null, fetch: false, pull: null, push: null, publish: false });
  });

  it('offers only fetch and publish for a branch that exists only here', () => {
    expect(syncOffers(status({ branch: { name: 'topic', detached: false, oid: 'a', upstream: null, ahead: null, behind: null } }))).toEqual({ remote: 'origin', fetch: true, pull: null, push: null, publish: true });
  });

  it('offers pull and push with their counts once there is an upstream', () => {
    expect(syncOffers(status({ branch: { name: 'main', detached: false, oid: 'a', upstream: 'origin/main', ahead: 2, behind: 1 } }))).toEqual({ remote: 'origin', fetch: true, pull: { count: 1 }, push: { count: 2 }, publish: false });
  });

  it('offers only fetch on a detached head, and nothing to publish before the first commit', () => {
    expect(syncOffers(status({ branch: { name: null, detached: true, oid: 'a', upstream: null, ahead: null, behind: null } }))).toMatchObject({ fetch: true, pull: null, push: null, publish: false });
    expect(syncOffers(status({ hasCommits: false, branch: { name: 'main', detached: false, oid: null, upstream: null, ahead: null, behind: null } })).publish).toBe(false);
  });
});

describe('undoing the last commit', () => {
  it('is offered only for a commit that has not been pushed', () => {
    expect(undoOffer(status({ branch: { name: 'main', detached: false, oid: 'a', upstream: 'origin/main', ahead: 1, behind: 0 } }))).toEqual({ offered: true, reason: 'none' });
    expect(undoOffer(status({ branch: { name: 'topic', detached: false, oid: 'a', upstream: null, ahead: null, behind: null } })).offered).toBe(true);
    expect(undoOffer(status())).toEqual({ offered: false, reason: 'pushed' });
    expect(undoOffer(status({ hasCommits: false }))).toEqual({ offered: false, reason: 'no-commits' });
    expect(undoOffer(status({ branch: { name: null, detached: true, oid: 'a', upstream: null, ahead: null, behind: null } }))).toEqual({ offered: false, reason: 'detached' });
  });
});

describe('refusals', () => {
  it('has a sentence for every code the server defines, in both languages', () => {
    expect(GIT_ERROR_CODES.length).toBeGreaterThan(30);
    for (const code of GIT_ERROR_CODES) {
      const key = gitErrorKey(code);
      expect(en[key], `${code} (en)`).toBeTruthy();
      expect(zhCN[key], `${code} (zh-CN)`).toBeTruthy();
      expect(zhCN[key], `${code} is translated`).not.toBe(en[key]);
      // Never just "failed": every sentence says something about what happened.
      expect(en[key].split(' ').length, code).toBeGreaterThan(3);
    }
  });

  it.each([
    ['git_auth_failed', /credentials/i],
    ['git_push_rejected', /rejected/i],
    ['git_diverged', /diverged/i],
    ['git_network', /could not be reached/i],
    ['git_timeout', /did not finish in time/i],
    ['git_conflict', /conflict/i],
  ] as const)('turns %s into words that name the cause', (code, pattern) => {
    const t = getTranslator('en');
    expect(describeError(new ApiError(502, code, 'server wording'), t)).toMatch(pattern);
    expect(describeError(new ApiError(502, code, 'server wording'), getTranslator('zh-CN'))).toBe(zhCN[gitErrorKey(code)]);
  });

  it('keeps git\'s own wording, and the server\'s more specific sentence, folded under the translated one', () => {
    const t = getTranslator('en');
    const problem = problemOf(new ApiError(409, 'git_push_rejected', 'The remote rejected the push because it has commits this branch lacks.', { output: ' ! [rejected] main -> main (fetch first)' }), t);
    expect(problem.text).toBe(en['errors.git_push_rejected']);
    expect(problem.code).toBe('git_push_rejected');
    expect(problem.detail).toContain('[rejected] main -> main');
    expect(problem.detail).toContain('The remote rejected the push');
    const conflict = problemOf(new ApiError(409, 'git_conflict', 'Merging would conflict.', { files: ['a.ts', 'b.ts'] }), t);
    expect(conflict.detail).toContain('a.ts\nb.ts');
  });

  it('knows which codes are git\'s', () => {
    expect(isGitErrorCode('git_busy')).toBe(true);
    expect(isGitErrorCode('file_changed')).toBe(false);
  });

  it('offers a next step only where there is an honest one', () => {
    expect(recoveryFor('git_diverged', 'pull')).toBe('pull-with-merge');
    expect(recoveryFor('git_push_rejected', 'push')).toBe('pull-first');
    expect(recoveryFor('git_no_upstream', 'push')).toBe('publish');
    expect(recoveryFor('git_identity_missing', 'commit')).toBe('set-identity');
    expect(recoveryFor('git_branch_not_merged', 'delete-branch')).toBe('force-delete-branch');
    expect(recoveryFor('git_worktree_dirty', 'remove-worktree')).toBe('force-remove-worktree');
    // The same code elsewhere is not an invitation to force anything.
    expect(recoveryFor('git_worktree_dirty', 'other')).toBeNull();
    expect(recoveryFor('git_branch_not_merged', 'other')).toBeNull();
    expect(recoveryFor('git_auth_failed', 'push')).toBeNull();
    expect(recoveryFor('git_would_overwrite', 'other')).toBeNull();
  });
});

describe('branches', () => {
  const branch = (name: string, kind: 'local' | 'remote', extra: Partial<GitBranch> = {}): GitBranch => ({
    name,
    kind,
    remote: kind === 'remote' ? 'origin' : null,
    current: false,
    oid: 'a'.repeat(40),
    upstream: null,
    upstreamGone: false,
    ahead: null,
    behind: null,
    subject: 'work',
    committedAt: 1,
    checkedOutElsewhere: false,
    ...extra,
  });
  const branches: GitBranches = {
    current: 'feature/login',
    detached: false,
    defaultBranch: 'main',
    branches: [branch('feature/login', 'local', { current: true }), branch('main', 'local'), branch('origin/HEAD', 'remote'), branch('origin/main', 'remote'), branch('origin/release', 'remote')],
  };

  it('lists local branches, then remote ones that have no local counterpart', () => {
    const listed = listBranches(branches, '');
    expect(listed.local.map((entry) => entry.name)).toEqual(['feature/login', 'main']);
    expect(listed.remote.map((entry) => entry.name)).toEqual(['origin/release']);
  });

  it('filters by name without regard to case', () => {
    expect(listBranches(branches, 'LOG').local.map((entry) => entry.name)).toEqual(['feature/login']);
    expect(listBranches(branches, 'rel').remote.map((entry) => entry.name)).toEqual(['origin/release']);
    expect(listBranches(undefined, '')).toEqual({ local: [], remote: [] });
  });

  it('compares against the main line by default, unless that is where we are', () => {
    expect(defaultCompareBase(branches)).toBe('main');
    expect(defaultCompareBase({ ...branches, current: 'main', branches: branches.branches.map((entry) => ({ ...entry, current: entry.name === 'main' })) })).toBe('origin/main');
    expect(defaultCompareBase({ current: 'main', detached: false, defaultBranch: 'main', branches: [branch('main', 'local', { current: true })] })).toBeNull();
    expect(defaultCompareBase(undefined)).toBeNull();
  });

  it('shortens commit ids', () => {
    expect(shortOid('0123456789abcdef')).toBe('0123456');
    expect(shortOid(null)).toBe('');
  });
});

describe('a patch, file by file', () => {
  const modified = ['diff --git a/src/app.ts b/src/app.ts', 'index 58228b8..0824b29 100644', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three', ''].join('\n');
  const added = ['diff --git a/docs/new file.md b/docs/new file.md', 'new file mode 100644', 'index 0000000..e69de29', '--- /dev/null', '+++ b/docs/new file.md\t', '@@ -0,0 +1 @@', '+hello', ''].join('\n');
  const deleted = ['diff --git a/old.txt b/old.txt', 'deleted file mode 100644', 'index e69de29..0000000', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', ''].join('\n');
  const renamed = ['diff --git a/a.txt b/b.txt', 'similarity index 100%', 'rename from a.txt', 'rename to b.txt', ''].join('\n');
  const mode = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n');
  const quoted = ['diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"', 'index 1..2 100644', '--- "a/we\\"ird.txt"', '+++ "b/we\\"ird.txt"', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');

  it('cuts at each file and names every piece by its file', () => {
    const parts = splitPatch(modified + added + deleted + renamed + mode + quoted);
    expect(parts.map((part) => part.path)).toEqual(['src/app.ts', 'docs/new file.md', 'old.txt', 'b.txt', 'run.sh', 'we"ird.txt']);
    expect(parts.map((part) => part.patch).join('')).toBe(modified + added + deleted + renamed + mode + quoted);
    expect(parts[0]!.patch).toBe(modified);
  });

  it('is not fooled by content that looks like a header', () => {
    const tricky = ['diff --git a/notes.md b/notes.md', '--- a/notes.md', '+++ b/notes.md', '@@ -1,2 +1,3 @@', ' diff --git a/x b/x', '+--- a/not-a-header', '-+++ b/not-a-header', ''].join('\n');
    const parts = splitPatch(tricky);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.path).toBe('notes.md');
  });

  it('has nothing to say about nothing, and keeps what it cannot name', () => {
    expect(splitPatch('')).toEqual([]);
    expect(splitPatch('  \n')).toEqual([]);
    expect(splitPatch('@@ -1 +1 @@\n-a\n+b\n')).toEqual([{ path: '', patch: '@@ -1 +1 @@\n-a\n+b\n' }]);
  });

  it('shows one file’s hunks without git’s preamble, unless the preamble is all there is', () => {
    expect(hunksOnly(modified)).toBe('@@ -1,2 +1,3 @@\n one\n+two\n three\n');
    expect(hunksOnly(renamed)).toBe(renamed);
    expect(hunksOnly(mode)).toBe(mode);
    expect(hunksOnly('')).toBe('');
  });
});
