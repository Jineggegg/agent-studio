import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Approval, Run } from '@agent-studio/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentToolContext } from '../../src/kernel/agent-tools.js';
import type { StudioModule } from '../../src/kernel/module.js';
import { type AgentsKit, createAgentsKit, until } from '../../src/testing/agents-kit.js';
import { TEST_HOST } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

/** Two tools as another module would register them: one that only reads, one that changes something. */
const calls: Array<{ tool: string; context: AgentToolContext; input: unknown }> = [];
const toolsModule: StudioModule = {
  name: 'testing.tools',
  setup(context) {
    context.agentTools.register({
      name: 'whoami',
      description: 'Says which run is calling.',
      input: z.object({}),
      effect: 'read',
      handler: (toolContext) => ({ text: JSON.stringify(toolContext) }),
    });
    context.agentTools.register({
      name: 'note_write',
      description: 'Writes a note.',
      input: z.object({ title: z.string().min(1), body: z.string() }),
      effect: 'write',
      handler: (toolContext, input) => {
        calls.push({ tool: 'note_write', context: toolContext, input });
        return { text: `saved "${input.title}"` };
      },
    });
  },
};

let kit: AgentsKit;
// An agent whose adapter knows nothing about its tools: the bridge falls back to conventional input fields.
const plain = new ScriptedAdapter({ id: 'plain', displayName: 'Plain agent' });
(plain as { onPermissionPrompt?: unknown }).onPermissionPrompt = undefined;

beforeAll(async () => {
  kit = await createAgentsKit({ adapters: [new ScriptedAdapter(), plain], extraModules: [toolsModule] });
});
afterAll(async () => {
  await kit.close();
});

interface BridgeReply {
  status: number;
  body: { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; content?: Array<{ type: string; text: string }>; isError?: boolean; error?: { code: string } };
}

async function bridge(path: string, token: string | null, payload: unknown = {}, options: { remoteAddress?: string; headers?: Record<string, string> } = {}): Promise<BridgeReply> {
  const response = await kit.t.studio.app.inject({
    method: 'POST',
    url: `/api/bridge/${path}`,
    headers: { host: TEST_HOST, 'content-type': 'application/json', ...(token === null ? {} : { 'x-studio-bridge-token': token }), ...options.headers },
    payload: payload as object,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });
  return { status: response.statusCode, body: response.json() };
}

/** Starts a run that waits at a gate and returns what its adapter was given. */
async function heldRun(gate: string, agent = kit.agent) {
  const session = await kit.session(kit.owner, { agentId: agent.id });
  agent.script([{ gate }]);
  const sent = await kit.send(kit.owner, session.id, `hold at ${gate}`);
  await agent.reached(gate);
  const request = agent.lastRun.request;
  return { session, runId: sent.body.runId!, request, token: request.bridge.env.STUDIO_BRIDGE_TOKEN!, release: () => agent.open(gate) };
}

const pendingApproval = (sessionId: string): Promise<Approval> => until(async () => (await kit.state(kit.owner, sessionId)).pendingApprovals[0]);

