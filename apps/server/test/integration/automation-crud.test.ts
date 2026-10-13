import type { Automation, AutomationOptions, SchedulePreview } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { agentRun, automation, createAutomation, createAutomationWorlds, getAutomation, historyOf, listAutomations, reminder } from '../../src/modules/automation/testing/world.js';
import { notifications } from '../../src/modules/inbox/testing/world.js';
import { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createAutomationWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const patch = (client: TestClient, projectId: string, id: string, body: Record<string, unknown>) => client.patch<Automation>(`/api/projects/${projectId}/automations/${id}`, body);

describe('creating an automation', () => {
  it('stores what the form holds and plans the first run in the automation\'s own time zone', async () => {
    // Friday 18:00 in Shanghai.
    const { kit } = await start({ at: '2026-10-16T10:00:00Z' });
    const { owner, project } = kit;
    const created = await createAutomation(owner, project.id, reminder({ name: 'Morning review', timeZone: 'Asia/Shanghai', trigger: { type: 'weekdays', time: '08:00' } }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      projectId: project.id,
      name: 'Morning review',
      enabled: true,
      timeZone: 'Asia/Shanghai',
      trigger: { type: 'weekdays', time: '08:00' },
      action: { type: 'notify', message: 'Stand-up in five minutes' },
      createdBy: { id: owner.userId, displayName: 'owner' },
      canManage: true,
      state: 'scheduled',
      disabledReason: null,
      running: false,
      lastRun: null,
      guard: null,
    });
    // The following Monday, 08:00 in Shanghai.
    expect(iso(created.body.nextRunAt)).toBe('2026-10-19T00:00:00.000Z');

    const list = await listAutomations(owner, project.id);
    expect(list).toMatchObject({ enabled: true, limit: 20 });
    expect(list.automations).toEqual([created.body]);
    expect(await getAutomation(owner, project.id, created.body.id)).toEqual(created.body);
    expect(kit.published.filter((event) => event.type === 'automation.changed')).toEqual([
      expect.objectContaining({ topic: `project:${project.id}`, data: { projectId: project.id, automationId: created.body.id, change: 'created' } }),
    ]);

    // Every kind of trigger is planned from the same instant.
    const next = async (trigger: Record<string, unknown>, timeZone = 'UTC') => iso((await automation(owner, project.id, reminder({ trigger, timeZone }))).nextRunAt);
    expect(await next({ type: 'once', date: '2026-10-17', time: '09:30' }, 'Europe/Berlin')).toBe('2026-10-17T07:30:00.000Z');
    expect(await next({ type: 'hourly', minute: 45 })).toBe('2026-10-16T10:45:00.000Z');
    expect(await next({ type: 'daily', time: '08:00' }, 'America/New_York')).toBe('2026-10-16T12:00:00.000Z');
    expect(await next({ type: 'weekly', days: [0, 3], time: '17:00' })).toBe('2026-10-18T17:00:00.000Z');
    expect(await next({ type: 'cron', expression: '30 6 1 * *' })).toBe('2026-11-01T06:30:00.000Z');
    // An event has no next run: it waits.
    const waiting = await automation(owner, project.id, reminder({ trigger: { type: 'event', event: 'run-failed' } }));
    expect(waiting).toMatchObject({ nextRunAt: null, state: 'waiting' });
    // Created switched off: nothing is planned.
    expect(await automation(owner, project.id, reminder({ enabled: false }))).toMatchObject({ enabled: false, nextRunAt: null, state: 'off' });
  });

  it('refuses a schedule that is malformed, impossible, in the past or too frequent', async () => {
    const { kit } = await start({ at: '2026-10-13T12:00:00Z' });
    const { owner, project } = kit;
    const refused = async (overrides: Record<string, unknown>) => {
      const response = await createAutomation(owner, project.id, reminder(overrides));
      return [response.status, (response.body as unknown as { error: { code: string } }).error.code];
    };
    for (const trigger of [
      { type: 'daily', time: '25:00' },
      { type: 'daily', time: '9:5' },
      { type: 'daily' },
      { type: 'weekly', time: '08:00' },
      { type: 'weekly', days: [], time: '08:00' },
      { type: 'weekly', days: [7], time: '08:00' },
      { type: 'weekly', days: [1, 1], time: '08:00' },
      { type: 'hourly', minute: 60 },
      { type: 'once', date: '2027-02-30', time: '08:00' },
      { type: 'once', date: '13/10/2026', time: '08:00' },
      { type: 'fortnightly', time: '08:00' },
      { type: 'event', event: 'build-failed' },
      { type: 'daily', time: '08:00', seconds: 30 },
    ]) {
      expect(await refused({ trigger }), JSON.stringify(trigger)).toEqual([400, 'invalid_request']);
    }
    expect(await refused({ timeZone: 'Mars/Olympus' })).toEqual([400, 'invalid_request']);
    expect(await refused({ timeZone: undefined })).toEqual([400, 'invalid_request']);
    // Yesterday, and a moment ago.
    expect(await refused({ trigger: { type: 'once', date: '2026-10-12', time: '09:00' } })).toEqual([400, 'time_passed']);
    expect(await refused({ trigger: { type: 'once', date: '2026-10-13', time: '12:00' } })).toEqual([400, 'time_passed']);
    expect(await refused({ trigger: { type: 'cron', expression: 'every morning' } })).toEqual([400, 'invalid_cron']);
    expect(await refused({ trigger: { type: 'cron', expression: '0 8 * * * *' } })).toEqual([400, 'invalid_cron']);
    expect(await refused({ trigger: { type: 'cron', expression: '0 0 31 2 *' } })).toEqual([400, 'never_runs']);
    expect(await refused({ trigger: { type: 'cron', expression: '* * * * *' } })).toEqual([400, 'cron_too_frequent']);
    // An event can only notify.
    expect(await refused({ ...agentRun(), trigger: { type: 'event', event: 'run-failed' } })).toEqual([400, 'invalid_request']);
    expect((await listAutomations(owner, project.id)).automations).toEqual([]);
  });

  it('reduces typed text to one clean, bounded line and refuses what ends up empty', async () => {
    const { kit } = await start();
    const { owner, project } = kit;
    const long = await automation(owner, project.id, reminder({ name: 'N'.repeat(100), action: { type: 'notify', message: 'm'.repeat(300) } }));
    expect(long.name).toBe('N'.repeat(80));
    expect((long.action as { message: string }).message).toBe('m'.repeat(240));
    // Line breaks, control characters and direction overrides do not survive.
    const rlo = String.fromCodePoint(0x202e);
    const messy = await automation(owner, project.id, reminder({ name: `  Deploy\n\treminder\u0007 ${rlo}txt.exe  `, action: { type: 'notify', message: 'line one\r\nline two' } }));
    expect(messy.name).toBe('Deploy reminder txt.exe');
    expect((messy.action as { message: string }).message).toBe('line one line two');

    for (const body of [
      reminder({ name: '   ' }),
      reminder({ name: '\n\t' }),
      reminder({ action: { type: 'notify', message: '  ' } }),
      reminder({ action: { type: 'notify' } }),
      reminder({ action: { type: 'email', to: 'boss@example.com', message: 'hi' } }),
      agentRun({}, { prompt: '   ' }),
      agentRun({}, { prompt: 'p'.repeat(16_001) }),
      agentRun({}, { session: { type: 'existing' } }),
      agentRun({}, { permissionMode: 'yolo' }),
      // There is no way to say who an automation acts as.
      { ...reminder(), createdBy: 'somebody-else' },
      { ...reminder(), actAs: owner.userId },
      agentRun({}, { userId: owner.userId }),
    ]) {
      const response = await createAutomation(owner, project.id, body);
      expect(response.status, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
    // A prompt keeps its line breaks; only what is invisible goes.
    const prompted = await automation(owner, project.id, agentRun({}, { prompt: `  first line\r\nsecond line\u0000${rlo}  ` }));
    expect((prompted.action as { prompt: string }).prompt).toBe('first line\nsecond line');
  });

  it('allows at most twenty per project', async () => {
    const { kit } = await start();
    const { owner, project } = kit;
    for (let index = 0; index < 20; index += 1) await automation(owner, project.id, reminder({ name: `Reminder ${index}` }));
    const extra = await createAutomation(owner, project.id, reminder({ name: 'One too many' }));
    expect(extra.status).toBe(409);
    expect(extra.body).toMatchObject({ error: { code: 'automation_limit' } });
    // Another project has its own allowance; deleting makes room.
    const other = await kit.makeProject('second');
    await automation(owner, other.id, reminder());
    const first = (await listAutomations(owner, project.id)).automations[0]!;
    expect((await owner.delete(`/api/projects/${project.id}/automations/${first.id}`)).status).toBe(204);
    await automation(owner, project.id, reminder({ name: 'Fits now' }));
    expect((await listAutomations(owner, project.id)).automations.map((entry) => entry.name).at(-1)).toBe('Fits now');
  });
});

describe('who may do what', () => {
  it('needs a sign-in; a project the caller cannot see does not exist; read access reads, write access writes', async () => {
    const { kit } = await start();
    const { owner, project } = kit;
    const mine = await automation(owner, project.id, reminder());
    const base = `/api/projects/${project.id}/automations`;
    const attempts = (client: TestClient) => ({
      list: client.get(base),
      options: client.get(`${base}/options`),
      create: client.post(base, reminder()),
      get: client.get(`${base}/${mine.id}`),
      update: client.patch(`${base}/${mine.id}`, { name: 'Renamed' }),
      run: client.post(`${base}/${mine.id}/run`),
      history: client.get(`${base}/${mine.id}/runs`),
      remove: client.delete(`${base}/${mine.id}`),
    });
    const statuses = async (client: TestClient) => {
      const result: Record<string, number> = {};
      for (const [name, pending] of Object.entries(attempts(client))) result[name] = (await pending).status;
      return result;
    };

    expect(await statuses(kit.t.anonymous())).toEqual({ list: 401, options: 401, create: 401, get: 401, update: 401, run: 401, history: 401, remove: 401 });

    const outsider = await kit.t.member('outsider');
    const outside = await statuses(outsider);
    expect(outside).toEqual({ list: 404, options: 404, create: 404, get: 404, update: 404, run: 404, history: 404, remove: 404 });
    // Exactly the answer an unknown project gets.
    expect((await outsider.get(base)).body).toEqual((await outsider.get(`/api/projects/${'0'.repeat(26)}/automations`)).body);

    const reader = await kit.t.member('reader');
    await kit.share(project, reader, 'read');
    expect(await statuses(reader)).toEqual({ list: 200, options: 200, create: 403, get: 200, update: 403, run: 403, history: 200, remove: 403 });
    expect((await reader.post(base, reminder())).body).toMatchObject({ error: { code: 'project_read_only' } });
    expect((await getAutomation(reader, project.id, mine.id)).canManage).toBe(false);
    expect((await reader.get<AutomationOptions>(`${base}/options`)).body.canCreate).toBe(false);

    // Nothing above changed anything.
    expect(await getAutomation(owner, project.id, mine.id)).toMatchObject({ name: 'Stand-up', lastRun: null });
    expect((await listAutomations(owner, project.id)).automations).toHaveLength(1);
  });

  it('a member manages what they created; the owner manages everything', async () => {
    const { kit } = await start();
    const { owner, project } = kit;
    const writer = await kit.t.member('writer');
    const colleague = await kit.t.member('colleague');
    await kit.share(project, writer);
    await kit.share(project, colleague);
    const owners = await automation(owner, project.id, reminder({ name: "Owner's" }));
    const writers = await automation(writer, project.id, reminder({ name: "Writer's" }));
    expect(writers).toMatchObject({ createdBy: { id: writer.userId, displayName: 'writer' }, canManage: true });
    const base = `/api/projects/${project.id}/automations`;

    // Everybody in the project sees both, and sees whose they are.
    const seen = (await listAutomations(colleague, project.id)).automations;
    expect(seen.map((entry) => [entry.name, entry.canManage])).toEqual([
      ["Owner's", false],
      ["Writer's", false],
    ]);

    // Somebody else's: not to be changed, switched, run or deleted — by a member.
    for (const target of [owners, writers]) {
      for (const response of [
        await colleague.patch(`${base}/${target.id}`, { name: 'Hijacked' }),
        await colleague.patch(`${base}/${target.id}`, { enabled: false }),
        await colleague.post(`${base}/${target.id}/run`),
        await colleague.delete(`${base}/${target.id}`),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ error: { code: 'not_your_automation' } });
      }
    }
    expect((await writer.patch(`${base}/${owners.id}`, { name: 'Hijacked' })).status).toBe(403);
    expect((await listAutomations(owner, project.id)).automations.map((entry) => [entry.name, entry.enabled, entry.lastRun])).toEqual([
      ["Owner's", true, null],
      ["Writer's", true, null],
    ]);

    // Their own: all of it.
    expect((await patch(writer, project.id, writers.id, { name: 'Renamed by its creator' })).body.name).toBe('Renamed by its creator');
    // The owner may change a member's automation; it keeps acting as the member.
    const edited = await patch(owner, project.id, writers.id, { name: 'Renamed by the owner' });
    expect(edited.body).toMatchObject({ name: 'Renamed by the owner', createdBy: { id: writer.userId }, canManage: true });
    expect((await owner.delete(`${base}/${writers.id}`)).status).toBe(204);
    expect((await writer.get(`${base}/${writers.id}`)).status).toBe(404);

    // An id from another project finds nothing, whoever asks.
    const other = await kit.makeProject('elsewhere');
    expect((await owner.get(`/api/projects/${other.id}/automations/${owners.id}`)).status).toBe(404);
    expect((await owner.patch(`/api/projects/${other.id}/automations/${owners.id}`, { name: 'x' })).status).toBe(404);
    expect((await owner.delete(`/api/projects/${other.id}/automations/${owners.id}`)).status).toBe(404);
  });

  it('honours the scope of an API token', async () => {
    const { kit } = await start();
    const { owner, project } = kit;
    const base = `/api/projects/${project.id}/automations`;
    const mine = await automation(owner, project.id, reminder());
    const token = async (scopes: string[]) => {
      const client = new TestClient(kit.t.studio);
      client.bearer = (await owner.post<{ token: string }>('/api/auth/tokens', { name: scopes.join('+'), scopes })).body.token;
      return client;
    };

    const readOnly = await token(['read']);
    expect((await readOnly.get(base)).status).toBe(200);
    expect((await readOnly.get(`${base}/${mine.id}/runs`)).status).toBe(200);
    expect((await readOnly.post('/api/automations/preview', { timeZone: 'UTC', trigger: { type: 'daily', time: '08:00' } })).status).toBe(200);
    for (const response of [
      await readOnly.post(base, reminder()),
      await readOnly.patch(`${base}/${mine.id}`, { enabled: false }),
      await readOnly.post(`${base}/${mine.id}/run`),
      await readOnly.delete(`${base}/${mine.id}`),
      await readOnly.post('/api/deferred-messages', { sessionId: '0'.repeat(26), text: 'later', sendAt: Date.now() + 60_000 }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'insufficient_scope' } });
    }
    expect(await getAutomation(owner, project.id, mine.id)).toMatchObject({ enabled: true, lastRun: null });

    // With the write scope it acts as the token's account — and only as that.
    const writing = await token(['read', 'write']);
    const created = await writing.post<Automation>(base, reminder({ name: 'From a script' }));
    expect(created.status).toBe(201);
    expect(created.body.createdBy.id).toBe(owner.userId);
    expect((await new TestClient(kit.t.studio).request('GET', base, undefined, { authorization: 'Bearer ast_nonsense' })).status).toBe(401);
  });
});

describe('switching and editing', () => {
  it('disabling clears the next run, enabling plans it again, and an edit plans it anew', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const created = await automation(owner, project.id, reminder());
    expect(iso(created.nextRunAt)).toBe('2026-10-14T08:00:00.000Z');

    const off = await patch(owner, project.id, created.id, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, nextRunAt: null, state: 'off', disabledReason: null });
    // While it is off nothing happens, however much time passes.
    time.set('2026-10-20T12:00:00Z');
    expect(await world.tick()).toEqual({ automations: 0, deferred: 0 });
    expect((await getAutomation(owner, project.id, created.id)).lastRun).toBeNull();

    // Switched back on: planned from now, not from where it had been.
    const on = await patch(owner, project.id, created.id, { enabled: true });
    expect(on.body).toMatchObject({ enabled: true, state: 'scheduled' });
    expect(iso(on.body.nextRunAt)).toBe('2026-10-21T08:00:00.000Z');

    // A new time, a new zone, a new kind of trigger: each plans again.
    expect(iso((await patch(owner, project.id, created.id, { trigger: { type: 'daily', time: '18:30' } })).body.nextRunAt)).toBe('2026-10-20T18:30:00.000Z');
    expect(iso((await patch(owner, project.id, created.id, { timeZone: 'Asia/Tokyo' })).body.nextRunAt)).toBe('2026-10-21T09:30:00.000Z');
    expect(iso((await patch(owner, project.id, created.id, { trigger: { type: 'weekly', days: [5], time: '09:00' } })).body.nextRunAt)).toBe('2026-10-23T00:00:00.000Z');
    const renamed = await patch(owner, project.id, created.id, { name: 'Weekly review', action: { type: 'notify', message: 'Review the week' } });
    expect(renamed.body).toMatchObject({ name: 'Weekly review', action: { message: 'Review the week' }, timeZone: 'Asia/Tokyo', trigger: { type: 'weekly' } });
    expect(iso(renamed.body.nextRunAt)).toBe('2026-10-23T00:00:00.000Z');

    // What a create refuses, an edit refuses — and nothing changes.
    for (const body of [{}, { trigger: { type: 'daily', time: '24:00' } }, { timeZone: 'Nowhere/Land' }, { name: ' ' }, { trigger: { type: 'cron', expression: '*/2 * * * *' } }, { createdBy: 'x' }, { trigger: { type: 'event', event: 'run-failed' }, action: agentRun().action }]) {
      expect((await patch(owner, project.id, created.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    // Turning a reminder into an event trigger is fine; turning an agent run into one is not.
    const agent = await automation(owner, project.id, agentRun());
    expect((await patch(owner, project.id, agent.id, { trigger: { type: 'event', event: 'run-failed' } })).status).toBe(400);
    expect((await patch(owner, project.id, created.id, { trigger: { type: 'event', event: 'run-failed' } })).body).toMatchObject({ state: 'waiting', nextRunAt: null });
    expect(await getAutomation(owner, project.id, created.id)).toMatchObject({ name: 'Weekly review', timeZone: 'Asia/Tokyo' });
  });

  it('a one-off whose time has passed cannot be switched on again without a new time', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const once = await automation(owner, project.id, reminder({ trigger: { type: 'once', date: '2026-10-13', time: '13:00' } }));
    time.set('2026-10-13T13:00:10Z');
    await world.tick();
    const ran = await getAutomation(owner, project.id, once.id);
    expect(ran).toMatchObject({ enabled: false, nextRunAt: null, state: 'off', disabledReason: 'ran-once', lastRun: { outcome: 'notified' } });

    const again = await patch(owner, project.id, once.id, { enabled: true });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'time_passed' } });
    // Renaming it while it is off is fine.
    expect((await patch(owner, project.id, once.id, { name: 'Done already' })).status).toBe(200);
    // Switching it on together with a time in the past is a bad request; with a later time it is planned.
    expect((await patch(owner, project.id, once.id, { enabled: true, trigger: { type: 'once', date: '2026-10-13', time: '09:00' } })).status).toBe(400);
    const later = await patch(owner, project.id, once.id, { enabled: true, trigger: { type: 'once', date: '2026-10-14', time: '09:00' } });
    expect(later.body).toMatchObject({ enabled: true, state: 'scheduled', disabledReason: null });
    expect(iso(later.body.nextRunAt)).toBe('2026-10-14T09:00:00.000Z');
  });
});

