import { type Approval, INBOX_EVENT, type NotificationList, type Run, type Session } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { nextRequestId, until } from '../../src/modules/inbox/testing/kit.js';
import { bash, createWorlds, device, idle, notifications, pending } from '../../src/modules/inbox/testing/world.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

describe('what raises a notification', () => {
  it('tells the user when a reply finishes off screen — and says nothing while the session is on screen', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const session = await kit.session(kit.owner, { title: 'Release notes' });

    // Off screen: one stored notification, one push, pointing at the session.
    const run = await kit.turn(kit.owner, session.id, 'summarise the changes since v1.4 for the customer');
    await idle(world);
    const [stored] = await notifications(kit.owner);
    expect(stored).toMatchObject({
      kind: 'reply-finished',
      title: 'Release notes',
      body: 'Scripted agent finished its reply',
      link: `/projects/${kit.project.id}/sessions/${session.id}`,
      targetAvailable: true,
      sessionId: session.id,
      runId: run.id,
      projectId: kit.project.id,
      readAt: null,
    });
    expect(push.payloads(phone)).toEqual([
      { title: 'Release notes', body: 'Scripted agent finished its reply', tag: `reply-finished:${session.id}`, url: `/projects/${kit.project.id}/sessions/${session.id}` },
    ]);

    // Visibly on screen: nothing is raised, and the result is already read.
    push.received.length = 0;
    await kit.owner.post('/api/notifications/clear', { scope: 'all' });
    await kit.looksAt(kit.owner, [session.id]);
    const seen = await kit.turn(kit.owner, session.id, 'and the highlights');
    await idle(world);
    expect(await notifications(kit.owner)).toEqual([]);
    expect(push.received).toEqual([]);
    expect(seen.seenAt).not.toBeNull();

    // The page was put away (tab in the background): it counts as off screen again.
    await kit.looksAt(kit.owner, []);
    await kit.turn(kit.owner, session.id, 'thanks');
    await idle(world);
    expect((await notifications(kit.owner)).map((entry) => entry.kind)).toEqual(['reply-finished']);
    expect(push.to(phone)).toHaveLength(1);
  });

  it('is silenced only by the run\'s own user looking, not by somebody else', async () => {
    const world = await start();
    const { kit, push } = world;
    const member = await kit.t.member('worker');
    await kit.share(kit.project, member);
    const phone = await device(world, member);
    const session = await kit.session(member);

    // The owner may watch a member's session; that must not silence the member's phone.
    await kit.looksAt(kit.owner, [session.id]);
    await kit.turn(member, session.id, 'refactor the parser');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect((await notifications(member)).map((entry) => entry.kind)).toEqual(['reply-finished']);
    // The watching owner gets nothing: it is not their run.
    expect(await notifications(kit.owner)).toEqual([]);
  });

  it('reports a failed run, and sends nothing at all for an event that is switched off', async () => {
    const world = await start();
    const { kit, push, clock } = world;
    const phone = await device(world, kit.owner);
    const quiet = await kit.owner.patch('/api/notifications/preferences', { events: { replyFinished: false } });
    expect(quiet.status).toBe(200);

    const session = await kit.session(kit.owner, { title: 'Nightly build' });
    kit.agent.script([{ text: 'fine' }]);
    await kit.turn(kit.owner, session.id, 'build it');
    await idle(world);
    // Off means off: not stored, not pushed.
    expect(await notifications(kit.owner)).toEqual([]);
    expect(push.received).toEqual([]);

    kit.agent.script([{ fail: { code: 'model_overloaded', message: 'The model refused: quota exceeded for key sk-live-0123456789abcdefghij' } }]);
    const failed = await kit.turn(kit.owner, session.id, 'build it again');
    expect(failed.status).toBe('failed');
    await idle(world);
    const [stored] = await notifications(kit.owner);
    expect(stored).toMatchObject({ kind: 'run-failed', title: 'Nightly build', body: "Scripted agent's run failed", runId: failed.id });
    // The app's own list may show why — with the credential removed.
    expect(stored!.detail).toContain('quota exceeded');
    expect(stored!.detail).not.toContain('sk-live-0123456789abcdefghij');
    // The lock screen does not.
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'Nightly build', body: "Scripted agent's run failed", tag: `run-failed:${session.id}` })]);

    // The same failure again straight away is the same event; later it is news again.
    push.received.length = 0;
    kit.agent.script([{ fail: { code: 'model_overloaded', message: 'again' } }]);
    const again = await kit.turn(kit.owner, session.id, 'retry');
    await kit.owner.post(`/api/runs/${failed.id}/dismiss`);
    await idle(world);
    expect(push.received).toEqual([]);
    clock.advance(21_000);
    kit.agent.script([{ fail: { code: 'model_overloaded', message: 'and again' } }]);
    await kit.owner.post(`/api/runs/${again.id}/dismiss`);
    await kit.turn(kit.owner, session.id, 'retry once more');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
  });

  it('says "needs you" once for the same request, names the tool, and puts the line away when it is answered', async () => {
    const world = await start();
    const { kit, push, clock } = world;
    const phone = await device(world, kit.owner);
    const session = await kit.session(kit.owner, { title: 'Database work' });

    kit.agent.script([{ permission: bash('npm run migrate') }, { permission: bash('npm run seed') }, { permission: bash('npm run verify') }, { permission: bash('npm run report') }, { text: 'done' }]);
    const sent = await kit.send(kit.owner, session.id, 'migrate the database');
    const first = await pending(kit, kit.owner, session.id);
    await idle(world);
    const [stored] = await notifications(kit.owner);
    expect(stored).toMatchObject({ kind: 'needs-you', title: 'Database work', body: 'Scripted agent needs your approval to use Bash', detail: 'npm run migrate', sessionId: session.id });
    // Title = the session's name; body = the assistant, that approval is needed, and the tool. No command.
    expect(push.payloads(phone)).toEqual([
      { title: 'Database work', body: 'Scripted agent needs your approval to use Bash', tag: `needs-you:${session.id}`, url: `/projects/${kit.project.id}/sessions/${session.id}` },
    ]);
    expect(push.to(phone)[0]!.headers.urgency).toBe('high');

    // Two more requests of the same kind within the window: no further notification.
    const decide = async (approval: Approval) => expect((await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' })).status).toBe(200);
    await decide(first);
    const second = await until(async () => (await kit.state(kit.owner, session.id)).pendingApprovals.find((entry) => entry.id !== first.id));
    await decide(second);
    const third = await until(async () => (await kit.state(kit.owner, session.id)).pendingApprovals.find((entry) => entry.id !== first.id && entry.id !== second.id));
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);

    // After the window the same request is news again.
    clock.advance(25_000);
    await decide(third);
    await until(async () => (await kit.state(kit.owner, session.id)).pendingApprovals.find((entry) => ![first.id, second.id, third.id].includes(entry.id)));
    await idle(world);
    expect(push.to(phone)).toHaveLength(2);
    expect((await notifications(kit.owner)).filter((entry) => entry.kind === 'needs-you')).toHaveLength(1);

    // Answered: nothing waits any more, so the line is read without the user touching it.
    const last = (await kit.state(kit.owner, session.id)).pendingApprovals[0]!;
    await decide(last);
    await kit.runEnded(kit.owner, sent.body.runId!);
    const after = (await notifications(kit.owner)).find((entry) => entry.kind === 'needs-you');
    expect(after!.readAt).not.toBeNull();
  });

  it('words a question and a plan as what they are', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const asking = await kit.session(kit.owner, { title: 'Docs' });
    kit.agent.script([{ ask: { questions: [{ id: 'q', question: 'Which section first?', options: [{ label: 'Intro' }, { label: 'API' }], multiSelect: false }] } }]);
    await kit.send(kit.owner, asking.id, 'write the docs');
    const question = await pending(kit, kit.owner, asking.id);

    const planning = await kit.session(kit.owner, { title: 'Refactor', permissionMode: 'plan' });
    kit.agent.script([{ permission: { approval: 'plan', toolName: 'ExitPlanMode', kind: 'other', input: { plan: '1. Delete the legacy module' }, plan: '1. Delete the legacy module' } }]);
    await kit.send(kit.owner, planning.id, 'plan the refactor');
    const plan = await pending(kit, kit.owner, planning.id);
    await idle(world);

    expect(push.payloads(phone)).toEqual([
      expect.objectContaining({ title: 'Docs', body: 'Scripted agent has a question for you' }),
      expect.objectContaining({ title: 'Refactor', body: 'Scripted agent has a plan waiting for you to confirm' }),
    ]);
    // The app's list shows the question; the plan's text stays in the session.
    const stored = await notifications(kit.owner);
    expect(stored.find((entry) => entry.sessionId === asking.id)!.detail).toBe('Which section first?');
    expect(stored.find((entry) => entry.sessionId === planning.id)!.detail).toBeNull();
    await kit.owner.post(`/api/approvals/${question.id}/decision`, { decision: 'deny' });
    await kit.owner.post(`/api/approvals/${plan.id}/decision`, { decision: 'deny' });
  });

  it('tells the owners too when a member\'s request needs an owner', async () => {
    const world = await start();
    const { kit, push } = world;
    const member = await kit.t.member('junior');
    await kit.share(kit.project, member);
    const ownerPhone = await device(world, kit.owner, 'owner-phone');
    const memberPhone = await device(world, member, 'member-phone');
    const session = await kit.session(member, { title: 'Cleanup' });
    kit.agent.script([{ permission: bash('rm -rf build') }]);
    await kit.send(member, session.id, 'clean the build folder');
    const approval = await pending(kit, member, session.id);
    expect(approval.requiresOwner).toBe(true);
    await idle(world);

    expect(push.payloads(memberPhone)).toEqual([expect.objectContaining({ title: 'Cleanup', body: 'Scripted agent needs your approval to use Bash' })]);
    expect(push.payloads(ownerPhone)).toEqual([
      expect.objectContaining({ title: 'Cleanup', body: "Scripted agent needs an owner's approval to use Bash (run by junior)", url: `/projects/${kit.project.id}/sessions/${session.id}` }),
    ]);
    await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
  });

  it('reports unattended work as background work, under its own switch', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(kit.owner.userId!)!;
    const session = await kit.session(kit.owner, { title: 'Reports' });

    const receipt = await agents.sendMessage(principal, session.id, { requestId: nextRequestId(), text: 'nightly report' }, { origin: 'scheduled' });
    await kit.runEnded(kit.owner, receipt.runId!);
    await idle(world);
    expect(push.payloads(phone)).toEqual([expect.objectContaining({ title: 'Reports', body: 'Scripted agent finished its background work', tag: `background-finished:${session.id}` })]);
    expect(push.to(phone)[0]!.headers.urgency).toBe('low');

    // Until it is set, the background switch follows the reply switch.
    push.received.length = 0;
    await kit.owner.patch('/api/notifications/preferences', { events: { replyFinished: false } });
    const second = await agents.sendMessage(principal, session.id, { requestId: nextRequestId(), text: 'nightly report' }, { origin: 'scheduled' });
    await kit.runEnded(kit.owner, second.runId!);
    await idle(world);
    expect(push.received).toEqual([]);
    // Set on its own, it stands on its own.
    await kit.owner.patch('/api/notifications/preferences', { events: { backgroundFinished: true } });
    const third = await agents.sendMessage(principal, session.id, { requestId: nextRequestId(), text: 'nightly report' }, { origin: 'scheduled' });
    await kit.runEnded(kit.owner, third.runId!);
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
  });

  it('does not notify when the user stops their own run', async () => {
    const world = await start();
    const { kit, push } = world;
    await device(world, kit.owner);
    const session = await kit.session();
    kit.agent.script([{ hang: true }]);
    const sent = await kit.send(kit.owner, session.id, 'work for ever');
    await until(async () => (await kit.owner.get<Run>(`/api/runs/${sent.body.runId}`)).body.status === 'running');
    await kit.owner.post(`/api/sessions/${session.id}/stop`);
    await kit.runEnded(kit.owner, sent.body.runId!);
    await idle(world);
    expect(push.received).toEqual([]);
    expect(await notifications(kit.owner)).toEqual([]);
  });

  it('turns a plugin\'s request into a notification, keeping the plugin\'s words off the lock screen', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const bus = kit.t.studio.context.bus;
    const event = { pluginId: 'deploy-watch', pluginName: 'Deploy Watch', userId: kit.owner.userId!, title: 'Deploy of api-7f3c finished', body: 'Duration 4m12s, 0 errors.', projectId: kit.project.id };
    bus.publish('internal:plugins', 'plugin.notification', event);
    await idle(world);

    const [stored] = await notifications(kit.owner);
    expect(stored).toMatchObject({ kind: 'plugin', title: 'Deploy of api-7f3c finished', body: 'Duration 4m12s, 0 errors.', link: `/projects/${kit.project.id}`, projectId: kit.project.id });
    expect(push.payloads(phone)).toEqual([{ title: 'demo', body: 'Deploy Watch sent a notification', tag: `plugin:deploy-watch:${kit.project.id}`, url: `/projects/${kit.project.id}` }]);

    // The switch for plugins is honoured, a malformed event is ignored, and one about a deleted project says nothing.
    push.received.length = 0;
    bus.publish('internal:plugins', 'plugin.notification', { ...event, userId: 'not-an-id' });
    bus.publish('internal:plugins', 'plugin.notification', { ...event, projectId: '0'.repeat(26) });
    await kit.owner.patch('/api/notifications/preferences', { events: { plugin: false } });
    bus.publish('internal:plugins', 'plugin.notification', { ...event, title: 'second' });
    await idle(world);
    expect(push.received).toEqual([]);
    expect(await notifications(kit.owner)).toHaveLength(1);
  });

  it('replaces an older notification about the same session and event instead of stacking', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const first = await kit.session(kit.owner, { title: 'One' });
    const other = await kit.session(kit.owner, { title: 'Two' });
    await kit.turn(kit.owner, first.id, 'a');
    await kit.turn(kit.owner, first.id, 'b');
    await kit.turn(kit.owner, other.id, 'c');
    await idle(world);

    // Three events, two notifications: the device shows one per session.
    const stored = await notifications(kit.owner);
    expect(stored.map((entry) => entry.title).sort()).toEqual(['One', 'Two']);
    const sent = push.to(phone);
    expect(sent).toHaveLength(3);
    expect(push.payloads(phone).map((payload) => payload.tag)).toEqual([`reply-finished:${first.id}`, `reply-finished:${first.id}`, `reply-finished:${other.id}`]);
    // The push service is told the same: an undelivered message is replaced, not queued behind.
    expect(sent[0]!.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(sent[1]!.headers.topic).toBe(sent[0]!.headers.topic);
    expect(sent[2]!.headers.topic).not.toBe(sent[0]!.headers.topic);
  });
});