describe('the bridge endpoints', () => {
  it('give an adapter what it needs to launch the bridge, and nothing secret but the run token', async () => {
    const run = await heldRun('launch-info');
    const { bridge: connection } = run.request;
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.at(-1)).toMatch(/[\\/]bin[\\/]mcp-bridge\.(ts|js)$/);
    expect(connection.serverName).toBe('studio');
    expect(connection.permissionPromptTool).toBe('permission_prompt');
    expect(Object.keys(connection.env).sort()).toEqual(['STUDIO_BRIDGE_TOKEN', 'STUDIO_BRIDGE_URL']);
    expect(connection.env.STUDIO_BRIDGE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(run.token.length).toBeGreaterThanOrEqual(40);
    // The token is not in the database, the events or anything a client can read.
    const everything = JSON.stringify([await kit.events(kit.owner, run.session.id), await kit.state(kit.owner, run.session.id), (await kit.owner.get(`/api/runs/${run.runId}`)).body]);
    expect(everything).not.toContain(run.token);
    const rows = kit.t.studio.context.db.all<Record<string, unknown>>('SELECT * FROM agent_runs WHERE id = ?', run.runId);
    expect(JSON.stringify(rows)).not.toContain(run.token);
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });

  it('list the Studio\'s tools and the permission prompt', async () => {
    const run = await heldRun('list');
    const listed = await bridge('tools/list', run.token);
    expect(listed.status).toBe(200);
    // Every tool any module registered, then the permission prompt.
    const names = listed.body.tools!.map((tool) => tool.name);
    expect(names).toEqual([...kit.t.studio.context.agentTools.list().map((tool) => tool.name), 'permission_prompt']);
    expect(names).toEqual(expect.arrayContaining(['whoami', 'note_write']));
    expect(listed.body.tools!.find((tool) => tool.name === 'note_write')).toMatchObject({ description: 'Writes a note.', inputSchema: { type: 'object', required: ['title', 'body'] } });
    expect(listed.body.tools!.at(-1)!.inputSchema).toMatchObject({ required: ['tool_name', 'input'] });
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });

  it('refuse a missing, wrong, expired or cookie-borne credential', async () => {
    const run = await heldRun('tokens');
    expect((await bridge('tools/list', null)).status).toBe(401);
    expect(await bridge('tools/list', 'not-a-token')).toMatchObject({ status: 401, body: { error: { code: 'invalid_bridge_token' } } });
    expect((await bridge('tools/list', `${run.token}x`)).status).toBe(401);
    expect((await bridge('tools/list', run.token.slice(0, -1))).status).toBe(401);
    expect((await bridge('tools/call', 'x'.repeat(43), { name: 'whoami' })).status).toBe(401);
    // A signed-in browser session is not a bridge credential.
    expect((await kit.owner.post('/api/bridge/tools/list')).status).toBe(401);
    // Nor is the token accepted as an API token elsewhere.
    const elsewhere = await kit.t.studio.app.inject({ method: 'GET', url: '/api/sessions', headers: { host: TEST_HOST, authorization: `Bearer ${run.token}` } });
    expect(elsewhere.statusCode).toBe(401);

    expect((await bridge('tools/list', run.token)).status).toBe(200);
    run.release();
    await kit.runEnded(kit.owner, run.runId);
    // The moment the run ends its token is worthless — even while another run is going.
    const other = await heldRun('tokens-other');
    expect(await bridge('tools/list', run.token)).toMatchObject({ status: 401, body: { error: { code: 'invalid_bridge_token' } } });
    expect((await bridge('tools/call', run.token, { name: 'whoami' })).status).toBe(401);
    expect((await bridge('tools/list', other.token)).status).toBe(200);
    await kit.owner.post(`/api/sessions/${other.session.id}/stop`);
    expect((await bridge('tools/list', other.token)).status).toBe(401);
  });

  it('answer only a peer on this machine that did not come through a proxy', async () => {
    const run = await heldRun('loopback');
    expect(await bridge('tools/list', run.token, {}, { remoteAddress: '203.0.113.9' })).toMatchObject({ status: 403, body: { error: { code: 'bridge_local_only' } } });
    expect((await bridge('tools/list', run.token, {}, { remoteAddress: '10.0.0.5' })).status).toBe(403);
    expect((await bridge('tools/call', run.token, { name: 'whoami' }, { remoteAddress: '::ffff:192.168.1.20' })).status).toBe(403);
    // A tunnel or reverse proxy on this host connects from loopback too; its requests carry forwarding headers.
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'via']) {
      expect((await bridge('tools/list', run.token, {}, { headers: { [header]: '203.0.113.9' } })).status, header).toBe(403);
    }
    // A public host name is never the bridge's address.
    expect((await bridge('tools/list', run.token, {}, { headers: { host: 'studio.example.com' } })).status).toBe(403);
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await bridge('tools/list', run.token, {}, { remoteAddress })).status, remoteAddress).toBe(200);
    }
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });

  it('run a tool with the identity of the run whose token was used, and no other', async () => {
    const member = await kit.t.member('toolsmith');
    await kit.share(kit.project, member);
    const mine = await heldRun('identity-owner');
    const theirSession = await kit.session(member);
    kit.agent.script([{ gate: 'identity-member' }]);
    const theirs = await kit.send(member, theirSession.id, 'hold');
    await kit.agent.reached('identity-member');
    const theirToken = kit.agent.lastRun.request.bridge.env.STUDIO_BRIDGE_TOKEN!;

    const asOwner = await bridge('tools/call', mine.token, { name: 'whoami', arguments: {} });
    expect(asOwner.body.isError).toBe(false);
    expect(JSON.parse(asOwner.body.content![0]!.text)).toEqual({ runId: mine.runId, sessionId: mine.session.id, projectId: kit.project.id, userId: kit.owner.userId, agentId: kit.agent.id });
    // Naming someone else's run in the request changes nothing: the token decides.
    const asMember = await bridge('tools/call', theirToken, { name: 'whoami', arguments: { runId: mine.runId, userId: kit.owner.userId }, runId: mine.runId });
    expect(JSON.parse(asMember.body.content![0]!.text)).toEqual({ runId: theirs.body.runId, sessionId: theirSession.id, projectId: kit.project.id, userId: member.userId, agentId: kit.agent.id });

    expect((await bridge('tools/call', mine.token, { name: 'no_such_tool' })).body).toMatchObject({ isError: true });
    expect((await bridge('tools/call', mine.token, {})).status).toBe(400);
    mine.release();
    kit.agent.open('identity-member');
    await kit.runEnded(kit.owner, mine.runId);
    await kit.runEnded(member, theirs.body.runId!);
  });

  it('ask before a tool that changes something, and call it only when allowed', async () => {
    const run = await heldRun('write-tool');
    calls.length = 0;
    const call = bridge('tools/call', run.token, { name: 'note_write', arguments: { title: 'Plan', body: 'ship it' } });
    const approval = await pendingApproval(run.session.id);
    expect(approval).toMatchObject({ kind: 'tool', toolName: 'note_write', toolKind: 'other', risk: 'medium', input: { title: 'Plan', body: 'ship it' }, suggestedRule: { tool: 'note_write', pattern: null } });
    expect(calls).toEqual([]);
    await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    expect((await call).body).toEqual({ content: [{ type: 'text', text: 'saved "Plan"' }], isError: false });
    expect(calls).toEqual([{ tool: 'note_write', context: expect.objectContaining({ runId: run.runId, userId: kit.owner.userId, sessionId: run.session.id }), input: { title: 'Plan', body: 'ship it' } }]);

    const refused = bridge('tools/call', run.token, { name: 'note_write', arguments: { title: 'Nope', body: '' } });
    const second = await pendingApproval(run.session.id);
    await kit.owner.post(`/api/approvals/${second.id}/decision`, { decision: 'deny', note: 'not now' });
    expect((await refused).body).toEqual({ content: [{ type: 'text', text: 'Not allowed: not now' }], isError: true });
    expect(calls).toHaveLength(1);

    // A read tool is not asked about, and bad input never reaches a handler.
    expect((await bridge('tools/call', run.token, { name: 'whoami' })).body.isError).toBe(false);
    expect((await kit.state(kit.owner, run.session.id)).pendingApprovals).toEqual([]);
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });

  it('turn an agent\'s permission prompt into an approval and answer in the agent\'s format', async () => {
    const run = await heldRun('prompt');
    const call = bridge('tools/call', run.token, { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'npm publish', description: 'Publish' }, tool_use_id: 'toolu_1' } });
    const approval = await pendingApproval(run.session.id);
    expect(approval).toMatchObject({ toolName: 'Bash', toolKind: 'execute', command: 'npm publish', toolCallId: 'toolu_1' });
    await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    const allowed = await call;
    expect(allowed.body.isError).toBe(false);
    expect(JSON.parse(allowed.body.content![0]!.text)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm publish', description: 'Publish' } });
    expect(kit.agent.lastRun.prompts).toEqual([{ toolName: 'Bash', input: { command: 'npm publish', description: 'Publish' }, toolCallId: 'toolu_1' }]);

    const denied = bridge('tools/call', run.token, { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'rm -rf ~' } } });
    expect(JSON.parse((await denied).body.content![0]!.text)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('home directory') });

    // A question the agent asks through the same tool comes back with the answers filled in.
    const question = bridge('tools/call', run.token, {
      name: 'permission_prompt',
      arguments: { tool_name: 'AskUserQuestion', input: { questions: [{ id: 'q', question: 'Tabs or spaces?', options: [{ label: 'Tabs' }, { label: 'Spaces' }], multiSelect: false }] } },
    });
    const asked = await pendingApproval(run.session.id);
    expect(asked).toMatchObject({ kind: 'question' });
    await kit.owner.post(`/api/approvals/${asked.id}/decision`, { decision: 'allow', answers: [{ questionId: 'q', selected: ['Spaces'] }] });
    expect(JSON.parse((await question).body.content![0]!.text)).toMatchObject({ behavior: 'allow', updatedInput: { answers: [{ questionId: 'q', selected: ['Spaces'] }] } });

    // A prompt that cannot be read is a refusal, not an error the agent might shrug off.
    const malformed = await bridge('tools/call', run.token, { name: 'permission_prompt', arguments: { input: {} } });
    expect(JSON.parse(malformed.body.content![0]!.text)).toMatchObject({ behavior: 'deny' });
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });

  it('treat a prompt from an agent it knows nothing about as a tool of unknown kind', async () => {
    const run = await heldRun('plain-prompt', plain);
    const reading = bridge('tools/call', run.token, { name: 'permission_prompt', arguments: { tool_name: 'Mystery', input: { file_path: 'notes.md' } } });
    const first = await pendingApproval(run.session.id);
    expect(first).toMatchObject({ toolName: 'Mystery', toolKind: 'other', paths: ['notes.md'], command: null });
    await kit.owner.post(`/api/approvals/${first.id}/decision`, { decision: 'deny' });
    expect(JSON.parse((await reading).body.content![0]!.text)).toEqual({ behavior: 'deny', message: 'The user denied this request.' });

    const running = bridge('tools/call', run.token, { name: 'permission_prompt', arguments: { tool_name: 'Shell', input: { command: 'sudo make install' } } });
    const second = await pendingApproval(run.session.id);
    expect(second).toMatchObject({ toolName: 'Shell', toolKind: 'execute', command: 'sudo make install', risk: 'dangerous', riskCategories: ['privilege'] });
    await kit.owner.post(`/api/approvals/${second.id}/decision`, { decision: 'allow' });
    expect(JSON.parse((await running).body.content![0]!.text)).toEqual({ behavior: 'allow', updatedInput: { command: 'sudo make install' } });
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });

  it('offer the same tools, with the same checks, to an adapter that calls functions itself', async () => {
    const session = await kit.session();
    calls.length = 0;
    kit.agent.script([
      {
        do: (run) => {
          const offered = run.host.studioTools.list().map((tool) => [tool.name, tool.effect]);
          expect(offered).toEqual(expect.arrayContaining([['whoami', 'read'], ['note_write', 'write']]));
          expect(offered.map(([name]) => name)).not.toContain('permission_prompt');
        },
      },
      { studioTool: { name: 'whoami', input: {} } },
      { studioTool: { name: 'note_write', input: { title: 'From an API model', body: 'hello' } } },
      { studioTool: { name: 'note_write', input: { title: '' } } },
    ]);
    const sent = await kit.send(kit.owner, session.id, 'use your tools');
    const approval = await pendingApproval(session.id);
    await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow', remember: 'session' });
    const run: Run = await kit.runEnded(kit.owner, sent.body.runId!);
    expect(run.status).toBe('completed');
    const results = kit.agent.lastRun.toolResults;
    expect(JSON.parse(results[0]!.text)).toMatchObject({ runId: run.id, userId: kit.owner.userId });
    expect(results[1]).toEqual({ text: 'saved "From an API model"' });
    // Remembered for the session, so not asked again — and invalid input is refused before the handler.
    expect(results[2]).toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
  });
});

