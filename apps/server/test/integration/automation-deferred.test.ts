import type { Approval, DeferredMessage, Inbox, Run, Session } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type AutomationWorld, createAutomationWorlds, deferredOf } from '../../src/modules/automation/testing/world.js';
import { until } from '../../src/modules/inbox/testing/kit.js';
import { bash, device, idle, notifications, pending } from '../../src/modules/inbox/testing/world.js';
import type { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createAutomationWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const NOW = '2026-10-13T12:00:00Z';
const AT_18 = '2026-10-13T18:00:00Z';
const HOUR = 60 * 60 * 1000;

const defer = (client: TestClient, body: Record<string, unknown>) => client.post<DeferredMessage>('/api/deferred-messages', body);
const one = async (client: TestClient, sessionId: string, id: string): Promise<DeferredMessage> => (await deferredOf(client, `?sessionId=${sessionId}`)).find((entry) => entry.id === id)!;
const errorCode = (body: unknown): string => (body as { error: { code: string } }).error.code;

/** Waits for a deferred message to reach a state. */
const reaches = (client: TestClient, sessionId: string, id: string, state: DeferredMessage['state']): Promise<DeferredMessage> =>
  until(
    async () => {
      const message = await one(client, sessionId, id);
      return message.state === state ? message : null;
    },
    { what: `the deferred message to be ${state}` },
  );

async function restart(before: AutomationWorld, at: string, agent = new ScriptedAdapter()): Promise<AutomationWorld> {
  await before.kit.t.studio.stop();
  before.time.set(at);
  const after = await start({ kit: { restartOf: before.kit, adapters: [agent] }, push: before.push, clock: before.clock, time: before.time });
  await after.kit.listen();
  return after;
}

describe('sending a message later', () => {
  it('is sent at its time — once, with nobody connected — as the session\'s next turn, with what the composer had selected', async () => {
    const world = await start({ at: NOW });
    const { kit, time } = world;
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Evening work' });
    const created = await defer(owner, { sessionId: session.id, text: '  Run the full test suite and summarise the failures.  ', sendAt: AT_18, model: 'scripted-small', permissionMode: 'accept-edits' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      sessionId: session.id,
      projectId: kit.project.id,
      text: 'Run the full test suite and summarise the failures.',
      sendAt: Date.parse(AT_18),
      state: 'pending',
      queued: false,
      reason: null,
      detail: null,
      options: { model: 'scripted-small', effort: null, permissionMode: 'accept-edits' },
      runId: null,
      dismissed: false,
    });
    // Listed for its session, and among everything of the caller's that still waits.
    expect(await deferredOf(owner, `?sessionId=${session.id}`)).toEqual([created.body]);
    expect(await deferredOf(owner)).toEqual([created.body]);
    expect(await deferredOf(owner, `?projectId=${kit.project.id}&state=pending`)).toEqual([created.body]);
    expect(await deferredOf(owner, '?state=sent')).toEqual([]);
    expect(kit.userEvents(owner.userId, 'deferred.changed').map((event) => event.data)).toEqual([{ id: created.body.id, sessionId: session.id, state: 'pending' }]);

    // Before its time nothing happens.
    time.set('2026-10-13T17:59:59Z');
    expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
    expect(kit.agent.runs).toHaveLength(0);

    // At its time: two passes at once, and more afterwards — the agent receives it once.
    kit.agent.script([{ gate: 'evening' }, { text: 'Three tests fail.' }]);
    time.set(AT_18);
    const passes = await Promise.all([world.tick(), world.tick()]);
    expect(passes.map((pass) => pass.deferred).sort()).toEqual([0, 1]);
    await kit.agent.reached('evening');
    expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
    expect(kit.agent.runs).toHaveLength(1);

    const running = await one(owner, session.id, created.body.id);
    expect(running).toMatchObject({ state: 'in-progress', queued: false, runId: expect.any(String) });
    expect(await deferredOf(owner)).toEqual([]);
    expect(await deferredOf(owner, '?state=in-progress')).toHaveLength(1);
    // It runs like a message typed at that moment: with the options captured when it was scheduled.
    expect(kit.agent.lastRun.request).toMatchObject({ sessionId: session.id, userId: owner.userId, origin: 'scheduled', model: 'scripted-small', permissionMode: 'accept-edits' });
    expect(kit.agent.lastRun.request.prompt.text).toBe('Run the full test suite and summarise the failures.');
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body).toMatchObject({ activeRunId: running.runId, attention: 'running' });

    kit.agent.open('evening');
    await kit.runEnded(owner, running.runId!);
    expect(await reaches(owner, session.id, created.body.id, 'sent')).toMatchObject({ runId: running.runId, reason: null });
    expect(kit.userEvents(owner.userId, 'deferred.changed').map((event) => (event.data as { state: string }).state)).toEqual(['pending', 'in-progress', 'in-progress', 'sent']);

    // Sent means sent: later passes, and a restart, send nothing more.
    time.advance(HOUR);
    await world.tick();
    const after = await restart(world, '2026-10-13T20:00:00Z');
    await after.tick();
    expect(after.kit.agent.runs).toHaveLength(0);
    expect(kit.agent.runs).toHaveLength(1);
    expect((await one(after.kit.owner, session.id, created.body.id)).state).toBe('sent');
  });

  it('accepts an instant as milliseconds or as an ISO date-time with an offset, and one just gone is sent at the next pass', async () => {
    const world = await start({ at: NOW });
    const { kit } = world;
    const { owner } = kit;
    const session = await kit.session(owner);
    const iso = await defer(owner, { sessionId: session.id, text: 'iso', sendAt: '2026-10-13T20:00:00+02:00' });
    expect(iso.body.sendAt).toBe(Date.parse('2026-10-13T18:00:00Z'));
    const millis = await defer(owner, { sessionId: session.id, text: 'millis', sendAt: Date.parse(AT_18) + 1 });
    expect(millis.status).toBe(201);
    // A minute ago: accepted, and sent on the next pass.
    const past = await defer(owner, { sessionId: session.id, text: 'a minute late', sendAt: '2026-10-13T11:59:00Z' });
    expect(past.status).toBe(201);
    expect(await world.tick()).toEqual({ automations: 0, deferred: 1 });
    await reaches(owner, session.id, past.body.id, 'sent');
    expect(kit.agent.runs.map((run) => run.request.prompt.text)).toEqual(['a minute late']);
    expect((await one(owner, session.id, iso.body.id)).state).toBe('pending');
  });

  it('refuses what cannot be scheduled, each for its own reason', async () => {
    const world = await start({ at: NOW });
    const { kit } = world;
    const { owner } = kit;
    const member = await kit.t.member('other');
    await kit.share(kit.project, member);
    const session = await kit.session(owner);
    const theirs = await kit.session(member);
    const good = { sessionId: session.id, text: 'later', sendAt: AT_18 };
    const refused = async (client: TestClient, body: Record<string, unknown>) => {
      const response = await defer(client, body);
      const details = (response.body as unknown as { error: { details?: Array<{ path: string }> } }).error.details;
      return [response.status, errorCode(response.body), Array.isArray(details) ? details[0]?.path : undefined];
    };

    expect(await refused(owner, { ...good, text: '' })).toEqual([400, 'invalid_request', 'text']);
    expect(await refused(owner, { ...good, text: '   \n ' })).toEqual([400, 'invalid_request', 'text']);
    expect(await refused(owner, { ...good, text: 'x'.repeat(100_001) })).toEqual([400, 'invalid_request', 'text']);
    for (const sendAt of ['tomorrow at six', '2026-10-13 18:00', '2026-10-13T18:00:00', '', null, -5]) {
      expect(await refused(owner, { ...good, sendAt }), String(sendAt)).toEqual([400, 'invalid_request', 'sendAt']);
    }
    // 400 days ahead; exactly a year is still fine.
    expect(await refused(owner, { ...good, sendAt: Date.parse(NOW) + 400 * 24 * HOUR })).toEqual([400, 'send_time_too_far', undefined]);
    expect((await defer(owner, { ...good, sendAt: Date.parse(NOW) + 365 * 24 * HOUR })).status).toBe(201);
    // Further back than a late message would still be sent.
    expect(await refused(owner, { ...good, sendAt: Date.parse(NOW) - 7 * HOUR })).toEqual([400, 'send_time_passed', undefined]);
    expect(await refused(owner, { ...good, sessionId: '0'.repeat(26) })).toEqual([404, 'session_not_found', undefined]);
    // Somebody else's session — also for the owner, who may read it but not write into it.
    expect(await refused(owner, { ...good, sessionId: theirs.id })).toEqual([404, 'session_not_found', undefined]);
    expect(await refused(member, good)).toEqual([404, 'session_not_found', undefined]);
    expect(await refused(owner, { ...good, permissionMode: 'everything' })).toEqual([400, 'invalid_request', 'permissionMode']);
    expect(await refused(owner, { ...good, userId: member.userId })).toEqual([400, 'invalid_request', '']);
    expect((await defer(kit.t.anonymous(), good)).status).toBe(401);
    expect((await kit.t.anonymous().get('/api/deferred-messages')).status).toBe(401);

    // Where the project's automation switch is off, nothing is scheduled.
    const plain = await kit.makeProject('no-automation', { features: { automation: false } });
    const there = await kit.session(owner, { projectId: plain.id });
    expect(await refused(owner, { ...good, sessionId: there.id })).toEqual([409, 'automation_disabled', undefined]);
    // A member reduced to reading cannot schedule into their old session.
    await kit.share(kit.project, member, 'read');
    expect(await refused(member, { ...good, sessionId: theirs.id })).toEqual([403, 'project_read_only', undefined]);
    expect((await deferredOf(owner, '?state=pending')).map((entry) => entry.text)).toEqual(['later']);
  });

  it('keeps a bounded number waiting per user', async () => {
    const world = await start({ at: NOW });
    const { kit } = world;
    const session = await kit.session(kit.owner);
    for (let index = 0; index < 100; index += 1) {
      expect((await defer(kit.owner, { sessionId: session.id, text: `message ${index}`, sendAt: Date.parse(AT_18) + index })).status).toBe(201);
    }
    const extra = await defer(kit.owner, { sessionId: session.id, text: 'one too many', sendAt: AT_18 });
    expect(extra.status).toBe(409);
    expect(errorCode(extra.body)).toBe('too_many_deferred');
    expect(await deferredOf(kit.owner, '?limit=200')).toHaveLength(100);
  });
});

