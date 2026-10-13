import { existsSync } from 'node:fs';
import path from 'node:path';
import { type ActivitySummary, type Agent, type MessageSearchHit, type Session, type SessionList, type SessionUsage, sessionTopic, userTopic } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';
import type { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

let kit: AgentsKit;
const chatModel = new ScriptedAdapter({ id: 'chat-model', displayName: 'Chat model', kind: 'api', permissionModes: ['ask'] });

beforeAll(async () => {
  kit = await createAgentsKit({ adapters: [new ScriptedAdapter({ nativeSessionId: 'native-abc' }), chatModel] });
});
afterAll(async () => {
  await kit.close();
});

const read = async (client: TestClient, sessionId: string): Promise<Session> => (await client.get<Session>(`/api/sessions/${sessionId}`)).body;
const list = async (client: TestClient, query = ''): Promise<SessionList> => (await client.get<SessionList>(`/api/sessions${query}`)).body;
const search = async (client: TestClient, q: string, extra = ''): Promise<MessageSearchHit[]> =>
  (await client.get<{ hits: MessageSearchHit[] }>(`/api/sessions/search?q=${encodeURIComponent(q)}${extra}`)).body.hits;

describe('agents', () => {
  it('lists what is registered, with capabilities and status but no credentials', async () => {
    const { owner, agent } = kit;
    // The real adapters (Claude Code, Codex) register themselves too; this test is about the two it controls.
    const all = (await owner.get<{ agents: Agent[] }>('/api/agents')).body.agents;
    const agents = all.filter((entry) => entry.id === 'scripted' || entry.id === 'chat-model');
    expect(agents.map((entry) => [entry.id, entry.kind])).toEqual([
      ['scripted', 'cli'],
      ['chat-model', 'api'],
    ]);
    expect(JSON.stringify(all)).not.toMatch(/token|secret|apiKey|password/i);
    expect(agents[0]).toMatchObject({
      displayName: 'Scripted agent',
      capabilities: { defaultModel: 'scripted-large', permissionModes: ['plan', 'ask', 'accept-edits', 'auto'], steering: true, resume: true, images: true, planMode: true, usage: true },
      status: { installed: true, signedIn: true, account: 'scripted@example.test', problem: null },
    });
    expect(agents[0]!.capabilities.models[0]).toMatchObject({ id: 'scripted-large', recommended: true, contextWindow: 200_000, efforts: ['low', 'high'] });
    agent.currentStatus = { installed: true, version: '1.0.0', signedIn: false, account: null, problem: 'Sign in to the agent on this machine first.' };
    expect((await owner.get<Agent>('/api/agents/scripted')).body.status).toMatchObject({ signedIn: false, problem: 'Sign in to the agent on this machine first.' });
    agent.currentStatus = { installed: true, version: '1.0.0', signedIn: true, account: 'scripted@example.test', problem: null };
    expect((await owner.get('/api/agents/nobody')).status).toBe(404);
  });
});

describe('sessions', () => {
  it('are created with an id of their own before any message, with the agent\'s defaults', async () => {
    const { owner, project } = kit;
    const created = await owner.post<Session>('/api/sessions', { projectId: project.id, agentId: 'scripted' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      projectId: project.id,
      userId: owner.userId,
      agentId: 'scripted',
      model: 'scripted-large',
      effort: null,
      permissionMode: 'ask',
      effectivePermissionMode: 'ask',
      title: 'New session',
      titleSource: 'default',
      pinned: false,
      archived: false,
      attention: 'none',
      activeRunId: null,
      hasDraft: false,
      resumable: false,
      lastSeq: 0,
      lastUserMessageAt: null,
      chainId: null,
      parentSessionId: null,
    });
    expect(created.body.id).toMatch(/^[0-9a-z]{26}$/);
    expect(await read(owner, created.body.id)).toEqual(created.body);
    expect((await kit.events(owner, created.body.id))).toEqual([]);

    const chosen = await kit.session(owner, { model: 'scripted-small', effort: 'high', permissionMode: 'plan', title: 'Release notes' });
    expect(chosen).toMatchObject({ model: 'scripted-small', effort: 'high', permissionMode: 'plan', title: 'Release notes', titleSource: 'manual' });

    for (const body of [
      { projectId: project.id },
      { projectId: 'not-an-id', agentId: 'scripted' },
      { projectId: project.id, agentId: 'scripted', permissionMode: 'yolo' },
      { projectId: project.id, agentId: 'scripted', title: '   ' },
      { projectId: project.id, agentId: 'scripted', title: 'x'.repeat(201) },
    ]) {
      expect((await owner.post('/api/sessions', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await owner.post('/api/sessions', { projectId: '00000000000000000000000000', agentId: 'scripted' })).status).toBe(404);
    // A mode the agent does not have is refused; so is a plain chat model being given one.
    expect((await owner.post('/api/sessions', { projectId: project.id, agentId: 'chat-model', permissionMode: 'auto' })).body).toMatchObject({ error: { code: 'unsupported_permission_mode' } });
    expect((await owner.patch(`/api/sessions/${chosen.id}`, { permissionMode: 'auto' })).status).toBe(200);
  });

  it('may live outside a project only for a plain chat model', async () => {
    const { owner } = kit;
    const general = await owner.post<Session>('/api/sessions', { agentId: 'chat-model' });
    expect(general.status).toBe(201);
    expect(general.body).toMatchObject({ projectId: null, agentId: 'chat-model' });
    const run = await kit.turn(owner, general.body.id, 'hello model');
    expect(run).toMatchObject({ status: 'completed', projectId: null });
    expect(chatModel.lastRun.request).toMatchObject({ cwd: null, projectId: null });
    expect((await list(owner)).sessions.map((session) => session.id)).toContain(general.body.id);
    expect((await owner.post('/api/sessions', { agentId: 'scripted' })).body).toMatchObject({ error: { code: 'project_required' } });
    await owner.delete(`/api/sessions/${general.body.id}`);
  });

  it('are named from the first message, then by the agent, and never over a name the user typed', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const live = await kit.connect(owner);
    await live.subscribe(userTopic(owner.userId!));

    agent.script([{ emit: { type: 'title', title: '  **"Checkout redesign"**.  ' } }, { text: 'on it' }]);
    await kit.turn(owner, session.id, 'please   redesign the checkout page for mobile');
    expect(await read(owner, session.id)).toMatchObject({ title: 'Checkout redesign', titleSource: 'agent' });
    // Every device hears about the new name.
    const renames = live.events(userTopic(owner.userId!)).filter((frame) => frame.type === 'session.updated').map((frame) => (frame.data as { session: Session }).session.title);
    expect(renames).toContain('please redesign the checkout');
    expect(renames.at(-1)).toBe('Checkout redesign');

    // Proposals that are not usable as a name change nothing.
    for (const title of ['x', '???', 'y'.repeat(61), '']) {
      agent.script([{ emit: { type: 'title', title } }]);
      await kit.turn(owner, session.id, 'more');
      expect((await read(owner, session.id)).title, JSON.stringify(title)).toBe('Checkout redesign');
    }
    // A newer usable proposal wins.
    agent.script([{ emit: { type: 'title', title: '结账页面重构' } }]);
    await kit.turn(owner, session.id, 'more');
    expect((await read(owner, session.id)).title).toBe('结账页面重构');

    const renamed = await owner.patch<Session>(`/api/sessions/${session.id}`, { title: '  Mine  ' });
    expect(renamed.body).toMatchObject({ title: 'Mine', titleSource: 'manual' });
    agent.script([{ emit: { type: 'title', title: 'The agent knows better' } }]);
    await kit.turn(owner, session.id, 'more');
    expect(await read(owner, session.id)).toMatchObject({ title: 'Mine', titleSource: 'manual' });
    live.close();

    // Text without spaces is cut, not used whole; a message with only an attachment leaves the placeholder.
    const chinese = await kit.session();
    await kit.turn(owner, chinese.id, '请帮我把登录页面的表单校验逻辑重构一下并补充单元测试覆盖所有边界情况以及异常分支确保没有回归问题出现在生产环境');
    expect([...(await read(owner, chinese.id)).title].length).toBeLessThanOrEqual(60);
    expect((await read(owner, chinese.id)).titleSource).toBe('auto');
    expect((await owner.patch(`/api/sessions/${session.id}`, { title: '' })).status).toBe(400);
  });

  it('are listed running first, then pinned, then by the last user message — agent output does not reorder them', async () => {
    const { owner, agent } = kit;
    const project = await kit.makeProject('ordering');
    const make = (title: string) => kit.session(owner, { projectId: project.id, title });
    const oldest = await make('oldest');
    const middle = await make('middle');
    const newest = await make('newest');
    const untouched = await make('never used');
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const session of [oldest, middle, newest]) {
      await kit.turn(owner, session.id, `hello from ${session.title}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const titles = async (query = '') => (await list(owner, `?projectId=${project.id}${query}`)).sessions.map((session) => session.title);
    // A session nobody has written in yet sorts by when it was created.
    expect(await titles()).toEqual(['newest', 'middle', 'oldest', 'never used']);

    // Streamed output in an older session leaves it where it is.
    const before = (await read(owner, oldest.id)).lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    kit.t.studio.context.services.agents.sessions.append(oldest.id, null, 'notice', { runId: null, level: 'info', code: 'background', text: 'late output' });
    expect((await read(owner, oldest.id)).lastActivityAt).toBeGreaterThan(before);
    expect(await titles()).toEqual(['newest', 'middle', 'oldest', 'never used']);

    await owner.patch(`/api/sessions/${middle.id}`, { pinned: true });
    expect(await titles()).toEqual(['middle', 'newest', 'oldest', 'never used']);
    agent.script([{ gate: 'ordering' }]);
    const running = await kit.send(owner, oldest.id, 'now I am running');
    await agent.reached('ordering');
    expect(await titles()).toEqual(['oldest', 'middle', 'newest', 'never used']);
    expect((await list(owner, `?projectId=${project.id}`)).sessions[0]).toMatchObject({ attention: 'running', activeRunId: running.body.runId });
    agent.open('ordering');
    await kit.runEnded(owner, running.body.runId!);
    expect(await titles()).toEqual(['middle', 'oldest', 'newest', 'never used']);

    // Paging.
    const first = await list(owner, `?projectId=${project.id}&limit=3`);
    expect(first.sessions.map((session) => session.title)).toEqual(['middle', 'oldest', 'newest']);
    expect(first.hasMore).toBe(true);
    const second = await list(owner, `?projectId=${project.id}&limit=3&offset=3`);
    expect(second.sessions.map((session) => session.title)).toEqual(['never used']);
    expect(second.hasMore).toBe(false);
    expect((await owner.get(`/api/sessions?limit=201`)).status).toBe(400);
    void untouched;

    // Title search: every word, in any order and any case.
    expect(await titles('&q=NEVER')).toEqual(['never used']);
    expect(await titles('&q=used%20never')).toEqual(['never used']);
    expect(await titles('&q=e')).toEqual(['middle', 'oldest', 'newest', 'never used']);
    expect(await titles('&q=never%20oldest')).toEqual([]);
    expect(await titles('&q=100%25')).toEqual([]);
    expect(await titles('&q=_')).toEqual([]);
  });

  it('can be archived and restored, and come back by themselves on new activity', async () => {
    const { owner, agent } = kit;
    const project = await kit.makeProject('archive');
    const session = await kit.session(owner, { projectId: project.id, title: 'to be archived' });
    const keep = await kit.session(owner, { projectId: project.id, title: 'kept' });
    const ids = async (query: string) => (await list(owner, `?projectId=${project.id}${query}`)).sessions.map((entry) => entry.id);

    expect((await owner.patch<Session>(`/api/sessions/${session.id}`, { archived: true })).body.archived).toBe(true);
    expect(await ids('')).toEqual([keep.id]);
    expect(await ids('&archived=only')).toEqual([session.id]);
    expect((await ids('&archived=include')).sort()).toEqual([session.id, keep.id].sort());
    // Still reachable by its link.
    expect((await read(owner, session.id)).archived).toBe(true);
    expect((await owner.patch<Session>(`/api/sessions/${session.id}`, { archived: false })).body.archived).toBe(false);
    expect((await ids('')).sort()).toEqual([session.id, keep.id].sort());

    await owner.patch(`/api/sessions/${session.id}`, { archived: true });
    await kit.turn(owner, session.id, 'I am back');
    expect((await read(owner, session.id)).archived).toBe(false);

    // A running session cannot be archived out from under its run.
    agent.script([{ gate: 'archive-busy' }]);
    const running = await kit.send(owner, session.id, 'busy');
    await agent.reached('archive-busy');
    expect((await owner.patch(`/api/sessions/${session.id}`, { archived: true })).body).toMatchObject({ error: { code: 'session_busy' } });
    agent.open('archive-busy');
    await kit.runEnded(owner, running.body.runId!);

    // Sessions of an archived project leave the cross-project list but can still be listed by naming the project.
    await owner.patch(`/api/projects/${project.id}`, { archived: true });
    expect((await list(owner, '?limit=200')).sessions.map((entry) => entry.id)).not.toContain(keep.id);
    expect(await ids('')).toContain(keep.id);
    await owner.patch(`/api/projects/${project.id}`, { archived: false });
  });

  it('are deleted with everything that belonged to them', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const live = await kit.connect(owner);
    await live.subscribe(userTopic(owner.userId!));
    agent.script([{ text: 'a unique phrase: zebra-crossing-quartz' }, { emit: { type: 'usage', model: 'scripted-large', inputTokens: 10, outputTokens: 5 } }]);
    const run = await kit.turn(owner, session.id, 'say something memorable');
    await owner.post('/api/permission-rules', { scope: 'session', sessionId: session.id, effect: 'allow', tool: 'Bash' });
    agent.script([{ permission: { toolName: 'Edit', kind: 'edit', input: {}, paths: ['a.ts'] } }]);
    const pendingRun = await kit.send(owner, session.id, 'edit something');
    const approval = await until(async () => (await kit.state(owner, session.id)).pendingApprovals[0]);
    const queued = await kit.send(owner, session.id, 'queued message');
    expect(await search(owner, 'zebra-crossing-quartz')).toHaveLength(1);

    // Deleting stops the run in progress first.
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(204);
    expect(agent.lastRun.cancelled).toBe(true);

    for (const url of [
      `/api/sessions/${session.id}`,
      `/api/sessions/${session.id}/events`,
      `/api/sessions/${session.id}/state`,
      `/api/runs/${run.id}`,
      `/api/runs/${pendingRun.body.runId}`,
      `/api/approvals/${approval.id}`,
      `/api/sessions/${session.id}/messages/${queued.body.requestId}`,
    ]) {
      expect((await owner.get(url)).status, url).toBe(404);
    }
    const db = kit.t.studio.context.db;
    for (const table of ['agent_sessions', 'agent_events', 'agent_runs', 'agent_approvals', 'agent_queue', 'agent_receipts', 'agent_attachments', 'agent_permission_rules', 'agent_message_fts']) {
      const column = table === 'agent_sessions' ? 'id' : 'session_id';
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, session.id)!.n, table).toBe(0);
    }
    expect(await search(owner, 'zebra-crossing-quartz')).toEqual([]);
    expect((await list(owner, '?limit=200')).sessions.map((entry) => entry.id)).not.toContain(session.id);
    // What was spent stays on record.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_usage WHERE session_id = ?', session.id)!.n).toBe(1);
    // The agent's own copy of the conversation is removed too.
    expect(agent.deletedNativeSessions).toContain('native-abc');
    // Every device is told, and the id can be subscribed to no more.
    expect(await live.next((frame) => frame.op === 'event' && frame.type === 'session.removed')).toMatchObject({ data: { sessionId: session.id, projectId: kit.project.id } });
    expect(await live.subscribe(sessionTopic(session.id))).toMatchObject({ op: 'rejected' });
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(404);
    live.close();
  });

  it('disappear with their project, files included, and stop what was running there', async () => {
    const { owner, agent } = kit;
    const project = await kit.makeProject('doomed');
    const session = await kit.session(owner, { projectId: project.id });
    const boundary = 'b';
    const uploaded = await owner.request<{ attachments: Array<{ id: string }> }>(
      'POST',
      `/api/sessions/${session.id}/attachments`,
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhello\r\n--${boundary}--\r\n`),
      { 'content-type': `multipart/form-data; boundary=${boundary}` },
    );
    expect(uploaded.status).toBe(201);
    const folder = path.join(kit.t.dataDir, 'attachments', session.id);
    expect(existsSync(folder)).toBe(true);
    agent.script([{ text: 'doomed-project-marker' }, { hang: true }]);
    const running = await kit.send(owner, session.id, 'work in the doomed project');
    await until(async () => (await kit.state(owner, session.id)).run?.status === 'running');
    const token = agent.lastRun.request.bridge.env.STUDIO_BRIDGE_TOKEN!;

    expect((await owner.delete(`/api/projects/${project.id}`)).status).toBe(204);
    expect(agent.lastRun.cancelled).toBe(true);
    expect((await owner.get(`/api/sessions/${session.id}`)).status).toBe(404);
    expect((await owner.get(`/api/runs/${running.body.runId}`)).status).toBe(404);
    expect(await search(owner, 'doomed-project-marker')).toEqual([]);
    await until(() => !existsSync(folder), { what: 'the attachments to be removed' });
    const bridge = await kit.t.studio.app.inject({ method: 'POST', url: '/api/bridge/tools/list', headers: { host: 'localhost:7420', 'x-studio-bridge-token': token }, payload: {} });
    expect(bridge.statusCode).toBe(401);
    // The files of the project itself are not the Studio's to delete.
    expect(existsSync(project.rootDir)).toBe(true);
  });

  it('record a handoff as a chain of sessions', async () => {
    const { owner } = kit;
    const first = await kit.session();
    const second = await kit.session(owner, { parentSessionId: first.id, agentId: 'chat-model' });
    expect(second).toMatchObject({ parentSessionId: first.id, chainId: first.id, agentId: 'chat-model' });
    const third = await kit.session(owner, { parentSessionId: second.id });
    expect(third).toMatchObject({ parentSessionId: second.id, chainId: first.id });
    const elsewhere = await kit.makeProject('other-chain');
    expect((await owner.post('/api/sessions', { projectId: elsewhere.id, agentId: 'scripted', parentSessionId: first.id })).body).toMatchObject({ error: { code: 'parent_in_other_project' } });
    const stranger = await kit.t.member('chain-stranger');
    await kit.share(kit.project, stranger);
    expect((await stranger.post('/api/sessions', { projectId: kit.project.id, agentId: 'scripted', parentSessionId: first.id })).status).toBe(404);
  });
});

describe('drafts', () => {
  it('are kept per session, follow the account to its other devices, and end when the message is sent', async () => {
    const { owner } = kit;
    const other = await kit.t.signIn('owner');
    const session = await kit.session();
    const live = await kit.connect(other);
    await live.subscribe(userTopic(owner.userId!));

    const saved = await owner.put<{ text: string; updatedAt: number }>(`/api/sessions/${session.id}/draft`, { text: 'half a thought' });
    expect(saved.body).toMatchObject({ sessionId: session.id, text: 'half a thought' });
    expect(await live.next((frame) => frame.op === 'event' && frame.type === 'session.draft')).toMatchObject({ data: { sessionId: session.id, text: 'half a thought' } });
    expect((await other.get(`/api/sessions/${session.id}/draft`)).body).toMatchObject({ text: 'half a thought' });
    expect((await read(other, session.id)).hasDraft).toBe(true);
    expect((await list(owner, '?limit=200')).sessions.find((entry) => entry.id === session.id)!.hasDraft).toBe(true);
    // Another session has its own.
    const sibling = await kit.session();
    expect((await owner.get(`/api/sessions/${sibling.id}/draft`)).body).toMatchObject({ text: '', updatedAt: null });

    await kit.turn(owner, session.id, 'half a thought, finished');
    expect((await owner.get(`/api/sessions/${session.id}/draft`)).body).toMatchObject({ text: '' });
    expect((await read(owner, session.id)).hasDraft).toBe(false);

    await owner.put(`/api/sessions/${session.id}/draft`, { text: 'another' });
    await owner.put(`/api/sessions/${session.id}/draft`, { text: '' });
    expect((await read(owner, session.id)).hasDraft).toBe(false);
    expect((await owner.put(`/api/sessions/${session.id}/draft`, { text: 'x'.repeat(100_001) })).status).toBe(400);
    live.close();
  });
});

describe('attention and presence', () => {
  it('marks a result nobody saw, clears it when the session is opened, and counts it per project', async () => {
    const { owner, agent } = kit;
    const quiet = await kit.makeProject('quiet-project');
    const busy = await kit.makeProject('busy-project');
    const unseen = await kit.session(owner, { projectId: quiet.id });
    const asking = await kit.session(owner, { projectId: busy.id });
    const working = await kit.session(owner, { projectId: busy.id });
    const idle = await kit.makeProject('idle-project');
    await kit.session(owner, { projectId: idle.id });
    const before = kit.internal.length;

    const run = await kit.turn(owner, unseen.id, 'finish while I am elsewhere');
    expect(run.seenAt).toBeNull();
    expect((await read(owner, unseen.id)).attention).toBe('unseen');
    // The notification module is told that nobody was looking.
    expect(kit.internal.slice(before).find((event) => event.type === 'run.finished')).toMatchObject({
      topic: 'internal:runs',
      data: { runId: run.id, sessionId: unseen.id, projectId: quiet.id, userId: owner.userId, agentId: 'scripted', status: 'completed', error: null, visibleTo: [], origin: 'interactive', unattended: false },
    });
    expect(kit.internal.slice(before).find((event) => event.type === 'run.started')).toMatchObject({ data: { runId: run.id, userId: owner.userId, origin: 'interactive' } });

    agent.script([{ permission: { toolName: 'Bash', kind: 'execute', input: {}, command: 'npm test' } }]);
    const waiting = await kit.send(owner, asking.id, 'needs an answer');
    const approval = await until(async () => (await kit.state(owner, asking.id)).pendingApprovals[0]);
    agent.script([{ gate: 'activity' }]);
    const running = await kit.send(owner, working.id, 'just running');
    await agent.reached('activity');

    const summary = (await owner.get<ActivitySummary>('/api/sessions/activity')).body.projects;
    expect(summary.find((entry) => entry.projectId === quiet.id)).toEqual({ projectId: quiet.id, running: 0, runningAgents: [], attention: [], unseen: [unseen.id] });
    const busyEntry = summary.find((entry) => entry.projectId === busy.id)!;
    expect(busyEntry).toMatchObject({ running: 2, runningAgents: ['scripted'], attention: [asking.id], unseen: [] });
    // Idle projects are left out.
    expect(summary.map((entry) => entry.projectId)).not.toContain(idle.id);

    // Answered, then finished unseen: the mark changes from "needs you" to "unseen".
    await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    await kit.runEnded(owner, waiting.body.runId!);
    expect((await read(owner, asking.id)).attention).toBe('unseen');
    agent.open('activity');
    await kit.runEnded(owner, running.body.runId!);

    // Opening a session — on any device — clears its mark.
    const elsewhere = await kit.t.signIn('owner');
    expect((await elsewhere.post<Session>(`/api/sessions/${unseen.id}/seen`)).body.attention).toBe('none');
    expect((await owner.get(`/api/runs/${run.id}`)).body).toMatchObject({ seenAt: expect.any(Number) });
    const after = (await owner.get<ActivitySummary>('/api/sessions/activity')).body.projects;
    expect(after.map((entry) => entry.projectId)).not.toContain(quiet.id);
    expect(after.find((entry) => entry.projectId === busy.id)).toMatchObject({ running: 0, unseen: expect.arrayContaining([asking.id, working.id]) });
  });

  it('counts a result as seen when its session is visibly on screen, and raises nothing for it', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const other = await kit.session();
    const report = (visible: string[], clientId = 'tab-one-0001') => owner.put('/api/sessions/presence', { clientId, visible });
    expect((await report([session.id])).status).toBe(204);

    const before = kit.internal.length;
    const seen = await kit.turn(owner, session.id, 'I am watching this one');
    expect(seen.seenAt).not.toBeNull();
    expect((await read(owner, session.id)).attention).toBe('none');
    expect(kit.internal.slice(before).find((event) => event.type === 'run.finished')).toMatchObject({ data: { runId: seen.id, visibleTo: [owner.userId] } });
    // Another session of the same user is not on screen.
    await kit.turn(owner, other.id, 'not watching this one');
    expect((await read(owner, other.id)).attention).toBe('unseen');

    // An approval request also says who is looking.
    agent.script([{ permission: { toolName: 'Bash', kind: 'execute', input: {}, command: 'make' } }]);
    const asking = await kit.send(owner, session.id, 'ask me');
    const approval = await until(async () => (await kit.state(owner, session.id)).pendingApprovals[0]);
    expect(kit.internal.find((event) => event.type === 'approval.pending' && (event.data as { approvalId: string }).approvalId === approval.id)).toMatchObject({ data: { visibleTo: [owner.userId], requiresOwner: false } });
    await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
    await kit.runEnded(owner, asking.body.runId!);
    expect(kit.internal.find((event) => event.type === 'approval.resolved' && (event.data as { approvalId: string }).approvalId === approval.id)).toMatchObject({ data: { status: 'denied', decidedBy: owner.userId } });

    // A failure is never read by itself, even with the session on screen.
    agent.script([{ fail: { code: 'boom', message: 'It broke.' } }]);
    const failed = await kit.turn(owner, session.id, 'fail in front of me');
    expect(failed.seenAt).toBeNull();
    expect((await read(owner, session.id)).attention).toBe('needs-you');
    await owner.post(`/api/sessions/${session.id}/seen`);
    expect((await read(owner, session.id)).attention).toBe('needs-you');
    await owner.post(`/api/runs/${failed.id}/dismiss`);
    expect((await read(owner, session.id)).attention).toBe('none');

    // Each report replaces the tab's previous one; an empty one means the page is hidden.
    await report([other.id]);
    expect((await read(owner, other.id)).attention).toBe('none');
    await report([]);
    await kit.turn(owner, session.id, 'page hidden now');
    expect((await read(owner, session.id)).attention).toBe('unseen');
    // Two tabs: either one showing the session is enough.
    await report([session.id], 'tab-two-0002');
    expect((await read(owner, session.id)).attention).toBe('none');
    await kit.turn(owner, session.id, 'second tab is watching');
    expect((await read(owner, session.id)).attention).toBe('none');
    await report([], 'tab-two-0002');

    expect((await owner.put('/api/sessions/presence', { clientId: 'tab-one-0001', visible: Array.from({ length: 33 }, () => session.id) })).status).toBe(400);
    expect((await owner.put('/api/sessions/presence', { clientId: 'short', visible: [] })).status).toBe(400);
  });
});

