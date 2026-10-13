import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestStudio, type TestStudio } from '../../src/testing/harness.js';

let t: TestStudio;
beforeEach(async () => {
  t = await createTestStudio();
});
afterEach(async () => {
  await t.close();
});

async function makeProject(name = 'demo'): Promise<Project> {
  const owner = await t.owner();
  const response = await owner.post<Project>('/api/projects', { name, rootDir: path.join(t.workspace, name), createDirectory: true });
  expect(response.status).toBe(201);
  return response.body;
}

describe('creating projects', () => {
  it('registers a folder, creating it when asked', async () => {
    const project = await makeProject('alpha');
    expect(project).toMatchObject({ name: 'alpha', access: 'write', archived: false });
    expect(existsSync(project.rootDir)).toBe(true);
  });

  it('refuses a missing folder unless asked to create it', async () => {
    const owner = await t.owner();
    const response = await owner.post('/api/projects', { name: 'x', rootDir: path.join(t.workspace, 'nope') });
    expect(response.body).toMatchObject({ error: { code: 'folder_missing' } });
  });

  it('allows one project per folder', async () => {
    const project = await makeProject('alpha');
    const owner = await t.owner();
    const again = await owner.post('/api/projects', { name: 'again', rootDir: project.rootDir });
    expect(again.status).toBe(409);
  });

  it.each([
    ['/etc', 'a system directory'],
    ['/', 'the file system root'],
    [os.tmpdir(), 'a folder outside the workspace roots'],
    ['relative/path', 'a relative path'],
    ['~', 'the home directory'],
  ])('refuses %s (%s)', async (rootDir) => {
    const owner = await t.owner();
    const response = await owner.post('/api/projects', { name: 'bad', rootDir, createDirectory: true });
    expect([400, 403]).toContain(response.status);
  });

  it('refuses a folder that reaches outside the workspace through a link', async () => {
    const owner = await t.owner();
    const outside = path.join(path.dirname(t.workspace), 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(t.workspace, 'sneaky'));
    const direct = await owner.post('/api/projects', { name: 'sneaky', rootDir: path.join(t.workspace, 'sneaky') });
    expect(direct.body).toMatchObject({ error: { code: 'outside_workspace' } });
    const nested = await owner.post('/api/projects', { name: 'sneaky', rootDir: path.join(t.workspace, 'sneaky', 'child'), createDirectory: true });
    expect(nested.body).toMatchObject({ error: { code: 'outside_workspace' } });
    expect(existsSync(path.join(outside, 'child'))).toBe(false);
  });

  it("refuses the Studio's own data directory and anything around it", async () => {
    const wide = await createTestStudio({ config: { workspaceRoots: [os.tmpdir()] } });
    try {
      const owner = await wide.owner();
      for (const rootDir of [wide.dataDir, path.dirname(wide.dataDir), path.join(wide.dataDir, 'inner')]) {
        const response = await owner.post('/api/projects', { name: 'data', rootDir, createDirectory: true });
        expect(response.body, rootDir).toMatchObject({ error: { code: 'folder_not_allowed' } });
      }
    } finally {
      await wide.close();
    }
  });
});

describe('project access', () => {
  it('shows a member only the projects shared with them', async () => {
    const shared = await makeProject('shared');
    const secret = await makeProject('secret');
    const owner = await t.owner();
    const member = await t.member('alice');

    expect((await member.get<{ projects: Project[] }>('/api/projects')).body.projects).toEqual([]);
    // Invisible and non-existent look the same.
    const hidden = await member.get(`/api/projects/${secret.id}`);
    const missing = await member.get('/api/projects/00000000000000000000000000');
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);

    expect((await owner.put(`/api/projects/${shared.id}/members/${member.userId}`, { access: 'read' })).status).toBe(204);
    const visible = (await member.get<{ projects: Project[] }>('/api/projects')).body.projects;
    expect(visible.map((project) => project.name)).toEqual(['shared']);
    expect(visible[0]!.access).toBe('read');
  });

  it('enforces read-only access and lifts it when upgraded', async () => {
    const project = await makeProject('shared');
    const owner = await t.owner();
    const member = await t.member('alice');
    await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'read' });
    expect((await member.patch(`/api/projects/${project.id}`, { name: 'renamed' })).body).toMatchObject({ error: { code: 'project_read_only' } });

    await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'write' });
    expect((await member.patch(`/api/projects/${project.id}`, { name: 'renamed' })).status).toBe(200);
    // Still not the member's to archive, delete, create or share.
    expect((await member.patch(`/api/projects/${project.id}`, { archived: true })).status).toBe(403);
    expect((await member.delete(`/api/projects/${project.id}`)).status).toBe(403);
    expect((await member.post('/api/projects', { name: 'mine', rootDir: path.join(t.workspace, 'mine'), createDirectory: true })).status).toBe(403);
    expect((await member.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'write' })).status).toBe(403);
    expect((await member.get(`/api/projects/${project.id}/members`)).status).toBe(403);
  });

  it('removes access when the member is taken off the project', async () => {
    const project = await makeProject('shared');
    const owner = await t.owner();
    const member = await t.member('alice');
    await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'write' });
    expect((await member.get(`/api/projects/${project.id}`)).status).toBe(200);
    await owner.delete(`/api/projects/${project.id}/members/${member.userId}`);
    expect((await member.get(`/api/projects/${project.id}`)).status).toBe(404);
  });
});

