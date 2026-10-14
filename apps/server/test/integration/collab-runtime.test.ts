import { readFileSync } from 'node:fs';
import type { ActivitySummary, Attachment, Inbox, MessageSearchHit, Notification, Run, Session, UsageReport } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollabWorlds, errorOf, until } from '../../src/modules/collab/testing/kit.js';
import type { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

/**
 * What the collab module needed from the agent runtime and added there:
 * helper sessions, background for a new session, the chain of a session,
 * removing a session and copying attachments — each through the service other
 * modules use, `context.services.agents`.
 */

const worlds = createCollabWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const runsOf = async (client: TestClient, query: string): Promise<Run[]> => (await client.get<{ runs: Run[] }>(`/api/runs?${query}`)).body.runs;
const inboxCounts = async (client: TestClient): Promise<Inbox['counts']> => (await client.get<Inbox>('/api/inbox')).body.counts;
const ended = (client: TestClient, runId: string): Promise<Run> =>
  until(async () => {
    const run = (await client.get<Run>(`/api/runs/${runId}`)).body;
    return run.status !== 'accepted' && run.status !== 'running' ? run : null;
  });

describe('helper sessions', () => {
  it('are in nobody\'s lists and announce nothing, while what they use is recorded', async () => {
    const agent = new ScriptedAdapter({ nativeSessionId: 'native-helper-conversation' });
    const world = await start({ kit: { adapters: [agent] } });
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member();
    await kit.share(project, member, 'write');
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const ordinary = await kit.session(owner, { title: 'An ordinary conversation' });
    const published = kit.published.length;

    const helper = await agents.createSession(principal, { projectId: project.id, agentId: 'scripted', permissionMode: 'plan', title: 'Helper' }, { hidden: true });
    agent.script([
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 4000, outputTokens: 321, costUsd: 0.02 } },
      { text: 'needlehaystack is what the helper says' },
      { gate: 'helper-works' },
      { text: 'done' },
    ]);
    const receipt = await agents.sendMessage(principal, helper.id, { requestId: 'helper-request-1', text: 'summarise the needlehaystack' }, { origin: 'automation' });
    await agent.reached('helper-works');

    // While it runs: not a conversation anybody has, and not a run anybody lists.
    for (const query of ['archived=include', 'archived=only', 'archived=include&scope=all', `projectId=${project.id}`, 'q=Helper']) {
      expect((await world.sessions(owner, query)).map((session) => session.id), query).not.toContain(helper.id);
    }
    expect((await world.sessions(owner)).map((session) => session.id)).toEqual([ordinary.id]);
    for (const state of ['active', 'all', 'unresolved']) expect((await runsOf(owner, `state=${state}`)).map((run) => run.id)).not.toContain(receipt.runId);
    expect((await owner.get<ActivitySummary>('/api/sessions/activity')).body.projects).toEqual([]);
    expect((await world.inbox(owner)).counts).toEqual({ approvals: 0, needsHandling: 0, results: 0, running: 0 });
    expect((await world.running(owner)).runs).toEqual([]);
    expect((await owner.get<{ hits: MessageSearchHit[] }>('/api/sessions/search?q=needlehaystack')).body.hits).toEqual([]);

    // Its creator reaches it by naming it; nobody else does.
    expect((await owner.get<Session>(`/api/sessions/${helper.id}`)).status).toBe(200);
    expect((await owner.get<Run>(`/api/runs/${receipt.runId}`)).body).toMatchObject({ status: 'running', origin: 'automation', unattended: true, permissionMode: 'plan' });
    expect((await runsOf(owner, `state=all&sessionId=${helper.id}`)).map((run) => run.id)).toEqual([receipt.runId]);
    expect(errorOf(await member.get(`/api/sessions/${helper.id}`))).toEqual([404, 'session_not_found']);

    agent.open('helper-works');
    expect((await ended(owner, receipt.runId!)).status).toBe('completed');
    // A finished helper run is not a result waiting to be read, and nobody is notified of it.
    expect((await world.inbox(owner)).counts).toEqual({ approvals: 0, needsHandling: 0, results: 0, running: 0 });
    expect((await owner.get<{ notifications: Notification[] }>('/api/notifications')).body.notifications).toEqual([]);

    // Nothing about it went to anybody's devices or to the modules that follow runs…
    const told = kit.published.slice(published).filter((event) => event.topic.startsWith('user:') || event.topic.startsWith('internal:'));
    expect(told.filter((event) => JSON.stringify(event.data).includes(helper.id))).toEqual([]);
    expect(told.filter((event) => JSON.stringify(event.data).includes(receipt.runId!))).toEqual([]);
    // …while its own topic carries the whole run, for whoever created it.
    const own = kit.published.filter((event) => event.topic === `session:${helper.id}`).map((event) => event.type);
    expect(own).toEqual(expect.arrayContaining(['message.user', 'run.started', 'usage.reported', 'message.assistant', 'run.finished']));

    // What it used is in the records a usage report adds up.
    const report = (await owner.get<UsageReport>('/api/usage/report')).body;
    expect(report.totals).toMatchObject({ inputTokens: 4000, outputTokens: 321, runs: 1, sessions: 1, cost: { usd: 0.02, coverage: 'complete' } });

    // Removing it takes the agent's own copy along and leaves the record of what was spent.
    await agents.removeSession(principal, helper.id);
    expect(errorOf(await owner.get(`/api/sessions/${helper.id}`))).toEqual([404, 'session_not_found']);
    expect(agent.deletedNativeSessions).toEqual(['native-helper-conversation']);
    expect((await owner.get<UsageReport>('/api/usage/report')).body.totals).toMatchObject({ inputTokens: 4000, outputTokens: 321, runs: 1 });
    expect(kit.userEvents(owner.userId, 'session.removed')).toEqual([]);
    expect(kit.userEvents(owner.userId, 'session.created').map((event) => (event.data as { session: Session }).session.id)).toEqual([ordinary.id]);
  });

  it('are offered none of the Studio\'s tools, and a failure of theirs asks nobody for attention', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project, agent } = kit;
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;

    // An ordinary run sees the Studio's tools (shared memory among them)…
    const offered: number[] = [];
    const ordinary = await kit.session(owner);
    agent.script([{ do: (run) => void offered.push(run.host.studioTools.list().length) }, { text: 'ok' }]);
    await kit.turn(owner, ordinary.id, 'what can you use?');
    expect(offered[0]).toBeGreaterThan(0);
    const published = kit.published.length;

    // …a helper run sees none, and cannot call one by guessing its name.
    const helper = await agents.createSession(principal, { projectId: project.id, agentId: 'scripted', permissionMode: 'plan' }, { hidden: true });
    agent.script([
      { do: (run) => void offered.push(run.host.studioTools.list().length) },
      { studioTool: { name: 'memory_search', input: { query: 'anything' } } },
      { fail: { code: 'rate_limited', message: 'The provider said to slow down.' } },
    ]);
    const receipt = await agents.sendMessage(principal, helper.id, { requestId: 'helper-request-2', text: 'summarise' }, { origin: 'automation' });
    expect(await ended(owner, receipt.runId!)).toMatchObject({ status: 'failed', error: { code: 'rate_limited' } });
    expect(offered[1]).toBe(0);
    expect(agent.lastRun.toolResults).toEqual([{ text: 'This run has no tools.', isError: true }]);

    // A failed run of a helper is nobody's task to handle.
    expect((await world.inbox(owner)).counts).toEqual({ approvals: 0, needsHandling: 0, results: 1, running: 0 });
    expect((await world.inbox(owner)).groups.results.map((item) => item.sessionId)).toEqual([ordinary.id]);
    expect(await runsOf(owner, 'state=unresolved')).toEqual([]);
    expect((await owner.get<ActivitySummary>('/api/sessions/activity')).body.projects.flatMap((entry) => entry.attention)).toEqual([]);
    const notifications = (await owner.get<{ notifications: Notification[] }>('/api/notifications')).body.notifications;
    expect(notifications.map((notification) => notification.sessionId)).toEqual([ordinary.id]);
    expect(kit.published.slice(published).filter((event) => event.topic.startsWith('internal:') && JSON.stringify(event.data).includes(helper.id))).toEqual([]);
    // By its id the failure is there to be read.
    expect((await runsOf(owner, `state=unresolved&sessionId=${helper.id}`)).map((run) => run.id)).toEqual([receipt.runId]);
  });

  it('do not outlive the process that made them: what a crash leaves behind is removed at the next start', async () => {
    const before = await start({ kit: { adapters: [new ScriptedAdapter({ nativeSessionId: 'native-left-behind' })] } });
    await before.kit.listen();
    const { owner, project } = before.kit;
    const agents = before.kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const ordinary = await before.kit.session(owner);
    const helper = await agents.createSession(principal, { projectId: project.id, agentId: 'scripted', permissionMode: 'plan' }, { hidden: true });
    before.kit.agent.script([{ emit: { type: 'usage', model: 'scripted-large', inputTokens: 700, outputTokens: 70 } }, { text: 'half way' }, { hang: true }]);
    await agents.sendMessage(principal, helper.id, { requestId: 'helper-left-behind', text: 'summarise' }, { origin: 'automation' });
    await until(async () => (await owner.get<UsageReport>('/api/usage/report')).body.totals.inputTokens === 700);

    // The server goes down in the middle of the helper's run.
    await before.kit.t.studio.stop();
    const agent = new ScriptedAdapter({ nativeSessionId: 'native-left-behind' });
    const after = await start({ kit: { restartOf: before.kit, adapters: [agent] } });
    await after.kit.listen();
    const again = after.kit.owner;
    expect(errorOf(await again.get(`/api/sessions/${helper.id}`))).toEqual([404, 'session_not_found']);
    expect(agent.deletedNativeSessions).toEqual(['native-left-behind']);
    expect((await again.get<{ sessions: Session[] }>('/api/sessions?archived=include&scope=all')).body.sessions.map((session) => session.id)).toEqual([ordinary.id]);
    // Nobody is told about an interruption they could do nothing with, and nothing ran again.
    expect((await inboxCounts(again)).needsHandling).toBe(0);
    const told = after.kit.published.filter((event) => event.topic.startsWith('user:') || event.topic.startsWith('internal:'));
    expect(told.filter((event) => JSON.stringify(event.data ?? null).includes(helper.id))).toEqual([]);
    expect(agent.runs).toHaveLength(0);
    // What it had used by then is still counted.
    expect((await again.get<UsageReport>('/api/usage/report')).body.totals).toMatchObject({ inputTokens: 700, outputTokens: 70, runs: 1 });
  });

  it('can be removed only by their creator or the instance owner', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member();
    const other = await kit.t.member();
    await kit.share(project, member, 'write');
    await kit.share(project, other, 'write');
    const agents = kit.t.studio.context.services.agents;
    const asMember = agents.principalFor(member.userId!)!;
    const asOther = agents.principalFor(other.userId!)!;
    const asOwner = agents.principalFor(owner.userId!)!;
    const first = await agents.createSession(asMember, { projectId: project.id, agentId: 'scripted' }, { hidden: true });
    const second = await kit.session(member);

    await expect(agents.removeSession(asOther, first.id)).rejects.toMatchObject({ status: 404, code: 'session_not_found' });
    await expect(agents.removeSession(asOther, second.id)).rejects.toMatchObject({ status: 404, code: 'session_not_found' });
    expect((await member.get(`/api/sessions/${first.id}`)).status).toBe(200);

    // A run in progress is stopped first, exactly as the route does it.
    kit.agent.script([{ hang: true }]);
    const sent = await kit.send(member, second.id, 'work for ever');
    await until(() => kit.agent.runs.length > 0 && agents.isRunning(second.id));
    await agents.removeSession(asMember, second.id);
    expect(kit.agent.lastRun.cancelled).toBe(true);
    expect(errorOf(await member.get(`/api/sessions/${second.id}`))).toEqual([404, 'session_not_found']);
    expect(sent.status).toBe(202);
    await agents.removeSession(asOwner, first.id);
    expect(errorOf(await member.get(`/api/sessions/${first.id}`))).toEqual([404, 'session_not_found']);
  });
});

