import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime, until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  approvalsWaiting,
  createProject,
  createSession,
  decide,
  getRun,
  newRequestId,
  runEnded,
  sandboxIsOn,
  send,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
  type Receipt,
  type Run,
  type Session,
} from './support/workbench.js';

/**
 * 6.7 — Restart and recovery (requirements 01 §6.7, §5.10).
 *
 * The scene is set once: several sessions are caught at different moments —
 * mid-run, waiting for an approval, with a queued message, finished but not
 * yet looked at — and then the server is stopped and started again on the
 * same data. Each test then checks one promise about what the owner finds.
 *
 * The rule under test: a run the server was carrying when it went down is
 * marked interrupted and is NEVER run again by itself. A person continues it
 * (one new run) or dismisses it.
 */
describe('6.7 restart and recovery', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let codexAvailable = false;

  // What was going on when the server went down.
  let midRun: { session: Session; receipt: Receipt; eventsBefore: number };
  let waitingForApproval: { session: Session; receipt: Receipt; approvalId: string };
  let approvedThenCut: { session: Session; receipt: Receipt };
  let withQueue: { session: Session; receipt: Receipt; queued: Receipt };
  let twoDevices: { session: Session; receipt: Receipt };
  let toDismiss: { session: Session; receipt: Receipt };
  let finishedUnseen: Session;
  let failedUnseen: Session;
  let codexMidRun: { session: Session; receipt: Receipt } | null = null;

  /** Starts a long run and returns once its text is streaming, i.e. the agent is demonstrably at work. */
  async function startLongRun(agentId: string, text: string, extra: Record<string, unknown> = {}) {
    const session = await createSession(owner, project.id, agentId, extra);
    const live = await Realtime.open(studio, owner);
    await live.subscribe(`session:${session.id}`);
    const receipt = await send(owner, session.id, text);
    return { session, receipt, live };
  }

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'recovery');
    codexAvailable = await sandboxIsOn(owner);

    finishedUnseen = await createSession(owner, project.id);
    await runEnded(
      owner,
      (await send(owner, finishedUnseen.id, 'done while you were away')).runId!,
    );
    failedUnseen = await createSession(owner, project.id);
    await runEnded(
      owner,
      (await send(owner, failedUnseen.id, 'this breaks [[scenario:crash]]')).runId!,
    );

    const sockets: Realtime[] = [];
    const a = await startLongRun(
      'claude-code',
      'the original request [[scenario:echo-prompt]] [[scenario:edit-file written-once.txt]] [[scenario:long 300]]',
      { permissionMode: 'accept-edits' },
    );
    const c = await startLongRun(
      'claude-code',
      'needs a yes [[scenario:bash npm test]] [[scenario:long 300]]',
    );
    const e = await startLongRun('claude-code', 'busy [[scenario:long 300]]');
    const g = await startLongRun('claude-code', 'for two devices [[scenario:long 300]]');
    const h = await startLongRun('claude-code', 'to be dismissed [[scenario:long 300]]');
    const f = codexAvailable
      ? await startLongRun('codex', 'codex at work [[scenario:long 300]]')
      : null;
    sockets.push(a.live, c.live, e.live, g.live, h.live);
    if (f) sockets.push(f.live);

    const b = await createSession(owner, project.id);
    const bReceipt = await send(owner, b.id, 'ask first [[scenario:bash npm test]]');
    const [bApproval] = await approvalsWaiting(owner, b.id);
    waitingForApproval = { session: b, receipt: bReceipt, approvalId: bApproval!.id };

    const [cApproval] = await approvalsWaiting(owner, c.session.id);
    expect((await decide(owner, cApproval!.id, 'allow')).status).toBe(200);
    const queued = await send(owner, e.session.id, 'sent from the queue');
    expect(queued.disposition).toBe('queued');

    // Every long run is streaming text before the lights go out.
    for (const run of [a, c, e, g, h, ...(f ? [f] : [])])
      await run.live.event(`session:${run.session.id}`, 'message.delta');
    midRun = {
      session: a.session,
      receipt: a.receipt,
      eventsBefore: (await transcript(owner, a.session.id)).length,
    };
    approvedThenCut = { session: c.session, receipt: c.receipt };
    withQueue = { session: e.session, receipt: e.receipt, queued };
    twoDevices = { session: g.session, receipt: g.receipt };
    toDismiss = { session: h.session, receipt: h.receipt };
    codexMidRun = f ? { session: f.session, receipt: f.receipt } : null;

    await studio.restart();
    // The old connections ended with the old process.
    await Promise.all(sockets.map((socket) => socket.closed));
  });
  afterAll(() => studio?.destroy());

  const sessionNow = async (id: string) => (await owner.get<Json>(`/api/sessions/${id}`)).body;
  const unresolved = async () =>
    (await owner.get<{ runs: Run[] }>('/api/runs?state=unresolved')).body.runs.map((run) => run.id);

  it('the owner’s sign-in, the sessions and their transcripts survive the restart', async () => {
    expect((await owner.get('/api/auth/state')).status).toBe(200);
    const events = await transcript(owner, finishedUnseen.id);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'completed' } });
    expect(events.filter((event) => event.type === 'message.assistant')).toHaveLength(1);
    const list = await owner.get<{ sessions: Array<{ id: string }> }>(
      `/api/sessions?projectId=${project.id}`,
    );
    expect(list.body.sessions.map((row) => row.id)).toEqual(
      expect.arrayContaining([finishedUnseen.id, midRun.session.id, withQueue.session.id]),
    );
  });

  it('AT-WB-076: a run in progress at the restart is marked interrupted by the restart, the session is idle and flagged, and the run was not executed again', async () => {
    const run = await getRun(owner, midRun.receipt.runId!);
    expect(run).toMatchObject({
      status: 'interrupted',
      interruptedByRestart: true,
      continuedByRunId: null,
      dismissedAt: null,
    });
    const session = await sessionNow(midRun.session.id);
    expect(session.activeRunId).toBeNull();
    expect(session.attention).toBe('needs-you');

    const events = await transcript(owner, midRun.session.id);
    const finished = events.filter((event) => event.type === 'run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data).toMatchObject({
      runId: run.id,
      status: 'interrupted',
      interruptedByRestart: true,
    });
    expect(events.at(-1)).toBe(finished[0]);
    // Not re-executed: one user turn, one start, and nothing but the closing events was added after the restart.
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message.user')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
    const added = events.slice(midRun.eventsBefore).map((event) => event.type);
    expect(added.filter((type) => type !== 'run.finished' && type !== 'message.assistant')).toEqual(
      [],
    );
    expect(readFileSync(path.join(project.rootDir, 'written-once.txt'), 'utf8')).toBe(
      'written by the stand-in\n',
    );

    // It is on the recovery list, and a client opening the session is told so.
    expect(await unresolved()).toContain(run.id);
    const live = await Realtime.open(studio, owner);
    const snapshot = (await live.subscribe(`session:${midRun.session.id}`)).snapshot;
    expect(snapshot.run).toBeNull();
    expect(snapshot.unresolvedRuns.map((item: Json) => item.id)).toEqual([run.id]);
    await live.close();
    expect((await owner.get<{ runs: Run[] }>('/api/runs?state=active')).body.runs).toEqual([]);
  });

  it('AT-NTF-004/038: after the restart the inbox lists the cut-short runs as needing handling — no approval is listed — and the owner is told once per session, not once per run', async () => {
    const box = (await owner.get<Json>('/api/inbox')).body;
    expect(box.groups.approvals).toEqual([]);
    expect(box.groups.running).toEqual([]);
    const interrupted = [
      midRun,
      waitingForApproval,
      approvedThenCut,
      withQueue,
      twoDevices,
      toDismiss,
      ...(codexMidRun ? [codexMidRun] : []),
    ];
    const listed = box.groups.needsHandling as Json[];
    for (const scene of interrupted) {
      const item = listed.find((entry) => entry.runId === scene.receipt.runId);
      expect(item, `run of session ${scene.session.id}`).toMatchObject({
        kind: 'needs-handling',
        runStatus: 'interrupted',
        interruptedByRestart: true,
        sessionId: scene.session.id,
      });
    }
    // The run that had been waiting for an approval is there as an interruption, with no approval attached.
    expect(
      listed.find((entry) => entry.runId === waitingForApproval.receipt.runId).approval,
    ).toBeNull();

    const told = await until(
      async () => {
        const notifications = (
          await owner.get<{ notifications: Json[] }>('/api/notifications?order=newest&limit=100')
        ).body.notifications.filter((item) => item.kind === 'run-interrupted');
        return notifications.length >= interrupted.length ? notifications : undefined;
      },
      { what: 'the interruption notices' },
    );
    expect(told.map((item) => item.sessionId).sort()).toEqual(
      interrupted.map((scene) => scene.session.id).sort(),
    ); // one each
    expect(told.every((item) => /restart/i.test(item.body))).toBe(true);
  });

  it('AT-WB-080: re-submitting the request whose receipt was lost returns a duplicate receipt in state "interrupted" and does not invoke the agent', async () => {
    const again = await owner.post<Receipt>(`/api/sessions/${midRun.session.id}/messages`, {
      requestId: midRun.receipt.requestId,
      text: 'the original request [[scenario:echo-prompt]] [[scenario:edit-file written-once.txt]] [[scenario:long 300]]',
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      duplicate: true,
      runId: midRun.receipt.runId,
      run: { status: 'interrupted', interruptedByRestart: true },
    });
    expect((await sessionNow(midRun.session.id)).activeRunId).toBeNull();
    expect(
      (await owner.get<{ runs: Run[] }>(`/api/runs?state=all&sessionId=${midRun.session.id}`)).body
        .runs,
    ).toHaveLength(1);
  });

  it('AT-WB-082: an approval that was waiting when the server went down is not waiting afterwards — nothing is reconstructed', async () => {
    expect((await owner.get<{ approvals: unknown[] }>('/api/approvals')).body.approvals).toEqual(
      [],
    );
    const record = await owner.get<Json>(`/api/approvals/${waitingForApproval.approvalId}`);
    if (record.status === 200) expect(record.body.status).not.toBe('pending');
    const late = await decide(owner, waitingForApproval.approvalId, 'allow');
    expect([404, 409]).toContain(late.status);
    expect((await getRun(owner, waitingForApproval.receipt.runId!)).status).toBe('interrupted');
    const events = await transcript(owner, waitingForApproval.session.id);
    expect(
      events.filter((event) => event.type === 'tool.finished' && event.data.status === 'ok'),
    ).toEqual([]); // the command never ran
    const live = await Realtime.open(studio, owner);
    expect(
      (await live.subscribe(`session:${waitingForApproval.session.id}`)).snapshot.pendingApprovals,
    ).toEqual([]);
    await live.close();
  });

  it('AT-WB-105 (adapted): the "finished, not yet looked at" mark survives the restart, and a failure stays flagged as needing attention', async () => {
    expect((await sessionNow(finishedUnseen.id)).attention).toBe('unseen');
    expect((await sessionNow(failedUnseen.id)).attention).toBe('needs-you');
    await owner.post(`/api/sessions/${finishedUnseen.id}/seen`);
    expect((await sessionNow(finishedUnseen.id)).attention).toBe('none');
    // Looking at a failure does not make it go away; dismissing it does.
    await owner.post(`/api/sessions/${failedUnseen.id}/seen`);
    expect((await sessionNow(failedUnseen.id)).attention).toBe('needs-you');
  });

  it('AT-WB-081 (adapted): a message that was queued behind the interrupted run is kept and is not sent by itself; it goes out once the interruption has been dealt with', async () => {
    const queue = (
      await owner.get<{ queue: Array<{ id: string; text: string }> }>(
        `/api/sessions/${withQueue.session.id}/queue`,
      )
    ).body.queue;
    expect(queue.map((item) => item.text)).toEqual(['sent from the queue']);
    expect((await getRun(owner, withQueue.receipt.runId!)).status).toBe('interrupted');
    expect((await sessionNow(withQueue.session.id)).activeRunId).toBeNull();
    const before = (await transcript(owner, withQueue.session.id)).filter(
      (event) => event.type === 'message.user',
    );
    expect(before.map((event) => event.data.text)).toEqual(['busy [[scenario:long 300]]']);

    expect((await owner.post(`/api/runs/${withQueue.receipt.runId}/dismiss`)).status).toBe(200);
    const sent = await until(
      async () =>
        (await transcript(owner, withQueue.session.id)).find(
          (event) => event.type === 'message.user' && event.data.origin === 'queued',
        ),
      { what: 'the queued message to be sent after the dismissal' },
    );
    expect(sent.data.text).toBe('sent from the queue');
    await runEnded(owner, sent.data.runId);
    expect(
      (await transcript(owner, withQueue.session.id)).filter(
        (event) => event.type === 'message.user',
      ),
    ).toHaveLength(2);
  });

  it('AT-WB-077: Continue starts one new run in the same session — the continuation instruction followed by the original request, with the session’s current model — and the interruption is closed', async () => {
    // The owner changed the model since; the continuation uses what the session says now.
    expect(
      (await owner.patch(`/api/sessions/${midRun.session.id}`, { model: 'sonnet' })).status,
    ).toBe(200);
    const requestId = newRequestId();
    const continued = await owner.post<Json>(`/api/runs/${midRun.receipt.runId}/continue`, {
      requestId,
    });
    expect([200, 201, 202]).toContain(continued.status);
    const live = await Realtime.open(studio, owner);
    await live.subscribe(`session:${midRun.session.id}`, midRun.eventsBefore);
    const original = await getRun(owner, midRun.receipt.runId!);
    expect(original.continuedByRunId).not.toBeNull();
    const next = await getRun(owner, original.continuedByRunId!);
    expect(next).toMatchObject({
      sessionId: midRun.session.id,
      origin: 'continue',
      continuesRunId: original.id,
    });
    expect(await unresolved()).not.toContain(original.id);

    // Wait until the agent has repeated the prompt it was given, then stop the continuation (its long tail is not needed).
    const echoed = await live.event(`session:${midRun.session.id}`, 'message.assistant', {
      where: (frame) => frame.data.runId === next.id,
    });
    expect((await owner.post(`/api/sessions/${midRun.session.id}/stop`)).status).toBe(200);
    await runEnded(owner, next.id);
    const events = await transcript(owner, midRun.session.id);
    const turn = events.filter((event) => event.type === 'message.user').at(-1)!;
    expect(turn.data).toMatchObject({
      runId: next.id,
      origin: 'continue',
      continuesRunId: original.id,
    });
    expect(
      events.find((event) => event.type === 'run.started' && event.data.runId === next.id)!.data,
    ).toMatchObject({ model: 'sonnet', origin: 'continue', permissionMode: 'accept-edits' });
    // What the agent actually received: an instruction to continue, then the original request.
    const prompt: string = echoed.data.text;
    expect(prompt).toContain('the original request');
    expect(prompt.indexOf('the original request')).toBeGreaterThan(20);
    expect(prompt.slice(0, prompt.indexOf('the original request')).toLowerCase()).toMatch(
      /continu|interrupt/,
    );
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(2);
    await live.close();
  });

  it('AT-WB-078: Continue pressed on two devices at once starts exactly one continuation', async () => {
    const phone = await studio.owner();
    const runId = twoDevices.receipt.runId!;
    const [a, b] = await Promise.all([
      owner.post<Json>(`/api/runs/${runId}/continue`, { requestId: newRequestId() }),
      phone.post<Json>(`/api/runs/${runId}/continue`, { requestId: newRequestId() }),
    ]);
    const statuses = [a.status, b.status];
    expect(
      statuses.filter((status) => status >= 200 && status < 300).length,
    ).toBeGreaterThanOrEqual(1);
    const original = await until(async () => {
      const run = await getRun(owner, runId);
      return run.continuedByRunId ? run : undefined;
    });
    const runs = (
      await owner.get<{ runs: Run[] }>(`/api/runs?state=all&sessionId=${twoDevices.session.id}`)
    ).body.runs;
    expect(runs.filter((run) => run.continuesRunId === runId).map((run) => run.id)).toEqual([
      original.continuedByRunId,
    ]);
    expect(runs).toHaveLength(2);
    // The device that lost is not shown an error it has to act on: its request is either answered with the same
    // continuation or refused as already handled.
    const loser = [a, b].find((response) => response.status >= 400);
    if (loser) {
      expect(loser.status).toBe(409);
      expect(['run_not_available', 'run_not_continuable']).toContain(
        (loser.body as ErrorBody).error.code,
      );
    }
    await owner.post(`/api/sessions/${twoDevices.session.id}/stop`);
    await runEnded(owner, original.continuedByRunId!);
    expect(
      (await transcript(owner, twoDevices.session.id)).filter(
        (event) => event.type === 'run.started',
      ),
    ).toHaveLength(2);
  });

  it('AT-WB-079: dismissing an interrupted run removes it from the session, the recovery list and the attention mark without running anything; dismissing again is silent', async () => {
    const runId = toDismiss.receipt.runId!;
    expect(await unresolved()).toContain(runId);
    const tablet = await studio.owner();
    const first = await owner.post<{ run: Run; alreadyHandled: boolean }>(
      `/api/runs/${runId}/dismiss`,
    );
    expect(first.status).toBe(200);
    expect(first.body.alreadyHandled).toBe(false);
    expect(first.body.run.dismissedAt).not.toBeNull();
    expect(await unresolved()).not.toContain(runId);
    expect(
      (await owner.get<Json>(`/api/sessions/${toDismiss.session.id}/state`)).body.unresolvedRuns,
    ).toEqual([]);
    expect((await sessionNow(toDismiss.session.id)).attention).toBe('none');
    // Handled elsewhere already: the second device's × closes without an error.
    const second = await tablet.post<{ alreadyHandled: boolean }>(`/api/runs/${runId}/dismiss`);
    expect(second.status).toBe(200);
    expect(second.body.alreadyHandled).toBe(true);
    // Nothing was run, and a dismissed run can no longer be continued.
    expect(
      (await transcript(owner, toDismiss.session.id)).filter(
        (event) => event.type === 'run.started',
      ),
    ).toHaveLength(1);
    const late = await owner.post<ErrorBody>(`/api/runs/${runId}/continue`, {
      requestId: newRequestId(),
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('run_not_available');
    expect((await sessionNow(toDismiss.session.id)).activeRunId).toBeNull();
  });

  it('AT-WB-141: a tool that was approved in the interrupted run is asked again when the run is continued', async () => {
    const before = await transcript(owner, approvedThenCut.session.id);
    expect(
      before.filter(
        (event) => event.type === 'approval.resolved' && event.data.status === 'allowed',
      ),
    ).toHaveLength(1);
    const continued = await owner.post(`/api/runs/${approvedThenCut.receipt.runId}/continue`, {
      requestId: newRequestId(),
    });
    expect(continued.status).toBeLessThan(300);
    const [again] = await approvalsWaiting(owner, approvedThenCut.session.id);
    expect(again).toMatchObject({ command: 'npm test', status: 'pending' });
    expect(again!.runId).not.toBe(approvedThenCut.receipt.runId);
    await decide(owner, again!.id, 'deny');
    // This time it is refused, and the command does not run on the strength of the earlier yes.
    const refused = await until(
      async () =>
        (await transcript(owner, approvedThenCut.session.id)).find(
          (event) => event.type === 'tool.finished' && event.data.runId === again!.runId,
        ),
      { what: 'the refused tool call to be recorded' },
    );
    expect(refused.data.status).toBe('denied');
    await owner.post(`/api/sessions/${approvedThenCut.session.id}/stop`);
    await runEnded(owner, again!.runId);
  });

  it('AT-WB-076/077 (Codex): the other agent’s run is interrupted, not re-run, and can be continued', async (context) => {
    if (!codexMidRun)
      return context.skip('skipped: no sandbox on this machine, so Codex did not run');
    const run = await getRun(owner, codexMidRun.receipt.runId!);
    expect(run).toMatchObject({ status: 'interrupted', interruptedByRestart: true });
    expect(
      (await transcript(owner, codexMidRun.session.id)).filter(
        (event) => event.type === 'run.started',
      ),
    ).toHaveLength(1);
    const continued = await owner.post(`/api/runs/${run.id}/continue`, {
      requestId: newRequestId(),
    });
    expect(continued.status).toBeLessThan(300);
    const next = (await getRun(owner, run.id)).continuedByRunId!;
    await until(async () => (await getRun(owner, next)).status === 'running', {
      what: 'the continuation to run',
    });
    expect((await owner.post(`/api/sessions/${codexMidRun.session.id}/stop`)).status).toBe(200);
    expect((await runEnded(owner, next)).status).toBe('stopped');
  });

  it('after all of it, nothing is left running and nothing that was written before the restart was written twice', async () => {
    await until(
      async () =>
        (await owner.get<{ runs: Run[] }>('/api/runs?state=active')).body.runs.length === 0,
      { what: 'no active runs' },
    );
    expect(existsSync(path.join(project.rootDir, 'written-once.txt'))).toBe(true);
  });
});