describe('the project\'s automation switch', () => {
  it('when off: nothing can be created, changed or run, what exists stays readable, and what comes due is recorded as not run', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time, push } = world;
    const { owner, project } = kit;
    const existing = await automation(owner, project.id, reminder());
    const base = `/api/projects/${project.id}/automations`;
    expect((await owner.patch(`/api/projects/${project.id}`, { features: { automation: false } })).status).toBe(200);

    for (const response of [await owner.post(base, reminder()), await owner.patch(`${base}/${existing.id}`, { name: 'x' }), await owner.post(`${base}/${existing.id}/run`)]) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: { code: 'automation_disabled' } });
    }
    const list = await listAutomations(owner, project.id);
    expect(list.enabled).toBe(false);
    expect(list.automations).toHaveLength(1);
    expect((await owner.get<AutomationOptions>(`${base}/options`)).body.enabled).toBe(false);

    // It comes due: checked again at that moment, and recorded — nothing is sent.
    time.set('2026-10-14T08:00:05Z');
    expect(await world.tick()).toEqual({ automations: 1, deferred: 0 });
    const after = await getAutomation(owner, project.id, existing.id);
    expect(after.lastRun).toMatchObject({ outcome: 'denied', reason: 'automation-off', summary: 'Not run: automations are switched off for this project.' });
    expect(iso(after.nextRunAt)).toBe('2026-10-15T08:00:00.000Z');
    expect(push.received).toEqual([]);
    expect(await notifications(owner)).toEqual([]);

    // A project created without saying so has the switch off; deleting is always possible.
    const plain = (await owner.post<{ id: string }>('/api/projects', { name: 'plain', rootDir: `${kit.t.workspace}/plain`, createDirectory: true })).body;
    expect((await owner.post(`/api/projects/${plain.id}/automations`, reminder())).body).toMatchObject({ error: { code: 'automation_disabled' } });
    expect((await owner.delete(`${base}/${existing.id}`)).status).toBe(204);

    // An archived project takes no new automations either.
    const archived = await kit.makeProject('archived');
    await owner.patch(`/api/projects/${archived.id}`, { archived: true });
    expect((await owner.post(`/api/projects/${archived.id}/automations`, reminder())).body).toMatchObject({ error: { code: 'project_archived' } });
  });
});

