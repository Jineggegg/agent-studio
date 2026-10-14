import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawRequest } from './support/raw.js';
import { until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  createSession,
  decide,
  download,
  getRun,
  pendingApprovals,
  send,
  shareProject,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.13 — Plugins (requirements 02 §6.13 AT-PJ-199…201, §7.6).
 *
 * Deliberate differences this file is written for: a plugin's code runs in a
 * sandboxed process of its own with only the capabilities the owner granted,
 * and its interface in a frame that does not have the page's origin. Being
 * installed gives a plugin nothing: it stays off until the owner has seen
 * what it asks for and switched it on.
 *
 * The plugin installed here is the repository's own example, copied into a
 * throw-away source folder next to a deliberately broken one. The module's
 * suite has the hostile plugin and the real browser.
 */
const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plugins/examples/notes-counter',
);

describe('6.13 plugins', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let source: string;
  let project: Project;
  let runnable = true;
  let isolation = '';
  let networkContained = true;

  beforeAll(async () => {
    source = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-acceptance-plugins-'));
    await cp(EXAMPLE, path.join(source, 'notes-counter'), { recursive: true });
    await mkdir(path.join(source, 'broken'));
    await writeFile(
      path.join(source, 'broken', 'plugin.json'),
      '{ "manifestVersion": 1, "id": "Not A Valid Id", "name": "", "permissions": ["everything"] }',
    );
    await mkdir(path.join(source, 'no-manifest'));
    await writeFile(path.join(source, 'no-manifest', 'readme.txt'), 'not a plugin');
    await cp(EXAMPLE, path.join(source, 'wants-network'), { recursive: true });
    const manifest = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(path.join(source, 'wants-network', 'plugin.json'), 'utf8'),
    ) as Json;
    manifest.id = 'wants-network';
    manifest.name = 'Wants network';
    manifest.permissions = ['network:api.example.test', 'notifications'];
    await writeFile(
      path.join(source, 'wants-network', 'plugin.json'),
      JSON.stringify(manifest, null, 2),
    );

    studio = await startAgentStudio({ env: { AGENT_STUDIO_PLUGIN_SOURCE_DIR: source } });
    owner = await studio.owner();
    project = await createProject(studio, owner, 'with-plugins');
    const list = (await owner.get<Json>('/api/plugins')).body;
    isolation = list.isolation.level;
    runnable = isolation !== 'none';
    networkContained = list.isolation.restricts.network === true;
  });
  afterAll(async () => {
    await studio?.destroy();
    if (source) await rm(source, { recursive: true, force: true });
  });

  const plugin = async (id: string) => (await owner.get<Json>(`/api/plugins/${id}`)).body;
  const install = (name: string, client: ApiClient = owner) =>
    client.post<Json>('/api/plugins/install', { source: { kind: 'directory', name } });
  const contributions = async (client: ApiClient) =>
    (await client.get<Json>('/api/plugins/contributions')).body;
  const NO_ISOLATION =
    'skipped: this machine can isolate plugin code in no way, so a plugin with server code cannot be switched on';

  it('PJ-118: the owner sees what the operator’s source folder offers — a valid plugin with its name and version, and why the others are not plugins', async () => {
    const sources = (await owner.get<Json>('/api/plugins/sources')).body;
    expect(sources.configured).toBe(true);
    const byName = Object.fromEntries(
      (sources.entries as Json[]).map((entry) => [entry.name, entry]),
    );
    expect(byName['notes-counter']).toMatchObject({
      valid: true,
      problem: null,
      id: 'notes-counter',
      title: 'Notes counter',
      version: '1.0.0',
      installed: false,
    });
    expect(byName.broken.valid).toBe(false);
    expect(byName.broken.problem.length).toBeGreaterThan(5);
    expect(byName['no-manifest'].valid).toBe(false);
    expect((await owner.get<Json>('/api/plugins')).body).toMatchObject({
      plugins: [],
      sourceDirectoryConfigured: true,
    });
  });

  it('AT-PJ-199: installing something without a valid manifest fails with a sentence that names the manifest and leaves nothing installed; a name that is a path, or an address that is not plain https, is refused outright', async () => {
    for (const name of ['broken', 'no-manifest']) {
      const failed = await install(name);
      expect(failed.status, name).toBeGreaterThanOrEqual(400);
      expect(failed.status, name).toBeLessThan(500);
      expect(failed.body.error.message.toLowerCase(), name).toMatch(/manifest|plugin\.json/);
    }
    expect((await install('not-in-the-folder')).status).toBeGreaterThanOrEqual(400);
    for (const name of [
      '../notes-counter',
      '/etc',
      'notes-counter/../../etc',
      '.hidden',
      '-rf',
      '',
    ]) {
      expect((await install(name)).status, JSON.stringify(name)).toBe(400);
    }
    for (const url of [
      'git@github.com:someone/plugin.git',
      'ssh://git@example.test/plugin.git',
      'file:///etc',
      'http://example.test/plugin.git',
      '--upload-pack=touch pwned',
      'ext::sh -c id',
      'https://user:secret@example.test/plugin.git',
    ]) {
      const refused = await owner.post<ErrorBody>('/api/plugins/install', {
        source: { kind: 'git', url },
      });
      expect(refused.status, url).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain('secret');
    }
    expect(
      (
        await owner.post('/api/plugins/install', {
          source: { kind: 'directory', name: 'notes-counter' },
          enable: true,
        })
      ).status,
    ).toBe(400); // no shortcut to "installed and on"
    expect((await owner.get<Json>('/api/plugins')).body.plugins).toEqual([]);
  });

  it('AT-PJ-200 (adapted): an installed plugin is off and contributes nothing — no tile, no tab, no tool — until the owner switches it on having echoed exactly what it asked for; then its panel is offered to everyone and its tools to agents', async (context) => {
    const installed = await install('notes-counter');
    expect(installed.status, JSON.stringify(installed.body)).toBeLessThan(300);
    const record = await plugin('notes-counter');
    expect(record).toMatchObject({
      id: 'notes-counter',
      name: 'Notes counter',
      enabled: false,
      hasServer: true,
      source: { kind: 'directory', name: 'notes-counter' },
      permissions: { requested: [], granted: [] },
    });
    expect(record.approval).toMatchObject({ state: 'none', approvedAt: null, approvedBy: null });
    expect(
      record.contributes.tools.map((tool: Json) => `${tool.name}:${tool.declaredEffect}`),
    ).toEqual(['count_notes:read', 'add_note:write']);
    const member = await createMember(studio, owner, 'pluginuser');
    await shareProject(owner, project.id, member.userId!, 'write');
    for (const client of [owner, member])
      expect(await contributions(client)).toEqual({
        homeTiles: [],
        projectTabs: [],
        settingsPages: [],
        linkTiles: [],
      });
    const closed = await owner.post<ErrorBody>('/api/plugins/notes-counter/panels/notes/open', {
      slot: 'home-tile',
    });
    expect(closed.status).toBeGreaterThanOrEqual(400);
    // An agent run has no such tool while the plugin is off.
    const tool = record.contributes.tools[0].registeredName as string;
    const session = await createSession(owner, project.id);
    const before = await send(owner, session.id, `count them [[scenario:studio-tool ${tool} {}]]`);
    await until(async () =>
      ['completed', 'failed'].includes((await getRun(owner, before.runId!)).status)
        ? true
        : undefined,
    );
    expect(
      (await transcript(owner, session.id)).some(
        (event) => event.type === 'tool.finished' && event.data.status === 'ok',
      ),
    ).toBe(false);

    if (!runnable) return context.skip(NO_ISOLATION);
    // Switching on means approving what is shown: the permissions, this exact content, this level of isolation.
    for (const wrong of [
      { permissions: ['network'], contentHash: record.contentHash, isolation },
      { permissions: [], contentHash: 'sha256-of-something-else', isolation },
      {
        permissions: [],
        contentHash: record.contentHash,
        isolation: isolation === 'sandboxed' ? 'restricted' : 'sandboxed',
      },
    ]) {
      const refused = await owner.post<ErrorBody>('/api/plugins/notes-counter/enable', wrong);
      expect([400, 409], JSON.stringify(wrong)).toContain(refused.status);
    }
    expect((await plugin('notes-counter')).enabled).toBe(false);
    const enabled = await owner.post<Json>('/api/plugins/notes-counter/enable', {
      permissions: [],
      contentHash: record.contentHash,
      isolation,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBeLessThan(300);
    const on = await plugin('notes-counter');
    expect(on).toMatchObject({
      enabled: true,
      approval: { state: 'current', approvedBy: owner.userId, isolation },
    });
    expect(['running', 'stopped']).toContain(on.status);

    for (const client of [owner, member]) {
      const offered = await contributions(client);
      expect(offered.homeTiles).toEqual([
        {
          pluginId: 'notes-counter',
          pluginName: 'Notes counter',
          panelId: 'notes',
          title: 'Notes',
          icon: 'notebook',
        },
      ]);
      expect(offered.projectTabs.map((tab: Json) => tab.panelId)).toEqual(['notes']);
    }
    // Its read tool answers an agent without a prompt; its write tool is put to the user first. Where this machine
    // cannot keep plugin code off the network, a "read" tool could still send what it reads anywhere, so it is
    // put to the user too.
    const [count, add] = on.contributes.tools.map((item: Json) => item.registeredName as string);
    const working = await createSession(owner, project.id);
    const receipt = await send(
      owner,
      working.id,
      `note it [[scenario:studio-tool ${add} {"text":"remember the milk"}]] [[scenario:studio-tool ${count} {}]]`,
    );
    const asked: string[] = [];
    await until(
      async () => {
        for (const approval of await pendingApprovals(owner, working.id)) {
          asked.push(approval.toolName ?? '');
          await decide(owner, approval.id, 'allow');
        }
        return ['completed', 'failed'].includes((await getRun(owner, receipt.runId!)).status)
          ? true
          : undefined;
      },
      { timeout: 40_000, what: 'the run that uses the plugin’s tools to end' },
    );
    expect(asked).toEqual(networkContained ? [add] : [add, count]);
    const outputs = (await transcript(owner, working.id))
      .filter((event) => event.type === 'tool.finished')
      .map((event) => `${event.data.status}: ${event.data.output}`);
    expect(outputs[0]).toContain('Saved note #1.');
    expect(outputs[1]).toContain('1 note saved.');
    expect(outputs[1]).toContain('remember the milk');
  });

  it('AT-PJ-201 (adapted): a plugin’s panel is served only under a grant, as a page that cannot run with the product’s origin — a path with parent steps, another grant or no grant gets the same "not found"; a call through the panel acts as the person who opened it', async (context) => {
    if (!runnable) return context.skip(NO_ISOLATION);
    expect((await plugin('notes-counter')).enabled).toBe(true);
    const member = await createMember(studio, owner, 'panelviewer');
    await shareProject(owner, project.id, member.userId!, 'read');
    const opened = await member.post<Json>('/api/plugins/notes-counter/panels/notes/open', {
      slot: 'project-tab',
      projectId: project.id,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
    const grant = opened.body;
    expect(grant).toMatchObject({
      pluginId: 'notes-counter',
      panelId: 'notes',
      slot: 'project-tab',
      projectId: project.id,
      sandbox: 'allow-scripts allow-forms',
    });
    expect(grant.expiresAt).toBeGreaterThan(Date.now());

    // The grant in the address is the credential: no cookie is needed, and none is used.
    const page = await download(studio.client(), grant.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(page.headers.get('set-cookie')).toBeNull();
    const base = grant.url.replace(/[^/]*$/, '');
    // Sent byte for byte (a browser would tidy the dots away before sending): none of these leaves the panel's own files.
    for (const escape of [
      '../plugin.json',
      '..%2fplugin.json',
      '%2e%2e/plugin.json',
      '../server/index.js',
      '..%2f..%2f..%2f..%2fstudio.db',
      '....//plugin.json',
      'no-such-file.html',
    ]) {
      const answer = await rawRequest({
        port: studio.port,
        method: 'GET',
        path: `${base}${escape}`,
        host: `127.0.0.1:${studio.port}`,
      });
      expect([400, 404], escape).toContain(answer.status);
      expect(answer.body, escape).not.toContain('manifestVersion');
      expect(answer.body, escape).not.toContain('definePlugin');
    }
    expect(
      (
        await download(
          studio.client(),
          grant.url.replace(/panel\/[^/]+\//, 'panel/0123456789abcdefghijklmnopqrstuvwxyz0123/'),
        )
      ).status,
    ).toBe(404);

    // A call relayed for the panel reaches the plugin's own server-side part and knows who is asking.
    const summary = await member.post<Json>('/api/plugins/notes-counter/rpc', {
      panel: grant.panel,
      method: 'summary',
    });
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      ok: true,
      result: { greeting: 'Hello, panelviewer', projectId: project.id },
    });
    expect(JSON.stringify(summary.body)).not.toContain(member.cookie!.split('=')[1]!);
    // The grant belongs to that person and that sign-in: nobody else can call with it.
    const stolen = await owner.post<Json>('/api/plugins/notes-counter/rpc', {
      panel: grant.panel,
      method: 'summary',
    });
    expect(stolen.status).toBeGreaterThanOrEqual(400);
    const token = await member.post<{ token: string }>('/api/auth/tokens', {
      name: 'panel-probe',
      scopes: ['read', 'write'],
    });
    const robot = studio.client();
    robot.bearer = token.body.token;
    expect(
      (
        await robot.post('/api/plugins/notes-counter/rpc', {
          panel: grant.panel,
          method: 'summary',
        })
      ).status,
    ).toBe(403);
    // A project tab needs the project: someone without it cannot open one there.
    const outsider = await createMember(studio, owner, 'paneloutsider');
    expect(
      (
        await outsider.post('/api/plugins/notes-counter/panels/notes/open', {
          slot: 'project-tab',
          projectId: project.id,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    // When the share ends, the grant stops working for calls.
    await owner.delete(`/api/projects/${project.id}/members/${member.userId}`);
    const afterwards = await member.post<Json>('/api/plugins/notes-counter/rpc', {
      panel: grant.panel,
      method: 'summary',
    });
    expect(afterwards.status === 200 ? afterwards.body.ok : false).toBe(false);
  });

  it('§7.6: a plugin that asks for more — a network host, notifications — is installed with nothing granted; the owner grants what they choose of what it asked for, and never more than it asked', async (context) => {
    const installed = await install('wants-network');
    expect(installed.status).toBeLessThan(300);
    const record = await plugin('wants-network');
    expect(record.permissions).toEqual({
      requested: ['network:api.example.test', 'notifications'],
      granted: [],
    });
    expect(record.enabled).toBe(false);
    if (!runnable) return context.skip(NO_ISOLATION);
    // More than it asked for — another host, the whole network, the projects — is refused.
    for (const permissions of [
      ['network:api.example.test', 'notifications', 'projects:read'],
      ['network', 'notifications'],
      ['network:other.example.test'],
      ['everything'],
    ]) {
      const refused = await owner.post('/api/plugins/wants-network/enable', {
        permissions,
        contentHash: record.contentHash,
        isolation,
      });
      expect([400, 409], JSON.stringify(permissions)).toContain(refused.status);
    }
    expect(await plugin('wants-network')).toMatchObject({
      enabled: false,
      permissions: { granted: [] },
    });
    // Less is the owner's choice: here the notifications, not the network host.
    const enabled = await owner.post('/api/plugins/wants-network/enable', {
      permissions: ['notifications'],
      contentHash: record.contentHash,
      isolation,
    });
    expect(enabled.status).toBeLessThan(300);
    const on = await plugin('wants-network');
    expect(on.enabled).toBe(true);
    expect(on.permissions).toEqual({
      requested: ['network:api.example.test', 'notifications'],
      granted: ['notifications'],
    });
    // With a notification grant every tool counts as one that changes things: agents must ask before using it.
    expect(
      on.contributes.tools.map((tool: Json) => `${tool.declaredEffect}->${tool.effect}`),
    ).toEqual(['read->write', 'write->write']);
  });

  it('§7.6: plugins are the owner’s to manage, from a signed-in browser — a member cannot look at, install or switch them; an API token cannot install or switch them either', async () => {
    const member = await createMember(studio, owner, 'pluginmember');
    for (const attempt of [
      member.get('/api/plugins'),
      member.get('/api/plugins/sources'),
      member.get('/api/plugins/notes-counter'),
      install('notes-counter', member),
      member.post('/api/plugins/notes-counter/enable', {}),
      member.post('/api/plugins/notes-counter/disable'),
      member.post('/api/plugins/notes-counter/uninstall', {}),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('owner_required');
    }
    const token = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'plugin-automation',
      scopes: ['read', 'write', 'admin'],
    });
    const robot = studio.client();
    robot.bearer = token.body.token;
    expect((await robot.get('/api/plugins')).status).toBe(200); // reading is allowed to an admin token
    const record = await plugin('notes-counter');
    for (const attempt of [
      install('notes-counter', robot),
      robot.post('/api/plugins/notes-counter/enable', {
        permissions: [],
        contentHash: record.contentHash,
        isolation,
      }),
      robot.post('/api/plugins/notes-counter/disable'),
      robot.post('/api/plugins/notes-counter/uninstall', {}),
      robot.post('/api/plugins/notes-counter/update'),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('session_required');
    }
    expect((await studio.client().get('/api/plugins/contributions')).status).toBe(401);
    expect((await plugin('notes-counter')).enabled).toBe(record.enabled);
  });

  it('AT-PJ-200: switching a plugin off removes what it contributed; uninstalling removes it altogether', async () => {
    const member = await createMember(studio, owner, 'pluginwatcher');
    const off = await owner.post('/api/plugins/notes-counter/disable');
    expect(off.status).toBeLessThan(300);
    expect((await plugin('notes-counter')).enabled).toBe(false);
    expect(
      (await contributions(member)).homeTiles.filter(
        (tile: Json) => tile.pluginId === 'notes-counter',
      ),
    ).toEqual([]);
    expect(
      (await member.post('/api/plugins/notes-counter/panels/notes/open', { slot: 'home-tile' }))
        .status,
    ).toBeGreaterThanOrEqual(400);

    const removed = await owner.post('/api/plugins/notes-counter/uninstall', { deleteData: true });
    expect(removed.status).toBeLessThan(300);
    expect((await owner.get('/api/plugins/notes-counter')).status).toBe(404);
    expect(
      (await owner.get<Json>('/api/plugins')).body.plugins.map((item: Json) => item.id),
    ).not.toContain('notes-counter');
    const sources = (await owner.get<Json>('/api/plugins/sources')).body.entries as Json[];
    expect(sources.find((entry) => entry.name === 'notes-counter')).toMatchObject({
      installed: false,
    });
    await owner.post('/api/plugins/wants-network/uninstall', { deleteData: true });
  });
});