describe('telling other devices', () => {
  it('announces list changes to accounts that can see the project, and to no one else', async () => {
    const owner = await t.owner();
    const insider = await t.member('alice');
    const outsider = await t.member('bob');
    const seen: Array<{ topic: string; change: string }> = [];
    t.studio.context.bus.on('projects.changed', (event) => seen.push({ topic: event.topic, change: (event.data as { change: string }).change }));

    const project = await makeProject('watched');
    await owner.put(`/api/projects/${project.id}/members/${insider.userId}`, { access: 'read' });
    seen.length = 0;
    await owner.patch(`/api/projects/${project.id}`, { name: 'renamed' });
    await owner.delete(`/api/projects/${project.id}`);

    const topics = (change: string) => seen.filter((entry) => entry.change === change).map((entry) => entry.topic).sort();
    const expected = [`user:${insider.userId}`, `user:${owner.userId}`].sort();
    expect(topics('updated')).toEqual(expected);
    expect(topics('removed')).toEqual(expected);
    expect(seen.some((entry) => entry.topic === `user:${outsider.userId}`)).toBe(false);
  });
});

describe('archiving and removing', () => {
  it('hides archived projects from the default list', async () => {
    const project = await makeProject('old');
    const owner = await t.owner();
    await owner.patch(`/api/projects/${project.id}`, { archived: true });
    expect((await owner.get<{ projects: Project[] }>('/api/projects')).body.projects).toEqual([]);
    expect((await owner.get<{ projects: Project[] }>('/api/projects?archived=include')).body.projects).toHaveLength(1);
  });

  it('forgets a removed project but never touches its files', async () => {
    const project = await makeProject('keepfiles');
    const file = path.join(project.rootDir, 'important.txt');
    await writeFile(file, 'do not delete');
    const owner = await t.owner();
    expect((await owner.delete(`/api/projects/${project.id}`)).status).toBe(204);
    expect((await owner.get(`/api/projects/${project.id}`)).status).toBe(404);
    expect(existsSync(file)).toBe(true);
  });
});

describe('preferences', () => {
  it('stores values per account and removes keys set to null', async () => {
    const owner = await t.owner();
    const member = await t.member('alice');
    await owner.patch('/api/preferences', { values: { 'appearance.theme': 'dark', 'home.layout': { tiles: ['a', 'b'] } } });
    await member.patch('/api/preferences', { values: { 'appearance.theme': 'light' } });
    expect((await owner.get('/api/preferences')).body).toEqual({ values: { 'appearance.theme': 'dark', 'home.layout': { tiles: ['a', 'b'] } } });
    expect((await member.get('/api/preferences')).body).toEqual({ values: { 'appearance.theme': 'light' } });
    await owner.patch('/api/preferences', { values: { 'home.layout': null } });
    expect((await owner.get('/api/preferences')).body).toEqual({ values: { 'appearance.theme': 'dark' } });
  });

  it('rejects malformed keys and oversized values', async () => {
    const owner = await t.owner();
    expect((await owner.patch('/api/preferences', { values: { 'Bad Key!': 1 } })).status).toBe(400);
    expect((await owner.patch('/api/preferences', { values: { 'big.value': 'x'.repeat(70 * 1024) } })).status).toBe(413);
  });
});

describe('audit log', () => {
  it('masks addresses, redacts secrets, and shows members only their own events', async () => {
    const owner = await t.owner();
    const member = await t.member('alice');
    const audit = t.studio.context.services.audit;
    audit.record({ category: 'change', action: 'token.created', userId: owner.userId, subject: 'ci', detail: 'token=ast_abcdefghijklmnopqrstuvwxyz012345', address: '203.0.113.42' });
    audit.record({ category: 'failure', action: 'sign-in.refused', userId: member.userId, address: '2001:db8:1234:5678::1' });

    // The owner sees every account's events (including the ones sign-in itself recorded).
    const all = (await owner.get<{ events: Array<Record<string, unknown>> }>('/api/audit')).body.events;
    expect(all.map((event) => event.action)).toEqual(expect.arrayContaining(['token.created', 'sign-in.refused', 'owner.created']));
    expect(JSON.stringify(all)).not.toContain('ast_abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.stringify(all)).not.toContain('203.0.113.42');
    expect(all.find((event) => event.action === 'token.created')).toMatchObject({ address: '203.0.113.x' });

    // A member sees only events about their own account.
    const own = (await member.get<{ events: Array<Record<string, unknown>> }>('/api/audit')).body.events;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((event) => event.userId === member.userId)).toBe(true);
    expect(own.find((event) => event.action === 'sign-in.refused')).toMatchObject({ address: '2001:db8:1234::/48' });
    expect(own.some((event) => event.action === 'token.created')).toBe(false);
    const failures = (await owner.get<{ events: Array<{ category: string }> }>('/api/audit?category=failure')).body.events;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((event) => event.category === 'failure')).toBe(true);
  });
});