describe('background for a new session', () => {
  const SEED = '<<<BACKGROUND>>>\nThe earlier conversation decided to use SQLite.\n<<<END_BACKGROUND>>>';

  it('goes out in front of the first message, stays out of the transcript, and heads the history afterwards', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project, agent } = kit;
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const session = await agents.createSession(principal, { projectId: project.id, agentId: 'scripted' }, { seed: SEED });
    // A client can neither read it nor set it.
    expect(JSON.stringify((await owner.get(`/api/sessions/${session.id}`)).body)).not.toContain('SQLite');
    expect((await owner.post('/api/sessions', { projectId: project.id, agentId: 'scripted', seed: 'client text' })).status).toBe(201);

    agent.script([{ text: 'Understood.' }]);
    const first = await kit.turn(owner, session.id, 'Carry on with the schema.');
    expect(agent.runs[0]!.request.prompt.text).toBe(`${SEED}\n\nCarry on with the schema.`);
    expect(agent.runs[0]!.request.history).toEqual([]);
    // The transcript has the person's own words, and so has the run.
    const events = await world.events(owner, session.id);
    expect(events.filter((event) => event.type === 'message.user').map((event) => (event.data as { text: string }).text)).toEqual(['Carry on with the schema.']);
    expect(first.text).toBe('Carry on with the schema.');
    expect(JSON.stringify(events)).not.toContain('SQLite');

    // Once the agent has answered, the background is not sent again: it heads the history instead.
    agent.script([{ text: 'Second answer.' }]);
    await kit.turn(owner, session.id, 'And the indexes?');
    expect(agent.runs[1]!.request.prompt.text).toBe('And the indexes?');
    expect(agent.runs[1]!.request.history).toEqual([
      { role: 'user', text: SEED },
      { role: 'user', text: 'Carry on with the schema.' },
      { role: 'assistant', text: 'Understood.' },
    ]);
    // A session created without it is as it always was.
    const plain = await kit.session(owner);
    await kit.turn(owner, plain.id, 'Hello.');
    expect(agent.lastRun.request.prompt.text).toBe('Hello.');
    expect(agent.lastRun.request.history).toEqual([]);
  });

  it('is given again when the first run failed before the agent had it', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project, agent } = kit;
    const agents = kit.t.studio.context.services.agents;
    const session = await agents.createSession(agents.principalFor(owner.userId!)!, { projectId: project.id, agentId: 'scripted' }, { seed: SEED });
    agent.script([{ fail: { code: 'not_signed_in', message: 'Sign in first.' } }]);
    const failed = await kit.turn(owner, session.id, 'First try.');
    expect(failed.status).toBe('failed');

    agent.script([{ text: 'Now it works.' }]);
    await kit.turn(owner, session.id, 'Second try.');
    expect(agent.runs[1]!.request.prompt.text).toBe(`${SEED}\n\nSecond try.`);
    // The history is what was said — without the background a second time.
    expect(agent.runs[1]!.request.history).toEqual([{ role: 'user', text: 'First try.' }]);

    agent.script([{ text: 'Third.' }]);
    await kit.turn(owner, session.id, 'Third try.');
    expect(agent.runs[2]!.request.prompt.text).toBe('Third try.');
    expect(agent.runs[2]!.request.history[0]).toEqual({ role: 'user', text: SEED });
  });

  it('is not repeated to an agent that resumes a conversation of its own', async () => {
    const agent = new ScriptedAdapter({ nativeSessionId: 'native-conversation-7' });
    const world = await start({ kit: { adapters: [agent] } });
    const { kit } = world;
    const { owner, project } = kit;
    const agents = kit.t.studio.context.services.agents;
    const session = await agents.createSession(agents.principalFor(owner.userId!)!, { projectId: project.id, agentId: 'scripted' }, { seed: SEED });
    // The first run ends badly, but the agent had already opened its conversation — with the background in it.
    agent.script([{ text: 'Started.' }, { fail: { code: 'agent_error', message: 'Broke halfway.' } }]);
    await kit.turn(owner, session.id, 'Begin.');
    expect(agent.runs[0]!.request.prompt.text.startsWith(SEED)).toBe(true);
    agent.script([{ text: 'Resumed.' }]);
    await kit.turn(owner, session.id, 'Go on.');
    expect(agent.runs[1]!.request.nativeSessionId).toBe('native-conversation-7');
    expect(agent.runs[1]!.request.prompt.text).toBe('Go on.');
  });

  it('is bounded', async () => {
    const world = await start();
    const { kit } = world;
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(kit.owner.userId!)!;
    await expect(agents.createSession(principal, { projectId: kit.project.id, agentId: 'scripted' }, { seed: 'x'.repeat(60_001) })).rejects.toThrow('too long');
    await expect(agents.createSession(principal, { projectId: kit.project.id, agentId: 'scripted' }, { seed: 'x'.repeat(60_000) })).resolves.toMatchObject({ agentId: 'scripted' });
  });
});