describe('presence that is not renewed', () => {
  it('stops counting after a while', async () => {
    const brief = await createAgentsKit({ agents: { presenceTtlMs: 120 } });
    try {
      const session = await brief.session();
      await brief.owner.put('/api/sessions/presence', { clientId: 'tab-brief-0001', visible: [session.id] });
      expect((await brief.turn(brief.owner, session.id, 'seen')).seenAt).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await brief.turn(brief.owner, session.id, 'the tab went away without saying so')).seenAt).toBeNull();
    } finally {
      await brief.close();
    }
  });
});

describe('searching message text', () => {
  it('finds words, phrases and Chinese text, and points at the message', async () => {
    const { owner, agent } = kit;
    const project = await kit.makeProject('searchable');
    const english = await kit.session(owner, { projectId: project.id, title: 'English session' });
    const chinese = await kit.session(owner, { projectId: project.id, title: '中文会话' });
    agent.script([{ text: 'The flux capacitor needs 1.21 gigawatts of power to work.' }]);
    await kit.turn(owner, english.id, 'How does the Flux Capacitor work?');
    agent.script([{ text: '登录失败通常是因为会话令牌已经过期，请重新登录后再试一次。' }]);
    await kit.turn(owner, chinese.id, '为什么用户登录失败了？帮我排查一下原因');

    const hits = await search(owner, 'flux capacitor');
    expect(hits.map((hit) => [hit.sessionId, hit.role])).toEqual([
      [english.id, 'assistant'],
      [english.id, 'user'],
    ]);
    expect(hits[0]).toMatchObject({ title: 'English session', projectId: project.id, seq: 3 });
    // The snippet contains the match, and says where.
    for (const hit of hits) expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe('flux capacitor');
    const event = (await kit.events(owner, english.id)).find((entry) => entry.seq === hits[0]!.seq)!;
    expect(event).toMatchObject({ type: 'message.assistant' });

    // Chinese has no spaces to split on: any run of characters is found.
    const zh = await search(owner, '登录失败');
    expect(zh.map((hit) => hit.sessionId)).toEqual([chinese.id, chinese.id]);
    expect(zh[0]!.snippet).toContain('登录失败');
    expect((await search(owner, '会话令牌已经过期')).map((hit) => [hit.sessionId, hit.role])).toEqual([[chinese.id, 'assistant']]);
    expect((await search(owner, '排查一下')).map((hit) => hit.role)).toEqual(['user']);
    // Shorter than three characters: still found, by scanning.
    expect((await search(owner, '登录', `&projectId=${project.id}`)).map((hit) => hit.sessionId)).toEqual([chinese.id, chinese.id]);
    expect((await search(owner, '因', `&projectId=${project.id}`)).map((hit) => hit.role)).toEqual(['assistant', 'user']);
    expect((await search(owner, 'of')).map((hit) => hit.sessionId)).toContain(english.id);

    // A multi-word query is a phrase; punctuation and quotes are just text.
    expect(await search(owner, 'capacitor flux')).toEqual([]);
    expect((await search(owner, '1.21 gigawatts')).length).toBe(1);
    for (const hostile of ['"', '" OR 1=1 --', 'NEAR(', '*', 'a" AND "b', "'; DROP TABLE agent_events; --", '%', '_', 'col:', '^flux']) {
      const response = await owner.get(`/api/sessions/search?q=${encodeURIComponent(hostile)}`);
      expect(response.status, hostile).toBe(200);
    }
    expect((await kit.events(owner, english.id)).length).toBeGreaterThan(0);
    expect(await search(owner, 'no such text anywhere zzz')).toEqual([]);
    expect((await owner.get('/api/sessions/search?q=')).status).toBe(400);
    expect((await owner.get('/api/sessions/search')).status).toBe(400);

    // Narrowed to one project; archived sessions are left out.
    expect((await search(owner, 'flux capacitor', `&projectId=${kit.project.id}`))).toEqual([]);
    expect((await search(owner, 'flux capacitor', `&projectId=${project.id}&limit=1`))).toHaveLength(1);
    await owner.patch(`/api/sessions/${english.id}`, { archived: true });
    expect(await search(owner, 'flux capacitor')).toEqual([]);
    await owner.patch(`/api/sessions/${english.id}`, { archived: false });
  });

  it('only ever finds the caller\'s own conversations', async () => {
    const { owner } = kit;
    const member = await kit.t.member('searcher');
    await kit.share(kit.project, member);
    const mine = await kit.session(member);
    kit.agent.script([{ text: 'the member answer mentions plutonium-239' }]);
    await kit.turn(member, mine.id, 'a member question about plutonium-239');
    const theirs = await kit.session(owner);
    kit.agent.script([{ text: 'the owner answer mentions plutonium-239 as well' }]);
    await kit.turn(owner, theirs.id, 'an owner question');

    expect((await search(member, 'plutonium-239')).every((hit) => hit.sessionId === mine.id)).toBe(true);
    expect(await search(member, 'plutonium-239')).toHaveLength(2);
    // The owner's own search is the owner's own conversations too.
    expect((await search(owner, 'plutonium-239')).map((hit) => hit.sessionId)).toEqual([theirs.id]);
    // A project the member cannot see is not searchable by naming it.
    const hidden = await kit.makeProject('hidden-from-member');
    expect((await member.get(`/api/sessions/search?q=plutonium&projectId=${hidden.id}`)).status).toBe(404);
    // Off the project, the member's own messages there are out of reach as well.
    await owner.delete(`/api/projects/${kit.project.id}/members/${member.userId}`);
    expect(await search(member, 'plutonium-239')).toEqual([]);
  });
});

