import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FolderListing, Project, ProjectLinkStatus } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';

let t: TestStudio;
let owner: TestClient;
beforeEach(async () => {
  t = await createTestStudio();
  owner = await t.owner();
});
afterEach(async () => {
  await t.close();
});

async function makeProject(name: string, extra: Record<string, unknown> = {}): Promise<Project> {
  const response = await owner.post<Project>('/api/projects', { name, rootDir: path.join(t.workspace, name), createDirectory: true, ...extra });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

async function share(project: Project, member: TestClient, access: 'read' | 'write'): Promise<void> {
  expect((await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access })).status).toBe(204);
}

function eventsOn(topic: string): StudioEvent[] {
  const events: StudioEvent[] = [];
  t.studio.context.bus.onTopic(topic, (event) => events.push(event));
  return events;
}

const MISSING = '00000000000000000000000000';

describe('new project fields', () => {
  it('gives every project its defaults', async () => {
    const project = await makeProject('plain');
    expect(project).toMatchObject({
      links: [],
      agents: null,
      features: { assistant: true, automation: false },
      scratch: false,
      pinned: false,
      lastOpenedAt: null,
    });
  });

  it('accepts links, agents and features at creation', async () => {
    const project = await makeProject('rich', {
      links: [{ label: 'Docs', url: 'https://docs.example.org/guide' }],
      agents: ['claude-code'],
      features: { automation: true },
    });
    expect(project.links).toHaveLength(1);
    expect(project.links[0]).toMatchObject({ label: 'Docs', url: 'https://docs.example.org/guide', local: false });
    expect(project.agents).toEqual(['claude-code']);
    expect(project.features).toEqual({ assistant: true, automation: true });
  });

  it('creates nothing when a new project is refused for its settings', async () => {
    const rootDir = path.join(t.workspace, 'refused');
    const response = await owner.post('/api/projects', { name: 'refused', rootDir, createDirectory: true, agents: [], features: { assistant: true } });
    expect(response.body).toMatchObject({ error: { code: 'agents_required' } });
    expect(existsSync(rootDir)).toBe(false);
  });
});

