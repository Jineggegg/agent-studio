import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitBaseline,
  GitBranches,
  GitCommitDetail,
  GitCommitResult,
  GitComparison,
  GitFileDiff,
  GitFileStatus,
  GitIdentityState,
  GitLog,
  GitStatus,
  Project,
} from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { createGitSandbox, type GitSandbox } from '../../src/modules/git/testing/fixtures.js';
import { createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

let sandbox: GitSandbox;
let t: TestStudio;
let owner: TestClient;

beforeEach(async () => {
  sandbox = await createGitSandbox();
  t = await createTestStudio();
  owner = await t.owner();
});
afterEach(async () => {
  await t.close();
  await sandbox.restore();
});

interface Repo {
  project: Project;
  dir: string;
  url: (suffix: string) => string;
  git: (...args: string[]) => Promise<string>;
}

async function register(name: string, dir: string): Promise<Repo> {
  const response = await owner.post<Project>('/api/projects', { name, rootDir: dir, createDirectory: true });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const project = response.body;
  return { project, dir: project.rootDir, url: (suffix) => `/api/projects/${project.id}/git/${suffix}`, git: (...args) => sandbox.git(project.rootDir, ...args) };
}

/** A registered project whose folder is a repository with one commit. */
async function repo(name = 'demo', files?: Record<string, string>): Promise<Repo> {
  const dir = path.join(t.workspace, name);
  await sandbox.repo(dir, files);
  return register(name, dir);
}

const status = async (r: Repo, client: TestClient = owner) => {
  const response = await client.get<GitStatus>(r.url('status'));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
};
const fileOf = (s: GitStatus, file: string): GitFileStatus | undefined => s.files.find((entry) => entry.path === file);
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const errorCode = (body: unknown): string | undefined => (body as { error?: { code?: string } } | undefined)?.error?.code;

const MISSING = '00000000000000000000000000';

describe('what kind of folder it is', () => {
  it('reports a folder without a repository, initialises it, and makes the first commit', async () => {
    const dir = path.join(t.workspace, 'plain');
    await sandbox.write(dir, { 'a.txt': 'a\n', 'src/b.txt': 'b\n' });
    const r = await register('plain', dir);

    const before = await status(r);
    expect(before).toMatchObject({ state: 'none', branch: null, hasCommits: false, files: [] });
    expect(before.message).toContain('not a git repository');
    // Everything else says the same thing as an error, not as a crash.
    expect((await owner.get(r.url('branches'))).body).toMatchObject({ error: { code: 'git_not_a_repository' } });
    expect((await owner.post(r.url('stage'), { all: true })).status).toBe(409);

    expect((await owner.post(r.url('init'))).body).toEqual({ created: true });
    expect((await owner.post(r.url('init'))).body).toEqual({ created: false });
    const fresh = await status(r);
    expect(fresh).toMatchObject({ state: 'ready', hasCommits: false, branch: { name: 'main', oid: null, detached: false } });
    expect(fresh.files.map((file) => file.path).sort()).toEqual(['a.txt', 'src/b.txt']);
    expect((await owner.get<GitLog>(r.url('log'))).body).toEqual({ commits: [], nextCursor: null });

    const first = await owner.post<GitCommitResult>(r.url('initial-commit'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ subject: 'Initial commit', branch: 'main' });
    expect((await r.git('ls-tree', '-r', '--name-only', 'HEAD')).trim().split('\n').sort()).toEqual(['a.txt', 'src/b.txt']);
    expect((await status(r)).files).toEqual([]);

    const again = await owner.post(r.url('initial-commit'));
    expect(again.status).toBe(400);
    expect(errorCode(again.body)).toBe('git_has_commits');
    expect((await r.git('rev-list', '--count', 'HEAD')).trim()).toBe('1');
  });

  it('does not manage a folder that merely sits inside a larger repository', async () => {
    const outer = path.join(t.workspace, 'outer');
    await sandbox.repo(outer, { 'top.txt': 'top\n', 'packages/inner/file.txt': 'inner\n' });
    const r = await register('inner', path.join(outer, 'packages/inner'));
    await writeFile(path.join(outer, 'top.txt'), 'changed outside the project\n');

    const inner = await status(r);
    expect(inner.state).toBe('nested');
    expect(inner.files).toEqual([]);
    // Nothing of the enclosing repository can be staged, committed or discarded through the inner project.
    expect((await owner.post(r.url('stage'), { all: true })).status).toBe(409);
    expect((await owner.post(r.url('commit'), { message: 'x' })).status).toBe(409);
    expect((await sandbox.git(outer, 'status', '--porcelain')).trim()).toBe('M top.txt');
  });

  it('recognises a bare repository and a repository git does not trust', async () => {
    const bareDir = path.join(t.workspace, 'bare');
    await mkdir(bareDir, { recursive: true });
    await sandbox.git(bareDir, 'init', '--quiet', '--bare');
    expect((await status(await register('bare', bareDir))).state).toBe('bare');

    // Git's own switch for "this folder belongs to someone else" — the same refusal a real foreign folder gets.
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    const other = await createTestStudio({ config: { childEnvPassthrough: ['GIT_TEST_ASSUME_DIFFERENT_OWNER'] } });
    try {
      const admin = await other.owner();
      const dir = path.join(other.workspace, 'foreign');
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
      await sandbox.repo(dir);
      process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
      const project = (await admin.post<Project>('/api/projects', { name: 'foreign', rootDir: dir })).body;
      const foreign = (await admin.get<GitStatus>(`/api/projects/${project.id}/git/status`)).body;
      expect(foreign.state).toBe('untrusted');
      expect(foreign.message).toContain('safe.directory');
      // The server does not override git's judgement to get its way.
      const refused = await admin.post(`/api/projects/${project.id}/git/stage`, { all: true });
      expect(refused.status).toBe(409);
      expect(errorCode(refused.body)).toBe('git_untrusted');
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
      await other.close();
    }
  });

  it('answers 404 when the project folder has vanished', async () => {
    const r = await repo('vanishing');
    await rm(r.dir, { recursive: true });
    const response = await owner.get(r.url('status'));
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('project_folder_missing');
  });
});

const ODD_NAMES = ['with space.txt', 'quo"te.txt', "apos'trophe.txt", '-leading-dash.txt', '--output=evil.txt', '文件 名.txt', 'new\nline.txt', 'tab\tname.txt', 'semi;colon $(x).txt', 'back\\slash.txt', 'star*.txt'];

describe('status', () => {
  it('sorts every kind of change into the right place', async () => {
    const r = await repo('matrix', {
      'modified.txt': 'one\n',
      'deleted.txt': 'gone soon\n',
      'staged-delete.txt': 'gone sooner\n',
      'renamed-from.txt': 'this content is long enough for git to recognise the rename\n',
      'both.txt': 'base\n',
      'clean.txt': 'untouched\n',
    });
    await writeFile(path.join(r.dir, 'modified.txt'), 'two\n');
    await rm(path.join(r.dir, 'deleted.txt'));
    await r.git('rm', '--quiet', 'staged-delete.txt');
    await r.git('mv', 'renamed-from.txt', 'renamed-to.txt');
    await sandbox.write(r.dir, { 'added.txt': 'new\n', 'untracked.txt': 'loose\n', 'nested/deep/untracked.txt': 'loose\n', 'both.txt': 'staged\n' });
    await r.git('add', 'added.txt', 'both.txt');
    await writeFile(path.join(r.dir, 'both.txt'), 'staged and then edited\n');

    const s = await status(r);
    expect(s).toMatchObject({ state: 'ready', hasCommits: true, operation: null, remotes: [], defaultRemote: null, truncated: false });
    expect(s.branch).toMatchObject({ name: 'main', detached: false, upstream: null, ahead: null, behind: null });
    expect(s.branch!.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(fileOf(s, 'modified.txt')).toMatchObject({ index: null, worktree: 'modified', conflicted: false });
    expect(fileOf(s, 'deleted.txt')).toMatchObject({ index: null, worktree: 'deleted' });
    expect(fileOf(s, 'staged-delete.txt')).toMatchObject({ index: 'deleted', worktree: null });
    expect(fileOf(s, 'added.txt')).toMatchObject({ index: 'added', worktree: null });
    expect(fileOf(s, 'both.txt')).toMatchObject({ index: 'modified', worktree: 'modified' });
    // A staged rename appears once, under its new path.
    expect(fileOf(s, 'renamed-to.txt')).toMatchObject({ index: 'renamed', originalPath: 'renamed-from.txt' });
    expect(fileOf(s, 'renamed-from.txt')).toBeUndefined();
    expect(fileOf(s, 'untracked.txt')).toMatchObject({ index: null, worktree: 'untracked' });
    // Untracked files are listed one by one, not as a folder.
    expect(fileOf(s, 'nested/deep/untracked.txt')).toMatchObject({ worktree: 'untracked' });
    expect(fileOf(s, 'clean.txt')).toBeUndefined();
    expect(s.counts).toEqual({ staged: 4, unstaged: 3, untracked: 2, conflicted: 0 });
  });

  it('keeps odd file names intact and can act on each of them', async () => {
    const r = await repo('odd');
    await sandbox.write(r.dir, Object.fromEntries(ODD_NAMES.map((name) => [name, `content of ${JSON.stringify(name)}\n`])));
    const untracked = await status(r);
    expect(untracked.files.map((file) => file.path).sort()).toEqual([...ODD_NAMES].sort());

    for (const name of ODD_NAMES) {
      const diff = await owner.get<GitFileDiff>(r.url(`diff?${q({ path: name })}`));
      expect(diff.status, name).toBe(200);
      expect(diff.body.diff, name).toContain('+content of ');
      expect((await owner.post(r.url('stage'), { paths: [name] })).status, name).toBe(204);
    }
    const staged = await status(r);
    expect(staged.files.filter((file) => file.index === 'added').map((file) => file.path).sort()).toEqual([...ODD_NAMES].sort());
    // Nothing was created by an "option": the folder holds exactly the files that were written.
    expect(existsSync(path.join(r.dir, 'evil.txt'))).toBe(false);

    const committed = await owner.post<GitCommitResult>(r.url('commit'), { message: 'odd names' });
    expect(committed.status).toBe(200);
    expect((await r.git('ls-tree', '-r', '-z', '--name-only', 'HEAD')).split('\0').filter(Boolean).sort()).toEqual(['README.md', ...ODD_NAMES].sort());

    for (const name of ODD_NAMES) await writeFile(path.join(r.dir, name), 'edited\n');
    for (const name of ODD_NAMES) {
      expect((await owner.get<GitBaseline>(r.url(`baseline?${q({ path: name })}`))).body, name).toMatchObject({ kind: 'text', content: `content of ${JSON.stringify(name)}\n` });
      expect((await owner.post(r.url('discard'), { path: name })).status, name).toBe(204);
    }
    expect((await status(r)).files).toEqual([]);
  });

  it('shows a conflicted file as a change, never as staged, and names the unfinished merge', async () => {
    const r = await repo('conflict', { 'shared.txt': 'base\n' });
    await r.git('switch', '--quiet', '-c', 'theirs');
    await writeFile(path.join(r.dir, 'shared.txt'), 'theirs\n');
    await r.git('commit', '--quiet', '-am', 'theirs');
    await r.git('switch', '--quiet', 'main');
    await writeFile(path.join(r.dir, 'shared.txt'), 'ours\n');
    await r.git('commit', '--quiet', '-am', 'ours');
    expect((await sandbox.tryGit(r.dir, 'merge', 'theirs')).code).not.toBe(0);

    const s = await status(r);
    expect(s.operation).toBe('merge');
    expect(fileOf(s, 'shared.txt')).toMatchObject({ index: null, worktree: 'modified', conflicted: true });
    expect(s.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 1 });

    // Committing with conflicts is refused; switching away from a half-done merge too.
    expect(errorCode((await owner.post(r.url('commit'), { message: 'no' })).body)).toBe('git_conflict');
    expect(errorCode((await owner.post(r.url('switch'), { branch: 'theirs' })).body)).toBe('git_operation_in_progress');
    expect(errorCode((await owner.post(r.url('undo-commit'))).body)).toBe('git_operation_in_progress');
    // Resolving by hand and staging lets the merge be concluded with an ordinary commit.
    await writeFile(path.join(r.dir, 'shared.txt'), 'resolved\n');
    expect((await owner.post(r.url('stage'), { paths: ['shared.txt'] })).status).toBe(204);
    expect((await owner.post(r.url('commit'), { message: 'merge theirs' })).status).toBe(200);
    expect((await r.git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')).toHaveLength(3);
    expect((await status(r)).operation).toBeNull();
  });

  it('describes a detached head and a branch that tracks nothing', async () => {
    const r = await repo('detached');
    const head = (await r.git('rev-parse', 'HEAD')).trim();
    await r.git('checkout', '--quiet', '--detach');
    expect((await status(r)).branch).toEqual({ name: null, detached: true, oid: head, upstream: null, ahead: null, behind: null });
    expect((await owner.get<GitBranches>(r.url('branches'))).body).toMatchObject({ current: null, detached: true });
  });

  it('cuts a very long change list and says so', async () => {
    const r = await repo('many');
    t.studio.context.services.git.limits.statusFiles = 5;
    await sandbox.write(r.dir, Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`file-${String(index).padStart(2, '0')}.txt`, 'x\n'])));
    const s = await status(r);
    expect(s.files).toHaveLength(5);
    expect(s.truncated).toBe(true);
    expect(s.counts.untracked).toBe(12);
  });
});