describe('the chain of a session', () => {
  it('lists the sessions that continue one another, oldest first, and keeps the rest together when one is deleted', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const post = async (parentSessionId?: string): Promise<Session> =>
      (await owner.post<Session>('/api/sessions', { projectId: project.id, agentId: 'scripted', ...(parentSessionId ? { parentSessionId } : {}) })).body;
    const a = await post();
    const alone = await post();
    expect(agents.sessions.chain(principal, alone.id).map((session) => session.id)).toEqual([alone.id]);
    const b = await post(a.id);
    const c = await post(b.id);
    await agents.createSession(principal, { projectId: project.id, agentId: 'scripted', parentSessionId: c.id }, { hidden: true });

    for (const asked of [a.id, b.id, c.id]) expect(agents.sessions.chain(principal, asked).map((session) => session.id), asked).toEqual([a.id, b.id, c.id]);
    expect(agents.sessions.chain(principal, c.id).map((session) => [session.chainId, session.parentSessionId])).toEqual([[null, null], [a.id, a.id], [a.id, b.id]]);

    // The middle goes: the two that remain are still one conversation, in order.
    expect((await owner.delete(`/api/sessions/${b.id}`)).status).toBe(204);
    expect(agents.sessions.chain(principal, c.id).map((session) => session.id)).toEqual([a.id, c.id]);
    expect(agents.sessions.chain(principal, a.id).map((session) => session.id)).toEqual([a.id, c.id]);
    // The first goes too: what is left is a chain of one that still knows where it came from.
    expect((await owner.delete(`/api/sessions/${a.id}`)).status).toBe(204);
    expect(agents.sessions.chain(principal, c.id).map((session) => [session.id, session.chainId])).toEqual([[c.id, a.id]]);
  });

  it('is only for those who may see the session', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member();
    const stranger = await kit.t.member();
    await kit.share(project, member, 'write');
    const agents = kit.t.studio.context.services.agents;
    const first = await kit.session(member);
    const second = (await member.post<Session>('/api/sessions', { projectId: project.id, agentId: 'scripted', parentSessionId: first.id })).body;
    const ids = (userId: string | null, sessionId: string) => agents.sessions.chain(agents.principalFor(userId!)!, sessionId).map((session) => session.id);
    expect(ids(member.userId, second.id)).toEqual([first.id, second.id]);
    expect(ids(owner.userId, first.id)).toEqual([first.id, second.id]);
    expect(() => ids(stranger.userId, first.id)).toThrow('No such session.');
    // Access to the project is gone: so is the chain.
    await kit.share(project, member, null);
    expect(() => ids(member.userId, first.id)).toThrow('No such session.');
  });
});