describe('pins', () => {
  it('keeps an ordered list per user and tells the other devices', async () => {
    const [a, b, c] = [await makeProject('a'), await makeProject('b'), await makeProject('c')];
    const events = eventsOn(`user:${owner.userId}`);
    expect((await owner.get('/api/projects/pins')).body).toEqual({ projectIds: [] });

    expect((await owner.put('/api/projects/pins', { projectIds: [c.id, a.id] })).body).toEqual({ projectIds: [c.id, a.id] });
    expect(events.filter((event) => event.type === 'projects.pins.changed').map((event) => event.data)).toEqual([{ projectIds: [c.id, a.id] }]);

    // A second device of the same account sees the same order.
    const otherDevice = await t.signIn('owner');
    expect((await otherDevice.get('/api/projects/pins')).body).toEqual({ projectIds: [c.id, a.id] });
    const listed = (await otherDevice.get<{ projects: Project[] }>('/api/projects')).body.projects;
    expect(Object.fromEntries(listed.map((project) => [project.name, project.pinned]))).toEqual({ a: true, b: false, c: true });
    expect((await otherDevice.get<Project>(`/api/projects/${c.id}`)).body.pinned).toBe(true);

    // Reordering and unpinning replace the list.
    expect((await owner.put('/api/projects/pins', { projectIds: [a.id, b.id, c.id] })).body).toEqual({ projectIds: [a.id, b.id, c.id] });
    expect((await owner.put('/api/projects/pins', { projectIds: [b.id] })).body).toEqual({ projectIds: [b.id] });
    expect((await owner.get<Project>(`/api/projects/${a.id}`)).body.pinned).toBe(false);
  });

  it('are personal: one user’s pins are not another’s', async () => {
    const project = await makeProject('shared');
    const member = await t.member('alice');
    await share(project, member, 'read');
    await owner.put('/api/projects/pins', { projectIds: [project.id] });
    expect((await member.get('/api/projects/pins')).body).toEqual({ projectIds: [] });
    expect((await member.get<Project>(`/api/projects/${project.id}`)).body.pinned).toBe(false);
    // A read-only member may still pin: it changes nothing about the project.
    expect((await member.put('/api/projects/pins', { projectIds: [project.id] })).status).toBe(200);
    expect((await member.get<Project>(`/api/projects/${project.id}`)).body.pinned).toBe(true);
  });

  it('refuses projects the caller cannot see, duplicates, and anonymous callers', async () => {
    const visible = await makeProject('visible');
    const hidden = await makeProject('hidden');
    const member = await t.member('alice');
    await share(visible, member, 'read');

    const refused = await member.put('/api/projects/pins', { projectIds: [visible.id, hidden.id] });
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual((await member.put('/api/projects/pins', { projectIds: [MISSING] })).body);
    expect((await member.get('/api/projects/pins')).body).toEqual({ projectIds: [] });

    expect((await owner.put('/api/projects/pins', { projectIds: [visible.id, visible.id] })).status).toBe(400);
    expect((await owner.put('/api/projects/pins', { projectIds: ['not-an-id'] })).status).toBe(400);
    expect((await owner.put('/api/projects/pins', { projectIds: Array.from({ length: 51 }, () => visible.id) })).status).toBe(400);
    expect((await t.anonymous().get('/api/projects/pins')).status).toBe(401);
    expect((await t.anonymous().put('/api/projects/pins', { projectIds: [] })).status).toBe(401);
  });

  it('drops a pin when the project is no longer shared or is removed', async () => {
    const project = await makeProject('shared');
    const member = await t.member('alice');
    await share(project, member, 'read');
    await member.put('/api/projects/pins', { projectIds: [project.id] });
    await owner.delete(`/api/projects/${project.id}/members/${member.userId}`);
    expect((await member.get('/api/projects/pins')).body).toEqual({ projectIds: [] });

    await owner.put('/api/projects/pins', { projectIds: [project.id] });
    await owner.delete(`/api/projects/${project.id}`);
    expect((await owner.get('/api/projects/pins')).body).toEqual({ projectIds: [] });
  });
});

describe('recently opened', () => {
  it('records when a user opened a project, per user', async () => {
    const project = await makeProject('recent');
    const member = await t.member('alice');
    await share(project, member, 'read');
    const events = eventsOn(`user:${owner.userId}`);

    const before = Date.now();
    const opened = await owner.post<{ projectId: string; lastOpenedAt: number }>(`/api/projects/${project.id}/opened`);
    expect(opened.status).toBe(200);
    expect(opened.body.lastOpenedAt).toBeGreaterThanOrEqual(before);
    expect((await owner.get<Project>(`/api/projects/${project.id}`)).body.lastOpenedAt).toBe(opened.body.lastOpenedAt);
    expect((await owner.get<{ projects: Project[] }>('/api/projects')).body.projects[0]!.lastOpenedAt).toBe(opened.body.lastOpenedAt);
    expect(events.find((event) => event.type === 'project.opened')?.data).toEqual({ projectId: project.id, lastOpenedAt: opened.body.lastOpenedAt });

    // The member has not opened it; and opening does not disturb a pin.
    expect((await member.get<Project>(`/api/projects/${project.id}`)).body.lastOpenedAt).toBeNull();
    await owner.put('/api/projects/pins', { projectIds: [project.id] });
    await owner.post(`/api/projects/${project.id}/opened`);
    expect((await owner.get<Project>(`/api/projects/${project.id}`)).body).toMatchObject({ pinned: true });
  });

  it('answers 404 for a project the caller cannot see and 401 without a session', async () => {
    const project = await makeProject('hidden');
    const member = await t.member('alice');
    expect((await member.post(`/api/projects/${project.id}/opened`)).status).toBe(404);
    expect((await member.post(`/api/projects/${MISSING}/opened`)).status).toBe(404);
    expect((await t.anonymous().post(`/api/projects/${project.id}/opened`)).status).toBe(401);
  });
});