describe('what a lock screen may show', () => {
  const SECRET_PROMPT = 'rotate the deploy key ghp_abcdefghijklmnopqrstuvwxyz0123 and push to prod';
  const COMMAND = 'curl -H "Authorization: Bearer abcdef0123456789" https://internal.example/deploy';
  const ERROR = 'connection to db.internal.example:5432 refused for user billing_admin';

  async function scenario(showDetails: boolean) {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    if (showDetails) expect((await kit.owner.patch('/api/notifications/preferences', { showDetails: true })).status).toBe(200);

    // A session nobody named: its title is the start of the first message.
    const session = await kit.session();
    kit.agent.script([{ permission: bash(COMMAND) }, { text: 'deployed' }]);
    const sent = await kit.send(kit.owner, session.id, SECRET_PROMPT);
    const approval = await pending(kit, kit.owner, session.id);
    await idle(world);
    await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    await kit.runEnded(kit.owner, sent.body.runId!);
    await idle(world);
    kit.agent.script([{ fail: { code: 'db_down', message: ERROR } }]);
    await kit.turn(kit.owner, session.id, 'check the database');
    await idle(world);
    const title = (await kit.owner.get<Session>(`/api/sessions/${session.id}`)).body.title;
    return { world, phone, payloads: push.payloads(phone), title };
  }

  it('by default: the project, the assistant and what happened — no message, no command, no error text', async () => {
    const { payloads, title } = await scenario(false);
    expect(title).toContain('rotate the deploy key');
    expect(payloads.map((payload) => payload.body)).toEqual([
      'Scripted agent needs your approval to use Bash',
      'Scripted agent finished its reply',
      "Scripted agent's run failed",
    ]);
    // An unnamed session is called by its project's name: the automatic title is message text.
    expect(payloads.map((payload) => payload.title)).toEqual(['demo', 'demo', 'demo']);
    const everything = JSON.stringify(payloads);
    for (const forbidden of ['rotate', 'deploy key', 'ghp_', 'curl', 'Authorization', 'internal.example', 'db.internal', 'billing_admin', 'refused', 'check the database']) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it('with "show details" on: one more line, after the credentials have been taken out', async () => {
    const { payloads } = await scenario(true);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]!.body).toContain('Scripted agent needs your approval to use Bash — curl -H');
    expect(payloads[1]!.body).toContain('Scripted agent finished its reply — rotate the deploy key');
    expect(payloads[2]!.body).toBe(`Scripted agent's run failed — ${ERROR}`);
    expect(payloads[0]!.title).toContain('rotate the deploy key');
    const everything = JSON.stringify(payloads);
    expect(everything).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(everything).not.toContain('abcdef0123456789');
    expect(everything).toContain('[redacted]');
    for (const payload of payloads) expect(payload.body.length).toBeLessThanOrEqual(240);
  });
});

