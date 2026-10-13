import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitCreateWorktreeResult,
  GitMergeWorktreeResult,
  GitRemoveWorktreeResult,
  GitWorktree,
  GitWorktrees,
  Project,
} from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function repo(name = 'repo', files: Record<string, string> = { 'README.md': '# repo\n', 'shared.txt': 'base\n' }): Promise<Repo> {
  const dir = path.join(t.workspace, name);
  await sandbox.repo(dir, files);
  const response = await owner.post<Project>('/api/projects', { name, rootDir: dir });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const project = response.body;
  return { project, dir: project.rootDir, url: (suffix) => `/api/projects/${project.id}/git/${suffix}`, git: (...args) => sandbox.git(project.rootDir, ...args) };
}

const errorOf = (response: { status: number; body: unknown }): [number, string | undefined] => [response.status, (response.body as { error?: { code?: string } } | undefined)?.error?.code];
const list = async (r: Repo, client: TestClient = owner) => (await client.get<GitWorktrees>(r.url('worktrees'))).body;

async function create(r: Repo, branch: string, base?: string): Promise<GitCreateWorktreeResult> {
  const response = await owner.post<GitCreateWorktreeResult>(r.url('worktrees'), { branch, ...(base ? { base } : {}) });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

async function commitIn(dir: string, file: string, content: string, message = `change ${file}`): Promise<string> {
  await sandbox.write(dir, { [file]: content });
  await sandbox.git(dir, 'add', '--all');
  await sandbox.git(dir, 'commit', '--quiet', '-m', message);
  return (await sandbox.git(dir, 'rev-parse', 'HEAD')).trim();
}

describe('listing and creating worktrees', () => {
  it('starts with the main checkout alone', async () => {
    const r = await repo();
    const worktrees = await list(r);
    expect(worktrees).toMatchObject({ baseBranch: 'main', location: path.join(t.workspace, 'repo-worktrees') });
    expect(worktrees.worktrees).toHaveLength(1);
    expect(worktrees.worktrees[0]).toMatchObject({
      path: r.dir,
      branch: 'main',
      main: true,
      current: true,
      detached: false,
      locked: false,
      missing: false,
      changes: 0,
      ahead: null,
      behind: null,
      subject: 'first commit',
      projectId: r.project.id,
      projectArchived: false,
    });
  });

  it('creates a worktree for a new branch in the folder next to the repository and registers it as a project', async () => {
    const r = await repo();
    const created = await create(r, 'feature/x');
    const expected = path.join(t.workspace, 'repo-worktrees', 'feature-x');
    expect(created.branchCreated).toBe(true);
    expect(created.worktree).toMatchObject({ path: expected, branch: 'feature/x', main: false, current: false, changes: 0, ahead: 0, behind: 0 });
    expect(created.project).toMatchObject({ name: 'repo · feature/x', rootDir: expected, archived: false });
    expect(created.worktree.projectId).toBe(created.project.id);
    expect(existsSync(path.join(expected, 'README.md'))).toBe(true);
    expect((await sandbox.git(expected, 'branch', '--show-current')).trim()).toBe('feature/x');

    // The worktree is a project of its own: git works there, and it knows it is not the main checkout.
    await commitIn(expected, 'feature.txt', 'f\n');
    await writeFile(path.join(expected, 'loose.txt'), 'l\n');
    const seenFromMain = (await list(r)).worktrees.find((worktree) => worktree.branch === 'feature/x')!;
    expect(seenFromMain).toMatchObject({ ahead: 1, behind: 0, changes: 1, subject: 'change feature.txt', projectId: created.project.id });
    const seenFromWorktree = (await owner.get<GitWorktrees>(`/api/projects/${created.project.id}/git/worktrees`)).body;
    expect(seenFromWorktree.worktrees.map((worktree) => [worktree.branch, worktree.main, worktree.current])).toEqual([
      ['main', true, false],
      ['feature/x', false, true],
    ]);
    // A branch that lives in a worktree is marked as taken in the branch list.
    const branches = (await owner.get<{ branches: Array<{ name: string; checkedOutElsewhere: boolean }> }>(r.url('branches'))).body.branches;
    expect(branches.find((branch) => branch.name === 'feature/x')!.checkedOutElsewhere).toBe(true);
  });

  it('checks an existing branch out as it is, and starts a new one where asked', async () => {
    const r = await repo();
    await r.git('branch', 'existing');
    const first = await commitIn(r.dir, 'later.txt', 'l\n');
    const existing = await create(r, 'existing');
    expect(existing.branchCreated).toBe(false);
    expect(existsSync(path.join(existing.worktree.path, 'later.txt'))).toBe(false);

    const fromBase = await create(r, 'from-existing', 'existing');
    expect(fromBase.worktree.oid).toBe(existing.worktree.oid);
    const fromMain = await create(r, 'from-main');
    expect(fromMain.worktree.oid).toBe(first);
    expect(errorOf(await owner.post(r.url('worktrees'), { branch: 'bad-base', base: 'no-such-ref' }))).toEqual([400, 'git_unknown_ref']);
    expect(existsSync(path.join(t.workspace, 'repo-worktrees', 'bad-base'))).toBe(false);
  });

  it('continues a remote branch of the same name instead of starting from scratch', async () => {
    const r = await repo();
    const remote = await sandbox.bare('worktree-remote.git');
    await r.git('remote', 'add', 'origin', remote);
    await r.git('switch', '--quiet', '-c', 'shared-topic');
    const remoteTip = await commitIn(r.dir, 'topic.txt', 't\n');
    await r.git('push', '--quiet', '-u', 'origin', 'shared-topic');
    await r.git('switch', '--quiet', 'main');
    await r.git('branch', '--quiet', '-D', 'shared-topic');

    const created = await create(r, 'shared-topic');
    expect(created.worktree.oid).toBe(remoteTip);
    expect((await sandbox.git(created.worktree.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).trim()).toBe('origin/shared-topic');
  });

  it('refuses a branch that is taken, a folder that exists, and names that are not branch names', async () => {
    const r = await repo();
    await create(r, 'feature/x');
    expect(errorOf(await owner.post(r.url('worktrees'), { branch: 'feature/x' }))).toEqual([409, 'git_branch_in_use']);
    expect(errorOf(await owner.post(r.url('worktrees'), { branch: 'main' }))).toEqual([409, 'git_branch_in_use']);
    // "feature-x" would land in the same folder as "feature/x".
    expect(errorOf(await owner.post(r.url('worktrees'), { branch: 'feature-x' }))).toEqual([409, 'git_worktree_exists']);
    expect((await r.git('branch', '--list', 'feature-x')).trim()).toBe('');

    for (const branch of ['', '   ', '-dash', '/slash', 'ends/', 'ends.', 'a..b', 'a//b', 'with space', 'semi;colon', 'a/.hidden', 'part.lock/x', 'x.lock', '$(id)']) {
      const refused = await owner.post(r.url('worktrees'), { branch });
      expect(refused.status, JSON.stringify(branch)).toBe(400);
    }
    const before = (await list(r)).worktrees.length;
    // Surrounding spaces are not part of the name.
    const trimmed = await create(r, '  feature/login-form  ');
    expect(trimmed.worktree.branch).toBe('feature/login-form');
    expect((await list(r)).worktrees).toHaveLength(before + 1);
  });

  it('does not create worktrees outside the workspace roots', async () => {
    // The repository *is* the workspace root, so the folder next to it would be outside.
    await sandbox.repo(t.workspace);
    const project = (await owner.post<Project>('/api/projects', { name: 'top', rootDir: t.workspace })).body;
    const url = (suffix: string) => `/api/projects/${project.id}/git/${suffix}`;
    expect((await owner.get<GitWorktrees>(url('worktrees'))).body.location).toBeNull();
    expect(errorOf(await owner.post(url('worktrees'), { branch: 'feature/x' }))).toEqual([409, 'git_worktree_location']);
    expect(existsSync(`${t.workspace}-worktrees`)).toBe(false);
    expect((await sandbox.git(t.workspace, 'branch', '--list', 'feature/x')).trim()).toBe('');
  });
});

describe('opening a worktree as a project', () => {
  it('registers a worktree made outside the Studio, and revives an archived one', async () => {
    const r = await repo();
    const manual = path.join(t.workspace, 'made-by-hand');
    await r.git('worktree', 'add', '--quiet', '-b', 'by-hand', manual);
    expect((await list(r)).worktrees.find((worktree) => worktree.branch === 'by-hand')).toMatchObject({ projectId: null });

    const opened = await owner.post<{ project: Project }>(r.url('worktrees/open'), { path: manual });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.project).toMatchObject({ name: 'repo · by-hand', rootDir: manual });
    // Opening again returns the same project; an archived one is restored.
    expect((await owner.post<{ project: Project }>(r.url('worktrees/open'), { path: manual })).body.project.id).toBe(opened.body.project.id);
    await owner.patch(`/api/projects/${opened.body.project.id}`, { archived: true });
    expect((await list(r)).worktrees.find((worktree) => worktree.branch === 'by-hand')).toMatchObject({ projectArchived: true });
    expect((await owner.post<{ project: Project }>(r.url('worktrees/open'), { path: manual })).body.project).toMatchObject({ id: opened.body.project.id, archived: false });
  });

  it.each(['/etc', '/tmp', 'relative/path', '../repo', '--force', 'nul\u0000byte'])('answers 404 for %j, which is not a worktree of the repository', async (target) => {
    const r = await repo();
    const other = await repo('unrelated');
    for (const candidate of [target, other.dir, path.join(t.workspace, 'nope')]) {
      for (const route of ['worktrees/open', 'worktrees/remove', 'worktrees/merge']) {
        expect(errorOf(await owner.post(r.url(route), { path: candidate })), `${route} ${candidate}`).toEqual([404, 'git_worktree_unknown']);
      }
    }
    expect(existsSync(other.dir)).toBe(true);
  });
});

describe('removing a worktree', () => {
  it('refuses while there is uncommitted work, unless told to discard it', async () => {
    const r = await repo();
    const created = await create(r, 'feature/x');
    await writeFile(path.join(created.worktree.path, 'unsaved.txt'), 'work in progress\n');

    const refused = await owner.post(r.url('worktrees/remove'), { path: created.worktree.path });
    expect(errorOf(refused)).toEqual([409, 'git_worktree_dirty']);
    expect(existsSync(path.join(created.worktree.path, 'unsaved.txt'))).toBe(true);
    // A string is not a boolean: "true" does not switch force on.
    expect((await owner.post(r.url('worktrees/remove'), { path: created.worktree.path, force: 'true' })).status).toBe(400);
    expect(existsSync(created.worktree.path)).toBe(true);

    const removed = await owner.post<GitRemoveWorktreeResult>(r.url('worktrees/remove'), { path: created.worktree.path, force: true });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ path: created.worktree.path, branch: 'feature/x', branchDeleted: false, branchNote: null });
    expect(existsSync(created.worktree.path)).toBe(false);
    // The branch stays unless its deletion was asked for; the project is archived, not deleted.
    expect((await r.git('branch', '--list', 'feature/x')).trim()).not.toBe('');
    expect(removed.body.project).toMatchObject({ id: created.project.id, archived: true });
    expect((await owner.get<Project>(`/api/projects/${created.project.id}`)).body.archived).toBe(true);
    expect((await list(r)).worktrees).toHaveLength(1);
  });

  it('deletes the branch only when that loses nothing, or when forced', async () => {
    const r = await repo();
    const merged = await create(r, 'already-merged');
    const done = await owner.post<GitRemoveWorktreeResult>(r.url('worktrees/remove'), { path: merged.worktree.path, deleteBranch: true });
    expect(done.body).toMatchObject({ branchDeleted: true, branchNote: null });
    expect((await r.git('branch', '--list', 'already-merged')).trim()).toBe('');

    const unmerged = await create(r, 'unmerged');
    await commitIn(unmerged.worktree.path, 'work.txt', 'w\n');
    const kept = await owner.post<GitRemoveWorktreeResult>(r.url('worktrees/remove'), { path: unmerged.worktree.path, deleteBranch: true });
    expect(kept.body.branchDeleted).toBe(false);
    expect(kept.body.branchNote).toContain('merged nowhere else');
    expect((await r.git('branch', '--list', 'unmerged')).trim()).not.toBe('');
    expect(existsSync(unmerged.worktree.path)).toBe(false);
  });

  it('never removes the main checkout, and forgets a worktree whose folder is already gone', async () => {
    const r = await repo();
    for (const force of [false, true]) {
      expect(errorOf(await owner.post(r.url('worktrees/remove'), { path: r.dir, force }))).toEqual([400, 'git_worktree_main']);
    }
    expect(existsSync(path.join(r.dir, 'README.md'))).toBe(true);

    const created = await create(r, 'vanishing');
    await rm(created.worktree.path, { recursive: true });
    expect((await list(r)).worktrees.find((worktree) => worktree.branch === 'vanishing')).toMatchObject({ missing: true, changes: null });
    expect((await owner.post(r.url('worktrees/remove'), { path: created.worktree.path })).status).toBe(200);
    expect((await list(r)).worktrees).toHaveLength(1);
  });
});

