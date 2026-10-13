import type { Approval, Inbox, InboxItem, InboxSummary, Run, Session } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type StudioKit, until } from '../../src/modules/inbox/testing/kit.js';
import { bash, createWorlds, notifications, pending } from '../../src/modules/inbox/testing/world.js';
import type { TestClient } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const DAY = 24 * 60 * 60 * 1000;

const inbox = async (client: TestClient): Promise<Inbox> => (await client.get<Inbox>('/api/inbox')).body;
const summary = async (client: TestClient): Promise<InboxSummary> => (await client.get<InboxSummary>('/api/inbox/summary')).body;
const flat = (value: Inbox): InboxItem[] => [...value.groups.approvals, ...value.groups.needsHandling, ...value.groups.results, ...value.groups.running];
const acknowledge = (client: TestClient, runId: string) => client.post<{ acknowledged: true; alreadyHandled: boolean }>('/api/inbox/acknowledge', { runId });

async function failedRun(kit: StudioKit, client: TestClient, sessionId: string, message = 'The build broke.'): Promise<Run> {
  kit.agent.script([{ fail: { code: 'build_failed', message } }]);
  return kit.turn(client, sessionId, 'build the project');
}

async function runningRun(kit: StudioKit, client: TestClient, sessionId: string, gate: string): Promise<string> {
  kit.agent.script([{ gate }, { text: 'done' }]);
  const sent = await kit.send(client, sessionId, 'a long job');
  await kit.agent.reached(gate);
  return sent.body.runId!;
}