describe('after a restart', () => {
  it('sends one "interrupted" notice per session whose run was cut short, and runs nothing again', async () => {
    const before = await start();
    const phone = await device(before, before.kit.owner);
    const first = await before.kit.session(before.kit.owner, { title: 'Importer' });
    const second = await before.kit.session(before.kit.owner, { title: 'Exporter' });
    const idleSession = await before.kit.session(before.kit.owner, { title: 'Untouched' });
    before.kit.agent.script([{ permission: bash('npm run import') }]).script([{ hang: true }]);
    const a = await before.kit.send(before.kit.owner, first.id, 'import everything');
    await pending(before.kit, before.kit.owner, first.id);
    const b = await before.kit.send(before.kit.owner, second.id, 'export everything');
    await until(async () => (await before.kit.owner.get<Run>(`/api/runs/${b.body.runId}`)).body.status === 'running');
    await before.kit.turn(before.kit.owner, idleSession.id, 'nothing special');
    await idle(before);
    before.push.received.length = 0;

    await before.kit.t.studio.stop();
    const agent = new ScriptedAdapter();
    const after = await start({ kit: { restartOf: before.kit, adapters: [agent] }, push: before.push, clock: before.clock });
    await after.kit.listen();
    await idle(after);

    const payloads = before.push.payloads(phone);
    expect(payloads.map((payload) => [payload.title, payload.body]).sort()).toEqual([
      ['Exporter', "Scripted agent's run was cut short by a restart. Open the session to continue."],
      ['Importer', "Scripted agent's run was cut short by a restart. Open the session to continue."],
    ]);
    expect(payloads.map((payload) => payload.tag).sort()).toEqual([`run-interrupted:${first.id}`, `run-interrupted:${second.id}`].sort());
    expect(agent.runs).toHaveLength(0);
    for (const sent of [a, b]) expect((await after.kit.owner.get<Run>(`/api/runs/${sent.body.runId}`)).body.status).toBe('interrupted');
    // The approval that was waiting is void, and its "needs you" line is not left standing as unread.
    const stored = await notifications(after.kit.owner);
    expect(stored.filter((entry) => entry.kind === 'run-interrupted')).toHaveLength(2);
    expect(stored.find((entry) => entry.kind === 'needs-you')).toMatchObject({ sessionId: first.id, readAt: expect.any(Number) });
  });
});

