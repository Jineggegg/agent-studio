import { type MessageReceipt, type QueuedMessage, type Run, type SendNowResponse, type SessionEvent, sessionTopic } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../src/testing/agents-kit.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

let kit: AgentsKit;
// A second agent that cannot take a message mid-turn, like a CLI without steering.
const rigid = new ScriptedAdapter({ id: 'rigid', displayName: 'Rigid agent', steering: false });
// And one that does not react to being stopped.
const stubborn = new ScriptedAdapter({ id: 'stubborn', displayName: 'Stubborn agent', ignoreCancel: true });

beforeAll(async () => {
  kit = await createAgentsKit({ adapters: [new ScriptedAdapter(), rigid, stubborn], agents: { stopGraceMs: 150 } });
});
afterAll(async () => {
  await kit.close();
});

const userTexts = (events: SessionEvent[]): string[] =>
  events.filter((event) => event.type === 'message.user').map((event) => (event.data as { text: string }).text);
const queueOf = async (sessionId: string): Promise<QueuedMessage[]> =>
  (await kit.owner.get<{ queue: QueuedMessage[] }>(`/api/sessions/${sessionId}/queue`)).body.queue;

describe('stopping a run', () => {
  it('ends the run exactly once and keeps what it had produced', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ text: 'A finished paragraph.' }, { text: 'An unfinished sen', chunks: 2, complete: false }, { hang: true }]);
    const sent = await kit.send(owner, session.id, 'write a lot');
    await until(async () => (await kit.state(owner, session.id)).streaming.length === 1);

    const stopped = await owner.post<{ run: Run }>(`/api/sessions/${session.id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.run).toMatchObject({ id: sent.body.runId, status: 'stopped', error: null });
    expect(agent.lastRun.cancelled).toBe(true);
    expect(agent.lastRun.request.signal.aborted).toBe(true);

    const events = await kit.events(owner, session.id);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'stopped' } });
    const answers = events.filter((event) => event.type === 'message.assistant').map((event) => event.data);
    expect(answers).toEqual([expect.objectContaining({ text: 'A finished paragraph.', partial: false }), expect.objectContaining({ text: 'An unfinished sen', partial: true })]);
    expect(await kit.state(owner, session.id)).toMatchObject({ run: null, streaming: [] });

    // The session is idle again and takes a new message.
    expect((await kit.turn(owner, session.id, 'carry on')).status).toBe('completed');
  });

  it('produces one terminal event when stop races the agent finishing, and when stop is pressed twice', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ gate: 'race' }]);
    const sent = await kit.send(owner, session.id, 'race me');
    await agent.reached('race');
    agent.open('race');
    const [a, b] = await Promise.all([owner.post(`/api/sessions/${session.id}/stop`), owner.post(`/api/sessions/${session.id}/stop`)]);
    expect([a.status, b.status].every((status) => status === 200 || status === 409)).toBe(true);
    await kit.runEnded(owner, sent.body.runId!);
    const events = await kit.events(owner, session.id);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
  });

  it('can be stopped before the agent has even been started', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const before = agent.runs.length;
    agent.script([{ text: 'should never be said' }]);
    // Over HTTP the agent is started before a stop could arrive, so this goes through the service:
    // the stop lands between the receipt and the launch.
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const receipt = await agents.sendMessage(principal, session.id, { requestId: nextRequestId(), text: 'changed my mind' });
    expect(receipt.run).toMatchObject({ status: 'accepted' });
    const stopped = await agents.stop(principal, session.id);
    expect(stopped).toMatchObject({ id: receipt.runId, status: 'stopped' });
    const events = await kit.events(owner, session.id);
    expect(events.map((event) => event.type)).toEqual(['message.user', 'run.started', 'run.finished']);
    expect(agent.runs.length).toBe(before);
    // The script that was lined up is used by the next run instead.
    expect((await kit.turn(owner, session.id, 'now really')).status).toBe('completed');
    expect((await kit.events(owner, session.id)).at(-2)).toMatchObject({ data: { text: 'should never be said' } });
  });

  it('refuses to stop a session that is not running', async () => {
    const session = await kit.session();
    const response = await kit.owner.post(`/api/sessions/${session.id}/stop`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'no_active_run' } });
  });

  it('ends the run even when the agent will not wind down, and ignores what it says afterwards', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: stubborn.id });
    stubborn.script([{ text: 'before' }, { gate: 'deaf' }, { text: 'said after the stop' }]);
    const sent = await kit.send(owner, session.id, 'you cannot stop me');
    await stubborn.reached('deaf');
    const stopped = await owner.post<{ run: Run }>(`/api/sessions/${session.id}/stop`);
    expect(stopped.body.run).toMatchObject({ id: sent.body.runId, status: 'stopped' });
    // The agent carries on regardless; nothing it emits is recorded any more.
    stubborn.open('deaf');
    await until(() => stubborn.lastRun.finished);
    const events = await kit.events(owner, session.id);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('said after the stop');
    expect((await owner.get<Run>(`/api/runs/${sent.body.runId}`)).body.status).toBe('stopped');
  });
});

describe('the queue', () => {
  it('holds messages sent during a run and sends them in order, one turn each', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ gate: 'first-turn' }, { text: 'first done' }]);
    const first = await kit.send(owner, session.id, 'first');
    await rigid.reached('first-turn');

    const queued: MessageReceipt[] = [];
    for (const text of ['second', 'third', 'fourth']) {
      const receipt = await kit.send(owner, session.id, text);
      expect(receipt.status).toBe(202);
      expect(receipt.body).toMatchObject({ disposition: 'queued', runId: null, run: null });
      queued.push(receipt.body);
    }
    expect((await queueOf(session.id)).map((item) => item.text)).toEqual(['second', 'third', 'fourth']);
    expect((await kit.state(owner, session.id)).queue.map((item) => item.id)).toEqual(queued.map((receipt) => receipt.queueItemId));
    // Nothing has gone out yet.
    expect(userTexts(await kit.events(owner, session.id))).toEqual(['first']);

    rigid.open('first-turn');
    await until(async () => (await queueOf(session.id)).length === 0 && (await kit.state(owner, session.id)).run === null && rigid.runs.length >= 4, { what: 'the queue to drain' });
    await kit.idle(owner, session.id);

    const events = await kit.events(owner, session.id);
    expect(userTexts(events)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(events.filter((event) => event.type === 'message.user').map((event) => (event.data as { origin: string }).origin)).toEqual(['interactive', 'queued', 'queued', 'queued']);
    // One run per message, strictly one after another.
    const brackets = events.filter((event) => ['message.user', 'run.started', 'run.finished'].includes(event.type)).map((event) => event.type);
    expect(brackets).toEqual(Array.from({ length: 4 }, () => ['message.user', 'run.started', 'run.finished']).flat());
    // The receipt of a queued message now names the run that sent it.
    const receipt = await owner.get<MessageReceipt>(`/api/sessions/${session.id}/messages/${queued[0]!.requestId}`);
    expect(receipt.body).toMatchObject({ disposition: 'run', queueItemId: null, run: { status: 'completed', origin: 'queued' } });
    expect(receipt.body.runId).not.toBe(first.body.runId);
  });

  it('drains with no client connected, and tells watchers when it takes an item', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    const live = await kit.connect(owner);
    await live.subscribe(sessionTopic(session.id));
    rigid.script([{ gate: 'unattended-drain' }]);
    await kit.send(owner, session.id, 'now');
    await rigid.reached('unattended-drain');
    const later = await kit.send(owner, session.id, 'later');
    await kit.send(owner, session.id, 'last');
    const changes = () => live.events(sessionTopic(session.id)).filter((frame) => frame.type === 'queue.changed').map((frame) => frame.data as { queue: QueuedMessage[]; taken: { itemId: string } | null });
    await until(() => changes().length === 2);
    expect(changes().map((change) => change.queue.length)).toEqual([1, 2]);
    live.close();
    await until(() => kit.t.studio.context.realtime.connectionCount === 0);

    rigid.open('unattended-drain');
    await until(async () => userTexts(await kit.events(owner, session.id)).length === 3, { what: 'both queued messages to be sent' });
    await kit.idle(owner, session.id);
    expect(userTexts(await kit.events(owner, session.id))).toEqual(['now', 'later', 'last']);
    expect(await queueOf(session.id)).toEqual([]);
    expect((await owner.get<MessageReceipt>(`/api/sessions/${session.id}/messages/${later.body.requestId}`)).body.run).toMatchObject({ status: 'completed' });
  });

  it('lets a queued message be edited and removed until it is sent', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ gate: 'editing' }]);
    await kit.send(owner, session.id, 'running');
    await rigid.reached('editing');
    const a = (await kit.send(owner, session.id, 'draft a')).body;
    const b = (await kit.send(owner, session.id, 'draft b')).body;
    const c = (await kit.send(owner, session.id, 'draft c')).body;

    const edited = await owner.patch<QueuedMessage>(`/api/sessions/${session.id}/queue/${a.queueItemId}`, { text: 'final a' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: a.queueItemId, text: 'final a' });
    expect((await owner.delete(`/api/sessions/${session.id}/queue/${b.queueItemId}`)).status).toBe(204);
    expect((await queueOf(session.id)).map((item) => item.text)).toEqual(['final a', 'draft c']);
    // A removed message was withdrawn: its receipt is gone, and it is never sent.
    expect((await owner.get(`/api/sessions/${session.id}/messages/${b.requestId}`)).status).toBe(404);
    expect((await owner.patch(`/api/sessions/${session.id}/queue/${a.queueItemId}`, { text: '  ' })).status).toBe(400);

    rigid.open('editing');
    await until(async () => userTexts(await kit.events(owner, session.id)).length === 3);
    await kit.idle(owner, session.id);
    expect(userTexts(await kit.events(owner, session.id))).toEqual(['running', 'final a', 'draft c']);

    // Once it has gone out it can no longer be changed.
    const tooLate = await owner.patch(`/api/sessions/${session.id}/queue/${c.queueItemId}`, { text: 'changed my mind' });
    expect(tooLate.status).toBe(409);
    expect(tooLate.body).toMatchObject({ error: { code: 'not_queued' } });
    expect((await owner.delete(`/api/sessions/${session.id}/queue/${c.queueItemId}`)).body).toMatchObject({ error: { code: 'not_queued' } });
  });

  it('"send now" stops a turn that cannot be steered and sends that message first', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ text: 'working on the old thing', complete: false }, { hang: true }]);
    const running = await kit.send(owner, session.id, 'old thing');
    await until(async () => (await kit.state(owner, session.id)).streaming.length === 1);
    await kit.send(owner, session.id, 'can wait');
    const urgent = (await kit.send(owner, session.id, 'urgent')).body;

    const now = await owner.post<SendNowResponse>(`/api/sessions/${session.id}/queue/${urgent.queueItemId}/send-now`);
    expect(now.status).toBe(200);
    expect(now.body.outcome).toBe('interrupted');
    expect((await owner.get<Run>(`/api/runs/${running.body.runId}`)).body.status).toBe('stopped');
    await until(async () => userTexts(await kit.events(owner, session.id)).length === 3);
    await kit.idle(owner, session.id);
    expect(userTexts(await kit.events(owner, session.id))).toEqual(['old thing', 'urgent', 'can wait']);
    expect((await owner.get<Run>(`/api/runs/${now.body.runId}`)).body).toMatchObject({ text: 'urgent', origin: 'queued' });
  });

  it('"send now" on an idle session sends at once, even past a failed run', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ gate: 'will-fail' }, { fail: { code: 'boom', message: 'It broke.' } }]);
    const failing = await kit.send(owner, session.id, 'break');
    await rigid.reached('will-fail');
    const waiting = (await kit.send(owner, session.id, 'after the failure')).body;
    rigid.open('will-fail');
    expect((await kit.runEnded(owner, failing.body.runId!)).status).toBe('failed');

    // A failed run needs the person first: the queue does not push on by itself.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await queueOf(session.id)).map((item) => item.text)).toEqual(['after the failure']);
    expect(await kit.state(owner, session.id)).toMatchObject({ run: null, unresolvedRuns: [{ id: failing.body.runId, status: 'failed' }] });

    const now = await owner.post<SendNowResponse>(`/api/sessions/${session.id}/queue/${waiting.queueItemId}/send-now`);
    expect(now.body.outcome).toBe('next');
    expect((await kit.runEnded(owner, now.body.runId!)).status).toBe('completed');
    expect(userTexts(await kit.events(owner, session.id))).toEqual(['break', 'after the failure']);
  });

  it('resumes by itself once a failed run is dismissed', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ gate: 'fail-then-dismiss' }, { fail: { code: 'boom', message: 'It broke.' } }]);
    const failing = await kit.send(owner, session.id, 'break');
    await rigid.reached('fail-then-dismiss');
    await kit.send(owner, session.id, 'queued behind the failure');
    rigid.open('fail-then-dismiss');
    await kit.runEnded(owner, failing.body.runId!);
    expect((await owner.post(`/api/runs/${failing.body.runId}/dismiss`)).body).toMatchObject({ alreadyHandled: false });
    await until(async () => userTexts(await kit.events(owner, session.id)).length === 2, { what: 'the queue to resume' });
    await kit.idle(owner, session.id);
  });

  it('refuses a 21st queued message', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ hang: true }]);
    await kit.send(owner, session.id, 'busy');
    await until(async () => (await kit.state(owner, session.id)).run?.status === 'running');
    for (let index = 1; index <= 20; index += 1) expect((await kit.send(owner, session.id, `queued ${index}`)).status).toBe(202);
    const overflow = await kit.send(owner, session.id, 'one too many');
    expect(overflow.status).toBe(409);
    expect(overflow.body).toMatchObject({ error: { code: 'queue_full' } });
    expect(await queueOf(session.id)).toHaveLength(20);
    // Tidy up: remove the queue, then stop the run.
    for (const item of await queueOf(session.id)) await owner.delete(`/api/sessions/${session.id}/queue/${item.id}`);
    await owner.post(`/api/sessions/${session.id}/stop`);
  });
});

describe('steering', () => {
  it('injects a message into the running turn and records it where the turn took it', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ text: 'starting' }, { gate: 'steerable' }, { awaitSteer: true }, { text: 'finished' }]);
    const running = await kit.send(owner, session.id, 'do the thing');
    await agent.reached('steerable');

    const steered = await kit.send(owner, session.id, 'also update the README', { whenBusy: 'steer' });
    expect(steered.status).toBe(202);
    expect(steered.body).toMatchObject({ disposition: 'steered', runId: running.body.runId, queueItemId: null });
    expect(agent.lastRun.steered).toEqual(['also update the README']);
    agent.open('steerable');
    await kit.runEnded(owner, running.body.runId!);

    const events = await kit.events(owner, session.id);
    expect(events.map((event) => event.type)).toEqual(['message.user', 'run.started', 'message.assistant', 'message.user', 'message.assistant', 'message.assistant', 'run.finished']);
    expect(events[3]).toMatchObject({ data: { origin: 'steer', text: 'also update the README', runId: running.body.runId } });
    expect(events[4]).toMatchObject({ data: { text: 'steered: also update the README' } });
    // Exactly once: one run, no queue, and a repeat of the request changes nothing.
    expect(agent.runs.filter((run) => run.request.sessionId === session.id)).toHaveLength(1);
    expect(await queueOf(session.id)).toEqual([]);
    const repeat = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, { requestId: steered.body.requestId, text: 'also update the README', whenBusy: 'steer' });
    expect(repeat.body).toMatchObject({ duplicate: true, disposition: 'steered' });
    expect(userTexts(await kit.events(owner, session.id))).toEqual(['do the thing', 'also update the README']);
  });

  it('queues the message when the turn cannot take it, so it is neither lost nor sent twice', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.acceptSteer = false;
    agent.script([{ gate: 'too-late' }, { text: 'ending' }]);
    const running = await kit.send(owner, session.id, 'almost done');
    await agent.reached('too-late');
    const missed = await kit.send(owner, session.id, 'one more thing', { whenBusy: 'steer' });
    expect(missed.body).toMatchObject({ disposition: 'queued', runId: null });
    agent.acceptSteer = true;
    agent.open('too-late');
    await kit.runEnded(owner, running.body.runId!);
    await until(async () => userTexts(await kit.events(owner, session.id)).length === 2);
    await kit.idle(owner, session.id);
    const events = await kit.events(owner, session.id);
    expect(userTexts(events)).toEqual(['almost done', 'one more thing']);
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(2);
    expect(agent.runs.at(-1)!.request.prompt.text).toBe('one more thing');
  });

  it('queues instead of steering an agent that cannot be steered', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: rigid.id });
    rigid.script([{ gate: 'no-steer' }]);
    const running = await kit.send(owner, session.id, 'go');
    await rigid.reached('no-steer');
    const attempt = await kit.send(owner, session.id, 'steer please', { whenBusy: 'steer' });
    expect(attempt.body.disposition).toBe('queued');
    rigid.open('no-steer');
    await kit.runEnded(owner, running.body.runId!);
    await until(async () => userTexts(await kit.events(owner, session.id)).length === 2);
    await kit.idle(owner, session.id);
  });

  it('"send now" steers a queued message into a turn that can take it', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    agent.script([{ gate: 'send-now-steer' }, { awaitSteer: true }]);
    const running = await kit.send(owner, session.id, 'long job');
    await agent.reached('send-now-steer');
    const queued = (await kit.send(owner, session.id, 'by the way')).body;
    expect(queued.disposition).toBe('queued');
    const now = await owner.post<SendNowResponse>(`/api/sessions/${session.id}/queue/${queued.queueItemId}/send-now`);
    expect(now.body).toEqual({ outcome: 'steered', runId: running.body.runId });
    expect(await queueOf(session.id)).toEqual([]);
    agent.open('send-now-steer');
    await kit.runEnded(owner, running.body.runId!);
    const events = await kit.events(owner, session.id);
    expect(events.filter((event) => event.type === 'message.user').map((event) => (event.data as { origin: string }).origin)).toEqual(['interactive', 'steer']);
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
    expect((await owner.get<MessageReceipt>(`/api/sessions/${session.id}/messages/${queued.requestId}`)).body).toMatchObject({ disposition: 'steered', runId: running.body.runId });
    void nextRequestId;
  });
});