describe('the task inbox', () => {
  it('lists what waits, what failed, what is unread and what runs — in that order, and nothing older than three days', async () => {
    const world = await start();
    const { kit, clock } = world;
    const { owner } = kit;
    const waiting = await kit.session(owner, { title: 'Waiting for me' });
    const broken = await kit.session(owner, { title: 'Broken build' });
    const finished = await kit.session(owner, { title: 'Finished work' });
    const busy = await kit.session(owner, { title: 'Still going' });

    kit.agent.script([{ permission: bash('npm run deploy -- --token=hunter2hunter2') }]);
    const asked = await kit.send(owner, waiting.id, 'deploy the thing');
    const approval = await pending(kit, owner, waiting.id);
    const failed = await failedRun(kit, owner, broken.id, 'Compilation failed in src/app.ts: password=hunter2hunter2 leaked');
    const done = await kit.turn(owner, finished.id, 'write the changelog for the release');
    const going = await runningRun(kit, owner, busy.id, 'inbox-order');

    // A day later everything is still there.
    clock.advance(DAY);
    const read = await inbox(owner);
    expect(flat(read).map((item) => [item.kind, item.title])).toEqual([
      ['approval', 'Waiting for me'],
      ['needs-handling', 'Broken build'],
      ['result', 'Finished work'],
      ['running', 'Still going'],
    ]);
    expect(read.counts).toEqual({ approvals: 1, needsHandling: 1, results: 1, running: 1 });
    expect(read.truncated).toBe(false);
    expect(read.checkedAt).toBeGreaterThan(Date.now());

    const [approvalItem, failedItem, resultItem, runningItem] = flat(read);
    expect(approvalItem).toMatchObject({
      id: `approval:${approval.id}`,
      runId: asked.body.runId,
      sessionId: waiting.id,
      projectId: kit.project.id,
      projectName: 'demo',
      userId: owner.userId,
      agentId: 'scripted',
      agentName: 'Scripted agent',
      preview: 'deploy the thing',
      runStatus: 'running',
      link: `/projects/${kit.project.id}/sessions/${waiting.id}`,
      approval: { id: approval.id, kind: 'tool', toolName: 'Bash', requiresOwner: false, expiresAt: expect.any(Number) },
      acknowledgeable: false,
    });
    expect(failedItem).toMatchObject({ id: `needs-handling:${failed.id}`, runStatus: 'failed', interruptedByRestart: false, acknowledgeable: true, approval: null });
    expect(resultItem).toMatchObject({ id: `result:${done.id}`, runStatus: 'completed', preview: 'write the changelog for the release', acknowledgeable: true, error: null });
    expect(runningItem).toMatchObject({ id: `running:${going}`, runStatus: 'running', acknowledgeable: false });

    // Only names, a prompt preview, the tool's name and a shortened, cleaned error leave the server.
    const everything = JSON.stringify(read);
    expect(everything).not.toContain('hunter2hunter2');
    expect(everything).not.toContain('npm run deploy');
    expect(failedItem!.error).toContain('Compilation failed in src/app.ts');

    // Five days on: the unread result has aged out of the list (it is still in its session); the rest has not.
    clock.advance(4 * DAY);
    expect(flat(await inbox(owner)).map((item) => item.kind)).toEqual(['approval', 'needs-handling', 'running']);
    expect((await owner.get<Run>(`/api/runs/${done.id}`)).body.seenAt).toBeNull();

    kit.agent.open('inbox-order');
    await kit.runEnded(owner, going);
    await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
    await kit.runEnded(owner, asked.body.runId!);
  });

  it('shows one result per session, under the name the session was given from its first message', async () => {
    const { kit } = await start();
    const session = await kit.session();
    await kit.turn(kit.owner, session.id, 'first question about the importer');
    const second = await kit.turn(kit.owner, session.id, 'second question about the importer');
    const results = (await inbox(kit.owner)).groups.results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: second.id, preview: 'second question about the importer' });
    expect(results[0]!.title).toContain('first question about');

    // While the session is busy again, its earlier result is not offered as "new".
    const going = await runningRun(kit, kit.owner, session.id, 'busy-again');
    const now = await inbox(kit.owner);
    expect(now.counts).toMatchObject({ results: 0, running: 1 });
    kit.agent.open('busy-again');
    await kit.runEnded(kit.owner, going);
  });

  it('is each person\'s own — also for the owner, except for what only an owner can approve', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const member = await kit.t.member('colleague');
    const outsider = await kit.t.member('outsider');
    await kit.share(kit.project, member);
    const mine = await kit.session(owner, { title: "Owner's own" });
    const theirs = await kit.session(member, { title: "Member's work" });
    const theirFailure = await kit.session(member, { title: "Member's failure" });
    await kit.turn(owner, mine.id, 'owner task');
    await kit.turn(member, theirs.id, 'member task');
    const memberFailure = await failedRun(kit, member, theirFailure.id);

    expect(flat(await inbox(member)).map((item) => [item.kind, item.title])).toEqual([
      ['needs-handling', "Member's failure"],
      ['result', "Member's work"],
    ]);
    // The owner may open anybody's session, but the inbox is not a list of everybody's work.
    expect(flat(await inbox(owner)).map((item) => item.title)).toEqual(["Owner's own"]);
    expect(flat(await inbox(outsider))).toEqual([]);
    expect((await summary(outsider)).status).toEqual({ code: 'clear', count: 0 });

    // A member's dangerous request can only be allowed by an owner: it is addressed to the owners, so they see it.
    await member.post(`/api/runs/${memberFailure.id}/dismiss`);
    kit.agent.script([{ permission: bash('rm -rf build') }, { permission: bash('npm run lint') }]);
    const sent = await kit.send(member, theirs.id, 'clean up');
    const dangerous = await pending(kit, member, theirs.id);
    expect(dangerous.requiresOwner).toBe(true);
    const ownerView = await inbox(owner);
    expect(ownerView.groups.approvals).toEqual([
      expect.objectContaining({ title: "Member's work", userId: member.userId, approval: expect.objectContaining({ id: dangerous.id, requiresOwner: true, toolName: 'Bash' }) }),
    ]);
    expect((await inbox(member)).groups.approvals).toHaveLength(1);
    // An ordinary request of the member is the member's alone.
    await owner.post(`/api/approvals/${dangerous.id}/decision`, { decision: 'deny' });
    const ordinary = await until(async () => (await kit.state(member, theirs.id)).pendingApprovals.find((entry) => entry.id !== dangerous.id));
    expect(ordinary.requiresOwner).toBe(false);
    expect((await inbox(owner)).groups.approvals).toEqual([]);
    expect((await inbox(member)).groups.approvals).toHaveLength(1);
    await member.post(`/api/approvals/${ordinary.id}/decision`, { decision: 'deny' });
    await kit.runEnded(member, sent.body.runId!);

    expect((await kit.t.anonymous().get('/api/inbox')).status).toBe(401);
    expect((await kit.t.anonymous().get('/api/inbox/summary')).status).toBe(401);
  });

  it('does not list what has no page to open: archived or deleted sessions, archived or lost projects', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const member = await kit.t.member('mover');
    const elsewhere = await kit.makeProject('elsewhere');
    await kit.share(kit.project, member);
    await kit.share(elsewhere, member);
    const archived = await kit.session(member, { title: 'Archived session' });
    const deleted = await kit.session(member, { title: 'Deleted session' });
    const inArchivedProject = await kit.session(member, { title: 'In an archived project', projectId: elsewhere.id });
    const kept = await kit.session(member, { title: 'Kept' });
    for (const session of [archived, deleted, inArchivedProject, kept]) await failedRun(kit, member, session.id);
    expect((await inbox(member)).counts.needsHandling).toBe(4);

    expect((await member.patch(`/api/sessions/${archived.id}`, { archived: true })).status).toBe(200);
    expect((await member.delete(`/api/sessions/${deleted.id}`)).status).toBe(204);
    expect((await owner.patch(`/api/projects/${elsewhere.id}`, { archived: true })).status).toBe(200);
    expect((await inbox(member)).groups.needsHandling.map((item) => item.title)).toEqual(['Kept']);

    // Taken off the project: nothing of it is listed for them any more.
    await kit.share(kit.project, member, null);
    expect(flat(await inbox(member))).toEqual([]);
  });

  it('shows an approval only while it is live: after a restart the run needs handling instead', async () => {
    const before = await start();
    const session = await before.kit.session(before.kit.owner, { title: 'Was waiting' });
    before.kit.agent.script([{ permission: bash('npm run migrate') }]);
    const sent = await before.kit.send(before.kit.owner, session.id, 'migrate');
    const approval = await pending(before.kit, before.kit.owner, session.id);
    expect((await inbox(before.kit.owner)).groups.approvals).toHaveLength(1);

    await before.kit.t.studio.stop();
    const after = await start({ kit: { restartOf: before.kit, adapters: [new ScriptedAdapter()] }, push: before.push, clock: before.clock });
    await after.kit.listen();
    const read = await inbox(after.kit.owner);
    expect(read.groups.approvals).toEqual([]);
    expect(read.groups.needsHandling).toEqual([
      expect.objectContaining({ runId: sent.body.runId, runStatus: 'interrupted', interruptedByRestart: true, acknowledgeable: true, error: expect.stringContaining('restarted') }),
    ]);
    // The approval is history: it cannot be answered any more, from anywhere.
    expect((await after.kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'allow' })).status).toBe(409);
    expect(after.kit.agent.runs).toHaveLength(0);
  });
});