describe('what an agent run may do, as the form is told', () => {
  it('offers plan and ask everywhere, and the modes that change things only where the owner enabled auto mode', async () => {
    const planner = new ScriptedAdapter({ id: 'planner', displayName: 'Planner', permissionModes: ['plan', 'ask'] });
    const main = new ScriptedAdapter();
    const { kit } = await start({ kit: { adapters: [main, planner] } });
    const { owner, project } = kit;
    const base = `/api/projects/${project.id}/automations`;

    const before = (await owner.get<AutomationOptions>(`${base}/options`)).body;
    expect(before).toMatchObject({ enabled: true, canCreate: true, count: 0, limit: 20, autoMode: false, actsAs: { id: owner.userId, displayName: 'owner' }, events: ['run-failed'] });
    const modes = (id: string, options: AutomationOptions) => options.agents.find((agent) => agent.id === id)!.modes.map((mode) => [mode.mode, mode.behaviour, mode.allowed, mode.refusal]);
    expect(modes('scripted', before)).toEqual([
      ['plan', 'read-only', true, null],
      ['ask', 'deny-and-report', true, null],
      ['accept-edits', 'edits-allowed', false, 'auto-mode-off'],
      ['auto', 'auto', false, 'auto-mode-off'],
    ]);
    expect(modes('planner', before)).toEqual([
      ['plan', 'read-only', true, null],
      ['ask', 'deny-and-report', true, null],
      ['accept-edits', 'edits-allowed', false, 'unsupported'],
      ['auto', 'auto', false, 'unsupported'],
    ]);
    expect(before.agents.find((agent) => agent.id === 'scripted')).toMatchObject({ displayName: 'Scripted agent', available: true, problem: null, defaultModel: 'scripted-large' });

    // What the form would not offer, the server does not accept.
    for (const mode of ['accept-edits', 'auto']) {
      const refused = await createAutomation(owner, project.id, agentRun({}, { permissionMode: mode }));
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ error: { code: 'mode_not_allowed' } });
    }
    expect((await createAutomation(owner, project.id, agentRun({}, { agentId: 'planner', permissionMode: 'accept-edits' }))).body).toMatchObject({ error: { code: 'unsupported_permission_mode' } });
    const asking = await automation(owner, project.id, agentRun());
    expect(asking.guard).toEqual({ actsAs: { id: owner.userId, displayName: 'owner' }, permissionMode: 'ask', behaviour: 'deny-and-report', allowed: true, refusal: null });
    // The mode defaults to ask when the form leaves it out.
    const defaulted = await automation(owner, project.id, { ...agentRun(), action: { type: 'agent-run', agentId: 'scripted', prompt: 'Look around.', session: { type: 'new' } } });
    expect(defaulted.guard).toMatchObject({ permissionMode: 'ask', behaviour: 'deny-and-report' });
    expect((await automation(owner, project.id, agentRun({}, { permissionMode: 'plan' }))).guard).toMatchObject({ behaviour: 'read-only', allowed: true });

    // The owner enables auto mode for the project.
    expect((await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true })).status).toBe(200);
    const after = (await owner.get<AutomationOptions>(`${base}/options`)).body;
    expect(after.autoMode).toBe(true);
    expect(modes('scripted', after).map((mode) => mode[2])).toEqual([true, true, true, true]);
    expect(modes('planner', after).map((mode) => mode[2])).toEqual([true, true, false, false]);
    const automatic = await automation(owner, project.id, agentRun({ name: 'Auto-fix' }, { permissionMode: 'auto' }));
    expect(automatic.guard).toMatchObject({ permissionMode: 'auto', behaviour: 'auto', allowed: true, refusal: null });

    // …and takes it back: the automation stays, and says it would be refused.
    await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: false });
    expect((await getAutomation(owner, project.id, automatic.id)).guard).toMatchObject({ allowed: false, refusal: 'mode-not-allowed' });
    expect((await getAutomation(owner, project.id, asking.id)).guard).toMatchObject({ allowed: true });
  });

  it('accepts only an agent offered in the project and a session that is the creator\'s own, in this project, with that agent', async () => {
    const other = new ScriptedAdapter({ id: 'second', displayName: 'Second agent' });
    const main = new ScriptedAdapter();
    const { kit } = await start({ kit: { adapters: [main, other] } });
    const { owner, project } = kit;
    const member = await kit.t.member('worker');
    await kit.share(project, member);
    const elsewhere = await kit.makeProject('elsewhere');
    const restricted = await kit.makeProject('restricted', { agents: ['second'] });

    const code = async (client: TestClient, projectId: string, action: Record<string, unknown>) => {
      const response = await createAutomation(client, projectId, agentRun({}, action));
      return response.status === 201 ? 'created' : (response.body as unknown as { error: { code: string } }).error.code;
    };
    expect(await code(owner, project.id, { agentId: 'does-not-exist' })).toBe('agent_unavailable');
    expect(await code(owner, restricted.id, { agentId: 'scripted' })).toBe('agent_not_enabled');
    expect(await code(owner, restricted.id, { agentId: 'second' })).toBe('created');

    const mine = await kit.session(owner, { title: 'Mine' });
    const members = await kit.session(member, { title: "Member's" });
    const inOtherProject = await kit.session(owner, { title: 'Elsewhere', projectId: elsewhere.id });
    const withOtherAgent = await kit.session(owner, { title: 'Other agent', agentId: 'second' });
    const existing = (sessionId: string) => ({ session: { type: 'existing', sessionId } });
    expect(await code(owner, project.id, existing(mine.id))).toBe('created');
    // The owner can open a member's session, but an automation of the owner's cannot write into it.
    expect(await code(owner, project.id, existing(members.id))).toBe('session_not_usable');
    expect(await code(member, project.id, existing(mine.id))).toBe('session_not_usable');
    expect(await code(owner, project.id, existing(inOtherProject.id))).toBe('session_not_usable');
    expect(await code(owner, project.id, existing(withOtherAgent.id))).toBe('session_not_usable');
    expect(await code(owner, project.id, existing('0'.repeat(26)))).toBe('session_not_usable');
    expect(await code(member, project.id, existing(members.id))).toBe('created');

    // When the owner edits a member's automation, the session must still be the member's.
    const membersAutomation = (await listAutomations(owner, project.id)).automations.find((entry) => entry.createdBy.id === member.userId)!;
    const edit = (sessionId: string) => patch(owner, project.id, membersAutomation.id, { action: { ...agentRun().action as object, ...existing(sessionId) } });
    expect((await edit(mine.id)).body).toMatchObject({ error: { code: 'session_not_usable' } });
    expect((await edit(members.id)).status).toBe(200);
  });
});

