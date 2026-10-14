import { type Approval, type Run, type Session, sessionTopic, userTopic } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';
import type { TestClient } from '../../src/testing/harness.js';

let kit: AgentsKit;
let alice: TestClient;
let mallory: TestClient;

beforeAll(async () => {
  kit = await createAgentsKit();
  alice = await kit.t.member('alice');
  mallory = await kit.t.member('mallory');
  await kit.share(kit.project, alice);
  await kit.share(kit.project, mallory);
});
afterAll(async () => {
  await kit.close();
});

/** A session of alice's with a run waiting on an approval and a message in its queue. */
async function busySession(): Promise<{ session: Session; runId: string; approval: Approval; queueItemId: string; attachmentId: string }> {
  const session = await kit.session(alice);
  kit.agent.script([{ text: 'alice only: the launch code is 0000' }, { permission: { toolName: 'Bash', kind: 'execute', input: { command: 'npm run secret' }, command: 'npm run secret' } }]);
  const sent = await kit.send(alice, session.id, 'alice private request');
  const approval = await until(async () => (await kit.state(alice, session.id)).pendingApprovals[0]);
  const queued = await kit.send(alice, session.id, 'alice queued message');
  const boundary = 'x-test-boundary';
  const upload = await alice.request<{ attachments: Array<{ id: string }> }>(
    'POST',
    `/api/sessions/${session.id}/attachments`,
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="notes.txt"\r\ncontent-type: text/plain\r\n\r\nalice file\r\n--${boundary}--\r\n`),
    { 'content-type': `multipart/form-data; boundary=${boundary}` },
  );
  return { session, runId: sent.body.runId!, approval, queueItemId: queued.body.queueItemId!, attachmentId: upload.body.attachments[0]!.id };
}

async function finish(target: { session: Session; approval: Approval; runId: string }): Promise<void> {
  await alice.post(`/api/approvals/${target.approval.id}/decision`, { decision: 'deny' });
  await kit.runEnded(alice, target.runId);
  await until(async () => (await kit.state(alice, target.session.id)).queue.length === 0);
  await kit.idle(alice, target.session.id);
}

describe('another user', () => {
  it('cannot read, write, stop, answer or watch someone else\'s session — and cannot tell it exists', async () => {
    const target = await busySession();
    const id = target.session.id;
    const missing = '00000000000000000000000000';

    const attempts: Array<[string, () => Promise<{ status: number; body: unknown }>]> = [
      ['read the session', () => mallory.get(`/api/sessions/${id}`)],
      ['read its events', () => mallory.get(`/api/sessions/${id}/events`)],
      ['read its state', () => mallory.get(`/api/sessions/${id}/state`)],
      ['read its usage', () => mallory.get(`/api/sessions/${id}/usage`)],
      ['read its queue', () => mallory.get(`/api/sessions/${id}/queue`)],
      ['read its draft', () => mallory.get(`/api/sessions/${id}/draft`)],
      ['read its native id', () => mallory.get(`/api/sessions/${id}/native-id`)],
      ['list its attachments', () => mallory.get(`/api/sessions/${id}/attachments`)],
      ['fetch its attachment', () => mallory.get(`/api/sessions/${id}/attachments/${target.attachmentId}`)],
      ['send to it', () => mallory.post(`/api/sessions/${id}/messages`, { requestId: nextRequestId(), text: 'injected' })],
      ['check a delivery in it', () => mallory.get(`/api/sessions/${id}/messages/anything`)],
      ['stop it', () => mallory.post(`/api/sessions/${id}/stop`)],
      ['rename it', () => mallory.patch(`/api/sessions/${id}`, { title: 'mine now' })],
      ['delete it', () => mallory.delete(`/api/sessions/${id}`)],
      ['save a draft in it', () => mallory.put(`/api/sessions/${id}/draft`, { text: 'x' })],
      ['mark it seen', () => mallory.post(`/api/sessions/${id}/seen`)],
      ['edit its queue', () => mallory.patch(`/api/sessions/${id}/queue/${target.queueItemId}`, { text: 'changed' })],
      ['remove from its queue', () => mallory.delete(`/api/sessions/${id}/queue/${target.queueItemId}`)],
      ['send its queue now', () => mallory.post(`/api/sessions/${id}/queue/${target.queueItemId}/send-now`)],
      ['delete its attachment', () => mallory.delete(`/api/sessions/${id}/attachments/${target.attachmentId}`)],
      ['read its run', () => mallory.get(`/api/runs/${target.runId}`)],
      ['continue its run', () => mallory.post(`/api/runs/${target.runId}/continue`, { requestId: nextRequestId() })],
      ['dismiss its run', () => mallory.post(`/api/runs/${target.runId}/dismiss`)],
      ['read its approval', () => mallory.get(`/api/approvals/${target.approval.id}`)],
      ['allow its approval', () => mallory.post(`/api/approvals/${target.approval.id}/decision`, { decision: 'allow' })],
      ['deny its approval', () => mallory.post(`/api/approvals/${target.approval.id}/decision`, { decision: 'deny' })],
      ['make a rule for it', () => mallory.post('/api/permission-rules', { scope: 'session', sessionId: id, effect: 'allow', tool: '*' })],
      ['list its rules', () => mallory.get(`/api/permission-rules?sessionId=${id}`)],
      ['list its runs', () => mallory.get(`/api/runs?state=all&sessionId=${id}`)],
      ['list its approvals', () => mallory.get(`/api/approvals?sessionId=${id}`)],
    ];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      expect(response.status, what).toBe(404);
      expect(JSON.stringify(response.body), what).not.toContain('alice');
    }
    // A session that is not theirs answers exactly like one that does not exist.
    expect((await mallory.get(`/api/sessions/${id}`)).body).toEqual((await mallory.get(`/api/sessions/${missing}`)).body);
    expect((await mallory.get(`/api/runs/${target.runId}`)).body).toEqual((await mallory.get(`/api/runs/${missing}`)).body);
    expect((await mallory.get(`/api/approvals/${target.approval.id}`)).body).toEqual((await mallory.get(`/api/approvals/${missing}`)).body);

    // Lists never include it either.
    expect((await mallory.get<{ sessions: Session[] }>('/api/sessions?scope=all')).body.sessions).toEqual([]);
    expect((await mallory.get<{ runs: Run[] }>('/api/runs?state=all')).body.runs).toEqual([]);
    expect((await mallory.get<{ approvals: Approval[] }>('/api/approvals?status=all')).body.approvals).toEqual([]);
    expect((await mallory.get<{ hits: unknown[] }>('/api/sessions/search?q=launch code')).body.hits).toEqual([]);
    expect((await mallory.get<{ projects: unknown[] }>('/api/sessions/activity')).body.projects).toEqual([]);
    await mallory.put('/api/sessions/presence', { clientId: 'mallory-tab-1', visible: [id] });
    expect(kit.t.studio.context.services.agents.sessions.viewers(id)).toEqual([]);

    // Nothing was changed by any of it.
    expect(await kit.state(alice, id)).toMatchObject({ run: { id: target.runId, status: 'running' }, pendingApprovals: [{ id: target.approval.id }], queue: [{ text: 'alice queued message' }] });
    expect((await alice.get<Session>(`/api/sessions/${id}`)).body.title).toBe('alice private request');
    await finish(target);
  });

  it('cannot subscribe to someone else\'s session or list feed, and receives nothing about it', async () => {
    const session = await kit.session(alice);
    const spy = await kit.connect(mallory);
    expect(await spy.subscribe(sessionTopic(session.id))).toMatchObject({ op: 'rejected', code: 'forbidden' });
    expect(await spy.subscribe(userTopic(alice.userId!))).toMatchObject({ op: 'rejected', code: 'forbidden' });
    expect(await spy.subscribe(sessionTopic('00000000000000000000000000'))).toMatchObject({ op: 'rejected', code: 'forbidden' });
    expect(await spy.subscribe('session:../../etc')).toMatchObject({ op: 'rejected' });
    expect(await spy.subscribe('internal:runs')).toMatchObject({ op: 'rejected' });
    await spy.subscribe(userTopic(mallory.userId!));

    kit.agent.script([{ text: 'for alice alone', chunks: 3 }, { permission: { toolName: 'Bash', kind: 'execute', input: {}, command: 'echo private' } }]);
    const sent = await kit.send(alice, session.id, 'confidential');
    const approval = await until(async () => (await kit.state(alice, session.id)).pendingApprovals[0]);
    await alice.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    await kit.runEnded(alice, sent.body.runId!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spy.frames.filter((frame) => frame.op === 'event')).toEqual([]);
    expect(JSON.stringify(spy.frames)).not.toContain('for alice alone');
    spy.close();
  });

  it('gets 401 for everything when not signed in', async () => {
    const anonymous = kit.t.anonymous();
    const session = await kit.session(alice);
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/api/agents'],
      ['GET', '/api/sessions'],
      ['POST', '/api/sessions', { projectId: kit.project.id, agentId: kit.agent.id }],
      ['GET', `/api/sessions/${session.id}`],
      ['GET', `/api/sessions/${session.id}/events`],
      ['GET', `/api/sessions/${session.id}/state`],
      ['POST', `/api/sessions/${session.id}/messages`, { requestId: 'r', text: 'x' }],
      ['POST', `/api/sessions/${session.id}/stop`],
      ['POST', `/api/sessions/${session.id}/attachments`],
      ['GET', `/api/sessions/${session.id}/attachments`],
      ['GET', '/api/sessions/search?q=x'],
      ['GET', '/api/sessions/activity'],
      ['PUT', '/api/sessions/presence', { clientId: 'anonymous-tab', visible: [] }],
      ['GET', '/api/runs'],
      ['POST', '/api/runs/00000000000000000000000000/continue', { requestId: 'r' }],
      ['GET', '/api/approvals'],
      ['POST', '/api/approvals/00000000000000000000000000/decision', { decision: 'allow' }],
      ['GET', '/api/permission-rules'],
      ['POST', '/api/permission-rules', { scope: 'account', effect: 'allow', tool: '*' }],
      ['PUT', `/api/agents/projects/${kit.project.id}/settings`, { autoMode: true }],
    ];
    for (const [method, url, body] of requests) {
      const response = await anonymous.request(method as 'GET', url, body);
      expect(response.status, `${method} ${url}`).toBe(401);
    }
    await expect(kit.connect(anonymous)).rejects.toThrow('HTTP 401');
  });
});

describe('project access', () => {
  it('ends when a member is taken off the project — for the API, for live subscriptions and for running agents', async () => {
    const project = await kit.makeProject('revocable');
    const bob = await kit.t.member('bob');
    await kit.share(project, bob);
    const session = await kit.session(bob, { projectId: project.id });
    await kit.turn(bob, session.id, 'bob was here');

    const live = await kit.connect(bob);
    expect(await live.subscribe(sessionTopic(session.id))).toMatchObject({ op: 'subscribed' });
    await live.subscribe(userTopic(bob.userId!));
    kit.agent.script([{ text: 'before removal' }, { hang: true }]);
    const running = await kit.send(bob, session.id, 'keep working');
    await until(async () => (await kit.state(bob, session.id)).run?.status === 'running');
    const queued = await kit.send(bob, session.id, 'queued for later');
    expect(queued.body.disposition).toBe('queued');

    expect((await kit.owner.delete(`/api/projects/${project.id}/members/${bob.userId}`)).status).toBe(204);

    // The live subscription is ended at once and says so.
    expect(await live.next((frame) => frame.op === 'rejected' && frame.topic === sessionTopic(session.id))).toMatchObject({ code: 'forbidden' });
    // The agent no longer works there for him, and his queued message is not sent.
    const stopped = await kit.runEnded(kit.owner, running.body.runId!);
    expect(stopped.status).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(kit.agent.runs.filter((run) => run.request.sessionId === session.id)).toHaveLength(2);

    // His own session is gone from his point of view.
    for (const attempt of [
      () => bob.get(`/api/sessions/${session.id}`),
      () => bob.get(`/api/sessions/${session.id}/events`),
      () => bob.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'still here?' }),
      () => bob.post(`/api/sessions/${session.id}/stop`),
      () => bob.get(`/api/runs/${running.body.runId}`),
      () => bob.post('/api/sessions', { projectId: project.id, agentId: kit.agent.id }),
    ]) {
      expect((await attempt()).status).toBe(404);
    }
    expect((await bob.get<{ sessions: Session[] }>('/api/sessions')).body.sessions).toEqual([]);
    expect((await bob.get<{ hits: unknown[] }>('/api/sessions/search?q=bob was here')).body.hits).toEqual([]);
    const fresh = await kit.connect(bob);
    expect(await fresh.subscribe(sessionTopic(session.id))).toMatchObject({ op: 'rejected' });
    // Events after the removal do not reach the old connection.
    const framesBefore = live.events(sessionTopic(session.id)).length;
    kit.t.studio.context.bus.publish(sessionTopic(session.id), 'notice', { text: 'after removal' }, 999);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(live.events(sessionTopic(session.id)).length).toBe(framesBefore);

    // Given access back, it is all his again — and the queue picks up where it stopped.
    await kit.share(project, bob);
    expect((await bob.get<Session>(`/api/sessions/${session.id}`)).status).toBe(200);
    live.close();
    fresh.close();
  });

  it('lets a read-only member look but not run an agent', async () => {
    const project = await kit.makeProject('look-only');
    const reader = await kit.t.member('reader');
    await kit.share(project, reader, 'write');
    const session = await kit.session(reader, { projectId: project.id });
    await kit.turn(reader, session.id, 'while I could write');
    await kit.share(project, reader, 'read');

    expect((await reader.get(`/api/sessions/${session.id}`)).status).toBe(200);
    expect((await reader.get(`/api/sessions/${session.id}/events`)).status).toBe(200);
    for (const attempt of [
      () => reader.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'run something' }),
      () => reader.post('/api/sessions', { projectId: project.id, agentId: kit.agent.id }),
      () => reader.patch(`/api/sessions/${session.id}`, { permissionMode: 'auto' }),
      () => reader.post('/api/permission-rules', { scope: 'project', projectId: project.id, effect: 'allow', tool: '*' }),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'project_read_only' } });
    }
    expect(kit.agent.runs.filter((run) => run.request.sessionId === session.id)).toHaveLength(1);
  });

  it('lets the instance owner see and stop a member\'s session, but not speak in it', async () => {
    const { owner } = kit;
    const session = await kit.session(alice);
    kit.agent.script([{ text: 'working for alice' }, { hang: true }]);
    const running = await kit.send(alice, session.id, 'alice asks');
    await until(async () => (await kit.state(alice, session.id)).run?.status === 'running');

    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body).toMatchObject({ userId: alice.userId });
    expect((await owner.get(`/api/sessions/${session.id}/events`)).status).toBe(200);
    expect((await owner.get<{ sessions: Session[] }>('/api/sessions?scope=all')).body.sessions.map((entry) => entry.id)).toContain(session.id);
    // By default the owner's lists are the owner's own.
    expect((await owner.get<{ sessions: Session[] }>('/api/sessions')).body.sessions.map((entry) => entry.id)).not.toContain(session.id);
    // Asked for the runs of that session, the owner gets them — the session can be read, so can its runs —
    // while the owner's own run lists stay the owner's own, and another member still finds no such session.
    for (const state of ['all', 'active']) {
      const runs = await owner.get<{ runs: Run[] }>(`/api/runs?state=${state}&sessionId=${session.id}`);
      expect(runs.body.runs.map((run) => [run.id, run.userId])).toEqual([[running.body.runId, alice.userId]]);
    }
    expect((await alice.get<{ runs: Run[] }>(`/api/runs?state=all&sessionId=${session.id}`)).body.runs.map((run) => run.id)).toEqual([running.body.runId]);
    expect((await owner.get<{ runs: Run[] }>('/api/runs?state=all')).body.runs.map((run) => run.id)).not.toContain(running.body.runId);
    expect((await owner.get<{ runs: Run[] }>(`/api/runs?state=active&projectId=${kit.project.id}`)).body.runs.map((run) => run.id)).not.toContain(running.body.runId);
    expect((await mallory.get(`/api/runs?state=all&sessionId=${session.id}`)).status).toBe(404);
    const watching = await kit.connect(owner);
    expect(await watching.subscribe(sessionTopic(session.id))).toMatchObject({ op: 'subscribed' });
    watching.close();

    for (const attempt of [
      () => owner.post(`/api/sessions/${session.id}/messages`, { requestId: nextRequestId(), text: 'owner speaking' }),
      () => owner.patch(`/api/sessions/${session.id}`, { title: 'renamed by owner' }),
      () => owner.put(`/api/sessions/${session.id}/draft`, { text: 'x' }),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'not_your_session' } });
    }
    const stopped = await owner.post<{ run: Run }>(`/api/sessions/${session.id}/stop`);
    expect(stopped.body.run).toMatchObject({ id: running.body.runId, status: 'stopped' });
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(204);
    expect((await alice.get(`/api/sessions/${session.id}`)).status).toBe(404);
  });

  it('keeps members out of each other\'s rules and out of the owner\'s shared ones', async () => {
    const { owner } = kit;
    const shared = await owner.post<{ id: string }>('/api/permission-rules', { scope: 'project', projectId: kit.project.id, effect: 'deny', tool: 'Bash', pattern: 'terraform destroy *', shared: true });
    expect(shared.status).toBe(201);
    const mine = await alice.post<{ id: string }>('/api/permission-rules', { scope: 'account', effect: 'allow', tool: 'Bash', pattern: 'ls *' });
    expect((await alice.post('/api/permission-rules', { scope: 'project', projectId: kit.project.id, effect: 'deny', tool: 'Bash', shared: true })).body).toMatchObject({ error: { code: 'owner_required' } });

    // A shared rule is visible to the project's people and governs their runs; they cannot remove it.
    const visible = (await mallory.get<{ rules: Array<{ id: string }> }>('/api/permission-rules')).body.rules.map((rule) => rule.id);
    expect(visible).toContain(shared.body.id);
    expect(visible).not.toContain(mine.body.id);
    expect((await mallory.delete(`/api/permission-rules/${shared.body.id}`)).status).toBe(404);
    expect((await mallory.delete(`/api/permission-rules/${mine.body.id}`)).status).toBe(404);
    const session = await kit.session(mallory, { permissionMode: 'ask' });
    kit.agent.script([{ permission: { toolName: 'Bash', kind: 'execute', input: {}, command: 'terraform destroy -auto-approve' } }]);
    await kit.turn(mallory, session.id, 'tear it down');
    expect(kit.agent.lastRun.decisions).toEqual([expect.objectContaining({ behavior: 'deny', source: 'rule' })]);
    // Alice's own allow rule does nothing for mallory.
    kit.agent.script([{ permission: { toolName: 'Bash', kind: 'execute', input: {}, command: 'ls -la' } }]);
    const sent = await kit.send(mallory, session.id, 'list');
    const approval = await until(async () => (await kit.state(mallory, session.id)).pendingApprovals[0]);
    await mallory.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
    await kit.runEnded(mallory, sent.body.runId!);
    expect((await owner.delete(`/api/permission-rules/${shared.body.id}`)).status).toBe(204);
    await alice.delete(`/api/permission-rules/${mine.body.id}`);
  });
});