describe('copying attachments into another session', () => {
  it('gives the other session files of its own and leaves the originals unsent', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, agent } = kit;
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const from = await kit.session(owner);
    const to = await kit.session(owner);
    const notes = await world.upload(owner, from.id, 'notes.txt', 'remember the milk');
    const plan = await world.upload(owner, from.id, 'plan.md', '# plan');

    const copies = await agents.copyAttachments(principal, [notes, plan], to.id);
    expect(copies).toHaveLength(2);
    expect(copies).not.toContain(notes);
    const listed = async (sessionId: string) => (await owner.get<{ attachments: Attachment[] }>(`/api/sessions/${sessionId}/attachments`)).body.attachments;
    expect((await listed(to.id)).map((attachment) => [attachment.id, attachment.name, attachment.size, attachment.pending])).toEqual([
      [copies[0], 'notes.txt', 17, true],
      [copies[1], 'plan.md', 6, true],
    ]);
    expect((await listed(from.id)).map((attachment) => [attachment.id, attachment.pending])).toEqual([[notes, true], [plan, true]]);

    // The copy goes out with a message there; the agent reads the same bytes.
    agent.script([{ text: 'read' }]);
    await kit.turn(owner, to.id, 'look at these', { attachmentIds: copies });
    const given = agent.lastRun.request.prompt.attachments;
    expect(given.map((attachment) => attachment.name)).toEqual(['notes.txt', 'plan.md']);
    expect(readFileSync(given[0]!.path, 'utf8')).toBe('remember the milk');
    expect(given[0]!.path).toContain(to.id);
    // The original is still there to be sent where it was uploaded.
    agent.script([{ text: 'read' }]);
    await kit.turn(owner, from.id, 'and here', { attachmentIds: [notes] });
    expect(agent.lastRun.request.prompt.attachments.map((attachment) => attachment.id)).toEqual([notes]);
  });

  it('refuses files that are not the caller\'s own unsent uploads', async () => {
    const world = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member();
    await kit.share(project, member, 'write');
    const agents = kit.t.studio.context.services.agents;
    const asOwner = agents.principalFor(owner.userId!)!;
    const asMember = agents.principalFor(member.userId!)!;
    const mine = await kit.session(owner);
    const target = await kit.session(owner);
    const theirs = await kit.session(member);
    const upload = await world.upload(owner, mine.id, 'mine.txt', 'mine');
    const foreign = await world.upload(member, theirs.id, 'theirs.txt', 'theirs');
    const missing = { status: 422, code: 'attachment_not_found' };

    // Somebody else's file — also for the instance owner, who may read the session but not send from it.
    await expect(agents.copyAttachments(asOwner, [foreign], target.id)).rejects.toMatchObject(missing);
    await expect(agents.copyAttachments(asMember, [upload], theirs.id)).rejects.toMatchObject(missing);
    await expect(agents.copyAttachments(asOwner, ['0123456789abcdefghjkmnpqrs'], target.id)).rejects.toMatchObject(missing);
    // Into a session the caller cannot write in.
    await expect(agents.copyAttachments(asOwner, [upload], theirs.id)).rejects.toMatchObject({ status: 403, code: 'not_your_session' });
    // A file that has gone out already.
    await kit.turn(owner, mine.id, 'sent', { attachmentIds: [upload] });
    await expect(agents.copyAttachments(asOwner, [upload], target.id)).rejects.toMatchObject({ status: 422, code: 'attachment_already_sent' });
    expect((await owner.get<{ attachments: Attachment[] }>(`/api/sessions/${target.id}/attachments`)).body.attachments).toEqual([]);
  });
});