describe('links', () => {
  const eight = Array.from({ length: 8 }, (_, index) => ({ label: `Link ${index + 1}`, url: `https://example.org/${index + 1}` }));

  it('stores up to eight validated links and keeps their ids across edits', async () => {
    const project = await makeProject('linked');
    const saved = await owner.patch<Project>(`/api/projects/${project.id}`, { links: eight });
    expect(saved.status).toBe(200);
    expect(saved.body.links.map((link) => link.label)).toEqual(eight.map((link) => link.label));
    expect(new Set(saved.body.links.map((link) => link.id)).size).toBe(8);

    const [first, second] = saved.body.links;
    const edited = await owner.patch<Project>(`/api/projects/${project.id}`, {
      links: [{ id: second!.id, label: 'Renamed', url: second!.url }, { label: 'Brand new', url: 'http://plain.example.org/' }],
    });
    expect(edited.body.links).toHaveLength(2);
    expect(edited.body.links[0]).toMatchObject({ id: second!.id, label: 'Renamed' });
    expect(edited.body.links[1]!.id).not.toBe(first!.id);
    expect((await owner.patch<Project>(`/api/projects/${project.id}`, { links: [] })).body.links).toEqual([]);
  });

  it.each([
    ['nine links', [...eight, { label: 'Nine', url: 'https://example.org/9' }]],
    ['a script address', [{ label: 'x', url: 'javascript:alert(1)' }]],
    ['a data address', [{ label: 'x', url: 'data:text/html,<script>alert(1)</script>' }]],
    ['a file address', [{ label: 'x', url: 'file:///etc/passwd' }]],
    ['an ftp address', [{ label: 'x', url: 'ftp://example.org/' }]],
    ['something that is not an address', [{ label: 'x', url: 'not a url' }]],
    ['a link-local address', [{ label: 'x', url: 'http://169.254.169.254/latest/meta-data/' }]],
    ['an IPv6 link-local address', [{ label: 'x', url: 'http://[fe80::1]/' }]],
    ['a blank label', [{ label: '   ', url: 'https://example.org/' }]],
    ['a label of 41 characters', [{ label: 'x'.repeat(41), url: 'https://example.org/' }]],
    ['an address of 501 characters', [{ label: 'x', url: `https://example.org/${'a'.repeat(490)}` }]],
  ])('refuses %s and changes nothing', async (_what, links) => {
    const project = await makeProject('strict');
    await owner.patch(`/api/projects/${project.id}`, { links: [{ label: 'Kept', url: 'https://kept.example.org/' }] });
    expect((await owner.patch(`/api/projects/${project.id}`, { links })).status).toBe(400);
    expect((await owner.get<Project>(`/api/projects/${project.id}`)).body.links.map((link) => link.label)).toEqual(['Kept']);
  });

  it('refuses credentials inside an address without repeating them', async () => {
    const project = await makeProject('strict');
    const response = await owner.patch(`/api/projects/${project.id}`, { links: [{ label: 'x', url: 'https://admin:hunter2secret@example.org/' }] });
    expect(response.body).toMatchObject({ error: { code: 'invalid_link' } });
    expect(JSON.stringify(response.body)).not.toContain('hunter2secret');
  });

  it('lets only the owner mark a link as local, and lets members edit the rest', async () => {
    const project = await makeProject('shared');
    const member = await t.member('alice');
    await share(project, member, 'write');
    const withLocal = await owner.patch<Project>(`/api/projects/${project.id}`, {
      links: [{ label: 'Dev server', url: 'http://127.0.0.1:5173/', local: true }],
    });
    const local = withLocal.body.links[0]!;
    expect(local.local).toBe(true);

    // A member cannot create a local link, nor point an existing one somewhere else…
    expect((await member.patch(`/api/projects/${project.id}`, { links: [{ label: 'Mine', url: 'http://10.0.0.5/', local: true }] })).body).toMatchObject({ error: { code: 'owner_required' } });
    expect((await member.patch(`/api/projects/${project.id}`, { links: [{ id: local.id, label: 'Dev server', url: 'http://127.0.0.1:22/', local: true }] })).status).toBe(403);
    // …but may keep it as it is while adding ordinary links, or relabel it.
    const edited = await member.patch<Project>(`/api/projects/${project.id}`, {
      links: [{ id: local.id, label: 'Dev', url: local.url, local: true }, { label: 'Docs', url: 'https://docs.example.org/' }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.links.map((link) => [link.label, link.local])).toEqual([['Dev', true], ['Docs', false]]);
  });

  it('is closed to read-only members, strangers and anonymous callers', async () => {
    const project = await makeProject('shared');
    const reader = await t.member('reader');
    const stranger = await t.member('stranger');
    await share(project, reader, 'read');
    const links = [{ label: 'x', url: 'https://example.org/' }];
    expect((await reader.patch(`/api/projects/${project.id}`, { links })).body).toMatchObject({ error: { code: 'project_read_only' } });
    expect((await stranger.patch(`/api/projects/${project.id}`, { links })).status).toBe(404);
    expect((await t.anonymous().patch(`/api/projects/${project.id}`, { links })).status).toBe(401);
    expect((await owner.get<Project>(`/api/projects/${project.id}`)).body.links).toEqual([]);
  });
});

describe('link reachability', () => {
  let server: http.Server;
  let port: number;
  let requests: string[];

  beforeEach(async () => {
    requests = [];
    server = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const url = request.url ?? '/';
      if (url === '/fail') return void response.writeHead(500).end('SECRET-BODY');
      if (url === '/nohead' && request.method === 'HEAD') return void response.writeHead(405).end();
      if (url === '/to-metadata') return void response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      if (url === '/to-ok') return void response.writeHead(302, { location: '/ok' }).end();
      if (url === '/loop') return void response.writeHead(302, { location: '/loop' }).end();
      if (url === '/framed') return void response.writeHead(200, { 'x-frame-options': 'DENY' }).end('SECRET-BODY');
      if (url === '/csp') return void response.writeHead(200, { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }).end();
      if (url === '/slow') return void setTimeout(() => response.writeHead(200).end(), 10_000).unref();
      return void response.writeHead(200, { 'content-type': 'text/html' }).end('SECRET-BODY');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function statusOf(project: Project, client: TestClient = owner): Promise<Record<string, ProjectLinkStatus>> {
    const current = (await owner.get<Project>(`/api/projects/${project.id}`)).body;
    const response = await client.get<{ links: ProjectLinkStatus[] }>(`/api/projects/${project.id}/links/status`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('SECRET-BODY');
    const labels = new Map(current.links.map((link) => [link.id, link.label]));
    return Object.fromEntries(response.body.links.map((status) => [labels.get(status.linkId)!, status]));
  }

  const local = (label: string, pathname: string) => ({ label, url: `http://127.0.0.1:${port}${pathname}`, local: true });

  it('reports status and latency for local links, and never the body', async () => {
    const closed = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const free = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(free));
      });
    });
    const project = await makeProject('probed', {
      links: [
        local('ok', '/ok'),
        local('fail', '/fail'),
        local('nohead', '/nohead'),
        local('redirected', '/to-ok'),
        local('framed', '/framed'),
        local('csp', '/csp'),
        { label: 'closed', url: `http://127.0.0.1:${closed}/`, local: true },
      ],
    });
    const status = await statusOf(project);
    expect(status.ok).toMatchObject({ state: 'ok', status: 200, frameable: true });
    expect(status.ok!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(status.ok!).sort()).toEqual(['checkedAt', 'frameable', 'latencyMs', 'linkId', 'state', 'status']);
    expect(status.fail).toMatchObject({ state: 'http_error', status: 500 });
    expect(status.nohead).toMatchObject({ state: 'ok', status: 200 });
    expect(status.redirected).toMatchObject({ state: 'ok', status: 200 });
    expect(status.framed).toMatchObject({ state: 'ok', frameable: false });
    expect(status.csp).toMatchObject({ state: 'ok', frameable: false });
    expect(status.closed).toMatchObject({ state: 'unreachable', status: null, latencyMs: null, frameable: null });
    // The site was asked for headers only, and only falls back to GET when HEAD is refused.
    expect(requests).toContain('HEAD /ok');
    expect(requests).not.toContain('GET /ok');
    expect(requests).toContain('GET /nohead');
  });

  it('never contacts a private address for a link that is not marked local', async () => {
    const project = await makeProject('unmarked', {
      links: [
        { label: 'loopback', url: `http://127.0.0.1:${port}/ok` },
        { label: 'localhost', url: `http://localhost:${port}/ok` },
        { label: 'private', url: 'http://10.255.255.1/' },
      ],
    });
    const status = await statusOf(project);
    expect(status.loopback).toMatchObject({ state: 'blocked', status: null });
    expect(status.localhost).toMatchObject({ state: 'blocked', status: null });
    expect(status.private).toMatchObject({ state: 'blocked', status: null });
    expect(requests).toEqual([]);
  });

  it('refuses to follow a redirect to a link-local address, or redirects without end', async () => {
    const project = await makeProject('redirects', { links: [local('metadata', '/to-metadata'), local('loop', '/loop')] });
    const status = await statusOf(project);
    expect(status.metadata).toMatchObject({ state: 'blocked', status: null });
    expect(status.loop).toMatchObject({ state: 'blocked', status: null });
    expect(requests.filter((request) => request.endsWith('/loop')).length).toBeLessThanOrEqual(5);
  });

  it('reuses a recent answer instead of asking the site again', async () => {
    const project = await makeProject('cached', { links: [local('ok', '/ok')] });
    await statusOf(project);
    await statusOf(project);
    await owner.get(`/api/projects/${project.id}/links/status?refresh=true`);
    expect(requests).toEqual(['HEAD /ok']);
  });

  it('probes only stored links: there is no way to name an address in the request', async () => {
    const project = await makeProject('narrow', { links: [local('ok', '/ok')] });
    const response = await owner.get<{ links: ProjectLinkStatus[] }>(`/api/projects/${project.id}/links/status?url=http://127.0.0.1:${port}/fail&link=http://127.0.0.1:${port}/fail`);
    expect(response.body.links).toHaveLength(1);
    expect(requests).toEqual(['HEAD /ok']);
  });

  it('is open to members of the project and to nobody else', async () => {
    const project = await makeProject('shared', { links: [local('ok', '/ok')] });
    const reader = await t.member('reader');
    const stranger = await t.member('stranger');
    await share(project, reader, 'read');
    expect((await statusOf(project, reader)).ok).toMatchObject({ state: 'ok' });
    expect((await stranger.get(`/api/projects/${project.id}/links/status`)).status).toBe(404);
    expect((await t.anonymous().get(`/api/projects/${project.id}/links/status`)).status).toBe(401);
  });
});