describe('cancelling and dismissing', () => {
  it('a waiting message can be cancelled and then never fires; one that was sent cannot', async () => {
    const world = await start({ at: NOW });
    const { kit, time } = world;
    const { owner } = kit;
    const member = await kit.t.member('nosy');
    await kit.share(kit.project, member);
    const session = await kit.session(owner);
    const cancelled = (await defer(owner, { sessionId: session.id, text: 'do not send me', sendAt: AT_18 })).body;
    const kept = (await defer(owner, { sessionId: session.id, text: 'send me', sendAt: AT_18 })).body;

    // Somebody else's message does not exist for you — the owner of the Studio included, the other way round.
    const theirSession = await kit.session(member);
    const members = (await defer(member, { sessionId: theirSession.id, text: "member's", sendAt: AT_18 })).body;
    for (const [client, id] of [[member, kept.id], [owner, members.id]] as const) {
      const answer = await client.post(`/api/deferred-messages/${id}/cancel`);
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual((await client.post(`/api/deferred-messages/${'0'.repeat(26)}/cancel`)).body);
      expect((await client.post(`/api/deferred-messages/${id}/dismiss`)).status).toBe(404);
    }
    expect(await deferredOf(member)).toEqual([members]);

    const done = await owner.post<DeferredMessage>(`/api/deferred-messages/${cancelled.id}/cancel`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'cancelled', runId: null });
    expect((await owner.post(`/api/deferred-messages/${cancelled.id}/cancel`)).status).toBe(409);

    time.set(AT_18);
    expect((await world.tick()).deferred).toBe(2);
    await reaches(owner, session.id, kept.id, 'sent');
    await reaches(member, theirSession.id, members.id, 'sent');
    expect(kit.agent.runs.map((run) => run.request.prompt.text).sort()).toEqual(["member's", 'send me']);
    expect((await one(owner, session.id, cancelled.id)).state).toBe('cancelled');

    // Already sent: refused.
    const late = await owner.post(`/api/deferred-messages/${kept.id}/cancel`);
    expect(late.status).toBe(409);
    expect(errorCode(late.body)).toBe('deferred_not_pending');
    // Only a failure can be dismissed.
    expect(errorCode((await owner.post(`/api/deferred-messages/${kept.id}/dismiss`)).body)).toBe('deferred_not_failed');
    expect((await owner.post('/api/deferred-messages/not-an-id/cancel')).status).toBe(400);
  });

  it('a failed message stays, with its reason, until it is dismissed — and then stays dismissed', async () => {
    const world = await start({ at: NOW });
    const { kit, time, push } = world;
    const { owner } = kit;
    const phone = await device(world, owner);
    const session = await kit.session(owner, { title: 'Will fail' });
    const created = (await defer(owner, { sessionId: session.id, text: 'deploy to production', sendAt: AT_18 })).body;
    kit.agent.script([{ fail: { code: 'not_signed_in', message: 'The agent is not signed in. token=abcdef0123456789' } }]);

    time.set(AT_18);
    expect((await world.tick()).deferred).toBe(1);
    const failed = await reaches(owner, session.id, created.id, 'failed');
    expect(failed).toMatchObject({ reason: 'run-failed', dismissed: false, runId: expect.any(String) });
    expect(failed.detail).toContain('The agent is not signed in.');
    expect(failed.detail).not.toContain('abcdef0123456789');
    // The failed run is in the inbox like any other, and the user is told once — by the inbox, about the session.
    await idle(world);
    expect((await owner.get<Inbox>('/api/inbox')).body.groups.needsHandling.map((item) => item.runId)).toEqual([failed.runId]);
    expect((await notifications(owner)).map((entry) => [entry.kind, entry.tag])).toEqual([['run-failed', `run-failed:${session.id}`]]);
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'Will fail', body: "Scripted agent's run failed" })]);

    // It is not sent again on later passes.
    for (let pass = 0; pass < 3; pass += 1) {
      time.advance(30_000);
      expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
    }
    expect(kit.agent.runs).toHaveLength(1);

    const dismissed = await owner.post<DeferredMessage>(`/api/deferred-messages/${created.id}/dismiss`);
    expect(dismissed.body).toMatchObject({ state: 'failed', dismissed: true });
    expect(await deferredOf(owner, `?sessionId=${session.id}`)).toEqual([]);
    expect(await deferredOf(owner, '?state=failed')).toEqual([]);
    // Again: fine. And it is still put away after a restart.
    expect((await owner.post(`/api/deferred-messages/${created.id}/dismiss`)).status).toBe(200);
    const after = await restart(world, '2026-10-13T19:00:00Z');
    expect(await deferredOf(after.kit.owner, `?sessionId=${session.id}`)).toEqual([]);
    await after.tick();
    expect(after.kit.agent.runs).toHaveLength(0);
  });
});

