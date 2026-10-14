import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime, until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createProject,
  createSession,
  getRun,
  postMessage,
  runEnded,
  sandboxIsOn,
  SANDBOX_OFF,
  send,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
  type Receipt,
} from './support/workbench.js';

/**
 * 6.4 — Stop, steer and queue (requirements 01 §6.4, §5.7).
 *
 * Deliberate difference: a message sent to a busy session is queued on the
 * server by default (`whenBusy: 'queue'`); `'steer'` asks for it to be taken
 * into the running turn and falls back to the queue. The queue belongs to the
 * server: it drains in order with no browser connected.
 *
 * Not built: edit-and-resend (AT-WB-053/054) and background-work telemetry
 * (AT-WB-052).
 */

/** Resolves once the session has no run in progress and nothing queued. */
function settled(client: ApiClient, sessionId: string, timeout = 40_000): Promise<true> {
  return until(
    async () => {
      const session = (await client.get<Json>(`/api/sessions/${sessionId}`)).body;
      if (session.activeRunId !== null) return undefined;
      const queue = (await client.get<{ queue: unknown[] }>(`/api/sessions/${sessionId}/queue`))
        .body.queue;
      return queue.length === 0 ? true : undefined;
    },
    { timeout, what: `session ${sessionId} to be idle with an empty queue` },
  );
}

const userTurns = async (client: ApiClient, sessionId: string) =>
  (await transcript(client, sessionId))
    .filter((event) => event.type === 'message.user')
    .map((event) => ({
      text: event.data.text as string,
      origin: event.data.origin as string,
      runId: event.data.runId as string,
    }));

