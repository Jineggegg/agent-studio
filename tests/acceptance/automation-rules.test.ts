import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  createSession,
  pendingApprovals,
  shareProject,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.2 — Automations (requirements 04 §6.2, §7.3).
 *
 * An automation is a schedule (or the "a run failed" event) plus one action:
 * a reminder, or an unattended agent run. Deliberate differences this file is
 * written for:
 *  - recurring agent runs exist, with the rule that what would need a
 *    person's approval is denied and reported — never waited for, never run;
 *  - the project's automation switch is off until the owner turns it on.
 *
 * Not built, so not tested: planning from a sentence (AT-AUT-001…004), the
 * digest action (AT-AUT-016…018), saved instruction drafts (AT-AUT-024).
 * A schedule coming due by the clock is exercised with deferred messages in
 * the neighbouring file; here executions are started with "run now".
 */
describe('6.2 automations', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let api: string;

  const daily = {
    name: 'Stand-up reminder',
    timeZone: 'Europe/Berlin',
    trigger: { type: 'daily', time: '08:00' },
    action: { type: 'notify', message: 'time for the stand-up' },
  };

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'Automated', { features: { automation: true } });
    api = `/api/projects/${project.id}/automations`;
  });
  afterAll(() => studio?.destroy());

  const create = (body: Record<string, unknown>, client: ApiClient = owner, base = api) =>
    client.post<Json>(base, body);
  const listed = async (client: ApiClient = owner, base = api) =>
    (await client.get<Json>(base)).body;
  /** "Run now", then wait for the execution to be closed. */
  async function runNow(id: string, client: ApiClient = owner): Promise<Json> {
    const started = await client.post<Json>(`${api}/${id}/run`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.execution, 'an execution was started').not.toBeNull();
    return until(
      async () => {
        const history = (await client.get<{ runs: Json[] }>(`${api}/${id}/runs`)).body.runs;
        const mine = history.find((run) => run.id === started.body.execution.id);
        return mine && mine.endedAt !== null ? mine : undefined;
      },
      { timeout: 40_000, what: 'the execution to end' },
    );
  }
  const localTime = (instant: number, timeZone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(instant));

  it('AT-AUT-020: a project’s automations are off until its owner switches them on — until then nothing can be created, changed or run there', async () => {
    const plain = await createProject(studio, owner, 'Not automated');
    expect(plain).toMatchObject({ id: plain.id });
    expect((await owner.get<Json>(`/api/projects/${plain.id}`)).body.features.automation).toBe(
      false,
    );
    const base = `/api/projects/${plain.id}/automations`;
    expect(await listed(owner, base)).toMatchObject({ automations: [], enabled: false });
    const refused = await create(daily, owner, base);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('automation_disabled');
    // Switched on, an automation can be made; switched off again, it can be neither changed nor run.
    await owner.patch(`/api/projects/${plain.id}`, { features: { automation: true } });
    const made = await create(daily, owner, base);
    expect(made.status).toBe(201);
    await owner.patch(`/api/projects/${plain.id}`, { features: { automation: false } });
    for (const attempt of [
      owner.patch(`${base}/${made.body.id}`, { name: 'Renamed' }),
      owner.post(`${base}/${made.body.id}/run`),
      create({ ...daily, name: 'Another' }, owner, base),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).error.code).toBe('automation_disabled');
    }
    expect(
      (await owner.get<{ runs: unknown[] }>(`${base}/${made.body.id}/runs`)).body.runs ?? [],
    ).toEqual([]);
  });

  it('AUT-06: an automation is created, read, changed and deleted; what is stored says when it runs next, in its own time zone', async () => {
    const created = await create(daily);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      projectId: project.id,
      name: 'Stand-up reminder',
      enabled: true,
      timeZone: 'Europe/Berlin',
      trigger: { type: 'daily', time: '08:00' },
      action: { type: 'notify', message: 'time for the stand-up' },
      createdBy: { id: owner.userId },
      canManage: true,
      state: 'scheduled',
      running: false,
      lastRun: null,
      guard: null,
    });
    expect(created.body.nextRunAt).toBeGreaterThan(Date.now());
    expect(created.body.nextRunAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(localTime(created.body.nextRunAt, 'Europe/Berlin')).toMatch(/08:00$/);
    expect((await owner.get<Json>(`${api}/${created.body.id}`)).body.id).toBe(created.body.id);
    expect((await listed()).automations.map((item: Json) => item.id)).toContain(created.body.id);

    const changed = await owner.patch<Json>(`${api}/${created.body.id}`, {
      trigger: { type: 'weekly', days: [5], time: '17:00' },
      timeZone: 'Asia/Shanghai',
    });
    expect(changed.status).toBe(200);
    expect(localTime(changed.body.nextRunAt, 'Asia/Shanghai')).toBe('Fri 17:00');
    const off = await owner.patch<Json>(`${api}/${created.body.id}`, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, state: 'off', nextRunAt: null });
    expect((await owner.patch(`${api}/${created.body.id}`, {})).status).toBe(400);

    expect((await owner.delete(`${api}/${created.body.id}`)).status).toBeLessThan(300);
    expect((await owner.get(`${api}/${created.body.id}`)).status).toBe(404);
    expect((await listed()).automations.map((item: Json) => item.id)).not.toContain(
      created.body.id,
    );
  });

  it('AT-AUT-005/006: a malformed schedule is refused and nothing is stored — a time that is not a time, a zone that is not a zone, a week without a day, a date that does not exist, an unknown repeat, a one-off in the past', async () => {
    const before = (await listed()).automations.length;
    const bad: Array<Record<string, unknown>> = [
      { ...daily, trigger: { type: 'daily', time: '25:00' } },
      { ...daily, trigger: { type: 'daily', time: '9:5' } },
      { ...daily, timeZone: 'Mars/Olympus' },
      { ...daily, trigger: { type: 'weekly', time: '08:00' } },
      { ...daily, trigger: { type: 'weekly', days: [], time: '08:00' } },
      { ...daily, trigger: { type: 'weekly', days: [7], time: '08:00' } },
      { ...daily, trigger: { type: 'once', date: '2027-02-30', time: '08:00' } },
      { ...daily, trigger: { type: 'fortnightly', time: '08:00' } },
      { ...daily, trigger: { type: 'hourly', minute: 60 } },
      { ...daily, trigger: { type: 'cron', expression: 'every day at noon' } },
      { ...daily, trigger: { type: 'cron', expression: '* * * * *' } }, // every minute: more often than allowed
      { ...daily, trigger: { type: 'daily', time: '08:00', command: 'rm -rf /' } },
    ];
    for (const body of bad) {
      const refused = await create(body);
      expect(refused.status, JSON.stringify(body.trigger ?? body.timeZone)).toBe(400);
    }
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const passed = await create({
      ...daily,
      trigger: { type: 'once', date: yesterday, time: '08:00' },
    });
    expect(passed.status).toBe(400);
    expect(passed.body.error.code).toBe('time_passed');
    expect((await listed()).automations.length).toBe(before);
  });

  it('AT-AUT-007 (adapted): the schedule preview shows the next five runs — "weekdays 08:00" lands on Monday to Friday at 08:00 local time in the chosen zone, and stores nothing', async () => {
    const before = (await listed()).automations.length;
    for (const timeZone of ['America/New_York', 'Asia/Shanghai', 'Australia/Sydney']) {
      const preview = await owner.post<{ runs: number[] }>('/api/automations/preview', {
        timeZone,
        trigger: { type: 'weekdays', time: '08:00' },
      });
      expect(preview.status).toBe(200);
      expect(preview.body.runs).toHaveLength(5);
      expect([...preview.body.runs].sort((a, b) => a - b)).toEqual(preview.body.runs);
      expect(preview.body.runs[0]).toBeGreaterThan(Date.now());
      for (const instant of preview.body.runs) {
        const [day, time] = localTime(instant, timeZone).split(' ');
        expect(time, `${timeZone} ${new Date(instant).toISOString()}`).toBe('08:00');
        expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(day);
      }
      expect(
        new Set(preview.body.runs.map((instant) => localTime(instant, timeZone).split(' ')[0]))
          .size,
      ).toBe(5);
    }
    const hourly = (
      await owner.post<{ runs: number[] }>('/api/automations/preview', {
        timeZone: 'UTC',
        trigger: { type: 'hourly', minute: 15 },
      })
    ).body.runs;
    expect(hourly.map((instant) => new Date(instant).getUTCMinutes())).toEqual([
      15, 15, 15, 15, 15,
    ]);
    expect(hourly[1]! - hourly[0]!).toBe(60 * 60 * 1000);
    const once = (
      await owner.post<{ runs: number[] }>('/api/automations/preview', {
        timeZone: 'UTC',
        trigger: { type: 'once', date: '2031-03-04', time: '05:06' },
      })
    ).body.runs;
    expect(once).toEqual([Date.UTC(2031, 2, 4, 5, 6)]);
    expect(
      (
        await owner.post('/api/automations/preview', {
          timeZone: 'Mars/Olympus',
          trigger: { type: 'daily', time: '08:00' },
        })
      ).status,
    ).toBe(400);
    expect((await listed()).automations.length).toBe(before);
  });

  it('AT-AUT-008/013 (adapted): "run now" on a reminder raises one notification under the project’s name — and on a disabled automation it runs once and leaves it disabled with no next run', async () => {
    const created = (
      await create({
        ...daily,
        name: 'Timesheet',
        action: { type: 'notify', message: 'submit my timesheet' },
        enabled: false,
      })
    ).body;
    expect(created).toMatchObject({ enabled: false, state: 'off', nextRunAt: null });
    const execution = await runNow(created.id);
    expect(execution).toMatchObject({
      trigger: 'manual',
      outcome: 'notified',
      reason: null,
      sessionId: null,
      runId: null,
    });
    const after = (await owner.get<Json>(`${api}/${created.id}`)).body;
    expect(after).toMatchObject({ enabled: false, state: 'off', nextRunAt: null, running: false });
    expect(after.lastRun).toMatchObject({ id: execution.id, outcome: 'notified' });

    const notifications = (
      await owner.get<{ notifications: Json[] }>('/api/notifications?order=newest')
    ).body.notifications.filter((item) => item.kind === 'automation');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: 'Automated',
      projectId: project.id,
      tag: `automation:${created.id}`,
      link: `/projects/${project.id}/automations`,
    });
    // In the app's own list the reminder reads as it was written (what a lock screen shows is the push's business).
    expect(notifications[0]!.body).toBe('submit my timesheet');
    expect(
      (await owner.get<{ runs: Json[] }>(`${api}/${created.id}/runs`)).body.runs.map(
        (run) => run.id,
      ),
    ).toEqual([execution.id]);
  });

  it('AT-AUT-011 (adapted): with automation notifications switched off the reminder runs "quiet" — nothing is raised, and the record says why', async () => {
    const quietPerson = await createMember(studio, owner, 'quietperson');
    await shareProject(owner, project.id, quietPerson.userId!, 'write');
    await quietPerson.patch('/api/notifications/preferences', { events: { automation: false } });
    const created = (await create({ ...daily, name: 'Quiet reminder' }, quietPerson)).body;
    const started = await quietPerson.post<Json>(`${api}/${created.id}/run`);
    const execution = await until(async () => {
      const history = (await quietPerson.get<{ runs: Json[] }>(`${api}/${created.id}/runs`)).body
        .runs;
      return history.find((run) => run.id === started.body.execution.id && run.endedAt !== null);
    });
    expect(execution).toMatchObject({ outcome: 'quiet', reason: 'event-off' });
    expect(
      (await quietPerson.get<{ notifications: Json[] }>('/api/notifications')).body.notifications,
    ).toEqual([]);
  });

  it('AT-AUT-015/019: an event can only trigger a reminder; a project holds twenty automations; a name is one line of at most eighty characters and a message cannot be empty', async () => {
    const crowded = await createProject(studio, owner, 'Crowded', {
      features: { automation: true },
    });
    const base = `/api/projects/${crowded.id}/automations`;
    const eventRun = await create(
      {
        name: 'On failure, run',
        timeZone: 'UTC',
        trigger: { type: 'event', event: 'run-failed' },
        action: {
          type: 'agent-run',
          agentId: 'claude-code',
          prompt: 'fix it',
          session: { type: 'new' },
        },
      },
      owner,
      base,
    );
    expect(eventRun.status).toBe(400);
    expect(
      (
        await create(
          {
            name: 'On failure, tell me',
            timeZone: 'UTC',
            trigger: { type: 'event', event: 'run-failed' },
            action: { type: 'notify', message: 'a run failed' },
          },
          owner,
          base,
        )
      ).status,
    ).toBe(201);
    expect(
      (await create({ ...daily, trigger: { type: 'event', event: 'build-failed' } }, owner, base))
        .status,
    ).toBe(400);

    for (const [field, body] of [
      ['empty message', { ...daily, action: { type: 'notify', message: '' } }],
      ['blank message', { ...daily, action: { type: 'notify', message: '   \n ' } }],
      ['empty name', { ...daily, name: '  ' }],
      [
        'empty prompt',
        {
          ...daily,
          action: {
            type: 'agent-run',
            agentId: 'claude-code',
            prompt: ' ',
            session: { type: 'new' },
          },
        },
      ],
      [
        'oversized prompt',
        {
          ...daily,
          action: {
            type: 'agent-run',
            agentId: 'claude-code',
            prompt: 'x'.repeat(16_001),
            session: { type: 'new' },
          },
        },
      ],
      ['unknown action', { ...daily, action: { type: 'send-email', to: 'a@example.test' } }],
      ['acting as someone else', { ...daily, actsAs: owner.userId }],
      ['acting as someone else (createdBy)', { ...daily, createdBy: { id: owner.userId } }],
    ] as const) {
      expect((await create(body, owner, base)).status, field).toBe(400);
    }
    const long = await create({ ...daily, name: `${'n'.repeat(85)}\nsecond line` }, owner, base);
    expect(long.status).toBe(201);
    expect(long.body.name).toHaveLength(80); // cut, and on one line
    expect(long.body.name).not.toContain('\n');

    for (let index = (await listed(owner, base)).automations.length; index < 20; index += 1) {
      expect((await create({ ...daily, name: `Reminder ${index}` }, owner, base)).status).toBe(201);
    }
    expect(await listed(owner, base)).toMatchObject({ limit: 20 });
    const overflow = await create({ ...daily, name: 'One too many' }, owner, base);
    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('automation_limit');
    expect((await listed(owner, base)).automations).toHaveLength(20);
  });

  it('AT-AUT-021: someone without the project finds no automations there; a member of the project sees them but can change, run or delete only their own — the owner can manage any', async () => {
    const mine = (await create({ ...daily, name: 'The owner’s' })).body;
    const outsider = await createMember(studio, owner, 'autooutsider');
    for (const attempt of [
      outsider.get(api),
      outsider.get(`${api}/${mine.id}`),
      outsider.patch(`${api}/${mine.id}`, { enabled: false }),
      outsider.post(`${api}/${mine.id}/run`),
      outsider.delete(`${api}/${mine.id}`),
      outsider.get(`${api}/${mine.id}/runs`),
      create(daily, outsider),
    ]) {
      expect((await attempt).status).toBe(404);
    }
    const reader = await createMember(studio, owner, 'autoreader');
    await shareProject(owner, project.id, reader.userId!, 'read');
    expect((await listed(reader)).automations.map((item: Json) => item.id)).toContain(mine.id);
    expect((await create(daily, reader)).status).toBe(403);

    const colleague = await createMember(studio, owner, 'autocolleague');
    await shareProject(owner, project.id, colleague.userId!, 'write');
    expect((await colleague.get<Json>(`${api}/${mine.id}`)).body.canManage).toBe(false);
    for (const attempt of [
      colleague.patch(`${api}/${mine.id}`, { enabled: false }),
      colleague.post(`${api}/${mine.id}/run`),
      colleague.delete(`${api}/${mine.id}`),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('not_your_automation');
    }
    const theirs = (await create({ ...daily, name: 'The colleague’s' }, colleague)).body;
    expect(theirs).toMatchObject({ canManage: true, createdBy: { id: colleague.userId } });
    const unchanged = (await owner.get<Json>(`${api}/${mine.id}`)).body;
    expect(unchanged).toMatchObject({ enabled: true, name: 'The owner’s', lastRun: null });
    // The owner manages a member's automation; it keeps acting as its creator.
    const byOwner = await owner.patch<Json>(`${api}/${theirs.id}`, { enabled: false });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.createdBy.id).toBe(colleague.userId);
    expect((await studio.client().get(api)).status).toBe(401);
  });

  it('SEC-AUT (unattended agent run): what needs no approval runs; what would need a person’s approval is denied without ever being asked, and reported — on the automation, in the transcript and to the person', async () => {
    const created = await create({
      name: 'Nightly check',
      timeZone: 'UTC',
      trigger: { type: 'daily', time: '03:00' },
      action: {
        type: 'agent-run',
        agentId: 'claude-code',
        prompt:
          'check things [[scenario:bash ls]] [[scenario:bash npm test]] [[scenario:edit-file written-unattended.txt]]',
        session: { type: 'new' },
        permissionMode: 'ask',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.guard).toMatchObject({
      actsAs: { id: owner.userId },
      permissionMode: 'ask',
      behaviour: 'deny-and-report',
      allowed: true,
      refusal: null,
    });
    const execution = await runNow(created.body.id);
    expect(execution).toMatchObject({
      trigger: 'manual',
      outcome: 'denied',
      reason: 'approval-needed',
    });
    expect(execution.sessionId).toMatch(/^[0-9a-z]{26}$/);

    const run = (await owner.get<Json>(`/api/runs/${execution.runId}`)).body;
    expect(run).toMatchObject({
      origin: 'automation',
      unattended: true,
      status: 'completed',
      permissionMode: 'ask',
    });
    const events = await transcript(owner, execution.sessionId);
    // Nobody was asked: no approval record was ever made, none is pending.
    expect(events.filter((event) => event.type === 'approval.requested')).toEqual([]);
    expect(await pendingApprovals(owner, execution.sessionId)).toEqual([]);
    expect(
      events.filter((event) => event.type === 'tool.finished').map((event) => event.data.status),
    ).toEqual(['ok', 'denied', 'denied']); // the listing ran; the command and the edit did not
    const skipped = events.filter(
      (event) => event.type === 'notice' && event.data.code === 'approval_skipped',
    );
    expect(skipped).toHaveLength(2);
    expect(events.find((event) => event.type === 'message.user')!.data.origin).toBe('automation');
    expect(
      (await owner.get(`/api/projects/${project.id}/files/content?path=written-unattended.txt`))
        .status,
    ).toBe(404);
    // The person is told that it finished with denials.
    const told = await until(
      async () =>
        (
          await owner.get<{ notifications: Json[] }>('/api/notifications?order=newest')
        ).body.notifications.find(
          (item) => item.kind === 'run-failed' && item.tag === `automation:${created.body.id}`,
        ),
      {
        what: 'the report of the denied actions',
      },
    );
    expect(told.body).toContain('Nightly check');
    expect(told.body).toMatch(/denied/);
    expect((await owner.get<Json>(`${api}/${created.body.id}`)).body.lastRun).toMatchObject({
      outcome: 'denied',
      reason: 'approval-needed',
    });
  });

  it('SEC-AUT: an unattended run that only reads completes and is reported as finished background work; in "plan" mode even an edit it asks for is refused', async () => {
    const reading = (
      await create({
        name: 'Read-only round',
        timeZone: 'UTC',
        trigger: { type: 'daily', time: '04:00' },
        action: {
          type: 'agent-run',
          agentId: 'claude-code',
          prompt: 'look around [[scenario:bash ls]]',
          session: { type: 'new' },
          permissionMode: 'plan',
        },
      })
    ).body;
    expect(reading.guard).toMatchObject({ behaviour: 'read-only', allowed: true });
    const fine = await runNow(reading.id);
    expect(fine).toMatchObject({ outcome: 'completed', reason: null });
    const told = await until(
      async () =>
        (
          await owner.get<{ notifications: Json[] }>('/api/notifications?order=newest')
        ).body.notifications.find(
          (item) => item.kind === 'background-finished' && item.tag === `automation:${reading.id}`,
        ),
      {
        what: 'the report of the finished run',
      },
    );
    expect(told.body).toContain('Read-only round');

    const writing = (
      await create({
        name: 'Plan that wants to write',
        timeZone: 'UTC',
        trigger: { type: 'daily', time: '04:30' },
        action: {
          type: 'agent-run',
          agentId: 'claude-code',
          prompt: 'change things [[scenario:edit-file written-in-plan.txt]]',
          session: { type: 'new' },
          permissionMode: 'plan',
        },
      })
    ).body;
    const refused = await runNow(writing.id);
    expect(['denied', 'completed']).toContain(refused.outcome);
    const events = await transcript(owner, refused.sessionId);
    expect(
      events.filter((event) => event.type === 'tool.finished').map((event) => event.data.status),
    ).toEqual(['denied']);
    expect(
      (await owner.get(`/api/projects/${project.id}/files/content?path=written-in-plan.txt`))
        .status,
    ).toBe(404);
  });

  it('SEC-AUT: the wider modes need the project owner’s switch — an automation cannot be created in "auto" or "accept edits" without it, and one made with it is refused, not downgraded, once the switch is off again', async () => {
    const action = (permissionMode: string) => ({
      type: 'agent-run',
      agentId: 'claude-code',
      prompt: 'do things [[scenario:edit-file written-by-auto.txt]]',
      session: { type: 'new' },
      permissionMode,
    });
    for (const mode of ['auto', 'accept-edits']) {
      const refused = await create({
        name: `Too wide (${mode})`,
        timeZone: 'UTC',
        trigger: { type: 'daily', time: '05:00' },
        action: action(mode),
      });
      expect(refused.status, mode).toBe(422);
      expect(refused.body.error.code).toBe('mode_not_allowed');
    }
    const options = (await owner.get<Json>(`${api}/options`)).body;
    expect(options).toMatchObject({
      enabled: true,
      canCreate: true,
      autoMode: false,
      actsAs: { id: owner.userId },
    });
    const modes = options.agents.find((agent: Json) => agent.id === 'claude-code').modes as Json[];
    expect(Object.fromEntries(modes.map((mode) => [mode.mode, mode.allowed]))).toEqual({
      plan: true,
      ask: true,
      'accept-edits': false,
      auto: false,
    });

    await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true });
    const wide = await create({
      name: 'Allowed while the switch is on',
      timeZone: 'UTC',
      trigger: { type: 'daily', time: '05:00' },
      action: action('accept-edits'),
    });
    expect(wide.status).toBe(201);
    expect(wide.body.guard).toMatchObject({ behaviour: 'edits-allowed', allowed: true });
    await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: false });
    expect((await owner.get<Json>(`${api}/${wide.body.id}`)).body.guard).toMatchObject({
      allowed: false,
      refusal: 'mode-not-allowed',
    });
    const execution = await runNow(wide.body.id);
    expect(execution).toMatchObject({ outcome: 'denied', reason: 'mode-not-allowed', runId: null });
    expect(
      (await owner.get(`/api/projects/${project.id}/files/content?path=written-by-auto.txt`))
        .status,
    ).toBe(404);
  });

  it('AT-AUT-023 (adapted): "run now" while an execution of the same automation is in progress starts nothing — one run in all', async () => {
    const created = (
      await create({
        name: 'Long job',
        timeZone: 'UTC',
        trigger: { type: 'daily', time: '06:00' },
        action: {
          type: 'agent-run',
          agentId: 'claude-code',
          prompt: 'take a while [[scenario:long 80]]',
          session: { type: 'new' },
          permissionMode: 'plan',
        },
      })
    ).body;
    const first = await owner.post<Json>(`${api}/${created.id}/run`);
    expect(first.body.execution).not.toBeNull();
    const second = await owner.post<Json>(`${api}/${created.id}/run`);
    expect(second.status).toBe(200);
    expect(second.body.execution).toBeNull();
    expect(second.body.automation.running).toBe(true);
    const ended = await until(
      async () => {
        const history = (await owner.get<{ runs: Json[] }>(`${api}/${created.id}/runs`)).body.runs;
        return history.every((run) => run.endedAt !== null) ? history : undefined;
      },
      { timeout: 40_000, what: 'the long execution to end' },
    );
    expect(ended.filter((run) => run.outcome === 'completed')).toHaveLength(1);
    expect(ended.filter((run) => run.runId !== null)).toHaveLength(1);
    const sessions = (
      await owner.get<{ sessions: Json[] }>(`/api/sessions?projectId=${project.id}`)
    ).body.sessions.filter(
      (session) => session.id === ended.find((run) => run.runId !== null)!.sessionId,
    );
    expect(sessions).toHaveLength(1);
  });

  it('AUT-22: an automation that sends into a chosen session uses a session of the same project and agent that its creator may write in — anything else is refused', async () => {
    const mine = await createSession(owner, project.id, 'claude-code');
    const otherProject = await createProject(studio, owner, 'Elsewhere', {
      features: { automation: true },
    });
    const elsewhere = await createSession(owner, otherProject.id, 'claude-code');
    const colleague = await createMember(studio, owner, 'autosessions');
    await shareProject(owner, project.id, colleague.userId!, 'write');
    const theirs = await createSession(colleague, project.id, 'claude-code');
    const into = (sessionId: string, agentId = 'claude-code') => ({
      name: 'Into a session',
      timeZone: 'UTC',
      trigger: { type: 'daily', time: '07:00' },
      action: {
        type: 'agent-run',
        agentId,
        prompt: 'hello [[scenario:bash ls]]',
        session: { type: 'existing', sessionId },
        permissionMode: 'plan',
      },
    });
    for (const [what, body] of [
      ['a session of another project', into(elsewhere.id)],
      ['a session of another agent', into(mine.id, 'codex')],
      ['a session that does not exist', into('0123456789abcdefghjkmnpqrs')],
      [
        'an agent that does not exist',
        { ...into(mine.id), action: { ...into(mine.id).action, agentId: 'no-such-agent' } },
      ],
    ] as const) {
      const refused = await create(body);
      expect(refused.status, what).toBe(422);
    }
    expect((await create(into(theirs.id), owner)).status).toBe(422); // the owner's automation cannot speak in a member's session
    const ok = await create(into(mine.id));
    expect(ok.status).toBe(201);
    const execution = await runNow(ok.body.id);
    expect(execution).toMatchObject({ outcome: 'completed', sessionId: mine.id });
    expect(
      (await transcript(owner, mine.id)).find((event) => event.type === 'message.user')!.data,
    ).toMatchObject({ origin: 'automation', text: 'hello [[scenario:bash ls]]' });
  });

  it('AT-AUT-022: deleting a project deletes its automations with it', async () => {
    const doomed = await createProject(studio, owner, 'Doomed', { features: { automation: true } });
    const base = `/api/projects/${doomed.id}/automations`;
    const created = (await create(daily, owner, base)).body;
    expect((await owner.delete(`/api/projects/${doomed.id}`)).status).toBe(204);
    expect((await owner.get(`${base}/${created.id}`)).status).toBe(404);
    expect((await owner.get(base)).status).toBe(404);
  });
});
