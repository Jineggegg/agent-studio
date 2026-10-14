import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  createSession,
  runToEnd,
  shareProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.1–6.3 — Projects: where one may live, who may see and change it, and what
 * follows the account (requirements 02 §6.1–6.3, §7.2, §7.10).
 *
 * Deliberate differences: only the instance owner creates projects; a project
 * is shared with a member explicitly, read-only or with write access. Home
 * screen "cards" and workspace projects are one thing here, so the card tests
 * are adapted to the project record (name, links). Not built: discovery of
 * folders an agent was run in outside the product (AT-PJ-009).
 */
describe('6.1 projects: location rules, access, links', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let workspace: string;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    workspace = studio.workspace;
  });
  afterAll(() => studio?.destroy());

  const register = (body: Record<string, unknown>, client: ApiClient = owner) =>
    client.post<Json>('/api/projects', body);
  const active = async (client: ApiClient = owner) =>
    (await client.get<{ projects: Project[] }>('/api/projects')).body.projects;

  it('AT-PJ-001: registering an existing empty folder inside the workspace root gives a new project that appears in the list', async () => {
    const folder = path.join(workspace, 'first-project');
    await mkdir(folder);
    const created = await register({ name: 'first-project', rootDir: folder });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'first-project',
      rootDir: folder,
      access: 'write',
      archived: false,
    });
    expect(created.body.id).toMatch(/^[0-9a-z]{26}$/);
    expect((await active()).map((project) => project.id)).toContain(created.body.id);
    expect((await owner.get<Json>(`/api/projects/${created.body.id}`)).body.rootDir).toBe(folder);
  });

  it('AT-PJ-002: a path whose last two folders do not exist is created on request — and refused, creating nothing, when not asked to', async () => {
    const deep = path.join(workspace, 'made', 'on-demand');
    const refused = await register({ name: 'deep', rootDir: deep });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('folder_missing');
    expect(existsSync(path.join(workspace, 'made'))).toBe(false);
    const created = await register({ name: 'deep', rootDir: deep, createDirectory: true });
    expect(created.status).toBe(201);
    expect(existsSync(deep)).toBe(true);
    expect((await active()).map((project) => project.rootDir)).toContain(deep);
  });

  it('AT-PJ-003/004: the same folder cannot be registered twice — not as written, nor with a trailing, doubled or "./" separator', async () => {
    const folder = path.join(workspace, 'only-once');
    await mkdir(folder);
    expect((await register({ name: 'only-once', rootDir: folder })).status).toBe(201);
    for (const spelling of [
      folder,
      `${folder}/`,
      `${workspace}//only-once`,
      `${workspace}/./only-once`,
      `${workspace}/first-project/../only-once`,
    ]) {
      const again = await register({ name: 'duplicate', rootDir: spelling });
      expect(again.status, spelling).toBe(409);
      expect(again.body.error.code).toBe('project_exists');
    }
    expect((await active()).filter((project) => project.rootDir === folder)).toHaveLength(1);
  });

  it('AT-PJ-005/006/008: the file-system root, a system folder, the temporary folder, a folder outside the workspace root, a relative or blank path are all refused and nothing is created', async () => {
    const outside = path.join(workspace, '..', 'outside-the-root');
    const before = (await active()).length;
    for (const rootDir of [
      '/',
      '/etc',
      '/tmp',
      '/usr/local',
      outside,
      path.join(workspace, '..', '..'),
    ]) {
      const refused = await register({ name: 'nope', rootDir, createDirectory: true });
      expect(refused.status, rootDir).toBe(403);
      expect(refused.body.error.code).toBe('outside_workspace');
      expect(refused.body.error.message).toContain('workspace'); // the reason names the allowed place
    }
    expect(existsSync(outside)).toBe(false);
    for (const rootDir of ['', '   ', 'relative/path', './here']) {
      const refused = await register({ name: 'nope', rootDir, createDirectory: true });
      expect(refused.status, JSON.stringify(rootDir)).toBe(400);
    }
    expect((await active()).length).toBe(before);
  });

  it('AT-PJ-007: a link inside the workspace root that points outside it cannot be registered, and nor can a folder beneath it', async () => {
    const target = path.join(workspace, '..', 'outside-target');
    await mkdir(target);
    await symlink(target, path.join(workspace, 'way-out'));
    for (const rootDir of [
      path.join(workspace, 'way-out'),
      path.join(workspace, 'way-out', 'child'),
    ]) {
      const refused = await register({ name: 'escape', rootDir, createDirectory: true });
      expect(refused.status, rootDir).toBe(403);
      expect(refused.body.error.code).toBe('outside_workspace');
    }
    expect(existsSync(path.join(target, 'child'))).toBe(false);
  });

  it('AT-PJ-010/027 (adapted): renaming changes the display name and never the folder; a blank or 81-character name is refused, 80 characters are accepted', async () => {
    const project = await createProject(studio, owner, 'rename-me');
    const renamed = await owner.patch<Json>(`/api/projects/${project.id}`, { name: 'Demo' });
    expect(renamed.body).toMatchObject({ name: 'Demo', rootDir: project.rootDir });
    expect(existsSync(project.rootDir)).toBe(true);
    expect((await active()).find((item) => item.id === project.id)!.name).toBe('Demo');
    expect((await owner.patch(`/api/projects/${project.id}`, { name: '   ' })).status).toBe(400);
    expect(
      (await owner.patch(`/api/projects/${project.id}`, { name: 'x'.repeat(81) })).status,
    ).toBe(400);
    expect(
      (await owner.patch<Json>(`/api/projects/${project.id}`, { name: 'x'.repeat(80) })).body.name,
    ).toHaveLength(80);
  });

  it('AT-PJ-011: an archived project leaves the active list with its conversations intact, the folder untouched; restoring brings it back under the same id', async () => {
    const project = await createProject(studio, owner, 'archive-me');
    await writeFile(path.join(project.rootDir, 'keep.txt'), 'still here');
    const one = await createSession(owner, project.id);
    const two = await createSession(owner, project.id);
    await runToEnd(owner, one.id, 'remember this conversation');
    expect(
      (await owner.patch<Json>(`/api/projects/${project.id}`, { archived: true })).body.archived,
    ).toBe(true);
    expect((await active()).map((item) => item.id)).not.toContain(project.id);
    const all = (await owner.get<{ projects: Project[] }>('/api/projects?archived=include')).body
      .projects;
    expect(all.find((item) => item.id === project.id)).toMatchObject({ archived: true });
    expect(readFileSync(path.join(project.rootDir, 'keep.txt'), 'utf8')).toBe('still here');
    const kept = (
      await owner.get<{ sessions: Array<{ id: string }> }>(`/api/sessions?projectId=${project.id}`)
    ).body.sessions.map((row) => row.id);
    expect(kept.sort()).toEqual([one.id, two.id].sort());

    expect(
      (await owner.patch<Json>(`/api/projects/${project.id}`, { archived: false })).body,
    ).toMatchObject({ id: project.id, archived: false });
    expect((await active()).map((item) => item.id)).toContain(project.id);
    expect(
      (await owner.get<{ events: unknown[] }>(`/api/sessions/${one.id}/events`)).body.events.length,
    ).toBeGreaterThan(0);
  });

  it('AT-PJ-013: deleting a project removes it and its conversations from every list — the folder and the files in it stay', async () => {
    const project = await createProject(studio, owner, 'delete-me');
    await writeFile(path.join(project.rootDir, 'keep.txt'), 'not the product’s to delete');
    const session = await createSession(owner, project.id);
    await runToEnd(owner, session.id, 'a conversation that goes with the project');
    expect((await owner.delete(`/api/projects/${project.id}`)).status).toBe(204);
    expect((await owner.get(`/api/projects/${project.id}`)).status).toBe(404);
    expect(
      (
        await owner.get<{ projects: Project[] }>('/api/projects?archived=include')
      ).body.projects.map((item) => item.id),
    ).not.toContain(project.id);
    expect((await owner.get(`/api/sessions/${session.id}`)).status).toBe(404);
    expect(
      (
        await owner.get<{ sessions: Array<{ id: string }> }>(
          '/api/sessions?scope=all&archived=include',
        )
      ).body.sessions.map((row) => row.id),
    ).not.toContain(session.id);
    expect(readFileSync(path.join(project.rootDir, 'keep.txt'), 'utf8')).toBe(
      'not the product’s to delete',
    );
    // The folder is free to become a project again — a new one.
    const again = await register({ name: 'delete-me', rootDir: project.rootDir });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(project.id);
  });

  it('AT-PJ-014: registering the folder of an archived project reactivates that project and returns its original id and name', async () => {
    const project = await createProject(studio, owner, 'come-back');
    await owner.patch(`/api/projects/${project.id}`, { archived: true });
    expect((await active()).map((item) => item.id)).not.toContain(project.id);
    // Only the owner adds folders — a member gets no way round that by naming an archived one.
    const member = await createMember(studio, owner, 'returner');
    const byMember = await register({ name: 'mine now', rootDir: project.rootDir }, member);
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.code).toBe('owner_required');

    const again = await register({ name: 'another name', rootDir: project.rootDir });
    expect(again.status).toBeLessThan(300);
    expect(again.body).toMatchObject({ id: project.id, name: 'come-back', archived: false });
    expect((await active()).map((item) => item.id)).toContain(project.id);
    // Now that it is active again, the same folder is a conflict once more.
    const twice = await register({ name: 'come-back', rootDir: project.rootDir });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('project_exists');
  });

  it('AT-PJ-017: the folder browser shows folders only, inside the workspace root — nothing above it, no system folder, and a file is not a folder', async () => {
    await mkdir(path.join(workspace, 'browse-me', 'inner'), { recursive: true });
    await mkdir(path.join(workspace, 'browse-me', 'node_modules'));
    await mkdir(path.join(workspace, 'browse-me', '.git'));
    await writeFile(path.join(workspace, 'browse-me', 'a-file.txt'), 'x');
    const top = await owner.get<Json>('/api/projects/browse');
    expect(top.status).toBe(200);
    expect(top.body.roots.map((root: Json) => root.path)).toEqual([workspace]);
    const listing = (
      await owner.get<Json>(
        `/api/projects/browse?path=${encodeURIComponent(path.join(workspace, 'browse-me'))}`,
      )
    ).body;
    expect(listing).toMatchObject({
      path: path.join(workspace, 'browse-me'),
      parent: workspace,
      selectable: true,
    });
    expect(listing.entries.map((entry: Json) => entry.name)).toEqual(['inner']); // no file, no dependency folder, no repository metadata
    // A folder that already is a project says so.
    const known = (
      await owner.get<Json>(`/api/projects/browse?path=${encodeURIComponent(workspace)}`)
    ).body.entries.find((entry: Json) => entry.name === 'first-project');
    expect(known.projectId).toMatch(/^[0-9a-z]{26}$/);

    for (const outside of [path.dirname(workspace), '/', '/etc', '/home']) {
      const refused = await owner.get<ErrorBody>(
        `/api/projects/browse?path=${encodeURIComponent(outside)}`,
      );
      expect(refused.status, outside).toBe(403);
      expect(refused.body.error.code).toBe('outside_workspace');
    }
    const file = await owner.get<ErrorBody>(
      `/api/projects/browse?path=${encodeURIComponent(path.join(workspace, 'browse-me', 'a-file.txt'))}`,
    );
    expect(file.status).toBe(400);
    expect(file.body.error.code).toBe('not_a_directory');
  });

  it('AT-PJ-053: an unknown project is "not found" — the same answer as for one that exists but is not shared', async () => {
    const hidden = await createProject(studio, owner, 'not-shared');
    const stranger = await createMember(studio, owner, 'stranger');
    const unknown = await stranger.get<ErrorBody>('/api/projects/0123456789abcdefghjkmnpqrs');
    const unshared = await stranger.get<ErrorBody>(`/api/projects/${hidden.id}`);
    expect(unknown.status).toBe(404);
    expect(unshared.status).toBe(404);
    expect(unshared.body).toEqual(unknown.body);
    expect(await active(stranger)).toEqual([]);
  });

  it('AT-PJ-207 (adapted): a member sees only what was shared with them — read-only means read-only, and even with write access the owner’s switches stay the owner’s', async () => {
    const project = await createProject(studio, owner, 'shared-with-care');
    const member = await createMember(studio, owner, 'teammate');
    // Not shared: nothing — not the record, not its members, not its settings.
    for (const attempt of [
      member.get(`/api/projects/${project.id}`),
      member.patch(`/api/projects/${project.id}`, { name: 'mine now' }),
      member.post(`/api/projects/${project.id}/opened`),
      member.get(`/api/projects/${project.id}/links/status`),
    ]) {
      expect((await attempt).status).toBe(404);
    }
    expect(
      (await member.put<ErrorBody>('/api/projects/pins', { projectIds: [project.id] })).status,
    ).toBe(404);
    // Only the owner creates, deletes and shares.
    expect(
      (
        await register(
          {
            name: 'by a member',
            rootDir: path.join(workspace, 'by-a-member'),
            createDirectory: true,
          },
          member,
        )
      ).status,
    ).toBe(403);
    expect(existsSync(path.join(workspace, 'by-a-member'))).toBe(false);
    expect((await member.delete(`/api/projects/${project.id}`)).status).toBe(403);
    expect(
      (
        await member.put(`/api/projects/${project.id}/members/${member.userId}`, {
          access: 'write',
        })
      ).status,
    ).toBe(403);

    await shareProject(owner, project.id, member.userId!, 'read');
    expect((await active(member)).map((item) => `${item.id}:${item.access}`)).toEqual([
      `${project.id}:read`,
    ]);
    const readOnly = await member.patch<ErrorBody>(`/api/projects/${project.id}`, {
      name: 'renamed by a reader',
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error.code).toBe('project_read_only');

    await shareProject(owner, project.id, member.userId!, 'write');
    expect(
      (
        await member.patch<Json>(`/api/projects/${project.id}`, {
          description: 'edited by a teammate',
        })
      ).status,
    ).toBe(200);
    for (const ownerOnly of [
      { features: { automation: true } },
      { agents: ['codex'] },
      { archived: true },
      { links: [{ label: 'inside', url: 'http://127.0.0.1:9/', local: true }] },
    ]) {
      const refused = await member.patch<ErrorBody>(`/api/projects/${project.id}`, ownerOnly);
      expect(refused.status, JSON.stringify(ownerOnly)).toBe(403);
      expect(refused.body.error.code).toBe('owner_required');
    }
    const now = (await owner.get<Json>(`/api/projects/${project.id}`)).body;
    expect(now).toMatchObject({
      name: 'shared-with-care',
      description: 'edited by a teammate',
      archived: false,
      agents: null,
      links: [],
    });
    expect(now.features.automation).toBe(false);
    expect(
      (await owner.get<{ members: Json[] }>(`/api/projects/${project.id}/members`)).body.members,
    ).toEqual([
      { userId: member.userId, username: 'teammate', displayName: 'teammate', access: 'write' },
    ]);

    // Taking the share away takes the project away.
    expect(
      (await owner.delete(`/api/projects/${project.id}/members/${member.userId}`)).status,
    ).toBe(204);
    expect(await active(member)).toEqual([]);
    expect((await member.get(`/api/projects/${project.id}`)).status).toBe(404);
  });

  it('AT-PJ-043/048 (adapted): pins and "last opened" follow the account — set on one device, they are there, in order, on the other', async () => {
    const a = await createProject(studio, owner, 'pin-a');
    const b = await createProject(studio, owner, 'pin-b');
    const tablet = await studio.owner();
    const live = await Realtime.open(studio, tablet);
    await live.subscribe(`user:${tablet.userId}`);
    expect((await owner.put<Json>('/api/projects/pins', { projectIds: [b.id, a.id] })).status).toBe(
      200,
    );
    const told = await live.event(`user:${tablet.userId}`, 'projects.pins.changed');
    expect(told.data).toEqual({ projectIds: [b.id, a.id] });
    expect((await tablet.get<Json>('/api/projects/pins')).body).toEqual({
      projectIds: [b.id, a.id],
    });
    const rows = await active(tablet);
    expect(rows.find((item) => item.id === a.id)!.pinned).toBe(true);
    // A project cannot be pinned twice, and pins are personal.
    expect((await owner.put('/api/projects/pins', { projectIds: [a.id, a.id] })).status).toBe(400);
    const other = await createMember(studio, owner, 'pinless');
    await shareProject(owner, a.id, other.userId!, 'read');
    expect((await other.get<Json>('/api/projects/pins')).body).toEqual({ projectIds: [] });
    expect((await active(other))[0]!.pinned).toBe(false);

    const opened = await owner.post<Json>(`/api/projects/${a.id}/opened`);
    expect(opened.body.projectId).toBe(a.id);
    const hint = await live.event(`user:${tablet.userId}`, 'project.opened');
    expect(hint.data).toEqual({ projectId: a.id, lastOpenedAt: opened.body.lastOpenedAt });
    expect((await active(tablet)).find((item) => item.id === a.id)!.lastOpenedAt).toBe(
      opened.body.lastOpenedAt,
    );
    expect((await active(tablet)).find((item) => item.id === b.id)!.lastOpenedAt).toBeNull();
    await live.close();
  });

  describe('links', () => {
    let site: Server;
    let hits: string[];
    let base: string;

    beforeAll(async () => {
      hits = [];
      site = createServer((request, response) => {
        hits.push(`${request.method} ${request.url}`);
        if (request.url === '/broken') {
          response.writeHead(500).end('internal details that must not travel');
        } else if (request.url === '/no-frames') {
          response.writeHead(200, { 'x-frame-options': 'DENY' }).end('ok');
        } else {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end('<title>secret page title</title>');
        }
      });
      await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()));
      base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

    it('AT-PJ-029 (adapted): nine links are refused, as is a link with a script scheme or with a user name and password in it; eight web links are accepted', async () => {
      const project = await createProject(studio, owner, 'links-rules');
      const eight = Array.from({ length: 8 }, (_unused, index) => ({
        label: `link ${index + 1}`,
        url: `https://example.com/${index + 1}`,
      }));
      expect(
        (
          await owner.patch(`/api/projects/${project.id}`, {
            links: [...eight, { label: 'ninth', url: 'https://example.com/9' }],
          })
        ).status,
      ).toBe(400);
      for (const url of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'ftp://example.com/',
        'https://user:secret@example.com/',
      ]) {
        const refused = await owner.patch<ErrorBody>(`/api/projects/${project.id}`, {
          links: [{ label: 'bad', url }],
        });
        expect(refused.status, url).toBe(400);
        expect(refused.body.error.code).toBe('invalid_link');
        expect(JSON.stringify(refused.body)).not.toContain('secret');
      }
      const saved = await owner.patch<Json>(`/api/projects/${project.id}`, { links: eight });
      expect(saved.status).toBe(200);
      expect(saved.body.links.map((link: Json) => link.url)).toEqual(eight.map((link) => link.url));
      expect(saved.body.links.every((link: Json) => link.local === false)).toBe(true);
    });

    it('AT-PJ-038 (adapted): link status reports that a site answered, how and how fast — a success with its latency, a server error with its status, a closed port as unreachable — and never what the site said', async () => {
      const project = await createProject(studio, owner, 'links-status');
      const links = [
        { label: 'fine', url: `${base}/fine`, local: true },
        { label: 'broken', url: `${base}/broken`, local: true },
        { label: 'no frames', url: `${base}/no-frames`, local: true },
        { label: 'closed', url: 'http://127.0.0.1:1/', local: true },
      ];
      const saved = (await owner.patch<Json>(`/api/projects/${project.id}`, { links })).body
        .links as Array<{ id: string; label: string }>;
      const status = await owner.get<{ links: Json[] }>(
        `/api/projects/${project.id}/links/status?refresh=true`,
      );
      expect(status.status).toBe(200);
      const of = (label: string) =>
        status.body.links.find(
          (item) => item.linkId === saved.find((link) => link.label === label)!.id,
        )!;
      expect(of('fine')).toMatchObject({ state: 'ok', status: 200, frameable: true });
      expect(of('fine').latencyMs).toBeGreaterThanOrEqual(0);
      expect(of('broken')).toMatchObject({ state: 'http_error', status: 500 });
      expect(of('no frames')).toMatchObject({ state: 'ok', frameable: false });
      expect(of('closed')).toMatchObject({
        state: 'unreachable',
        status: null,
        latencyMs: null,
        frameable: null,
      });
      const text = JSON.stringify(status.body);
      expect(text).not.toContain('internal details');
      expect(text).not.toContain('secret page title');
      expect(hits.some((hit) => hit.endsWith('/fine'))).toBe(true);
    });

    it('AT-PJ-039 (adapted): a link to a private address that the owner has not declared local is never contacted — verified at the listener — and shows as blocked; a link-local (cloud metadata) address cannot even be saved', async () => {
      const project = await createProject(studio, owner, 'links-guard');
      for (const local of [true, false]) {
        const metadata = await owner.patch<ErrorBody>(`/api/projects/${project.id}`, {
          links: [{ label: 'metadata', url: 'http://169.254.169.254/latest/meta-data/', local }],
        });
        expect(metadata.status).toBe(400);
        expect(metadata.body.error.code).toBe('invalid_link');
      }
      const patched = await owner.patch<Json>(`/api/projects/${project.id}`, {
        links: [{ label: 'undeclared', url: `${base}/must-not-be-fetched` }],
      });
      expect(patched.status).toBe(200);
      const [saved] = patched.body.links as Array<{ id: string }>;
      const before = hits.length;
      const status = await owner.get<{ links: Json[] }>(
        `/api/projects/${project.id}/links/status?refresh=true`,
      );
      expect(status.body.links).toHaveLength(1);
      expect(status.body.links[0]).toMatchObject({
        linkId: saved!.id,
        state: 'blocked',
        status: null,
        latencyMs: null,
      });
      expect(hits.slice(before)).toEqual([]);
      expect(hits.some((hit) => hit.includes('must-not-be-fetched'))).toBe(false);
      // Declared local by the owner, the same address is checked.
      await owner.patch(`/api/projects/${project.id}`, {
        links: [
          { id: saved!.id, label: 'declared', url: `${base}/must-not-be-fetched`, local: true },
        ],
      });
      const declared = await owner.get<{ links: Json[] }>(
        `/api/projects/${project.id}/links/status?refresh=true`,
      );
      expect(declared.body.links[0]).toMatchObject({ linkId: saved!.id, state: 'ok' });
      expect(hits.slice(before).length).toBeGreaterThan(0);
    });
  });
});