describe('diffs', () => {
  it('shows unstaged, staged and untracked changes, and tells binary from text', async () => {
    const r = await repo('diffs', { 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n' });
    await writeFile(path.join(r.dir, 'a.txt'), 'one\nTWO\nthree\n');
    const unstaged = (await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'a.txt' })}`))).body;
    expect(unstaged).toMatchObject({ path: 'a.txt', binary: false, truncated: false });
    expect(unstaged.diff).toContain('-two\n+TWO');
    expect((await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'a.txt', staged: 'true' })}`))).body.diff).toBe('');

    await r.git('add', 'a.txt');
    await writeFile(path.join(r.dir, 'a.txt'), 'one\nTWO\nTHREE\n');
    expect((await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'a.txt', staged: 'true' })}`))).body.diff).toContain('-two\n+TWO');
    const second = (await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'a.txt' })}`))).body.diff;
    expect(second).toContain('-three\n+THREE');
    expect(second).not.toContain('-two');

    await rm(path.join(r.dir, 'gone.txt'));
    expect((await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'gone.txt' })}`))).body.diff).toContain('-bye');

    await sandbox.write(r.dir, { 'new.txt': 'first line\nsecond line\n', 'image.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0xff]) });
    const untracked = (await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'new.txt' })}`))).body;
    expect(untracked.diff).toContain('+first line\n+second line');
    expect(untracked.diff).not.toMatch(/^-[^-]/m);
    expect((await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'image.bin' })}`))).body).toMatchObject({ binary: true, diff: '' });
    // A file with nothing to show is an empty diff, not an error.
    expect((await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'README.md' })}`))).body).toMatchObject({ diff: '', binary: false, truncated: false });
  });

  it('cuts an oversized diff at a line boundary and flags it', async () => {
    const r = await repo('bigdiff', { 'big.txt': 'x\n' });
    t.studio.context.services.git.limits.diffBytes = 4000;
    await writeFile(path.join(r.dir, 'big.txt'), Array.from({ length: 5000 }, (_, index) => `line number ${index}`).join('\n') + '\n');
    const diff = (await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'big.txt' })}`))).body;
    expect(diff.truncated).toBe(true);
    expect(diff.diff.length).toBeLessThanOrEqual(4000);
    expect(diff.diff.endsWith('\n')).toBe(true);
    expect(diff.diff).toContain('+line number 0');
  });

  it('hands an editor the last committed content', async () => {
    const r = await repo('baseline', { 'text.txt': 'committed\r\nwith crlf\r\n' });
    await sandbox.write(r.dir, { 'binary.bin': Buffer.from([0, 1, 2, 3, 255]), 'big.txt': 'y'.repeat(5000) });
    await r.git('add', '--all');
    await r.git('commit', '--quiet', '-m', 'more');
    await sandbox.write(r.dir, { 'text.txt': 'edited\n', 'untracked.txt': 'new\n' });
    t.studio.context.services.git.limits.baselineBytes = 1000;

    const baseline = async (file: string) => (await owner.get<GitBaseline>(r.url(`baseline?${q({ path: file })}`))).body;
    expect(await baseline('text.txt')).toEqual({ path: 'text.txt', kind: 'text', content: 'committed\r\nwith crlf\r\n' });
    expect(await baseline('binary.bin')).toEqual({ path: 'binary.bin', kind: 'binary', content: null });
    expect(await baseline('big.txt')).toEqual({ path: 'big.txt', kind: 'too_large', content: null });
    expect(await baseline('untracked.txt')).toEqual({ path: 'untracked.txt', kind: 'none', content: null });
    expect(await baseline('never-existed.txt')).toEqual({ path: 'never-existed.txt', kind: 'none', content: null });
  });
});

describe('staging, discarding and deleting', () => {
  it('stages and unstages single files and everything, reflecting the real index', async () => {
    const r = await repo('index', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    const events: StudioEvent[] = [];
    t.studio.context.bus.onTopic(`project:${r.project.id}`, (event) => events.push(event));
    const stagedNames = async () => (await r.git('diff', '--cached', '--name-only')).trim().split('\n').filter(Boolean).sort();

    await sandbox.write(r.dir, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'new.txt': 'n\n' });
    await rm(path.join(r.dir, 'c.txt'));
    expect((await owner.post(r.url('stage'), { paths: ['a.txt'] })).status).toBe(204);
    expect(await stagedNames()).toEqual(['a.txt']);
    expect(events.map((event) => [event.type, event.data])).toContainEqual(['git.changed', { projectId: r.project.id, reason: 'stage' }]);

    // Staging a deleted file stages its removal.
    expect((await owner.post(r.url('stage'), { paths: ['c.txt', 'new.txt'] })).status).toBe(204);
    expect(await stagedNames()).toEqual(['a.txt', 'c.txt', 'new.txt']);
    expect((await owner.post(r.url('unstage'), { paths: ['a.txt', 'c.txt'] })).status).toBe(204);
    expect(await stagedNames()).toEqual(['new.txt']);

    expect((await owner.post(r.url('stage'), { all: true })).status).toBe(204);
    expect(await stagedNames()).toEqual(['a.txt', 'b.txt', 'c.txt', 'new.txt']);
    expect((await owner.post(r.url('unstage'), { all: true })).status).toBe(204);
    expect(await stagedNames()).toEqual([]);

    // Something staged outside the Studio shows up on the next read.
    await r.git('add', 'b.txt');
    expect(fileOf(await status(r), 'b.txt')).toMatchObject({ index: 'modified', worktree: null });
  });

  it('unstages before the first commit, and keeps a rename whole', async () => {
    const dir = path.join(t.workspace, 'unborn');
    await sandbox.write(dir, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const fresh = await register('unborn', dir);
    await owner.post(fresh.url('init'));
    await owner.post(fresh.url('stage'), { all: true });
    expect((await owner.post(fresh.url('unstage'), { paths: ['a.txt'] })).status).toBe(204);
    expect(fileOf(await status(fresh), 'a.txt')).toMatchObject({ index: null, worktree: 'untracked' });
    expect((await owner.post(fresh.url('unstage'), { all: true })).status).toBe(204);
    expect((await status(fresh)).counts.staged).toBe(0);
    expect(existsSync(path.join(dir, 'b.txt'))).toBe(true);

    const r = await repo('renames', { 'old.txt': 'a file whose content is distinctive enough to be followed\n' });
    await r.git('mv', 'old.txt', 'new.txt');
    expect((await owner.post(r.url('unstage'), { paths: ['new.txt'] })).status).toBe(204);
    // Both halves were unstaged: the old name is back in the index, the new one is merely a loose file.
    const s = await status(r);
    expect(fileOf(s, 'old.txt')).toMatchObject({ index: null, worktree: 'deleted' });
    expect(fileOf(s, 'new.txt')).toMatchObject({ worktree: 'untracked' });
  });

  it('discards changes to tracked files and refuses what is not a tracked change', async () => {
    const r = await repo('discard', { 'a.txt': 'a\n', 'gone.txt': 'g\n', 'moved.txt': 'content that moves from one name to another one\n' });
    await sandbox.write(r.dir, { 'a.txt': 'edited\n', 'added.txt': 'new\n', 'loose.txt': 'loose\n' });
    await rm(path.join(r.dir, 'gone.txt'));
    await r.git('add', 'added.txt', 'a.txt');
    await writeFile(path.join(r.dir, 'a.txt'), 'edited twice\n');
    await r.git('mv', 'moved.txt', 'moved-here.txt');

    expect((await owner.post(r.url('discard'), { path: 'a.txt' })).status).toBe(204);
    expect(await readFile(path.join(r.dir, 'a.txt'), 'utf8')).toBe('a\n');
    expect((await owner.post(r.url('discard'), { path: 'gone.txt' })).status).toBe(204);
    expect(await readFile(path.join(r.dir, 'gone.txt'), 'utf8')).toBe('g\n');
    // A file that was only just added is unstaged, not deleted.
    expect((await owner.post(r.url('discard'), { path: 'added.txt' })).status).toBe(204);
    expect(await readFile(path.join(r.dir, 'added.txt'), 'utf8')).toBe('new\n');
    expect(fileOf(await status(r), 'added.txt')).toMatchObject({ index: null, worktree: 'untracked' });
    // A staged rename is undone as a whole.
    expect((await owner.post(r.url('discard'), { path: 'moved-here.txt' })).status).toBe(204);
    expect(existsSync(path.join(r.dir, 'moved.txt'))).toBe(true);
    expect(existsSync(path.join(r.dir, 'moved-here.txt'))).toBe(false);

    const untracked = await owner.post(r.url('discard'), { path: 'loose.txt' });
    expect([untracked.status, errorCode(untracked.body)]).toEqual([400, 'git_not_tracked']);
    const clean = await owner.post(r.url('discard'), { path: 'README.md' });
    expect([clean.status, errorCode(clean.body)]).toEqual([400, 'git_nothing_to_discard']);
    expect(await readFile(path.join(r.dir, 'loose.txt'), 'utf8')).toBe('loose\n');
  });

  it('deletes an untracked file, and only an untracked file', async () => {
    const r = await repo('untracked', { 'tracked.txt': 't\n' });
    const outside = path.join(path.dirname(t.workspace), 'outside-target.txt');
    await writeFile(outside, 'must survive\n');
    await sandbox.write(r.dir, { 'loose.txt': 'l\n', 'tracked.txt': 'modified\n' });
    await symlink(outside, path.join(r.dir, 'loose-link'));

    expect((await owner.post(r.url('delete-untracked'), { path: 'loose.txt' })).status).toBe(204);
    expect(existsSync(path.join(r.dir, 'loose.txt'))).toBe(false);
    // An untracked link is removed as a link; what it points to is not touched.
    expect((await owner.post(r.url('delete-untracked'), { path: 'loose-link' })).status).toBe(204);
    expect(existsSync(path.join(r.dir, 'loose-link'))).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('must survive\n');

    for (const file of ['tracked.txt', 'README.md', 'no-such-file.txt']) {
      const response = await owner.post(r.url('delete-untracked'), { path: file });
      expect([response.status, errorCode(response.body)], file).toEqual([400, 'git_not_untracked']);
    }
    expect(await readFile(path.join(r.dir, 'tracked.txt'), 'utf8')).toBe('modified\n');
  });
});

describe('committing', () => {
  it('commits exactly what is staged, with the message as written', async () => {
    const r = await repo('commits', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    await sandbox.write(r.dir, { 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'C\n' });

    const nothing = await owner.post(r.url('commit'), { message: 'nothing staged' });
    expect([nothing.status, errorCode(nothing.body)]).toEqual([409, 'git_nothing_to_commit']);
    for (const message of ['', '   \n\t ']) {
      const blank = await owner.post(r.url('commit'), { message });
      expect([blank.status, errorCode(blank.body)]).toEqual([400, 'invalid_message']);
    }

    await owner.post(r.url('stage'), { paths: ['a.txt', 'b.txt'] });
    const committed = await owner.post<GitCommitResult>(r.url('commit'), { message: 'm' });
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({ subject: 'm', branch: 'main' });
    expect(committed.body.oid).toBe((await r.git('rev-parse', 'HEAD')).trim());
    expect((await r.git('show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort()).toEqual(['a.txt', 'b.txt']);
    expect(fileOf(await status(r), 'c.txt')).toMatchObject({ index: null, worktree: 'modified' });

    // "paths" stages first; the message may look like options and is still just a message.
    const hostile = await owner.post<GitCommitResult>(r.url('commit'), { message: '--amend --no-verify -m pwned\n\nbody --author=x', paths: ['c.txt'] });
    expect(hostile.status).toBe(200);
    expect(hostile.body.subject).toBe('--amend --no-verify -m pwned');
    expect((await r.git('rev-list', '--count', 'HEAD')).trim()).toBe('3');
    expect((await r.git('log', '-1', '--format=%B')).trim()).toBe('--amend --no-verify -m pwned\n\nbody --author=x');
    expect((await r.git('log', '-1', '--format=%an <%ae>')).trim()).toBe('Fixture Author <fixture@example.test>');
  });

  it('uses the caller’s saved identity, and each user their own', async () => {
    const r = await repo('identity');
    const member = await t.member('alice');
    await owner.put(`/api/projects/${r.project.id}/members/${member.userId}`, { access: 'write' });

    expect((await owner.get<GitIdentityState>('/api/git/identity')).body).toEqual({ source: 'host', name: 'Fixture Author', email: 'fixture@example.test' });
    for (const bad of [{ name: 'Ada', email: 'not-an-email' }, { name: '', email: 'ada@example.org' }, { name: 'Ada <x>', email: 'ada@example.org' }, { name: 'Ada\nInjected: header', email: 'ada@example.org' }, { name: 'Ada' }]) {
      expect((await owner.put('/api/git/identity', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await owner.put<GitIdentityState>('/api/git/identity', { name: 'Ada Lovelace', email: 'ada@example.org' })).body).toEqual({ source: 'user', name: 'Ada Lovelace', email: 'ada@example.org' });
    expect((await owner.get<GitIdentityState>('/api/git/identity')).body.source).toBe('user');
    expect((await member.get<GitIdentityState>('/api/git/identity')).body.source).toBe('host');
    expect((await t.anonymous().get('/api/git/identity')).status).toBe(401);

    await writeFile(path.join(r.dir, 'one.txt'), '1\n');
    await owner.post(r.url('commit'), { message: 'by ada', paths: ['one.txt'] });
    expect((await r.git('log', '-1', '--format=%an <%ae> / %cn <%ce>')).trim()).toBe('Ada Lovelace <ada@example.org> / Ada Lovelace <ada@example.org>');
    await writeFile(path.join(r.dir, 'two.txt'), '2\n');
    await member.post(r.url('commit'), { message: 'by alice', paths: ['two.txt'] });
    expect((await r.git('log', '-1', '--format=%an')).trim()).toBe('Fixture Author');
    // The identity lives with the user, not in the machine's git configuration.
    expect((await sandbox.git(r.dir, 'config', '--global', 'user.name')).trim()).toBe('Fixture Author');
  });

  it('says so when git does not know who is committing', async () => {
    await writeFile(path.join(sandbox.home, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n');
    const dir = path.join(t.workspace, 'anonymous');
    await sandbox.write(dir, { 'a.txt': 'a\n' });
    const r = await register('anonymous', dir);
    await owner.post(r.url('init'));
    expect((await owner.get<GitIdentityState>('/api/git/identity')).body).toEqual({ source: 'none', name: null, email: null });
    const refused = await owner.post(r.url('initial-commit'));
    expect([refused.status, errorCode(refused.body)]).toEqual([409, 'git_identity_missing']);
    await owner.put('/api/git/identity', { name: 'Ada', email: 'ada@example.org' });
    expect((await owner.post(r.url('initial-commit'))).status).toBe(200);
  });

  it('runs the repository’s commit hooks and reports a refusal with the hook’s own words', async () => {
    const r = await repo('hooks');
    const marker = path.join(sandbox.dir, 'hook-ran');
    const hook = path.join(r.dir, '.git/hooks/pre-commit');
    await writeFile(hook, `#!/bin/sh\necho ran >> "${marker}"\nif grep -q FORBIDDEN "$(git rev-parse --show-toplevel)/a.txt" 2>/dev/null; then echo "policy: FORBIDDEN is not allowed; token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" >&2; exit 1; fi\n`);
    await chmod(hook, 0o755);

    await writeFile(path.join(r.dir, 'a.txt'), 'FORBIDDEN\n');
    const refused = await owner.post(r.url('commit'), { message: 'try', paths: ['a.txt'] });
    expect([refused.status, errorCode(refused.body)]).toEqual([409, 'git_commit_rejected']);
    const text = JSON.stringify(refused.body);
    expect(text).toContain('policy: FORBIDDEN is not allowed');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect((await r.git('rev-list', '--count', 'HEAD')).trim()).toBe('1');

    await writeFile(path.join(r.dir, 'a.txt'), 'fine\n');
    expect((await owner.post(r.url('commit'), { message: 'ok', paths: ['a.txt'] })).status).toBe(200);
    // The hook ran both times: verification is never skipped.
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('undoes the latest commit while it is still local, keeping its changes staged', async () => {
    const r = await repo('undo', { 'a.txt': 'a\n' });
    const first = (await r.git('rev-parse', 'HEAD')).trim();
    await writeFile(path.join(r.dir, 'b.txt'), 'b\n');
    await owner.post(r.url('commit'), { message: 'second', paths: ['b.txt'] });
    const second = (await r.git('rev-parse', 'HEAD')).trim();

    expect((await owner.post(r.url('undo-commit'))).body).toEqual({ undone: second, head: first });
    expect((await r.git('rev-list', '--count', 'HEAD')).trim()).toBe('1');
    expect(fileOf(await status(r), 'b.txt')).toMatchObject({ index: 'added', worktree: null });

    // Even the very first commit can be undone; then there is nothing left to undo.
    await owner.post(r.url('unstage'), { all: true });
    expect((await owner.post(r.url('undo-commit'))).body).toEqual({ undone: first, head: null });
    expect(await status(r)).toMatchObject({ hasCommits: false });
    expect(fileOf(await status(r), 'a.txt')).toMatchObject({ index: 'added' });
    const nothing = await owner.post(r.url('undo-commit'));
    expect([nothing.status, errorCode(nothing.body)]).toEqual([400, 'git_no_commits']);
  });

  it('does not undo a merge commit', async () => {
    const r = await repo('undo-merge');
    await r.git('switch', '--quiet', '-c', 'side');
    await sandbox.write(r.dir, { 'side.txt': 's\n' });
    await r.git('add', '--all');
    await r.git('commit', '--quiet', '-m', 'side');
    await r.git('switch', '--quiet', 'main');
    await r.git('merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
    const refused = await owner.post(r.url('undo-commit'));
    expect([refused.status, errorCode(refused.body)]).toEqual([409, 'git_merge_commit']);
    expect((await r.git('log', '-1', '--format=%s')).trim()).toBe('merge side');
  });
});

