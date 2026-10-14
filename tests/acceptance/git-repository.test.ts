import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitAll, git, initRepository, tryGit } from './support/git.js';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  shareProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.6 — Git on a real repository (requirements 02 §6.6, §7.3).
 *
 * Each test builds a throw-away repository in the harness's workspace with
 * the real `git`, drives the product through its API, and then asks `git`
 * itself what happened. Remotes (fetch, pull, push) are in the neighbouring
 * file.
 *
 * Deliberate difference under test: a read-only query — status, diff, log —
 * runs nothing that the repository's own configuration names.
 */
describe('6.6 git: status, staging, commits, branches, history', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let counter = 0;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
  });
  afterAll(() => studio?.destroy());

  /** A project whose folder is a repository with one commit (`README.md`, `src/app.ts`). */
  async function repository(
    name = `repo-${(counter += 1)}`,
  ): Promise<{ project: Project; root: string; api: string }> {
    const project = await createProject(studio, owner, name);
    const root = project.rootDir;
    initRepository(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'README.md'), '# Fixture\n');
    await writeFile(path.join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
    commitAll(root, 'first commit');
    return { project, root, api: `/api/projects/${project.id}/git` };
  }
  const status = async (api: string, client: ApiClient = owner) =>
    (await client.get<Json>(`${api}/status`)).body;
  const fileOf = (state: Json, file: string) =>
    (state.files as Json[]).find((entry) => entry.path === file);
  const refusal = (response: { status: number; body: unknown }, code: string, what = code) => {
    expect(
      (response.body as ErrorBody).error?.code,
      `${what}: ${JSON.stringify(response.body)}`,
    ).toBe(code);
    expect(response.status, what).toBeGreaterThanOrEqual(400);
    expect((response.body as ErrorBody).error.message.length).toBeGreaterThan(8); // a sentence, not a bare code
  };

  it('AT-PJ-086: a folder without a repository says so; initialising gives a repository with no commits; the initial commit holds the folder’s files; a second one is refused', async () => {
    const project = await createProject(studio, owner, 'not-yet-a-repo');
    const api = `/api/projects/${project.id}/git`;
    await writeFile(path.join(project.rootDir, 'hello.txt'), 'hello\n');
    await mkdir(path.join(project.rootDir, 'lib'));
    await writeFile(path.join(project.rootDir, 'lib', 'util.ts'), 'export {};\n');
    expect(await status(api)).toMatchObject({
      state: 'none',
      branch: null,
      hasCommits: false,
      files: [],
    });
    refusal(await owner.get(`${api}/log`), 'git_not_a_repository');

    const created = await owner.post<Json>(`${api}/init`);
    expect(created.status).toBeLessThan(300);
    expect(created.body).toEqual({ created: true });
    expect(existsSync(path.join(project.rootDir, '.git'))).toBe(true);
    const fresh = await status(api);
    expect(fresh).toMatchObject({ state: 'ready', hasCommits: false, remotes: [] });
    expect(fresh.counts.untracked).toBeGreaterThan(0);

    // Nobody on this server has said who they are yet: the commit is refused with that reason rather than made under a made-up name.
    refusal(await owner.post(`${api}/initial-commit`, {}), 'git_identity_missing');
    expect(tryGit(project.rootDir, 'rev-parse', 'HEAD').ok).toBe(false);
    expect(
      (await owner.put('/api/git/identity', { name: 'The Owner', email: 'owner@example.test' }))
        .status,
    ).toBe(200);
    const first = await owner.post<Json>(`${api}/initial-commit`, {});
    expect(first.status).toBeLessThan(300);
    expect(git(project.rootDir, 'log', '-1', '--format=%an <%ae>')).toBe(
      'The Owner <owner@example.test>',
    );
    expect(git(project.rootDir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(project.rootDir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()).toEqual(
      ['hello.txt', 'lib/util.ts'],
    );
    expect((await status(api)).hasCommits).toBe(true);
    const log = (await owner.get<Json>(`${api}/log`)).body;
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0].oid).toBe(first.body.oid);

    const second = await owner.post<ErrorBody>(`${api}/initial-commit`, {});
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    expect(git(project.rootDir, 'rev-list', '--count', 'HEAD')).toBe('1');
    // Initialising an existing repository changes nothing.
    expect((await owner.post<Json>(`${api}/init`)).body).toEqual({ created: false });
  });

  it('AT-PJ-087: status puts a modified, a newly added, a deleted and an untracked file each in its group, and keeps a path with a space intact', async () => {
    const { root, api } = await repository();
    await writeFile(path.join(root, 'gone.txt'), 'to be deleted\n');
    await writeFile(path.join(root, 'with space.txt'), 'spaced\n');
    commitAll(root, 'more files');
    await writeFile(path.join(root, 'README.md'), '# Fixture\n\nchanged\n'); // modified
    await writeFile(path.join(root, 'added.txt'), 'new and staged\n');
    git(root, 'add', 'added.txt'); // newly added, staged
    await rm(path.join(root, 'gone.txt')); // deleted
    await writeFile(path.join(root, 'untracked.txt'), 'nobody knows me\n'); // untracked
    await writeFile(path.join(root, 'with space.txt'), 'spaced and changed\n');

    const state = await status(api);
    expect(state).toMatchObject({
      state: 'ready',
      hasCommits: true,
      operation: null,
      truncated: false,
    });
    expect(state.branch).toMatchObject({ name: 'main', detached: false, upstream: null });
    expect(fileOf(state, 'README.md')).toMatchObject({
      index: null,
      worktree: 'modified',
      conflicted: false,
    });
    expect(fileOf(state, 'added.txt')).toMatchObject({ index: 'added', worktree: null });
    expect(fileOf(state, 'gone.txt')).toMatchObject({ index: null, worktree: 'deleted' });
    expect(fileOf(state, 'untracked.txt')).toMatchObject({ index: null, worktree: 'untracked' });
    expect(fileOf(state, 'with space.txt')).toMatchObject({ worktree: 'modified' });
    expect(state.files).toHaveLength(5);
    expect(state.counts).toEqual({ staged: 1, unstaged: 3, untracked: 1, conflicted: 0 });
    // The change itself can be read.
    const diff = (await owner.get<Json>(`${api}/diff?path=${encodeURIComponent('with space.txt')}`))
      .body;
    expect(diff).toMatchObject({ path: 'with space.txt', binary: false, truncated: false });
    expect(diff.diff).toContain('-spaced');
    expect(diff.diff).toContain('+spaced and changed');
    expect((await owner.get<Json>(`${api}/diff?path=added.txt&staged=true`)).body.diff).toContain(
      '+new and staged',
    );
  });

  it('AT-PJ-088: a staged rename appears once, under its new name; a file in a merge conflict is flagged as conflicted and is never listed as staged', async () => {
    const { root, api } = await repository();
    git(root, 'mv', 'README.md', 'GUIDE.md');
    let state = await status(api);
    expect(state.files).toHaveLength(1);
    expect(state.files[0]).toMatchObject({
      path: 'GUIDE.md',
      originalPath: 'README.md',
      index: 'renamed',
    });
    commitAll(root, 'rename');

    // Two branches change the same line.
    git(root, 'checkout', '-q', '-b', 'other');
    await writeFile(path.join(root, 'src', 'app.ts'), 'export const answer = 1;\n');
    commitAll(root, 'other says 1');
    git(root, 'checkout', '-q', 'main');
    await writeFile(path.join(root, 'src', 'app.ts'), 'export const answer = 2;\n');
    commitAll(root, 'main says 2');
    expect(tryGit(root, 'merge', 'other').ok).toBe(false);
    state = await status(api);
    expect(state.operation).toBe('merge');
    expect(fileOf(state, 'src/app.ts')).toMatchObject({ conflicted: true });
    expect(state.counts).toMatchObject({ conflicted: 1, staged: 0 });
    // Nothing can be committed over an unresolved conflict.
    const refused = await owner.post<ErrorBody>(`${api}/commit`, { message: 'pretend it is fine' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(git(root, 'log', '-1', '--format=%s')).toBe('main says 2');
  });

  it('AT-PJ-089: staging a file puts it in the repository’s index, unstaging takes it out, and a file staged outside the product shows as staged', async () => {
    const { root, api } = await repository();
    await writeFile(path.join(root, 'one.txt'), '1\n');
    await writeFile(path.join(root, 'two.txt'), '2\n');
    expect((await owner.post(`${api}/stage`, { paths: ['one.txt'] })).status).toBeLessThan(300);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('one.txt');
    git(root, 'add', 'two.txt'); // staged in a terminal
    const state = await status(api);
    expect(fileOf(state, 'one.txt').index).toBe('added');
    expect(fileOf(state, 'two.txt').index).toBe('added');
    expect((await owner.post(`${api}/unstage`, { paths: ['one.txt'] })).status).toBeLessThan(300);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('two.txt');
    expect((await owner.post(`${api}/stage`, { all: true })).status).toBeLessThan(300);
    expect(git(root, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([
      'one.txt',
      'two.txt',
    ]);
    // "Both or neither" is refused rather than guessed.
    expect((await owner.post(`${api}/stage`, {})).status).toBe(400);
    expect((await owner.post(`${api}/stage`, { all: true, paths: ['one.txt'] })).status).toBe(400);
    // Paths are confined to the project like everywhere else.
    const escape = await owner.post(`${api}/stage`, { paths: ['../repo-1/README.md'] });
    expect(escape.status).toBeGreaterThanOrEqual(400);
    expect(escape.status).toBeLessThan(500);
  });

  it('AT-PJ-090: a commit needs a message and something staged; two staged files committed with message "m" make one commit of exactly those files and leave nothing staged', async () => {
    const { root, api } = await repository();
    const before = git(root, 'rev-parse', 'HEAD');
    refusal(
      await owner.post(`${api}/commit`, { message: 'nothing to say' }),
      'git_nothing_to_commit',
    );
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await writeFile(path.join(root, 'b.txt'), 'b\n');
    await writeFile(path.join(root, 'left-out.txt'), 'not part of it\n');
    git(root, 'add', 'a.txt', 'b.txt');
    const blank = await owner.post<ErrorBody>(`${api}/commit`, { message: '   ' });
    expect(blank.status).toBe(400);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);

    const tablet = await studio.owner();
    const live = await Realtime.open(studio, tablet);
    await live.subscribe(`project:${(await owner.get<Json>(api.replace('/git', ''))).body.id}`);
    const committed = await owner.post<Json>(`${api}/commit`, { message: 'm' });
    expect(committed.status).toBeLessThan(300);
    expect(committed.body).toMatchObject({ subject: 'm', branch: 'main' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(committed.body.oid);
    expect(git(root, 'rev-list', '--count', `${before}..HEAD`)).toBe('1');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('m');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
    const state = await status(api);
    expect(state.counts).toMatchObject({ staged: 0, untracked: 1 });
    expect(fileOf(state, 'left-out.txt').worktree).toBe('untracked');
    // The other device is told the repository changed.
    const told = await live.event(
      live.frames.find((frame) => frame.op === 'subscribed')!.topic!,
      'git.changed',
    );
    expect(told.data.projectId).toBeDefined();
    await live.close();
  });

  it('AT-PJ-091: discarding a modified file restores what was committed; deleting an untracked file removes it; a tracked file cannot be deleted "as untracked"', async () => {
    const { root, api } = await repository();
    await writeFile(path.join(root, 'README.md'), 'scribbled over\n');
    await writeFile(path.join(root, 'scratch.txt'), 'temporary\n');
    expect((await owner.post(`${api}/discard`, { path: 'README.md' })).status).toBeLessThan(300);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# Fixture\n');
    refusal(
      await owner.post(`${api}/delete-untracked`, { path: 'src/app.ts' }),
      'git_not_untracked',
    );
    expect(existsSync(path.join(root, 'src', 'app.ts'))).toBe(true);
    expect(
      (await owner.post(`${api}/delete-untracked`, { path: 'scratch.txt' })).status,
    ).toBeLessThan(300);
    expect(existsSync(path.join(root, 'scratch.txt'))).toBe(false);
    expect((await status(api)).files).toEqual([]);
    // Nothing to discard is said, not silently accepted.
    const nothing = await owner.post<ErrorBody>(`${api}/discard`, { path: 'README.md' });
    expect(nothing.status).toBeGreaterThanOrEqual(400);
  });

  it('AT-PJ-092: undoing the latest commit removes it from history and leaves its changes staged', async () => {
    const { root, api } = await repository();
    const first = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'second.txt'), 'second\n');
    const second = commitAll(root, 'second commit');
    const undone = await owner.post<Json>(`${api}/undo-commit`);
    expect(undone.status).toBeLessThan(300);
    expect(undone.body).toEqual({ undone: second, head: first });
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('second.txt');
    expect(readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe('second\n');
    expect(fileOf(await status(api), 'second.txt').index).toBe('added');
  });

  it('AT-PJ-093/095: a branch is created and becomes current, another is switched to; a merged branch is deleted, an unmerged one only with force, the current one never', async () => {
    const { root, api } = await repository();
    const created = await owner.post<Json>(`${api}/branches`, { name: 'feature/login-form' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ branch: 'feature/login-form', current: 'feature/login-form' });
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login-form');
    const branches = (await owner.get<Json>(`${api}/branches`)).body;
    expect(branches).toMatchObject({ current: 'feature/login-form', detached: false });
    expect(
      branches.branches.map((branch: Json) => `${branch.name}${branch.current ? '*' : ''}`).sort(),
    ).toEqual(['feature/login-form*', 'main']);
    refusal(
      await owner.post(`${api}/branches`, { name: 'feature/login-form' }),
      'git_branch_exists',
    );

    await writeFile(path.join(root, 'login.ts'), 'export {};\n');
    commitAll(root, 'unmerged work');
    expect((await owner.post<Json>(`${api}/switch`, { branch: 'main' })).body).toMatchObject({
      current: 'main',
    });
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(existsSync(path.join(root, 'login.ts'))).toBe(false);

    git(root, 'branch', 'merged-already'); // points at main: fully merged
    expect(
      (await owner.post(`${api}/branches/delete`, { name: 'merged-already' })).status,
    ).toBeLessThan(300);
    refusal(
      await owner.post(`${api}/branches/delete`, { name: 'feature/login-form' }),
      'git_branch_not_merged',
    );
    expect(git(root, 'branch', '--list', 'feature/login-form')).toContain('feature/login-form');
    expect(
      (await owner.post(`${api}/branches/delete`, { name: 'feature/login-form', force: 'true' }))
        .status,
    ).toBe(400); // text is not a boolean
    expect(git(root, 'branch', '--list', 'feature/login-form')).toContain('feature/login-form');
    refusal(
      await owner.post(`${api}/branches/delete`, { name: 'main', force: true }),
      'git_branch_current',
    );
    expect(
      (await owner.post(`${api}/branches/delete`, { name: 'feature/login-form', force: true }))
        .status,
    ).toBeLessThan(300);
    expect(git(root, 'branch', '--format=%(refname:short)')).toBe('main');
    refusal(await owner.post(`${api}/switch`, { branch: 'no-such-branch' }), 'git_unknown_ref');
  });

  it('AT-PJ-094: a branch name that could be read as an option or a command is refused before git runs — on create, switch, delete, compare and history — and the repository is untouched', async () => {
    const { root, api } = await repository();
    const config = readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const head = git(root, 'rev-parse', 'HEAD');
    const names = [
      '-f',
      '--orphan=x',
      '--upload-pack=touch pwned',
      'bad name',
      'bad;name',
      'a..b',
      'topic.lock',
      '$(touch pwned)',
      '`touch pwned`',
      'x && touch pwned',
      'refs/heads/../../config',
      '-',
    ];
    for (const name of names) {
      for (const attempt of [
        owner.post(`${api}/branches`, { name }),
        owner.post(`${api}/branches`, { name: 'fine', from: name }),
        owner.post(`${api}/switch`, { branch: name }),
        owner.post(`${api}/branches/delete`, { name, force: true }),
        owner.get(`${api}/compare?base=${encodeURIComponent(name)}`),
        owner.get(`${api}/log?ref=${encodeURIComponent(name)}`),
      ]) {
        const response = await attempt;
        expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(400);
        expect((response.body as ErrorBody).error.code).toBe('git_invalid_ref');
      }
    }
    expect(git(root, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe(config);
    expect(existsSync(path.join(root, 'pwned'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
    // A remote name is held to the same standard.
    for (const remote of ['--upload-pack=touch pwned', '-o', 'ext::sh -c touch% pwned']) {
      const response = await owner.post<ErrorBody>(`${api}/fetch`, { remote });
      expect(response.status, remote).toBe(400);
    }
    expect(existsSync(path.join(root, 'pwned'))).toBe(false);
  });

  it('AT-PJ-101/102: comparing a feature branch against main lists its committed, staged, unstaged and untracked changes with the merge base; an unknown or unrelated branch is refused with its own reason', async () => {
    const { root, api } = await repository();
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'feature');
    await writeFile(path.join(root, 'committed.txt'), 'committed\n');
    commitAll(root, 'feature commit');
    await writeFile(path.join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    await writeFile(path.join(root, 'README.md'), '# Fixture\n\nunstaged change\n');
    await writeFile(path.join(root, 'untracked.txt'), 'line one\nline two\n');

    const comparison = (await owner.get<Json>(`${api}/compare?base=main`)).body;
    expect(comparison).toMatchObject({ base: 'main', mergeBase: base, truncated: false });
    expect(comparison.files.map((file: Json) => `${file.status} ${file.path}`).sort()).toEqual([
      'A committed.txt',
      'A staged.txt',
      'M README.md',
      'U untracked.txt',
    ]);
    expect(comparison.files.find((file: Json) => file.path === 'committed.txt')).toMatchObject({
      additions: 1,
      deletions: 0,
    });
    // Expanding the untracked file shows all of it as additions.
    const diff = (await owner.get<Json>(`${api}/compare/diff?base=main&path=untracked.txt`)).body;
    expect(diff.diff).toContain('+line one');
    expect(diff.diff).toContain('+line two');

    refusal(await owner.get(`${api}/compare?base=no-such-branch`), 'git_unknown_ref');
    git(root, 'checkout', '-q', '--orphan', 'island');
    git(root, 'rm', '-rfq', '--cached', '.');
    await writeFile(path.join(root, 'island.txt'), 'alone\n');
    git(root, 'add', 'island.txt');
    git(root, 'commit', '-q', '-m', 'unrelated history');
    refusal(await owner.get(`${api}/compare?base=main`), 'git_no_common_history');
  });

  it('AT-PJ-103 (adapted): history is read fifty commits at a time, newest first; a merge shows both parents; a commit shows its files with line counts', async () => {
    const { root, api } = await repository();
    for (let index = 1; index <= 57; index += 1) {
      writeFileSync(path.join(root, 'counter.txt'), `${index}\n`);
      commitAll(root, `commit ${index}`);
    }
    git(root, 'checkout', '-q', '-b', 'side');
    await writeFile(path.join(root, 'side.txt'), 'one\ntwo\nthree\n');
    const sideCommit = commitAll(root, 'side work');
    git(root, 'checkout', '-q', 'main');
    await writeFile(path.join(root, 'main.txt'), 'main\n');
    commitAll(root, 'main work');
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const total = Number(git(root, 'rev-list', '--count', 'HEAD'));
    expect(total).toBe(61);

    const first = (await owner.get<Json>(`${api}/log`)).body;
    expect(first.commits).toHaveLength(50);
    expect(first.commits[0]).toMatchObject({
      subject: 'merge side',
      authorName: 'Fixture Author',
      authorEmail: 'fixture@example.test',
    });
    expect(first.commits[0].parents).toHaveLength(2);
    expect(first.commits[0].parents).toContain(sideCommit);
    expect(first.commits[0].refs.map((ref: Json) => ref.name)).toContain('main');
    expect(first.nextCursor).not.toBeNull();
    const rest = (await owner.get<Json>(`${api}/log?cursor=${first.nextCursor}`)).body;
    expect(rest.commits).toHaveLength(11);
    expect(rest.nextCursor).toBeNull();
    const all = [...first.commits, ...rest.commits].map((commit: Json) => commit.oid);
    expect(new Set(all).size).toBe(61);
    expect(all.sort()).toEqual(git(root, 'rev-list', 'HEAD').split('\n').sort());

    const detail = (await owner.get<Json>(`${api}/commits/${sideCommit}`)).body;
    expect(detail).toMatchObject({
      oid: sideCommit,
      subject: 'side work',
      additions: 3,
      deletions: 0,
      diffTruncated: false,
    });
    expect(detail.files).toEqual([
      { path: 'side.txt', originalPath: null, status: 'A', additions: 3, deletions: 0 },
    ]);
    expect(detail.diff).toContain('+three');
    expect((await owner.get(`${api}/commits/not-a-commit-id`)).status).toBe(400);
    expect((await owner.get(`${api}/log?limit=500`)).status).toBe(400);
  });

  it('AT-PJ-106: a malformed commit identity is refused; a valid one is stored for the account, returned on the next read, and is the author of the next commit — the repository’s configuration is not touched', async () => {
    const { root, api } = await repository();
    const committer = await createMember(studio, owner, 'committer');
    await shareProject(
      owner,
      (await owner.get<Json>(api.replace('/git', ''))).body.id,
      committer.userId!,
      'write',
    );
    for (const bad of [
      { name: 'Ada', email: 'not-an-email' },
      { name: 'Ada <ada@example.test>', email: 'ada@example.test' },
      { name: '', email: 'ada@example.test' },
      { name: 'Ada\nInjected: header', email: 'ada@example.test' },
    ]) {
      expect((await committer.put('/api/git/identity', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await committer.get<Json>('/api/git/identity')).body.source).not.toBe('user');
    const saved = await committer.put<Json>('/api/git/identity', {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    });
    expect(saved.status).toBe(200);
    expect((await committer.get<Json>('/api/git/identity')).body).toEqual({
      source: 'user',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    });
    // It is the account's, not everyone's.
    expect((await owner.get<Json>('/api/git/identity')).body.name).not.toBe('Ada Lovelace');
    expect((await studio.client().get('/api/git/identity')).status).toBe(401);

    const config = readFileSync(path.join(root, '.git', 'config'), 'utf8');
    await writeFile(path.join(root, 'by-ada.txt'), 'x\n');
    await committer.post(`${api}/stage`, { paths: ['by-ada.txt'] });
    const committed = await committer.post<Json>(`${api}/commit`, { message: 'authored by Ada' });
    expect(committed.status).toBeLessThan(300);
    expect(git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Ada Lovelace <ada@example.test>');
    expect(readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe(config);
    expect((await owner.get<Json>(`${api}/log?limit=1`)).body.commits[0]).toMatchObject({
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.test',
    });
  });

  it('§7.3: reading a repository runs nothing the repository’s own configuration names — a planted file-system monitor, external diff, text converter or pager never executes', async () => {
    const { root, api } = await repository();
    const marker = path.join(root, 'EXECUTED');
    const script = path.join(root, 'planted.sh');
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`);
    chmodSync(script, 0o755);
    git(root, 'config', 'core.fsmonitor', script);
    git(root, 'config', 'diff.external', script);
    git(root, 'config', 'core.pager', script);
    git(root, 'config', 'diff.planted.textconv', script);
    git(root, 'config', 'core.hooksPath', root);
    await writeFile(path.join(root, '.gitattributes'), '*.md diff=planted\n');
    await writeFile(
      path.join(root, 'README.md'),
      '# Fixture\n\nchanged so there is something to diff\n',
    );

    // Control: plain git, as a person would run it in a terminal, does execute what was planted.
    tryGit(root, 'status');
    tryGit(root, 'diff');
    expect(existsSync(marker), 'the fixture is live: plain git runs the planted program').toBe(
      true,
    );
    await rm(marker);

    const state = await status(api);
    expect(state.state).toBe('ready');
    expect(fileOf(state, 'README.md').worktree).toBe('modified');
    expect((await owner.get<Json>(`${api}/diff?path=README.md`)).body.diff).toContain(
      '+changed so there is something to diff',
    );
    expect((await owner.get(`${api}/log`)).status).toBe(200);
    expect((await owner.get(`${api}/branches`)).status).toBe(200);
    expect((await owner.get(`${api}/compare?base=main`)).status).toBe(200);
    expect((await owner.get(`${api}/commits/${git(root, 'rev-parse', 'HEAD')}`)).status).toBe(200);
    expect(
      (await owner.get(`/api/projects/${api.split('/')[3]}/files/grep?query=Fixture`)).status,
    ).toBe(200);
    expect(
      existsSync(marker),
      'a program named by the repository’s configuration was run by a read-only query',
    ).toBe(false);
  });

  it('access: a read-only member can look at the repository and cannot change it; someone without the project finds nothing', async () => {
    const { project, root, api } = await repository();
    const reader = await createMember(studio, owner, 'gitreader');
    const stranger = await createMember(studio, owner, 'gitstranger');
    await shareProject(owner, project.id, reader.userId!, 'read');
    await writeFile(path.join(root, 'pending.txt'), 'x\n');
    expect((await status(api, reader)).state).toBe('ready');
    expect((await reader.get(`${api}/log`)).status).toBe(200);
    expect((await reader.get(`${api}/branches`)).status).toBe(200);
    const head = git(root, 'rev-parse', 'HEAD');
    for (const attempt of [
      reader.post(`${api}/stage`, { all: true }),
      reader.post(`${api}/commit`, { message: 'by a reader' }),
      reader.post(`${api}/branches`, { name: 'by-reader' }),
      reader.post(`${api}/switch`, { branch: 'main' }),
      reader.post(`${api}/discard`, { path: 'README.md' }),
      reader.post(`${api}/delete-untracked`, { path: 'pending.txt' }),
      reader.post(`${api}/undo-commit`),
      reader.post(`${api}/init`),
      reader.post(`${api}/push`, {}),
      reader.post(`${api}/pull`, {}),
      reader.post(`${api}/fetch`, {}),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('project_read_only');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(existsSync(path.join(root, 'pending.txt'))).toBe(true);
    for (const url of ['status', 'log', 'branches', 'diff?path=README.md', 'worktrees']) {
      expect((await stranger.get(`${api}/${url}`)).status, url).toBe(404);
      expect((await studio.client().get(`${api}/${url}`)).status, url).toBe(401);
    }
    expect((await stranger.post(`${api}/commit`, { message: 'x' })).status).toBe(404);
    // Worktrees make and unmake project folders: the owner's alone, even for a member who may write.
    await shareProject(owner, project.id, reader.userId!, 'write');
    const worktree = await reader.post<ErrorBody>(`${api}/worktrees`, { branch: 'feature/x' });
    expect(worktree.status).toBe(403);
    expect(worktree.body.error.code).toBe('owner_required');
  });
});