describe('6.4 stop, steer, queue', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'queue');
  });
  afterAll(() => studio?.destroy());

  for (const agentId of ['claude-code', 'codex']) {
    it(`AT-WB-043 (${agentId}): stopping mid-run ends the run exactly once as stopped, keeps the partial text, and leaves the session idle and usable`, async (context) => {
      if (agentId === 'codex' && !(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
      const session = await createSession(owner, project.id, agentId);
      const topic = `session:${session.id}`;
      const live = await Realtime.open(studio, owner);
      await live.subscribe(topic);
      await live.subscribe(`user:${owner.userId}`);
      const receipt = await send(owner, session.id, 'keep talking [[scenario:long 200]]');
      await live.event(topic, 'message.delta');
      await live.event(topic, 'message.delta', { from: live.mark() }); // some output is on screen

      const stopped = await owner.post<{ run: Json }>(`/api/sessions/${session.id}/stop`);
      expect(stopped.status).toBe(200);
      expect(stopped.body.run).toMatchObject({ id: receipt.runId, status: 'stopped' });
      const finished = await live.event(topic, 'run.finished');
      expect(finished.data).toMatchObject({
        runId: receipt.runId,
        status: 'stopped',
        error: null,
        interruptedByRestart: false,
      });

      // A second stop finds nothing to stop, and no second terminal event appears.
      const again = await owner.post<ErrorBody>(`/api/sessions/${session.id}/stop`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('no_active_run');

      const events = await transcript(owner, session.id);
      expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
      expect(events.at(-1)!.type).toBe('run.finished');
      const text = events.filter((event) => event.type === 'message.assistant');
      expect(text).toHaveLength(1);
      expect(text[0]!.data.partial).toBe(true);
      expect(text[0]!.data.text.length).toBeGreaterThan(0);
      // What was streamed before the stop is what was kept.
      const streamed = live
        .events(topic)
        .filter((frame) => frame.type === 'message.delta')
        .map((frame) => frame.data.text as string)
        .join('');
      expect(
        streamed.startsWith(text[0]!.data.text) || text[0]!.data.text.startsWith(streamed),
      ).toBe(true);

      const after = (await owner.get<Json>(`/api/sessions/${session.id}`)).body;
      expect(after.activeRunId).toBeNull();
      expect(after.attention).toBe('none'); // the person who stopped it has seen it
      await live.event(`user:${owner.userId}`, 'run.finished', {
        where: (frame) => frame.data.runId === receipt.runId && frame.data.status === 'stopped',
      });
      expect(live.events(topic).filter((frame) => frame.type === 'run.finished')).toHaveLength(1);

      // Idle: the next message starts a run at once.
      const next = await send(owner, session.id, 'and now something short');
      expect(next.disposition).toBe('run');
      expect((await runEnded(owner, next.runId!)).status).toBe('completed');
      await live.close();
    });
  }

  it('AT-WB-044: a stop for an idle session is refused and nothing changes', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'quick');
    await runEnded(owner, run.runId!);
    const before = await transcript(owner, session.id);
    const refused = await owner.post<ErrorBody>(`/api/sessions/${session.id}/stop`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('no_active_run');
    expect(await transcript(owner, session.id)).toEqual(before);
    expect((await getRun(owner, run.runId!)).status).toBe('completed');
  });

  it('AT-WB-046: a message steered into a running turn is taken by that turn, appears in the transcript once at that point, and is answered', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const first = await send(owner, session.id, 'start [[scenario:steerable]]');
    await live.event(topic, 'tool.started'); // the agent is at work and will make further calls
    const steer = await postMessage(owner, session.id, 'also update the README', {
      whenBusy: 'steer',
    });
    expect(steer.status).toBe(202);
    expect(steer.body).toMatchObject({
      disposition: 'steered',
      runId: first.runId,
      queueItemId: null,
    });
    const run = await runEnded(owner, first.runId!);
    expect(run.status).toBe('completed');

    const turns = await userTurns(owner, session.id);
    expect(turns).toEqual([
      { text: 'start [[scenario:steerable]]', origin: 'interactive', runId: first.runId },
      { text: 'also update the README', origin: 'steer', runId: first.runId },
    ]);
    const events = await transcript(owner, session.id);
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === 'message.assistant' &&
          event.data.text === 'Steered: also update the README',
      ),
    ).toBe(true);
    expect(
      (await owner.get<{ queue: unknown[] }>(`/api/sessions/${session.id}/queue`)).body.queue,
    ).toEqual([]);
    await live.close();
  });

  it('AT-WB-046 (Codex): the other agent takes a steered message the same way', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const session = await createSession(owner, project.id, 'codex');
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const first = await send(owner, session.id, 'start [[scenario:steerable]]');
    await live.event(topic, 'tool.started');
    const steer = await postMessage(owner, session.id, 'also update the README', {
      whenBusy: 'steer',
    });
    expect(steer.body).toMatchObject({ disposition: 'steered', runId: first.runId });
    await runEnded(owner, first.runId!);
    const turns = await userTurns(owner, session.id);
    expect(turns.filter((turn) => turn.text === 'also update the README')).toEqual([
      { text: 'also update the README', origin: 'steer', runId: first.runId },
    ]);
    expect(
      (await transcript(owner, session.id)).some(
        (event) =>
          event.type === 'message.assistant' &&
          event.data.text === 'You steered me: also update the README',
      ),
    ).toBe(true);
    await live.close();
  });

  it('AT-WB-047 (adapted): a steer the agent may not be able to take is never lost and never sent twice — it is taken or it becomes the next turn', async () => {
    const session = await createSession(owner, project.id);
    // Steered the instant the run exists, before the agent can possibly be listening.
    const first = await send(owner, session.id, 'start [[scenario:long 15]]');
    const steer = await postMessage(owner, session.id, 'do not lose me', { whenBusy: 'steer' });
    expect(steer.status).toBe(202);
    expect(['steered', 'queued']).toContain(steer.body.disposition);
    await settled(owner, session.id);
    const turns = await userTurns(owner, session.id);
    const mine = turns.filter((turn) => turn.text === 'do not lose me');
    expect(mine).toHaveLength(1);
    if (steer.body.disposition === 'queued') {
      expect(mine[0]!.origin).toBe('queued');
      expect(mine[0]!.runId).not.toBe(first.runId); // a turn of its own, after the one that could not take it
    } else {
      expect(mine[0]).toMatchObject({ origin: 'steer', runId: first.runId });
    }
    // Whichever way it went, the receipt now names the run that carries it.
    const receipt = await owner.get<Receipt>(
      `/api/sessions/${session.id}/messages/${steer.body.requestId}`,
    );
    expect(receipt.body.runId).toBe(mine[0]!.runId);
    expect(receipt.body.queueItemId).toBeNull();
  });

  it('AT-WB-048 (adapted): three messages sent during a run are queued 1–3 and, when it ends, sent in that order, one turn each', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const first = await send(owner, session.id, 'busy [[scenario:long 40]]');
    const queued: Receipt[] = [];
    for (const text of ['one', 'two', 'three']) queued.push(await send(owner, session.id, text));
    for (const receipt of queued)
      expect(receipt).toMatchObject({ disposition: 'queued', runId: null, run: null });
    expect(queued.every((receipt) => typeof receipt.queueItemId === 'string')).toBe(true);

    const listed = await owner.get<{ queue: Array<{ id: string; text: string }> }>(
      `/api/sessions/${session.id}/queue`,
    );
    expect(listed.body.queue.map((item) => item.text)).toEqual(['one', 'two', 'three']);
    expect(listed.body.queue.map((item) => item.id)).toEqual(
      queued.map((receipt) => receipt.queueItemId),
    );
    // Every device watching the session is told the queue as it changes.
    const announced = await live.event(topic, 'queue.changed', {
      where: (frame) => frame.data.queue.length === 3,
    });
    expect(announced.data.queue.map((item: Json) => item.text)).toEqual(['one', 'two', 'three']);
    expect(announced.seq).toBeUndefined();

    await settled(owner, session.id);
    const turns = await userTurns(owner, session.id);
    expect(turns.map((turn) => `${turn.origin}:${turn.text}`)).toEqual([
      'interactive:busy [[scenario:long 40]]',
      'queued:one',
      'queued:two',
      'queued:three',
    ]);
    expect(new Set(turns.map((turn) => turn.runId)).size).toBe(4); // one turn each
    const events = await transcript(owner, session.id);
    expect(
      events.filter((event) => event.type === 'run.finished').map((event) => event.data.status),
    ).toEqual(['completed', 'completed', 'completed', 'completed']);
    // Runs never overlap: each starts after the one before it has finished.
    const order = events
      .filter((event) => event.type === 'run.started' || event.type === 'run.finished')
      .map((event) => event.type);
    expect(order).toEqual([
      'run.started',
      'run.finished',
      'run.started',
      'run.finished',
      'run.started',
      'run.finished',
      'run.started',
      'run.finished',
    ]);
    // A queued message's receipt now names the run it became.
    const receipt = await owner.get<Receipt>(
      `/api/sessions/${session.id}/messages/${queued[1]!.requestId}`,
    );
    expect(receipt.body).toMatchObject({
      disposition: 'run',
      runId: turns[2]!.runId,
      queueItemId: null,
    });
    // The server announced each take.
    const taken = live
      .events(topic)
      .filter((frame) => frame.type === 'queue.changed' && frame.data.taken !== null);
    expect(taken.map((frame) => frame.data.taken.itemId)).toEqual(
      queued.map((item) => item.queueItemId),
    );
    expect(first.disposition).toBe('run');
    await live.close();
  });

  it('AT-WB-049: with no client connected at all the server still sends the queued messages in order; a later visit shows both turns', async () => {
    const session = await createSession(owner, project.id);
    await send(owner, session.id, 'busy [[scenario:long 30]]');
    await send(owner, session.id, 'queued alpha');
    await send(owner, session.id, 'queued beta');
    // No WebSocket was ever opened for this session; only the server drives the queue.
    await settled(owner, session.id);
    const later = await studio.owner(); // "reconnecting later", from a fresh sign-in
    const turns = await userTurns(later, session.id);
    expect(turns.map((turn) => turn.text)).toEqual([
      'busy [[scenario:long 30]]',
      'queued alpha',
      'queued beta',
    ]);
    const events = await transcript(later, session.id);
    expect(
      events.filter((event) => event.type === 'run.finished' && event.data.status === 'completed'),
    ).toHaveLength(3);
    expect(
      events.filter((event) => event.type === 'message.assistant').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('WB-055: a queued message can be edited or removed while it waits — the edit is what is sent, the removed one never is', async () => {
    const session = await createSession(owner, project.id);
    await send(owner, session.id, 'busy [[scenario:long 40]]');
    const keep = await send(owner, session.id, 'draft wording');
    const drop = await send(owner, session.id, 'never send this');
    const tablet = await studio.owner(); // the queue is the server's: another device edits it
    const edited = await tablet.patch<Json>(
      `/api/sessions/${session.id}/queue/${keep.queueItemId}`,
      { text: 'final wording' },
    );
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: keep.queueItemId, text: 'final wording' });
    expect(
      (await tablet.patch(`/api/sessions/${session.id}/queue/${keep.queueItemId}`, { text: '   ' }))
        .status,
    ).toBe(400);
    expect(
      (await tablet.delete(`/api/sessions/${session.id}/queue/${drop.queueItemId}`)).status,
    ).toBe(204);
    // The removed message is as if it had never been accepted.
    expect((await owner.get(`/api/sessions/${session.id}/messages/${drop.requestId}`)).status).toBe(
      404,
    );
    expect(
      (
        await owner.get<{ queue: Array<{ text: string }> }>(`/api/sessions/${session.id}/queue`)
      ).body.queue.map((item) => item.text),
    ).toEqual(['final wording']);

    await settled(owner, session.id);
    const turns = await userTurns(owner, session.id);
    expect(turns.map((turn) => turn.text)).toEqual(['busy [[scenario:long 40]]', 'final wording']);
    expect(JSON.stringify(await transcript(owner, session.id))).not.toContain('never send this');

    // AT-WB-051 (second half): saving an edit to a message that has just been sent fails with "may already have been sent".
    const late = await owner.patch<ErrorBody>(
      `/api/sessions/${session.id}/queue/${keep.queueItemId}`,
      { text: 'too late' },
    );
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('not_queued');
    expect(late.body.error.message).toContain('may already have been sent');
    expect(
      (await owner.delete<ErrorBody>(`/api/sessions/${session.id}/queue/${keep.queueItemId}`)).body
        .error.code,
    ).toBe('not_queued');
  });

  it('AT-WB-050 (adapted): "send now" on a queued message puts it ahead of the others — here the running turn takes it at once', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const first = await send(owner, session.id, 'busy [[scenario:long 50]]');
    await live.event(topic, 'message.delta');
    const a = await send(owner, session.id, 'queued a');
    const b = await send(owner, session.id, 'queued b');
    const now = await owner.post<{ outcome: string; runId: string | null }>(
      `/api/sessions/${session.id}/queue/${b.queueItemId}/send-now`,
    );
    expect(now.status).toBe(200);
    // Both stand-in agents can take a message mid-turn, so the outcome is "steered";
    // an agent that cannot would be stopped ("interrupted") and the message sent as the next turn.
    expect(now.body).toEqual({ outcome: 'steered', runId: first.runId });
    await settled(owner, session.id);
    const turns = await userTurns(owner, session.id);
    expect(turns.map((turn) => `${turn.origin}:${turn.text}`)).toEqual([
      'interactive:busy [[scenario:long 50]]',
      'steer:queued b',
      'queued:queued a',
    ]);
    expect(turns[1]!.runId).toBe(first.runId);
    expect(a.queueItemId).not.toBe(b.queueItemId);
    // Send-now on something no longer queued is refused.
    expect(
      (await owner.post<ErrorBody>(`/api/sessions/${session.id}/queue/${b.queueItemId}/send-now`))
        .body.error.code,
    ).toBe('not_queued');
    await live.close();
  });

  it('AT-WB-051: the queue holds twenty messages; the twenty-first is refused as full and nothing of it is kept', async () => {
    const session = await createSession(owner, project.id);
    const first = await send(owner, session.id, 'busy [[scenario:long 400]]');
    const queued: Receipt[] = [];
    for (let index = 1; index <= 20; index += 1)
      queued.push(await send(owner, session.id, `waiting ${index}`));
    const overflow = await postMessage(owner, session.id, 'one too many');
    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('queue_full');
    const queue = (
      await owner.get<{ queue: Array<{ text: string }> }>(`/api/sessions/${session.id}/queue`)
    ).body.queue;
    expect(queue).toHaveLength(20);
    expect(queue.map((item) => item.text)).not.toContain('one too many');
    // Removing one makes room again.
    expect(
      (await owner.delete(`/api/sessions/${session.id}/queue/${queued[0]!.queueItemId}`)).status,
    ).toBe(204);
    const retry = await postMessage(owner, session.id, 'one too many');
    expect(retry.status).toBe(202);
    // Tidy up: empty the queue, then stop the run.
    for (const item of (
      await owner.get<{ queue: Array<{ id: string }> }>(`/api/sessions/${session.id}/queue`)
    ).body.queue) {
      expect((await owner.delete(`/api/sessions/${session.id}/queue/${item.id}`)).status).toBe(204);
    }
    expect((await owner.post(`/api/sessions/${session.id}/stop`)).status).toBe(200);
    expect((await runEnded(owner, first.runId!)).status).toBe('stopped');
    await settled(owner, session.id);
    expect((await userTurns(owner, session.id)).map((turn) => turn.text)).toEqual([
      'busy [[scenario:long 400]]',
    ]);
  });

  it('WB-055 (this product): the queue waits behind a failed run until someone has dealt with it, then drains', async () => {
    const session = await createSession(owner, project.id);
    const failing = await send(
      owner,
      session.id,
      'this will fail [[scenario:long 20]] [[scenario:crash]]',
    );
    const waiting = await send(owner, session.id, 'after the failure');
    expect(waiting.disposition).toBe('queued');
    expect((await runEnded(owner, failing.runId!)).status).toBe('failed');
    // The failure is on record as unresolved, and the queued message has not been sent past it.
    const state = (await owner.get<Json>(`/api/sessions/${session.id}/state`)).body;
    expect(state.unresolvedRuns.map((run: Json) => run.id)).toEqual([failing.runId]);
    expect(state.queue.map((item: Json) => item.text)).toEqual(['after the failure']);
    expect(state.run).toBeNull();
    expect((await userTurns(owner, session.id)).map((turn) => turn.text)).toEqual([
      'this will fail [[scenario:long 20]] [[scenario:crash]]',
    ]);

    const dismissed = await owner.post<{ alreadyHandled: boolean }>(
      `/api/runs/${failing.runId}/dismiss`,
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.alreadyHandled).toBe(false);
    await settled(owner, session.id);
    expect(
      (await userTurns(owner, session.id)).map((turn) => `${turn.origin}:${turn.text}`),
    ).toEqual([
      'interactive:this will fail [[scenario:long 20]] [[scenario:crash]]',
      'queued:after the failure',
    ]);
  });
});