describe('the schedule preview', () => {
  it('says when a schedule would fire, without storing anything', async () => {
    const { kit } = await start({ at: '2026-10-30T12:00:00Z' });
    const preview = async (body: Record<string, unknown>) => kit.owner.post<SchedulePreview>('/api/automations/preview', body);
    // Across the night New York's clocks go back: still 08:00 on the clock.
    expect((await preview({ timeZone: 'America/New_York', trigger: { type: 'daily', time: '08:00' } })).body.runs.map(iso)).toEqual([
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
      '2026-11-02T13:00:00.000Z',
      '2026-11-03T13:00:00.000Z',
      '2026-11-04T13:00:00.000Z',
    ]);
    expect((await preview({ timeZone: 'UTC', trigger: { type: 'once', date: '2026-11-05', time: '09:00' } })).body.runs.map(iso)).toEqual(['2026-11-05T09:00:00.000Z']);
    expect((await preview({ timeZone: 'UTC', trigger: { type: 'event', event: 'run-failed' } })).body.runs).toEqual([]);
    expect((await preview({ timeZone: 'UTC', trigger: { type: 'cron', expression: 'whenever' } })).body).toMatchObject({ error: { code: 'invalid_cron' } });
    expect((await preview({ timeZone: 'UTC', trigger: { type: 'cron', expression: '@weekly' } })).body.runs.map(iso)[0]).toBe('2026-11-01T00:00:00.000Z');
    expect((await preview({ timeZone: 'UTC', trigger: { type: 'cron', expression: '   ' } })).status).toBe(400);
    expect((await preview({ timeZone: 'UTC', trigger: { type: 'once', date: '2026-10-01', time: '09:00' } })).body).toMatchObject({ error: { code: 'time_passed' } });
    expect((await preview({ timeZone: 'Atlantis/Central', trigger: { type: 'daily', time: '08:00' } })).status).toBe(400);
    expect((await kit.t.anonymous().post('/api/automations/preview', { timeZone: 'UTC', trigger: { type: 'daily', time: '08:00' } })).status).toBe(401);
    expect((await listAutomations(kit.owner, kit.project.id)).automations).toEqual([]);
  });
});

