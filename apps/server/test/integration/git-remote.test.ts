import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { GitBranches, GitStatus, GitSyncResult, Project } from '@agent-studio/protocol';
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
  remote: string;
  url: (suffix: string) => string;
  git: (...args: string[]) => Promise<string>;
}

/** A project with one commit, an `origin` (a bare repository next door) and `main` published to it. */
async function repoWithRemote(name = 'demo', remoteUrl?: (bare: string) => string): Promise<Repo> {
  const dir = path.join(t.workspace, name);
  const remote = await sandbox.bare(`${name}-remote.git`);
  await sandbox.repo(dir, { 'README.md': '# demo\n', 'shared.txt': 'base\n' });
  await sandbox.git(dir, 'remote', 'add', 'origin', remote);
  await sandbox.git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  if (remoteUrl) await sandbox.git(dir, 'remote', 'set-url', 'origin', remoteUrl(remote));
  const response = await owner.post<Project>('/api/projects', { name, rootDir: dir });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const project = response.body;
  return { project, dir: project.rootDir, remote, url: (suffix) => `/api/projects/${project.id}/git/${suffix}`, git: (...args) => sandbox.git(project.rootDir, ...args) };
}

/** Someone else pushes a commit to the remote. */
async function pushFromElsewhere(r: Repo, file: string, content: string, branch = 'main'): Promise<string> {
  const other = path.join(sandbox.dir, `other-${Math.random().toString(36).slice(2)}`);
  await sandbox.git(sandbox.dir, 'clone', '--quiet', '--branch', branch, r.remote, other);
  await sandbox.write(other, { [file]: content });
  await sandbox.git(other, 'add', '--all');
  await sandbox.git(other, 'commit', '--quiet', '-m', `remote change to ${file}`);
  await sandbox.git(other, 'push', '--quiet', 'origin', branch);
  return (await sandbox.git(other, 'rev-parse', 'HEAD')).trim();
}

async function commitLocally(r: Repo, file: string, content: string): Promise<string> {
  await sandbox.write(r.dir, { [file]: content });
  await r.git('add', '--all');
  await r.git('commit', '--quiet', '-m', `local change to ${file}`);
  return (await r.git('rev-parse', 'HEAD')).trim();
}

const status = async (r: Repo) => (await owner.get<GitStatus>(r.url('status'))).body;
const errorOf = (response: { status: number; body: unknown }): [number, string | undefined] => [response.status, (response.body as { error?: { code?: string } } | undefined)?.error?.code];
const remoteHead = async (r: Repo, branch = 'main') => (await sandbox.git(r.remote, 'rev-parse', `refs/heads/${branch}`)).trim();