describe('branches', () => {
  it('lists, creates, switches and deletes', async () => {
    const r = await repo('branches');
    const created = await owner.post(r.url('branches'), { name: ' feature/login-form ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ branch: 'feature/login-form', current: 'feature/login-form' });
    await writeFile(path.join(r.dir, 'feature.txt'), 'f\n');
    await owner.post(r.url('commit'), { message: 'feature work', paths: ['feature.txt'] });

    // Without switching, and from a named starting point.
    expect((await owner.post(r.url('branches'), { name: 'from-main', from: 'main', switch: false })).body).toEqual({ branch: 'from-main', current: 'feature/login-form' });
    expect((await r.git('rev-parse', 'from-main')).trim()).toBe((await r.git('rev-parse', 'main')).trim());
    const duplicate = await owner.post(r.url('branches'), { name: 'from-main' });
    expect([duplicate.status, errorCode(duplicate.body)]).toEqual([409, 'git_branch_exists']);
    const unknownStart = await owner.post(r.url('branches'), { name: 'nowhere', from: 'does-not-exist' });
    expect([unknownStart.status, errorCode(unknownStart.body)]).toEqual([400, 'git_unknown_ref']);

    const listed = (await owner.get<GitBranches>(r.url('branches'))).body;
    expect(listed).toMatchObject({ current: 'feature/login-form', detached: false, defaultBranch: 'main' });
    expect(listed.branches.map((branch) => [branch.name, branch.kind, branch.current])).toEqual([
      ['feature/login-form', 'local', true],
      ['from-main', 'local', false],
      ['main', 'local', false],
    ]);
    expect(listed.branches[0]).toMatchObject({ subject: 'feature work', upstream: null, ahead: null, behind: null, checkedOutElsewhere: false });

    expect((await owner.post(r.url('switch'), { branch: 'main' })).body).toEqual({ branch: 'main', current: 'main' });
    expect(existsSync(path.join(r.dir, 'feature.txt'))).toBe(false);
    const unknown = await owner.post(r.url('switch'), { branch: 'no-such-branch' });
    expect([unknown.status, errorCode(unknown.body)]).toEqual([400, 'git_unknown_ref']);

    // Deleting: merged goes quietly, unmerged needs an explicit decision, the current branch never goes.
    expect((await owner.post(r.url('branches/delete'), { name: 'from-main' })).status).toBe(200);
    const unmerged = await owner.post(r.url('branches/delete'), { name: 'feature/login-form' });
    expect([unmerged.status, errorCode(unmerged.body)]).toEqual([409, 'git_branch_not_merged']);
    for (const force of ['true', 1, 'yes', null]) {
      expect((await owner.post(r.url('branches/delete'), { name: 'feature/login-form', force })).status, String(force)).toBe(400);
    }
    expect((await r.git('branch', '--list', 'feature/login-form')).trim()).not.toBe('');
    for (const force of [false, true]) {
      const current = await owner.post(r.url('branches/delete'), { name: 'main', force });
      expect([current.status, errorCode(current.body)]).toEqual([400, 'git_branch_current']);
    }
    expect((await owner.post(r.url('branches/delete'), { name: 'feature/login-form', force: true })).status).toBe(200);
    expect((await r.git('branch', '--format=%(refname:short)')).trim()).toBe('main');
    const gone = await owner.post(r.url('branches/delete'), { name: 'feature/login-form' });
    expect([gone.status, errorCode(gone.body)]).toEqual([400, 'git_unknown_ref']);
  });

  it('refuses to switch when uncommitted work would be lost, and loses nothing', async () => {
    const r = await repo('dirty-switch', { 'shared.txt': 'base\n', 'other.txt': 'o\n' });
    await r.git('switch', '--quiet', '-c', 'topic');
    await writeFile(path.join(r.dir, 'shared.txt'), 'topic version\n');
    await r.git('commit', '--quiet', '-am', 'topic');
    await r.git('switch', '--quiet', 'main');

    await writeFile(path.join(r.dir, 'shared.txt'), 'precious local edit\n');
    const refused = await owner.post(r.url('switch'), { branch: 'topic' });
    expect([refused.status, errorCode(refused.body)]).toEqual([409, 'git_would_overwrite']);
    expect((refused.body as { error: { message: string } }).error.message).toContain('Nothing was changed');
    expect(await readFile(path.join(r.dir, 'shared.txt'), 'utf8')).toBe('precious local edit\n');
    expect((await r.git('branch', '--show-current')).trim()).toBe('main');
    // There is no way to ask for a forced switch.
    expect((await owner.post(r.url('switch'), { branch: 'topic', force: true, discard: true })).status).toBe(409);
    expect(await readFile(path.join(r.dir, 'shared.txt'), 'utf8')).toBe('precious local edit\n');

    // Changes that are not in the way simply come along.
    await r.git('checkout', '--quiet', '--', 'shared.txt');
    await writeFile(path.join(r.dir, 'other.txt'), 'harmless edit\n');
    expect((await owner.post(r.url('switch'), { branch: 'topic' })).status).toBe(200);
    expect(await readFile(path.join(r.dir, 'other.txt'), 'utf8')).toBe('harmless edit\n');
  });
});

describe('history', () => {
  it('pages through the log with refs and parents, newest first', async () => {
    const r = await repo('history');
    for (let i = 1; i <= 4; i += 1) {
      await writeFile(path.join(r.dir, `main-${i}.txt`), `${i}\n`);
      await r.git('add', '--all');
      await r.git('commit', '--quiet', '-m', `main ${i}`);
    }
    await r.git('tag', 'v1.0');
    await r.git('switch', '--quiet', '-c', 'side', 'HEAD~2');
    await writeFile(path.join(r.dir, 'side.txt'), 's\n');
    await r.git('add', '--all');
    await r.git('commit', '--quiet', '-m', 'side work');
    await r.git('switch', '--quiet', 'main');
    await r.git('merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
    await writeFile(path.join(r.dir, 'stashed.txt'), 'stash me\n');
    await r.git('add', '--all');
    await r.git('stash', '--quiet');

    const all = (await owner.get<GitLog>(r.url('log?limit=200'))).body;
    expect(all.nextCursor).toBeNull();
    expect(all.commits).toHaveLength(7);
    // Stashes are not history.
    expect(all.commits.map((commit) => commit.subject).join('\n')).not.toMatch(/WIP|stash/i);
    const [merge] = all.commits;
    expect(merge).toMatchObject({ subject: 'merge side', authorName: 'Fixture Author', authorEmail: 'fixture@example.test' });
    expect(merge!.parents).toHaveLength(2);
    expect(merge!.refs).toEqual(expect.arrayContaining([{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }]));
    expect(all.commits.find((commit) => commit.subject === 'side work')!.refs).toEqual([{ name: 'side', kind: 'branch' }]);
    expect(all.commits.find((commit) => commit.subject === 'main 4')!.refs).toEqual([{ name: 'v1.0', kind: 'tag' }]);
    // Children come before their parents, so a graph can be drawn top-down.
    const position = new Map(all.commits.map((commit, index) => [commit.oid, index]));
    for (const commit of all.commits) for (const parent of commit.parents) expect(position.get(parent)!).toBeGreaterThan(position.get(commit.oid)!);
    expect(all.commits[6]!.parents).toEqual([]);

    const pages: string[] = [];
    let cursor: string | null = null;
    do {
      const page: GitLog = (await owner.get<GitLog>(r.url(`log?limit=3${cursor ? `&cursor=${cursor}` : ''}`))).body;
      expect(page.commits.length).toBeLessThanOrEqual(3);
      pages.push(...page.commits.map((commit) => commit.oid));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual(all.commits.map((commit) => commit.oid));

    const sideOnly = (await owner.get<GitLog>(r.url('log?ref=side'))).body;
    expect(sideOnly.commits.map((commit) => commit.subject)).toEqual(['side work', 'main 2', 'main 1', 'first commit']);
    for (const bad of ['limit=0', 'limit=500', 'cursor=-1', 'cursor=abc', 'ref=--all']) expect((await owner.get(r.url(`log?${bad}`))).status, bad).toBe(400);
  });

  it('shows one commit with its files, counts and a size-limited diff', async () => {
    const r = await repo('detail', { 'keep.txt': 'one\ntwo\n', 'remove.txt': 'bye\n', 'rename-me.txt': 'a line that makes this file recognisable after renaming\n' });
    await sandbox.write(r.dir, { 'keep.txt': 'one\nTWO\nthree\n', 'added.txt': 'new\n', 'blob.bin': Buffer.from([0, 1, 2, 0, 255]) });
    await r.git('rm', '--quiet', 'remove.txt');
    await r.git('mv', 'rename-me.txt', 'renamed.txt');
    await r.git('add', '--all');
    await r.git('commit', '--quiet', '-m', 'subject line', '-m', 'body paragraph\nsecond line');
    const oid = (await r.git('rev-parse', 'HEAD')).trim();

    const detail = (await owner.get<GitCommitDetail>(r.url(`commits/${oid}`))).body;
    expect(detail).toMatchObject({ oid, subject: 'subject line', body: 'body paragraph\nsecond line', committerName: 'Fixture Author', diffTruncated: false });
    expect(detail.parents).toHaveLength(1);
    expect(detail.committedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(Object.fromEntries(detail.files.map((file) => [file.path, [file.status, file.additions, file.deletions, file.originalPath]]))).toEqual({
      'added.txt': ['A', 1, 0, null],
      'blob.bin': ['A', null, null, null],
      'keep.txt': ['M', 2, 1, null],
      'remove.txt': ['D', 0, 1, null],
      'renamed.txt': ['R', 0, 0, 'rename-me.txt'],
    });
    expect([detail.additions, detail.deletions]).toEqual([3, 2]);
    expect(detail.diff).toContain('+TWO');
    // An abbreviated id works; the first commit has no parent and shows everything as added.
    expect((await owner.get<GitCommitDetail>(r.url(`commits/${oid.slice(0, 8)}`))).body.oid).toBe(oid);
    const root = (await owner.get<GitCommitDetail>(r.url(`commits/${detail.parents[0]}`))).body;
    expect(root.parents).toEqual([]);
    expect(root.files.every((file) => file.status === 'A')).toBe(true);

    t.studio.context.services.git.limits.commitDiffBytes = 200;
    const cut = (await owner.get<GitCommitDetail>(r.url(`commits/${oid}`))).body;
    expect(cut.diffTruncated).toBe(true);
    expect(cut.diff.length).toBeLessThanOrEqual(200);
    expect(cut.files).toHaveLength(5);

    const unknown = await owner.get(r.url(`commits/${'0'.repeat(40)}`));
    expect([unknown.status, errorCode(unknown.body)]).toEqual([400, 'git_unknown_ref']);
    for (const bad of ['HEAD', 'main', 'xyz', '-n1', 'abc']) expect((await owner.get(r.url(`commits/${bad}`))).status, bad).toBe(400);
  });
});

describe('comparing with a branch', () => {
  it('lists everything that differs from the common ancestor, committed or not', async () => {
    const r = await repo('compare', { 'base.txt': 'base\n', 'staged.txt': 's\n', 'unstaged.txt': 'u\n' });
    const mergeBase = (await r.git('rev-parse', 'HEAD')).trim();
    await r.git('switch', '--quiet', '-c', 'feature');
    await sandbox.write(r.dir, { 'committed.txt': 'c\n' });
    await r.git('add', '--all');
    await r.git('commit', '--quiet', '-m', 'feature commit');
    // Main moves on too: the comparison is against the common ancestor, not against main's tip.
    await r.git('switch', '--quiet', 'main');
    await sandbox.write(r.dir, { 'only-on-main.txt': 'm\n' });
    await r.git('add', '--all');
    await r.git('commit', '--quiet', '-m', 'main moves on');
    await r.git('switch', '--quiet', 'feature');
    await sandbox.write(r.dir, { 'staged.txt': 'S\n', 'unstaged.txt': 'U\n', 'untracked.txt': 'line one\nline two\n' });
    await r.git('add', 'staged.txt');

    const comparison = (await owner.get<GitComparison>(r.url(`compare?${q({ base: 'main' })}`))).body;
    expect(comparison).toMatchObject({ base: 'main', mergeBase, truncated: false });
    expect(comparison.files.map((file) => [file.path, file.status])).toEqual([
      ['committed.txt', 'A'],
      ['staged.txt', 'M'],
      ['unstaged.txt', 'M'],
      ['untracked.txt', 'U'],
    ]);

    const diffOf = async (file: string) => (await owner.get<GitFileDiff>(r.url(`compare/diff?${q({ base: 'main', path: file })}`))).body;
    expect((await diffOf('committed.txt')).diff).toContain('+c');
    expect((await diffOf('staged.txt')).diff).toContain('-s\n+S');
    expect((await diffOf('unstaged.txt')).diff).toContain('-u\n+U');
    const untracked = await diffOf('untracked.txt');
    expect(untracked.diff).toContain('+line one\n+line two');
    expect(untracked.diff).not.toMatch(/^-[^-]/m);
    expect((await diffOf('base.txt')).diff).toBe('');
  });

  it('tells an invalid base from an unknown one from one without common history', async () => {
    const r = await repo('compare-errors');
    await r.git('switch', '--quiet', '--orphan', 'island');
    await r.git('commit', '--quiet', '--allow-empty', '-m', 'unrelated');
    await r.git('switch', '--quiet', 'main');

    const answer = async (base: string) => {
      const response = await owner.get(r.url(`compare?${q({ base })}`));
      return [response.status, errorCode(response.body)];
    };
    expect(await answer('--orphan=x')).toEqual([400, 'git_invalid_ref']);
    expect(await answer('no-such-branch')).toEqual([400, 'git_unknown_ref']);
    expect(await answer('island')).toEqual([400, 'git_no_common_history']);
    const diff = await owner.get(r.url(`compare/diff?${q({ base: 'island', path: 'README.md' })}`));
    expect([diff.status, errorCode(diff.body)]).toEqual([400, 'git_no_common_history']);
  });
});

/** Names that must never reach git as anything but a refused request. */
const HOSTILE_REFS = [
  '-f',
  '--orphan=x',
  '--upload-pack=touch PWNED',
  '-o',
  '--output=PWNED',
  'HEAD;rm -rf ~',
  'bad name',
  'bad;name',
  'a..b',
  '../../outside',
  'topic.lock',
  '$(touch PWNED)',
  '`touch PWNED`',
  "it's",
  'say "hi"',
  'new\nline',
  'tab\tname',
  'nul\u0000byte',
  'HEAD~1',
  'main^{tree}',
  ':/first',
  '@{-1}',
  'refs/heads/../../config',
  '.hidden',
  'ends/',
  '/starts',
  'x'.repeat(260),
];

describe('hostile input', () => {
  it.each(HOSTILE_REFS)('refuses %j as a branch, a base, a start point and a ref, and leaves the repository alone', async (name) => {
    const r = await repo('hardened');
    await r.git('branch', 'spare');
    const snapshot = async () => [await r.git('for-each-ref', '--format=%(refname) %(objectname)'), await r.git('status', '--porcelain'), await readFile(path.join(r.dir, '.git/config'), 'utf8')];
    const before = await snapshot();

    const attempts: Array<[string, Promise<{ status: number; body: unknown }>]> = [
      ['create', owner.post(r.url('branches'), { name })],
      ['create from', owner.post(r.url('branches'), { name: 'ok-name', from: name })],
      ['switch', owner.post(r.url('switch'), { branch: name })],
      ['switch remote', owner.post(r.url('switch'), { branch: name, kind: 'remote' })],
      ['delete', owner.post(r.url('branches/delete'), { name })],
      ['delete forced', owner.post(r.url('branches/delete'), { name, force: true })],
      ['compare', owner.get(r.url(`compare?${q({ base: name })}`))],
      ['compare diff', owner.get(r.url(`compare/diff?${q({ base: name, path: 'README.md' })}`))],
      ['log', owner.get(r.url(`log?${q({ ref: name })}`))],
      ['worktree', owner.post(r.url('worktrees'), { branch: name })],
      ['worktree base', owner.post(r.url('worktrees'), { branch: 'ok-name', base: name })],
      ['fetch', owner.post(r.url('fetch'), { remote: name })],
      ['push', owner.post(r.url('push'), { remote: name, publish: true })],
    ];
    for (const [what, attempt] of attempts) {
      const response = await attempt;
      expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
    for (const place of [r.dir, t.workspace, path.dirname(t.workspace), sandbox.dir]) expect(existsSync(path.join(place, 'PWNED')), place).toBe(false);
    expect(existsSync(path.join(path.dirname(r.dir), 'hardened-worktrees'))).toBe(false);
  });

  it.each([
    '../outside.txt',
    '../../etc/passwd',
    'sub/../../outside.txt',
    '/etc/passwd',
    '/tmp/absolute.txt',
    '.git/config',
    '.git/hooks/pre-commit',
    '.GIT/config',
    'sub/.git/config',
    'escape/secret.txt',
    'escape',
    '',
    '.',
    'nul\u0000byte.txt',
  ])('refuses the path %j everywhere a path is accepted', async (file) => {
    const r = await repo('paths', { 'README.md': '# paths\n', 'sub/inner.txt': 'i\n' });
    const outside = path.join(path.dirname(t.workspace), 'outside-dir');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'outside secret\n');
    await writeFile(path.join(path.dirname(t.workspace), 'outside.txt'), 'outside\n');
    // A folder link that leaves the project: nothing may be read or changed through it.
    await symlink(outside, path.join(r.dir, 'escape'));
    await r.git('add', 'escape');
    await r.git('commit', '--quiet', '-m', 'track the link itself');
    const configBefore = await readFile(path.join(r.dir, '.git/config'), 'utf8');

    const attempts: Array<[string, { status: number; body: unknown }]> = [
      ['diff', await owner.get(r.url(`diff?${q({ path: file })}`))],
      ['diff staged', await owner.get(r.url(`diff?${q({ path: file, staged: 'true' })}`))],
      ['baseline', await owner.get(r.url(`baseline?${q({ path: file })}`))],
      ['compare diff', await owner.get(r.url(`compare/diff?${q({ base: 'main', path: file })}`))],
      ['compare diff original', await owner.get(r.url(`compare/diff?${q({ base: 'main', path: 'README.md', originalPath: file })}`))],
      ['stage', await owner.post(r.url('stage'), { paths: ['README.md', file] })],
      ['unstage', await owner.post(r.url('unstage'), { paths: [file] })],
      ['discard', await owner.post(r.url('discard'), { path: file })],
      ['delete untracked', await owner.post(r.url('delete-untracked'), { path: file })],
      ['commit paths', await owner.post(r.url('commit'), { message: 'x', paths: [file] })],
    ];
    for (const [what, response] of attempts) {
      // "escape" names the tracked link itself, which git may legitimately be asked about; everything else is refused.
      if (file === 'escape') expect([200, 204, 400, 409], `${what}: ${JSON.stringify(response.body)}`).toContain(response.status);
      else expect([400, 403], `${what}: ${JSON.stringify(response.body)}`).toContain(response.status);
      expect(JSON.stringify(response.body ?? ''), what).not.toContain('outside secret');
    }
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret\n');
    expect(await readFile(path.join(path.dirname(t.workspace), 'outside.txt'), 'utf8')).toBe('outside\n');
    expect(await readFile(path.join(r.dir, '.git/config'), 'utf8')).toBe(configBefore);
    expect((await r.git('status', '--porcelain')).trim()).toBe('');
  });

  it('treats a file whose name looks like an option or a pattern as a file', async () => {
    const r = await repo('literal', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await sandbox.write(r.dir, { '--all': 'not an option\n', '*.txt': 'not a pattern\n', ':(top)': 'not magic\n', 'a.txt': 'A\n', 'b.txt': 'B\n' });
    for (const name of ['--all', '*.txt', ':(top)']) {
      expect((await owner.post(r.url('stage'), { paths: [name] })).status, name).toBe(204);
    }
    // "*.txt" staged one file of that exact name — not every .txt file; "--all" did not stage everything.
    expect((await r.git('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean).sort()).toEqual(['*.txt', '--all', ':(top)']);
    expect(fileOf(await status(r), 'a.txt')).toMatchObject({ index: null, worktree: 'modified' });
  });
});

describe('a repository cannot make the server run its programs by being looked at', () => {
  it('runs none of the programs planted in the repository configuration', async () => {
    const r = await repo('booby', { 'text.txt': 'one\ntwo\n', 'other.txt': 'o\n' });
    const marker = path.join(sandbox.dir, 'trap-sprung');
    const trap = (name: string) => `sh -c 'echo ${name} >> "${marker}"; cat 2>/dev/null; exit 0' #`;
    const hooksDir = path.join(r.dir, '.git/evil-hooks');
    await mkdir(hooksDir, { recursive: true });
    for (const hook of ['post-index-change', 'post-checkout', 'pre-commit', 'reference-transaction', 'fsmonitor-watchman', 'post-merge', 'pre-auto-gc']) {
      await writeFile(path.join(hooksDir, hook), `#!/bin/sh\necho hook-${hook} >> "${marker}"\n`);
      await chmod(path.join(hooksDir, hook), 0o755);
    }
    const plant: Array<[string, string]> = [
      ['core.fsmonitor', trap('fsmonitor')],
      ['core.pager', trap('pager')],
      ['pager.status', 'true'],
      ['pager.diff', 'true'],
      ['pager.log', 'true'],
      ['diff.external', trap('diff-external')],
      ['diff.evil.command', trap('diff-driver')],
      ['diff.evil.textconv', trap('textconv')],
      ['filter.evil.clean', trap('filter-clean')],
      ['filter.evil.smudge', trap('filter-smudge')],
      ['filter.evil.process', trap('filter-process')],
      ['filter.evil.required', 'true'],
      ['filter.odd=name.clean', trap('filter-odd-name')],
      ['core.sshCommand', trap('ssh')],
      ['core.askPass', trap('askpass')],
      ['credential.helper', `!${trap('credential')}`],
      ['core.editor', trap('editor')],
      ['sequence.editor', trap('sequence-editor')],
      ['core.hooksPath', hooksDir],
      ['log.showSignature', 'true'],
      ['gpg.program', trap('gpg')],
      ['core.alternateRefsCommand', trap('alternate-refs')],
      ['core.gitProxy', trap('proxy')],
      ['status.submoduleSummary', 'true'],
      ['submodule.recurse', 'true'],
      ['remote.origin.url', `ext::${trap('ext-transport')}`],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['protocol.ext.allow', 'always'],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialclonefilter', 'blob:none'],
    ];
    for (const [key, value] of plant) await r.git('config', key, value);
    await sandbox.write(r.dir, { '.gitattributes': '*.txt filter=evil diff=evil\nother.txt filter=odd=name\n' });

    // First prove the traps are live: plain git, as a careless server would run it, springs them.
    await sandbox.write(r.dir, { 'text.txt': 'one\nTWO\n', 'other.txt': 'O\n', 'loose.txt': 'l\n' });
    await sandbox.tryGit(r.dir, 'status');
    await sandbox.tryGit(r.dir, 'diff');
    // (The planted "required" filter makes plain git give up before it reaches the diff driver, so that one is shown separately.)
    await sandbox.tryGit(r.dir, '-c', 'filter.evil.clean=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false', '-c', 'filter.odd=name.clean=', 'diff');
    const sprung = (await readFile(marker, 'utf8').catch(() => '')).trim().split('\n');
    expect(sprung).toEqual(expect.arrayContaining(['fsmonitor', 'diff-driver']));
    expect(sprung.some((line) => line.startsWith('filter-'))).toBe(true);
    await rm(marker);

    const head = (await sandbox.tryGit(r.dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD')).stdout.trim();
    const reads = [
      'status',
      `diff?${q({ path: 'text.txt' })}`,
      `diff?${q({ path: 'text.txt', staged: 'true' })}`,
      `diff?${q({ path: 'other.txt' })}`,
      `diff?${q({ path: 'loose.txt' })}`,
      `baseline?${q({ path: 'text.txt' })}`,
      'branches',
      'log',
      `commits/${head}`,
      `compare?${q({ base: 'main' })}`,
      `compare/diff?${q({ base: 'main', path: 'text.txt' })}`,
      `compare/diff?${q({ base: 'main', path: 'loose.txt' })}`,
      'worktrees',
    ];
    for (const read of reads) {
      const response = await owner.get(r.url(read));
      expect(response.status, `${read}: ${JSON.stringify(response.body)}`).toBe(200);
    }
    // The files feature asks git about ignore rules, names and content; the same holds there.
    for (const read of ['list', 'tree', `search?${q({ query: 'text' })}`, `grep?${q({ query: 'TWO' })}`]) {
      const response = await owner.get(`/api/projects/${r.project.id}/files/${read}`);
      expect(response.status, `${read}: ${JSON.stringify(response.body)}`).toBe(200);
    }
    expect((await owner.get(`/api/projects/${r.project.id}/github/pull-request`)).status).toBe(200);
    // The diff that was answered is the real one, computed without the planted drivers.
    expect((await owner.get<GitFileDiff>(r.url(`diff?${q({ path: 'text.txt' })}`))).body.diff).toContain('-two\n+TWO');
    expect((await status(r)).files.map((file) => file.path).sort()).toEqual(['.gitattributes', 'loose.txt', 'other.txt', 'text.txt']);

    expect(existsSync(marker), existsSync(marker) ? await readFile(marker, 'utf8') : '').toBe(false);
  });
});

describe('who may do what', () => {
  const reads = ['status', 'diff?path=README.md', 'baseline?path=README.md', 'branches', 'log', `commits/${'a'.repeat(40)}`, 'compare?base=main', 'compare/diff?base=main&path=README.md', 'worktrees'];
  const writes: Array<[string, Record<string, unknown>]> = [
    ['init', {}],
    ['initial-commit', {}],
    ['stage', { all: true }],
    ['unstage', { all: true }],
    ['discard', { path: 'README.md' }],
    ['delete-untracked', { path: 'loose.txt' }],
    ['commit', { message: 'by a reader' }],
    ['undo-commit', {}],
    ['branches', { name: 'by-reader' }],
    ['switch', { branch: 'spare' }],
    ['branches/delete', { name: 'spare' }],
    ['fetch', {}],
    ['pull', {}],
    ['push', { publish: true }],
    ['worktrees', { branch: 'by-reader' }],
    ['worktrees/open', { path: '/somewhere' }],
    ['worktrees/remove', { path: '/somewhere' }],
    ['worktrees/merge', { path: '/somewhere' }],
  ];

  it('turns away anonymous callers, hides projects from strangers, and lets read-only members only read', async () => {
    const r = await repo('guarded');
    await r.git('branch', 'spare');
    await sandbox.write(r.dir, { 'loose.txt': 'l\n', 'README.md': '# edited\n' });
    await r.git('add', 'README.md');
    const reader = await t.member('reader');
    const stranger = await t.member('stranger');
    await owner.put(`/api/projects/${r.project.id}/members/${reader.userId}`, { access: 'read' });
    const snapshot = async () => [await r.git('for-each-ref', '--format=%(refname) %(objectname)'), await r.git('status', '--porcelain'), existsSync(path.join(r.dir, 'loose.txt'))];
    const before = await snapshot();
    const unknownProject = (suffix: string) => `/api/projects/${MISSING}/git/${suffix}`;

    for (const read of reads) {
      expect((await t.anonymous().get(r.url(read))).status, `anonymous ${read}`).toBe(401);
      const hidden = await stranger.get(r.url(read));
      expect(hidden.status, `stranger ${read}`).toBe(404);
      expect(hidden.body, `stranger ${read}`).toEqual((await stranger.get(unknownProject(read))).body);
      const allowed = await reader.get(r.url(read));
      expect([200, 400], `reader ${read}: ${JSON.stringify(allowed.body)}`).toContain(allowed.status);
    }
    for (const [write, body] of writes) {
      expect((await t.anonymous().post(r.url(write), body)).status, `anonymous ${write}`).toBe(401);
      const hidden = await stranger.post(r.url(write), body);
      expect(hidden.status, `stranger ${write}`).toBe(404);
      expect(hidden.body, `stranger ${write}`).toEqual((await stranger.post(unknownProject(write), body)).body);
      const refused = await reader.post(r.url(write), body);
      expect([refused.status, errorCode(refused.body)], `reader ${write}`).toEqual([403, 'project_read_only']);
    }
    expect(await snapshot()).toEqual(before);
    expect((await t.anonymous().put('/api/git/identity', { name: 'x', email: 'x@example.org' })).status).toBe(401);
  });

  it('keeps worktree changes for the owner even from a member who may write', async () => {
    const r = await repo('members');
    const writer = await t.member('writer');
    await owner.put(`/api/projects/${r.project.id}/members/${writer.userId}`, { access: 'write' });
    for (const [route, body] of [
      ['worktrees', { branch: 'mine' }],
      ['worktrees/open', { path: r.dir }],
      ['worktrees/remove', { path: r.dir }],
      ['worktrees/merge', { path: r.dir }],
    ] as const) {
      const refused = await writer.post(r.url(route), body);
      expect([refused.status, errorCode(refused.body)], route).toEqual([403, 'owner_required']);
    }
    expect((await writer.get(r.url('worktrees'))).status).toBe(200);
    // Ordinary git work is open to a writing member.
    await writeFile(path.join(r.dir, 'by-writer.txt'), 'w\n');
    expect((await writer.post(r.url('commit'), { message: 'by writer', paths: ['by-writer.txt'] })).status).toBe(200);
    expect(existsSync(path.join(t.workspace, 'members-worktrees'))).toBe(false);
  });
});
