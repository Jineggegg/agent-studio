import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime, until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  approvalsWaiting,
  createMember,
  createProject,
  createSession,
  decide,
  runEnded,
  runToEnd,
  send,
  shareProject,
  startAgentStudio,
  transcript,
  type Json,
  type Project,
  type Receipt,
  type Session,
} from './support/workbench.js';

/**
 * 6.3 — The task inbox (requirements 04 §6.3 AT-NTF-001…015, §7.4; also 01
 * §6.13 AT-WB-132/133).
 *
 * The inbox is a read-only summary of the caller's own runs in four groups:
 * waiting for an approval, needing handling (failed or interrupted), results
 * not yet looked at, and running. The one thing it can do is acknowledge —
 * and acknowledging never approves, denies, continues or runs anything.
 *
 * Each test signs in a fresh member so that its inbox holds only what the
 * test put there. Not testable from outside: "results older than three days
 * are left out" (needs a clock).
 */
describe('6.3 the task inbox', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let people = 0;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'inbox');
  });
  afterAll(() => studio?.destroy());

  /** A new member with write access to the project and an empty inbox. */
  async function person(): Promise<ApiClient> {
    const member = await createMember(studio, owner, `inboxuser${(people += 1)}`);
    await shareProject(owner, project.id, member.userId!, 'write');
    return member;
  }
  const inbox = async (client: ApiClient) => (await client.get<Json>('/api/inbox')).body;
  const runIds = (items: Json[]) => items.map((item) => item.runId as string);
  const acknowledge = (client: ApiClient, runId: string) =>
    client.post<Json>('/api/inbox/acknowledge', { runId });
  async function finished(
    client: ApiClient,
    text = 'a finished result',
  ): Promise<{ session: Session; runId: string }> {
    const session = await createSession(client, project.id);
    const run = await runToEnd(client, session.id, text);
    return { session, runId: run.id };
  }
  async function failed(client: ApiClient): Promise<{ session: Session; runId: string }> {
    const session = await createSession(client, project.id);
    const run = await runToEnd(client, session.id, 'this one breaks [[scenario:crash]]');
    expect(run.status).toBe('failed');
    return { session, runId: run.id };
  }
  async function waitingForApproval(
    client: ApiClient,
  ): Promise<{ session: Session; receipt: Receipt; approvalId: string }> {
    const session = await createSession(client, project.id);
    const receipt = await send(client, session.id, 'needs a yes [[scenario:bash npm test]]');
    const [approval] = await approvalsWaiting(client, session.id);
    return { session, receipt, approvalId: approval!.id };
  }
  async function running(client: ApiClient): Promise<{ session: Session; receipt: Receipt }> {
    const session = await createSession(client, project.id);
    const receipt = await send(client, session.id, 'still going [[scenario:long 700]]');
    await until(
      async () => (await client.get<Json>(`/api/runs/${receipt.runId}`)).body.status === 'running',
      { what: 'the run to be running' },
    );
    return { session, receipt };
  }
  const stop = async (client: ApiClient, sessionId: string) => {
    await client.post(`/api/sessions/${sessionId}/stop`);
  };

  it('AT-NTF-001 / AT-WB-132 (adapted): a pending approval, a failed run, an unviewed result and a running run are listed in those four groups, in that order, each saying what it is', async () => {
    const me = await person();
    const result = await finished(me);
    const failure = await failed(me);
    const approval = await waitingForApproval(me);
    const active = await running(me);

    const box = await inbox(me);
    expect(Object.keys(box.groups)).toEqual(['approvals', 'needsHandling', 'results', 'running']);
    expect(runIds(box.groups.approvals)).toEqual([approval.receipt.runId]);
    expect(runIds(box.groups.needsHandling)).toEqual([failure.runId]);
    expect(runIds(box.groups.results)).toEqual([result.runId]);
    expect(runIds(box.groups.running)).toEqual([active.receipt.runId]);
    expect(box.counts).toEqual({ approvals: 1, needsHandling: 1, results: 1, running: 1 });
    expect(box.truncated).toBe(false);

    expect(box.groups.approvals[0]).toMatchObject({
      kind: 'approval',
      sessionId: approval.session.id,
      projectId: project.id,
      projectName: 'inbox',
      agentId: 'claude-code',
      agentName: 'Claude Code',
      runStatus: 'running',
      acknowledgeable: false,
      approval: { id: approval.approvalId, kind: 'tool', toolName: 'Bash', requiresOwner: false },
      link: `/projects/${project.id}/sessions/${approval.session.id}`,
    });
    expect(box.groups.needsHandling[0]).toMatchObject({
      kind: 'needs-handling',
      runStatus: 'failed',
      interruptedByRestart: false,
      acknowledgeable: true,
      approval: null,
    });
    expect(box.groups.needsHandling[0].error.length).toBeGreaterThan(5);
    expect(box.groups.results[0]).toMatchObject({
      kind: 'result',
      runStatus: 'completed',
      acknowledgeable: true,
      error: null,
    });
    expect(box.groups.running[0]).toMatchObject({
      kind: 'running',
      runStatus: 'running',
      acknowledgeable: false,
    });
    // AT-NTF-014 (adapted): the one-line summary counts what is waiting for the person — the approval and the failure.
    const summary = (await me.get<Json>('/api/inbox/summary')).body;
    expect(summary).toMatchObject({
      counts: box.counts,
      waiting: 2,
      status: { code: 'waiting', count: 2 },
    });
    expect(summary.line.length).toBeGreaterThan(0);

    await decide(me, approval.approvalId, 'deny');
    await runEnded(me, approval.receipt.runId!);
    await stop(me, active.session.id);
  });

  it('AT-NTF-005 / AT-WB-133: acknowledging a run that is waiting for an approval, or still running, is refused as a conflict — nothing changes, and the agent’s request is neither approved nor denied', async () => {
    const me = await person();
    const approval = await waitingForApproval(me);
    const active = await running(me);
    for (const runId of [approval.receipt.runId!, active.receipt.runId!]) {
      const refused = await acknowledge(me, runId);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('task_in_progress');
    }
    const many = await me.post<Json>('/api/inbox/acknowledge-results', {
      runIds: [approval.receipt.runId, active.receipt.runId],
    });
    expect(many.body).toEqual({ acknowledged: 0 });
    // The request is exactly as it was: pending, unanswered, and the command has not run.
    expect((await me.get<Json>(`/api/approvals/${approval.approvalId}`)).body).toMatchObject({
      status: 'pending',
      decidedBy: null,
    });
    expect(
      (await transcript(me, approval.session.id)).filter(
        (event) => event.type === 'tool.finished' || event.type === 'approval.resolved',
      ),
    ).toEqual([]);
    expect((await me.get<Json>(`/api/runs/${active.receipt.runId}`)).body.status).toBe('running');
    const box = await inbox(me);
    expect(box.counts).toMatchObject({ approvals: 1, running: 1 });
    // The inbox has no way to approve, answer, continue or stop: those routes do not exist under it.
    for (const action of ['approve', 'decision', 'continue', 'stop', 'deny']) {
      expect(
        (
          await me.post(`/api/inbox/${action}`, {
            runId: approval.receipt.runId,
            decision: 'allow',
          })
        ).status,
        action,
      ).toBe(404);
    }
    expect((await me.get<Json>(`/api/approvals/${approval.approvalId}`)).body.status).toBe(
      'pending',
    );
    await decide(me, approval.approvalId, 'deny');
    await runEnded(me, approval.receipt.runId!);
    await stop(me, active.session.id);
  });

  it('AT-NTF-006 (adapted): acknowledging a result removes it, and with it the earlier unread results of the same session; acknowledging it again succeeds, flagged as already handled', async () => {
    const me = await person();
    const session = await createSession(me, project.id);
    const first = await runToEnd(me, session.id, 'first answer');
    const second = await runToEnd(me, session.id, 'second answer');
    const elsewhere = await finished(me, 'another conversation');
    // One row per conversation: its newest unread result stands for the earlier ones.
    expect(runIds((await inbox(me)).groups.results).sort()).toEqual(
      [second.id, elsewhere.runId].sort(),
    );

    const acknowledged = await acknowledge(me, second.id);
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body).toEqual({ acknowledged: true, alreadyHandled: false });
    expect(runIds((await inbox(me)).groups.results)).toEqual([elsewhere.runId]);
    expect((await me.get<Json>(`/api/sessions/${session.id}`)).body.attention).toBe('none');
    for (const runId of [first.id, second.id])
      expect(
        (await me.get<Json>(`/api/runs/${runId}`)).body.seenAt,
        'the earlier result is read as well',
      ).not.toBeNull();
    const again = await acknowledge(me, second.id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ acknowledged: true, alreadyHandled: true });
    // Nothing was run by any of it.
    expect(
      (await transcript(me, session.id)).filter((event) => event.type === 'run.started'),
    ).toHaveLength(2);
  });

  it('AT-NTF-007: "mark all read" with three results, a failure and an approval acknowledges exactly the three results and says so', async () => {
    const me = await person();
    const results = [
      await finished(me, 'one'),
      await finished(me, 'two'),
      await finished(me, 'three'),
    ];
    const failure = await failed(me);
    const approval = await waitingForApproval(me);
    const all = [...results.map((item) => item.runId), failure.runId, approval.receipt.runId!];
    const marked = await me.post<Json>('/api/inbox/acknowledge-results', { runIds: all });
    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({ acknowledged: 3 });
    const box = await inbox(me);
    expect(box.counts).toEqual({ approvals: 1, needsHandling: 1, results: 0, running: 0 });
    expect(runIds(box.groups.needsHandling)).toEqual([failure.runId]);
    expect((await me.get<Json>(`/api/approvals/${approval.approvalId}`)).body.status).toBe(
      'pending',
    );
    await decide(me, approval.approvalId, 'deny');
    await runEnded(me, approval.receipt.runId!);
  });

  it('AT-NTF-008 / AT-NTF-002: another person’s run is "not found" exactly like an id that does not exist, and never shows in one’s inbox; a bulk request with 0 or 101 ids is refused', async () => {
    const alice = await person();
    const bob = await person();
    const hers = await finished(alice);
    const herFailure = await failed(alice);
    expect((await inbox(bob)).counts).toEqual({
      approvals: 0,
      needsHandling: 0,
      results: 0,
      running: 0,
    });
    expect((await bob.get<Json>('/api/inbox/summary')).body.status).toEqual({
      code: 'clear',
      count: 0,
    });

    const foreign = await acknowledge(bob, hers.runId);
    const unknown = await acknowledge(bob, '0123456789abcdefghjkmnpqrs');
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('task_not_found');
    expect(foreign.body).toEqual(unknown.body);
    expect(
      (
        await bob.post<Json>('/api/inbox/acknowledge-results', {
          runIds: [hers.runId, herFailure.runId],
        })
      ).body,
    ).toEqual({ acknowledged: 0 });
    expect((await inbox(alice)).counts).toMatchObject({ results: 1, needsHandling: 1 });
    // The instance owner's inbox is the owner's own, too.
    expect(runIds((await inbox(owner)).groups.results)).not.toContain(hers.runId);
    expect((await acknowledge(owner, hers.runId)).status).toBe(404);

    expect((await alice.post('/api/inbox/acknowledge-results', { runIds: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_unused, index) =>
      `${String(index).padStart(4, '0')}456789abcdefghjkmnpqrs`.slice(0, 26),
    );
    expect((await alice.post('/api/inbox/acknowledge-results', { runIds: tooMany })).status).toBe(
      400,
    );
    expect(
      (await alice.post('/api/inbox/acknowledge-results', { runIds: [hers.runId, hers.runId] }))
        .status,
    ).toBe(400);
    expect((await alice.post('/api/inbox/acknowledge', { runId: 'not-an-id' })).status).toBe(400);
    expect((await studio.client().get('/api/inbox')).status).toBe(401);
  });

  it('§7.4: a member’s dangerous request appears in the owner’s inbox as an approval only the owner can give — the member’s other items do not', async () => {
    const me = await person();
    const ordinary = await finished(me);
    const session = await createSession(me, project.id);
    const receipt = await send(me, session.id, 'clean up [[scenario:bash rm -rf dist]]');
    const [approval] = await approvalsWaiting(me, session.id);
    expect(approval!.requiresOwner).toBe(true);
    const ownerBox = await inbox(owner);
    const item = ownerBox.groups.approvals.find((entry: Json) => entry.runId === receipt.runId);
    expect(item).toMatchObject({
      kind: 'approval',
      userId: me.userId,
      approval: { id: approval!.id, requiresOwner: true },
    });
    expect(runIds(ownerBox.groups.results)).not.toContain(ordinary.runId);
    // Seeing it there does not answer it; acknowledging it is refused.
    expect((await acknowledge(owner, receipt.runId!)).status).toBeGreaterThanOrEqual(400);
    expect((await me.get<Json>(`/api/approvals/${approval!.id}`)).body.status).toBe('pending');
    await decide(owner, approval!.id, 'deny');
    await runEnded(me, receipt.runId!);
    expect(
      (await inbox(owner)).groups.approvals.find((entry: Json) => entry.runId === receipt.runId),
    ).toBeUndefined();
  });

  it('AT-NTF-003: a failed run is no longer listed once its session is archived or deleted, or its project is archived', async () => {
    const me = await person();
    const archivedSession = await failed(me);
    const deletedSession = await failed(me);
    const side = await createProject(studio, owner, 'inbox-side');
    await shareProject(owner, side.id, me.userId!, 'write');
    const inArchivedProject = await createSession(me, side.id);
    const sideRun = await runToEnd(me, inArchivedProject.id, 'breaks too [[scenario:crash]]');
    expect(runIds((await inbox(me)).groups.needsHandling).sort()).toEqual(
      [archivedSession.runId, deletedSession.runId, sideRun.id].sort(),
    );

    await me.patch(`/api/sessions/${archivedSession.session.id}`, { archived: true });
    expect(runIds((await inbox(me)).groups.needsHandling).sort()).toEqual(
      [deletedSession.runId, sideRun.id].sort(),
    );
    await me.delete(`/api/sessions/${deletedSession.session.id}`);
    expect(runIds((await inbox(me)).groups.needsHandling)).toEqual([sideRun.id]);
    await owner.patch(`/api/projects/${side.id}`, { archived: true });
    expect((await inbox(me)).counts.needsHandling).toBe(0);
    // Restoring brings back what is still unresolved.
    await owner.patch(`/api/projects/${side.id}`, { archived: false });
    expect(runIds((await inbox(me)).groups.needsHandling)).toEqual([sideRun.id]);
  });

  it('AT-NTF-009: opening a session clears its unread result from the inbox; a failure stays listed until it is acknowledged — which runs nothing', async () => {
    const me = await person();
    const result = await finished(me);
    const failure = await failed(me);
    await me.post(`/api/sessions/${result.session.id}/seen`);
    await me.post(`/api/sessions/${failure.session.id}/seen`);
    const box = await inbox(me);
    expect(box.groups.results).toEqual([]);
    expect(runIds(box.groups.needsHandling)).toEqual([failure.runId]);

    const dismissed = await acknowledge(me, failure.runId);
    expect(dismissed.body).toEqual({ acknowledged: true, alreadyHandled: false });
    expect((await inbox(me)).counts.needsHandling).toBe(0);
    expect((await me.get<Json>(`/api/runs/${failure.runId}`)).body.dismissedAt).not.toBeNull();
    expect(
      (await transcript(me, failure.session.id)).filter((event) => event.type === 'run.started'),
    ).toHaveLength(1);
    expect((await acknowledge(me, failure.runId)).body.alreadyHandled).toBe(true);
  });

  it('§7.4: a failure with messages queued behind it cannot be acknowledged from the inbox — doing so would send them, and the inbox never starts a run', async () => {
    const me = await person();
    const session = await createSession(me, project.id);
    const failing = await send(
      me,
      session.id,
      'breaks after a while [[scenario:long 20]] [[scenario:crash]]',
    );
    const queued = await send(me, session.id, 'would run next');
    expect(queued.disposition).toBe('queued');
    await runEnded(me, failing.runId!);
    const refused = await acknowledge(me, failing.runId!);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('queue_waiting');
    expect(
      (await me.get<{ queue: unknown[] }>(`/api/sessions/${session.id}/queue`)).body.queue,
    ).toHaveLength(1);
    expect(
      (await transcript(me, session.id)).filter((event) => event.type === 'message.user'),
    ).toHaveLength(1);
    await me.delete(`/api/sessions/${session.id}/queue/${queued.queueItemId}`);
    expect((await acknowledge(me, failing.runId!)).status).toBe(200);
  });

  it('AT-NTF-010 (adapted): a run that completes while its session is visibly on screen leaves no result row and no notification; with the page hidden it leaves both', async () => {
    const me = await person();
    const live = await Realtime.open(studio, me);
    await live.subscribe(`user:${me.userId}`);
    const watched = await createSession(me, project.id);
    await me.put('/api/sessions/presence', { clientId: 'inbox-tab-0001', visible: [watched.id] });
    await runToEnd(me, watched.id, 'finishing in view');
    expect((await inbox(me)).counts.results).toBe(0);
    expect((await me.get<Json>('/api/notifications')).body.notifications).toEqual([]);

    await me.put('/api/sessions/presence', { clientId: 'inbox-tab-0001', visible: [] });
    const from = live.mark();
    const hidden = await runToEnd(me, watched.id, 'finishing out of view');
    await live.event(`user:${me.userId}`, 'inbox.changed', { from });
    expect(runIds((await inbox(me)).groups.results)).toEqual([hidden.id]);
    const stored = await until(async () => {
      const list = (await me.get<Json>('/api/notifications')).body.notifications as Json[];
      return list.length > 0 ? list : undefined;
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: 'reply-finished',
      sessionId: watched.id,
      runId: hidden.id,
      readAt: null,
      targetAvailable: true,
    });
    expect((await me.get<Json>('/api/inbox/summary')).body).toMatchObject({
      status: { code: 'results', count: 1 },
      unreadNotifications: 1,
    });
    // AT-NTF-040: somebody else having the session on screen does not count as the owner of the run having seen it.
    await owner.put('/api/sessions/presence', {
      clientId: 'owner-tab-0002',
      visible: [watched.id],
    });
    const second = await runToEnd(me, watched.id, 'the owner is watching, I am not');
    expect(runIds((await inbox(me)).groups.results)).toContain(second.id);
    await live.close();
  });
});