describe('when the session is busy at the due time', () => {
  it('the message waits in the session\'s queue — the running turn is not stopped — and runs next', async () => {
    const world = await start({ at: NOW });
    const { kit, time } = world;
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Busy' });
    const created = (await defer(owner, { sessionId: session.id, text: 'and then update the changelog', sendAt: AT_18 })).body;

    kit.agent.script([{ gate: 'long-turn' }, { text: 'first turn done' }]);
    const typed = await kit.send(owner, session.id, 'refactor the importer');
    await kit.agent.reached('long-turn');

    time.set(AT_18);
    expect((await world.tick()).deferred).toBe(1);
    // The turn in progress is untouched; the message is first in the session's queue.
    expect((await owner.get<Run>(`/api/runs/${typed.body.runId}`)).body.status).toBe('running');
    expect((await kit.state(owner, session.id)).queue.map((item) => item.text)).toEqual(['and then update the changelog']);
    expect(await one(owner, session.id, created.id)).toMatchObject({ state: 'in-progress', queued: true, runId: null });
    // Passes while it waits change nothing and send nothing twice.
    time.advance(30_000);
    expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
    expect(kit.agent.runs).toHaveLength(1);

    // The turn ends by itself, as "completed" — and the queued message becomes the next turn.
    kit.agent.open('long-turn');
    expect((await kit.runEnded(owner, typed.body.runId!)).status).toBe('completed');
    const sent = await reaches(owner, session.id, created.id, 'sent');
    expect(sent).toMatchObject({ queued: false, runId: expect.any(String) });
    expect(sent.runId).not.toBe(typed.body.runId);
    expect(kit.agent.runs.map((run) => run.request.prompt.text)).toEqual(['refactor the importer', 'and then update the changelog']);
    expect((await kit.state(owner, session.id)).queue).toEqual([]);
  });

  it('a message its author takes out of the queue is cancelled, not sent', async () => {
    const world = await start({ at: NOW });
    const { kit, time } = world;
    const { owner } = kit;
    const session = await kit.session(owner);
    const created = (await defer(owner, { sessionId: session.id, text: 'changed my mind', sendAt: AT_18 })).body;
    kit.agent.script([{ gate: 'busy' }, { text: 'done' }]);
    const typed = await kit.send(owner, session.id, 'first');
    await kit.agent.reached('busy');
    time.set(AT_18);
    await world.tick();
    const [item] = (await kit.state(owner, session.id)).queue;
    expect((await owner.delete(`/api/sessions/${session.id}/queue/${item!.id}`)).status).toBe(204);

    kit.agent.open('busy');
    await kit.runEnded(owner, typed.body.runId!);
    time.advance(30_000);
    await world.tick();
    expect(await one(owner, session.id, created.id)).toMatchObject({ state: 'cancelled', detail: 'The message was removed from the session’s queue.' });
    expect(kit.agent.runs).toHaveLength(1);
  });

  it('a full queue is a failure with a reason, and the author is told', async () => {
    const world = await start({ at: NOW });
    const { kit, time } = world;
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Full queue' });
    const created = (await defer(owner, { sessionId: session.id, text: 'no room for me', sendAt: AT_18 })).body;
    kit.agent.script([{ gate: 'stuck' }]);
    await kit.send(owner, session.id, 'first');
    await kit.agent.reached('stuck');
    for (let index = 0; index < 20; index += 1) expect((await kit.send(owner, session.id, `queued ${index}`)).body.disposition).toBe('queued');

    time.set(AT_18);
    await world.tick();
    expect(await one(owner, session.id, created.id)).toMatchObject({ state: 'failed', reason: 'queue-full', detail: 'The session was busy and its queue was full.', runId: null });
    expect(await notifications(owner)).toEqual([
      expect.objectContaining({ kind: 'run-failed', title: 'Full queue', body: 'A scheduled message could not be sent', detail: 'The session was busy and its queue was full.', sessionId: session.id, tag: `deferred:${created.id}` }),
    ]);
    // The turn in progress was left alone, and so were the twenty messages already waiting.
    expect((await kit.state(owner, session.id)).queue).toHaveLength(20);
    expect(kit.agent.runs).toHaveLength(1);
  });
});

