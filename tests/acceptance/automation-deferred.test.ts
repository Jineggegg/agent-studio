import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  createSession,
  runEnded,
  send,
  shareProject,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
  type Receipt,
  type Session,
} from './support/workbench.js';

/**
 * 6.2 — Messages to send later (requirements 04 §6.2 AT-AUT-025…034; 01
 * §6.14 AT-WB-136/137).
 *
 * A deferred message is sent by the server at its time, with no browser
 * connected, exactly once — also when the server was down at that moment.
 * Deliberate difference: when the session is busy at that time the message is
 * queued behind the running turn; the turn is not stopped (AT-AUT-028).
 *
 * The server looks for due messages a few seconds after it starts and then
 * every half minute, so the scene is set right after start-up and the tests
 * wait, with a deadline, for the first pass.
 */
const PASS = 50_000; // a little more than one scheduler pass

describe('6.2 messages sent later', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let idle: Session;
  let busy: Session;
  let busyRun: Receipt;
  let dueSoon: Json;
  let dueWhileBusy: Json;
  let farAhead: Json;

  const later = (
    client: ApiClient,
    sessionId: string,
    text: string,
    sendAt: number | string,
    extra: Record<string, unknown> = {},
  ) => client.post<Json>('/api/deferred-messages', { sessionId, text, sendAt, ...extra });
  const ofSession = async (client: ApiClient, sessionId: string) =>
    (await client.get<{ messages: Json[] }>(`/api/deferred-messages?sessionId=${sessionId}`)).body
      .messages;
  const reread = async (client: ApiClient, sessionId: string, id: string) =>
    (await ofSession(client, sessionId)).find((message) => message.id === id);
  const settledAs = (client: ApiClient, sessionId: string, id: string, states: string[]) =>
    until(
      async () => {
        const message = await reread(client, sessionId, id);
        return message && states.includes(message.state) ? message : undefined;
      },
      { timeout: PASS, interval: 250, what: `the deferred message to be ${states.join(' or ')}` },
    );
  const userTurns = async (client: ApiClient, sessionId: string) =>
    (await transcript(client, sessionId))
      .filter((event) => event.type === 'message.user')
      .map((event) => event.data);

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'Later', { features: { automation: true } });
    idle = await createSession(owner, project.id);
    busy = await createSession(owner, project.id);
    busyRun = await send(owner, busy.id, 'a long turn [[scenario:long 350]]');
    const soon = Date.now() + 1500;
    const [first, second, third] = await Promise.all([
      later(owner, idle.id, 'sent while nobody was looking', soon),
      later(owner, busy.id, 'sent after the long turn', soon),
      later(owner, idle.id, 'far in the future', Date.now() + 6 * 60 * 60 * 1000),
    ]);
    for (const response of [first, second, third])
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    dueSoon = first.body;
    dueWhileBusy = second.body;
    farAhead = third.body;
  });
  afterAll(() => studio?.destroy());

  it('AUT-22: a message to send later is stored, pending, with its time — and listed for its session', async () => {
    expect(dueSoon).toMatchObject({
      sessionId: idle.id,
      projectId: project.id,
      text: 'sent while nobody was looking',
      dismissed: false,
      runId: null,
    });
    expect(farAhead).toMatchObject({ state: 'pending', queued: false, reason: null });
    expect(farAhead.sendAt).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
    expect((await ofSession(owner, idle.id)).map((message) => message.id).sort()).toEqual(
      [dueSoon.id, farAhead.id].sort(),
    );
    // An instant can be written as a date and time with its offset.
    const written = await later(owner, idle.id, 'written as a date', '2031-05-06T07:08:00+08:00');
    expect(written.status).toBe(400); // more than a year ahead: see the limits below
    const iso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const accepted = await later(owner, idle.id, 'written as a date', iso);
    expect(accepted.status).toBe(201);
    expect(accepted.body.sendAt).toBe(Date.parse(iso));
    expect((await owner.post(`/api/deferred-messages/${accepted.body.id}/cancel`)).status).toBe(
      200,
    );
  });

  it('AT-WB-136 / AT-AUT-026 (adapted): with no browser connected, a due message is sent exactly once and is marked sent when its turn completes', async () => {
    const sent = await settledAs(owner, idle.id, dueSoon.id, ['sent', 'failed']);
    expect(sent).toMatchObject({ state: 'sent', reason: null });
    expect(sent.runId).toMatch(/^[0-9a-z]{26}$/);
    const run = await runEnded(owner, sent.runId);
    expect(run).toMatchObject({
      status: 'completed',
      origin: 'scheduled',
      text: 'sent while nobody was looking',
    });
    const turns = await userTurns(owner, idle.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      origin: 'scheduled',
      text: 'sent while nobody was looking',
      runId: sent.runId,
    });
    // The one far ahead has not gone out with it.
    expect((await reread(owner, idle.id, farAhead.id))!.state).toBe('pending');
  });

  it('AT-AUT-028 (adapted): a message that comes due while a turn is running waits behind that turn — the turn is not stopped — and is sent when it ends', async () => {
    // The long turn was running when the message came due.
    const mine = await settledAs(owner, busy.id, dueWhileBusy.id, ['sent', 'failed']);
    expect(mine.state).toBe('sent');
    const first = await runEnded(owner, busyRun.runId!);
    expect(first.status).toBe('completed'); // completed, not stopped or interrupted
    const events = await transcript(owner, busy.id);
    expect(
      events.filter((event) => event.type === 'run.finished').map((event) => event.data.status),
    ).toEqual(['completed', 'completed']);
    const turns = events
      .filter((event) => event.type === 'message.user')
      .map((event) => `${event.data.origin}: ${event.data.text}`);
    expect(turns).toEqual([
      'interactive: a long turn [[scenario:long 350]]',
      'queued: sent after the long turn',
    ]);
    // The long turn's whole answer is there: nothing of it was cut.
    expect(events.find((event) => event.type === 'message.assistant')!.data).toMatchObject({
      partial: false,
    });
    expect(events.find((event) => event.type === 'message.assistant')!.data.text).toContain(
      'tick 350',
    );
  });

  it('AT-AUT-034 / AT-WB-137: a message with no text, no real time, a time more than a year ahead or long past, or for a session that does not exist, is refused — each with its own reason', async () => {
    const before = (await ofSession(owner, idle.id)).length;
    const year = 365 * 24 * 60 * 60 * 1000;
    const reasons: string[] = [];
    for (const [what, body] of [
      ['no text', { sessionId: idle.id, text: '   ', sendAt: Date.now() + 60_000 }],
      ['not a time', { sessionId: idle.id, text: 'hello', sendAt: 'next tuesday' }],
      ['no offset', { sessionId: idle.id, text: 'hello', sendAt: '2027-03-04T05:06:00' }],
      [
        '400 days ahead',
        { sessionId: idle.id, text: 'hello', sendAt: Date.now() + year + 35 * 24 * 60 * 60 * 1000 },
      ],
      [
        'yesterday',
        { sessionId: idle.id, text: 'hello', sendAt: Date.now() - 24 * 60 * 60 * 1000 },
      ],
      [
        'unknown session',
        { sessionId: '0123456789abcdefghjkmnpqrs', text: 'hello', sendAt: Date.now() + 60_000 },
      ],
      [
        'an extra field',
        { sessionId: idle.id, text: 'hello', sendAt: Date.now() + 60_000, userId: owner.userId },
      ],
    ] as const) {
      const refused = await owner.post<ErrorBody>('/api/deferred-messages', body);
      expect(refused.status, what).toBeGreaterThanOrEqual(400);
      expect(refused.status, what).toBeLessThan(500);
      reasons.push(`${what}: ${refused.body.error.code}`);
    }
    expect(reasons).toEqual(
      expect.arrayContaining([
        '400 days ahead: send_time_too_far',
        'yesterday: send_time_passed',
        'unknown session: session_not_found',
      ]),
    );
    expect((await ofSession(owner, idle.id)).length).toBe(before);
  });

  it('AT-AUT-025 (adapted): a message cannot be scheduled into someone else’s session, nor in a project whose automations are off', async () => {
    const member = await createMember(studio, owner, 'latermember');
    await shareProject(owner, project.id, member.userId!, 'write');
    const foreign = await later(member, idle.id, 'into the owner’s session', Date.now() + 60_000);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('session_not_found');

    const plain = await createProject(studio, owner, 'No unattended work');
    const there = await createSession(owner, plain.id);
    const off = await later(owner, there.id, 'when automations are off', Date.now() + 60_000);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('automation_disabled');
    expect(await ofSession(owner, there.id)).toEqual([]);
    expect(
      (
        await studio.client().post('/api/deferred-messages', {
          sessionId: idle.id,
          text: 'anonymous',
          sendAt: Date.now() + 60_000,
        })
      ).status,
    ).toBe(401);
  });

  it('AT-AUT-032: a pending message its author cancels never fires; a sent one cannot be cancelled; nobody else can cancel it — not even the owner', async () => {
    const member = await createMember(studio, owner, 'latercanceller');
    await shareProject(owner, project.id, member.userId!, 'write');
    const theirs = await createSession(member, project.id);
    const pending = (
      await later(member, theirs.id, 'the member’s own', Date.now() + 3 * 60 * 60 * 1000)
    ).body;
    // Somebody else — another member, or the instance owner — gets "not found" and it stays pending.
    for (const other of [owner]) {
      const refused = await other.post<ErrorBody>(`/api/deferred-messages/${pending.id}/cancel`);
      expect(refused.status).toBe(404);
    }
    expect((await reread(member, theirs.id, pending.id))!.state).toBe('pending');
    expect(
      (await owner.get<{ messages: Json[] }>('/api/deferred-messages')).body.messages.map(
        (message) => message.id,
      ),
    ).not.toContain(pending.id);

    const cancelled = await member.post<Json>(`/api/deferred-messages/${pending.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((await reread(member, theirs.id, pending.id))!.state).toBe('cancelled');
    const again = await member.post<ErrorBody>(`/api/deferred-messages/${pending.id}/cancel`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('deferred_not_pending');

    await settledAs(owner, idle.id, dueSoon.id, ['sent']);
    const sent = await owner.post<ErrorBody>(`/api/deferred-messages/${dueSoon.id}/cancel`);
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe('deferred_not_pending');
    // Only a failed one can be dismissed.
    const dismiss = await owner.post<ErrorBody>(`/api/deferred-messages/${dueSoon.id}/dismiss`);
    expect(dismiss.status).toBe(409);
    expect(dismiss.body.error.code).toBe('deferred_not_failed');
    expect(await userTurns(member, theirs.id)).toEqual([]);
  });

  describe('across a restart', () => {
    let afterRestart: Session;
    let failing: Session;
    let due: Json;
    let dueAndFailing: Json;
    let cancelledBefore: Json;

    beforeAll(async () => {
      afterRestart = await createSession(owner, project.id);
      failing = await createSession(owner, project.id);
      const soon = Date.now() + 1200;
      due = (await later(owner, afterRestart.id, 'due while the server was down', soon)).body;
      dueAndFailing = (
        await later(owner, failing.id, 'due, and the agent fails [[scenario:crash]]', soon)
      ).body;
      cancelledBefore = (await later(owner, afterRestart.id, 'cancelled before the restart', soon))
        .body;
      expect((await owner.post(`/api/deferred-messages/${cancelledBefore.id}/cancel`)).status).toBe(
        200,
      );
      await studio.stop();
      // The moment passes while nothing is running.
      await until(() => Date.now() > soon + 300, { what: 'the due time to pass' });
      await studio.restart();
    });

    it('AT-AUT-026: a message that came due while the service was stopped is sent exactly once after it starts', async () => {
      const sent = await settledAs(owner, afterRestart.id, due.id, ['sent', 'failed']);
      expect(sent.state).toBe('sent');
      const turns = await userTurns(owner, afterRestart.id);
      expect(turns.map((turn) => `${turn.origin}: ${turn.text}`)).toEqual([
        'scheduled: due while the server was down',
      ]);
      // A cancelled message stays cancelled; the one far ahead is still waiting.
      expect((await reread(owner, afterRestart.id, cancelledBefore.id))!.state).toBe('cancelled');
      expect((await reread(owner, idle.id, farAhead.id))!.state).toBe('pending');
      // One more pass later it has still been sent once.
      const runs = (
        await owner.get<{ runs: Json[] }>(`/api/runs?state=all&sessionId=${afterRestart.id}`)
      ).body.runs;
      expect(runs).toHaveLength(1);
    });

    it('AT-AUT-029/033: a deferred message whose agent fails is recorded as failed with the reason, is not sent again, is reported to its author — and can then be dismissed', async () => {
      const failed = await settledAs(owner, failing.id, dueAndFailing.id, ['failed', 'sent']);
      expect(failed).toMatchObject({ state: 'failed', reason: 'run-failed' });
      expect(failed.detail.length).toBeGreaterThan(5);
      expect(failed.detail).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
      expect(await userTurns(owner, failing.id)).toHaveLength(1);
      expect(
        (
          await owner.get<{ runs: Json[] }>(`/api/runs?state=all&sessionId=${failing.id}`)
        ).body.runs.map((run) => run.status),
      ).toEqual(['failed']);
      // It needs handling: the failed run is in the inbox, and its author was told.
      const box = (await owner.get<Json>('/api/inbox')).body;
      expect(box.groups.needsHandling.map((item: Json) => item.sessionId)).toContain(failing.id);
      const told = await until(
        async () =>
          (
            await owner.get<{ notifications: Json[] }>('/api/notifications?order=newest')
          ).body.notifications.find(
            (item) => item.kind === 'run-failed' && item.sessionId === failing.id,
          ),
        {
          what: 'the failure to be reported',
        },
      );
      expect(told.body.length).toBeGreaterThan(5);

      const dismissed = await owner.post<Json>(
        `/api/deferred-messages/${dueAndFailing.id}/dismiss`,
      );
      expect(dismissed.status).toBe(200);
      expect((await ofSession(owner, failing.id)).map((message) => message.id)).not.toContain(
        dueAndFailing.id,
      ); // and it stays gone after a reload
      expect(await userTurns(owner, failing.id)).toHaveLength(1);
    });
  });
});
