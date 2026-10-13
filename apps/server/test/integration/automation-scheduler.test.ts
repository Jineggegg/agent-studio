import { AUTOMATION_LIMITS, type Automation, type AutomationHistory, type RunAutomationResponse } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { planOverdue } from '../../src/modules/automation/schedule.js';
import { AutomationStore } from '../../src/modules/automation/store.js';
import { type AutomationWorld, agentRun, automation, createAutomationWorlds, getAutomation, historyOf, reminder } from '../../src/modules/automation/testing/world.js';
import { until } from '../../src/modules/inbox/testing/kit.js';
import { device, idle, notifications } from '../../src/modules/inbox/testing/world.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createAutomationWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const HOUR = 60 * 60 * 1000;

/** Stops a Studio the way a deploy or a crash does and starts a new one on the same data, with the same clocks. */
async function restart(before: AutomationWorld, at?: string): Promise<AutomationWorld> {
  await before.kit.t.studio.stop();
  if (at !== undefined) before.time.set(at);
  const after = await start({ kit: { restartOf: before.kit, adapters: [new ScriptedAdapter()] }, push: before.push, clock: before.clock, time: before.time });
  // Start-up work (recovery) runs before the server accepts connections.
  await after.kit.listen();
  return after;
}

describe('each trigger fires at its instant', () => {
  it('not a moment before, exactly once at it, and plans the next', async () => {
    const world = await start({ at: '2026-10-16T10:00:00Z' }); // Friday
    const { kit, time } = world;
    const { owner, project } = kit;
    const cases: Array<{ name: string; timeZone: string; trigger: Record<string, unknown>; due: string; next: string | null }> = [
      { name: 'once', timeZone: 'Europe/Berlin', trigger: { type: 'once', date: '2026-10-17', time: '09:30' }, due: '2026-10-17T07:30:00.000Z', next: null },
      { name: 'hourly', timeZone: 'UTC', trigger: { type: 'hourly', minute: 45 }, due: '2026-10-16T10:45:00.000Z', next: '2026-10-16T11:45:00.000Z' },
      { name: 'daily', timeZone: 'America/New_York', trigger: { type: 'daily', time: '08:00' }, due: '2026-10-16T12:00:00.000Z', next: '2026-10-17T12:00:00.000Z' },
      { name: 'weekdays', timeZone: 'Asia/Shanghai', trigger: { type: 'weekdays', time: '08:00' }, due: '2026-10-19T00:00:00.000Z', next: '2026-10-20T00:00:00.000Z' },
      { name: 'weekly', timeZone: 'UTC', trigger: { type: 'weekly', days: [0, 3], time: '17:00' }, due: '2026-10-18T17:00:00.000Z', next: '2026-10-21T17:00:00.000Z' },
      { name: 'cron', timeZone: 'Asia/Tokyo', trigger: { type: 'cron', expression: '30 6 1 * *' }, due: '2026-10-31T21:30:00.000Z', next: '2026-11-30T21:30:00.000Z' },
    ];
    const created: Automation[] = [];
    for (const entry of cases) created.push(await automation(owner, project.id, reminder({ name: entry.name, timeZone: entry.timeZone, trigger: entry.trigger })));
    expect(created.map((entry) => iso(entry.nextRunAt))).toEqual(cases.map((entry) => entry.due));

    // In order of their due times: one millisecond early nothing happens; at the instant, exactly that one fires, once.
    const order = cases.map((entry, index) => ({ ...entry, id: created[index]!.id })).sort((a, b) => a.due.localeCompare(b.due));
    for (const entry of order) {
      time.set(Date.parse(entry.due) - 1);
      expect(await world.tick(), `${entry.name}: early`).toEqual({ automations: 0, deferred: 0 });
      time.set(entry.due);
      expect(await world.tick(), `${entry.name}: due`).toEqual({ automations: 1, deferred: 0 });
      expect(await world.tick(), `${entry.name}: again`).toEqual({ automations: 0, deferred: 0 });
      const after = await getAutomation(owner, project.id, entry.id);
      expect(iso(after.nextRunAt), entry.name).toBe(entry.next);
      expect(after.lastRun, entry.name).toMatchObject({ trigger: 'schedule', outcome: 'notified', scheduledFor: Date.parse(entry.due), startedAt: Date.parse(entry.due), endedAt: Date.parse(entry.due) });
      expect(await historyOf(owner, project.id, entry.id), entry.name).toHaveLength(1);
      // Put it away, so that the next case is watched alone.
      if (entry.name !== 'once') expect((await owner.patch(`/api/projects/${project.id}/automations/${entry.id}`, { enabled: false })).status).toBe(200);
    }
    // The one-off switched itself off when it ran.
    expect(await getAutomation(owner, project.id, order.find((entry) => entry.name === 'once')!.id)).toMatchObject({ enabled: false, state: 'off', disabledReason: 'ran-once' });
  });

  it('on the day the clocks go forward: a time inside the gap runs once, an hour later on the clock', async () => {
    // New York, the night of 13/14 March 2027: 02:00 becomes 03:00.
    const world = await start({ at: '2027-03-13T14:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const inGap = await automation(owner, project.id, reminder({ name: 'In the gap', timeZone: 'America/New_York', trigger: { type: 'daily', time: '02:30' } }));
    const morning = await automation(owner, project.id, reminder({ name: 'Morning', timeZone: 'America/New_York', trigger: { type: 'daily', time: '08:00' } }));
    expect(iso(inGap.nextRunAt)).toBe('2027-03-14T07:30:00.000Z'); // 03:30 EDT — there is no 02:30 that day
    expect(iso(morning.nextRunAt)).toBe('2027-03-14T12:00:00.000Z'); // 08:00 EDT, 23 hours after the previous 08:00

    time.set('2027-03-14T07:29:59.999Z');
    expect((await world.tick()).automations).toBe(0);
    time.set('2027-03-14T07:30:00Z');
    expect((await world.tick()).automations).toBe(1);
    time.set('2027-03-14T12:00:00Z');
    expect((await world.tick()).automations).toBe(1);
    // The day after, both are back at their usual place on the clock; neither ran twice or not at all.
    expect(iso((await getAutomation(owner, project.id, inGap.id)).nextRunAt)).toBe('2027-03-15T06:30:00.000Z');
    expect(iso((await getAutomation(owner, project.id, morning.id)).nextRunAt)).toBe('2027-03-15T12:00:00.000Z');
    time.set('2027-03-14T23:59:59Z');
    expect((await world.tick()).automations).toBe(0);
    expect(await historyOf(owner, project.id, inGap.id)).toHaveLength(1);
    expect(await historyOf(owner, project.id, morning.id)).toHaveLength(1);
  });

  it('on the day the clocks go back: a time that occurs twice runs once', async () => {
    // New York, the night of 31 October / 1 November 2026: 02:00 becomes 01:00.
    const world = await start({ at: '2026-10-31T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const twice = await automation(owner, project.id, reminder({ name: 'Occurs twice', timeZone: 'America/New_York', trigger: { type: 'daily', time: '01:30' } }));
    expect(iso(twice.nextRunAt)).toBe('2026-11-01T05:30:00.000Z'); // the first 01:30 (EDT)

    time.set('2026-11-01T05:30:00Z');
    expect((await world.tick()).automations).toBe(1);
    // An hour later it is 01:30 again (EST): not a second run.
    time.set('2026-11-01T06:30:00Z');
    expect((await world.tick()).automations).toBe(0);
    time.set('2026-11-01T23:00:00Z');
    expect((await world.tick()).automations).toBe(0);
    expect(await historyOf(owner, project.id, twice.id)).toHaveLength(1);
    expect(iso((await getAutomation(owner, project.id, twice.id)).nextRunAt)).toBe('2026-11-02T06:30:00.000Z'); // 01:30 EST
    time.set('2026-11-02T06:30:00Z');
    expect((await world.tick()).automations).toBe(1);
  });
});

describe('exactly once', () => {
  it('two passes at the same moment send one notification', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time, push } = world;
    const { owner, project } = kit;
    const phone = await device(world, owner);
    const created = await automation(owner, project.id, reminder());
    time.set('2026-10-14T08:00:10Z');

    const passes = await Promise.all([world.tick(), world.tick(), world.tick()]);
    expect(passes.map((pass) => pass.automations).sort()).toEqual([0, 0, 1]);
    await world.tick();
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    // By default a lock screen is told which reminder fired, in which project — not what it says.
    expect(push.payloads(phone)).toEqual([{ title: 'demo', body: 'Reminder from “Stand-up”', tag: `automation:${created.id}`, url: `/projects/${project.id}/automations` }]);
    expect(await notifications(owner)).toEqual([expect.objectContaining({ kind: 'automation', title: 'demo', body: 'Stand-up in five minutes', link: `/projects/${project.id}/automations`, projectId: project.id })]);

    const after = await getAutomation(owner, project.id, created.id);
    expect(after.lastRun).toMatchObject({ outcome: 'notified', reason: null, summary: 'Sent “Stand-up in five minutes” to the app and 1 device.' });
    // Tomorrow, the same time on the clock.
    expect(iso(after.nextRunAt)).toBe('2026-10-15T08:00:00.000Z');
    expect(await historyOf(owner, project.id, created.id)).toHaveLength(1);
  });

  it('a restart on the same data does not repeat what already ran', async () => {
    const before = await start({ at: '2026-10-13T12:00:00Z' });
    const phone = await device(before, before.kit.owner);
    const created = await automation(before.kit.owner, before.kit.project.id, reminder());
    before.time.set('2026-10-14T08:00:10Z');
    expect((await before.tick()).automations).toBe(1);
    await idle(before);
    expect(before.push.to(phone)).toHaveLength(1);

    // The process ends and a new one starts within the same minute.
    const after = await restart(before, '2026-10-14T08:00:40Z');
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    await idle(after);
    expect(before.push.to(phone)).toHaveLength(1);
    expect((await historyOf(after.kit.owner, after.kit.project.id, created.id)).map((entry) => entry.outcome)).toEqual(['notified']);
  });

  it('a crash after the claim and before the work: the occurrence is closed as interrupted and never carried out', async () => {
    const before = await start({ at: '2026-10-13T12:00:00Z' });
    const { owner, project } = before.kit;
    const phone = await device(before, owner);
    const notify = await automation(owner, project.id, reminder());
    const run = await automation(owner, project.id, agentRun());
    before.time.set('2026-10-14T08:00:10Z');
    // The claim, exactly as a pass makes it — and then the process dies before it can do anything with it.
    const now = before.time.now();
    const store = new AutomationStore(before.kit.t.studio.context.db);
    for (const id of [notify.id, run.id]) {
      const claim = store.claimDue(
        id,
        now,
        (row) => planOverdue({ trigger: JSON.parse(row.trigger), timeZone: row.time_zone, dueAt: row.next_run_at!, now, graceMs: AUTOMATION_LIMITS.graceMs }),
        { missed: () => 'missed', earlierMissed: () => 'earlier', stillRunning: () => 'still running' },
      );
      expect(claim.kind).toBe('run');
    }

    const after = await restart(before, '2026-10-14T08:01:00Z');
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    await idle(after);
    for (const id of [notify.id, run.id]) {
      const history = await historyOf(after.kit.owner, project.id, id);
      expect(history).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'interrupted', summary: 'The server stopped before this could start. It was not run again.', endedAt: expect.any(Number) })]);
      const record = await getAutomation(after.kit.owner, project.id, id);
      expect(record).toMatchObject({ running: false, enabled: true });
      expect(iso(record.nextRunAt)).toBe('2026-10-15T08:00:00.000Z');
    }
    // Nothing was sent and no agent was started — not by the old process, not by the new one.
    expect(before.push.to(phone)).toEqual([]);
    expect(after.kit.agent.runs).toHaveLength(0);
    expect(before.kit.agent.runs).toHaveLength(0);

    // The schedule goes on as if nothing had happened.
    after.time.set('2026-10-15T08:00:05Z');
    expect((await after.tick()).automations).toBe(2);
    expect((await historyOf(after.kit.owner, project.id, notify.id)).map((entry) => entry.outcome)).toEqual(['failed', 'notified']);
  });
});

