import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime, until, type Frame } from './support/realtime.js';
import { SETUP_TOKEN, type ApiClient, type RunningStudio } from './support/studio.js';
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
  type Json,
  type Project,
  type StoredEvent,
} from './support/workbench.js';

/**
 * 6.3 — The live stream, reconnecting and several clients (requirements 01
 * §6.3, §5.1, §5.5).
 *
 * A session's stored events are numbered 1, 2, 3 … across all its runs. A
 * client subscribes to `session:<id>`; with `after: n` the server first
 * replays everything numbered above n and then continues live. Text deltas are
 * live only (no number): the stored `message.assistant` replaces them, and the
 * `subscribed` snapshot carries the text streamed so far.
 *
 * Deliberate difference from the documents: there is no per-run cursor
 * ("run id + sequence") — one number orders the whole conversation, so the
 * scenarios about cursors are adapted to it.
 */

/** Asserts that numbered frames are exactly first, first+1, … with no gap and no repeat. */
function expectContiguous(frames: Array<{ seq?: number }>, first: number): void {
  expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_frame, index) => first + index));
}

const summary = (event: { seq?: number; type?: string }) => `${event.seq}:${event.type}`;

describe('6.3 live stream, reconnect, several clients', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'stream');
  });
  afterAll(() => studio?.destroy());

  it('AT-WB-032 (adapted): prose, a file edit, a command and prose arrive in that order, numbered without gaps, each tool call opened and closed once', async () => {
    const session = await createSession(owner, project.id, 'claude-code', {
      permissionMode: 'accept-edits',
    });
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const receipt = await send(
      owner,
      session.id,
      'go [[scenario:thinking]] [[scenario:edit-file a.txt]] [[scenario:bash ls]]',
    );
    const finished = await live.event(topic, 'run.finished');
    expect(finished.data).toMatchObject({ runId: receipt.runId, status: 'completed' });
    expect(finished.data.durationMs).toBeGreaterThan(0);

    const numbered = live.durable(topic);
    expectContiguous(numbered, 1);
    const kinds = numbered
      .filter((frame) => frame.type !== 'usage.reported')
      .map((frame) => frame.type);
    expect(kinds).toEqual([
      'message.user',
      'run.started',
      'thinking',
      'message.assistant', // prose
      'tool.started', // the edit
      'tool.finished',
      'message.assistant',
      'tool.started', // the command
      'tool.finished',
      'message.assistant', // prose
      'run.finished',
    ]);
    const [edit, command] = numbered.filter((frame) => frame.type === 'tool.started');
    expect(edit!.data).toMatchObject({ kind: 'edit', title: 'Write a.txt' });
    expect(command!.data).toMatchObject({ kind: 'execute', title: 'Run ls' });
    const results = numbered.filter((frame) => frame.type === 'tool.finished');
    expect(results.map((frame) => frame.data.toolCallId)).toEqual([
      edit!.data.toolCallId,
      command!.data.toolCallId,
    ]);
    expect(results[0]!.data).toMatchObject({
      status: 'ok',
      diffs: [{ path: 'a.txt', added: 1, removed: 0 }],
    });
    expect(results[1]!.data.status).toBe('ok');
    // Every event of the run names the run.
    expect(new Set(numbered.map((frame) => frame.data.runId))).toEqual(new Set([receipt.runId]));
    // Exactly one terminal event.
    expect(numbered.filter((frame) => frame.type === 'run.finished')).toHaveLength(1);
    await live.close();
  });

  it('WB-030: text streams as deltas that add up to the stored message; a delta says where it belongs', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    await send(owner, session.id, 'count [[scenario:long 12]]');
    await live.event(topic, 'run.finished');
    const stored = live.durable(topic).filter((frame) => frame.type === 'message.assistant');
    expect(stored.length).toBeGreaterThan(0);
    for (const message of stored) {
      const deltas = live
        .events(topic)
        .filter(
          (frame) =>
            frame.type === 'message.delta' && frame.data.messageId === message.data.messageId,
        );
      expect(deltas.length, 'the message was streamed in pieces').toBeGreaterThan(1);
      let text = '';
      for (const delta of deltas) {
        expect(delta.seq, 'a delta is live only and carries no number').toBeUndefined();
        expect(delta.data.offset).toBe(text.length);
        text += delta.data.text as string;
      }
      expect(text).toBe(message.data.text);
      // The stored message comes after its last delta.
      expect(live.frames.indexOf(message)).toBeGreaterThan(live.frames.indexOf(deltas.at(-1)!));
    }
    await live.close();
  });

  it('AT-WB-034: a client that drops mid-run and returns with its last number gets every later event exactly once, in order, and the run still shows as running', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const first = await Realtime.open(studio, owner);
    await first.subscribe(topic);
    // The long stretch at the end keeps the run going for a couple of seconds after the client has left.
    const receipt = await send(
      owner,
      session.id,
      'work [[scenario:todo]] [[scenario:long 10]] [[scenario:bash ls]] [[scenario:long 70]]',
    );
    // Stay until the to-do list is being written, then lose the connection.
    await first.event(topic, 'todos.updated');
    const seenBefore = first.durable(topic).map((frame) => frame.seq!);
    const lastSeen = seenBefore.at(-1)!;
    await first.close();

    // While away the run goes on; come back before it ends.
    await until(
      async () => (await owner.get<Json>(`/api/sessions/${session.id}`)).body.lastSeq > lastSeen,
      { what: 'the run to move on while the client is away' },
    );
    const second = await Realtime.open(studio, owner);
    const subscribed = await second.subscribe(topic, lastSeen);
    expect(subscribed.op).toBe('subscribed');
    expect(subscribed.snapshot.run, 'the run is still in progress on return').toMatchObject({
      id: receipt.runId,
      status: 'running',
    });
    expect(subscribed.replayed).toBeGreaterThan(0);
    await second.event(topic, 'run.finished');

    const after = second.durable(topic);
    expectContiguous(after, lastSeen + 1);
    // Together the two connections saw the whole log, each event once.
    const stored = await transcript(owner, session.id);
    expect([...seenBefore, ...after.map((frame) => frame.seq!)]).toEqual(
      stored.map((event) => event.seq),
    );
    expect(after.map(summary)).toEqual(stored.filter((event) => event.seq > lastSeen).map(summary));
    expect(after.filter((frame) => frame.type === 'run.finished')).toHaveLength(1);
    await second.close();
  });

  it('WB-052: replay after a run has ended returns the missed events once and nothing else', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const run = await runToEnd(owner, session.id, 'go [[scenario:todo]]');
    const stored = await transcript(owner, session.id);
    const live = await Realtime.open(studio, owner);
    const subscribed = await live.subscribe(topic, 4);
    expect(subscribed.replayed).toBe(stored.length - 4);
    expect(subscribed.snapshot).toMatchObject({ lastSeq: stored.length, run: null, streaming: [] });
    await roundTrip(live);
    const replayed = live.durable(topic);
    expectContiguous(replayed, 5);
    expect(replayed.at(-1)).toMatchObject({ type: 'run.finished', data: { runId: run.id } });
    expect(replayed.map(summary)).toEqual(stored.slice(4).map(summary));
    // Subscribing again from the newest number replays nothing.
    const again = await Realtime.open(studio, owner);
    expect((await again.subscribe(topic, stored.length)).replayed).toBe(0);
    await roundTrip(again);
    expect(again.events(topic)).toEqual([]);
    await Promise.all([live.close(), again.close()]);
  });

  it('AT-WB-035: a run whose only client went away still finishes; the result is complete in stored history and the session is marked unseen until opened', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const receipt = await send(
      owner,
      session.id,
      'carry on without me [[scenario:long 20]] [[scenario:edit-file left-alone.txt]]',
      { permissionMode: 'accept-edits' },
    );
    await live.event(topic, 'run.started');
    await live.close(); // the page is closed; nobody is connected any more

    const run = await runEnded(owner, receipt.runId!);
    expect(run.status).toBe('completed');
    const stored = await transcript(owner, session.id);
    expect(stored.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'completed' } });
    expect(
      stored.some((event) => event.type === 'tool.finished' && event.data.status === 'ok'),
    ).toBe(true);
    expect(
      stored.filter((event) => event.type === 'message.assistant').length,
    ).toBeGreaterThanOrEqual(2);

    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.attention).toBe('unseen');
    // Opening it on any device clears the mark for all of them.
    const otherDevice = await studio.owner();
    expect((await otherDevice.post(`/api/sessions/${session.id}/seen`)).status).toBeLessThan(300);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.attention).toBe('none');
  });

  it('AT-WB-036: two devices on one session see the same run — the second learns it is running at once, joins mid-run with the text so far, and ends with the same transcript', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const deviceA = await Realtime.open(studio, owner);
    await deviceA.subscribe(topic);
    const tablet = await studio.owner();
    const listB = await Realtime.open(studio, tablet); // device B is on the list, not in the session
    await listB.subscribe(`user:${tablet.userId}`);

    const receipt = await send(owner, session.id, 'stream for two [[scenario:long 60]]');
    // B is told the run started (well within the 5 s the requirement allows).
    const started = await listB.event(`user:${tablet.userId}`, 'run.started', {
      timeout: 5000,
      where: (frame) => frame.data.sessionId === session.id,
    });
    expect(started.data).toMatchObject({
      runId: receipt.runId,
      projectId: project.id,
      agentId: 'claude-code',
    });

    // B opens the session while text is streaming.
    await deviceA.event(topic, 'message.delta');
    const deviceB = await Realtime.open(studio, tablet);
    const joined = await deviceB.subscribe(topic);
    expect(joined.snapshot.run).toMatchObject({ id: receipt.runId, status: 'running' });
    expect(joined.snapshot.streaming).toHaveLength(1);
    const soFar: string = joined.snapshot.streaming[0].text;
    expect(soFar.length).toBeGreaterThan(0);

    await Promise.all([deviceA.event(topic, 'run.finished'), deviceB.event(topic, 'run.finished')]);
    // From the moment B joined, both saw the same events.
    const numberedB = deviceB.durable(topic);
    const numberedA = deviceA
      .durable(topic)
      .filter((frame) => frame.seq! > joined.snapshot.lastSeq);
    expect(numberedB.map(summary)).toEqual(numberedA.map(summary));
    // B's picture of the streamed message — snapshot text plus the deltas after it — equals the stored text.
    const message = numberedB.find((frame) => frame.type === 'message.assistant')!;
    let text = soFar;
    for (const delta of deviceB
      .events(topic)
      .filter(
        (frame) =>
          frame.type === 'message.delta' && frame.data.messageId === message.data.messageId,
      )) {
      if (delta.data.offset === text.length) text += delta.data.text as string; // otherwise a duplicate of what the snapshot held
    }
    expect(text).toBe(message.data.text);
    await Promise.all([deviceA.close(), deviceB.close(), listB.close()]);
  });

  it('AT-WB-037 (adapted): subscribing to a finished session with nothing seen replays no events — the content comes from history only', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    await runToEnd(owner, session.id, 'a finished run');
    const stored = await transcript(owner, session.id);
    const live = await Realtime.open(studio, owner);
    const subscribed = await live.subscribe(topic);
    expect(subscribed.replayed).toBe(0);
    expect(subscribed.snapshot).toMatchObject({
      sessionId: session.id,
      lastSeq: stored.length,
      run: null,
      streaming: [],
      pendingApprovals: [],
      queue: [],
    });
    await roundTrip(live);
    expect(live.events(topic)).toEqual([]);
    await live.close();
  });

  it('AT-WB-038 (adapted): a client whose last number belongs to an earlier run receives the run now in progress from its beginning', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    await runToEnd(owner, session.id, 'the first run');
    const endOfFirst = (await transcript(owner, session.id)).at(-1)!.seq;
    const second = await send(owner, session.id, 'the second run [[scenario:long 40]]');
    await until(
      async () => (await owner.get<Json>(`/api/runs/${second.runId}`)).body.status === 'running',
      { what: 'the second run to be running' },
    );

    const live = await Realtime.open(studio, owner);
    const subscribed = await live.subscribe(topic, endOfFirst);
    expect(subscribed.snapshot.run).toMatchObject({ id: second.runId });
    await live.event(topic, 'run.finished');
    const numbered = live.durable(topic);
    expectContiguous(numbered, endOfFirst + 1);
    expect(numbered[0]).toMatchObject({
      type: 'message.user',
      data: { runId: second.runId, text: 'the second run [[scenario:long 40]]' },
    });
    expect(numbered[1]).toMatchObject({ type: 'run.started', data: { runId: second.runId } });
    expect(numbered.every((frame) => frame.data.runId === second.runId)).toBe(true);
    await live.close();
  });

  it('AT-WB-039: an error the agent recovers from is a notice in the middle of the run; the session stays running until the one terminal event, and the run is recorded as completed', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const receipt = await send(
      owner,
      session.id,
      'hold on [[scenario:retry]] [[scenario:long 10]]',
    );
    const notice = await live.event(topic, 'notice');
    expect(notice.data).toMatchObject({
      runId: receipt.runId,
      level: 'warning',
      code: 'api_retry',
    });
    expect(notice.data.text).toContain('trying again');
    // Still running after the notice.
    const during = (await owner.get<Json>(`/api/sessions/${session.id}`)).body;
    expect(during.activeRunId).toBe(receipt.runId);
    expect(during.attention).toBe('running');
    const finished = await live.event(topic, 'run.finished');
    expect(finished.data).toMatchObject({ status: 'completed', error: null });
    expect(live.frames.indexOf(finished)).toBeGreaterThan(live.frames.indexOf(notice));
    expect((await runEnded(owner, receipt.runId!)).status).toBe('completed');
    await live.close();
  });

  it('AT-WB-040 (adapted): a long history is read newest page first and pages backwards to the very first event, without gaps or repeats', async () => {
    const session = await createSession(owner, project.id);
    for (let turn = 1; turn <= 5; turn += 1)
      await runToEnd(owner, session.id, `turn ${turn} [[scenario:todo]]`);
    const all = await transcript(owner, session.id);
    expect(all.length).toBeGreaterThan(100);
    expectContiguous(all, 1);

    // With no cursor: the newest page only.
    const newest = await owner.get<{ events: StoredEvent[]; hasMore: boolean; lastSeq: number }>(
      `/api/sessions/${session.id}/events?limit=30`,
    );
    expect(newest.status).toBe(200);
    expect(newest.body.events).toHaveLength(30);
    expect(newest.body.hasMore).toBe(true);
    expect(newest.body.lastSeq).toBe(all.length);
    expectContiguous(newest.body.events, all.length - 29);

    // Scrolling up loads the page before the oldest one held, until the start.
    let held = newest.body.events;
    let pages = 1;
    for (;;) {
      const page = await owner.get<{ events: StoredEvent[]; hasMore: boolean }>(
        `/api/sessions/${session.id}/events?before=${held[0]!.seq}&limit=30`,
      );
      expect(page.status).toBe(200);
      held = [...page.body.events, ...held];
      pages += 1;
      if (!page.body.hasMore) break;
      expect(pages).toBeLessThan(20);
    }
    expect(held.map(summary)).toEqual(all.map(summary));
    expect(held.filter((event) => event.type === 'message.user')).toHaveLength(5);
    // A cursor in both directions at once is refused.
    expect((await owner.get(`/api/sessions/${session.id}/events?after=1&before=9`)).status).toBe(
      400,
    );
  });

  it('AT-WB-150: a checklist update replaces the list — the newest event always carries the whole list', async () => {
    const session = await createSession(owner, project.id);
    await runToEnd(owner, session.id, 'plan it [[scenario:thinking]] [[scenario:todo]]');
    const events = await transcript(owner, session.id);
    expect(events.some((event) => event.type === 'thinking' && event.data.text.length > 0)).toBe(
      true,
    );
    const lists = events
      .filter((event) => event.type === 'todos.updated')
      .map((event) => event.data.items as Array<{ text: string; status: string }>);
    expect(lists.length).toBeGreaterThan(2);
    const done = lists.map(
      (items) => `${items.filter((item) => item.status === 'completed').length}/${items.length}`,
    );
    expect(done.at(-1)).toBe('2/2');
    expect(done).toContain('1/2');
    // One list of two items throughout, never a second list appended to the first.
    expect(lists.at(-1)!.map((item) => item.text)).toEqual(['Check the directory', 'Report']);
    expect(lists.every((items) => items.length <= 2)).toBe(true);
  });

  it('AT-WB-075 (adapted): what a sub-agent does is tied to the call that started it, not shown as top-level work', async () => {
    const session = await createSession(owner, project.id);
    await runToEnd(owner, session.id, 'delegate [[scenario:sub-agent]]');
    const events = await transcript(owner, session.id);
    const spawn = events.find(
      (event) => event.type === 'tool.started' && event.data.kind === 'agent',
    );
    expect(spawn, 'the sub-agent was started by a tool call').toBeDefined();
    expect(spawn!.data.parentToolCallId).toBeNull();
    const inside = events.filter((event) => event.data.parentToolCallId === spawn!.data.toolCallId);
    expect(inside.map((event) => event.type)).toEqual(
      expect.arrayContaining(['tool.started', 'message.assistant']),
    );
    // The parent's own answer is top-level.
    const top = events.filter(
      (event) => event.type === 'message.assistant' && event.data.parentToolCallId === null,
    );
    expect(top.at(-1)!.data.text).toContain('sub-agent reported');
  });

  it('AT-WB-075 (Codex, adapted): the same holds for the other agent', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const session = await createSession(owner, project.id, 'codex');
    await runToEnd(owner, session.id, 'delegate [[scenario:sub-agent]]');
    const events = await transcript(owner, session.id);
    const spawn = events.find(
      (event) => event.type === 'tool.started' && event.data.kind === 'agent',
    )!;
    const inside = events.filter((event) => event.data.parentToolCallId === spawn.data.toolCallId);
    expect(inside.map((event) => event.data.text)).toEqual(['The tests look fine.']);
  });

  it('AT-WB-115 (adapted): a context compaction during a run is reported as a notice of its own and the run carries on', async () => {
    const session = await createSession(owner, project.id);
    const run = await runToEnd(owner, session.id, 'long talk [[scenario:compact]]');
    expect(run.status).toBe('completed');
    const events = await transcript(owner, session.id);
    const notice = events.find((event) => event.type === 'notice');
    expect(notice!.data).toMatchObject({ level: 'info', code: 'compaction', runId: run.id });
    expect(events.findIndex((event) => event.type === 'message.assistant')).toBeGreaterThan(
      events.indexOf(notice!),
    );
  });

  it('AT-WB-142: no event carries the agent’s own conversation id, a sign-in credential or the server’s settings', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    await live.subscribe(`user:${owner.userId}`);
    await send(
      owner,
      session.id,
      'tell me everything [[scenario:thinking]] [[scenario:bash ls]] [[scenario:todo]]',
    );
    await live.event(topic, 'run.finished');
    const native = (
      await owner.get<{ nativeSessionId: string }>(`/api/sessions/${session.id}/native-id`)
    ).body.nativeSessionId;
    expect(native.length).toBeGreaterThan(8);
    const snapshot = await owner.get(`/api/sessions/${session.id}/state`);
    const everything = [
      JSON.stringify(live.frames),
      JSON.stringify(await transcript(owner, session.id)),
      JSON.stringify(snapshot.body),
      JSON.stringify((await owner.get(`/api/sessions/${session.id}`)).body),
      JSON.stringify((await owner.get(`/api/runs?state=all&sessionId=${session.id}`)).body),
    ].join('\n');
    expect(everything).not.toContain(native);
    expect(everything).not.toContain(owner.cookie!.split('=')[1]!);
    expect(everything).not.toContain(SETUP_TOKEN);
    expect(everything).not.toContain(studio.dataDir);
    expect(everything).not.toMatch(/STUDIO_BRIDGE_TOKEN|AGENT_STUDIO_[A-Z_]+=/);
    await live.close();
  });
});

/** Waits until the server has answered a ping: everything it had queued for this connection has arrived. */
async function roundTrip(live: Realtime): Promise<void> {
  const from = live.mark();
  const t = Date.now();
  live.sendFrame({ op: 'ping', t });
  await live.waitFor((frame: Frame) => frame.op === 'pong', { from, what: 'the pong' });
}
