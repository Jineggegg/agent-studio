import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitAll, git, initBareRepository, initRepository, tryGit } from './support/git.js';
import { within } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.6 — Git with a remote (requirements 02 §6.6: AT-PJ-096…100).
 *
 * The remote is a bare repository in the harness's workspace; a second clone
 * plays the colleague who pushes from elsewhere. Nothing leaves the machine.
 *
 * Deliberate difference under test: remote operations are bounded in time and
 * say what actually went wrong — a rejected push is "rejected", not "failed".
 */
describe('6.6 git: fetch, pull, push', () => {
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

  interface Fixture {
    project: Project;
    root: string;
    api: string;
    bare: string;
    colleague: string;
  }

  /** A project repository with `origin` (a bare repository) holding its first commit, and a colleague's clone of it. */
  async function withRemote(): Promise<Fixture> {
    const name = `remote-${(counter += 1)}`;
    const project = await createProject(studio, owner, name);
    const root = project.rootDir;
    const bare = path.join(studio.workspace, 'remotes', `${name}.git`);
    const colleague = path.join(studio.workspace, 'colleagues', name);
    initBareRepository(bare);
    initRepository(root);
    await writeFile(path.join(root, 'shared.txt'), 'line one\n');
    commitAll(root, 'first commit');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '-u', 'origin', 'main');
    await mkdir(path.dirname(colleague), { recursive: true });
    git(path.dirname(colleague), 'clone', '-q', bare, colleague);
    git(colleague, 'config', 'user.name', 'A Colleague');
    git(colleague, 'config', 'user.email', 'colleague@example.test');
    return { project, root, api: `/api/projects/${project.id}/git`, bare, colleague };
  }
  async function colleaguePushes(
    fixture: Fixture,
    file: string,
    content: string,
    message: string,
  ): Promise<string> {
    await writeFile(path.join(fixture.colleague, file), content);
    const oid = commitAll(fixture.colleague, message);
    git(fixture.colleague, 'push', '-q', 'origin', 'main');
    return oid;
  }
  async function localCommit(
    fixture: Fixture,
    file: string,
    content: string,
    message: string,
  ): Promise<string> {
    await writeFile(path.join(fixture.root, file), content);
    return commitAll(fixture.root, message);
  }
  const remoteHead = (fixture: Fixture, branch = 'main') =>
    git(fixture.bare, 'rev-parse', `refs/heads/${branch}`);
  const branchOf = async (fixture: Fixture) =>
    (await owner.get<Json>(`${fixture.api}/status`)).body.branch;
  const refusal = (response: { status: number; body: unknown }, code: string | string[]) => {
    const codes = Array.isArray(code) ? code : [code];
    expect(codes, JSON.stringify(response.body)).toContain(
      (response.body as ErrorBody).error?.code,
    );
    expect((response.body as ErrorBody).error.message.length).toBeGreaterThan(10);
  };

  it('AT-PJ-096: with the remote one commit ahead and the local branch two ahead, a fetch makes the header read "2 ahead, 1 behind"', async () => {
    const fixture = await withRemote();
    await colleaguePushes(fixture, 'theirs.txt', 'theirs\n', 'colleague commit');
    await localCommit(fixture, 'mine-1.txt', '1\n', 'mine 1');
    await localCommit(fixture, 'mine-2.txt', '2\n', 'mine 2');
    // Before fetching, the product knows only what the last fetch knew.
    expect(await branchOf(fixture)).toMatchObject({
      name: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
    });
    const fetched = await owner.post<Json>(`${fixture.api}/fetch`, {});
    expect(fetched.status).toBeLessThan(300);
    expect(fetched.body).toMatchObject({ operation: 'fetch', remote: 'origin' });
    expect(fetched.body.status.branch).toMatchObject({ ahead: 2, behind: 1 });
    expect(await branchOf(fixture)).toMatchObject({ ahead: 2, behind: 1 });
    const status = (await owner.get<Json>(`${fixture.api}/status`)).body;
    expect(status).toMatchObject({ remotes: ['origin'], defaultRemote: 'origin' });
  });

  it('PJ-064: a push sends the local commits — afterwards the remote’s branch is the local one and nothing is ahead', async () => {
    const fixture = await withRemote();
    const mine = await localCommit(fixture, 'mine.txt', 'mine\n', 'my commit');
    expect(remoteHead(fixture)).not.toBe(mine);
    const pushed = await owner.post<Json>(`${fixture.api}/push`, {});
    expect(pushed.status).toBeLessThan(300);
    expect(pushed.body).toMatchObject({ operation: 'push', remote: 'origin', branch: 'main' });
    expect(remoteHead(fixture)).toBe(mine);
    expect(await branchOf(fixture)).toMatchObject({ ahead: 0, behind: 0 });
    // The colleague receives it.
    git(fixture.colleague, 'pull', '-q');
    expect(readFileSync(path.join(fixture.colleague, 'mine.txt'), 'utf8')).toBe('mine\n');
  });

  it('PJ-064: a pull brings the remote’s commits in when the local branch has none of its own', async () => {
    const fixture = await withRemote();
    const theirs = await colleaguePushes(
      fixture,
      'theirs.txt',
      'from the colleague\n',
      'colleague commit',
    );
    const pulled = await owner.post<Json>(`${fixture.api}/pull`, {});
    expect(pulled.status).toBeLessThan(300);
    expect(pulled.body.operation).toBe('pull');
    expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(theirs);
    expect(readFileSync(path.join(fixture.root, 'theirs.txt'), 'utf8')).toBe(
      'from the colleague\n',
    );
    expect(await branchOf(fixture)).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('AT-PJ-097: a branch without an upstream can only be published; publishing creates it on the remote and sets the upstream', async () => {
    const fixture = await withRemote();
    git(fixture.root, 'checkout', '-q', '-b', 'feature/new-thing');
    const mine = await localCommit(fixture, 'feature.txt', 'feature\n', 'feature work');
    expect(await branchOf(fixture)).toMatchObject({
      name: 'feature/new-thing',
      upstream: null,
      ahead: null,
      behind: null,
    });
    refusal(await owner.post(`${fixture.api}/push`, {}), 'git_no_upstream');
    refusal(await owner.post(`${fixture.api}/pull`, {}), 'git_no_upstream');
    expect(git(fixture.bare, 'branch', '--format=%(refname:short)')).toBe('main');

    const published = await owner.post<Json>(`${fixture.api}/push`, { publish: true });
    expect(published.status).toBeLessThan(300);
    expect(remoteHead(fixture, 'feature/new-thing')).toBe(mine);
    expect(await branchOf(fixture)).toMatchObject({
      upstream: 'origin/feature/new-thing',
      ahead: 0,
      behind: 0,
    });
    expect(git(fixture.root, 'rev-parse', '--abbrev-ref', 'feature/new-thing@{upstream}')).toBe(
      'origin/feature/new-thing',
    );
  });

  it('AT-PJ-098: a push the remote rejects because it is not a fast-forward is reported as a rejected push — and the remote is unchanged', async () => {
    const fixture = await withRemote();
    const theirs = await colleaguePushes(
      fixture,
      'theirs.txt',
      'theirs\n',
      'colleague got there first',
    );
    await localCommit(fixture, 'mine.txt', 'mine\n', 'my commit');
    const rejected = await owner.post<ErrorBody>(`${fixture.api}/push`, {});
    expect(rejected.status).toBe(409);
    refusal(rejected, 'git_push_rejected');
    expect(rejected.body.error.message.toLowerCase()).toMatch(/reject|pull|behind|remote has/);
    expect(remoteHead(fixture)).toBe(theirs);
    // A push rule planted in the repository's configuration cannot turn it into a forced push.
    git(fixture.root, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
    git(fixture.root, 'config', 'push.default', 'matching');
    refusal(await owner.post(`${fixture.api}/push`, {}), 'git_push_rejected');
    expect(remoteHead(fixture)).toBe(theirs);
  });

  it('AT-PJ-099: a pull that cannot fast-forward says the branches have diverged; a merge that would conflict names the conflict and leaves a clean tree with no merge in progress', async () => {
    const fixture = await withRemote();
    await colleaguePushes(
      fixture,
      'shared.txt',
      'line one, changed by the colleague\n',
      'colleague edits the line',
    );
    const mine = await localCommit(
      fixture,
      'shared.txt',
      'line one, changed by me\n',
      'I edit the same line',
    );

    const diverged = await owner.post<ErrorBody>(`${fixture.api}/pull`, {});
    expect(diverged.status).toBe(409);
    refusal(diverged, 'git_diverged');
    expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(mine);

    const conflict = await owner.post<ErrorBody>(`${fixture.api}/pull`, { mode: 'merge' });
    expect(conflict.status).toBe(409);
    refusal(conflict, 'git_conflict');
    expect(conflict.body.error.message.toLowerCase()).toContain('conflict');
    expect(git(fixture.root, 'rev-parse', 'HEAD')).toBe(mine);
    expect(git(fixture.root, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(fixture.root, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(path.join(fixture.root, 'shared.txt'), 'utf8')).toBe(
      'line one, changed by me\n',
    );
    expect((await owner.get<Json>(`${fixture.api}/status`)).body.operation).toBeNull();
  });

  it('PJ-064: a pull in merge mode joins histories that do not conflict', async () => {
    const fixture = await withRemote();
    const theirs = await colleaguePushes(fixture, 'theirs.txt', 'theirs\n', 'colleague commit');
    const mine = await localCommit(fixture, 'mine.txt', 'mine\n', 'my commit');
    const merged = await owner.post<Json>(`${fixture.api}/pull`, { mode: 'merge' });
    expect(merged.status).toBeLessThan(300);
    expect(
      git(fixture.root, 'rev-list', '--parents', '-1', 'HEAD').split(' ').slice(1).sort(),
    ).toEqual([mine, theirs].sort());
    expect(existsSync(path.join(fixture.root, 'theirs.txt'))).toBe(true);
    expect(await branchOf(fixture)).toMatchObject({ ahead: 2, behind: 0 });
  });

  it('AT-PJ-099: an unreachable remote is a remote error with a reason — promptly, never a hang, and never a 401 that would sign the user out', async () => {
    const fixture = await withRemote();
    git(
      fixture.root,
      'remote',
      'set-url',
      'origin',
      path.join(studio.workspace, 'remotes', 'moved-away.git'),
    );
    for (const operation of ['fetch', 'pull', 'push']) {
      await localCommit(fixture, `${operation}.txt`, 'x\n', `before ${operation}`);
      const failed = await within(
        owner.post<ErrorBody>(`${fixture.api}/${operation}`, {}),
        20_000,
        `${operation} against a remote that is gone`,
      );
      expect(failed.status, operation).toBe(502);
      refusal(failed, ['git_remote_not_found', 'git_network']);
    }
    expect((await owner.get('/api/auth/state')).status).toBe(200);
  });

  it('AT-PJ-100: without a remote there is nothing to fetch, pull or push, and each says so', async () => {
    const project = await createProject(studio, owner, 'no-remote');
    initRepository(project.rootDir);
    await writeFile(path.join(project.rootDir, 'a.txt'), 'a\n');
    commitAll(project.rootDir, 'only commit');
    const api = `/api/projects/${project.id}/git`;
    expect((await owner.get<Json>(`${api}/status`)).body).toMatchObject({
      remotes: [],
      defaultRemote: null,
    });
    refusal(await owner.post(`${api}/fetch`, {}), 'git_no_remote');
    // Pull and push have nothing to follow either (the status above is what tells a client not to offer them).
    refusal(await owner.post(`${api}/pull`, {}), ['git_no_remote', 'git_no_upstream']);
    refusal(await owner.post(`${api}/push`, {}), ['git_no_remote', 'git_no_upstream']);
    refusal(await owner.post(`${api}/push`, { publish: true }), 'git_no_remote');
    refusal(await owner.post(`${api}/fetch`, { remote: 'upstream' }), [
      'git_no_remote',
      'git_invalid_remote',
    ]);
  });

  it('AT-PJ-020 (adapted): a remote whose address would run a program instead of contacting a repository is never used — even when the repository’s configuration says such addresses are allowed', async () => {
    const fixture = await withRemote();
    const marker = path.join(fixture.root, 'RAN');
    git(fixture.root, 'config', 'protocol.ext.allow', 'always');
    git(fixture.root, 'remote', 'set-url', 'origin', `ext::touch ${marker}`);
    // Control: plain git, with this configuration, does run the program.
    tryGit(fixture.root, 'ls-remote', 'origin');
    expect(
      existsSync(marker),
      'the fixture is live: plain git runs the program named by the address',
    ).toBe(true);
    await rm(marker);

    for (const operation of ['fetch', 'pull', 'push']) {
      const response = await within(
        owner.post<ErrorBody>(
          `${fixture.api}/${operation}`,
          operation === 'push' ? { publish: true } : {},
        ),
        20_000,
        operation,
      );
      expect(response.status, operation).toBeGreaterThanOrEqual(400);
      expect(response.body.error.message.length).toBeGreaterThan(10);
    }
    expect((await owner.get(`${fixture.api}/status`)).status).toBe(200);
    expect((await owner.get(`${fixture.api}/branches`)).status).toBe(200);
    expect(existsSync(marker), 'the product ran a program named by a remote address').toBe(false);
  });
});