describe('ahead, behind and fetching', () => {
  it('counts against the upstream as of the last fetch', async () => {
    const r = await repoWithRemote();
    expect(await status(r)).toMatchObject({ remotes: ['origin'], defaultRemote: 'origin', branch: { name: 'main', upstream: 'origin/main', ahead: 0, behind: 0 } });

    await pushFromElsewhere(r, 'theirs.txt', 't\n');
    await commitLocally(r, 'mine-1.txt', '1\n');
    await commitLocally(r, 'mine-2.txt', '2\n');
    // Nothing fetched yet: the remote's new commit is not known here.
    expect((await status(r)).branch).toMatchObject({ ahead: 2, behind: 0 });

    const fetched = await owner.post<GitSyncResult>(r.url('fetch'));
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    expect(fetched.body).toMatchObject({ operation: 'fetch', remote: 'origin', branch: 'main' });
    expect(fetched.body.status.branch).toMatchObject({ ahead: 2, behind: 1 });
    expect((await status(r)).branch).toMatchObject({ ahead: 2, behind: 1 });
    // Naming the remote works too; naming one that does not exist does not.
    expect((await owner.post(r.url('fetch'), { remote: 'origin' })).status).toBe(200);
    expect(errorOf(await owner.post(r.url('fetch'), { remote: 'upstream' }))).toEqual([400, 'git_invalid_remote']);
  });

  it('lists remote branches, tracking and the default branch, and continues a remote branch locally', async () => {
    const r = await repoWithRemote();
    await r.git('switch', '--quiet', '-c', 'topic');
    await commitLocally(r, 'topic.txt', 't\n');
    await r.git('push', '--quiet', '-u', 'origin', 'topic');
    await r.git('switch', '--quiet', 'main');
    await r.git('branch', '--quiet', '-D', 'topic');
    await r.git('remote', 'set-head', 'origin', 'main');
    await commitLocally(r, 'ahead.txt', 'a\n');

    const listed = (await owner.get<GitBranches>(r.url('branches'))).body;
    expect(listed).toMatchObject({ current: 'main', defaultBranch: 'main' });
    expect(listed.branches.map((branch) => [branch.name, branch.kind, branch.remote])).toEqual([
      ['main', 'local', null],
      ['origin/main', 'remote', 'origin'],
      ['origin/topic', 'remote', 'origin'],
    ]);
    expect(listed.branches[0]).toMatchObject({ upstream: 'origin/main', upstreamGone: false, ahead: 1, behind: 0 });

    const switched = await owner.post(r.url('switch'), { branch: 'origin/topic', kind: 'remote' });
    expect(switched.body).toEqual({ branch: 'topic', current: 'topic' });
    expect((await status(r)).branch).toMatchObject({ name: 'topic', upstream: 'origin/topic', ahead: 0, behind: 0 });
    // Asked again, it simply switches to the local branch that now exists.
    await r.git('switch', '--quiet', 'main');
    expect((await owner.post(r.url('switch'), { branch: 'origin/topic', kind: 'remote' })).status).toBe(200);
    expect(errorOf(await owner.post(r.url('switch'), { branch: 'origin/nope', kind: 'remote' }))).toEqual([400, 'git_unknown_ref']);
    expect(errorOf(await owner.post(r.url('switch'), { branch: 'nowhere/topic', kind: 'remote' }))).toEqual([400, 'git_unknown_ref']);
  });

  it('has nothing to sync with when there is no remote', async () => {
    const dir = path.join(t.workspace, 'lonely');
    await sandbox.repo(dir);
    const project = (await owner.post<Project>('/api/projects', { name: 'lonely', rootDir: dir })).body;
    const url = (suffix: string) => `/api/projects/${project.id}/git/${suffix}`;
    expect((await owner.get<GitStatus>(url('status'))).body).toMatchObject({ remotes: [], defaultRemote: null });
    expect(errorOf(await owner.post(url('fetch')))).toEqual([409, 'git_no_remote']);
    // Pull and push say so directly, rather than advising to publish the branch first.
    expect(errorOf(await owner.post(url('pull')))).toEqual([409, 'git_no_remote']);
    expect(errorOf(await owner.post(url('pull'), { mode: 'merge' }))).toEqual([409, 'git_no_remote']);
    expect(errorOf(await owner.post(url('push')))).toEqual([409, 'git_no_remote']);
    expect(errorOf(await owner.post(url('push'), { publish: true }))).toEqual([409, 'git_no_remote']);
    // Whatever state the branch is in: with no branch checked out the answer is the same.
    await sandbox.git(project.rootDir, 'checkout', '--quiet', '--detach');
    expect(errorOf(await owner.post(url('pull')))).toEqual([409, 'git_no_remote']);
    expect(errorOf(await owner.post(url('push')))).toEqual([409, 'git_no_remote']);
  });
});