describe('the bridge process', () => {
  it('serves the Studio\'s tools to an MCP client over stdio, for as long as its run lasts', async () => {
    await kit.listen();
    const run = await heldRun('real-bridge');
    const { command, args, env } = run.request.bridge;
    expect(env.STUDIO_BRIDGE_URL).toBe(`http://127.0.0.1:${(await kit.listen()).port}`);

    const transport = new StdioClientTransport({ command, args: [...args], env: { ...env, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...kit.t.studio.context.agentTools.list().map((tool) => tool.name), 'permission_prompt']);
      expect(listed.tools.find((tool) => tool.name === 'note_write')!.inputSchema).toMatchObject({ type: 'object', required: ['title', 'body'] });

      const who = (await client.callTool({ name: 'whoami', arguments: {} })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(who.isError).toBeFalsy();
      expect(JSON.parse(who.content[0]!.text)).toMatchObject({ runId: run.runId, sessionId: run.session.id, userId: kit.owner.userId });

      // A permission prompt blocks in the bridge until a person has decided.
      const prompt = client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'npm run e2e' }, tool_use_id: 'toolu_9' } });
      const approval = await pendingApproval(run.session.id);
      expect(approval).toMatchObject({ command: 'npm run e2e', toolCallId: 'toolu_9' });
      await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
      const answer = (await prompt) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(answer.content[0]!.text)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm run e2e' } });

      // When the run ends, the same process can do nothing more.
      run.release();
      await kit.runEnded(kit.owner, run.runId);
      const after = (await client.callTool({ name: 'whoami', arguments: {} })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(after.isError).toBe(true);
      expect(after.content[0]!.text).toContain('not valid');
      const refused = (await client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'ls' } } })) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ behavior: 'deny' });
    } finally {
      await client.close();
    }
  });

  it('refuses to start without its two variables', async () => {
    const run = await heldRun('bridge-no-env');
    const { command, args } = run.request.bridge;
    const transport = new StdioClientTransport({ command, args: [...args], env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => {});
    run.release();
    await kit.runEnded(kit.owner, run.runId);
  });
});