describe('agents and feature switches', () => {
  it('lets the owner choose agents and features, with typed accessors for other modules', async () => {
    const project = await makeProject('configured');
    const projects = t.studio.context.services.projects;
    expect(projects.isAgentEnabled(projects.find(project.id)!, 'anything')).toBe(true);
    expect(projects.isFeatureEnabled(projects.find(project.id)!, 'automation')).toBe(false);

    const updated = await owner.patch<Project>(`/api/projects/${project.id}`, { agents: ['claude-code', 'codex'], features: { automation: true } });
    expect(updated.body).toMatchObject({ agents: ['claude-code', 'codex'], features: { assistant: true, automation: true } });
    const record = projects.find(project.id)!;
    expect(projects.isAgentEnabled(record, 'codex')).toBe(true);
    expect(projects.isAgentEnabled(record, 'other')).toBe(false);
    expect(projects.isFeatureEnabled(record, 'automation')).toBe(true);
    expect(projects.settingsOf(record)).toMatchObject({ agents: ['claude-code', 'codex'], scratch: false });

    // Turning the assistant off allows an empty agent list; null offers every agent again.
    expect((await owner.patch<Project>(`/api/projects/${project.id}`, { agents: [], features: { assistant: false } })).body).toMatchObject({ agents: [], features: { assistant: false, automation: true } });
    expect((await owner.patch<Project>(`/api/projects/${project.id}`, { agents: null, features: { assistant: true } })).body.agents).toBeNull();
  });

  it.each([
    ['a duplicate agent', { agents: ['codex', 'codex'] }, 400],
    ['the assistant without any agent', { agents: [] }, 400],
    ['an agent id with odd characters', { agents: ['Not Valid!'] }, 400],
    ['an agent id that looks like an option', { agents: ['--dangerously-skip'] }, 400],
    ['a feature that is not a boolean', { features: { automation: 'true' } }, 400],
    ['twenty-one agents', { agents: Array.from({ length: 21 }, (_, index) => `agent-${index}`) }, 400],
  ])('refuses %s', async (_what, body, status) => {
    const project = await makeProject('strict');
    expect((await owner.patch(`/api/projects/${project.id}`, body)).status).toBe(status);
    expect((await owner.get<Project>(`/api/projects/${project.id}`)).body).toMatchObject({ agents: null, features: { assistant: true, automation: false } });
  });

  it('keeps these switches the owner’s, even from a member who may write', async () => {
    const project = await makeProject('shared');
    const member = await t.member('alice');
    await share(project, member, 'write');
    expect((await member.patch(`/api/projects/${project.id}`, { agents: ['codex'] })).body).toMatchObject({ error: { code: 'owner_required' } });
    expect((await member.patch(`/api/projects/${project.id}`, { features: { automation: true } })).status).toBe(403);
    expect((await member.patch(`/api/projects/${project.id}`, { name: 'still allowed' })).status).toBe(200);
  });

  it('leaves the settings of other features alone', async () => {
    const project = await makeProject('bag');
    const projects = t.studio.context.services.projects;
    projects.patchSettings(project.id, { 'someone.else': { keep: 'me' } });
    await owner.patch(`/api/projects/${project.id}`, { links: [{ label: 'x', url: 'https://example.org/' }], agents: ['codex'] });
    await owner.patch(`/api/projects/${project.id}`, { name: 'renamed' });
    expect(projects.find(project.id)!.settings['someone.else']).toEqual({ keep: 'me' });
    expect((await owner.get<Project>(`/api/projects/${project.id}`)).body).toMatchObject({ name: 'renamed', agents: ['codex'] });
  });
});