describe('the summary for the home tile', () => {
  it('says what waits, else what is new, else what runs', async () => {
    const { kit } = await start();
    const { owner } = kit;
    expect(await summary(owner)).toMatchObject({ counts: { approvals: 0, needsHandling: 0, results: 0, running: 0 }, waiting: 0, status: { code: 'clear', count: 0 }, line: 'Nothing waiting', unreadNotifications: 0 });

    // Two running.
    const a = await kit.session(owner, { title: 'A' });
    const b = await kit.session(owner, { title: 'B' });
    const runA = await runningRun(kit, owner, a.id, 'sum-a');
    const runB = await runningRun(kit, owner, b.id, 'sum-b');
    expect(await summary(owner)).toMatchObject({ status: { code: 'running', count: 2 }, line: '2 in progress' });

    // Three results (the two above and one more).
    kit.agent.open('sum-a');
    kit.agent.open('sum-b');
    await kit.runEnded(owner, runA);
    await kit.runEnded(owner, runB);
    const c = await kit.session(owner, { title: 'C' });
    await kit.turn(owner, c.id, 'go');
    expect(await summary(owner)).toMatchObject({ status: { code: 'results', count: 3 }, line: '3 new results', unreadNotifications: 3 });

    // One approval and one failure on top: two wait, and that is what the tile says.
    const d = await kit.session(owner, { title: 'D' });
    const e = await kit.session(owner, { title: 'E' });
    await failedRun(kit, owner, d.id);
    kit.agent.script([{ permission: bash('npm publish') }]);
    const sent = await kit.send(owner, e.id, 'publish');
    const approval = await pending(kit, owner, e.id);
    expect(await summary(owner)).toMatchObject({ counts: { approvals: 1, needsHandling: 1, results: 3, running: 0 }, waiting: 2, status: { code: 'waiting', count: 2 }, line: '2 waiting' });

    // In the user's language.
    await owner.patch('/api/preferences', { values: { 'appearance.language': 'zh-CN' } });
    expect((await summary(owner)).line).toBe('2 项待处理');
    await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
    await kit.runEnded(owner, sent.body.runId!);
  });
});