describe('an automation never overlaps itself', () => {
  it('due again while its run is still going: skipped, recorded, and nothing is started', async () => {
    const world = await start({ at: '2026-10-13T07:30:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const hourly = await automation(owner, project.id, agentRun({ name: 'Hourly sweep', trigger: { type: 'hourly', minute: 0 } }));
    kit.agent.script([{ gate: 'long-job' }, { text: 'swept' }]);

    time.set('2026-10-13T08:00:05Z');
    expect((await world.tick()).automations).toBe(1);
    await kit.agent.reached('long-job');
    expect(await getAutomation(owner, project.id, hourly.id)).toMatchObject({ running: true, lastRun: { outcome: 'started', endedAt: null } });

    // An hour later, and another: the first run has not finished.
    for (const at of ['2026-10-13T09:00:05Z', '2026-10-13T10:00:05Z']) {
      time.set(at);
      expect((await world.tick()).automations).toBe(0);
    }
    expect(kit.agent.runs).toHaveLength(1);
    expect((await historyOf(owner, project.id, hourly.id)).map((entry) => [entry.outcome, entry.reason, iso(entry.scheduledFor)])).toEqual([
      ['started', null, '2026-10-13T08:00:00.000Z'],
      ['skipped', 'still-running', '2026-10-13T09:00:00.000Z'],
      ['skipped', 'still-running', '2026-10-13T10:00:00.000Z'],
    ]);
    expect((await getAutomation(owner, project.id, hourly.id)).lastRun).toMatchObject({ outcome: 'skipped', summary: 'Skipped: the previous run of this automation was still going.' });

    // "Run now" while it runs: executes nothing and records nothing.
    const now = await owner.post<RunAutomationResponse>(`/api/projects/${project.id}/automations/${hourly.id}/run`);
    expect(now.status).toBe(200);
    expect(now.body.execution).toBeNull();
    expect(now.body.automation.running).toBe(true);
    expect(await historyOf(owner, project.id, hourly.id)).toHaveLength(3);
    expect(kit.agent.runs).toHaveLength(1);

    // It finishes; the next occurrence runs again.
    kit.agent.open('long-job');
    await until(async () => (await getAutomation(owner, project.id, hourly.id)).running === false, { what: 'the run to end' });
    time.set('2026-10-13T11:00:05Z');
    expect((await world.tick()).automations).toBe(1);
    await until(async () => kit.agent.runs.length === 2 && kit.agent.runs[1]!.finished);
    expect((await historyOf(owner, project.id, hourly.id)).map((entry) => entry.outcome).filter((outcome) => outcome === 'completed' || outcome === 'started')).toHaveLength(2);
  });
});

describe('a run that came due while the server was down', () => {
  it('is made up once when the server is back within six hours', async () => {
    const before = await start({ at: '2026-10-13T06:30:00Z' });
    const created = await automation(before.kit.owner, before.kit.project.id, reminder());
    // Down from 07:00 to 10:00; due at 08:00.
    const after = await restart(before, '2026-10-13T10:00:00Z');
    expect((await after.tick()).automations).toBe(1);
    expect((await after.tick()).automations).toBe(0);
    const record = await getAutomation(after.kit.owner, after.kit.project.id, created.id);
    expect(record.lastRun).toMatchObject({ outcome: 'notified', scheduledFor: Date.parse('2026-10-13T08:00:00Z'), startedAt: Date.parse('2026-10-13T10:00:00Z') });
    expect(iso(record.nextRunAt)).toBe('2026-10-14T08:00:00.000Z');
    expect(await historyOf(after.kit.owner, after.kit.project.id, created.id)).toHaveLength(1);
  });

  it('is recorded as missed, and not run, when the server comes back later than that', async () => {
    const before = await start({ at: '2026-10-13T06:30:00Z' });
    const phone = await device(before, before.kit.owner);
    const created = await automation(before.kit.owner, before.kit.project.id, reminder({ timeZone: 'Europe/Berlin', trigger: { type: 'daily', time: '10:00' } }));
    expect(iso(created.nextRunAt)).toBe('2026-10-13T08:00:00.000Z');
    // Back at 15:00 UTC: seven hours late.
    const after = await restart(before, '2026-10-13T15:00:00Z');
    expect(await after.tick()).toEqual({ automations: 0, deferred: 0 });
    await idle(after);
    const record = await getAutomation(after.kit.owner, after.kit.project.id, created.id);
    // The sentence names the run that was missed, in the automation's own zone.
    expect(record.lastRun).toMatchObject({ outcome: 'missed', reason: 'server-down', summary: 'Missed the run of Oct 13, 10:00: the server was not running.', scheduledFor: Date.parse('2026-10-13T08:00:00Z') });
    expect(iso(record.nextRunAt)).toBe('2026-10-14T08:00:00.000Z');
    expect(record).toMatchObject({ enabled: true, state: 'scheduled' });
    expect(before.push.to(phone)).toEqual([]);
    expect(await notifications(after.kit.owner)).toEqual([]);

    // Tomorrow it runs as usual.
    after.time.set('2026-10-14T08:00:01Z');
    expect((await after.tick()).automations).toBe(1);
  });

  it('after days of downtime makes up only the most recent occurrence', async () => {
    const before = await start({ at: '2026-10-09T12:00:00Z' });
    const hourly = await automation(before.kit.owner, before.kit.project.id, reminder({ name: 'Hourly', trigger: { type: 'hourly', minute: 0 } }));
    const daily = await automation(before.kit.owner, before.kit.project.id, reminder({ name: 'Daily' }));
    const once = await automation(before.kit.owner, before.kit.project.id, reminder({ name: 'Once', trigger: { type: 'once', date: '2026-10-10', time: '09:00' } }));
    const after = await restart(before, '2026-10-13T09:30:00Z');
    expect((await after.tick()).automations).toBe(2);
    const { owner, project } = after.kit;

    expect((await historyOf(owner, project.id, daily.id)).map((entry) => [entry.outcome, iso(entry.scheduledFor), entry.summary])).toEqual([
      ['missed', '2026-10-10T08:00:00.000Z', 'Missed 3 earlier runs (since Oct 10, 08:00): the server was not running. The most recent one is made up now.'],
      ['notified', '2026-10-13T08:00:00.000Z', 'Sent “Stand-up in five minutes” to the notification list in the app.'],
    ]);
    const hourlyRuns = await historyOf(owner, project.id, hourly.id);
    expect(hourlyRuns.map((entry) => [entry.outcome, iso(entry.scheduledFor)])).toEqual([
      ['missed', '2026-10-09T13:00:00.000Z'],
      ['notified', '2026-10-13T09:00:00.000Z'],
    ]);
    expect(iso((await getAutomation(owner, project.id, hourly.id)).nextRunAt)).toBe('2026-10-13T10:00:00.000Z');
    // The one-off's moment is long gone: missed, and switched off.
    expect(await getAutomation(owner, project.id, once.id)).toMatchObject({ enabled: false, nextRunAt: null, lastRun: { outcome: 'missed', summary: 'Missed the run of Oct 10, 09:00: the server was not running.' } });
  });
});

describe('"run now"', () => {
  it('runs once at once — also when switched off — and leaves the schedule alone', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit } = world;
    const { owner, project } = kit;
    const off = await automation(owner, project.id, reminder({ name: 'Off', enabled: false }));
    const on = await automation(owner, project.id, reminder({ name: 'On' }));

    const ranOff = await owner.post<RunAutomationResponse>(`/api/projects/${project.id}/automations/${off.id}/run`);
    expect(ranOff.status).toBe(200);
    expect(ranOff.body.execution).toMatchObject({ trigger: 'manual', scheduledFor: null, outcome: 'notified', endedAt: expect.any(Number) });
    expect(ranOff.body.automation).toMatchObject({ enabled: false, nextRunAt: null, state: 'off', lastRun: { outcome: 'notified', trigger: 'manual' } });

    const ranOn = await owner.post<RunAutomationResponse>(`/api/projects/${project.id}/automations/${on.id}/run`);
    expect(iso(ranOn.body.automation.nextRunAt)).toBe('2026-10-14T08:00:00.000Z');
    // The scheduled run still happens at its time.
    world.time.set('2026-10-14T08:00:01Z');
    expect((await world.tick()).automations).toBe(1);
    expect((await historyOf(owner, project.id, on.id)).map((entry) => entry.trigger)).toEqual(['manual', 'schedule']);
    expect((await historyOf(owner, project.id, off.id)).map((entry) => entry.trigger)).toEqual(['manual']);
    expect((await notifications(owner)).length).toBe(2);
  });
});

