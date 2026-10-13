import type { Inbox, Run, RunAutomationResponse, Session, SessionEvent } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type AutomationWorld, agentRun, automation, createAutomationWorlds, getAutomation, historyOf } from '../../src/modules/automation/testing/world.js';
import { until } from '../../src/modules/inbox/testing/kit.js';
import { bash, device, idle, notifications } from '../../src/modules/inbox/testing/world.js';
import type { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createAutomationWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const DUE = '2026-10-14T08:00:05Z';
const PROMPT = 'Check the dependencies and report.';

/** Waits until the automation's newest execution has ended, and returns it. */
async function ended(world: AutomationWorld, client: TestClient, projectId: string, id: string) {
  return until(
    async () => {
      const last = (await getAutomation(client, projectId, id)).lastRun;
      return last && last.endedAt !== null ? last : null;
    },
    { what: 'the execution to end' },
  );
}

const sessionEvents = async (client: TestClient, sessionId: string): Promise<SessionEvent[]> =>
  (await client.get<{ events: SessionEvent[] }>(`/api/sessions/${sessionId}/events?after=0&limit=1000`)).body.events;

describe('a scheduled agent run', () => {
  it('starts an unattended run as its creator in a new session, follows it to its end, and reports once', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time, push } = world;
    const { owner, project } = kit;
    const phone = await device(world, owner);
    const created = await automation(owner, project.id, agentRun({}, { model: 'scripted-small' }));
    kit.agent.script([{ gate: 'working' }, { text: 'All dependencies are current.' }]);

    time.set(DUE);
    expect(await world.tick()).toEqual({ automations: 1, deferred: 0 });
    await kit.agent.reached('working');

    // While it runs: the execution is open and says where.
    const running = await getAutomation(owner, project.id, created.id);
    expect(running).toMatchObject({ running: true, lastRun: { outcome: 'started', reason: null, endedAt: null, trigger: 'schedule', summary: 'Scripted agent is working in “Nightly check” (ask).' } });
    const { sessionId, runId } = running.lastRun!;
    expect(sessionId).not.toBeNull();
    expect(runId).not.toBeNull();

    // What the agent was handed: the prompt, the creator's identity, the chosen mode — and that nobody is watching.
    const request = kit.agent.lastRun.request;
    expect(request).toMatchObject({ runId, sessionId, userId: owner.userId, projectId: project.id, origin: 'automation', unattended: true, permissionMode: 'ask', model: 'scripted-small' });
    expect(request.prompt.text).toBe(PROMPT);
    const session = (await owner.get<Session>(`/api/sessions/${sessionId}`)).body;
    expect(session).toMatchObject({ userId: owner.userId, projectId: project.id, agentId: 'scripted', title: 'Nightly check', permissionMode: 'ask' });
    expect((await owner.get<Run>(`/api/runs/${runId}`)).body).toMatchObject({ origin: 'automation', unattended: true, status: 'running' });

    kit.agent.open('working');
    const last = await ended(world, owner, project.id, created.id);
    expect(last).toMatchObject({ outcome: 'completed', reason: null, summary: 'Scripted agent finished in “Nightly check”.', sessionId, runId });
    expect(await getAutomation(owner, project.id, created.id)).toMatchObject({ running: false, enabled: true });
    await idle(world);

    // One notification for the execution — the automation's own, under the "background work" switch — and no second one about the run.
    expect(await notifications(owner)).toEqual([
      expect.objectContaining({ kind: 'background-finished', title: 'demo', body: '“Nightly check” finished', link: `/projects/${project.id}/sessions/${sessionId}`, sessionId, runId, tag: `automation:${created.id}` }),
    ]);
    // On the lock screen: the project and the automation's name. Not the prompt, not the answer.
    expect(push.payloads(phone)).toEqual([{ title: 'demo', body: '“Nightly check” finished', tag: `automation:${created.id}`, url: `/projects/${project.id}/sessions/${sessionId}` }]);
    expect(JSON.stringify(push.payloads(phone))).not.toContain('dependencies');

    // The next day it runs again, in another new session.
    time.set('2026-10-15T08:00:05Z');
    expect((await world.tick()).automations).toBe(1);
    const second = await ended(world, owner, project.id, created.id);
    expect(second.sessionId).not.toBe(sessionId);
    expect((await historyOf(owner, project.id, created.id)).map((entry) => entry.outcome)).toEqual(['completed', 'completed']);
  });

  it('a member\'s automation acts as that member, never as whoever edits or runs it', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member('scheduler');
    await kit.share(project, member);
    const created = await automation(member, project.id, agentRun());
    expect(created.guard).toMatchObject({ actsAs: { id: member.userId, displayName: 'scheduler' }, allowed: true });

    // The owner changes the prompt and presses "run now".
    await owner.patch(`/api/projects/${project.id}/automations/${created.id}`, { action: { ...(created.action as object), prompt: 'Edited by the owner.' } });
    const ran = await owner.post<RunAutomationResponse>(`/api/projects/${project.id}/automations/${created.id}/run`);
    expect(ran.body.execution).toMatchObject({ trigger: 'manual', outcome: 'started' });
    const last = await ended(world, owner, project.id, created.id);
    expect(kit.agent.lastRun.request).toMatchObject({ userId: member.userId, unattended: true });
    expect(kit.agent.lastRun.request.prompt.text).toBe('Edited by the owner.');
    expect((await owner.get<Session>(`/api/sessions/${last.sessionId}`)).body.userId).toBe(member.userId);
    // The member is told; the owner, who only pressed the button, is not.
    expect((await notifications(member)).map((entry) => entry.body)).toEqual(['“Nightly check” finished']);
    expect(await notifications(owner)).toEqual([]);
  });

  it('into one fixed session: the prompt arrives there, and a busy session is skipped — never queued behind a person\'s turn', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const session = await kit.session(owner, { title: 'Standing report', permissionMode: 'plan' });
    const created = await automation(owner, project.id, agentRun({ trigger: { type: 'hourly', minute: 0 } }, { session: { type: 'existing', sessionId: session.id } }));

    time.set('2026-10-13T13:00:05Z');
    await world.tick();
    const first = await ended(world, owner, project.id, created.id);
    expect(first).toMatchObject({ outcome: 'completed', sessionId: session.id, summary: 'Scripted agent finished in “Standing report”.' });
    expect(kit.agent.lastRun.request).toMatchObject({ sessionId: session.id, unattended: true, permissionMode: 'ask' });
    // The run's mode is the automation's; it is now what the session shows.
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body.permissionMode).toBe('ask');

    // An hour later the user is in the middle of a turn in that session.
    kit.agent.script([{ gate: 'person-working' }, { text: 'done by hand' }]);
    const typed = await kit.send(owner, session.id, 'I am working here myself');
    await kit.agent.reached('person-working');
    time.set('2026-10-13T14:00:05Z');
    expect((await world.tick()).automations).toBe(1);
    const skipped = (await getAutomation(owner, project.id, created.id)).lastRun;
    expect(skipped).toMatchObject({ outcome: 'skipped', reason: 'session-busy', summary: 'Skipped: the session “Standing report” was busy with another turn.', runId: null });
    // Nothing waits in the session's queue: a queued message would later run as an ordinary turn, without the guard rails.
    expect((await kit.state(owner, session.id)).queue).toEqual([]);
    kit.agent.open('person-working');
    await kit.runEnded(owner, typed.body.runId!);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(kit.agent.runs).toHaveLength(2);
  });
});