describe('a deferred message has the session\'s ordinary permissions', () => {
  it('waits for approval like a message typed by hand, and the author is notified', async () => {
    const world = await start({ at: NOW });
    const { kit, time, push } = world;
    const { owner } = kit;
    const phone = await device(world, owner);
    const session = await kit.session(owner, { title: 'Needs a yes' });
    const created = (await defer(owner, { sessionId: session.id, text: 'publish the package', sendAt: AT_18 })).body;
    kit.agent.script([{ permission: bash('npm publish') }, { text: 'published' }]);

    time.set(AT_18);
    await world.tick();
    // Not denied because nobody is there: put up for approval, exactly as it would be for a typed message.
    const approval: Approval = await pending(kit, owner, session.id);
    expect(approval).toMatchObject({ status: 'pending', command: 'npm publish' });
    expect(kit.agent.lastRun.decisions).toEqual([]);
    await idle(world);
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'Needs a yes', body: 'Scripted agent needs your approval to use Bash' })]);
    expect((await owner.get<Inbox>('/api/inbox')).body.groups.approvals).toHaveLength(1);
    expect((await one(owner, session.id, created.id)).state).toBe('in-progress');

    expect((await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' })).status).toBe(200);
    await reaches(owner, session.id, created.id, 'sent');
    expect(kit.agent.lastRun.decisions).toEqual([expect.objectContaining({ behavior: 'allow', source: 'user' })]);
  });
});