describe('what becomes of a reminder', () => {
  it('is recorded in words: where it went, or why it went nowhere', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, push } = world;
    const { owner, project } = kit;
    const created = await automation(owner, project.id, reminder());
    const run = async () => (await owner.post<RunAutomationResponse>(`/api/projects/${project.id}/automations/${created.id}/run`)).body.execution!;

    // No device: the app's own list is where it goes.
    expect(await run()).toMatchObject({ outcome: 'notified', reason: null, summary: 'Sent “Stand-up in five minutes” to the notification list in the app.' });

    const phone = await device(world, owner, 'phone');
    const tablet = await device(world, owner, 'tablet');
    expect(await run()).toMatchObject({ outcome: 'notified', summary: 'Sent “Stand-up in five minutes” to the app and 2 devices.' });
    await owner.patch('/api/notifications/preferences', { channels: { inApp: false } });
    expect(await run()).toMatchObject({ outcome: 'notified', summary: 'Sent “Stand-up in five minutes” to 2 devices.' });

    // With "show details" on, the device shows the message itself.
    await owner.patch('/api/notifications/preferences', { showDetails: true });
    push.received.length = 0;
    await run();
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'demo', body: 'Stand-up in five minutes' })]);
    await owner.patch('/api/notifications/preferences', { showDetails: false });

    // Every push service refuses, and the list in the app is off: that is a failure, said as one.
    push.answer(phone, 500);
    push.answer(tablet, 503);
    expect(await run()).toMatchObject({ outcome: 'failed', reason: 'not-delivered', summary: 'Not delivered: no device’s push service accepted the message, and the list in the app is switched off.' });

    // The creator switched reminders off, or every channel: nothing is sent, and the record says which.
    await owner.patch('/api/notifications/preferences', { channels: { inApp: true }, events: { automation: false } });
    push.received.length = 0;
    expect(await run()).toMatchObject({ outcome: 'quiet', reason: 'event-off', summary: 'Not sent: notifications about automations are switched off in the creator’s settings.' });
    await owner.patch('/api/notifications/preferences', { channels: { inApp: false, webPush: false }, events: { automation: true } });
    expect(await run()).toMatchObject({ outcome: 'quiet', reason: 'channels-off' });
    expect(push.received).toEqual([]);

    // A newer reminder of the same automation replaces the older one in the list.
    await owner.patch('/api/notifications/preferences', { channels: { inApp: true } });
    await owner.post('/api/notifications/clear', { scope: 'all' });
    await run();
    await run();
    expect(await notifications(owner)).toHaveLength(1);

    // In the creator's language.
    await owner.patch('/api/preferences', { values: { 'appearance.language': 'zh-CN' } });
    expect((await run()).summary).toBe('已把“Stand-up in five minutes”发到应用内的通知列表。');
  });
});