/** A throwaway self-signed certificate, when the machine has openssl to make one. */
function selfSignedCertificate(): { directory: string; certFile: string; keyFile: string } | null {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-studio-tls-'));
  const certFile = path.join(directory, 'cert.pem');
  const keyFile = path.join(directory, 'key.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=studio.example.test'], { stdio: 'ignore' });
    return { directory, certFile, keyFile };
  } catch {
    rmSync(directory, { recursive: true, force: true });
    return null;
  }
}

describe('the bridge when the server speaks TLS', () => {
  const certificate = selfSignedCertificate();
  afterAll(() => {
    if (certificate) rmSync(certificate.directory, { recursive: true, force: true });
  });

  it.skipIf(certificate === null)('reaches the server by pinning its certificate, and refuses any other', async () => {
    const secure = await createAgentsKit({ extraModules: [toolsModule], config: { tls: { certFile: certificate!.certFile, keyFile: certificate!.keyFile } } });
    try {
      const { port } = await secure.listen();
      const session = await secure.session();
      secure.agent.script([{ gate: 'tls' }]);
      const sent = await secure.send(secure.owner, session.id, 'hold');
      await secure.agent.reached('tls');
      const { command, args, env } = secure.agent.lastRun.request.bridge;
      expect(env.STUDIO_BRIDGE_URL).toBe(`https://127.0.0.1:${port}`);
      expect(env.STUDIO_BRIDGE_TLS_PIN).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(Object.keys(env).sort()).toEqual(['STUDIO_BRIDGE_TLS_PIN', 'STUDIO_BRIDGE_TOKEN', 'STUDIO_BRIDGE_URL']);

      const connect = async (variables: Readonly<Record<string, string | undefined>>) => {
        const client = new Client({ name: 'bridge-tls-test', version: '1.0.0' });
        await client.connect(new StdioClientTransport({ command, args: [...args], env: { ...(JSON.parse(JSON.stringify(variables)) as Record<string, string>), PATH: process.env.PATH ?? '' }, stderr: 'pipe' }));
        return client;
      };
      const trusted = await connect(env);
      try {
        const who = (await trusted.callTool({ name: 'whoami', arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
        expect(who.isError, who.content[0]!.text).toBeFalsy();
        expect(JSON.parse(who.content[0]!.text)).toMatchObject({ runId: sent.body.runId, userId: secure.owner.userId });
      } finally {
        await trusted.close();
      }
      // Told to expect a different certificate, the bridge sends nothing — not even its token.
      const wrongPin = env.STUDIO_BRIDGE_TLS_PIN!.replace(/^[0-9A-F]{2}/, (head) => (head === '00' ? '01' : '00'));
      for (const variables of [{ ...env, STUDIO_BRIDGE_TLS_PIN: wrongPin }, { STUDIO_BRIDGE_URL: env.STUDIO_BRIDGE_URL!, STUDIO_BRIDGE_TOKEN: env.STUDIO_BRIDGE_TOKEN! }]) {
        const suspicious = await connect(variables);
        try {
          const refused = (await suspicious.callTool({ name: 'whoami', arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
          expect(refused.isError).toBe(true);
          expect(refused.content[0]!.text).toContain('not told to trust');
        } finally {
          await suspicious.close();
        }
      }
      secure.agent.open('tls');
      await secure.runEnded(secure.owner, sent.body.runId!);
    } finally {
      await secure.close();
    }
  });
});