describe('usage', () => {
  it('records what each run used and shows how full the context is', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    expect((await owner.get<SessionUsage>(`/api/sessions/${session.id}/usage`)).body).toEqual({ context: null, totals: [] });

    agent.script([
      // Two requests to one model are added up…
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: 0.01, contextTokens: 1260, contextWindow: 200_000 } },
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 2000, outputTokens: 300, costUsd: 0.02, contextTokens: 3560, contextWindow: 200_000 } },
      // …a sub-agent on another model is kept apart…
      { emit: { type: 'usage', model: 'scripted-small', inputTokens: 400, outputTokens: 40 } },
      { text: 'done' },
    ]);
    const first = await kit.turn(owner, session.id, 'use some tokens');
    agent.script([
      // …and an agent that reports running totals replaces instead of adding.
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 500, outputTokens: 50, cumulative: true } },
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 900, outputTokens: 90, contextTokens: 160_000, contextWindow: 200_000, cumulative: true } },
    ]);
    const second = await kit.turn(owner, session.id, 'and some more');

    const usage = (await owner.get<SessionUsage>(`/api/sessions/${session.id}/usage`)).body;
    expect(usage.context).toMatchObject({ tokens: 160_000, window: 200_000, model: 'scripted-large' });
    expect(usage.totals).toEqual([
      { model: 'scripted-large', inputTokens: 3900, outputTokens: 590, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: 0.03 },
      { model: 'scripted-small', inputTokens: 400, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    ]);

    // One row per run and model, saying whose it was and where — the table a usage report reads.
    const rows = kit.t.studio.context.db.all<Record<string, unknown>>('SELECT * FROM agent_usage WHERE session_id = ? ORDER BY at, model', session.id);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.run_id === first.id && row.model === 'scripted-large')).toMatchObject({
      user_id: owner.userId,
      project_id: kit.project.id,
      agent_id: 'scripted',
      input_tokens: 3000,
      output_tokens: 500,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
      cost_usd: 0.03,
      context_tokens: 3560,
      context_window: 200_000,
    });
    expect(rows.find((row) => row.run_id === second.id)).toMatchObject({ input_tokens: 900, output_tokens: 90, cost_usd: null, context_tokens: 160_000 });
    // The transcript carries the running totals, so a client can show them live.
    const reported = (await kit.events(owner, session.id)).filter((event) => event.type === 'usage.reported').map((event) => event.data as { model: string; inputTokens: number; contextTokens: number | null });
    expect(reported.map((entry) => [entry.model, entry.inputTokens, entry.contextTokens])).toEqual([
      ['scripted-large', 1000, 1260],
      ['scripted-large', 3000, 3560],
      ['scripted-small', 400, null],
      ['scripted-large', 500, null],
      ['scripted-large', 900, 160_000],
    ]);
    // A window that is not known is never invented; nonsense figures are not stored.
    const unknown = await kit.session();
    agent.script([{ emit: { type: 'usage', model: 'mystery', inputTokens: -5, outputTokens: Number.NaN, contextTokens: 5000 } }]);
    await kit.turn(owner, unknown.id, 'who knows');
    const figures = (await owner.get<SessionUsage>(`/api/sessions/${unknown.id}/usage`)).body;
    expect(figures.context).toMatchObject({ tokens: 5000, window: null });
    expect(figures.totals).toEqual([{ model: 'mystery', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }]);
    void nextRequestId;
  });
});
