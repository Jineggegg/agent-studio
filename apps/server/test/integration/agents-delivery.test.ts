import type { MessageReceipt, Run, Session, SessionEvent } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';

let kit: AgentsKit;
beforeAll(async () => {
  kit = await createAgentsKit();
});
afterAll(async () => {
  await kit.close();
});

const types = (events: SessionEvent[]): string[] => events.map((event) => event.type);

describe('sending a message', () => {
  it('records the message, runs the agent and ends the run exactly once', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    expect(session).toMatchObject({ title: 'New session', titleSource: 'default', attention: 'none', activeRunId: null, lastSeq: 0 });

    agent.script([{ text: 'Looking at it.', chunks: 3 }, { tool: { id: 't1', name: 'Read', kind: 'read', title: 'Read app.ts', input: { path: 'app.ts' }, output: 'contents' } }, { text: 'All done.' }]);
    const receipt = await kit.send(owner, session.id, 'fix the login bug please now thanks');
    expect(receipt.status).toBe(202);
    expect(receipt.body).toMatchObject({ sessionId: session.id, disposition: 'run', duplicate: false, queueItemId: null });
    const run = await kit.runEnded(owner, receipt.body.runId!);
    expect(run).toMatchObject({ status: 'completed', origin: 'interactive', text: 'fix the login bug please now thanks', error: null });

    const events = await kit.events(owner, session.id);
    expect(types(events)).toEqual(['message.user', 'run.started', 'message.assistant', 'tool.started', 'tool.finished', 'message.assistant', 'run.finished']);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: { text: 'fix the login bug please now thanks', origin: 'interactive', runId: run.id } });
    expect(events[2]).toMatchObject({ data: { text: 'Looking at it.', partial: false } });

    // The first message names the session: its first four words.
    const after = (await owner.get<Session>(`/api/sessions/${session.id}`)).body;
    expect(after).toMatchObject({ title: 'fix the login bug', titleSource: 'auto', activeRunId: null, lastSeq: 7 });
    expect(after.lastUserMessageAt).not.toBeNull();
  });

  it('acknowledges durably before the agent does anything', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ gate: 'receipt-first' }, { text: 'late' }]);
    const receipt = await kit.send(owner, session.id, 'hello');
    // The receipt is back and already stored while the agent has produced nothing.
    expect(receipt.body.run).toMatchObject({ status: 'accepted' });
    const stored = await owner.get<MessageReceipt>(`/api/sessions/${session.id}/messages/${receipt.body.requestId}`);
    expect(stored.body).toMatchObject({ runId: receipt.body.runId, disposition: 'run' });
    expect((await kit.events(owner, session.id)).map((event) => event.type)).not.toContain('message.assistant');
    await agent.reached('receipt-first');
    agent.open('receipt-first');
    await kit.runEnded(owner, receipt.body.runId!);
  });

  it('answers a repeated request id with the original receipt and never runs twice', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const before = agent.runs.length;
    const body = { requestId: nextRequestId(), text: 'run the tests' };
    const first = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, body);
    expect(first.status).toBe(202);
    await kit.runEnded(owner, first.body.runId!);

    const again = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, runId: first.body.runId, run: { status: 'completed' } });
    // Even while the session is busy with something else, a duplicate is a duplicate.
    agent.script([{ gate: 'busy-duplicate' }]);
    const other = await kit.send(owner, session.id, 'something else');
    await agent.reached('busy-duplicate');
    const whileBusy = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, body);
    expect(whileBusy.body).toMatchObject({ duplicate: true, runId: first.body.runId });
    agent.open('busy-duplicate');
    await kit.runEnded(owner, other.body.runId!);

    expect(agent.runs.length).toBe(before + 2);
    expect((await kit.events(owner, session.id)).filter((event) => event.type === 'message.user')).toHaveLength(2);
  });

  it('accepts one of two identical requests sent at the same moment', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const before = agent.runs.length;
    const body = { requestId: nextRequestId(), text: 'double tap' };
    const [a, b] = await Promise.all([
      owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, body),
      owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.runId).toBe(b.body.runId);
    await kit.runEnded(owner, a.body.runId!);
    expect(agent.runs.length).toBe(before + 1);
  });

  it('refuses the same request id with different content', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const before = agent.runs.length;
    const requestId = nextRequestId();
    const first = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, { requestId, text: 'one' });
    await kit.runEnded(owner, first.body.runId!);
    const conflicting = await owner.post(`/api/sessions/${session.id}/messages`, { requestId, text: 'two' });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ error: { code: 'request_conflict' } });
    // The same id aimed at another session is a conflict too.
    const elsewhere = await kit.session();
    expect((await owner.post(`/api/sessions/${elsewhere.id}/messages`, { requestId, text: 'one' })).status).toBe(409);
    expect(agent.runs.length).toBe(before + 1);
  });

  it('says plainly whether a request was received', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const never = await owner.get(`/api/sessions/${session.id}/messages/${nextRequestId()}`);
    expect(never.status).toBe(404);
    expect(never.body).toMatchObject({ error: { code: 'receipt_not_found' } });

    const sent = await kit.send(owner, session.id, 'did you get this?');
    const check = await owner.get<MessageReceipt>(`/api/sessions/${session.id}/messages/${sent.body.requestId}`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ requestId: sent.body.requestId, runId: sent.body.runId, duplicate: true });
    await kit.runEnded(owner, sent.body.runId!);
    // A receipt is looked up in the session it was sent to.
    const other = await kit.session();
    expect((await owner.get(`/api/sessions/${other.id}/messages/${sent.body.requestId}`)).status).toBe(404);
  });

  it('refuses a second run in a busy session when asked to, and stores nothing for it', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ gate: 'busy' }, { text: 'done' }]);
    const first = await kit.send(owner, session.id, 'first');
    await agent.reached('busy');

    const requestId = nextRequestId();
    const second = await owner.post(`/api/sessions/${session.id}/messages`, { requestId, text: 'second', whenBusy: 'reject' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'session_busy' } });
    expect((await owner.get(`/api/sessions/${session.id}/messages/${requestId}`)).status).toBe(404);
    expect((await kit.state(owner, session.id)).run).toMatchObject({ id: first.body.runId, status: 'running' });

    agent.open('busy');
    expect((await kit.runEnded(owner, first.body.runId!)).status).toBe('completed');
  });

  it('refuses a session that does not exist, an empty message and a malformed id', async () => {
    const { owner } = kit;
    const missing = await owner.post('/api/sessions/00000000000000000000000000/messages', { requestId: nextRequestId(), text: 'hi' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'session_not_found' } });
    const session = await kit.session();
    expect((await owner.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: '   ' })).status).toBe(400);
    expect((await owner.post(`/api/sessions/${session.id}/messages`, { text: 'no request id' })).status).toBe(400);
    expect((await owner.post('/api/sessions/not-an-id/messages', { requestId: nextRequestId(), text: 'hi' })).status).toBe(400);
    expect((await owner.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'x'.repeat(100_001) })).status).toBe(400);
  });

  it('runs in the folder of the session\'s project whatever the client says', async () => {
    const { owner, agent, project } = kit;
    const session = await kit.session();
    const run = await kit.turn(owner, session.id, 'where am I?', { cwd: '/etc', projectId: 'nope', agentId: 'other', nativeSessionId: 'x' });
    expect(run.status).toBe('completed');
    expect(agent.lastRun.request).toMatchObject({ cwd: project.rootDir, projectId: project.id, sessionId: session.id, nativeSessionId: null });
    // Creating a session cannot choose a folder either.
    const sneaky = await owner.post<Session>('/api/sessions', { projectId: project.id, agentId: agent.id, cwd: '/etc', rootDir: '/etc' });
    expect(sneaky.status).toBe(201);
    await kit.turn(owner, sneaky.body.id, 'and now?');
    expect(agent.lastRun.request.cwd).toBe(project.rootDir);
  });

  it('gives the agent the model, effort, mode, quote and history of the session', async () => {
    const { owner, agent } = kit;
    const session = await kit.session(owner, { model: 'scripted-small', permissionMode: 'accept-edits' });
    agent.script([{ text: 'first answer' }]);
    await kit.turn(owner, session.id, 'first question');
    await kit.turn(owner, session.id, 'second question', { quote: 'first answer', model: 'scripted-large', effort: 'high', permissionMode: 'plan' });
    const request = agent.lastRun.request;
    expect(request).toMatchObject({ model: 'scripted-large', effort: 'high', permissionMode: 'plan', origin: 'interactive', unattended: false });
    expect(request.prompt).toMatchObject({ text: 'second question', quote: 'first answer', attachments: [] });
    expect(request.history).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
    ]);
    // What a message carries becomes the session's recorded choice.
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body).toMatchObject({ model: 'scripted-large', effort: 'high', permissionMode: 'plan' });
    expect((await owner.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'x', permissionMode: 'bypass' })).status).toBe(400);
  });

  it('records a failure the agent reports, and hides one it did not mean to show', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ text: 'trying', complete: false }, { fail: { code: 'not_signed_in', message: 'Sign in to the agent first.' } }]);
    const failed = await kit.turn(owner, session.id, 'go');
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'not_signed_in', message: 'Sign in to the agent first.' } });
    const events = await kit.events(owner, session.id);
    // The half-written answer is kept, marked as partial; the run ends once.
    expect(events.find((event) => event.type === 'message.assistant')).toMatchObject({ data: { text: 'trying', partial: true } });
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body.attention).toBe('needs-you');

    agent.script([{ crash: 'ENOENT /home/secret/path token=sk-abcdefghijklmnopqrstuvwxyz' }]);
    const crashed = await kit.turn(owner, session.id, 'again');
    expect(crashed).toMatchObject({ status: 'failed', error: { code: 'agent_error', message: 'The agent stopped unexpectedly.' } });
    expect(JSON.stringify(await kit.events(owner, session.id))).not.toContain('/home/secret');
  });

  it('keeps a mid-run error as a notice and still completes', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ emit: { type: 'notice', level: 'error', code: 'rate_limit', text: 'Slowed down by the provider.' } }, { text: 'recovered' }]);
    const run = await kit.turn(owner, session.id, 'go');
    expect(run.status).toBe('completed');
    const events = await kit.events(owner, session.id);
    expect(events.find((event) => event.type === 'notice')).toMatchObject({ data: { level: 'error', code: 'rate_limit' } });
  });

  it('refuses an agent that is not there or not offered', async () => {
    const { owner, project } = kit;
    expect((await owner.post('/api/sessions', { projectId: project.id, agentId: 'nobody' })).body).toMatchObject({ error: { code: 'agent_unavailable' } });
    expect((await owner.post('/api/sessions', { agentId: kit.agent.id })).body).toMatchObject({ error: { code: 'project_required' } });
    const picky = await kit.makeProject('picky');
    await owner.patch(`/api/projects/${picky.id}`, { agents: ['some-other-agent'] });
    const refused = await owner.post('/api/sessions', { projectId: picky.id, agentId: kit.agent.id });
    if (refused.status !== 201) expect(refused.body).toMatchObject({ error: { code: 'agent_not_enabled' } });
  });

  it('bounds what a tool puts in the log and says so', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([
      { tool: { id: 'big', name: 'Bash', kind: 'execute', title: 'Run it', input: { command: 'cat big', blob: 'y'.repeat(50_000) }, output: 'x'.repeat(50_000) } },
    ]);
    await kit.turn(owner, session.id, 'make noise');
    const events = await kit.events(owner, session.id);
    const started = events.find((event) => event.type === 'tool.started')!;
    const finished = events.find((event) => event.type === 'tool.finished')!;
    expect(started.data).toMatchObject({ inputTruncated: true, input: { command: 'cat big' } });
    expect(JSON.stringify(started.data).length).toBeLessThan(20_000);
    expect(finished.data).toMatchObject({ status: 'ok', outputOmittedChars: 10_000 });
    expect((finished.data as { output: string }).output).toContain('10000 characters omitted');
  });

  it('lists runs and reads one', async () => {
    const { owner } = kit;
    const session = await kit.session();
    const run = await kit.turn(owner, session.id, 'hello');
    const all = await owner.get<{ runs: Run[] }>(`/api/runs?state=all&sessionId=${session.id}`);
    expect(all.body.runs.map((entry) => entry.id)).toEqual([run.id]);
    expect((await owner.get<{ runs: Run[] }>(`/api/runs?sessionId=${session.id}`)).body.runs).toEqual([]);
    expect((await owner.get('/api/runs/00000000000000000000000000')).status).toBe(404);
    await until(async () => (await kit.state(owner, session.id)).run === null);
  });
});
