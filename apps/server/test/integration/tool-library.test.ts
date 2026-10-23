import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LibraryItem, Project } from '@agent-studio/protocol';
import { modules } from '../../src/modules/index.js';
import { createToolLibraryModule } from '../../src/modules/tool-library/tool-library.module.js';
import type { guardedRequest } from '../../src/kernel/net.js';
import { createTestStudio, type TestStudio } from '../../src/testing/harness.js';
import { createAgentsKit, until } from '../../src/testing/agents-kit.js';

const opened: TestStudio[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) await t.close();
});
function fakeTransport() {
  return vi.fn<typeof guardedRequest>(async (_url, options) => {
    if (options?.method === 'DELETE') return { status: 204, headers: {}, body: Readable.from([]) };
    const body = JSON.parse(String(options?.body)) as { id?: number; method: string };
    if (body.id === undefined) return { status: 202, headers: {}, body: Readable.from([]) };
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
        : body.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'example_tool',
                  description: 'Synthetic tool',
                  inputSchema: { type: 'object' },
                },
              ],
            }
          : { content: [{ type: 'text', text: 'Synthetic answer' }] };
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'synthetic-session' },
      body: Readable.from([JSON.stringify({ jsonrpc: '2.0', id: body.id, result })]),
    };
  });
}
async function start() {
  const transport = fakeTransport();
  const t = await createTestStudio({
    modules: modules.map((m) =>
      m.name === 'tool-library' ? createToolLibraryModule(transport) : m,
    ),
  });
  opened.push(t);
  return { t, owner: await t.owner(), transport };
}
const connection = {
  kind: 'mcp',
  name: 'example',
  endpoint: 'https://example.invalid/mcp',
  token: 'synthetic-mcp-credential',
};
describe('private tool library', () => {
  it('propagates a stopped run to a pending registered tool', async () => {
    let signal: AbortSignal | undefined;
    const kit = await createAgentsKit({
      extraModules: [
        {
          name: 'cancellation-probe',
          setup(context) {
            context.agentTools.register({
              name: 'synthetic_wait',
              description: 'Synthetic cancellation probe',
              input: z.object({}),
              effect: 'read',
              async handler(run) {
                signal = run.signal;
                if (!signal) throw new Error('Missing run cancellation signal');
                await new Promise<void>((resolve) => {
                  if (signal!.aborted) resolve();
                  else signal!.addEventListener('abort', () => resolve(), { once: true });
                });
                return { text: 'Stopped synthetic work' };
              },
            });
          },
        },
      ],
    });
    try {
      kit.agent.script([{ studioTool: { name: 'synthetic_wait', input: {} } }]);
      const session = await kit.session();
      await kit.send(kit.owner, session.id, 'Synthetic cancellation');
      await until(() => signal);
      expect((await kit.owner.post(`/api/sessions/${session.id}/stop`)).status).toBe(200);
      expect(signal?.aborted).toBe(true);
    } finally {
      await kit.close();
    }
  });
  it('removes encrypted tokens when a project deletion cascades library rows', async () => {
    const { t, owner } = await start();
    const project = (
      await owner.post<Project>('/api/projects', {
        name: 'Ephemeral project',
        rootDir: t.workspace,
      })
    ).body;
    const saved = (
      await owner.post<LibraryItem>('/api/tool-library', {
        ...connection,
        projectId: project.id,
      })
    ).body;
    expect(t.studio.context.secrets.describe(`tool-library:${saved.id}:token`)).not.toBeNull();
    t.studio.context.db.run('DELETE FROM projects WHERE id = ?', project.id);
    expect(t.studio.context.secrets.describe(`tool-library:${saved.id}:token`)).toBeNull();
  });
  it('starts empty, stores credentials encrypted and never contacts an endpoint on save', async () => {
    const { t, owner, transport } = await start();
    expect((await t.anonymous().get('/api/tool-library')).status).toBe(401);
    const saved = await owner.post<LibraryItem>('/api/tool-library', connection);
    expect(saved.status).toBe(201);
    expect(saved.body.credentialSaved).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain(connection.token);
    expect(JSON.stringify(t.studio.context.db.all('SELECT * FROM secrets'))).not.toContain(
      connection.token,
    );
    expect(transport).not.toHaveBeenCalled();
    const member = await t.member();
    expect((await member.get('/api/tool-library')).body).toEqual({ items: [] });
    expect(
      (await member.post(`/api/tool-library/${saved.body.id}/test`, { version: 1 })).status,
    ).toBe(404);
    expect(
      (await member.put(`/api/tool-library/${saved.body.id}`, { ...connection, version: 1 }))
        .status,
    ).toBe(404);
  });
  it('rejects SSRF by default and only the owner may opt into private HTTPS', async () => {
    const { t, owner, transport } = await start();
    for (const endpoint of [
      'http://127.0.0.1:9000/mcp',
      'https://169.254.169.254/mcp',
      'https://user:pass@example.invalid/mcp',
      'https://example.invalid/mcp?key=example',
    ]) {
      expect(
        (await owner.post('/api/tool-library', { ...connection, endpoint })).status,
      ).toBeGreaterThanOrEqual(400);
    }
    const member = await t.member();
    expect(
      (await member.post('/api/tool-library', { ...connection, allowPrivateNetwork: true })).status,
    ).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('negotiates MCP on explicit test and clears credentials on endpoint change', async () => {
    const { owner, transport } = await start();
    const saved = (await owner.post<LibraryItem>('/api/tool-library', connection)).body;
    const result = await owner.post(`/api/tool-library/${saved.id}/test`, { version: 1 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ tools: [{ name: 'example_tool' }] });
    expect(transport.mock.calls.map((call) => call[1]?.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${connection.token}`,
    });
    const edited = await owner.put<LibraryItem>(`/api/tool-library/${saved.id}`, {
      ...connection,
      token: undefined,
      endpoint: 'https://second.invalid/mcp',
      version: 1,
    });
    expect(edited.body).toMatchObject({ version: 2, credentialSaved: false });
    expect((await owner.post(`/api/tool-library/${saved.id}/test`, { version: 1 })).status).toBe(
      409,
    );
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('isolates project entries and expands commands without shell evaluation', async () => {
    const { t, owner } = await start();
    const project = (
      await owner.post<Project>('/api/projects', { name: 'Example', rootDir: t.workspace })
    ).body;
    expect(project.id).toBeTruthy();
    await owner.post('/api/tool-library', {
      kind: 'command',
      name: 'review',
      content: 'Review: $ARGUMENTS',
    });
    await owner.post('/api/tool-library', {
      kind: 'command',
      name: 'review',
      content: 'Project review: $ARGUMENTS',
      projectId: project.id,
    });
    const library = t.studio.context.services.toolLibrary!;
    const user = t.studio.context.services.agents.principalFor(owner.userId!)!;
    expect(library.expand(user, null, '/review $(touch /tmp/never-run)')).toBe(
      '[User-selected command: review]\nReview: $(touch /tmp/never-run)',
    );
    expect(library.expand(user, project.id, '/review sample')).toContain('Project review: sample');
    expect(library.expand(user, null, '/unknown hello')).toBe('/unknown hello');
    const member = await t.member();
    expect((await member.get(`/api/tool-library?projectId=${project.id}`)).status).toBe(404);
    const tools = t.studio.context.agentTools;
    expect(tools.get('mcp_call')?.effect).toBe('write');
    expect(tools.get('mcp_tools')?.effect).toBe('write');
    expect(tools.get('skill_read')?.effect).toBe('read');
  });
  it('refuses stale writes and deletion cleans the encrypted token', async () => {
    const { t, owner } = await start();
    const saved = (await owner.post<LibraryItem>('/api/tool-library', connection)).body;
    expect(
      (await owner.put(`/api/tool-library/${saved.id}`, { ...connection, version: 5 })).status,
    ).toBe(409);
    expect(
      (await owner.request('DELETE', `/api/tool-library/${saved.id}`, { version: 5 })).status,
    ).toBe(409);
    expect(
      (await owner.request('DELETE', `/api/tool-library/${saved.id}`, { version: 1 })).status,
    ).toBe(200);
    expect(t.studio.context.secrets.describe(`tool-library:${saved.id}:token`)).toBeNull();
  });
});