describe('projects the user can no longer see', () => {
  it('produce no notifications, and existing ones lose their link', async () => {
    const world = await start();
    const { kit, push } = world;
    const member = await kit.t.member('contractor');
    await kit.share(kit.project, member);
    const phone = await device(world, member);
    const session = await kit.session(member, { title: 'Audit' });
    await kit.turn(member, session.id, 'first pass');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect((await notifications(member))[0]).toMatchObject({ targetAvailable: true, link: `/projects/${kit.project.id}/sessions/${session.id}` });

    kit.agent.script([{ gate: 'hold' }, { text: 'late result' }]);
    const sent = await kit.send(member, session.id, 'second pass');
    await kit.agent.reached('hold');
    await kit.share(kit.project, member, null);
    // Taken off the project: the run is stopped, and nothing about that project reaches them any more.
    await until(async () => kit.t.studio.context.services.agents.runs.getRun(kit.t.studio.context.services.agents.principalFor(kit.owner.userId!)!, sent.body.runId!).status !== 'running');
    kit.t.studio.context.bus.publish('internal:plugins', 'plugin.notification', { pluginId: 'p', pluginName: 'P', userId: member.userId!, title: 't', body: 'b', projectId: kit.project.id });
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);

    // What they were told before stays as a line of history — without a way into the project.
    const [stored] = await notifications(member);
    expect(stored).toMatchObject({ kind: 'reply-finished', title: 'Audit', link: '/', targetAvailable: false, sessionId: null, projectId: null, runId: null });
  });
});

