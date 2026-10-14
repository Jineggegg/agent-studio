import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createProject,
  createSession,
  runEnded,
  runToEnd,
  sandboxIsOn,
  SANDBOX_OFF,
  send,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
  type Session,
} from './support/workbench.js';

/**
 * 6.9 — Sessions: listing, finding, naming, pinning, archiving, deleting,
 * drafts and the "unseen" mark (requirements 01 §6.9, §5.2, §5.19, §5.23).
 *
 * Not built in this release (so not tested): session groups, titles proposed
 * inside the agent's prose (AT-WB-096), sessions started outside the product
 * (AT-WB-106…109), fork (AT-WB-152), export (AT-WB-159).
 */
describe('6.9 sessions', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let tablet: ApiClient;
  let project: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    tablet = await studio.owner(); // the same person on a second device
    project = await createProject(studio, owner, 'sessions');
  });
  afterAll(() => studio?.destroy());

  type Row = Session & { lastUserMessageAt: number | null; lastActivityAt: number };
  const list = async (client: ApiClient, query: string) =>
    (await client.get<{ sessions: Row[]; hasMore: boolean }>(`/api/sessions?${query}`)).body;
  const reread = async (id: string, client: ApiClient = owner) =>
    (await client.get<Row>(`/api/sessions/${id}`)).body;

  it('AT-WB-092 (adapted): the history is ordered by the last message the user sent — later agent output does not move an older session up', async () => {
    const shelf = await createProject(studio, owner, 'ordering');
    const older = await createSession(owner, shelf.id);
    const newer = await createSession(owner, shelf.id);
    const untouched = await createSession(owner, shelf.id);
    const slow = await send(owner, older.id, 'asked first [[scenario:long 40]]');
    await runToEnd(owner, newer.id, 'asked second'); // finishes while the older one is still talking
    await runEnded(owner, slow.runId!);

    const a = await reread(older.id);
    const b = await reread(newer.id);
    expect(a.lastActivityAt).toBeGreaterThan(b.lastActivityAt); // the older session has the newest agent output …
    expect(a.lastUserMessageAt!).toBeLessThan(b.lastUserMessageAt!);
    const rows = (await list(owner, `projectId=${shelf.id}`)).sessions.map((row) => row.id);
    expect(rows.indexOf(newer.id)).toBeLessThan(rows.indexOf(older.id)); // … and is still listed below it
    expect(rows).toContain(untouched.id);
    // A session with a run in progress is listed first.
    const busy = await send(owner, older.id, 'again [[scenario:long 40]]');
    const during = (await list(owner, `projectId=${shelf.id}`)).sessions;
    expect(during[0]).toMatchObject({
      id: older.id,
      attention: 'running',
      activeRunId: busy.runId,
    });
    await runEnded(owner, busy.runId!);
  });

  it('AT-WB-093: 120 sessions are read fifty at a time; each page says whether earlier sessions remain', async () => {
    const crowded = await createProject(studio, owner, 'crowded');
    const created: string[] = [];
    for (let index = 0; index < 120; index += 1)
      created.push(
        (await createSession(owner, crowded.id, 'claude-code', { title: `session ${index}` })).id,
      );
    const first = await list(owner, `projectId=${crowded.id}`);
    expect(first.sessions).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = await list(owner, `projectId=${crowded.id}&offset=50`);
    expect(second.sessions).toHaveLength(50);
    expect(second.hasMore).toBe(true);
    const third = await list(owner, `projectId=${crowded.id}&offset=100`);
    expect(third.sessions).toHaveLength(20);
    expect(third.hasMore).toBe(false);
    const seen = [...first.sessions, ...second.sessions, ...third.sessions].map((row) => row.id);
    expect(new Set(seen).size).toBe(120);
    expect([...seen].sort()).toEqual([...created].sort());
    // A page size past the limit is refused rather than silently honoured.
    expect((await owner.get(`/api/sessions?projectId=${crowded.id}&limit=201`)).status).toBe(400);
  });

  it('AT-WB-094: searching titles for "api fix" lists only "Fix API tests"; clearing the search restores the list', async () => {
    const shelf = await createProject(studio, owner, 'titles');
    const deploy = await createSession(owner, shelf.id, 'claude-code', { title: 'Deploy API' });
    const fix = await createSession(owner, shelf.id, 'claude-code', { title: 'Fix API tests' });
    const found = await list(owner, `projectId=${shelf.id}&q=${encodeURIComponent('api fix')}`);
    expect(found.sessions.map((row) => row.title)).toEqual(['Fix API tests']);
    expect(
      (await list(owner, `projectId=${shelf.id}&q=api`)).sessions.map((row) => row.id).sort(),
    ).toEqual([deploy.id, fix.id].sort());
    expect((await list(owner, `projectId=${shelf.id}&q=billing`)).sessions).toEqual([]);
    expect((await list(owner, `projectId=${shelf.id}`)).sessions).toHaveLength(2);
  });

  it('WB-103: a typed title is kept — later messages never rename the session — and an empty or over-long title is refused', async () => {
    const session = await createSession(owner, project.id);
    await runToEnd(owner, session.id, 'first words become the title');
    expect(await reread(session.id)).toMatchObject({
      title: 'first words become the',
      titleSource: 'auto',
    }); // the first four words
    const renamed = await owner.patch<Row>(`/api/sessions/${session.id}`, { title: 'Mine' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Mine', titleSource: 'manual' });
    await runToEnd(owner, session.id, 'a completely different subject');
    expect(await reread(session.id, tablet)).toMatchObject({
      title: 'Mine',
      titleSource: 'manual',
    });
    expect((await owner.patch(`/api/sessions/${session.id}`, { title: '   ' })).status).toBe(400);
    expect(
      (await owner.patch(`/api/sessions/${session.id}`, { title: 'x'.repeat(201) })).status,
    ).toBe(400);
    expect((await reread(session.id)).title).toBe('Mine');
  });

  it('AT-WB-095 (adapted): a title the agent proposes replaces the automatic one on every device; once the owner has renamed the session it stays theirs', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const session = await createSession(owner, project.id, 'codex');
    const other = await Realtime.open(studio, tablet);
    await other.subscribe(`user:${tablet.userId}`);
    await runToEnd(owner, session.id, 'help with the shop [[scenario:rename Checkout redesign]]');
    expect(await reread(session.id)).toMatchObject({
      title: 'Checkout redesign',
      titleSource: 'agent',
    });
    // The other device was told, without asking.
    const told = await other.event(`user:${tablet.userId}`, 'session.updated', {
      where: (frame) =>
        frame.data.session.id === session.id && frame.data.session.title === 'Checkout redesign',
    });
    expect(told.data.session.titleSource).toBe('agent');
    // The proposal travels beside the conversation, never as a line of it.
    expect(
      JSON.stringify(
        (await transcript(owner, session.id)).filter((event) => event.type === 'message.assistant'),
      ),
    ).not.toContain('Checkout redesign');

    expect((await owner.patch(`/api/sessions/${session.id}`, { title: 'Mine' })).status).toBe(200);
    await runToEnd(owner, session.id, 'and now [[scenario:rename Something else]]');
    expect(await reread(session.id)).toMatchObject({ title: 'Mine', titleSource: 'manual' });
    await other.close();
  });

  it('AT-WB-097 (adapted): a session pinned on one device is pinned on the other, and pinned sessions are listed above the rest', async () => {
    const shelf = await createProject(studio, owner, 'pins');
    const first = await createSession(owner, shelf.id, 'claude-code', { title: 'older' });
    const second = await createSession(owner, shelf.id, 'claude-code', { title: 'newer' });
    await runToEnd(owner, first.id, 'one');
    await runToEnd(owner, second.id, 'two');
    expect((await list(owner, `projectId=${shelf.id}`)).sessions.map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);

    const other = await Realtime.open(studio, tablet);
    await other.subscribe(`user:${tablet.userId}`);
    expect(
      (await owner.patch<Row>(`/api/sessions/${first.id}`, { pinned: true })).body.pinned,
    ).toBe(true);
    await other.event(`user:${tablet.userId}`, 'session.updated', {
      where: (frame) => frame.data.session.id === first.id && frame.data.session.pinned === true,
    });
    const rows = (await list(tablet, `projectId=${shelf.id}`)).sessions;
    expect(rows.map((row) => `${row.id}:${row.pinned}`)).toEqual([
      `${first.id}:true`,
      `${second.id}:false`,
    ]);
    expect(
      (await tablet.patch<Row>(`/api/sessions/${first.id}`, { pinned: false })).body.pinned,
    ).toBe(false);
    expect((await list(owner, `projectId=${shelf.id}`)).sessions.map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);
    await other.close();
  });

  it('AT-WB-098: an archived session leaves the list and appears under Archived; restoring brings it back unchanged', async () => {
    const shelf = await createProject(studio, owner, 'archive');
    const session = await createSession(owner, shelf.id);
    await runToEnd(owner, session.id, 'keep me for later');
    const before = await transcript(owner, session.id);
    expect(
      (await owner.patch<Row>(`/api/sessions/${session.id}`, { archived: true })).body.archived,
    ).toBe(true);
    expect((await list(owner, `projectId=${shelf.id}`)).sessions).toEqual([]);
    expect(
      (await list(tablet, `projectId=${shelf.id}&archived=only`)).sessions.map((row) => row.id),
    ).toEqual([session.id]);
    expect(
      (await list(owner, `projectId=${shelf.id}&archived=include`)).sessions.map((row) => row.id),
    ).toEqual([session.id]);
    // Archived is not deleted: its link still opens it.
    expect((await owner.get(`/api/sessions/${session.id}`)).status).toBe(200);
    // Undo / Restore.
    expect(
      (await owner.patch<Row>(`/api/sessions/${session.id}`, { archived: false })).body.archived,
    ).toBe(false);
    expect((await list(owner, `projectId=${shelf.id}`)).sessions.map((row) => row.id)).toEqual([
      session.id,
    ]);
    expect(await transcript(owner, session.id)).toEqual(before);
  });

  it('AT-WB-099: a deleted session is gone — its record, history and link — on every device', async () => {
    const shelf = await createProject(studio, owner, 'delete');
    const session = await createSession(owner, shelf.id);
    const keep = await createSession(owner, shelf.id);
    await runToEnd(owner, session.id, 'delete me afterwards');
    await runToEnd(owner, keep.id, 'leave me alone');
    const other = await Realtime.open(studio, tablet);
    await other.subscribe(`user:${tablet.userId}`);

    const removed = await owner.delete(`/api/sessions/${session.id}`);
    expect(removed.status).toBeLessThan(300);
    const told = await other.event(`user:${tablet.userId}`, 'session.removed');
    expect(told.data).toEqual({ sessionId: session.id, projectId: shelf.id });
    for (const url of [
      `/api/sessions/${session.id}`,
      `/api/sessions/${session.id}/events`,
      `/api/sessions/${session.id}/state`,
      `/api/sessions/${session.id}/usage`,
    ]) {
      const gone = await tablet.get<ErrorBody>(url);
      expect(gone.status, url).toBe(404);
      expect(gone.body.error.code).toBe('session_not_found'); // "no longer exists"
    }
    expect(
      (await list(owner, `projectId=${shelf.id}&archived=include`)).sessions.map((row) => row.id),
    ).toEqual([keep.id]);
    expect(
      (await owner.get<{ hits: unknown[] }>('/api/sessions/search?q=afterwards')).body.hits,
    ).toEqual([]);
    expect(
      (
        await owner.get<{ runs: Array<{ sessionId: string }> }>('/api/runs?state=all')
      ).body.runs.some((run) => run.sessionId === session.id),
    ).toBe(false);
    // Deleting again is "not found"; the neighbour is untouched.
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(404);
    expect((await transcript(owner, keep.id)).length).toBeGreaterThan(0);
    await other.close();
  });

  it('WB-107: deleting a session whose run is in progress ends that run — nothing keeps working for a conversation that no longer exists', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'busy [[scenario:long 300]]');
    const live = await Realtime.open(studio, owner);
    await live.subscribe(`session:${session.id}`);
    await live.event(`session:${session.id}`, 'message.delta');
    const removed = await owner.delete<ErrorBody>(`/api/sessions/${session.id}`);
    expect(removed.status).toBeLessThan(300);
    expect((await owner.get(`/api/sessions/${session.id}`)).status).toBe(404);
    expect(
      (await owner.get<{ runs: Array<{ id: string }> }>('/api/runs?state=active')).body.runs.map(
        (item) => item.id,
      ),
    ).not.toContain(run.runId);
    await live.close();
  });

  it('AT-WB-103: text typed and not sent is kept as a draft that follows the account to another device; clearing it removes the mark', async () => {
    const session = await createSession(owner, project.id);
    const other = await Realtime.open(studio, tablet);
    await other.subscribe(`user:${tablet.userId}`);
    expect((await owner.get<Json>(`/api/sessions/${session.id}/draft`)).body).toMatchObject({
      text: '',
      updatedAt: null,
    });

    const saved = await owner.put<Json>(`/api/sessions/${session.id}/draft`, {
      text: 'half a thought',
    });
    expect(saved.status).toBe(200);
    const hint = await other.event(`user:${tablet.userId}`, 'session.draft');
    expect(hint.data).toMatchObject({ sessionId: session.id, text: 'half a thought' });
    expect((await reread(session.id, tablet)).hasDraft).toBe(true);
    expect((await tablet.get<Json>(`/api/sessions/${session.id}/draft`)).body.text).toBe(
      'half a thought',
    );
    expect(
      (await list(tablet, `projectId=${project.id}`)).sessions.find((row) => row.id === session.id)!
        .hasDraft,
    ).toBe(true);

    expect((await tablet.put(`/api/sessions/${session.id}/draft`, { text: '' })).status).toBe(200);
    expect((await reread(session.id)).hasDraft).toBe(false);
    expect((await owner.get<Json>(`/api/sessions/${session.id}/draft`)).body.text).toBe('');
    expect(
      (await owner.put(`/api/sessions/${session.id}/draft`, { text: 'x'.repeat(100_001) })).status,
    ).toBe(400);
    await other.close();
  });

  it('AT-WB-105/134 (adapted): a run that finishes while its session is not on screen leaves an "unseen" mark; one that finishes in view does not; a failure is flagged until dealt with', async () => {
    const away = await createSession(owner, project.id);
    await runToEnd(owner, away.id, 'finish while I look elsewhere');
    expect((await reread(away.id)).attention).toBe('unseen');
    expect((await reread(away.id, tablet)).attention).toBe('unseen'); // the mark belongs to the account, not the device
    expect((await tablet.post(`/api/sessions/${away.id}/seen`)).status).toBe(200);
    expect((await reread(away.id)).attention).toBe('none');

    // Visibly on screen on some device when the run ends: nothing to mark.
    const watched = await createSession(owner, project.id);
    expect(
      (
        await owner.put('/api/sessions/presence', {
          clientId: 'owner-tab-0001',
          visible: [watched.id],
        })
      ).status,
    ).toBe(204);
    await runToEnd(owner, watched.id, 'finish while I watch');
    expect((await reread(watched.id)).attention).toBe('none');
    // The page is hidden (an empty report) and the next result is unseen again.
    await owner.put('/api/sessions/presence', { clientId: 'owner-tab-0001', visible: [] });
    await runToEnd(owner, watched.id, 'finish after I looked away');
    expect((await reread(watched.id)).attention).toBe('unseen');

    // A failure is never read automatically, even in view.
    const failing = await createSession(owner, project.id);
    await owner.put('/api/sessions/presence', {
      clientId: 'owner-tab-0001',
      visible: [failing.id],
    });
    const failed = await runToEnd(owner, failing.id, 'break [[scenario:crash]]');
    expect(failed.status).toBe('failed');
    expect((await reread(failing.id)).attention).toBe('needs-you');
    await owner.post(`/api/runs/${failed.id}/dismiss`);
    expect((await reread(failing.id)).attention).toBe('none');
    // The presence report is bounded.
    const tooMany = Array.from({ length: 33 }, () => watched.id);
    expect(
      (await owner.put('/api/sessions/presence', { clientId: 'owner-tab-0001', visible: tooMany }))
        .status,
    ).toBe(400);
  });

  it('AT-WB-085: a model picked for an open session is used by the next turn and is what another device sees selected', async () => {
    const session = await createSession(owner, project.id);
    expect(session.model).toBe('default');
    const picked = await owner.patch<Row>(`/api/sessions/${session.id}`, {
      model: 'sonnet',
      effort: 'high',
    });
    expect(picked.status).toBe(200);
    const run = await runToEnd(owner, session.id, 'which model are you?');
    const started = (await transcript(owner, session.id)).find(
      (event) => event.type === 'run.started',
    )!;
    expect(started.data).toMatchObject({ runId: run.id, model: 'sonnet', effort: 'high' });
    expect(
      (await transcript(owner, session.id)).find((event) => event.type === 'message.assistant')!
        .data.model,
    ).toBe('claude-sonnet-standin');
    expect(await reread(session.id, tablet)).toMatchObject({ model: 'sonnet', effort: 'high' });
    // A model chosen with a message becomes the session's recorded choice as well.
    await runToEnd(owner, session.id, 'and now?', { model: 'haiku' });
    expect((await reread(session.id, tablet)).model).toBe('haiku');
  });

  it('AT-WB-158 (adapted): searching what was said finds only conversations that contain the phrase and says which message to jump to', async () => {
    const shelf = await createProject(studio, owner, 'search');
    const match = await createSession(owner, shelf.id);
    const partial = await createSession(owner, shelf.id);
    await runToEnd(owner, match.id, 'please look into the alpha beta rollout');
    await runToEnd(owner, partial.id, 'the alpha release and, later, the beta one');
    const found = await owner.get<{
      hits: Array<{
        sessionId: string;
        seq: number;
        role: string;
        snippet: string;
        matchStart: number;
        matchLength: number;
        title: string;
        projectId: string;
      }>;
    }>(`/api/sessions/search?q=${encodeURIComponent('alpha beta')}&projectId=${shelf.id}`);
    expect(found.status).toBe(200);
    expect(found.body.hits.length).toBeGreaterThan(0);
    expect(new Set(found.body.hits.map((hit) => hit.sessionId))).toEqual(new Set([match.id]));
    const hit = found.body.hits.find((item) => item.role === 'user')!;
    expect(hit.projectId).toBe(shelf.id);
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe(
      'alpha beta',
    );
    // The hit names the event to open the conversation at.
    const events = await transcript(owner, match.id);
    expect(events.find((event) => event.seq === hit.seq)).toMatchObject({ type: 'message.user' });
    // An empty search is refused; one that matches nothing is simply empty.
    expect((await owner.get('/api/sessions/search?q=')).status).toBe(400);
    expect(
      (await owner.get<{ hits: unknown[] }>('/api/sessions/search?q=zeppelin')).body.hits,
    ).toEqual([]);
  });

  it('WB-100: a session is created before its first message, belongs to its project, and an unknown agent or project is refused', async () => {
    const session = await createSession(owner, project.id);
    expect(session).toMatchObject({
      projectId: project.id,
      userId: owner.userId,
      agentId: 'claude-code',
      lastSeq: 0,
      attention: 'none',
      activeRunId: null,
      permissionMode: 'ask',
    });
    expect(
      (await owner.post('/api/sessions', { projectId: project.id, agentId: 'no-such-agent' }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await owner.post<ErrorBody>('/api/sessions', {
          projectId: '0123456789abcdefghjkmnpqrs',
          agentId: 'claude-code',
        })
      ).status,
    ).toBe(404);
    expect((await owner.post('/api/sessions', { projectId: project.id })).status).toBe(400);
  });
});