describe('the event trigger', () => {
  it('fires when a run its creator may see fails in that project — and only then', async () => {
    const world = await start();
    const { kit, push } = world;
    const { owner, project } = kit;
    const member = await kit.t.member('builder');
    await kit.share(project, member);
    const other = await kit.makeProject('other');
    const event = { trigger: { type: 'event', event: 'run-failed' } };
    const mine = await automation(owner, project.id, reminder({ name: 'Tell me', ...event, action: { type: 'notify', message: 'A run failed in demo' } }));
    const elsewhere = await automation(owner, other.id, reminder({ name: 'Other project', ...event }));
    const members = await automation(member, project.id, reminder({ name: "Member's", ...event, action: { type: 'notify', message: 'One of my runs failed' } }));
    const off = await automation(owner, project.id, reminder({ name: 'Off', enabled: false, ...event }));
    const phone = await device(world, owner);
    await owner.patch('/api/notifications/preferences', { events: { failure: false } });
    await member.patch('/api/notifications/preferences', { events: { failure: false } });

    // A run that succeeds triggers nothing.
    const session = await kit.session(owner, { title: 'Build' });
    await kit.turn(owner, session.id, 'build');
    expect(await historyOf(owner, project.id, mine.id)).toEqual([]);
    await owner.post('/api/notifications/clear', { scope: 'all' });
    push.received.length = 0;

    // The owner's run fails: the owner's automation in that project fires; the member's does not (it is not their run).
    kit.agent.script([{ fail: { code: 'build_failed', message: 'tsc exited with code 2' } }]);
    await kit.turn(owner, session.id, 'build again');
    await until(async () => (await historyOf(owner, project.id, mine.id)).length === 1);
    await idle(world);
    expect((await historyOf(owner, project.id, mine.id))[0]).toMatchObject({ trigger: 'event', scheduledFor: null, outcome: 'notified' });
    expect(await historyOf(owner, project.id, members.id)).toEqual([]);
    expect(await historyOf(owner, other.id, elsewhere.id)).toEqual([]);
    expect(await historyOf(owner, project.id, off.id)).toEqual([]);
    // The message, followed — in the app — by the short reason; tapping it opens the project's automations.
    expect(await notifications(owner)).toEqual([
      expect.objectContaining({ kind: 'automation', title: 'demo', body: 'A run failed in demo', detail: 'Scripted agent: tsc exited with code 2', link: `/projects/${project.id}/automations` }),
    ]);
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'demo', body: 'Reminder from “Tell me”' })]);

    // The member's run fails: their own automation fires, and so does the owner's — an owner may see every run.
    const memberSession = await kit.session(member, { title: "Member's build" });
    kit.agent.script([{ fail: { code: 'build_failed', message: 'out of memory' } }]);
    await kit.turn(member, memberSession.id, 'build');
    await until(async () => (await historyOf(owner, project.id, members.id)).length === 1);
    await until(async () => (await historyOf(owner, project.id, mine.id)).length === 2);
    expect((await notifications(member)).map((entry) => [entry.body, entry.detail])).toEqual([['One of my runs failed', 'Scripted agent: out of memory']]);

    // A run the user stopped is not a failure.
    kit.agent.script([{ hang: true }]);
    const hanging = await kit.send(owner, session.id, 'never ends');
    await until(async () => (await kit.state(owner, session.id)).run?.status === 'running');
    await owner.post(`/api/sessions/${session.id}/stop`);
    await kit.runEnded(owner, hanging.body.runId!);
    expect(await historyOf(owner, project.id, mine.id)).toHaveLength(2);
  });
});