describe('guard rails: what an unattended run may do', () => {
  it('ask mode: what would need approval is denied — never waited for — and the outcome says so', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time, push } = world;
    const { owner, project } = kit;
    const phone = await device(world, owner);
    const created = await automation(owner, project.id, agentRun());
    kit.agent.script([
      { permission: { toolName: 'Read', kind: 'read', input: {}, paths: ['package.json'] } },
      { permission: bash('npm audit fix --force') },
      { permission: { toolName: 'Edit', kind: 'edit', input: { file_path: 'package.json' }, paths: ['package.json'] } },
      { text: 'I could only look.' },
    ]);

    time.set(DUE);
    await world.tick();
    const last = await ended(world, owner, project.id, created.id);
    // The read ran; the command and the edit were refused by the engine because nobody was there.
    expect(kit.agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([
      ['allow', 'mode'],
      ['deny', 'unattended'],
      ['deny', 'unattended'],
    ]);
    expect(last).toMatchObject({
      outcome: 'denied',
      reason: 'approval-needed',
      summary: 'Scripted agent finished in “Nightly check”, but 2 actions needed approval and were denied because nobody was there to give it.',
    });
    // Nothing was ever put up for approval: there is nothing to approve after the fact.
    expect((await owner.get<{ approvals: unknown[] }>('/api/approvals?status=all')).body.approvals).toEqual([]);
    expect((await owner.get<Inbox>('/api/inbox')).body.counts.approvals).toBe(0);
    const events = await sessionEvents(owner, last.sessionId!);
    expect(events.filter((event) => event.type === 'approval.requested')).toEqual([]);
    expect(events.filter((event) => event.type === 'notice').map((event) => (event.data as { code: string }).code)).toEqual(['approval_skipped', 'approval_skipped']);

    // The creator is told that it did not go through, under the "failure" switch.
    await idle(world);
    expect(await notifications(owner)).toEqual([
      expect.objectContaining({ kind: 'run-failed', title: 'demo', body: '“Nightly check” finished, but some actions were denied', detail: expect.stringContaining('2 actions needed approval'), sessionId: last.sessionId }),
    ]);
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'demo', body: '“Nightly check” finished, but some actions were denied' })]);
    expect(JSON.stringify(push.payloads(phone))).not.toContain('npm audit');
  });

  it('plan mode: reads only — everything else is refused by the mode itself', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const created = await automation(owner, project.id, agentRun({}, { permissionMode: 'plan' }));
    expect(created.guard).toMatchObject({ permissionMode: 'plan', behaviour: 'read-only', allowed: true });
    kit.agent.script([
      { permission: { toolName: 'Read', kind: 'read', input: {}, paths: ['README.md'] } },
      { permission: { toolName: 'Edit', kind: 'edit', input: { file_path: 'README.md' }, paths: ['README.md'] } },
      { permission: bash('npm test') },
      { text: 'Here is what I would change.' },
    ]);
    time.set(DUE);
    await world.tick();
    const last = await ended(world, owner, project.id, created.id);
    expect(kit.agent.lastRun.request.permissionMode).toBe('plan');
    expect(kit.agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([
      ['allow', 'mode'],
      ['deny', 'mode'],
      ['deny', 'mode'],
    ]);
    // It did what plan mode is for.
    expect(last).toMatchObject({ outcome: 'completed', reason: null });
  });

  it('the modes that change things run only while the project\'s owner has auto mode enabled', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true });
    const created = await automation(owner, project.id, agentRun({ name: 'Auto-fix' }, { permissionMode: 'auto' }));
    kit.agent.script([{ permission: bash('npm run lint -- --fix') }, { text: 'fixed' }]);

    time.set(DUE);
    await world.tick();
    expect(await ended(world, owner, project.id, created.id)).toMatchObject({ outcome: 'completed' });
    expect(kit.agent.lastRun.request.permissionMode).toBe('auto');
    expect(kit.agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([['allow', 'mode']]);

    // The owner takes auto mode back. The automation is not quietly run in a weaker mode: it is refused, on the record.
    await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: false });
    expect((await getAutomation(owner, project.id, created.id)).guard).toMatchObject({ allowed: false, refusal: 'mode-not-allowed' });
    time.set('2026-10-15T08:00:05Z');
    expect((await world.tick()).automations).toBe(1);
    const refused = (await getAutomation(owner, project.id, created.id)).lastRun;
    expect(refused).toMatchObject({
      outcome: 'denied',
      reason: 'mode-not-allowed',
      summary: 'Not run: the mode “auto” needs auto mode, which the project’s owner has not enabled.',
      sessionId: null,
      runId: null,
      endedAt: expect.any(Number),
    });
    expect(kit.agent.runs).toHaveLength(1);
    // The creator has something to fix, so they are told.
    expect((await notifications(owner)).map((entry) => [entry.kind, entry.body, entry.link])).toEqual([['run-failed', '“Auto-fix” did not run', `/projects/${project.id}/automations`]]);
    // It stays scheduled: once auto mode is back, it runs again.
    await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true });
    time.set('2026-10-16T08:00:05Z');
    await world.tick();
    expect(await ended(world, owner, project.id, created.id)).toMatchObject({ outcome: 'completed' });
  });

  it('is refused, with the reason recorded, when its creator may no longer work in the project', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const member = await kit.t.member('former');
    await kit.share(project, member);
    const created = await automation(member, project.id, agentRun());

    // Reduced to read access: switched off at once (see the CRUD tests). "Run now" by the owner still checks who it acts as.
    await kit.share(project, member, 'read');
    const ran = await owner.post<RunAutomationResponse>(`/api/projects/${project.id}/automations/${created.id}/run`);
    expect(ran.body.execution).toMatchObject({
      outcome: 'denied',
      reason: 'access-lost',
      summary: 'Not run: former, who created this automation, no longer has write access to this project.',
      runId: null,
    });
    expect(kit.agent.runs).toHaveLength(0);

    // Even if the switch-off had been missed, the check at execution time holds.
    kit.t.studio.context.db.run('UPDATE automations SET enabled = 1, next_run_at = ?, disabled_reason = NULL WHERE id = ?', Date.parse('2026-10-14T08:00:00Z'), created.id);
    time.set(DUE);
    expect((await world.tick()).automations).toBe(1);
    expect((await getAutomation(owner, project.id, created.id)).lastRun).toMatchObject({ outcome: 'denied', reason: 'access-lost', trigger: 'schedule' });
    expect(kit.agent.runs).toHaveLength(0);
  });

  it('is refused when its creator\'s account has been disabled', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const member = await kit.t.member('suspended');
    await kit.share(project, member);
    const created = await automation(member, project.id, agentRun());
    expect((await owner.patch(`/api/users/${member.userId}`, { disabled: true })).status).toBe(200);
    expect((await getAutomation(owner, project.id, created.id)).guard).toMatchObject({ allowed: false, refusal: 'creator-disabled' });

    time.set(DUE);
    expect((await world.tick()).automations).toBe(1);
    expect((await getAutomation(owner, project.id, created.id)).lastRun).toMatchObject({
      outcome: 'denied',
      reason: 'creator-disabled',
      summary: 'Not run: the account of suspended, who created this automation, is disabled or gone.',
    });
    expect(kit.agent.runs).toHaveLength(0);
  });

  it('is refused when the chosen agent is not installed, or no longer offered in the project', async () => {
    const second = new ScriptedAdapter({ id: 'second', displayName: 'Second agent' });
    const main = new ScriptedAdapter();
    const world = await start({ at: '2026-10-13T12:00:00Z', kit: { adapters: [main, second] } });
    const { kit, time } = world;
    const { owner, project } = kit;
    const created = await automation(owner, project.id, agentRun());

    // The agent's program is gone from the machine.
    main.currentStatus = { installed: false, version: null, signedIn: false, account: null, problem: 'The scripted agent is not installed.' };
    time.set(DUE);
    await world.tick();
    expect((await getAutomation(owner, project.id, created.id)).lastRun).toMatchObject({ outcome: 'denied', reason: 'agent-unavailable', summary: 'Not run: Scripted agent is not available on this Studio.' });
    main.currentStatus = { installed: true, version: '1.0.0', signedIn: true, account: null, problem: null };

    // The owner stops offering the agent in this project.
    expect((await owner.patch(`/api/projects/${project.id}`, { agents: ['second'] })).status).toBe(200);
    expect((await getAutomation(owner, project.id, created.id)).guard).toMatchObject({ allowed: false, refusal: 'agent-not-enabled' });
    time.set('2026-10-15T08:00:05Z');
    await world.tick();
    expect((await getAutomation(owner, project.id, created.id)).lastRun).toMatchObject({ outcome: 'denied', reason: 'agent-not-enabled', summary: 'Not run: Scripted agent is not offered in this project any more.' });
    expect(main.runs).toHaveLength(0);
    expect(second.runs).toHaveLength(0);
    expect((await historyOf(owner, project.id, created.id)).map((entry) => entry.outcome)).toEqual(['denied', 'denied']);
    expect((await notifications(owner)).map((entry) => entry.body)).toEqual(['“Nightly check” did not run']);
  });

  it('is refused when the session it continues is gone', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const session = await kit.session(owner, { title: 'To be deleted' });
    const created = await automation(owner, project.id, agentRun({}, { session: { type: 'existing', sessionId: session.id } }));
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(204);
    time.set(DUE);
    await world.tick();
    expect((await getAutomation(owner, project.id, created.id)).lastRun).toMatchObject({ outcome: 'denied', reason: 'session-gone' });
    expect(kit.agent.runs).toHaveLength(0);
  });
});

