import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CloneJob, Project } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { createGitSandbox, type GitSandbox } from '../../src/modules/git/testing/fixtures.js';
import { TEST_PASSWORD, createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

let sandbox: GitSandbox;
let t: TestStudio;
let owner: TestClient;
let source: string;

beforeEach(async () => {
  sandbox = await createGitSandbox();
  await sandbox.fakeSsh();
  t = await createTestStudio();
  owner = await t.owner();
  // A repository "on a server": reached only through the stand-in ssh.
  const seed = path.join(sandbox.dir, 'seed');
  await sandbox.repo(seed, { 'README.md': '# sample\n', 'src/index.js': 'console.log(1)\n' });
  source = await sandbox.bare('sample.git');
  await sandbox.git(seed, 'push', '--quiet', source, 'main');
});
afterEach(async () => {
  await t.close();
  await sandbox.restore();
});

const errorOf = (response: { status: number; body: unknown }): [number, string | undefined] => [response.status, (response.body as { error?: { code?: string } } | undefined)?.error?.code];
const address = () => `git@example.test:${source}`;

async function settled(id: string, client: TestClient = owner): Promise<CloneJob> {
  for (let i = 0; i < 200; i += 1) {
    const response = await client.get<CloneJob>(`/api/projects/clone/${id}`);
    expect(response.status).toBe(200);
    if (response.body.state !== 'running') return response.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The clone did not settle.');
}

describe('creating a project by cloning', () => {
  it('clones into a new folder of the workspace, reports progress on the user’s topic, and registers the project', async () => {
    const events: StudioEvent[] = [];
    t.studio.context.bus.onTopic(`user:${owner.userId}`, (event) => events.push(event));

    const started = await owner.post<CloneJob>('/api/projects/clone', { url: address() });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body).toMatchObject({ state: 'running', url: address(), targetDir: path.join(t.workspace, 'sample'), project: null, error: null });

    const done = await settled(started.body.id);
    expect(done).toMatchObject({ state: 'done', percent: 100, error: null });
    expect(done.project).toMatchObject({ name: 'sample', rootDir: path.join(t.workspace, 'sample') });
    expect(await readFile(path.join(t.workspace, 'sample/src/index.js'), 'utf8')).toBe('console.log(1)\n');
    expect((await owner.get<{ projects: Project[] }>('/api/projects')).body.projects.map((project) => project.name)).toEqual(['sample']);

    const updates = events.filter((event) => event.type === 'project.clone.updated').map((event) => event.data as CloneJob);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]).toMatchObject({ id: started.body.id, state: 'running' });
    expect(updates[updates.length - 1]).toMatchObject({ state: 'done', project: { id: done.project!.id } });
    // The clone went through ssh, to the host in the address, asking for exactly that repository.
    expect(await sandbox.sshCalls()).toEqual([expect.stringContaining(`git@example.test git-upload-pack '${source}'`)]);
    // Git's own settings of the new repository hold the address and nothing the server added.
    expect((await sandbox.git(done.project!.rootDir, 'config', '--get', 'remote.origin.url')).trim()).toBe(address());
    expect((await sandbox.tryGit(done.project!.rootDir, 'config', '--local', '--get', 'core.hooksPath')).code).not.toBe(0);
  });

  it('honours a chosen parent folder, folder name and project name, and accepts the ssh:// form', async () => {
    const started = await owner.post<CloneJob>('/api/projects/clone', {
      url: `ssh://git@example.test${source}`,
      parentDir: path.join(t.workspace, 'clients/acme'),
      directoryName: 'website',
      name: 'Acme website',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const done = await settled(started.body.id);
    expect(done.project).toMatchObject({ name: 'Acme website', rootDir: path.join(t.workspace, 'clients/acme/website') });
    expect(existsSync(path.join(t.workspace, 'clients/acme/website/README.md'))).toBe(true);
  });

  it.each([
    'ext::sh -c touch% PWNED',
    'file:///etc',
    '/etc',
    '../../somewhere',
    'git://example.test/repo.git',
    'http://example.test/repo.git',
    '--upload-pack=touch PWNED',
    '-oProxyCommand=touch PWNED',
    'ssh://-oProxyCommand=touch PWNED/x',
    'git@-oProxyCommand=x:repo.git',
    'git@example.test:--upload-pack=x',
    'https://example.test/repo.git --upload-pack=x',
    'https://example.test/repo.git\n--upload-pack=x',
    'fd::3',
    'not a url',
  ])('refuses the address %j before anything starts', async (url) => {
    const response = await owner.post('/api/projects/clone', { url });
    expect(errorOf(response)).toEqual([400, 'invalid_repository_url']);
    expect(await readdir(t.workspace)).toEqual([]);
    expect(await sandbox.sshCalls()).toEqual([]);
    for (const place of [t.workspace, path.dirname(t.workspace), sandbox.dir, process.cwd()]) expect(existsSync(path.join(place, 'PWNED')), place).toBe(false);
  });

  it('refuses credentials in the address without repeating them', async () => {
    for (const url of ['https://deploy:hunter2secret@example.test/team/repo.git', 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/team/repo.git']) {
      const response = await owner.post('/api/projects/clone', { url });
      expect(errorOf(response)).toEqual([400, 'invalid_repository_url']);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('hunter2secret');
      expect(text).not.toContain('ghp_');
      expect(text).toMatch(/Sign git in on the server/);
    }
    expect(await readdir(t.workspace)).toEqual([]);
  });

  it('never clones into a folder that exists, nor outside the workspace', async () => {
    await mkdir(path.join(t.workspace, 'sample'));
    await writeFile(path.join(t.workspace, 'sample/keep.txt'), 'mine\n');
    expect(errorOf(await owner.post('/api/projects/clone', { url: address() }))).toEqual([409, 'target_exists']);
    expect(await readdir(path.join(t.workspace, 'sample'))).toEqual(['keep.txt']);
    await mkdir(path.join(t.workspace, 'empty'));
    expect(errorOf(await owner.post('/api/projects/clone', { url: address(), directoryName: 'empty' }))).toEqual([409, 'target_exists']);

    const outside = path.join(path.dirname(t.workspace), 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(t.workspace, 'escape'));
    for (const parentDir of [outside, '/etc', '/', path.join(t.workspace, 'escape'), path.join(t.workspace, '..', 'outside')]) {
      const response = await owner.post('/api/projects/clone', { url: address(), parentDir });
      expect(response.status, parentDir).toBe(403);
    }
    expect((await owner.post('/api/projects/clone', { url: address(), parentDir: 'relative' })).status).toBe(400);
    for (const directoryName of ['../up', 'a/b', '.git', '-rf', '..', 'with space', '']) {
      expect(errorOf(await owner.post('/api/projects/clone', { url: address(), directoryName })), JSON.stringify(directoryName)).toEqual([400, 'invalid_directory_name']);
    }
    expect(await readdir(outside)).toEqual([]);
    expect(await sandbox.sshCalls()).toEqual([]);
  });

  it('leaves nothing behind when the clone fails, and says why', async () => {
    await sandbox.sshMode('deny');
    const denied = await settled((await owner.post<CloneJob>('/api/projects/clone', { url: address() })).body.id);
    expect(denied).toMatchObject({ state: 'failed', project: null, error: { code: 'git_auth_failed' } });
    expect(existsSync(path.join(t.workspace, 'sample'))).toBe(false);

    await sandbox.sshMode('ok');
    const missing = await settled((await owner.post<CloneJob>('/api/projects/clone', { url: `git@example.test:${source}-nope`, directoryName: 'nope' })).body.id);
    expect(missing).toMatchObject({ state: 'failed', error: { code: 'git_remote_not_found' } });

    const unreachable = await settled((await owner.post<CloneJob>('/api/projects/clone', { url: 'https://127.0.0.1:1/team/repo.git' })).body.id);
    expect(unreachable).toMatchObject({ state: 'failed', error: { code: 'git_network' } });

    expect(await readdir(t.workspace)).toEqual([]);
    expect((await owner.get<{ projects: Project[] }>('/api/projects')).body.projects).toEqual([]);
  });

  it('stops a clone that takes too long, and one that is cancelled, removing the partial folder', async () => {
    await sandbox.sshMode('hang');
    t.studio.context.services.git.exec.timeouts.clone = 800;
    const slow = await owner.post<CloneJob>('/api/projects/clone', { url: address(), directoryName: 'slow' });
    expect(existsSync(path.join(t.workspace, 'slow'))).toBe(true);
    const timedOut = await settled(slow.body.id);
    expect(timedOut).toMatchObject({ state: 'failed', error: { code: 'git_timeout' } });
    expect(existsSync(path.join(t.workspace, 'slow'))).toBe(false);

    t.studio.context.services.git.exec.timeouts.clone = 60_000;
    const running = await owner.post<CloneJob>('/api/projects/clone', { url: address(), directoryName: 'cancelled' });
    expect((await owner.delete(`/api/projects/clone/${running.body.id}`)).status).toBe(200);
    const cancelled = await settled(running.body.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', project: null, error: null });
    expect(existsSync(path.join(t.workspace, 'cancelled'))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t.studio.context.processes.running).toBe(0);
  });

  it('runs only a couple of clones at a time', async () => {
    await sandbox.sshMode('hang');
    const first = await owner.post<CloneJob>('/api/projects/clone', { url: address(), directoryName: 'one' });
    const second = await owner.post<CloneJob>('/api/projects/clone', { url: address(), directoryName: 'two' });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(errorOf(await owner.post('/api/projects/clone', { url: address(), directoryName: 'three' }))).toEqual([503, 'git_busy']);
    expect(existsSync(path.join(t.workspace, 'three'))).toBe(false);
    for (const job of [first, second]) await owner.delete(`/api/projects/clone/${job.body.id}`);
    for (const job of [first, second]) await settled(job.body.id);
  });

  it('is the owner’s alone, and a job is visible only to who started it', async () => {
    const member = await t.member('alice');
    expect(errorOf(await member.post('/api/projects/clone', { url: address() }))).toEqual([403, 'owner_required']);
    expect((await t.anonymous().post('/api/projects/clone', { url: address() })).status).toBe(401);
    expect(await readdir(t.workspace)).toEqual([]);

    const started = await owner.post<CloneJob>('/api/projects/clone', { url: address() });
    expect((await member.get(`/api/projects/clone/${started.body.id}`)).status).toBe(403);
    expect((await member.delete(`/api/projects/clone/${started.body.id}`)).status).toBe(403);
    expect((await t.anonymous().get(`/api/projects/clone/${started.body.id}`)).status).toBe(401);
    expect(errorOf(await owner.get('/api/projects/clone/00000000000000000000000000'))).toEqual([404, 'clone_not_found']);
    // Even a second owner cannot watch or cancel it: to them it does not exist.
    expect((await owner.post('/api/users', { username: 'second-owner', password: TEST_PASSWORD, role: 'owner' })).status).toBe(201);
    const secondOwner = await t.signIn('second-owner');
    expect(errorOf(await secondOwner.get(`/api/projects/clone/${started.body.id}`))).toEqual([404, 'clone_not_found']);
    expect(errorOf(await secondOwner.delete(`/api/projects/clone/${started.body.id}`))).toEqual([404, 'clone_not_found']);
    expect((await settled(started.body.id)).state).toBe('done');
  });
});
