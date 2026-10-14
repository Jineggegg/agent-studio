import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitAll, git, initRepository } from './support/git.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.7 — Worktrees, and creating a project by cloning (requirements 02 §6.7
 * AT-PJ-108…115, §6.1 AT-PJ-020/021).
 *
 * A worktree is a second checkout of a repository on a branch of its own, in
 * a sibling folder, and a project of its own. Making and unmaking them makes
 * and unmakes project folders, so it is the owner's.
 *
 * Cloning is tested for its refusals only: an address that would be accepted
 * would make the server contact a real host.
 */
describe('6.7 worktrees', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let counter = 0;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    expect(
      (await owner.put('/api/git/identity', { name: 'The Owner', email: 'owner@example.test' }))
        .status,
    ).toBe(200);
  });
  afterAll(() => studio?.destroy());

  async function repository(): Promise<{
    project: Project;
    root: string;
    api: string;
    name: string;
  }> {
    const name = `tree-${(counter += 1)}`;
    const project = await createProject(studio, owner, name);
    initRepository(project.rootDir);
    await writeFile(path.join(project.rootDir, 'shared.txt'), 'line one\n');
    commitAll(project.rootDir, 'first commit');
    return { project, root: project.rootDir, api: `/api/projects/${project.id}/git`, name };
  }
  const projects = async () =>
    (await owner.get<{ projects: Project[] }>('/api/projects?archived=include')).body.projects;

  it('AT-PJ-108: creating a worktree for a new branch makes a folder beside the repository, on that branch, and a project of its own for it', async () => {
    const { root, api, name } = await repository();
    const created = await owner.post<Json>(`${api}/worktrees`, { branch: 'feature/x' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { worktree, project: linked, branchCreated } = created.body;
    expect(branchCreated).toBe(true);
    expect(worktree).toMatchObject({
      branch: 'feature/x',
      main: false,
      detached: false,
      missing: false,
      projectId: linked.id,
    });
    expect(path.dirname(worktree.path)).toBe(path.join(studio.workspace, `${name}-worktrees`)); // the sibling folder
    expect(existsSync(path.join(worktree.path, 'shared.txt'))).toBe(true);
    expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // the main checkout did not move
    expect(linked).toMatchObject({ rootDir: worktree.path, name: `${name} · feature/x` });
    expect((await projects()).map((project) => project.id)).toContain(linked.id);

    const listed = (await owner.get<Json>(`${api}/worktrees`)).body;
    expect(listed.baseBranch).toBe('main');
    expect(listed.worktrees.map((entry: Json) => `${entry.branch}:${entry.main}`).sort()).toEqual([
      'feature/x:false',
      'main:true',
    ]);
    // The worktree is an ordinary project: its own git status works.
    expect((await owner.get<Json>(`/api/projects/${linked.id}/git/status`)).body.branch.name).toBe(
      'feature/x',
    );
  });

  it('AT-PJ-109/110: a worktree branch needs a real branch name — a blank, option-like, path-like or shell-flavoured one is refused and nothing is created; surrounding spaces are trimmed; a branch already checked out cannot be checked out again', async () => {
    const { root, api, name } = await repository();
    const sibling = path.join(studio.workspace, `${name}-worktrees`);
    for (const branch of [
      '',
      '   ',
      '-f',
      '--detach',
      '/leading',
      'trailing/',
      'trailing.',
      'a..b',
      'a//b',
      'has space',
      'semi;colon',
      '$(touch pwned)',
      '.hidden/x',
      'x/.hidden',
      'topic.lock',
      'x/topic.lock/y',
    ]) {
      const refused = await owner.post<ErrorBody>(`${api}/worktrees`, { branch });
      expect(refused.status, JSON.stringify(branch)).toBe(400);
    }
    expect(existsSync(sibling)).toBe(false);
    expect(git(root, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(existsSync(path.join(root, 'pwned'))).toBe(false);

    const trimmed = await owner.post<Json>(`${api}/worktrees`, { branch: ' feature/login-form ' });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.worktree.branch).toBe('feature/login-form');
    // The same branch again: it is checked out elsewhere already.
    const twice = await owner.post<ErrorBody>(`${api}/worktrees`, { branch: 'feature/login-form' });
    expect(twice.status).toBe(409);
    const current = await owner.post<ErrorBody>(`${api}/worktrees`, { branch: 'main' });
    expect(current.status).toBe(409);
    // A folder already in the way is a conflict as well, not something to overwrite.
    await mkdir(path.join(sibling, 'occupied'), { recursive: true });
    await writeFile(path.join(sibling, 'occupied', 'mine.txt'), 'do not touch\n');
    const occupied = await owner.post<ErrorBody>(`${api}/worktrees`, { branch: 'occupied' });
    expect(occupied.status).toBe(409);
    expect(readFileSync(path.join(sibling, 'occupied', 'mine.txt'), 'utf8')).toBe('do not touch\n');
    // AT-PJ-115: text is not a boolean.
    expect(
      (
        await owner.post(`${api}/worktrees/remove`, {
          path: trimmed.body.worktree.path,
          force: 'true',
        })
      ).status,
    ).toBe(400);
    expect(existsSync(trimmed.body.worktree.path)).toBe(true);
  });

  it('AT-PJ-111: merging a worktree back with "squash" and clean-up leaves exactly one new commit on the main branch, and the worktree’s folder, branch and project are gone from the active list', async () => {
    const { root, api } = await repository();
    const created = (await owner.post<Json>(`${api}/worktrees`, { branch: 'feature/two-commits' }))
      .body;
    const tree = created.worktree.path as string;
    git(tree, 'config', 'user.name', 'Fixture Author');
    git(tree, 'config', 'user.email', 'fixture@example.test');
    await writeFile(path.join(tree, 'one.txt'), 'one\n');
    commitAll(tree, 'first of two');
    await writeFile(path.join(tree, 'two.txt'), 'two\n');
    commitAll(tree, 'second of two');
    const before = git(root, 'rev-parse', 'HEAD');

    const merged = await owner.post<Json>(`${api}/worktrees/merge`, {
      path: tree,
      squash: true,
      message: 'Add one and two',
      cleanup: true,
    });
    expect(merged.status, JSON.stringify(merged.body)).toBeLessThan(300);
    expect(merged.body).toMatchObject({
      into: 'main',
      branch: 'feature/two-commits',
      squash: true,
      cleanupError: null,
    });
    expect(git(root, 'rev-list', '--count', `${before}..HEAD`)).toBe('1');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('Add one and two');
    expect(git(root, 'rev-list', '--parents', '-1', 'HEAD').split(' ')).toHaveLength(2); // one parent: a squash, not a merge commit
    expect(readFileSync(path.join(root, 'two.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(tree)).toBe(false);
    expect(git(root, 'branch', '--format=%(refname:short)')).toBe('main');
    const linked = (await projects()).find((project) => project.id === created.project.id);
    expect(linked?.archived ?? true).toBe(true); // archived (its conversations stay restorable), or gone
    expect(
      (await owner.get<{ projects: Project[] }>('/api/projects')).body.projects.map(
        (project) => project.id,
      ),
    ).not.toContain(created.project.id);
  });

  it('AT-PJ-112/113: a merge that would conflict is refused naming the files, and leaves the main checkout exactly as it was; so is a merge from a worktree with uncommitted changes, and of the main checkout into itself', async () => {
    const { root, api } = await repository();
    const created = (await owner.post<Json>(`${api}/worktrees`, { branch: 'feature/conflict' }))
      .body;
    const tree = created.worktree.path as string;
    git(tree, 'config', 'user.name', 'Fixture Author');
    git(tree, 'config', 'user.email', 'fixture@example.test');

    // Uncommitted changes on the worktree side.
    await writeFile(path.join(tree, 'shared.txt'), 'line one, changed in the worktree\n');
    const dirty = await owner.post<ErrorBody>(`${api}/worktrees/merge`, { path: tree });
    expect(dirty.status).toBe(409);
    expect(dirty.body.error.code).toBe('git_worktree_dirty');

    commitAll(tree, 'worktree changes the line');
    await writeFile(path.join(root, 'shared.txt'), 'line one, changed in the main checkout\n');
    const mainHead = commitAll(root, 'main changes the same line');
    const conflict = await owner.post<ErrorBody>(`${api}/worktrees/merge`, { path: tree });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('git_conflict');
    expect(JSON.stringify(conflict.body)).toContain('shared.txt');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(
      'line one, changed in the main checkout\n',
    );

    const self = await owner.post<ErrorBody>(`${api}/worktrees/merge`, { path: root });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('git_worktree_main');
    expect(
      (
        await owner.post(`${api}/worktrees/merge`, {
          path: path.join(studio.workspace, 'not-a-worktree'),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('AT-PJ-114: a worktree with uncommitted changes is removed only when forced; the main checkout can never be removed; the linked project ends archived', async () => {
    const { root, api } = await repository();
    const created = (await owner.post<Json>(`${api}/worktrees`, { branch: 'feature/abandoned' }))
      .body;
    const tree = created.worktree.path as string;
    await writeFile(path.join(tree, 'unsaved-work.txt'), 'not committed\n');
    const careful = await owner.post<ErrorBody>(`${api}/worktrees/remove`, { path: tree });
    expect(careful.status).toBe(409);
    expect(careful.body.error.code).toBe('git_worktree_dirty');
    expect(existsSync(path.join(tree, 'unsaved-work.txt'))).toBe(true);

    const main = await owner.post<ErrorBody>(`${api}/worktrees/remove`, {
      path: root,
      force: true,
    });
    expect(main.status).toBe(400);
    expect(main.body.error.code).toBe('git_worktree_main');
    expect(existsSync(path.join(root, 'shared.txt'))).toBe(true);
    // A path that is not one of this repository's worktrees is not removed either.
    const elsewhere = path.join(studio.workspace, 'precious');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'keep.txt'), 'keep\n');
    expect(
      (await owner.post(`${api}/worktrees/remove`, { path: elsewhere, force: true })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(existsSync(path.join(elsewhere, 'keep.txt'))).toBe(true);

    const forced = await owner.post<Json>(`${api}/worktrees/remove`, {
      path: tree,
      force: true,
      deleteBranch: true,
    });
    expect(forced.status, JSON.stringify(forced.body)).toBeLessThan(300);
    expect(existsSync(tree)).toBe(false);
    expect(forced.body).toMatchObject({ branch: 'feature/abandoned', branchDeleted: true });
    expect(forced.body.project).toMatchObject({ id: created.project.id, archived: true });
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('AT-PJ-020/021: a clone address that is a local path, a helper program or an option is refused before anything is transferred, and one with a password in it is refused without repeating the password', async () => {
    const before = (await projects()).length;
    for (const url of [
      'file:///etc',
      '/etc/passwd',
      '../somewhere',
      'ext::sh -c "touch pwned"',
      '--upload-pack=touch pwned',
      '-oProxyCommand=touch pwned',
      'git://example.test/repo.git',
      'http://example.test/repo.git',
      'ftp://example.test/repo.git',
    ]) {
      const refused = await owner.post<ErrorBody>('/api/projects/clone', { url });
      expect(refused.status, url).toBe(400);
    }
    const withSecret = await owner.post<ErrorBody>('/api/projects/clone', {
      url: 'https://someone:hunter2-token@example.test/private/repo.git',
    });
    expect(withSecret.status).toBe(400);
    expect(JSON.stringify(withSecret.body)).not.toContain('hunter2-token');
    expect(withSecret.body.error.message.length).toBeGreaterThan(10);
    // A destination outside the workspace is refused as well, whatever the address.
    for (const body of [
      { url: 'https://example.test/owner/repo.git', parentDir: '/etc' },
      { url: 'https://example.test/owner/repo.git', parentDir: path.dirname(studio.workspace) },
      { url: 'https://example.test/owner/repo.git', directoryName: '../escape' },
      { url: 'https://example.test/owner/repo.git', directoryName: '.git' },
    ]) {
      const refused = await owner.post<ErrorBody>('/api/projects/clone', body);
      expect(refused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(refused.status, JSON.stringify(body)).toBeLessThan(500);
    }
    expect((await projects()).length).toBe(before);
    expect(existsSync(path.join(studio.workspace, 'pwned'))).toBe(false);
    expect(existsSync(path.join(studio.workspace, 'repo'))).toBe(false);
    // AT-PJ-022: a clone job is its starter's — an unknown handle is "not found".
    expect((await owner.get('/api/projects/clone/0123456789abcdefghjkmnpqrs')).status).toBe(404);
  });
});