describe('when a scheduled run goes wrong', () => {
  it('a failure is recorded with its reason, notified according to the creator\'s switches, and not retried', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time, push } = world;
    const { owner, project } = kit;
    const phone = await device(world, owner);
    const created = await automation(owner, project.id, agentRun({ trigger: { type: 'hourly', minute: 0 } }));
    kit.agent.script([{ fail: { code: 'rate_limited', message: 'The provider refused: quota exhausted for key sk-live-0123456789abcdefghij' } }]);

    time.set('2026-10-13T13:00:05Z');
    await world.tick();
    const failed = await ended(world, owner, project.id, created.id);
    expect(failed).toMatchObject({ outcome: 'failed', reason: 'run-failed' });
    expect(failed.summary).toContain('Scripted agent failed in “Nightly check”: The provider refused: quota exhausted');
    // Nothing that looks like a credential is kept in the record.
    expect(failed.summary).not.toContain('sk-live-0123456789abcdefghij');
    await idle(world);
    expect(await notifications(owner)).toEqual([expect.objectContaining({ kind: 'run-failed', title: 'demo', body: '“Nightly check” failed', sessionId: failed.sessionId, runId: failed.runId })]);
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'demo', body: '“Nightly check” failed' })]);
    expect(JSON.stringify(push.payloads(phone))).not.toContain('quota');

    // Nothing is run again by itself: later passes in the same hour do nothing.
    for (const at of ['2026-10-13T13:01:00Z', '2026-10-13T13:30:00Z', '2026-10-13T13:59:59Z']) {
      time.set(at);
      expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
    }
    expect(kit.agent.runs).toHaveLength(1);
    // The failed run is in the creator's inbox like any failed run, to be continued by hand or put away.
    expect((await owner.get<Inbox>('/api/inbox')).body.groups.needsHandling.map((item) => item.runId)).toEqual([failed.runId]);

    // With the "failure" switch off the record is kept all the same; only the notification is not sent.
    await owner.patch('/api/notifications/preferences', { events: { failure: false } });
    await owner.post('/api/notifications/clear', { scope: 'all' });
    push.received.length = 0;
    kit.agent.script([{ fail: { code: 'rate_limited', message: 'again' } }]);
    time.set('2026-10-13T14:00:05Z');
    await world.tick();
    await until(async () => (await historyOf(owner, project.id, created.id)).filter((entry) => entry.outcome === 'failed').length === 2);
    await idle(world);
    expect(await notifications(owner)).toEqual([]);
    expect(push.received).toEqual([]);
  });

  it('a run somebody stopped is recorded as stopped, without a notification', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const created = await automation(owner, project.id, agentRun());
    kit.agent.script([{ hang: true }]);
    time.set(DUE);
    await world.tick();
    const running = await until(async () => {
      const last = (await getAutomation(owner, project.id, created.id)).lastRun;
      return last?.runId ? last : null;
    });
    await until(async () => (await owner.get<Run>(`/api/runs/${running.runId}`)).body.status === 'running');
    expect((await owner.post(`/api/sessions/${running.sessionId}/stop`)).status).toBe(200);
    expect(await ended(world, owner, project.id, created.id)).toMatchObject({ outcome: 'failed', reason: 'run-stopped', summary: 'The run in “Nightly check” was stopped before it finished.' });
    expect(await notifications(owner)).toEqual([]);
  });

  it('a restart in the middle of a run: recorded as interrupted, one notice, and nothing is run again', async () => {
    const before = await start({ at: '2026-10-13T12:00:00Z' });
    const { owner, project } = before.kit;
    const phone = await device(before, owner);
    const created = await automation(owner, project.id, agentRun());
    before.kit.agent.script([{ hang: true }]);
    before.time.set(DUE);
    await before.tick();
    const running = await until(async () => {
      const last = (await getAutomation(owner, project.id, created.id)).lastRun;
      return last?.runId ? last : null;
    });
    await until(async () => (await owner.get<Run>(`/api/runs/${running.runId}`)).body.status === 'running');

    await before.kit.t.studio.stop();
    before.time.set('2026-10-14T08:05:00Z');
    const agent = new ScriptedAdapter();
    const after = await start({ kit: { restartOf: before.kit, adapters: [agent] }, push: before.push, clock: before.clock, time: before.time });
    await after.kit.listen();
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    await idle(after);

    const record = await getAutomation(after.kit.owner, project.id, created.id);
    expect(record).toMatchObject({ running: false, enabled: true });
    expect(record.lastRun).toMatchObject({
      outcome: 'failed',
      reason: 'interrupted',
      summary: 'The server restarted while this was running. Nothing was run again; open the session to see how far it got.',
      runId: running.runId,
    });
    expect(agent.runs).toHaveLength(0);
    expect((await after.kit.owner.get<Run>(`/api/runs/${running.runId}`)).body).toMatchObject({ status: 'interrupted', interruptedByRestart: true });
    // The session's own "cut short by a restart" notice is the one the creator gets.
    expect(before.push.payloads(phone).map((payload) => payload.tag)).toEqual([`run-interrupted:${running.sessionId}`]);
    expect((await after.kit.owner.get<Inbox>('/api/inbox')).body.groups.needsHandling).toEqual([expect.objectContaining({ runId: running.runId, interruptedByRestart: true })]);

    // The schedule continues.
    after.time.set('2026-10-15T08:00:05Z');
    expect((await after.tick()).automations).toBe(1);
    await until(async () => agent.runs.length === 1 && agent.runs[0]!.finished);
  });
});
