import path from 'node:path';
import type { BrowserSession, Project } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { modules } from '../../src/modules/index.js';
import { createBrowserModule } from '../../src/modules/browser/browser.module.js';
import type { BrowserEngineFactory } from '../../src/modules/browser/engine.js';
import { createTestStudio, type TestStudio, type TestClient } from '../../src/testing/harness.js';
const engine = {
  action: vi.fn().mockResolvedValue({
    url: 'https://example.com',
    title: 'Synthetic page',
    text: 'Synthetic page text',
    screenshot: Buffer.from('fake screenshot'),
  }),
  close: vi.fn().mockResolvedValue(undefined),
};
const factory = vi.fn<BrowserEngineFactory>().mockResolvedValue(engine);
let studio: TestStudio;
let owner: TestClient;
let member: TestClient;
let browser: BrowserSession;
beforeAll(async () => {
  studio = await createTestStudio({
    config: { sandbox: 'auto' },
    modules: modules.map((module) =>
      module.name === 'browser'
        ? createBrowserModule({ executable: '/usr/bin/synthetic-chromium', engineFactory: factory })
        : module,
    ),
  });
  owner = await studio.owner();
  member = await studio.member();
});
afterAll(async () => {
  await studio.close();
});
describe('isolated browser ownership', () => {
  it('fails closed without authentication', async () => {
    expect((await studio.anonymous().get('/api/browser')).status).toBe(401);
    expect((await studio.anonymous().post('/api/browser', {})).status).toBe(401);
  });
  it('creates no browser without a working OS sandbox', async (test) => {
    if (studio.studio.context.sandbox.status.mode !== 'bwrap') {
      expect((await owner.post('/api/browser', {})).status).toBe(503);
      return;
    }
    test.skip();
  });
  it('isolates an owner browser from every other account', async (test) => {
    if (studio.studio.context.sandbox.status.mode !== 'bwrap') return test.skip();
    const result = await owner.post<BrowserSession>('/api/browser', {});
    expect(result.status).toBe(200);
    browser = result.body;
    expect(
      (await member.get<{ sessions: BrowserSession[] }>('/api/browser')).body.sessions,
    ).toEqual([]);
    expect(
      (await member.post(`/api/browser/${browser.id}/actions`, { action: 'screenshot' })).status,
    ).toBe(404);
    expect((await member.get(`/api/browser/${browser.id}/screenshot`)).status).toBe(404);
    expect((await member.delete(`/api/browser/${browser.id}`)).status).toBe(404);
    expect(engine.action).not.toHaveBeenCalled();
    expect(
      (await owner.post(`/api/browser/${browser.id}/actions`, { action: 'screenshot' })).status,
    ).toBe(200);
    expect(
      (await owner.get(`/api/browser/${browser.id}/screenshot`)).headers['content-type'],
    ).toContain('image/png');
    expect((await owner.post('/api/browser', {})).status).toBe(409);
    expect((await owner.delete(`/api/browser/${browser.id}`)).status).toBe(204);
    expect(engine.close).toHaveBeenCalledTimes(1);
  });
  it('enforces project visibility and write permission before opening a browser', async () => {
    const project = (
      await owner.post<Project>('/api/projects', {
        name: 'browser test',
        rootDir: path.join(studio.workspace, 'browser'),
        createDirectory: true,
      })
    ).body;
    expect((await member.post('/api/browser', { projectId: project.id })).status).toBe(404);
    await owner.put(`/api/projects/${project.id}/members/${member.userId}`, { access: 'read' });
    expect((await member.post('/api/browser', { projectId: project.id })).status).toBe(403);
  });
  it('registers browser interaction as a write tool behind existing agent approvals', () => {
    expect(studio.studio.context.agentTools.get('browser_control')?.effect).toBe('write');
  });
});