describe('a push service that misbehaves', () => {
  it('never fails or delays the run that caused the notification', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const session = await kit.session(kit.owner, { title: 'Steady' });

    push.answer(phone, 500);
    expect((await kit.turn(kit.owner, session.id, 'one')).status).toBe('completed');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);

    // The service sits on the message: the run still ends, and the next one starts.
    const release = push.hold(phone);
    expect((await kit.turn(kit.owner, session.id, 'two')).status).toBe('completed');
    expect((await kit.turn(kit.owner, session.id, 'three')).status).toBe('completed');
    release();
    await idle(world);

    // The service is gone altogether.
    await push.close();
    expect((await kit.turn(kit.owner, session.id, 'four')).status).toBe('completed');
    await idle(world);
    // The app's own list has everything regardless.
    expect((await notifications(kit.owner)).map((entry) => entry.kind)).toEqual(['reply-finished']);
    expect((await kit.owner.get<{ unread: number }>('/api/notifications/unread')).body.unread).toBe(1);
  });
});

describe('stored notifications', () => {
  it('lists, counts, marks read, deletes — each user their own', async () => {
    const world = await start();
    const { kit } = world;
    const member = await kit.t.member('reader');
    await kit.share(kit.project, member);
    const one = await kit.session(kit.owner, { title: 'One' });
    const two = await kit.session(kit.owner, { title: 'Two' });
    const three = await kit.session(kit.owner, { title: 'Three' });
    for (const session of [one, two, three]) await kit.turn(kit.owner, session.id, 'go');
    kit.agent.script([{ fail: { code: 'boom', message: 'it broke' } }]);
    await kit.turn(kit.owner, three.id, 'again');
    const mine = await kit.session(member, { title: 'Member work' });
    await kit.turn(member, mine.id, 'go');

    const all = (await kit.owner.get<NotificationList>('/api/notifications?order=newest')).body;
    expect(all.notifications.map((entry) => [entry.title, entry.kind])).toEqual([
      ['Three', 'run-failed'],
      ['Three', 'reply-finished'],
      ['Two', 'reply-finished'],
      ['One', 'reply-finished'],
    ]);
    expect(all).toMatchObject({ unread: 4, hasMore: false });
    expect((await kit.owner.get<{ unread: number }>('/api/notifications/unread')).body).toEqual({ unread: 4 });

    // One.
    const target = all.notifications[2]!;
    expect((await kit.owner.post(`/api/notifications/${target.id}/read`)).body).toEqual({ changed: 1, unread: 3 });
    expect((await kit.owner.post(`/api/notifications/${target.id}/read`)).body).toEqual({ changed: 0, unread: 3 });
    // Unread first, then by time; paged.
    const page = (await kit.owner.get<NotificationList>('/api/notifications?limit=3')).body;
    expect(page.notifications.map((entry) => entry.title)).toEqual(['Three', 'Three', 'One']);
    expect(page.hasMore).toBe(true);
    expect((await kit.owner.get<NotificationList>('/api/notifications?limit=3&offset=3')).body.notifications.map((entry) => entry.title)).toEqual(['Two']);
    expect((await kit.owner.get<NotificationList>('/api/notifications?unread=only')).body.notifications).toHaveLength(3);

    // By session, then everything.
    expect((await kit.owner.post('/api/notifications/read-all', { sessionId: three.id })).body).toEqual({ changed: 2, unread: 1 });
    expect((await kit.owner.post('/api/notifications/read-all')).body).toEqual({ changed: 1, unread: 0 });

    // Somebody else's notification does not exist for you — reading, marking or deleting.
    const theirs = (await notifications(member))[0]!;
    expect((await kit.owner.post(`/api/notifications/${theirs.id}/read`)).status).toBe(404);
    expect((await kit.owner.delete(`/api/notifications/${theirs.id}`)).status).toBe(404);
    expect((await kit.owner.delete(`/api/notifications/${'0'.repeat(26)}`)).body).toEqual((await kit.owner.delete(`/api/notifications/${theirs.id}`)).body);
    expect((await member.get<{ unread: number }>('/api/notifications/unread')).body).toEqual({ unread: 1 });

    // Delete one; clear what is read; nothing of the member's is touched.
    expect((await kit.owner.delete(`/api/notifications/${target.id}`)).body).toEqual({ changed: 1, unread: 0 });
    expect((await kit.owner.post('/api/notifications/clear')).body).toEqual({ changed: 3, unread: 0 });
    expect(await notifications(kit.owner)).toEqual([]);
    expect(await notifications(member)).toHaveLength(1);

    expect((await kit.t.anonymous().get('/api/notifications')).status).toBe(401);
    expect((await kit.owner.get('/api/notifications?limit=1000')).status).toBe(400);
  });

  it('keeps a bounded number per user, for a bounded time', async () => {
    const world = await start();
    const { kit } = world;
    const inbox = kit.t.studio.context.services.inbox;
    for (let index = 0; index < 205; index += 1) {
      world.clock.advance(1);
      await inbox.notify(kit.owner.userId!, { kind: 'automation', title: 'demo', body: `reminder ${index}`, link: `/projects/${kit.project.id}`, tag: `automation:test-${index}` });
    }
    const first = (await kit.owner.get<NotificationList>('/api/notifications?order=newest&limit=100')).body;
    expect(first.unread).toBe(200);
    expect(first.notifications[0]!.body).toBe('reminder 204');
    const last = (await kit.owner.get<NotificationList>('/api/notifications?order=newest&limit=100&offset=100')).body;
    expect(last.notifications.at(-1)!.body).toBe('reminder 5');
    expect(last.hasMore).toBe(false);

    // …and for a bounded time: a month on, the next notification finds the old ones gone.
    world.clock.advance(31 * 24 * 60 * 60 * 1000);
    await inbox.notify(kit.owner.userId!, { kind: 'automation', title: 'demo', body: 'a month later', link: '/', tag: 'automation:later' });
    expect((await kit.owner.get<NotificationList>('/api/notifications')).body).toMatchObject({ unread: 1, notifications: [{ body: 'a month later' }] });
  });

  it('only ever stores a link into the app', async () => {
    const world = await start();
    const { kit } = world;
    const inbox = kit.t.studio.context.services.inbox;
    const hostile = ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', `/${'a'.repeat(3000)}`, '/a/../../etc', ''];
    for (const [index, link] of hostile.entries()) {
      world.clock.advance(1);
      await inbox.notify(kit.owner.userId!, { kind: 'automation', title: 't', body: 'b', link, tag: `automation:hostile-${index}` });
    }
    world.clock.advance(1);
    await inbox.notify(kit.owner.userId!, { kind: 'automation', title: 't', body: 'b', link: `/projects/${kit.project.id}/automations`, tag: 'automation:fine' });
    const stored = await notifications(kit.owner);
    expect(stored.map((entry) => entry.link)).toEqual([`/projects/${kit.project.id}/automations`, ...hostile.map(() => '/')]);
  });
});

