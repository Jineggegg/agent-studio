import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime, until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  approvalsWaiting,
  createMember,
  createProject,
  createSession,
  decide,
  getRun,
  newRequestId,
  postMessage,
  runEnded,
  send,
  shareProject,
  startAgentStudio,
  transcript,
  type Approval,
  type ErrorBody,
  type Json,
  type Project,
  type Receipt,
  type Session,
} from './support/workbench.js';

/**
 * 6.15 — Who may touch a session (requirements 01 §6.15, §7.1.1).
 *
 * This product has members, so "user 2" is the hard case: another member of
 * the SAME project, with write access. A session belongs to the person who
 * started it. Another member finds it "not found" on every route and cannot
 * subscribe to it. The instance owner may look at, stop and answer approvals
 * in anyone's session, but not write in it.
 */
describe('6.15 access to sessions', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let alice: ApiClient;
  let bob: ApiClient;
  let project: Project;
  // Alice's session: a run in progress that waits for an approval, and a message in the queue.
  let session: Session;
  let receipt: Receipt;
  let approval: Approval;
  let queued: Receipt;
  let bobLive: Realtime;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'shared');
    alice = await createMember(studio, owner, 'alice');
    bob = await createMember(studio, owner, 'bobby');
    await shareProject(owner, project.id, alice.userId!, 'write');
    await shareProject(owner, project.id, bob.userId!, 'write');
    // Bob is connected and listening on everything he is entitled to, from before Alice does anything.
    bobLive = await Realtime.open(studio, bob);
    expect((await bobLive.subscribe(`user:${bob.userId}`)).op).toBe('subscribed');
    expect((await bobLive.subscribe(`project:${project.id}`)).op).toBe('subscribed');

    session = await createSession(alice, project.id);
    receipt = await send(
      alice,
      session.id,
      'the secret launch plan [[scenario:bash npm test]] [[scenario:long 150]]',
    );
    [approval] = (await approvalsWaiting(alice, session.id)) as [Approval];
    queued = await send(alice, session.id, 'queued by alice');
  });
  afterAll(async () => {
    await bobLive?.close();
    await studio?.destroy();
  });

  const notFound = async (response: Promise<{ status: number; body: unknown }>, what: string) => {
    const answer = await response;
    expect(answer.status, what).toBe(404);
    expect((answer.body as ErrorBody).error.code, what).toMatch(/_not_found$/);
  };

  it('AT-WB-139/121: another member of the same project cannot read the session — its record, snapshot, history, usage, queue, runs and approvals are all "not found"', async () => {
    await notFound(bob.get(`/api/sessions/${session.id}`), 'session');
    await notFound(bob.get(`/api/sessions/${session.id}/state`), 'snapshot');
    await notFound(bob.get(`/api/sessions/${session.id}/events`), 'history');
    await notFound(bob.get(`/api/sessions/${session.id}/usage`), 'usage');
    await notFound(bob.get(`/api/sessions/${session.id}/native-id`), 'native id');
    await notFound(bob.get(`/api/sessions/${session.id}/draft`), 'draft');
    await notFound(bob.get(`/api/sessions/${session.id}/queue`), 'queue');
    await notFound(bob.get(`/api/sessions/${session.id}/attachments`), 'attachments');
    await notFound(
      bob.get(`/api/sessions/${session.id}/messages/${receipt.requestId}`),
      'delivery check',
    );
    await notFound(bob.get(`/api/runs/${receipt.runId}`), 'run');
    await notFound(bob.get(`/api/runs?state=all&sessionId=${session.id}`), 'runs of the session');
    await notFound(bob.get(`/api/approvals?sessionId=${session.id}`), 'approvals of the session');
    await notFound(bob.get(`/api/approvals/${approval.id}`), 'approval');
    // The refusal is the same as for a session that never existed.
    const real = await bob.get<ErrorBody>(`/api/sessions/${session.id}`);
    const invented = await bob.get<ErrorBody>('/api/sessions/0123456789abcdefghjkmnpqrs');
    expect(real.body).toEqual(invented.body);

    // Nor does it show up in anything Bob can list or search.
    expect((await bob.get<{ sessions: unknown[] }>('/api/sessions')).body.sessions).toEqual([]);
    expect(
      (await bob.get<{ sessions: unknown[] }>(`/api/sessions?projectId=${project.id}`)).body
        .sessions,
    ).toEqual([]);
    expect(
      (await bob.get<{ sessions: unknown[] }>('/api/sessions?scope=all')).body.sessions,
    ).toEqual([]); // "all" is the owner's
    expect((await bob.get<{ hits: unknown[] }>('/api/sessions/search?q=secret')).body.hits).toEqual(
      [],
    );
    expect((await bob.get<{ approvals: unknown[] }>('/api/approvals')).body.approvals).toEqual([]);
    expect((await bob.get<{ runs: unknown[] }>('/api/runs?state=active')).body.runs).toEqual([]);
    expect(
      (await bob.get<{ projects: unknown[] }>('/api/sessions/activity')).body.projects,
    ).toEqual([]);
  });

  it('AT-WB-139: nor can they send to it, queue to it, edit its queue, stop it, answer its approval, rename, continue, dismiss or delete it — and nothing changes', async () => {
    const before = await transcript(alice, session.id);
    await notFound(postMessage(bob, session.id, 'intruding'), 'send');
    await notFound(postMessage(bob, session.id, 'intruding', { whenBusy: 'steer' }), 'steer');
    await notFound(
      bob.patch(`/api/sessions/${session.id}/queue/${queued.queueItemId}`, { text: 'hijacked' }),
      'edit queue',
    );
    await notFound(
      bob.delete(`/api/sessions/${session.id}/queue/${queued.queueItemId}`),
      'remove from queue',
    );
    await notFound(
      bob.post(`/api/sessions/${session.id}/queue/${queued.queueItemId}/send-now`),
      'send now',
    );
    await notFound(bob.post(`/api/sessions/${session.id}/stop`), 'stop');
    await notFound(decide(bob, approval.id, 'allow'), 'allow');
    await notFound(decide(bob, approval.id, 'deny'), 'deny');
    await notFound(bob.patch(`/api/sessions/${session.id}`, { title: 'hijacked' }), 'rename');
    await notFound(bob.put(`/api/sessions/${session.id}/draft`, { text: 'planted' }), 'draft');
    await notFound(bob.post(`/api/sessions/${session.id}/seen`), 'seen');
    await notFound(
      bob.post(`/api/runs/${receipt.runId}/continue`, { requestId: newRequestId() }),
      'continue',
    );
    await notFound(bob.post(`/api/runs/${receipt.runId}/dismiss`), 'dismiss');
    await notFound(bob.delete(`/api/sessions/${session.id}`), 'delete');
    // A rule of Bob's cannot be attached to Alice's session either.
    const rule = await bob.post<ErrorBody>('/api/permission-rules', {
      scope: 'session',
      sessionId: session.id,
      effect: 'allow',
      tool: 'Bash',
    });
    expect(rule.status).toBeGreaterThanOrEqual(400);

    // Alice's session is exactly as it was: still running, still asking, same queue, same title.
    const now = (await alice.get<Json>(`/api/sessions/${session.id}`)).body;
    expect(now.activeRunId).toBe(receipt.runId);
    expect(now.title).not.toBe('hijacked');
    expect(now.hasDraft).toBe(false);
    expect((await alice.get<Json>(`/api/approvals/${approval.id}`)).body.status).toBe('pending');
    expect(
      (
        await alice.get<{ queue: Array<{ text: string }> }>(`/api/sessions/${session.id}/queue`)
      ).body.queue.map((item) => item.text),
    ).toEqual(['queued by alice']);
    expect((await transcript(alice, session.id)).map((event) => event.seq)).toEqual(
      before.map((event) => event.seq),
    );
  });

  it('AT-WB-139: they cannot watch it or follow it, and no event about it ever reaches them', async () => {
    const refused = await bobLive.subscribe(`session:${session.id}`);
    expect(refused).toEqual({ op: 'rejected', topic: `session:${session.id}`, code: 'forbidden' });
    expect(await bobLive.subscribe(`user:${alice.userId}`)).toEqual({
      op: 'rejected',
      topic: `user:${alice.userId}`,
      code: 'forbidden',
    });
    // "Following" a session one cannot see has no effect: the report is accepted and tells nothing.
    const presence = await bob.put('/api/sessions/presence', {
      clientId: 'bobs-tab-0001',
      visible: [session.id],
    });
    expect(presence.status).toBe(204);

    // Alice's work goes on: an approval answered, text streamed, a queued turn sent, a run finished.
    expect((await decide(alice, approval.id, 'allow')).status).toBe(200);
    expect((await runEnded(alice, receipt.runId!, 40_000)).status).toBe('completed');
    await until(
      async () =>
        (await alice.get<Json>(`/api/sessions/${session.id}`)).body.activeRunId === null &&
        (await alice.get<Json>(`/api/sessions/${session.id}/queue`)).body.queue.length === 0
          ? true
          : undefined,
      {
        what: 'the queued turn to finish',
      },
    );
    // Bob's connection is still open and has seen nothing that names Alice's session, run or approval.
    const from = bobLive.mark();
    bobLive.sendFrame({ op: 'ping' });
    await bobLive.waitFor((frame) => frame.op === 'pong', { from });
    const heard = JSON.stringify(bobLive.frames.filter((frame) => frame.op === 'event'));
    expect(heard).not.toContain(session.id);
    expect(heard).not.toContain(receipt.runId!);
    expect(heard).not.toContain(approval.id);
    expect(heard).not.toContain('secret launch plan');
    expect(
      bobLive.frames.filter((frame) => frame.op === 'event' && frame.topic?.startsWith('session:')),
    ).toEqual([]);
  });

  it('WB-073: one member’s "always allow" does not open the door for another member’s runs', async () => {
    const mine = await createSession(alice, project.id);
    const first = await send(alice, mine.id, 'status [[scenario:bash git status]]');
    const [ask] = await approvalsWaiting(alice, mine.id);
    expect((await decide(alice, ask!.id, 'allow', { remember: 'always' })).status).toBe(200);
    await runEnded(alice, first.runId!);
    expect((await bob.get<{ rules: unknown[] }>('/api/permission-rules')).body.rules).toEqual([]);

    const his = await createSession(bob, project.id);
    const second = await send(bob, his.id, 'status [[scenario:bash git status]]');
    const [stillAsked] = await approvalsWaiting(bob, his.id);
    expect(stillAsked!.command).toBe('git status');
    // And Alice cannot answer Bob's request.
    await notFound(decide(alice, stillAsked!.id, 'allow'), 'alice answering bob');
    await decide(bob, stillAsked!.id, 'deny');
    await runEnded(bob, second.runId!);
  });

  it('SEC-027: the instance owner may look at a member’s session, stop it and answer its approvals — but not write in it', async () => {
    const hers = await createSession(alice, project.id);
    const run = await send(
      alice,
      hers.id,
      'watched [[scenario:bash npm test]] [[scenario:long 200]]',
    );
    const [ask] = await approvalsWaiting(alice, hers.id);
    expect((await owner.get<Json>(`/api/sessions/${hers.id}`)).body.userId).toBe(alice.userId);
    expect(
      (await owner.get<{ events: unknown[] }>(`/api/sessions/${hers.id}/events`)).body.events
        .length,
    ).toBeGreaterThan(0);
    const everyone = await owner.get<{ sessions: Array<{ id: string }> }>(
      '/api/sessions?scope=all',
    );
    expect(everyone.body.sessions.map((row) => row.id)).toContain(hers.id);
    expect(
      (await owner.get<{ sessions: Array<{ id: string }> }>('/api/sessions')).body.sessions.map(
        (row) => row.id,
      ),
    ).not.toContain(hers.id); // "mine" is mine
    // The session's runs come with it: asked for them by session, the owner gets hers.
    for (const state of ['all', 'active']) {
      const runs = await owner.get<{ runs: Array<{ id: string; userId: string }> }>(
        `/api/runs?state=${state}&sessionId=${hers.id}`,
      );
      expect(
        runs.body.runs.map((row) => [row.id, row.userId]),
        state,
      ).toEqual([[run.runId, alice.userId]]);
    }
    expect(
      (await owner.get<{ runs: Array<{ id: string }> }>('/api/runs?state=all')).body.runs.map(
        (row) => row.id,
      ),
    ).not.toContain(run.runId); // the owner's own list stays the owner's own
    const ownerLive = await Realtime.open(studio, owner);
    expect((await ownerLive.subscribe(`session:${hers.id}`)).op).toBe('subscribed');

    // Writing is the creator's alone.
    for (const attempt of [
      postMessage(owner, hers.id, 'the owner speaking'),
      owner.patch(`/api/sessions/${hers.id}`, { title: 'renamed by the owner' }),
      owner.put(`/api/sessions/${hers.id}/draft`, { text: 'planted' }),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).error.code).toBe('not_your_session');
    }
    // Answering and stopping are allowed.
    const answered = await decide(owner, ask!.id, 'allow');
    expect(answered.status).toBe(200);
    expect(answered.body.approval.decidedBy).toBe(owner.userId);
    await ownerLive.event(`session:${hers.id}`, 'message.delta');
    expect((await owner.post(`/api/sessions/${hers.id}/stop`)).status).toBe(200);
    expect((await runEnded(alice, run.runId!)).status).toBe('stopped');
    expect(
      (await transcript(alice, hers.id)).filter((event) => event.type === 'message.user'),
    ).toHaveLength(1);
    await ownerLive.close();
  });

  it('a member cannot start a session in a project that was not shared with them, and a read-only member cannot start one at all', async () => {
    const privateProject = await createProject(studio, owner, 'private');
    const outsider = await bob.post<ErrorBody>('/api/sessions', {
      projectId: privateProject.id,
      agentId: 'claude-code',
    });
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe('project_not_found'); // not even its existence is confirmed
    expect((await bob.get(`/api/sessions?projectId=${privateProject.id}`)).status).toBe(404);

    const reader = await createMember(studio, owner, 'reader');
    await shareProject(owner, project.id, reader.userId!, 'read');
    const readOnly = await reader.post<ErrorBody>('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error.code).toBe('project_read_only');
    // A session with a CLI agent always needs a project.
    expect(
      (await bob.post('/api/sessions', { projectId: null, agentId: 'claude-code' })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('a member removed from the project loses the live stream at once; their run is stopped, their queue is not sent, and the session is out of their reach', async () => {
    const leaver = await createMember(studio, owner, 'leaver');
    await shareProject(owner, project.id, leaver.userId!, 'write');
    const theirs = await createSession(leaver, project.id, 'claude-code', {
      permissionMode: 'accept-edits',
    });
    const topic = `session:${theirs.id}`;
    const live = await Realtime.open(studio, leaver);
    await live.subscribe(topic);
    await live.subscribe(`project:${project.id}`);
    const run = await send(
      leaver,
      theirs.id,
      'still here [[scenario:long 200]] [[scenario:edit-file written-after-removal.txt]]',
    );
    const waiting = await send(
      leaver,
      theirs.id,
      'queued [[scenario:edit-file queued-after-removal.txt]]',
    );
    expect(waiting.disposition).toBe('queued');
    await live.event(topic, 'message.delta');

    const from = live.mark();
    expect(
      (await owner.delete(`/api/projects/${project.id}/members/${leaver.userId}`)).status,
    ).toBe(204);
    const cut = await live.waitFor((frame) => frame.op === 'rejected' && frame.topic === topic, {
      from,
      timeout: 5000,
      what: 'the session stream to be cut',
    });
    expect(cut.code).toBe('forbidden');
    await live.waitFor(
      (frame) => frame.op === 'rejected' && frame.topic === `project:${project.id}`,
      { from, timeout: 5000, what: 'the project stream to be cut' },
    );

    // The run does not go on working in a project its owner may no longer touch.
    const stopped = await until(async () => {
      const state = await getRun(owner, run.runId!);
      return state.status === 'running' || state.status === 'accepted' ? undefined : state;
    });
    expect(stopped.status).toBe('stopped');
    // Nothing more reaches the removed member on that connection …
    const cutAt = live.frames.indexOf(cut);
    expect(
      live.frames.slice(cutAt + 1).filter((frame) => frame.op === 'event' && frame.topic === topic),
    ).toEqual([]);
    // … the session is gone for them …
    await notFound(leaver.get(`/api/sessions/${theirs.id}`), 'session after removal');
    await notFound(postMessage(leaver, theirs.id, 'let me back in'), 'send after removal');
    expect((await live.subscribe(topic)).op).toBe('rejected');
    expect((await leaver.get<{ sessions: unknown[] }>('/api/sessions')).body.sessions).toEqual([]);
    // … and the queued message is never sent on their behalf.
    const users = (await transcript(owner, theirs.id)).filter(
      (event) => event.type === 'message.user',
    );
    expect(users).toHaveLength(1);
    expect(existsSync(path.join(project.rootDir, 'written-after-removal.txt'))).toBe(false);
    expect(existsSync(path.join(project.rootDir, 'queued-after-removal.txt'))).toBe(false);
    await live.close();
  });

  it('an API token is bound by its scopes: a read-only token can read its owner’s session and cannot send or stop', async () => {
    const hers = await createSession(alice, project.id);
    const run = await send(alice, hers.id, 'token test [[scenario:bash npm test]]');
    const [ask] = await approvalsWaiting(alice, hers.id);
    const created = await alice.post<{ token: string }>('/api/auth/tokens', {
      name: 'read-only',
      scopes: ['read'],
    });
    expect(created.status).toBe(200);
    const robot = studio.client();
    robot.bearer = created.body.token;
    expect((await robot.get<Json>(`/api/sessions/${hers.id}`)).body.id).toBe(hers.id);
    for (const attempt of [
      postMessage(robot, hers.id, 'robot here'),
      robot.post(`/api/sessions/${hers.id}/stop`),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect((response.body as ErrorBody).error.code).toBe('insufficient_scope');
    }
    // Another member's token is no better than that member.
    const bobToken = await bob.post<{ token: string }>('/api/auth/tokens', {
      name: 'bobs',
      scopes: ['read', 'write'],
    });
    const bobRobot = studio.client();
    bobRobot.bearer = bobToken.body.token;
    await notFound(bobRobot.get(`/api/sessions/${hers.id}`), 'another member’s token');
    expect((await alice.get<Json>(`/api/approvals/${ask!.id}`)).body.status).toBe('pending');
    await decide(alice, ask!.id, 'deny');
    await runEnded(alice, run.runId!);
  });

  it('AT-WB-056 (adapted): an approval is answered by a person in a browser — no API token can allow or deny it, whatever its scopes and whoever made it', async () => {
    const hers = await createSession(alice, project.id);
    const run = await send(alice, hers.id, 'needs a person [[scenario:bash npm test]]');
    const [ask] = await approvalsWaiting(alice, hers.id);
    const robots: Array<[string, ApiClient]> = [];
    for (const [who, client, scopes] of [
      ['her own read-only token', alice, ['read']],
      ['her own write token', alice, ['read', 'write']],
      ['the instance owner’s admin token', owner, ['read', 'write', 'admin']],
      ['another member’s token', bob, ['read', 'write']],
    ] as const) {
      const token = await client.post<{ token: string }>('/api/auth/tokens', {
        name: `answering ${robots.length}`,
        scopes,
      });
      expect(token.status, who).toBe(200);
      const robot = studio.client();
      robot.bearer = token.body.token;
      robots.push([who, robot]);
    }
    for (const [who, robot] of robots) {
      for (const decision of ['allow', 'deny'] as const) {
        const response = await decide(robot, ask!.id, decision);
        expect(response.status, `${who}: ${decision}`).toBe(403);
        expect((response.body as ErrorBody).error.code, who).toBe('session_required');
      }
    }
    expect((await alice.get<Json>(`/api/approvals/${ask!.id}`)).body).toMatchObject({
      status: 'pending',
      decidedBy: null,
    });
    // The person, in her browser, still can.
    expect((await decide(alice, ask!.id, 'deny')).status).toBe(200);
    await runEnded(alice, run.runId!);
  });
});
