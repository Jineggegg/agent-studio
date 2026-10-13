import { describe, expect, it } from 'vitest';
import { isBinaryDiff, parseNameStatus, parseNumstat, parseStatusV2, parseTrack, parseWorktreeList } from './git.parse.js';

const z = (...records: string[]) => records.join('\0') + '\0';
const oid = (c: string) => c.repeat(40);

describe('status (porcelain v2, NUL separated)', () => {
  it('reads the branch header', () => {
    const status = parseStatusV2(z(`# branch.oid ${oid('a')}`, '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1'));
    expect(status).toMatchObject({ oid: oid('a'), head: 'feature/x', detached: false, upstream: 'origin/feature/x', ahead: 2, behind: 1, files: [] });
  });

  it('knows a repository without commits and a detached head', () => {
    expect(parseStatusV2(z('# branch.oid (initial)', '# branch.head main'))).toMatchObject({ oid: null, head: 'main', detached: false, upstream: null, ahead: null });
    expect(parseStatusV2(z(`# branch.oid ${oid('b')}`, '# branch.head (detached)'))).toMatchObject({ head: null, detached: true });
  });

  it('classifies ordinary, renamed, conflicted and untracked entries', () => {
    const status = parseStatusV2(
      z(
        `1 .M N... 100644 100644 100644 ${oid('1')} ${oid('1')} modified.txt`,
        `1 A. N... 000000 100644 100644 ${oid('0')} ${oid('2')} added.txt`,
        `1 D. N... 100644 000000 000000 ${oid('3')} ${oid('0')} staged-delete.txt`,
        `1 .D N... 100644 100644 000000 ${oid('3')} ${oid('3')} deleted.txt`,
        `1 MM N... 100644 100644 100644 ${oid('4')} ${oid('5')} both.txt`,
        `1 .T N... 100644 100644 120000 ${oid('4')} ${oid('4')} now-a-link`,
        `2 R. N... 100644 100644 100644 ${oid('6')} ${oid('6')} R100 new name.txt`,
        'old name.txt',
        `2 C. N... 100644 100644 100644 ${oid('6')} ${oid('6')} C75 copy.txt`,
        'source.txt',
        `u UU N... 100644 100644 100644 100644 ${oid('7')} ${oid('8')} ${oid('9')} conflict.txt`,
        `u DU N... 100644 000000 100644 100644 ${oid('7')} ${oid('0')} ${oid('9')} deleted-by-us.txt`,
        `1 .M S.M. 160000 160000 160000 ${oid('a')} ${oid('a')} vendor/lib`,
        '? untracked.txt',
      ),
    );
    const byPath = Object.fromEntries(status.files.map((file) => [file.path, file]));
    expect(byPath['modified.txt']).toMatchObject({ index: null, worktree: 'modified', conflicted: false });
    expect(byPath['added.txt']).toMatchObject({ index: 'added', worktree: null });
    expect(byPath['staged-delete.txt']).toMatchObject({ index: 'deleted', worktree: null });
    expect(byPath['deleted.txt']).toMatchObject({ index: null, worktree: 'deleted' });
    expect(byPath['both.txt']).toMatchObject({ index: 'modified', worktree: 'modified' });
    expect(byPath['now-a-link']).toMatchObject({ worktree: 'type_changed' });
    expect(byPath['new name.txt']).toMatchObject({ index: 'renamed', originalPath: 'old name.txt' });
    expect(byPath['copy.txt']).toMatchObject({ index: 'copied', originalPath: 'source.txt' });
    // A conflict is never "staged".
    expect(byPath['conflict.txt']).toMatchObject({ index: null, worktree: 'modified', conflicted: true });
    expect(byPath['deleted-by-us.txt']).toMatchObject({ index: null, worktree: 'deleted', conflicted: true });
    expect(byPath['vendor/lib']).toMatchObject({ submodule: true });
    expect(byPath['untracked.txt']).toMatchObject({ index: null, worktree: 'untracked' });
    expect(status.files).toHaveLength(12);
  });

  it.each([
    'with space.txt',
    '  leading and trailing  ',
    'quo"te.txt',
    "apos'trophe.txt",
    '-leading-dash.txt',
    '--option=like',
    'new\nline.txt',
    'tab\there.txt',
    '文件.txt',
    'emoji-🙂.txt',
    'back\\slash',
    'dir with space/inner file.txt',
    '? question',
    '1 .M looks like a record',
    '#hash',
  ])('keeps the odd file name %j intact', (name) => {
    const status = parseStatusV2(z(`1 .M N... 100644 100644 100644 ${oid('1')} ${oid('1')} ${name}`, `? ${name}.untracked`, `2 R. N... 100644 100644 100644 ${oid('6')} ${oid('6')} R100 ${name}.new`, name));
    expect(status.files.map((file) => file.path)).toEqual([name, `${name}.untracked`, `${name}.new`]);
    expect(status.files[2]!.originalPath).toBe(name);
  });

  it('survives truncated and malformed input', () => {
    expect(parseStatusV2('').files).toEqual([]);
    expect(parseStatusV2('1 .M N...').files).toEqual([]);
    expect(parseStatusV2(z('2 R. N... 100644 100644 100644 a b R100 only-half')).files).toEqual([]);
    expect(parseStatusV2(z('! ignored.txt', 'x unknown')).files).toEqual([]);
  });
});

