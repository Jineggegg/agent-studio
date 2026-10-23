import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MiniApp, Project } from '@agent-studio/protocol';
import { miniAppProposalsSchema } from '@agent-studio/protocol';
import { modules } from '../../src/modules/index.js';
import { createMiniAppsModule } from '../../src/modules/mini-apps/mini-apps.module.js';
import { createTestStudio, type TestStudio } from '../../src/testing/harness.js';
const studios: TestStudio[] = [];
afterEach(async () => {
  for (const t of studios.splice(0)) await t.close();
  vi.restoreAllMocks();
});
async function start() {
  const t = await createTestStudio({
    modules: [...modules.filter((m) => m.name !== 'mini-apps'), createMiniAppsModule()],
  });
  studios.push(t);
  const owner = await t.owner();
  const project = (
    await owner.post<Project>('/api/projects', {
      name: 'Synthetic apps',
      rootDir: path.join(t.workspace, 'project'),
      createDirectory: true,
    })
  ).body;
  const url = `/api/projects/${project.id}/mini-apps`;
  const input = {
    name: 'Counter',
    directory: 'counter',
    outputDirectory: '.',
    build: { kind: 'none' },
    html: '<!doctype html><script>window.appLoaded=true</script><h1>Synthetic app</h1>',
  };
  return { t, owner, project, url, input };
}
async function idle(t: TestStudio, id: string) {
  await vi.waitFor(() => {
    const row = t.studio.context.db.get<{ state: string }>(
      'SELECT state FROM mini_apps WHERE id = ?',
      id,
    );
    expect(row?.state).not.toBe('building');
  });
}
describe('isolated static mini apps', () => {
  it('pins human-reviewed configuration for direct builds and agent proposals across edits and artifact publications', async () => {
    const { t, owner, project, url, input } = await start();
    const app = (await owner.post<MiniApp>(url, input)).body;
    expect(app).toMatchObject({ configRevision: 1, version: 0 });
    const tool = {
      userId: owner.userId!,
      projectId: project.id,
      sessionId: 'fake-session',
      runId: 'fake-run',
      agentId: 'scripted',
    };
    const proposalsUrl = `/api/projects/${project.id}/mini-app-proposals`;
    const propose = () =>
      t.studio.context.agentTools.call('mini_app_propose', tool, {
        operation: 'build',
        appId: app.id,
      });
    const proposals = async () =>
      miniAppProposalsSchema.parse((await owner.get(proposalsUrl)).body).proposals;
    expect((await propose()).isError).toBeUndefined();
    const reviewed = (await proposals())[0]!;
    const original = {
      name: app.name,
      directory: app.directory,
      outputDirectory: app.outputDirectory,
      build: app.build,
    };
    expect(reviewed.proposal).toEqual({
      operation: 'build',
      appId: app.id,
      configRevision: app.configRevision,
      config: original,
    });
    const run = vi.spyOn(t.studio.context.processes, 'run');
    const changed = (
      await owner.put<MiniApp>(`${url}/${app.id}`, {
        ...original,
        directory: 'other-app',
        outputDirectory: 'dist',
        build: { kind: 'npm', script: 'other-build', args: ['--changed'] },
      })
    ).body;
    expect(changed).toMatchObject({ configRevision: 2, version: 0 });
    const direct = await owner.post(`${url}/${app.id}/build`, {
      confirmed: true,
      configRevision: app.configRevision,
    });
    expect(direct).toMatchObject({ status: 409, body: { error: { code: 'app_config_changed' } } });
    expect((await owner.post(`${url}/${app.id}/build`, { confirmed: true })).status).toBe(400);
    const approvalUrl = `${proposalsUrl}/${reviewed.id}/approve`;
    expect(await owner.post(approvalUrl, { confirmed: true })).toMatchObject({
      status: 409,
      body: { error: { code: 'app_config_changed' } },
    });
    expect((await proposals())[0]!.proposal).toEqual(reviewed.proposal);
    expect(run).not.toHaveBeenCalled();

    // Restoring identical settings must not resurrect an earlier approval (ABA).
    const restored = (await owner.put<MiniApp>(`${url}/${app.id}`, original)).body;
    expect(restored).toMatchObject({ configRevision: 3, version: 0 });
    expect((await owner.post(approvalUrl, { confirmed: true })).status).toBe(409);
    expect(
      (
        await owner.post(`${url}/${app.id}/build`, {
          confirmed: true,
          configRevision: app.configRevision,
        })
      ).status,
    ).toBe(409);
    expect(run).not.toHaveBeenCalled();

    // Artifact publication does not change the separately reviewed configuration.
    expect((await propose()).isError).toBeUndefined();
    const fresh = (await proposals()).find((p) => p.id !== reviewed.id)!;
    expect(
      (
        await owner.post(`${url}/${app.id}/build`, {
          confirmed: true,
          configRevision: restored.configRevision,
        })
      ).status,
    ).toBe(202);
    await idle(t, app.id);
    expect(
      (await owner.post(`${proposalsUrl}/${fresh.id}/approve`, { confirmed: true })).status,
    ).toBe(200);
    await idle(t, app.id);
    const result = (await owner.get<{ apps: MiniApp[] }>(url)).body.apps[0]!;
    expect(result).toMatchObject({ state: 'ready', configRevision: 3, version: 2 });
  });
  it('scaffolds explicitly, publishes immutable assets, and applies sandbox CSP even to direct navigation', async () => {
    const { t, owner, project, url, input } = await start();
    expect((await t.anonymous().get(url)).status).toBe(401);
    const app = (await owner.post<MiniApp>(url, input)).body;
    expect(await readFile(path.join(project.rootDir, 'counter/index.html'), 'utf8')).toBe(
      input.html,
    );
    await writeFile(
      path.join(project.rootDir, 'counter/icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>document.cookie</script></svg>',
    );
    expect((await owner.post(`${url}/${app.id}/preview`, {})).status).toBe(409);
    expect((await owner.post(`${url}/${app.id}/build`, { confirmed: false })).status).toBe(400);
    expect(
      (
        await owner.post(`${url}/${app.id}/build`, {
          confirmed: true,
          configRevision: app.configRevision,
        })
      ).status,
    ).toBe(202);
    await idle(t, app.id);
    const grant = (await owner.post<{ url: string }>(`${url}/${app.id}/preview`, {})).body;
    const html = await owner.get(grant.url);
    expect(html.status).toBe(200);
    expect(html.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(html.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(html.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(html.headers['access-control-allow-origin']).toBe('*');
    expect(html.headers['set-cookie']).toBeUndefined();
    // Capability assets also load without browser credentials, as opaque-origin ES modules require.
    expect((await t.anonymous().get(grant.url)).status).toBe(200);
    const svg = await t.anonymous().get(grant.url.replace('index.html', 'icon.svg'));
    expect(svg.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    await writeFile(
      path.join(project.rootDir, 'counter/index.html'),
      '<h1>Changed afterwards</h1>',
    );
    expect((await owner.get(grant.url)).body).toBe(input.html);
    expect((await owner.get(grant.url.replace('index.html', '%2e%2e/secrets'))).status).toBe(404);
  });
  it('isolates project access, revokes preview after membership removal, and rechecks every request', async () => {
    const { t, owner, project, url, input } = await start();
    const app = (await owner.post<MiniApp>(url, input)).body;
    await owner.post(`${url}/${app.id}/build`, {
      confirmed: true,
      configRevision: app.configRevision,
    });
    await idle(t, app.id);
    const member = await t.member();
    expect((await member.get(url)).status).toBe(404);
    await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'read' });
    expect(
      (
        await member.post(`${url}/${app.id}/build`, {
          confirmed: true,
          configRevision: app.configRevision,
        })
      ).status,
    ).toBe(403);
    const grant = (await member.post<{ url: string }>(`${url}/${app.id}/preview`, {})).body;
    expect((await member.get(grant.url)).status).toBe(200);
    expect((await owner.get(grant.url)).status).toBe(404);
    await owner.delete(`/api/projects/${project.id}/members/${member.userId}`);
    expect((await member.get(grant.url)).status).toBe(404);
    expect((await t.anonymous().get(grant.url)).status).toBe(404);
  });
  it('refuses filesystem escapes and refuses builds without an actual sandbox', async () => {
    const { t, owner, project, url, input } = await start();
    expect((await owner.post(url, { ...input, directory: '../outside' })).status).toBe(400);
    const app = (await owner.post<MiniApp>(url, input)).body;
    const outside = path.join(t.workspace, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.js'), 'do not publish');
    await symlink(path.join(outside, 'secret.js'), path.join(project.rootDir, 'counter/leak.js'));
    await owner.post(`${url}/${app.id}/build`, {
      confirmed: true,
      configRevision: app.configRevision,
    });
    await idle(t, app.id);
    expect(
      t.studio.context.db.get<{ state: string }>('SELECT state FROM mini_apps WHERE id = ?', app.id)
        ?.state,
    ).toBe('failed');
    expect(
      t.studio.context.db.all('SELECT * FROM mini_app_assets WHERE app_id = ?', app.id),
    ).toEqual([]);
    const updated = (
      await owner.put<MiniApp>(`${url}/${app.id}`, {
        ...input,
        html: undefined,
        build: { kind: 'npm', script: 'build', args: [] },
      })
    ).body;
    const run = vi.spyOn(t.studio.context.processes, 'run');
    expect(
      (
        await owner.post(`${url}/${app.id}/build`, {
          confirmed: true,
          configRevision: updated.configRevision,
        })
      ).status,
    ).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
  it('wraps argv and scrubs environment, supports cancellation, and never starts agent proposals silently', async () => {
    const { t, owner, project, url, input } = await start();
    const app = (
      await owner.post<MiniApp>(url, {
        ...input,
        build: { kind: 'node', script: 'build.mjs', args: ['literal;not-a-shell'] },
      })
    ).body;
    await writeFile(path.join(project.rootDir, 'counter/build.mjs'), '');
    Object.defineProperty(t.studio.context.sandbox, 'status', {
      value: { mode: 'bwrap' },
      configurable: true,
    });
    const wrap = vi
      .spyOn(t.studio.context.sandbox, 'wrap')
      .mockImplementation((file, args) => ({ file, args: [...args], sandboxed: true }));
    const runner = vi.spyOn(t.studio.context.processes, 'run').mockImplementation(
      async (_file, _args, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () =>
            resolve({
              code: null,
              signal: 'SIGTERM',
              stdout: 'Synthetic cancelled build',
              stderr: '',
              timedOut: false,
              truncated: false,
            }),
          );
        }),
    );
    const tool = {
      userId: owner.userId!,
      projectId: project.id,
      sessionId: 'fake-session',
      runId: 'fake-run',
      agentId: 'scripted',
    };
    const proposal = await t.studio.context.agentTools.call('mini_app_propose', tool, {
      operation: 'build',
      appId: app.id,
    });
    expect(proposal.isError).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
    expect(
      (
        await owner.post(`${url}/${app.id}/build`, {
          confirmed: true,
          configRevision: app.configRevision,
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    expect(wrap.mock.calls[0]?.[2]).toMatchObject({ kind: 'isolate', network: false });
    expect(runner.mock.calls[0]?.[1]).toEqual([
      path.join(project.rootDir, 'counter/build.mjs'),
      'literal;not-a-shell',
    ]);
    const env = runner.mock.calls[0]?.[2]?.env;
    expect(Object.keys(env ?? {}).sort()).toEqual(
      [
        'HOME',
        'LANG',
        'PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'npm_config_audit',
        'npm_config_cache',
        'npm_config_fund',
        'npm_config_offline',
      ].sort(),
    );
    await owner.post(`${url}/${app.id}/cancel`, { confirmed: true });
    await idle(t, app.id);
    expect(
      t.studio.context.db.get<{ state: string }>('SELECT state FROM mini_apps WHERE id = ?', app.id)
        ?.state,
    ).toBe('cancelled');
  });
});