describe('the history of an automation', () => {
  it('is kept, newest first, a page at a time', async () => {
    const world = await start({ at: '2026-10-13T00:30:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const hourly = await automation(owner, project.id, reminder({ trigger: { type: 'hourly', minute: 0 } }));
    for (let hour = 1; hour <= 7; hour += 1) {
      time.set(Date.parse('2026-10-13T00:00:00Z') + hour * HOUR + 1000);
      await world.tick();
    }
    const url = `/api/projects/${project.id}/automations/${hourly.id}/runs`;
    const first = (await owner.get<AutomationHistory>(`${url}?limit=3`)).body;
    expect(first.hasMore).toBe(true);
    expect(first.runs.map((entry) => iso(entry.scheduledFor))).toEqual(['2026-10-13T07:00:00.000Z', '2026-10-13T06:00:00.000Z', '2026-10-13T05:00:00.000Z']);
    const second = (await owner.get<AutomationHistory>(`${url}?limit=3&before=${first.runs[2]!.id}`)).body;
    expect(second.runs.map((entry) => iso(entry.scheduledFor))).toEqual(['2026-10-13T04:00:00.000Z', '2026-10-13T03:00:00.000Z', '2026-10-13T02:00:00.000Z']);
    const last = (await owner.get<AutomationHistory>(`${url}?limit=3&before=${second.runs[2]!.id}`)).body;
    expect(last).toMatchObject({ hasMore: false, runs: [{ scheduledFor: Date.parse('2026-10-13T01:00:00Z'), outcome: 'notified', sessionId: null, runId: null }] });
    expect((await owner.get(`${url}?limit=1000`)).status).toBe(400);
    expect((await owner.get(`${url}?before=nonsense`)).status).toBe(400);
  });
});

describe('the timer', () => {
  it('makes passes by itself, and stops when the server stops', async () => {
    // The real clock and a real, fast timer: nothing here calls tick().
    const world = await start({ automation: { now: Date.now, tickMs: 25, firstTickMs: 5 } });
    const { kit } = world;
    const { owner, project } = kit;
    const created = await automation(owner, project.id, reminder({ trigger: { type: 'hourly', minute: 0 } }));
    // Make it due now, as if its time had just come.
    kit.t.studio.context.db.run('UPDATE automations SET next_run_at = ? WHERE id = ?', Date.now() - 1000, created.id);
    expect(await historyOf(owner, project.id, created.id)).toEqual([]);

    await kit.listen();
    await until(async () => (await historyOf(owner, project.id, created.id)).length === 1, { what: 'the timer to make a pass' });
    expect((await historyOf(owner, project.id, created.id))[0]).toMatchObject({ outcome: 'notified', trigger: 'schedule' });

    // Stopped: later passes do not happen, even with something due.
    const db = kit.t.studio.context.db;
    await kit.t.studio.stop();
    const reopened = await start({ kit: { restartOf: kit }, push: world.push, clock: world.clock, automation: { now: Date.now, tickMs: 0 } });
    reopened.kit.t.studio.context.db.run('UPDATE automations SET next_run_at = ? WHERE id = ?', Date.now() - 1000, created.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await historyOf(reopened.kit.owner, project.id, created.id)).toHaveLength(1);
    expect(() => db.run('SELECT 1')).toThrow();
  });
});