describe('merging a worktree back', () => {
  it('squashes by default into one commit with the given message, and cleans up when asked', async () => {
    const r = await repo();
    const created = await create(r, 'feature/x');
    await commitIn(created.worktree.path, 'one.txt', '1\n');
    await commitIn(created.worktree.path, 'two.txt', '2\n');
    const before = (await r.git('rev-parse', 'HEAD')).trim();
    await owner.put('/api/git/identity', { name: 'Ada Lovelace', email: 'ada@example.org' });

    const merged = await owner.post<GitMergeWorktreeResult>(r.url('worktrees/merge'), { path: created.worktree.path, message: 'Add feature x', cleanup: true });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toMatchObject({ into: 'main', branch: 'feature/x', squash: true, cleanupError: null });
    expect((await r.git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')).toEqual([merged.body.oid, before]);
    expect((await r.git('log', '-1', '--format=%s|%an')).trim()).toBe('Add feature x|Ada Lovelace');
    expect(existsSync(path.join(r.dir, 'one.txt')) && existsSync(path.join(r.dir, 'two.txt'))).toBe(true);
    expect((await r.git('status', '--porcelain')).trim()).toBe('');

    // Clean-up: the worktree and its branch are gone, its project is archived.
    expect(merged.body.cleanup).toMatchObject({ branch: 'feature/x', branchDeleted: true });
    expect(existsSync(created.worktree.path)).toBe(false);
    expect((await r.git('branch', '--list', 'feature/x')).trim()).toBe('');
    expect((await owner.get<Project>(`/api/projects/${created.project.id}`)).body.archived).toBe(true);
  });

  it('creates a real merge commit when squash is switched off, and keeps the worktree without clean-up', async () => {
    const r = await repo();
    const created = await create(r, 'topic');
    const tip = await commitIn(created.worktree.path, 'topic.txt', 't\n');
    const mainTip = await commitIn(r.dir, 'main.txt', 'm\n');

    const merged = await owner.post<GitMergeWorktreeResult>(r.url('worktrees/merge'), { path: created.worktree.path, squash: false });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toMatchObject({ squash: false, cleanup: null, cleanupError: null });
    expect((await r.git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')).toEqual([merged.body.oid, mainTip, tip]);
    expect((await r.git('log', '-1', '--format=%s')).trim()).toBe("Merge branch 'topic'");
    expect(existsSync(created.worktree.path)).toBe(true);
    // Merged once, there is nothing left to merge.
    expect(errorOf(await owner.post(r.url('worktrees/merge'), { path: created.worktree.path, squash: false }))).toEqual([409, 'git_nothing_to_commit']);
  });

  it('changes nothing when the merge would conflict, and names the files', async () => {
    const r = await repo();
    const created = await create(r, 'clash');
    await commitIn(created.worktree.path, 'shared.txt', 'worktree version\n');
    const mainTip = await commitIn(r.dir, 'shared.txt', 'main version\n');

    for (const squash of [true, false]) {
      const refused = await owner.post(r.url('worktrees/merge'), { path: created.worktree.path, squash, cleanup: true });
      expect(errorOf(refused), `squash=${squash}`).toEqual([409, 'git_conflict']);
      expect((refused.body as { error: { details: { files: string[] } } }).error.details.files).toEqual(['shared.txt']);
      expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(mainTip);
      expect((await r.git('status', '--porcelain')).trim()).toBe('');
      expect(existsSync(path.join(r.dir, '.git/MERGE_HEAD'))).toBe(false);
      expect(existsSync(path.join(r.dir, '.git/SQUASH_MSG'))).toBe(false);
      expect(await readFile(path.join(r.dir, 'shared.txt'), 'utf8')).toBe('main version\n');
    }
    // Clean-up was asked for but, with no merge, did not happen.
    expect(existsSync(created.worktree.path)).toBe(true);
    expect((await r.git('branch', '--list', 'clash')).trim()).not.toBe('');
  });

  it('needs both folders clean and something to merge', async () => {
    const r = await repo();
    const created = await create(r, 'feature/x');
    expect(errorOf(await owner.post(r.url('worktrees/merge'), { path: created.worktree.path }))).toEqual([409, 'git_nothing_to_commit']);
    await commitIn(created.worktree.path, 'feature.txt', 'f\n');

    await writeFile(path.join(created.worktree.path, 'dirty.txt'), 'd\n');
    const dirtyWorktree = await owner.post(r.url('worktrees/merge'), { path: created.worktree.path });
    expect(errorOf(dirtyWorktree)).toEqual([409, 'git_worktree_dirty']);
    expect((dirtyWorktree.body as { error: { details: { side: string } } }).error.details.side).toBe('worktree');
    await rm(path.join(created.worktree.path, 'dirty.txt'));

    await writeFile(path.join(r.dir, 'dirty.txt'), 'd\n');
    const dirtyMain = await owner.post(r.url('worktrees/merge'), { path: created.worktree.path });
    expect(errorOf(dirtyMain)).toEqual([409, 'git_worktree_dirty']);
    expect((dirtyMain.body as { error: { details: { side: string } } }).error.details.side).toBe('main');
    await rm(path.join(r.dir, 'dirty.txt'));

    expect(errorOf(await owner.post(r.url('worktrees/merge'), { path: r.dir }))).toEqual([400, 'git_worktree_main']);
    for (const body of [{ squash: 'true' }, { squash: 1 }, { cleanup: 'yes' }]) {
      expect((await owner.post(r.url('worktrees/merge'), { path: created.worktree.path, ...body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await r.git('rev-list', '--count', 'HEAD')).trim()).toBe('1');

    await sandbox.git(created.worktree.path, 'checkout', '--quiet', '--detach');
    expect(errorOf(await owner.post(r.url('worktrees/merge'), { path: created.worktree.path }))).toEqual([400, 'git_detached_head']);
  });

  it('runs the main checkout’s commit hook and rolls back when it refuses', async () => {
    const r = await repo();
    const created = await create(r, 'hooked');
    await commitIn(created.worktree.path, 'feature.txt', 'f\n');
    const hook = path.join(r.dir, '.git/hooks/pre-commit');
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, '#!/bin/sh\necho "policy says no" >&2\nexit 1\n', { mode: 0o755 });
    const before = (await r.git('rev-parse', 'HEAD')).trim();

    const refused = await owner.post(r.url('worktrees/merge'), { path: created.worktree.path });
    expect(errorOf(refused)).toEqual([409, 'git_commit_rejected']);
    expect(JSON.stringify(refused.body)).toContain('policy says no');
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(before);
    expect((await r.git('status', '--porcelain')).trim()).toBe('');
    expect(existsSync(path.join(r.dir, 'feature.txt'))).toBe(false);
  });
});

describe('worktree details a member sees', () => {
  it('shows a member the worktrees but only the projects shared with them', async () => {
    const r = await repo();
    const created = await create(r, 'feature/x');
    const member = await t.member('alice');
    await owner.put(`/api/projects/${r.project.id}/members/${member.userId}`, { access: 'read' });
    const seen: GitWorktree[] = (await list(r, member)).worktrees;
    expect(seen.map((worktree) => [worktree.branch, worktree.projectId])).toEqual([
      ['main', r.project.id],
      ['feature/x', null],
    ]);
    await owner.put(`/api/projects/${created.project.id}/members/${member.userId}`, { access: 'read' });
    expect((await list(r, member)).worktrees[1]!.projectId).toBe(created.project.id);
  });
});