describe('live updates', () => {
  it('tells the user\'s open pages when the inbox or the unread count changes', async () => {
    const world = await start();
    const { kit } = world;
    const me = kit.owner.userId;
    const session = await kit.session(kit.owner, { title: 'Live' });
    kit.agent.script([{ permission: bash('npm test') }, { text: 'ok' }]);
    const sent = await kit.send(kit.owner, session.id, 'run the tests');
    const approval = await pending(kit, kit.owner, session.id);

    const changes = () => kit.userEvents(me, INBOX_EVENT.inboxChanged).map((event) => (event.data as { reason: string }).reason);
    expect(changes()).toContain('run');
    expect(changes()).toContain('approval');
    const added = kit.userEvents(me, INBOX_EVENT.notificationsChanged).at(-1)!;
    expect(added.data).toMatchObject({ unread: 1, reason: 'added', notification: { kind: 'needs-you', sessionId: session.id } });

    await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' });
    const run = await kit.runEnded(kit.owner, sent.body.runId!);
    // The answered request was put away by the server; the finished reply is new.
    expect(kit.userEvents(me, INBOX_EVENT.notificationsChanged).map((event) => (event.data as { reason: string }).reason)).toEqual(['added', 'read', 'added']);

    const before = changes().length;
    expect((await kit.owner.post('/api/inbox/acknowledge', { runId: run.id })).status).toBe(200);
    expect(changes().slice(before)).toContain('acknowledged');
    expect(kit.userEvents(me, INBOX_EVENT.notificationsChanged).at(-1)!.data).toMatchObject({ unread: 0, reason: 'read' });

    // Opening a session elsewhere changes its mark, and with it the inbox.
    const other = await kit.session(kit.owner, { title: 'Other' });
    await kit.turn(kit.owner, other.id, 'go');
    const mark = changes().length;
    await kit.looksAt(kit.owner, [other.id]);
    expect(changes().slice(mark)).toContain('attention');
    // Nobody else hears any of it.
    expect(kit.published.filter((event) => event.type === INBOX_EVENT.inboxChanged && event.topic !== `user:${me}`)).toEqual([]);
  });
});