describe('when what an automation depends on goes away', () => {
  it('a deleted project takes its automations with it, and none of them runs afterwards', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time, push } = world;
    const { owner } = kit;
    const doomed = await kit.makeProject('doomed');
    const kept = await automation(owner, kit.project.id, reminder({ name: 'Kept' }));
    await automation(owner, doomed.id, reminder({ name: 'Doomed reminder' }));
    await automation(owner, doomed.id, agentRun({ name: 'Doomed run' }));
    const session = await kit.session(owner, { title: 'In the doomed project', projectId: doomed.id });
    const deferred = await owner.post('/api/deferred-messages', { sessionId: session.id, text: 'later', sendAt: time.now() + 3_600_000 });
    expect(deferred.status).toBe(201);

    expect((await owner.delete(`/api/projects/${doomed.id}`)).status).toBe(204);
    expect((await owner.get(`/api/projects/${doomed.id}/automations`)).status).toBe(404);
    const db = kit.t.studio.context.db;
    expect(db.all('SELECT id FROM automations WHERE project_id = ?', doomed.id)).toEqual([]);
    expect(db.all('SELECT id FROM deferred_messages WHERE project_id = ?', doomed.id)).toEqual([]);

    // The day after: only what belongs to the surviving project runs.
    time.set('2026-10-14T08:00:05Z');
    expect(await world.tick()).toEqual({ automations: 1, deferred: 0 });
    expect(kit.agent.runs).toHaveLength(0);
    expect(push.received).toEqual([]);
    expect((await historyOf(owner, kit.project.id, kept.id)).map((entry) => entry.outcome)).toEqual(['notified']);
    expect((await notifications(owner)).map((entry) => entry.body)).toEqual(['Stand-up in five minutes']);
  });

  it('a creator who can no longer write in the project has their automations there switched off — and they stay off', async () => {
    const world = await start({ at: '2026-10-13T12:00:00Z' });
    const { kit, time } = world;
    const { owner, project } = kit;
    const member = await kit.t.member('leaver');
    const stayer = await kit.t.member('stayer');
    await kit.share(project, member);
    await kit.share(project, stayer);
    const other = await kit.makeProject('other');
    await kit.share(other, member);
    const theirs = await automation(member, project.id, reminder({ name: "Leaver's reminder" }));
    const theirRun = await automation(member, project.id, agentRun({ name: "Leaver's run" }));
    const elsewhere = await automation(member, other.id, reminder({ name: 'In another project' }));
    const stayers = await automation(stayer, project.id, reminder({ name: "Stayer's" }));
    const owners = await automation(owner, project.id, reminder({ name: "Owner's" }));

    // Reduced to read access.
    await kit.share(project, member, 'read');
    for (const id of [theirs.id, theirRun.id]) {
      expect(await getAutomation(owner, project.id, id)).toMatchObject({ enabled: false, nextRunAt: null, state: 'off', disabledReason: 'access-lost' });
    }
    expect((await getAutomation(owner, project.id, theirRun.id)).guard).toMatchObject({ allowed: false, refusal: 'access-lost' });
    for (const [projectId, id] of [[project.id, stayers.id], [project.id, owners.id], [other.id, elsewhere.id]] as const) {
      expect(await getAutomation(owner, projectId, id)).toMatchObject({ enabled: true, disabledReason: null });
    }
    // The member can still see them, and cannot switch them back on.
    expect((await getAutomation(member, project.id, theirs.id)).canManage).toBe(false);
    expect((await patch(member, project.id, theirs.id, { enabled: true })).status).toBe(403);
    // Neither can the owner on their behalf, while the creator has no write access.
    expect((await patch(owner, project.id, theirs.id, { enabled: true })).body).toMatchObject({ error: { code: 'creator_without_access' } });

    time.set('2026-10-14T08:00:05Z');
    await world.tick();
    expect(await historyOf(owner, project.id, theirs.id)).toEqual([]);
    expect(await historyOf(owner, project.id, theirRun.id)).toEqual([]);
    expect(kit.agent.runs).toHaveLength(0);
    expect((await historyOf(owner, project.id, stayers.id)).map((entry) => entry.outcome)).toEqual(['notified']);

    // Access comes back: nothing switches itself on again; the creator does that.
    await kit.share(project, member, 'write');
    expect(await getAutomation(member, project.id, theirs.id)).toMatchObject({ enabled: false, disabledReason: 'access-lost', canManage: true });
    const back = await patch(member, project.id, theirs.id, { enabled: true });
    expect(back.body).toMatchObject({ enabled: true, disabledReason: null, state: 'scheduled' });
    expect(iso(back.body.nextRunAt)).toBe('2026-10-15T08:00:00.000Z');

    // Taken off the project altogether: the same, and the list is no longer theirs to read.
    await kit.share(project, member, null);
    expect(await getAutomation(owner, project.id, theirs.id)).toMatchObject({ enabled: false, disabledReason: 'access-lost' });
    expect((await member.get(`/api/projects/${project.id}/automations`)).status).toBe(404);
  });

  it('a deleted account takes its automations with it', async () => {
    const { kit } = await start();
    const { owner, project } = kit;
    const member = await kit.t.member('temp');
    await kit.share(project, member);
    await automation(member, project.id, reminder({ name: "Temp's" }));
    await automation(owner, project.id, reminder({ name: "Owner's" }));
    expect((await owner.delete(`/api/users/${member.userId}`)).status).toBe(204);
    expect((await listAutomations(owner, project.id)).automations.map((entry) => entry.name)).toEqual(["Owner's"]);
  });
});