describe('what can go wrong before it is sent', () => {
  it('the session was deleted: failed with a reason, and the author is told', async () => {
    const world = await start({ at: NOW });
    const { kit, time, push } = world;
    const { owner } = kit;
    const phone = await device(world, owner);
    const session = await kit.session(owner, { title: 'Short-lived' });
    const created = (await defer(owner, { sessionId: session.id, text: 'too late', sendAt: AT_18 })).body;
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(204);

    time.set(AT_18);
    expect((await world.tick()).deferred).toBe(1);
    await idle(world);
    const [failed] = await deferredOf(owner, '?state=failed');
    expect(failed).toMatchObject({ id: created.id, state: 'failed', reason: 'session-gone', detail: 'The session no longer exists.', runId: null });
    expect(kit.agent.runs).toHaveLength(0);
    // There is no run and no session to show it in, so this notification is the only way the author learns of it.
    expect(await notifications(owner)).toEqual([expect.objectContaining({ kind: 'run-failed', title: 'demo', body: 'A scheduled message could not be sent', detail: 'The session no longer exists.', link: '/' })]);
    expect(push.payloads(phone)).toEqual([{ title: 'demo', body: 'A scheduled message could not be sent', tag: `deferred:${created.id}`, url: '/' }]);
    // Not tried again.
    time.advance(60_000);
    expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
  });

  it('the switch was turned off, or the author lost write access, in the meantime: failed with that reason', async () => {
    const world = await start({ at: NOW });
    const { kit, time } = world;
    const { owner } = kit;
    const member = await kit.t.member('demoted');
    await kit.share(kit.project, member);
    const second = await kit.makeProject('second');
    const inSecond = await kit.session(owner, { title: 'Second', projectId: second.id });
    const members = await kit.session(member, { title: "Member's" });
    const switchedOff = (await defer(owner, { sessionId: inSecond.id, text: 'a', sendAt: AT_18 })).body;
    const noAccess = (await defer(member, { sessionId: members.id, text: 'b', sendAt: AT_18 })).body;

    await owner.patch(`/api/projects/${second.id}`, { features: { automation: false } });
    await kit.share(kit.project, member, 'read');
    time.set(AT_18);
    expect((await world.tick()).deferred).toBe(2);
    expect(await one(owner, inSecond.id, switchedOff.id)).toMatchObject({ state: 'failed', reason: 'automation-off', detail: 'Scheduled work is switched off for this project.' });
    expect(await one(member, members.id, noAccess.id)).toMatchObject({ state: 'failed', reason: 'access-lost', detail: 'You no longer have write access to the project.' });
    expect(kit.agent.runs).toHaveLength(0);
    expect((await notifications(member)).map((entry) => entry.body)).toEqual(['A scheduled message could not be sent']);
  });
});

