import { existsSync } from 'node:fs';
import { type Approval, type MessageReceipt, type Run, type Session, sessionTopic } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';
import { CONTINUATION_PREAMBLE } from '../../src/modules/agents/runtime.js';

const kits: AgentsKit[] = [];
afterEach(async () => {
  // Newest first: a restarted Studio shares its data directory with the one before it.
  for (const kit of kits.splice(0).reverse()) await kit.close();
});

async function start(options: Parameters<typeof createAgentsKit>[0] = {}): Promise<AgentsKit> {
  const kit = await createAgentsKit(options);
  kits.push(kit);
  return kit;
}

/** Stops the server the way a deploy or a crash does — the data directory stays — and starts a new one on it. */
async function restart(previous: AgentsKit, agent = new ScriptedAdapter({ nativeSessionId: 'native-1' })): Promise<AgentsKit> {
  await previous.t.studio.stop();
  const next = await start({ restartOf: previous, adapters: [agent] });
  // Start-up work (recovery) runs before the server accepts connections.
  await next.listen();
  return next;
}

describe('after a restart', () => {
  it('marks what was running as interrupted, cancels its approvals, and runs nothing again', async () => {
    const before = await start({ adapters: [new ScriptedAdapter({ nativeSessionId: 'native-1' })] });
    await before.listen();
    const session = await before.session();
    before.agent.script([
      { text: 'Step one is done.' },
      { text: 'Step two is half', complete: false },
      { permission: { toolName: 'Bash', kind: 'execute', input: { command: 'npm run migrate' }, command: 'npm run migrate' } },
      { text: 'never reached' },
    ]);
    const sent = await before.send(before.owner, session.id, 'migrate the database carefully');
    const approval = await until(async () => (await before.state(before.owner, session.id)).pendingApprovals[0]);
    const queued = await before.send(before.owner, session.id, 'then run the tests');
    expect(queued.body.disposition).toBe('queued');
    const seqBefore = (await before.owner.get<Session>(`/api/sessions/${session.id}`)).body.lastSeq;

    const after = await restart(before);
    const owner = after.owner;
    // Nothing was started by the new process.
    expect(after.agent.runs).toHaveLength(0);

    const run = (await owner.get<Run>(`/api/runs/${sent.body.runId}`)).body;
    expect(run).toMatchObject({ status: 'interrupted', interruptedByRestart: true, error: { code: 'server_restart' }, continuedByRunId: null, dismissedAt: null });
    expect(run.finishedAt).not.toBeNull();
    expect((await owner.get<Approval>(`/api/approvals/${approval.id}`)).body).toMatchObject({ status: 'cancelled', decidedBy: null });
    expect((await owner.get<{ approvals: Approval[] }>('/api/approvals')).body.approvals).toEqual([]);
    expect((await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' })).status).toBe(409);

    // The log says what happened, after everything that was already in it.
    const events = await after.events(owner, session.id);
    const added = events.filter((event) => event.seq > seqBefore).map((event) => event.type);
    expect(added).toEqual(['approval.resolved', 'run.finished']);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { runId: run.id, status: 'interrupted', interruptedByRestart: true } });
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(events.find((event) => event.type === 'message.assistant')).toMatchObject({ data: { text: 'Step one is done.' } });

    // The session is idle, needs its owner, and says so to a client that reconnects.
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body).toMatchObject({ attention: 'needs-you', activeRunId: null });
    const live = await after.connect(owner);
    const subscribed = await live.subscribe(sessionTopic(session.id), seqBefore);
    expect(subscribed).toMatchObject({ replayed: 2, snapshot: { run: null, pendingApprovals: [], streaming: [], unresolvedRuns: [{ id: run.id, status: 'interrupted' }] } });
    live.close();
    expect((await owner.get<{ runs: Run[] }>('/api/runs')).body.runs.map((entry) => entry.id)).toEqual([run.id]);
    // The notification module is told once.
    expect(after.internal.filter((event) => event.type === 'run.interrupted')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ runId: run.id, sessionId: session.id, userId: owner.userId, reason: 'restart', visibleTo: [] }) }),
    ]);

    // The message queued behind it was never sent, and is not sent behind the owner's back now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await after.state(owner, session.id)).queue.map((item) => item.text)).toEqual(['then run the tests']);
    expect(after.agent.runs).toHaveLength(0);

    // A lost receipt is answered with what became of the run — the agent is not invoked.
    const resent = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, { requestId: sent.body.requestId, text: 'migrate the database carefully' });
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ duplicate: true, runId: run.id, run: { status: 'interrupted' } });
    expect(after.agent.runs).toHaveLength(0);
  });

  it('continues an interrupted run once, resuming the agent\'s own conversation', async () => {
    const before = await start({ adapters: [new ScriptedAdapter({ nativeSessionId: 'native-1' })] });
    const session = await before.session(before.owner, { permissionMode: 'accept-edits' });
    before.agent.script([{ text: 'working' }, { permission: { toolName: 'Bash', kind: 'execute', input: { command: 'npm run build' }, command: 'npm run build' } }]);
    const sent = await before.send(before.owner, session.id, 'build the release');
    const approval = await until(async () => (await before.state(before.owner, session.id)).pendingApprovals[0]);
    // It was allowed once, before the restart…
    await before.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    before.agent.script([{ hang: true }]);
    await before.runEnded(before.owner, sent.body.runId!);
    const second = await before.send(before.owner, session.id, 'now publish it');
    await until(async () => (await before.state(before.owner, session.id)).run?.status === 'running');

    const after = await restart(before);
    const owner = after.owner;
    const deviceB = await after.t.signIn('owner');
    const record = second.body.runId!;
    await owner.patch(`/api/sessions/${session.id}`, { model: 'scripted-small', permissionMode: 'ask' });

    // Two devices tap Continue at once: exactly one continuation runs.
    after.agent.script([{ permission: { toolName: 'Bash', kind: 'execute', input: { command: 'npm run build' }, command: 'npm run build' } }, { text: 'published' }]);
    const [a, b] = await Promise.all([
      owner.post<MessageReceipt>(`/api/runs/${record}/continue`, { requestId: nextRequestId() }),
      deviceB.post<MessageReceipt>(`/api/runs/${record}/continue`, { requestId: nextRequestId() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const winner = a.status === 202 ? a : b;
    const loser = a.status === 202 ? b : a;
    expect(loser.body).toMatchObject({ error: { code: 'run_not_available' } });
    expect(winner.body).toMatchObject({ disposition: 'run', run: { origin: 'continue', continuesRunId: record, text: 'now publish it' } });

    // Approvals do not carry over: the same command is asked about again.
    const again = await until(async () => (await after.state(owner, session.id)).pendingApprovals[0]);
    expect(again.command).toBe('npm run build');
    expect(again.id).not.toBe(approval.id);
    await owner.post(`/api/approvals/${again.id}/decision`, { decision: 'allow' });
    const continuation = await after.runEnded(owner, winner.body.runId!);
    expect(continuation.status).toBe('completed');

    // The continuation resumed the agent's conversation, with the session's current choices and the fixed instruction.
    expect(after.agent.runs).toHaveLength(1);
    const request = after.agent.lastRun.request;
    expect(request).toMatchObject({ nativeSessionId: 'native-1', model: 'scripted-small', permissionMode: 'ask', origin: 'continue' });
    expect(request.prompt.text).toBe(`${CONTINUATION_PREAMBLE}\n\nnow publish it`);

    expect((await owner.get<Run>(`/api/runs/${record}`)).body).toMatchObject({ status: 'interrupted', continuedByRunId: winner.body.runId });
    expect((await owner.get<{ runs: Run[] }>('/api/runs')).body.runs).toEqual([]);
    expect((await after.state(owner, session.id)).unresolvedRuns).toEqual([]);
    const events = await after.events(owner, session.id);
    expect(events.filter((event) => event.type === 'message.user').at(-1)).toMatchObject({ data: { origin: 'continue', text: 'now publish it', continuesRunId: record } });
    // It cannot be continued a second time, nor dismissed afterwards; the winner's request id is idempotent.
    expect((await owner.post(`/api/runs/${record}/continue`, { requestId: nextRequestId() })).status).toBe(409);
    expect((await owner.post<{ alreadyHandled: boolean }>(`/api/runs/${record}/dismiss`)).body.alreadyHandled).toBe(true);
    const repeat = await owner.post<MessageReceipt>(`/api/runs/${record}/continue`, { requestId: winner.body.requestId });
    expect(repeat.body).toMatchObject({ duplicate: true, runId: winner.body.runId });
    expect(after.agent.runs).toHaveLength(1);
  });

  it('does not nest the instruction when a continuation is itself continued', async () => {
    const kit = await start();
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ fail: { code: 'boom', message: 'First failure.' } }]);
    const original = await kit.turn(owner, session.id, 'ship the feature');
    expect(original.status).toBe('failed');
    agent.script([{ fail: { code: 'boom', message: 'Second failure.' } }]);
    const first = await owner.post<MessageReceipt>(`/api/runs/${original.id}/continue`, { requestId: nextRequestId() });
    const failedAgain = await kit.runEnded(owner, first.body.runId!);
    // A continuation that fails is itself recoverable.
    expect(failedAgain).toMatchObject({ status: 'failed', continuesRunId: original.id });
    expect((await owner.get<{ runs: Run[] }>(`/api/runs?sessionId=${session.id}`)).body.runs.map((run) => run.id)).toEqual([failedAgain.id]);
    const second = await owner.post<MessageReceipt>(`/api/runs/${failedAgain.id}/continue`, { requestId: nextRequestId() });
    await kit.runEnded(owner, second.body.runId!);
    expect(agent.lastRun.request.prompt.text).toBe(`${CONTINUATION_PREAMBLE}\n\nship the feature`);
    // A run that ended well, or is still going, has nothing to continue.
    expect((await owner.post(`/api/runs/${second.body.runId}/continue`, { requestId: nextRequestId() })).body).toMatchObject({ error: { code: 'run_not_continuable' } });
  });

  it('dismisses a record without running anything, and refuses to continue while the session is busy', async () => {
    const kit = await start();
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ fail: { code: 'boom', message: 'It broke.' } }]);
    const failed = await kit.turn(owner, session.id, 'try');
    const runsBefore = agent.runs.length;

    agent.script([{ gate: 'busy-continue' }]);
    const other = await kit.send(owner, session.id, 'something else');
    await agent.reached('busy-continue');
    const refused = await owner.post(`/api/runs/${failed.id}/continue`, { requestId: nextRequestId() });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'session_busy' } });
    // The refusal released the claim.
    expect((await owner.get<Run>(`/api/runs/${failed.id}`)).body.continuedByRunId).toBeNull();
    expect((await owner.post(`/api/runs/${other.body.runId}/dismiss`)).body).toMatchObject({ error: { code: 'run_in_progress' } });
    agent.open('busy-continue');
    await kit.runEnded(owner, other.body.runId!);

    const dismissed = await owner.post<{ run: Run; alreadyHandled: boolean }>(`/api/runs/${failed.id}/dismiss`);
    expect(dismissed.body).toMatchObject({ alreadyHandled: false, run: { status: 'failed' } });
    expect(dismissed.body.run.dismissedAt).not.toBeNull();
    expect((await owner.post<{ alreadyHandled: boolean }>(`/api/runs/${failed.id}/dismiss`)).body.alreadyHandled).toBe(true);
    expect((await owner.post(`/api/runs/${failed.id}/continue`, { requestId: nextRequestId() })).body).toMatchObject({ error: { code: 'run_not_available' } });
    expect((await owner.get<{ runs: Run[] }>(`/api/runs?sessionId=${session.id}`)).body.runs).toEqual([]);
    expect(agent.runs.length).toBe(runsBefore + 1);
    expect((await owner.post('/api/runs/00000000000000000000000000/dismiss')).status).toBe(404);
  });

  it('keeps attention marks, the queue and the transcript across a restart', async () => {
    const before = await start();
    const { owner } = before;
    const finished = await before.session();
    await before.turn(owner, finished.id, 'finish while nobody looks');
    const failed = await before.session();
    before.agent.script([{ fail: { code: 'boom', message: 'It broke.' } }]);
    await before.turn(owner, failed.id, 'fail');
    const idle = await before.session();
    await before.turn(owner, idle.id, 'seen');
    await owner.post(`/api/sessions/${idle.id}/seen`);
    const marks = async (kit: AgentsKit, client = kit.owner) =>
      Object.fromEntries(
        (await Promise.all([finished, failed, idle].map((session) => client.get<Session>(`/api/sessions/${session.id}`)))).map((response) => [response.body.id, response.body.attention]),
      );
    const expected = { [finished.id]: 'unseen', [failed.id]: 'needs-you', [idle.id]: 'none' };
    expect(await marks(before)).toEqual(expected);
    const transcript = await before.events(owner, finished.id);

    const after = await restart(before);
    expect(await marks(after)).toEqual(expected);
    expect(await after.events(after.owner, finished.id)).toEqual(transcript);
    expect(after.internal.filter((event) => event.type === 'run.interrupted')).toEqual([]);
    // Opening the session on any device clears the "finished, unseen" mark.
    await after.owner.post(`/api/sessions/${finished.id}/seen`);
    expect((await marks(after))[finished.id]).toBe('none');
    // The restarted Studio really is running on the first one's data.
    expect(after.t.studio.context.config.dataDir).toBe(before.t.dataDir);
    expect(existsSync(before.t.dataDir)).toBe(true);
  });

  it('keeps the queue across a restart and sends it once the owner has dealt with the interruption', async () => {
    const before = await start({ adapters: [new ScriptedAdapter({ steering: false })] });
    const session = await before.session();
    before.agent.script([{ hang: true }]);
    const running = await before.send(before.owner, session.id, 'long job');
    await until(async () => (await before.state(before.owner, session.id)).run?.status === 'running');
    const queued = await before.send(before.owner, session.id, 'queued before the restart');
    expect(queued.body.disposition).toBe('queued');

    const after = await restart(before, new ScriptedAdapter({ steering: false }));
    const owner = after.owner;
    expect((await after.state(owner, session.id)).queue.map((item) => item.text)).toEqual(['queued before the restart']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(after.agent.runs).toHaveLength(0);

    // Dismissing the interrupted run is the owner's decision to move on; the queue then drains by itself.
    expect((await owner.post<{ alreadyHandled: boolean }>(`/api/runs/${running.body.runId}/dismiss`)).body.alreadyHandled).toBe(false);
    await until(() => after.agent.runs.length === 1, { what: 'the queued message to be sent' });
    await after.idle(owner, session.id);
    expect(after.agent.lastRun.request.prompt.text).toBe('queued before the restart');
    expect((await after.state(owner, session.id)).queue).toEqual([]);
    const receipt = await owner.get<MessageReceipt>(`/api/sessions/${session.id}/messages/${queued.body.requestId}`);
    expect(receipt.body).toMatchObject({ disposition: 'run', run: { status: 'completed', origin: 'queued' } });
  });
});