describe('folder browser', () => {
  beforeEach(async () => {
    for (const folder of ['zeta', 'Alpha', 'beta/inner', '.hidden', 'node_modules/pkg', 'dist', '__pycache__']) {
      await mkdir(path.join(t.workspace, folder), { recursive: true });
    }
    await writeFile(path.join(t.workspace, 'a-file.txt'), 'x');
  });

  it('lists folders only, without hidden and clutter folders, in name order', async () => {
    const project = await makeProject('registered');
    const listing = (await owner.get<FolderListing>('/api/projects/browse')).body;
    expect(listing.path).toBe(t.workspace);
    expect(listing.parent).toBeNull();
    expect(listing.entries.map((entry) => entry.name)).toEqual(['Alpha', 'beta', 'registered', 'zeta']);
    expect(listing.entries.find((entry) => entry.name === 'registered')!.projectId).toBe(project.id);
    expect(listing.entries.find((entry) => entry.name === 'beta')).toMatchObject({ path: path.join(t.workspace, 'beta'), projectId: null });
    expect(listing.roots.map((root) => root.path)).toEqual([t.workspace]);
    expect(listing.truncated).toBe(false);

    const inner = (await owner.get<FolderListing>(`/api/projects/browse?path=${encodeURIComponent(path.join(t.workspace, 'beta'))}`)).body;
    expect(inner).toMatchObject({ path: path.join(t.workspace, 'beta'), parent: t.workspace, selectable: true });
    expect(inner.entries.map((entry) => entry.name)).toEqual(['inner']);
  });

  it.each([
    ['/etc', 403],
    ['/', 403],
    [os.tmpdir(), 403],
    ['relative/path', 400],
  ])('refuses to look at %s', async (target, status) => {
    expect((await owner.get(`/api/projects/browse?path=${encodeURIComponent(target)}`)).status).toBe(status);
  });

  it('refuses paths that climb out, files, missing folders and links that leave', async () => {
    const outside = path.join(path.dirname(t.workspace), 'outside');
    await mkdir(path.join(outside, 'private'), { recursive: true });
    await symlink(outside, path.join(t.workspace, 'escape'));
    const browse = (target: string) => owner.get<FolderListing>(`/api/projects/browse?path=${encodeURIComponent(target)}`);

    expect((await browse(path.join(t.workspace, '..', 'outside'))).status).toBe(403);
    expect((await browse(`${t.workspace}/beta/../../outside`)).status).toBe(403);
    expect((await browse(path.join(t.workspace, 'escape'))).body).toMatchObject({ error: { code: 'outside_workspace' } });
    expect((await browse(path.join(t.workspace, 'escape', 'private'))).status).toBe(403);
    expect((await browse(path.join(t.workspace, 'a-file.txt'))).body).toMatchObject({ error: { code: 'not_a_directory' } });
    expect((await browse(path.join(t.workspace, 'nope'))).status).toBe(404);
    expect((await browse(`${t.workspace}\0/etc`)).status).toBe(400);
    // The escaping link is not even offered.
    expect((await browse(t.workspace)).body.entries.map((entry) => entry.name)).not.toContain('escape');
  });

  it("never shows the Studio's own data or system folders, however wide the roots are", async () => {
    const wide = await createTestStudio({ config: { workspaceRoots: [path.dirname(t.dataDir), '/'] } });
    try {
      const admin = await wide.owner();
      const around = (await admin.get<FolderListing>(`/api/projects/browse?path=${encodeURIComponent(path.dirname(wide.dataDir))}`)).body;
      expect(around.entries.map((entry) => entry.name)).toEqual(['workspace']);
      expect((await admin.get(`/api/projects/browse?path=${encodeURIComponent(wide.dataDir)}`)).status).toBe(403);
      const top = (await admin.get<FolderListing>('/api/projects/browse?path=%2F')).body;
      expect(top.selectable).toBe(false);
      for (const name of ['etc', 'proc', 'sys', 'dev', 'usr', 'bin']) expect(top.entries.map((entry) => entry.name)).not.toContain(name);
      // Without a path and with several roots, the roots themselves are the answer.
      expect((await admin.get<FolderListing>('/api/projects/browse')).body).toMatchObject({ path: null, selectable: false });
    } finally {
      await wide.close();
    }
  });

  it('is for the owner only', async () => {
    const member = await t.member('alice');
    expect((await member.get('/api/projects/browse')).body).toMatchObject({ error: { code: 'owner_required' } });
    expect((await t.anonymous().get('/api/projects/browse')).status).toBe(401);
  });
});