describe('across a restart', () => {
  it('a message that came due while the server was down is sent once, on the first pass after it is back', async () => {
    const before = await start({ at: NOW });
    const session = await before.kit.session(before.kit.owner, { title: 'Overnight' });
    const created = (await defer(before.kit.owner, { sessionId: session.id, text: 'run the nightly import', sendAt: AT_18 })).body;

    // Down from a minute before until ten minutes after its time.
    before.time.set('2026-10-13T17:59:00Z');
    const agent = new ScriptedAdapter();
    const after = await restart(before, '2026-10-13T18:10:00Z', agent);
    expect(agent.runs).toHaveLength(0);
    expect((await after.tick()).deferred).toBe(1);
    expect((await after.tick()).deferred).toBe(0);
    await reaches(after.kit.owner, session.id, created.id, 'sent');
    expect(agent.runs.map((run) => run.request.prompt.text)).toEqual(['run the nightly import']);
    expect(before.kit.agent.runs).toHaveLength(0);
  });

  it('back later than the grace window: not sent, recorded as missed, and the author is told', async () => {
    const before = await start({ at: NOW });
    const session = await before.kit.session(before.kit.owner, { title: 'Too late' });
    const created = (await defer(before.kit.owner, { sessionId: session.id, text: 'at six sharp', sendAt: AT_18 })).body;
    const agent = new ScriptedAdapter();
    const after = await restart(before, '2026-10-14T00:00:01Z', agent);
    expect((await after.tick()).deferred).toBe(1);
    expect(await one(after.kit.owner, session.id, created.id)).toMatchObject({ state: 'failed', reason: 'missed', detail: 'The server was not running at the time, and came back too late.' });
    expect(agent.runs).toHaveLength(0);
    expect(await notifications(after.kit.owner)).toEqual([expect.objectContaining({ kind: 'run-failed', body: 'A scheduled message could not be sent', sessionId: null, link: '/' })]);
  });

  it('a restart while its turn is running: failed as "restarted during execution", in the inbox, one notice, and the agent is not invoked again', async () => {
    const before = await start({ at: NOW });
    const { owner } = before.kit;
    const phone = await device(before, owner);
    const session = await before.kit.session(owner, { title: 'Cut short' });
    const created = (await defer(owner, { sessionId: session.id, text: 'migrate the database', sendAt: AT_18 })).body;
    before.kit.agent.script([{ hang: true }]);
    before.time.set(AT_18);
    await before.tick();
    const running = await until(async () => {
      const message = await one(owner, session.id, created.id);
      return message.runId ? message : null;
    });
    await until(async () => (await owner.get<Run>(`/api/runs/${running.runId}`)).body.status === 'running');

    const agent = new ScriptedAdapter();
    const after = await restart(before, '2026-10-13T18:05:00Z', agent);
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    await idle(after);
    expect(await one(after.kit.owner, session.id, created.id)).toMatchObject({
      state: 'failed',
      reason: 'interrupted',
      detail: 'The server restarted during execution — review before continuing.',
      runId: running.runId,
    });
    expect(agent.runs).toHaveLength(0);
    expect((await after.kit.owner.get<Inbox>('/api/inbox')).body.groups.needsHandling).toEqual([expect.objectContaining({ runId: running.runId, interruptedByRestart: true })]);
    expect(before.push.payloads(phone).map((payload) => payload.tag)).toEqual([`run-interrupted:${session.id}`]);
  });

  it('a crash between the claim and the send: the message was never sent, and is not sent afterwards', async () => {
    const before = await start({ at: NOW });
    const { owner } = before.kit;
    const session = await before.kit.session(owner, { title: 'Claimed' });
    const created = (await defer(owner, { sessionId: session.id, text: 'half-claimed', sendAt: AT_18 })).body;
    // The claim, as a pass makes it — and then the process is gone.
    before.kit.t.studio.context.db.run("UPDATE deferred_messages SET state = 'sending' WHERE id = ?", created.id);

    const agent = new ScriptedAdapter();
    const after = await restart(before, '2026-10-13T18:00:30Z', agent);
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    expect(await one(after.kit.owner, session.id, created.id)).toMatchObject({
      state: 'failed',
      reason: 'interrupted',
      detail: 'The server stopped before this message could be sent. It was not sent.',
      runId: null,
    });
    expect(agent.runs).toHaveLength(0);
    expect((await notifications(after.kit.owner)).map((entry) => entry.body)).toEqual(['A scheduled message could not be sent']);
  });

  it('a message that was waiting in a session\'s queue is still followed after a restart', async () => {
    const before = await start({ at: NOW });
    const { owner } = before.kit;
    const session = await before.kit.session(owner, { title: 'Queued across a restart' });
    const created = (await defer(owner, { sessionId: session.id, text: 'after the long turn', sendAt: AT_18 })).body;
    before.kit.agent.script([{ hang: true }]);
    const typed = await before.kit.send(owner, session.id, 'a long turn');
    await until(async () => (await owner.get<Run>(`/api/runs/${typed.body.runId}`)).body.status === 'running');
    before.time.set(AT_18);
    await before.tick();
    expect(await one(owner, session.id, created.id)).toMatchObject({ state: 'in-progress', queued: true });

    const agent = new ScriptedAdapter();
    const after = await restart(before, '2026-10-13T18:05:00Z', agent);
    // The long turn was cut short; the runtime holds the queue until that is dealt with. Nothing is sent meanwhile.
    await after.tick();
    expect(await one(after.kit.owner, session.id, created.id)).toMatchObject({ state: 'in-progress', queued: true });
    expect(agent.runs).toHaveLength(0);

    // The user puts the interrupted turn away in the session: the queue moves, and the record follows.
    expect((await after.kit.owner.post(`/api/runs/${typed.body.runId}/dismiss`)).status).toBe(200);
    await reaches(after.kit.owner, session.id, created.id, 'sent');
    expect(agent.runs.map((run) => run.request.prompt.text)).toEqual(['after the long turn']);
  });
});