describe('pulling', () => {
  it('fast-forwards, and says so when there is nothing to do', async () => {
    const r = await repoWithRemote();
    expect((await owner.post<GitSyncResult>(r.url('pull'))).body.summary).toBe('Already up to date.');
    const theirs = await pushFromElsewhere(r, 'theirs.txt', 't\n');
    const pulled = await owner.post<GitSyncResult>(r.url('pull'));
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    expect(pulled.body.status.branch).toMatchObject({ ahead: 0, behind: 0 });
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(theirs);
    expect(existsSync(path.join(r.dir, 'theirs.txt'))).toBe(true);
  });

  it('reports divergence instead of merging behind the user’s back', async () => {
    const r = await repoWithRemote();
    await pushFromElsewhere(r, 'theirs.txt', 't\n');
    const mine = await commitLocally(r, 'mine.txt', 'm\n');

    const refused = await owner.post(r.url('pull'));
    expect(errorOf(refused)).toEqual([409, 'git_diverged']);
    expect((refused.body as { error: { details: unknown } }).error.details).toEqual({ ahead: 1, behind: 1 });
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(mine);
    expect(existsSync(path.join(r.dir, 'theirs.txt'))).toBe(false);

    // Asked explicitly, a clean merge is made — as a real merge commit by the caller.
    await owner.put('/api/git/identity', { name: 'Ada Lovelace', email: 'ada@example.org' });
    const merged = await owner.post<GitSyncResult>(r.url('pull'), { mode: 'merge' });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect((await r.git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')).toHaveLength(3);
    expect((await r.git('log', '-1', '--format=%cn')).trim()).toBe('Ada Lovelace');
    expect(existsSync(path.join(r.dir, 'theirs.txt'))).toBe(true);
    expect(merged.body.status.branch).toMatchObject({ ahead: 2, behind: 0 });
  });

  it('never leaves a half-finished merge behind when the changes conflict', async () => {
    const r = await repoWithRemote();
    await pushFromElsewhere(r, 'shared.txt', 'their version\n');
    const mine = await commitLocally(r, 'shared.txt', 'my version\n');

    expect(errorOf(await owner.post(r.url('pull')))).toEqual([409, 'git_diverged']);
    const conflict = await owner.post(r.url('pull'), { mode: 'merge' });
    expect(errorOf(conflict)).toEqual([409, 'git_conflict']);
    expect((conflict.body as { error: { details: { files: string[] } } }).error.details.files).toEqual(['shared.txt']);
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(mine);
    expect(existsSync(path.join(r.dir, '.git/MERGE_HEAD'))).toBe(false);
    expect((await r.git('status', '--porcelain')).trim()).toBe('');
    expect(await readFile(path.join(r.dir, 'shared.txt'), 'utf8')).toBe('my version\n');
    expect((await status(r)).operation).toBeNull();
  });

  it('does not overwrite uncommitted work that is in the way', async () => {
    const r = await repoWithRemote();
    await pushFromElsewhere(r, 'shared.txt', 'their version\n');
    const before = (await r.git('rev-parse', 'HEAD')).trim();
    await writeFile(path.join(r.dir, 'shared.txt'), 'precious uncommitted edit\n');

    const refused = await owner.post(r.url('pull'));
    expect(errorOf(refused)).toEqual([409, 'git_would_overwrite']);
    expect(await readFile(path.join(r.dir, 'shared.txt'), 'utf8')).toBe('precious uncommitted edit\n');
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(before);
  });

  it('needs a branch with an upstream', async () => {
    const r = await repoWithRemote();
    await r.git('switch', '--quiet', '-c', 'unpublished');
    expect(errorOf(await owner.post(r.url('pull')))).toEqual([409, 'git_no_upstream']);
    await r.git('checkout', '--quiet', '--detach');
    expect(errorOf(await owner.post(r.url('pull')))).toEqual([409, 'git_detached_head']);
    expect(errorOf(await owner.post(r.url('push')))).toEqual([409, 'git_detached_head']);
    expect(errorOf(await owner.post(r.url('pull'), { mode: 'rebase' }))).toEqual([400, 'invalid_request']);
    expect(errorOf(await owner.post(r.url('pull'), { mode: 'merge', force: true, rebase: 'yes' }))).toEqual([409, 'git_detached_head']);
  });
});

describe('pushing', () => {
  it('pushes what is ahead', async () => {
    const r = await repoWithRemote();
    const mine = await commitLocally(r, 'mine.txt', 'm\n');
    const pushed = await owner.post<GitSyncResult>(r.url('push'));
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body).toMatchObject({ operation: 'push', remote: 'origin', branch: 'main' });
    expect(pushed.body.status.branch).toMatchObject({ ahead: 0, behind: 0 });
    expect(await remoteHead(r)).toBe(mine);
  });

  it('reports a rejected push as rejected — and never forces it', async () => {
    const r = await repoWithRemote();
    const theirs = await pushFromElsewhere(r, 'theirs.txt', 't\n');
    await commitLocally(r, 'mine.txt', 'm\n');
    // Even a repository configured to force every push does not get a forced push from here.
    await r.git('config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
    await r.git('config', 'push.default', 'matching');

    const rejected = await owner.post(r.url('push'));
    expect(errorOf(rejected)).toEqual([409, 'git_push_rejected']);
    const error = (rejected.body as { error: { message: string; details: { output: string } } }).error;
    expect(error.message).toMatch(/rejected/i);
    expect(error.message).toMatch(/non-fast-forward/i);
    expect(error.details.output).toContain('[rejected]');
    // Advice lines — which suggest forcing — are not relayed.
    expect(error.details.output).not.toMatch(/hint:|--force/);
    expect(await remoteHead(r)).toBe(theirs);
    for (const extra of [{ force: true }, { forceWithLease: true }, { publish: true, force: true }]) {
      expect(errorOf(await owner.post(r.url('push'), extra)), JSON.stringify(extra)).toEqual([409, 'git_push_rejected']);
    }
    expect(await remoteHead(r)).toBe(theirs);
  });

  it('publishes a new branch only when asked, and remembers where it went', async () => {
    const r = await repoWithRemote();
    await r.git('switch', '--quiet', '-c', 'feature/new');
    const mine = await commitLocally(r, 'feature.txt', 'f\n');
    expect((await status(r)).branch).toMatchObject({ name: 'feature/new', upstream: null, ahead: null, behind: null });

    expect(errorOf(await owner.post(r.url('push')))).toEqual([409, 'git_no_upstream']);
    expect((await sandbox.tryGit(r.remote, 'rev-parse', '--verify', 'refs/heads/feature/new')).code).not.toBe(0);

    const published = await owner.post<GitSyncResult>(r.url('push'), { publish: true });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(await remoteHead(r, 'feature/new')).toBe(mine);
    expect(published.body.status.branch).toMatchObject({ upstream: 'origin/feature/new', ahead: 0, behind: 0 });
    // From now on an ordinary push and fetch work.
    await commitLocally(r, 'feature-2.txt', 'f\n');
    expect((await owner.post(r.url('push'))).status).toBe(200);
    expect((await owner.post(r.url('fetch'))).status).toBe(200);
  });

  it('will not undo a commit that has been pushed', async () => {
    const r = await repoWithRemote();
    const pushed = (await r.git('rev-parse', 'HEAD')).trim();
    const refused = await owner.post(r.url('undo-commit'));
    expect(errorOf(refused)).toEqual([409, 'git_commit_pushed']);
    expect((refused.body as { error: { message: string } }).error.message).toContain('origin/main');
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(pushed);
    // A commit made since is still local and can be undone.
    await commitLocally(r, 'local.txt', 'l\n');
    expect((await owner.post(r.url('undo-commit'))).status).toBe(200);
    expect((await r.git('rev-parse', 'HEAD')).trim()).toBe(pushed);
  });
});

describe('telling failures apart', () => {
  const ssh = (bare: string) => `git@example.test:${bare}`;

  it('goes through ssh without prompting, and maps a refused key and an unreachable host', async () => {
    await sandbox.fakeSsh();
    const r = await repoWithRemote('over-ssh', ssh);
    await pushFromElsewhere(r, 'theirs.txt', 't\n');
    expect((await owner.post(r.url('fetch'))).status).toBe(200);
    expect((await sandbox.sshCalls()).some((call) => call.includes('git-upload-pack'))).toBe(true);
    expect((await status(r)).branch).toMatchObject({ behind: 1 });

    await sandbox.sshMode('deny');
    for (const operation of ['fetch', 'pull', 'push']) {
      const denied = await owner.post(r.url(operation));
      expect(errorOf(denied), operation).toEqual([502, 'git_auth_failed']);
      expect((denied.body as { error: { details: { output: string } } }).error.details.output).toContain('Permission denied');
    }
    await sandbox.sshMode('refuse');
    const refused = await owner.post(r.url('fetch'));
    expect(errorOf(refused)).toEqual([502, 'git_network']);
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/could not be reached/);
  });

  it('stops a remote that does not answer, and says it timed out', async () => {
    await sandbox.fakeSsh();
    const r = await repoWithRemote('hanging', ssh);
    await commitLocally(r, 'mine.txt', 'm\n');
    await sandbox.sshMode('hang');
    t.studio.context.services.git.exec.timeouts.network = 1200;

    for (const operation of ['fetch', 'pull', 'push']) {
      const started = Date.now();
      const response = await owner.post(r.url(operation));
      const elapsed = Date.now() - started;
      expect(errorOf(response), operation).toEqual([504, 'git_timeout']);
      expect((response.body as { error: { message: string } }).error.message, operation).toMatch(/did not answer within 1 seconds/);
      expect(elapsed, operation).toBeLessThan(8000);
    }
    // The stuck git and its ssh are gone, not left running.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t.studio.context.processes.running).toBe(0);
    // And the repository is still usable afterwards.
    expect((await status(r)).state).toBe('ready');
  });

  it('says when the remote repository is not there, and never repeats credentials from an address', async () => {
    const gone = await repoWithRemote('gone', (bare) => `${bare}-does-not-exist`);
    expect(errorOf(await owner.post(gone.url('fetch')))).toEqual([502, 'git_remote_not_found']);

    const secret = await repoWithRemote('secret', () => 'https://deploy:hunter2secret@127.0.0.1:1/team/repo.git');
    const failed = await owner.post(secret.url('fetch'));
    expect(errorOf(failed)).toEqual([502, 'git_network']);
    const text = JSON.stringify(failed.body);
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain('deploy:');
    expect(text).toContain('127.0.0.1:1/team/repo.git');
  });

  it('fails at once instead of waiting for a password nobody can type', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await repoWithRemote('needs-login', () => `http://127.0.0.1:${port}/team/repo.git`);
      const started = Date.now();
      const response = await owner.post(r.url('fetch'));
      expect(errorOf(response)).toEqual([502, 'git_auth_failed']);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((response.body as { error: { message: string } }).error.message).toMatch(/refused the credentials/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('never runs a command through an ext:: remote, even when the repository allows it', async () => {
    const marker = path.join(sandbox.dir, 'ext-ran');
    const r = await repoWithRemote('ext', () => `ext::sh -c touch% ${marker}`);
    await r.git('config', 'protocol.ext.allow', 'always');
    const response = await owner.post(r.url('fetch'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    await owner.post(r.url('pull'));
    await owner.post(r.url('push'));
    expect(existsSync(marker)).toBe(false);
  });
});