describe('acknowledging', () => {
  it('refuses what is running or waiting for an answer — and the request is neither approved nor denied', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const waiting = await kit.session(owner, { title: 'Waiting' });
    kit.agent.script([{ permission: bash('npm run deploy') }, { text: 'deployed' }]);
    const asked = await kit.send(owner, waiting.id, 'deploy');
    const approval = await pending(kit, owner, waiting.id);
    const busy = await kit.session(owner, { title: 'Busy' });
    const going = await runningRun(kit, owner, busy.id, 'ack-running');

    for (const runId of [asked.body.runId!, going]) {
      const refused = await acknowledge(owner, runId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: { code: 'task_in_progress' } });
    }
    expect((await owner.post('/api/inbox/acknowledge-results', { runIds: [asked.body.runId!, going] })).body).toEqual({ acknowledged: 0 });
    // Nothing moved: the request still waits, undecided; the agent was told nothing; the other run still runs.
    expect((await owner.get<Approval>(`/api/approvals/${approval.id}`)).body).toMatchObject({ status: 'pending', decidedBy: null });
    expect(kit.agent.runs[0]!.decisions).toEqual([]);
    expect((await owner.get<Run>(`/api/runs/${going}`)).body.status).toBe('running');
    expect((await inbox(owner)).counts).toEqual({ approvals: 1, needsHandling: 0, results: 0, running: 1 });

    kit.agent.open('ack-running');
    await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
    await kit.runEnded(owner, asked.body.runId!);
    await kit.runEnded(owner, going);
  });

  it('puts a result away with the session\'s earlier results, once', async () => {
    const world = await start();
    const { kit } = world;
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Two results' });
    const first = await kit.turn(owner, session.id, 'one');
    const second = await kit.turn(owner, session.id, 'two');
    expect((await notifications(owner)).filter((entry) => entry.readAt === null)).toHaveLength(1);

    const done = await acknowledge(owner, second.id);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ acknowledged: true, alreadyHandled: false });
    expect((await inbox(owner)).counts.results).toBe(0);
    for (const run of [first, second]) expect((await owner.get<Run>(`/api/runs/${run.id}`)).body.seenAt).not.toBeNull();
    // What the notifications said about that session is read with it.
    expect((await notifications(owner)).filter((entry) => entry.readAt === null)).toEqual([]);

    // Again — perhaps from another device: fine, and said so.
    expect((await acknowledge(owner, second.id)).body).toEqual({ acknowledged: true, alreadyHandled: true });
    expect((await acknowledge(owner, first.id)).body).toEqual({ acknowledged: true, alreadyHandled: true });
    // Nothing was run by any of it.
    expect(kit.agent.runs).toHaveLength(2);
  });

  it('marks a failure handled without continuing it', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Failure' });
    const failed = await failedRun(kit, owner, session.id);
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body.attention).toBe('needs-you');

    expect((await acknowledge(owner, failed.id)).body).toEqual({ acknowledged: true, alreadyHandled: false });
    const run = (await owner.get<Run>(`/api/runs/${failed.id}`)).body;
    expect(run).toMatchObject({ status: 'failed', continuedByRunId: null });
    expect(run.dismissedAt).not.toBeNull();
    expect((await inbox(owner)).counts.needsHandling).toBe(0);
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body.attention).toBe('none');
    expect((await acknowledge(owner, failed.id)).body).toEqual({ acknowledged: true, alreadyHandled: true });
    expect(kit.agent.runs).toHaveLength(1);
  });

  it('refuses to put a failure away when that would send the messages queued behind it', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Queue behind a failure' });
    kit.agent.script([{ gate: 'then-fail' }, { fail: { code: 'boom', message: 'It broke.' } }]);
    const sent = await kit.send(owner, session.id, 'do the risky thing');
    await kit.agent.reached('then-fail');
    const queued = await kit.send(owner, session.id, 'and then delete the old data');
    expect(queued.body.disposition).toBe('queued');
    kit.agent.open('then-fail');
    const failed = await kit.runEnded(owner, sent.body.runId!);
    expect(failed.status).toBe('failed');

    const refused = await acknowledge(owner, failed.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'queue_waiting' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The queued message was not sent behind the user's back, and the failure still needs handling.
    expect(kit.agent.runs).toHaveLength(1);
    expect((await kit.state(owner, session.id)).queue.map((item) => item.text)).toEqual(['and then delete the old data']);
    expect((await inbox(owner)).counts.needsHandling).toBe(1);
  });

  it('"mark all read" touches exactly the unread results among the ids', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const results: Run[] = [];
    for (const title of ['R1', 'R2', 'R3']) {
      const session = await kit.session(owner, { title });
      results.push(await kit.turn(owner, session.id, 'go'));
    }
    const brokenSession = await kit.session(owner, { title: 'Broken' });
    const failed = await failedRun(kit, owner, brokenSession.id);
    const waitingSession = await kit.session(owner, { title: 'Waiting' });
    kit.agent.script([{ permission: bash('npm run deploy') }]);
    const asked = await kit.send(owner, waitingSession.id, 'deploy');
    const approval = await pending(kit, owner, waitingSession.id);
    expect((await inbox(owner)).counts).toEqual({ approvals: 1, needsHandling: 1, results: 3, running: 0 });

    const marked = await owner.post('/api/inbox/acknowledge-results', { runIds: [...results.map((run) => run.id), failed.id, asked.body.runId!] });
    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({ acknowledged: 3 });
    expect((await inbox(owner)).counts).toEqual({ approvals: 1, needsHandling: 1, results: 0, running: 0 });
    expect((await owner.get<Run>(`/api/runs/${failed.id}`)).body.dismissedAt).toBeNull();
    expect((await owner.get<Approval>(`/api/approvals/${approval.id}`)).body.status).toBe('pending');
    // Again: nothing left to mark.
    expect((await owner.post('/api/inbox/acknowledge-results', { runIds: results.map((run) => run.id) })).body).toEqual({ acknowledged: 0 });

    // None, too many, or the same id twice: refused.
    expect((await owner.post('/api/inbox/acknowledge-results', { runIds: [] })).status).toBe(400);
    expect((await owner.post('/api/inbox/acknowledge-results', { runIds: Array.from({ length: 101 }, (_unused, index) => String(index).padStart(26, '0')) })).status).toBe(400);
    expect((await owner.post('/api/inbox/acknowledge-results', { runIds: [results[0]!.id, results[0]!.id] })).status).toBe(400);
    await owner.post(`/api/approvals/${approval.id}/decision`, { decision: 'deny' });
    await kit.runEnded(owner, asked.body.runId!);
  });

  it('answers somebody else\'s run exactly like one that does not exist — the owner included', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const member = await kit.t.member('first');
    const other = await kit.t.member('second');
    await kit.share(kit.project, member);
    await kit.share(kit.project, other);
    const session = await kit.session(member, { title: "Member's" });
    const result = await kit.turn(member, session.id, 'go');
    const failed = await failedRun(kit, member, session.id);

    const unknown = await acknowledge(other, '0'.repeat(26));
    expect(unknown.status).toBe(404);
    for (const client of [other, owner]) {
      for (const run of [result, failed]) {
        const answer = await acknowledge(client, run.id);
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual(unknown.body);
      }
      expect((await client.post('/api/inbox/acknowledge-results', { runIds: [result.id] })).body).toEqual({ acknowledged: 0 });
    }
    expect((await member.get<Run>(`/api/runs/${result.id}`)).body.seenAt).toBeNull();
    expect((await member.get<Run>(`/api/runs/${failed.id}`)).body.dismissedAt).toBeNull();
    expect((await acknowledge(owner, 'not-an-id')).status).toBe(400);
    expect((await kit.t.anonymous().post('/api/inbox/acknowledge', { runId: result.id })).status).toBe(401);
  });

  it('opening a session reads its results; a failure stays until it is handled', async () => {
    const { kit } = await start();
    const { owner } = kit;
    const session = await kit.session(owner, { title: 'Opened' });
    await kit.turn(owner, session.id, 'go');
    const other = await kit.session(owner, { title: 'Failed' });
    await failedRun(kit, owner, other.id);
    expect((await inbox(owner)).counts).toMatchObject({ results: 1, needsHandling: 1 });

    await kit.looksAt(owner, [session.id, other.id]);
    expect((await inbox(owner)).counts).toMatchObject({ results: 0, needsHandling: 1 });

    // A run that ends while its session is on screen never becomes a "new result".
    await kit.turn(owner, session.id, 'again');
    expect((await inbox(owner)).counts.results).toBe(0);
  });
});
