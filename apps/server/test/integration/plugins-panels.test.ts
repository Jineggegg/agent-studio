import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { PluginContributions, PluginNotificationEvent, PluginPanelGrant, PluginSummary, Project } from '@agent-studio/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '../../src/kernel/crypto.js';
import type { GuardedRequest, GuardedResponse } from '../../src/kernel/net.js';
import type { TestClient } from '../../src/testing/harness.js';
import { EXAMPLE_PLUGIN, manifest, pluginStudio, toolbox, type CapabilityAnswer, type PluginTestStudio } from './plugins-fixtures/kit.js';

const project = async (t: PluginTestStudio, owner: TestClient, name: string, files: Record<string, string | Buffer> = {}): Promise<Project> => {
  const response = await owner.post<Project>('/api/projects', { name, rootDir: path.join(t.workspace, name), createDirectory: true });
  if (response.status !== 201) throw new Error(JSON.stringify(response.body));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(response.body.rootDir, file)), { recursive: true });
    await writeFile(path.join(response.body.rootDir, file), content);
  }
  return response.body;
};

describe('panels', () => {
  let t: PluginTestStudio;
  let owner: TestClient;
  let grant: PluginPanelGrant;
  beforeAll(async () => {
    t = await pluginStudio({ sources: { 'notes-counter': EXAMPLE_PLUGIN } });
    owner = await t.owner();
    await t.writeSource('box', toolbox('box', []));
    await t.installAndEnable(owner, 'box');
    await t.installAndEnable(owner, 'notes-counter');
    grant = await t.openPanel(owner, 'box', 'main');
  });
  afterAll(async () => {
    await t.close();
  });
  const asset = (file: string, from: PluginPanelGrant = grant) => t.anonymous().get<string>(`/api/plugins/panel/${from.panel}/${file}`);

  it('mints a grant bound to the plugin, the panel, the slot and about an hour', () => {
    expect(grant).toMatchObject({ pluginId: 'box', panelId: 'main', slot: 'home-tile', projectId: null, sandbox: 'allow-scripts allow-forms' });
    expect(grant.panel).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.url).toBe(`/api/plugins/panel/${grant.panel}/index.html`);
    expect(grant.expiresAt - Date.now()).toBeGreaterThan(55 * 60 * 1000);
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('serves the panel page, without any cookie, with exactly the headers that confine it', async () => {
    const response = await asset('index.html');
    expect(response.status).toBe(200);
    expect(response.body).toContain('<script type="module" src="./app.js">');
    const base = `http://localhost:7420/api/plugins/panel/${grant.panel}/`;
    expect(response.headers['content-security-policy']).toBe(
      `sandbox allow-scripts allow-forms; default-src 'none'; script-src ${base}; style-src ${base}; img-src ${base} data:; font-src ${base}; ` +
        "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; webrtc 'block'",
    );
    expect(response.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      // The three that differ from every other response of this server:
      'cross-origin-resource-policy': 'cross-origin',
      'x-frame-options': 'SAMEORIGIN',
      'access-control-allow-origin': '*',
      // …and what stays as the server sets it everywhere:
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();

    // The rest of the server is as closed as before.
    const api = await owner.get('/api/plugins/contributions');
    expect(api.headers['x-frame-options']).toBe('DENY');
    expect(api.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(String(api.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(api.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the panel’s own scripts, styles and images with the same policy and the right types', async () => {
    for (const [file, type] of [
      ['app.js', 'text/javascript; charset=utf-8'],
      ['style.css', 'text/css; charset=utf-8'],
      ['img/dot.svg', 'image/svg+xml'],
      ['@studio/panel.js', 'text/javascript; charset=utf-8'],
    ] as const) {
      const response = await asset(file);
      expect(response.status, file).toBe(200);
      expect(response.headers['content-type'], file).toBe(type);
      expect(response.headers['x-content-type-options'], file).toBe('nosniff');
      expect(String(response.headers['content-security-policy']), file).toContain('sandbox allow-scripts allow-forms;');
      expect(response.headers['cross-origin-resource-policy'], file).toBe('cross-origin');
    }
    expect((await asset('@studio/panel.js')).body).toContain('export function connectPanel');
  });

  it('answers "not found" for anything outside the panel folder, hidden, or of a kind that is not served', async () => {
    for (const file of [
      '../plugin.json',
      '../server.js',
      '..%2fserver.js',
      '%2e%2e/server.js',
      '%2e%2e%2fserver.js',
      '..%252fserver.js',
      '....//server.js',
      'img/../../server.js',
      '../../../studio.db',
      '..%2f..%2f..%2fmaster.key',
      '../../node_modules/@agent-studio/plugin-sdk/plugin.js',
      '../../notes-counter/plugin.json',
      '/etc/passwd',
      '%2fetc%2fpasswd',
      'notes.md',
      '.hidden.js',
      'img/',
      'img',
      'missing.js',
      'index.html%00.js',
      'index.html/..',
      '@studio/plugin.js',
      '@studio/../server.js',
      '',
    ]) {
      const response = await asset(file);
      expect(response.status, file).toBe(404);
      expect(JSON.stringify(response.body), file).not.toMatch(/definePlugin|manifestVersion|SQLite/);
    }
  });

  it('does not follow a symbolic link out of the panel folder', async () => {
    // Slipped in after approval; the next "open" would catch it, an existing grant must not serve it.
    await symlink('/etc/passwd', path.join(t.pluginsDir, 'box', 'panel', 'passwd.txt'));
    await symlink(path.join(t.pluginsDir, 'box', 'server.js'), path.join(t.pluginsDir, 'box', 'panel', 'server-copy.js'));
    expect((await asset('passwd.txt')).status).toBe(404);
    expect((await asset('server-copy.js')).status).toBe(404);
    const { rm } = await import('node:fs/promises');
    await rm(path.join(t.pluginsDir, 'box', 'panel', 'passwd.txt'));
    await rm(path.join(t.pluginsDir, 'box', 'panel', 'server-copy.js'));
  });

  it('answers "not found" for a wrong, altered or made-up grant, and gives no hint which', async () => {
    const flipped = (grant.panel[0] === 'A' ? 'B' : 'A') + grant.panel.slice(1);
    for (const token of [flipped, grant.panel.slice(0, -1), `${grant.panel}x`, 'A'.repeat(43), 'x', '%00', '%2e', newId()]) {
      const response = await t.anonymous().get(`/api/plugins/panel/${token}/index.html`);
      expect(response.status, token).toBe(404);
      expect(response.body, token).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    // A grant opens its own panel's folder, not another plugin's.
    const other = await t.openPanel(owner, 'notes-counter', 'notes');
    expect((await asset('panel.css', other)).status).toBe(200);
    expect((await asset('style.css', other)).status).toBe(404);
    expect((await asset('panel.css')).status).toBe(404);
  });

  it('stops serving when the grant has expired', async () => {
    const fresh = await t.openPanel(owner, 'box', 'main');
    expect((await asset('index.html', fresh)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(fresh.expiresAt - 1000);
      expect((await asset('index.html', fresh)).status).toBe(200);
      vi.setSystemTime(fresh.expiresAt + 1);
      expect((await asset('index.html', fresh)).status).toBe(404);
      expect((await asset('app.js', fresh)).status).toBe(404);
      const call = await t.rpcRaw(owner, fresh, 'whoami');
      expect(call.status).toBe(410);
      expect(call.body).toMatchObject({ error: { code: 'panel_expired' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a grant when the session that minted it signs out', async () => {
    const laptop = await t.signIn('owner');
    const phone = await t.signIn('owner');
    const laptopGrant = await t.openPanel(laptop, 'box', 'main');
    const phoneGrant = await t.openPanel(phone, 'box', 'main');
    expect(await t.rpc(laptop, laptopGrant, 'whoami')).toMatchObject({ user: { displayName: 'owner' } });
    // A grant belongs to the session that opened it, not to the account.
    expect((await t.rpcRaw(phone, laptopGrant, 'whoami')).status).toBe(410);

    expect((await laptop.post('/api/auth/logout')).status).toBe(204);
    expect((await asset('index.html', laptopGrant)).status).toBe(404);
    expect((await t.rpcRaw(laptop, laptopGrant, 'whoami')).status).toBe(401);
    expect((await asset('index.html', phoneGrant)).status).toBe(200);

    expect((await phone.post('/api/auth/logout-everywhere')).status).toBe(204);
    expect((await asset('index.html', phoneGrant)).status).toBe(404);
    expect((await asset('index.html')).status).toBe(404);
    owner = await t.signIn('owner');
    grant = await t.openPanel(owner, 'box', 'main');
  });

  it('relays a panel call as the signed-in user, handing the plugin an id and a name and nothing else', async () => {
    const member = await t.member('mallory');
    const mine = await t.openPanel(member, 'box', 'main');
    const seenByOwner = await t.rpc<Record<string, unknown>>(owner, grant, 'whoami', { page: 2 });
    const seenByMember = await t.rpc<Record<string, unknown>>(member, mine, 'whoami');
    expect(seenByOwner).toEqual({
      user: { id: owner.userId, displayName: 'owner' },
      projectId: null,
      panel: { panelId: 'main', slot: 'home-tile' },
      method: 'whoami',
      keys: ['host', 'method', 'panel', 'plugin', 'projectId', 'user'],
      params: { page: 2 },
    });
    expect(seenByMember).toMatchObject({ user: { id: member.userId, displayName: 'mallory' }, params: null });
    // Nothing that could be used as a credential ever reaches the plugin.
    const everything = JSON.stringify([seenByOwner, seenByMember]);
    for (const secret of [owner.cookie!.split('=')[1]!, owner.csrfToken!, member.cookie!.split('=')[1]!, member.csrfToken!, grant.panel, mine.panel]) {
      expect(everything).not.toContain(secret);
    }

    // One user cannot make a call through another user's panel.
    const stolen = await t.rpcRaw(member, grant, 'whoami');
    expect(stolen.status).toBe(410);
    expect(stolen.body).toMatchObject({ error: { code: 'panel_expired' } });
    // Nor aim a grant at another plugin.
    const crossed = await member.post('/api/plugins/notes-counter/rpc', { panel: mine.panel, method: 'summary' });
    expect(crossed.status).toBe(410);
  });

  it('hands a failure the plugin reports to the panel, and keeps server-side failures as API errors', async () => {
    const failed = await t.rpcRaw(owner, grant, 'fail');
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ ok: false, error: { code: 'custom_failure', message: 'this did not work, token [redacted]' } });
    expect((await t.rpcRaw(owner, grant, 'no-such-method')).body).toMatchObject({ ok: false, error: { code: 'unknown_method' } });

    const big = await t.rpcRaw(owner, grant, 'big', { bytes: 300 * 1024 });
    expect(big.body).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(await t.rpc<string>(owner, grant, 'big', { bytes: 100 * 1024 })).toHaveLength(100 * 1024);

    for (const body of [{ panel: grant.panel }, { panel: grant.panel, method: '../x' }, { panel: grant.panel, method: 'a'.repeat(65) }, { panel: 'short', method: 'whoami' }, { panel: grant.panel, method: 'whoami', extra: 1 }]) {
      expect((await owner.post('/api/plugins/box/rpc', body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const huge = await owner.post('/api/plugins/box/rpc', { panel: grant.panel, method: 'whoami', params: { blob: 'x'.repeat(600 * 1024) } });
    expect(huge.status).toBe(413);
    const large = await owner.post('/api/plugins/box/rpc', { panel: grant.panel, method: 'whoami', params: { blob: 'x'.repeat(300 * 1024) } });
    expect(large.status).toBe(413);
    expect((await owner.post('/api/plugins/ghost/rpc', { panel: grant.panel, method: 'whoami' })).status).toBe(410);
  });

  it('opens only panels that exist, in slots they declare, for people who may see them', async () => {
    const member = await t.member('trent');
    const open = (client: TestClient, id: string, panelId: string, body: Record<string, unknown>) =>
      client.post<{ error: { code: string } } & PluginPanelGrant>(`/api/plugins/${id}/panels/${panelId}/open`, body);

    expect((await open(owner, 'box', 'ghost', { slot: 'home-tile' })).body.error.code).toBe('panel_not_found');
    expect((await open(owner, 'ghost', 'main', { slot: 'home-tile' })).body.error.code).toBe('plugin_not_found');
    expect((await open(owner, 'notes-counter', 'notes', { slot: 'settings-page' })).body.error.code).toBe('panel_not_found');
    expect((await open(owner, 'box', 'main', { slot: 'sidebar' })).status).toBe(400);
    expect((await open(owner, 'box', 'main', {})).status).toBe(400);
    expect((await open(owner, 'box', 'MAIN', { slot: 'home-tile' })).status).toBe(400);
    expect((await open(owner, 'box', 'main%2f..', { slot: 'home-tile' })).status).toBe(400);

    // Settings pages are the owner's.
    expect((await open(member, 'box', 'main', { slot: 'settings-page' })).body.error.code).toBe('owner_required');
    expect((await open(owner, 'box', 'main', { slot: 'settings-page' })).body.slot).toBe('settings-page');

    // A project tab is opened for a project the user can see.
    const shared = await project(t, owner, 'shared');
    const secret = await project(t, owner, 'secret');
    expect((await open(owner, 'box', 'main', { slot: 'project-tab' })).body.error.code).toBe('project_required');
    expect((await open(owner, 'box', 'main', { slot: 'home-tile', projectId: shared.id })).body.error.code).toBe('project_not_expected');
    expect((await open(member, 'box', 'main', { slot: 'project-tab', projectId: shared.id })).body.error.code).toBe('project_not_found');
    await owner.put(`/api/projects/${shared.id}/members/${member.userId}`, { access: 'read' });
    const tab = (await open(member, 'box', 'main', { slot: 'project-tab', projectId: shared.id })).body;
    expect(tab).toMatchObject({ slot: 'project-tab', projectId: shared.id });
    expect((await open(member, 'box', 'main', { slot: 'project-tab', projectId: secret.id })).status).toBe(404);
    expect(await t.rpc(member, tab, 'whoami')).toMatchObject({ projectId: shared.id, panel: { slot: 'project-tab' } });

    // Losing the project ends the tab.
    await owner.delete(`/api/projects/${shared.id}/members/${member.userId}`);
    expect((await t.rpcRaw(member, tab, 'whoami')).status).toBe(410);
    expect((await t.anonymous().get(tab.url)).status).toBe(404);
  });

  it('lists what enabled plugins add to the interface, settings pages for the owner only', async () => {
    await t.writeSource('tiles', {
      manifest: manifest('tiles', {
        contributes: {
          linkTiles: [
            { id: 'grafana', title: 'Dashboards', icon: 'chart', url: 'https://grafana.example.com/d/abc?orgId=1' },
            { id: 'docs', title: 'Docs', url: 'https://docs.example.com/' },
          ],
        },
      }),
    });
    await t.installAndEnable(owner, 'tiles');
    const member = await t.member('peggy');
    const forOwner = (await owner.get<PluginContributions>('/api/plugins/contributions')).body;
    const forMember = (await member.get<PluginContributions>('/api/plugins/contributions')).body;
    const box = { pluginId: 'box', pluginName: 'Test box', panelId: 'main', title: 'Toolbox', icon: 'puzzle' };
    const notes = { pluginId: 'notes-counter', pluginName: 'Notes counter', panelId: 'notes', title: 'Notes', icon: 'notebook' };
    expect(forOwner).toEqual({
      homeTiles: [box, notes],
      projectTabs: [box, notes],
      settingsPages: [box],
      linkTiles: [
        { pluginId: 'tiles', pluginName: 'Test tiles', id: 'grafana', title: 'Dashboards', icon: 'chart', url: 'https://grafana.example.com/d/abc?orgId=1' },
        { pluginId: 'tiles', pluginName: 'Test tiles', id: 'docs', title: 'Docs', icon: 'link', url: 'https://docs.example.com/' },
      ],
    });
    expect(forMember).toEqual({ ...forOwner, settingsPages: [] });
    // Nothing of the management view leaks into what every user gets.
    expect(JSON.stringify(forMember)).not.toMatch(/contentHash|logTail|granted|sha256/);
  });

  it('ends every grant of a plugin when it is disabled', async () => {
    const mine = await t.openPanel(owner, 'notes-counter', 'notes');
    expect((await asset('index.html', mine)).status).toBe(200);
    await owner.post('/api/plugins/notes-counter/disable');
    expect((await asset('index.html', mine)).status).toBe(404);
    expect((await asset('@studio/panel.js', mine)).status).toBe(404);
    expect((await t.rpcRaw(owner, mine, 'summary')).status).toBe(410);
    expect((await owner.post('/api/plugins/notes-counter/panels/notes/open', { slot: 'home-tile' })).status).toBe(404);
    expect((await asset('index.html')).status).toBe(200);
  });
});

describe('capabilities', () => {
  let t: PluginTestStudio;
  let owner: TestClient;
  const sent: { url: string; options: GuardedRequest }[] = [];
  let respond: (url: string) => GuardedResponse = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Readable.from([Buffer.from('ok')]) });
  const call = async <T = unknown>(client: TestClient, grant: PluginPanelGrant, fn: string, ...args: unknown[]) =>
    (await t.rpc<CapabilityAnswer<T>>(client, grant, 'call', { fn, args })).result;

  beforeAll(async () => {
    t = await pluginStudio({
      plugins: {
        // Stands in for the network: whatever reaches this was allowed by the checks before it.
        fetchTransport: (url, options = {}) => {
          sent.push({ url, options });
          return Promise.resolve(respond(url));
        },
        limits: { maxNotificationsPerMinute: 3, maxFetchResponseBytes: 4096, maxFetchRequestBytes: 1024 },
      },
    });
    owner = await t.owner();
    await t.writeSource('alpha', toolbox('alpha', ['network:api.example.com', 'notifications', 'projects:read']));
    await t.writeSource('beta', toolbox('beta', []));
    await t.installAndEnable(owner, 'alpha');
    await t.installAndEnable(owner, 'beta');
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    sent.length = 0;
  });

  it('gives each plugin a key-value space no other plugin can see', async () => {
    const alpha = await t.openPanel(owner, 'alpha', 'main');
    const beta = await t.openPanel(owner, 'beta', 'main');
    expect(await call(owner, alpha, 'storage.set', 'token', { secret: 'alpha-only' })).toEqual({ ok: true, value: null });
    expect(await call(owner, beta, 'storage.get', 'token')).toEqual({ ok: true, value: null });
    expect(await call(owner, beta, 'storage.list')).toEqual({ ok: true, value: [] });
    expect(await call(owner, beta, 'storage.set', 'token', 'beta-only')).toEqual({ ok: true, value: null });
    expect(await call(owner, beta, 'storage.delete', 'token')).toEqual({ ok: true, value: true });
    expect(await call(owner, alpha, 'storage.get', 'token')).toEqual({ ok: true, value: { secret: 'alpha-only' } });
    expect(await call(owner, alpha, 'storage.list', { prefix: 'to' })).toEqual({ ok: true, value: ['token'] });
    // Storage belongs to the plugin, not to a user: another user of the same plugin shares it.
    const member = await t.member();
    expect(await call(member, await t.openPanel(member, 'alpha', 'main'), 'storage.get', 'token')).toEqual({ ok: true, value: { secret: 'alpha-only' } });
    // Limits are enforced by the Studio.
    expect(await call(owner, alpha, 'storage.set', 'big', 'x'.repeat(70 * 1024))).toMatchObject({ ok: false, code: 'too_large' });
    expect(await call(owner, alpha, 'storage.set', 'k'.repeat(200), 1)).toMatchObject({ ok: false, code: 'invalid_key' });
  });

  it('fetches only from hosts that were granted, with a short list of headers, and never follows where it should not', async () => {
    const alpha = await t.openPanel(owner, 'alpha', 'main');
    respond = () => ({
      status: 201,
      headers: { 'content-type': 'application/json', etag: '"v1"', 'set-cookie': ['session=abc'], 'x-internal': 'hidden', location: 'https://elsewhere.example/' },
      body: Readable.from([Buffer.from('{"ok":'), Buffer.from('true}')]),
    });
    const ok = await call(owner, alpha, 'http.fetch', 'https://api.example.com/v1/items?q=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer plugin-own-token', Accept: 'application/json' },
      body: '{"a":1}',
    });
    expect(ok).toEqual({
      ok: true,
      value: { status: 201, headers: { 'content-type': 'application/json', etag: '"v1"', location: 'https://elsewhere.example/' }, body: '{"ok":true}', encoding: 'utf8' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.example.com/v1/items?q=1');
    expect(sent[0]!.options).toMatchObject({ method: 'POST', body: '{"a":1}', policy: {} });
    expect(sent[0]!.options.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer plugin-own-token',
      accept: 'application/json',
      'user-agent': expect.stringMatching(/^AgentStudio-Plugin\/.+ \(alpha\)$/),
      'accept-encoding': 'identity',
      'content-length': '7',
    });
    expect(await call(owner, alpha, 'http.fetch', 'https://api.example.com/bin', { responseType: 'base64' })).toMatchObject({
      ok: true,
      value: { encoding: 'base64', body: Buffer.from('{"ok":true}').toString('base64') },
    });
    sent.length = 0;

    const refusals: [unknown[], string][] = [
      [['https://other.example.com/'], 'permission_denied'],
      [['https://api.example.com.evil.test/'], 'permission_denied'],
      [['https://127.0.0.1/'], 'permission_denied'],
      [['http://api.example.com/'], 'insecure_url'],
      [['https://api.example.com:8443/'], 'port_not_allowed'],
      [['https://user:pw@api.example.com/'], 'invalid_url'],
      [['not a url'], 'invalid_url'],
      [['https://api.example.com/', { headers: { Host: 'internal' } }], 'header_not_allowed'],
      [['https://api.example.com/', { headers: { Cookie: 'a=b' } }], 'header_not_allowed'],
      [['https://api.example.com/', { headers: { 'X-Forwarded-For': '127.0.0.1' } }], 'header_not_allowed'],
      [['https://api.example.com/', { headers: { 'Transfer-Encoding': 'chunked' } }], 'header_not_allowed'],
      [['https://api.example.com/', { headers: { accept: 'a\r\nHost: evil' } }], 'invalid_params'],
      [['https://api.example.com/', { method: 'CONNECT' }], 'invalid_params'],
      [['https://api.example.com/', { method: 'TRACE' }], 'invalid_params'],
      [['https://api.example.com/', { method: 'GET', body: 'x' }], 'invalid_params'],
      [['https://api.example.com/', { method: 'POST', body: 'x'.repeat(2048) }], 'too_large'],
    ];
    for (const [args, code] of refusals) {
      expect(await call(owner, alpha, 'http.fetch', ...args), JSON.stringify(args).slice(0, 80)).toMatchObject({ ok: false, code });
    }
    // None of the refused requests got as far as the network.
    expect(sent).toEqual([]);

    // A response larger than the cap is refused rather than buffered.
    respond = () => ({ status: 200, headers: {}, body: Readable.from([Buffer.alloc(3000), Buffer.alloc(3000)]) });
    expect(await call(owner, alpha, 'http.fetch', 'https://api.example.com/huge')).toMatchObject({ ok: false, code: 'too_large' });

    // A plugin without the permission cannot fetch at all.
    const beta = await t.openPanel(owner, 'beta', 'main');
    sent.length = 0;
    expect(await call(owner, beta, 'http.fetch', 'https://api.example.com/')).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(sent).toEqual([]);
  });

  it('turns a notification into an event for the user the call was for, and limits how many', async () => {
    const events: PluginNotificationEvent[] = [];
    const off = t.studio.context.bus.on('plugin.notification', (event) => {
      if (event.topic === 'internal:plugins') events.push(event.data as PluginNotificationEvent);
    });
    try {
      const member = await t.member('nora');
      const alpha = await t.openPanel(member, 'alpha', 'main');
      expect(await call(member, alpha, 'notify', { title: 'Build finished', body: 'All green.' })).toEqual({ ok: true, value: null });
      expect(events).toEqual([{ pluginId: 'alpha', pluginName: 'Test alpha', userId: member.userId, title: 'Build finished', body: 'All green.', projectId: null }]);
      expect(await call(member, alpha, 'notify', { title: '' })).toMatchObject({ ok: false, code: 'invalid_params' });
      expect(await call(member, alpha, 'notify', { title: 't'.repeat(121) })).toMatchObject({ ok: false, code: 'invalid_params' });
      expect(await call(member, alpha, 'notify', { title: 'two' })).toMatchObject({ ok: true });
      expect(await call(member, alpha, 'notify', { title: 'three' })).toMatchObject({ ok: true });
      expect(await call(member, alpha, 'notify', { title: 'four' })).toMatchObject({ ok: false, code: 'rate_limited' });
      expect(events).toHaveLength(3);
      expect(await call(member, await t.openPanel(member, 'beta', 'main'), 'notify', { title: 'no' })).toMatchObject({ ok: false, code: 'permission_denied' });
    } finally {
      off();
    }
  });

  it('shows a plugin only the projects of the user it is acting for, and only files inside them', async () => {
    const open = await project(t, owner, 'open-project', {
      'README.md': '# Hello\n',
      'src/app.ts': 'export const x = 1;\n',
      '.env': 'API_KEY=very-secret\n',
      'deploy/server.pem': '-----BEGIN PRIVATE KEY-----\n',
      '.git/config': '[remote "origin"]\n\turl = https://token@github.com/x/y\n',
      'logo.bin': Buffer.from([0, 1, 2, 3, 255]),
      'big.txt': 'é'.repeat(5000),
    });
    const closed = await project(t, owner, 'closed-project', { 'README.md': 'not for members\n' });
    await writeFile(path.join(t.workspace, 'outside.txt'), 'outside every project');
    await symlink(path.join(t.workspace, 'outside.txt'), path.join(open.rootDir, 'link-out.txt'));
    await symlink('/etc/passwd', path.join(open.rootDir, 'passwd'));
    const member = await t.member('olivia');
    await owner.put(`/api/projects/${open.id}/members/${member.userId}`, { access: 'read' });

    const tile = await t.openPanel(member, 'alpha', 'main');
    expect(await call(member, tile, 'projects.list')).toEqual({ ok: true, value: [{ id: open.id, name: 'open-project', access: 'read' }] });
    expect(await call(member, tile, 'files.read', open.id, 'README.md')).toEqual({
      ok: true,
      value: { path: 'README.md', size: 8, truncated: false, encoding: 'utf8', content: '# Hello\n' },
    });
    expect(await call(member, tile, 'files.read', open.id, 'src/../src/app.ts')).toMatchObject({ ok: true, value: { path: 'src/app.ts' } });
    expect(await call(member, tile, 'files.read', open.id, 'logo.bin')).toMatchObject({ ok: true, value: { encoding: 'base64', content: Buffer.from([0, 1, 2, 3, 255]).toString('base64') } });
    const cut = await call<{ content: string; truncated: boolean; size: number; encoding: string }>(member, tile, 'files.read', open.id, 'big.txt', { maxBytes: 101 });
    expect(cut).toMatchObject({ ok: true, value: { truncated: true, size: 10000, encoding: 'utf8', content: 'é'.repeat(50) } });

    for (const [target, code] of [
      ['../closed-project/README.md', 'path_outside_root'],
      ['../outside.txt', 'path_outside_root'],
      ['/etc/passwd', 'path_outside_root'],
      [`${t.dataDir}/master.key`, 'path_outside_root'],
      ['link-out.txt', 'path_outside_root'],
      ['passwd', 'path_outside_root'],
      ['.env', 'path_not_allowed'],
      ['deploy/server.pem', 'path_not_allowed'],
      ['.git/config', 'path_not_allowed'],
      ['missing.txt', 'not_found'],
      ['src', 'not_a_file'],
      ['a\u0000b', 'invalid_path'],
    ] as const) {
      expect(await call(member, tile, 'files.read', open.id, target), target).toMatchObject({ ok: false, code });
    }
    // A project the user cannot see does not exist as far as the plugin can tell.
    expect(await call(member, tile, 'files.read', closed.id, 'README.md')).toMatchObject({ ok: false, code: 'project_not_found' });
    expect(await call(member, tile, 'files.read', newId(), 'README.md')).toMatchObject({ ok: false, code: 'project_not_found' });
    expect(await call(member, tile, 'files.read', 'not-an-id', 'README.md')).toMatchObject({ ok: false, code: 'invalid_params' });
    // The owner sees both.
    const ownerTile = await t.openPanel(owner, 'alpha', 'main');
    expect((await call<{ id: string }[]>(owner, ownerTile, 'projects.list')) as { value: { id: string }[] }).toMatchObject({ value: expect.arrayContaining([expect.objectContaining({ id: closed.id })]) });

    // Opened as a project tab, a panel is limited to that project even for the owner.
    const tab = await t.openPanel(owner, 'alpha', 'main', 'project-tab', open.id);
    expect(await call(owner, tab, 'projects.list')).toEqual({ ok: true, value: [{ id: open.id, name: 'open-project', access: 'write' }] });
    expect(await call(owner, tab, 'files.read', closed.id, 'README.md')).toMatchObject({ ok: false, code: 'project_not_found' });

    // Without the permission there are no projects at all.
    expect(await call(owner, await t.openPanel(owner, 'beta', 'main'), 'projects.list')).toMatchObject({ ok: false, code: 'permission_denied' });
  });

  it('runs a tool for the user and within the project of the run that called it', async () => {
    const mine = await project(t, owner, 'run-project', { 'notes.txt': 'in the run\n' });
    const other = await project(t, owner, 'other-project', { 'notes.txt': 'elsewhere\n' });
    const tool = async (userId: string, name: string, input: unknown, projectId: string | null = null) => {
      const result = await t.callTool(userId, name, input, projectId);
      return { ...result, parsed: result.isError ? null : (JSON.parse(result.text) as CapabilityAnswer & { run?: Record<string, string> }) };
    };

    const inRun = await tool(owner.userId!, 'plugin_alpha_probe', { fn: 'files.read', args: [mine.id, 'notes.txt'] }, mine.id);
    expect(inRun.parsed).toMatchObject({ result: { ok: true, value: { content: 'in the run\n' } }, user: { id: owner.userId, displayName: 'owner' }, projectId: mine.id, run: { agentId: 'test-agent' } });
    expect(inRun.parsed!.run!.runId).toMatch(/^[0-9a-z]{26}$/);
    // Even the owner's run reaches only its own project through a plugin.
    expect((await tool(owner.userId!, 'plugin_alpha_probe', { fn: 'files.read', args: [other.id, 'notes.txt'] }, mine.id)).parsed).toMatchObject({ result: { ok: false, code: 'project_not_found' } });
    expect((await tool(owner.userId!, 'plugin_alpha_probe', { fn: 'projects.list' }, mine.id)).parsed).toMatchObject({ result: { ok: true, value: [{ id: mine.id }] } });
    expect((await tool(owner.userId!, 'plugin_alpha_probe', { fn: 'projects.list' })).parsed).toMatchObject({ result: { ok: true, value: [] } });

    // Input that does not fit the declared schema never reaches the plugin.
    const bad = await t.callTool(owner.userId!, 'plugin_alpha_probe', { args: [] });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/Invalid input/);
    // A run of a user who no longer exists gets nothing.
    expect(await t.callTool(newId(), 'plugin_alpha_probe', { fn: 'storage.list' })).toMatchObject({ isError: true });

    // A tool that is "read" for the permission engine cannot change anything while it runs.
    const isolation = await t.isolation(owner);
    const readOnly = await tool(owner.userId!, 'plugin_beta_probe_read', { fn: 'storage.set', args: ['sneaky', 1] });
    if (isolation.restricts.network) {
      expect(readOnly.parsed).toMatchObject({ result: { ok: false, code: 'read_only_call' } });
      expect((await tool(owner.userId!, 'plugin_beta_probe_read', { fn: 'storage.delete', args: ['token'] })).parsed).toMatchObject({ result: { ok: false, code: 'read_only_call' } });
      expect((await tool(owner.userId!, 'plugin_beta_probe_read', { fn: 'storage.get', args: ['sneaky'] })).parsed).toMatchObject({ result: { ok: true, value: null } });
    } else {
      // Where plugin processes are not kept off the network, there is no read-only tool to begin with.
      expect(t.studio.context.agentTools.get('plugin_beta_probe_read')!.effect).toBe('write');
    }
    // The same call from the write tool, which went through approval, works.
    expect((await tool(owner.userId!, 'plugin_beta_probe', { fn: 'storage.set', args: ['honest', 1] })).parsed).toMatchObject({ result: { ok: true } });
  });

  it('cuts a tool result that is too long', async () => {
    await t.writeSource('wordy', {
      manifest: manifest('wordy', {
        server: { entry: 'server.js' },
        contributes: { tools: [{ name: 'talk', description: 'Talks.', effect: 'read', inputSchema: { type: 'object', properties: { bytes: { type: 'integer' } } } }] },
      }),
      files: { 'server.js': `import { definePlugin } from '@agent-studio/plugin-sdk';\ndefinePlugin({ tools: { talk: (input) => 'w'.repeat(input.bytes) } });\n` },
    });
    await t.installAndEnable(owner, 'wordy');
    const long = await t.callTool(owner.userId!, 'plugin_wordy_talk', { bytes: 300 * 1024 });
    expect(long.isError).toBeUndefined();
    expect(long.text.length).toBeLessThan(260 * 1024);
    expect(long.text).toMatch(/\[cut: the result was longer than \d+ bytes\]$/);
    const tooLong = await t.callTool(owner.userId!, 'plugin_wordy_talk', { bytes: 2 * 1024 * 1024 });
    expect(tooLong).toMatchObject({ isError: true });
  });
});

describe('hooks', () => {
  let t: PluginTestStudio;
  let owner: TestClient;
  beforeAll(async () => {
    t = await pluginStudio();
    owner = await t.owner();
    await t.writeSource('listener', toolbox('listener', ['notifications', 'projects:read']));
    await t.writeSource('deaf', toolbox('deaf', [], { hooks: ['project.deleted'] }));
    await t.writeSource('off', toolbox('off', []));
    await t.installAndEnable(owner, 'listener');
    await t.installAndEnable(owner, 'deaf');
    await t.install(owner, 'off');
  });
  afterAll(async () => {
    await t.close();
  });
  const heard = async (id: string) => {
    await t.studio.context.services.plugins.settled();
    return t.rpc<{ event: string; payload: Record<string, unknown>; user: unknown; keys: string[] }[]>(owner, await t.openPanel(owner, id, 'main'), 'hooks');
  };

  it('delivers the events a plugin asked for — identifiers only, for no user — and only to enabled plugins', async () => {
    const created = await project(t, owner, 'hooked');
    const runId = newId();
    const sessionId = newId();
    const run = { runId, sessionId, projectId: created.id, agentId: 'claude-code' };
    const { bus } = t.studio.context;
    // The agents module announces a run on the topic of every user who may see it…
    bus.publish(`user:${owner.userId}`, 'run.started', { ...run, prompt: 'the secret plan', title: 'Private conversation' });
    bus.publish(`user:${newId()}`, 'run.started', run);
    bus.publish(`user:${owner.userId}`, 'run.finished', { ...run, status: 'completed', finalMessage: 'here is the password' });
    bus.publish(`user:${newId()}`, 'run.finished', { ...run, status: 'completed' });
    // …and writes a different event of the same name into the session's own log.
    bus.publish(`session:${sessionId}`, 'run.finished', { runId, status: 'completed', error: null, interruptedByRestart: false, durationMs: 5 });
    // Events of the same name from anywhere else are not hooks.
    bus.publish('project:whatever', 'project.created', { projectId: newId() });
    bus.publish(`user:${owner.userId}`, 'run.finished', { runId: 'not-an-id', sessionId, projectId: null, agentId: 'x', status: 'completed' });
    expect((await owner.delete(`/api/projects/${created.id}`)).status).toBe(204);

    expect(await heard('listener')).toEqual([
      { event: 'project.created', payload: { projectId: created.id }, user: null, keys: ['event', 'host', 'plugin', 'projectId', 'user'] },
      { event: 'run.started', payload: run, user: null, keys: ['event', 'host', 'plugin', 'projectId', 'user'] },
      { event: 'run.finished', payload: { ...run, status: 'completed' }, user: null, keys: ['event', 'host', 'plugin', 'projectId', 'user'] },
      { event: 'project.deleted', payload: { projectId: created.id }, user: null, keys: ['event', 'host', 'plugin', 'projectId', 'user'] },
    ]);
    // A plugin hears only what its manifest lists.
    expect((await heard('deaf')).map((entry) => entry.event)).toEqual(['project.deleted']);
    // A plugin that is not enabled hears nothing, and no process was started for it.
    expect(t.studio.context.services.plugins.processId('off')).toBeUndefined();
    await t.enable(owner, 'off');
    expect(await heard('off')).toEqual([]);
  });

  it('gives a hook no way to anything that belongs to a user, whatever was granted', async () => {
    // The toolbox's hook handler records what it was given; this one tries to use it.
    await t.writeSource('grabby', {
      manifest: manifest('grabby', {
        server: { entry: 'server.js' },
        permissions: ['notifications', 'projects:read'],
        contributes: { hooks: ['project.created'], panels: [{ id: 'main', title: 'G', entry: 'p/index.html', slots: ['home-tile'] }] },
      }),
      files: {
        'p/index.html': '<!doctype html>',
        'server.js': `import { definePlugin } from '@agent-studio/plugin-sdk';
const attempt = async (work) => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, code: error.code }; } };
definePlugin({
  hooks: {
    'project.created': async (payload, { host }) => {
      await host.storage.set('report', {
        notify: await attempt(() => host.notify({ title: 'from a hook' })),
        list: await attempt(() => host.projects.list()),
        read: await attempt(() => host.files.read(payload.projectId, 'README.md')),
      });
    },
  },
  panelMethods: { report: (_params, { host }) => host.storage.get('report') },
});
`,
      },
    });
    await t.installAndEnable(owner, 'grabby');
    await project(t, owner, 'tempting', { 'README.md': 'user data' });
    await t.studio.context.services.plugins.settled();
    expect(await t.rpc(owner, await t.openPanel(owner, 'grabby', 'main'), 'report')).toEqual({
      notify: { ok: false, code: 'no_user' },
      list: { ok: false, code: 'no_user' },
      read: { ok: false, code: 'no_user' },
    });
  });
});

describe('uninstalling', () => {
  let t: PluginTestStudio;
  let owner: TestClient;
  afterEach(async () => {
    await t.close();
  });
  const setUp = async () => {
    t = await pluginStudio({ sources: { 'notes-counter': EXAMPLE_PLUGIN } });
    owner = await t.owner();
    await t.installAndEnable(owner, 'notes-counter');
    expect((await t.callTool(owner.userId!, 'plugin_notes_counter_add_note', { text: 'remember me' })).text).toBe('Saved note #1.');
    // The plugin's process wrote nothing itself; give its data folder a file as a real plugin might.
    await writeFile(path.join(t.pluginDataDir, 'notes-counter', 'cache.json'), '{}');
  };
  const stored = () => t.studio.context.db.all<{ key: string }>('SELECT key FROM plugin_storage WHERE plugin_id = ?', 'notes-counter').map((row) => row.key);

  it('removes the code, the process, the tools and the grants — and keeps the data unless told otherwise', async () => {
    await setUp();
    const grant = await t.openPanel(owner, 'notes-counter', 'notes');
    const pid = t.studio.context.services.plugins.processId('notes-counter');
    expect(pid).toBeGreaterThan(0);

    expect((await owner.post('/api/plugins/notes-counter/uninstall', {})).status).toBe(204);
    expect(existsSync(path.join(t.pluginsDir, 'notes-counter'))).toBe(false);
    expect((await owner.get('/api/plugins/notes-counter')).status).toBe(404);
    expect(t.studio.context.agentTools.list().filter((tool) => tool.name.startsWith('plugin_'))).toEqual([]);
    expect((await t.anonymous().get(grant.url)).status).toBe(404);
    expect(() => process.kill(pid!, 0)).toThrow();
    // Kept: what the plugin stored.
    expect(stored().sort()).toEqual(['notes', 'total']);
    expect(await readdir(path.join(t.pluginDataDir, 'notes-counter'))).toContain('cache.json');
    const events = (await owner.get<{ events: { action: string; detail: string }[] }>('/api/audit?limit=50')).body.events;
    expect(events.find((event) => event.action === 'plugin.uninstalled')).toMatchObject({ detail: 'its data was kept' });

    // Installing a plugin with the same id again says that it inherits that data.
    const again = await t.install(owner, 'notes-counter');
    expect(again).toMatchObject({ enabled: false, retainedData: true, approval: { state: 'none' }, permissions: { granted: [] } });
    await t.enable(owner, 'notes-counter');
    expect((await t.callTool(owner.userId!, 'plugin_notes_counter_count_notes', {})).text).toContain('1 note saved.');
  });

  it('removes the data too when asked', async () => {
    await setUp();
    expect((await owner.post('/api/plugins/notes-counter/uninstall', { deleteData: true })).status).toBe(204);
    expect(existsSync(path.join(t.pluginsDir, 'notes-counter'))).toBe(false);
    expect(existsSync(path.join(t.pluginDataDir, 'notes-counter'))).toBe(false);
    expect(stored()).toEqual([]);
    expect((await owner.post('/api/plugins/notes-counter/uninstall', {})).status).toBe(404);
    expect((await t.install(owner, 'notes-counter')).retainedData).toBe(false);
    expect((await owner.get<{ plugins: PluginSummary[] }>('/api/plugins')).body.plugins).toHaveLength(1);
  });
});