describe('scratch workspace', () => {
  it('is created on first use, found again afterwards, and revived when archived', async () => {
    const created = await owner.post<Project>('/api/projects/scratch');
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ scratch: true, archived: false, rootDir: path.join(t.workspace, 'studio-scratch') });
    expect(existsSync(created.body.rootDir)).toBe(true);

    expect((await owner.post<Project>('/api/projects/scratch')).body.id).toBe(created.body.id);
    expect((await owner.get<{ projects: Project[] }>('/api/projects')).body.projects.filter((project) => project.scratch)).toHaveLength(1);

    // Renamed, archived and with its folder deleted by hand: still the same workspace, usable again.
    await owner.patch(`/api/projects/${created.body.id}`, { name: 'My scratchpad', archived: true });
    await rm(created.body.rootDir, { recursive: true });
    const again = await owner.post<Project>('/api/projects/scratch');
    expect(again.body).toMatchObject({ id: created.body.id, name: 'My scratchpad', archived: false, scratch: true });
    expect(existsSync(created.body.rootDir)).toBe(true);
  });

  it('adopts a project that already lives in the scratch folder', async () => {
    const existing = await makeProject('studio-scratch');
    const scratch = await owner.post<Project>('/api/projects/scratch');
    expect(scratch.body).toMatchObject({ id: existing.id, scratch: true });
  });

  it('is the owner’s to create', async () => {
    const member = await t.member('alice');
    expect((await member.post('/api/projects/scratch')).status).toBe(403);
    expect((await t.anonymous().post('/api/projects/scratch')).status).toBe(401);
    expect(existsSync(path.join(t.workspace, 'studio-scratch'))).toBe(false);
  });
});