describe('name-status and numstat', () => {
  it('pairs renames and keeps odd names', () => {
    expect(parseNameStatus(z('M', 'a b.txt', 'R087', 'old\nname', 'new name', 'A', '-x', 'D', 'gone', 'T', 'type', 'U', 'unmerged'))).toEqual([
      { path: 'a b.txt', originalPath: null, status: 'M' },
      { path: 'new name', originalPath: 'old\nname', status: 'R' },
      { path: '-x', originalPath: null, status: 'A' },
      { path: 'gone', originalPath: null, status: 'D' },
      { path: 'type', originalPath: null, status: 'T' },
      { path: 'unmerged', originalPath: null, status: 'M' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('reads counts, binary markers and renames', () => {
    const counts = parseNumstat(z('12\t3\ta b.txt', '-\t-\timage.png', '0\t0\t', 'old', 'new', '5\t0\ttab\tin name'));
    expect(counts.get('a b.txt')).toEqual({ additions: 12, deletions: 3 });
    expect(counts.get('image.png')).toEqual({ additions: null, deletions: null });
    expect(counts.get('new')).toEqual({ additions: 0, deletions: 0 });
    expect(counts.get('tab\tin name')).toEqual({ additions: 5, deletions: 0 });
  });
});

describe('worktrees, tracking and binary diffs', () => {
  it('reads the worktree list', () => {
    const list = parseWorktreeList(
      z('worktree /srv/repo', `HEAD ${oid('a')}`, 'branch refs/heads/main', '') +
        z('worktree /srv/repo-worktrees/feature x', `HEAD ${oid('b')}`, 'branch refs/heads/feature/x', 'locked reason', '') +
        z('worktree /srv/elsewhere', `HEAD ${oid('c')}`, 'detached', 'prunable gitdir file points to non-existent location', ''),
    );
    expect(list).toEqual([
      { path: '/srv/repo', oid: oid('a'), branch: 'main', bare: false, detached: false, locked: false, prunable: false },
      { path: '/srv/repo-worktrees/feature x', oid: oid('b'), branch: 'feature/x', bare: false, detached: false, locked: true, prunable: false },
      { path: '/srv/elsewhere', oid: oid('c'), branch: null, bare: false, detached: true, locked: false, prunable: true },
    ]);
  });

  it('reads ahead/behind', () => {
    expect(parseTrack('ahead 2, behind 1')).toEqual({ ahead: 2, behind: 1, gone: false });
    expect(parseTrack('behind 7')).toEqual({ ahead: 0, behind: 7, gone: false });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
    expect(parseTrack('gone')).toEqual({ ahead: 0, behind: 0, gone: true });
  });

  it('tells binary diffs from text', () => {
    expect(isBinaryDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n')).toBe(true);
    expect(isBinaryDiff('diff --git a/x b/x\n@@ -1 +1 @@\n-Binary files differ in spirit\n+text\n')).toBe(false);
  });
});
