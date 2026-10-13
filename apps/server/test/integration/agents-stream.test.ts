import { type ServerFrame, type SessionSnapshot, sessionTopic, userTopic } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentsKit, type Live, createAgentsKit, until } from '../../src/testing/agents-kit.js';

let kit: AgentsKit;
beforeAll(async () => {
  kit = await createAgentsKit();
});
afterAll(async () => {
  await kit.close();
});

type EventFrame = Extract<ServerFrame, { op: 'event' }>;
const durable = (live: Live, topic: string): EventFrame[] => live.events(topic).filter((frame) => frame.seq !== undefined);
const finished = (live: Live, topic: string) => live.next((frame) => frame.op === 'event' && frame.topic === topic && frame.type === 'run.finished');

describe('watching a run', () => {
  it('delivers durable events in order with consecutive sequence numbers, and deltas without one', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const topic = sessionTopic(session.id);
    const live = await kit.connect(owner);
    const subscribed = await live.subscribe(topic);
    expect(subscribed).toMatchObject({ op: 'subscribed', replayed: 0, snapshot: { sessionId: session.id, lastSeq: 0, run: null, streaming: [], pendingApprovals: [], queue: [] } });

    agent.script([
      { text: 'Hello there, world.', chunks: 4, messageId: 'm1' },
      { tool: { id: 'c1', name: 'Bash', kind: 'execute', title: 'Run ls', input: { command: 'ls' }, outputChunks: ['a\n', 'b\n'] } },
      { emit: { type: 'todos', items: [{ text: 'look', status: 'completed' }, { text: 'fix', status: 'in_progress' }] } },
      { emit: { type: 'usage', model: 'scripted-large', inputTokens: 100, outputTokens: 20, contextTokens: 120, contextWindow: 200_000 } },
      { text: 'Done.', messageId: 'm2' },
    ]);
    await kit.send(owner, session.id, 'go');
    await finished(live, topic);

    const stored = durable(live, topic);
    expect(stored.map((frame) => frame.type)).toEqual([
      'message.user',
      'run.started',
      'message.assistant',
      'tool.started',
      'tool.finished',
      'todos.updated',
      'usage.reported',
      'message.assistant',
      'run.finished',
    ]);
    expect(stored.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // What was sent live is exactly what the log holds.
    expect(stored.map((frame) => ({ seq: frame.seq, type: frame.type, data: frame.data }))).toEqual(
      (await kit.events(owner, session.id)).map((event) => ({ seq: event.seq, type: event.type, data: event.data })),
    );

    const deltas = live.events(topic).filter((frame) => frame.type === 'message.delta');
    expect(deltas.every((frame) => frame.seq === undefined)).toBe(true);
    const m1 = deltas.map((frame) => frame.data as { messageId: string; offset: number; text: string }).filter((delta) => delta.messageId === 'm1');
    expect(m1.map((delta) => delta.text).join('')).toBe('Hello there, world.');
    expect(m1.map((delta) => delta.offset)).toEqual([0, 5, 10, 15]);
    // Deltas of a block arrive before the block that completes them.
    const frames = live.events(topic);
    expect(frames.findIndex((frame) => frame.type === 'message.delta')).toBeLessThan(frames.findIndex((frame) => frame.type === 'message.assistant'));
    expect(frames.filter((frame) => frame.type === 'tool.output').map((frame) => (frame.data as { text: string }).text)).toEqual(['a\n', 'b\n']);
    live.close();
  });

  it('replays exactly what a client missed, then carries on live', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const topic = sessionTopic(session.id);
    agent.script([{ text: 'one' }, { text: 'two' }, { gate: 'gap' }, { text: 'three' }]);
    const sent = await kit.send(owner, session.id, 'count');
    await agent.reached('gap');

    // A client that saw the first two events and then lost its connection.
    const late = await kit.connect(owner);
    const subscribed = await late.subscribe(topic, 2);
    expect(subscribed).toMatchObject({ op: 'subscribed', replayed: 2, snapshot: { lastSeq: 4, run: { id: sent.body.runId, status: 'running' } } });
    await late.next((frame) => frame.op === 'event' && frame.seq === 4);
    expect(durable(late, topic).map((frame) => frame.seq)).toEqual([3, 4]);

    agent.open('gap');
    await finished(late, topic);
    const all = durable(late, topic);
    expect(all.map((frame) => frame.seq)).toEqual([3, 4, 5, 6]);
    expect(all.map((frame) => frame.type)).toEqual(['message.assistant', 'message.assistant', 'message.assistant', 'run.finished']);

    // Nothing was missed, nothing is replayed.
    const current = await kit.connect(owner);
    expect(await current.subscribe(topic, 6)).toMatchObject({ replayed: 0, snapshot: { lastSeq: 6, run: null } });
    // Without `after`, a finished run is not replayed at all: its content is read from history.
    const fresh = await kit.connect(owner);
    expect(await fresh.subscribe(topic)).toMatchObject({ replayed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fresh.events(topic)).toEqual([]);
    for (const live of [late, current, fresh]) live.close();
  });

  it('fills a gap larger than the replay window over REST', async () => {
    const { owner } = kit;
    const session = await kit.session();
    await kit.turn(owner, session.id, 'one');
    await kit.turn(owner, session.id, 'two');
    const page = await owner.get<{ events: Array<{ seq: number }>; hasMore: boolean; lastSeq: number }>(`/api/sessions/${session.id}/events?after=2&limit=3`);
    expect(page.body.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(page.body).toMatchObject({ hasMore: true, lastSeq: 8 });
    const rest = await owner.get<{ events: Array<{ seq: number }>; hasMore: boolean }>(`/api/sessions/${session.id}/events?after=5&limit=3`);
    expect(rest.body.events.map((event) => event.seq)).toEqual([6, 7, 8]);
    expect(rest.body.hasMore).toBe(false);
    // Paging backwards from the newest, each page oldest first.
    const newest = await owner.get<{ events: Array<{ seq: number }>; hasMore: boolean }>(`/api/sessions/${session.id}/events?limit=3`);
    expect(newest.body.events.map((event) => event.seq)).toEqual([6, 7, 8]);
    expect(newest.body.hasMore).toBe(true);
    const older = await owner.get<{ events: Array<{ seq: number }>; hasMore: boolean }>(`/api/sessions/${session.id}/events?before=6&limit=10`);
    expect(older.body.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(older.body.hasMore).toBe(false);
    expect((await owner.get(`/api/sessions/${session.id}/events?before=3&after=1`)).status).toBe(400);
  });

  it('hands a late joiner the half-streamed message', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const topic = sessionTopic(session.id);
    agent.script([
      { text: 'A complete thought. ', messageId: 'done' },
      { text: 'The answer is forty', messageId: 'partial', chunks: 2, complete: false },
      { emit: { type: 'thinking.delta', messageId: 'th', text: 'hmm' } },
      { emit: { type: 'tool.started', toolCallId: 'slow', name: 'Bash', kind: 'execute', title: 'Run build', input: { command: 'make' } } },
      { emit: { type: 'tool.output', toolCallId: 'slow', text: 'compiling…' } },
      { gate: 'half' },
      { emit: { type: 'text.delta', messageId: 'partial', text: '-two.' } },
      { emit: { type: 'text', messageId: 'partial', text: 'The answer is forty-two.' } },
    ]);
    const sent = await kit.send(owner, session.id, 'what is the answer?');
    await agent.reached('half');

    const late = await kit.connect(owner);
    const subscribed = (await late.subscribe(topic)) as Extract<ServerFrame, { op: 'subscribed' }>;
    const snapshot = subscribed.snapshot as SessionSnapshot;
    expect(snapshot.run).toMatchObject({ id: sent.body.runId, status: 'running' });
    expect(snapshot.streaming).toEqual([
      { messageId: 'partial', kind: 'text', text: 'The answer is forty', parentToolCallId: null },
      { messageId: 'th', kind: 'thinking', text: 'hmm', parentToolCallId: null },
    ]);
    expect(snapshot.toolOutput).toEqual([{ toolCallId: 'slow', text: 'compiling…' }]);
    // The same state is readable over REST.
    expect(await kit.state(owner, session.id)).toMatchObject({ lastSeq: snapshot.lastSeq, streaming: snapshot.streaming });

    agent.open('half');
    await finished(late, topic);
    // The next delta continues exactly where the snapshot ended.
    const delta = late.events(topic).find((frame) => frame.type === 'message.delta')!;
    expect(delta.data).toMatchObject({ messageId: 'partial', offset: 'The answer is forty'.length, text: '-two.' });
    expect(late.events(topic).find((frame) => frame.type === 'message.assistant' && (frame.data as { messageId: string }).messageId === 'partial')).toMatchObject({
      data: { text: 'The answer is forty-two.', partial: false },
    });
    // The thinking that was never completed is kept as a partial block when the run ends.
    expect((await kit.events(owner, session.id)).find((event) => event.type === 'thinking')).toMatchObject({ data: { text: 'hmm', partial: true } });
    expect((await kit.state(owner, session.id)).streaming).toEqual([]);
    late.close();
  });

  it('shows every device the same stream', async () => {
    const { owner, agent } = kit;
    const second = await kit.t.signIn('owner');
    const session = await kit.session();
    const topic = sessionTopic(session.id);
    const deviceA = await kit.connect(owner);
    const deviceB = await kit.connect(second);
    await deviceA.subscribe(topic);
    await deviceB.subscribe(topic);
    await deviceB.subscribe(userTopic(owner.userId!));

    agent.script([{ text: 'streamed to both', chunks: 3 }, { gate: 'both' }, { text: 'and finished' }]);
    const sent = await kit.send(owner, session.id, 'from device A');
    await agent.reached('both');
    // The other device learns that the session is running without asking.
    await deviceB.next((frame) => frame.op === 'event' && frame.topic === userTopic(owner.userId!) && frame.type === 'run.started');
    expect((await kit.state(second, session.id)).run).toMatchObject({ id: sent.body.runId });
    agent.open('both');
    await Promise.all([finished(deviceA, topic), finished(deviceB, topic)]);

    const seen = (live: Live) => live.events(topic).map((frame) => ({ type: frame.type, seq: frame.seq, data: frame.data }));
    expect(seen(deviceB)).toEqual(seen(deviceA));
    expect(seen(deviceA).length).toBeGreaterThan(6);
    const listEvents = deviceB.events(userTopic(owner.userId!)).map((frame) => frame.type);
    expect(listEvents).toEqual(expect.arrayContaining(['run.started', 'run.finished', 'session.updated']));
    deviceA.close();
    deviceB.close();
  });

  it('never sends a session\'s events to a connection that is not watching it', async () => {
    const { owner, agent } = kit;
    const watched = await kit.session();
    const other = await kit.session();
    const bystander = await kit.connect(owner);
    await bystander.subscribe(sessionTopic(other.id));
    const member = await kit.t.member();
    const stranger = await kit.connect(member);
    await stranger.subscribe(userTopic(member.userId!));

    agent.script([{ text: 'private words', chunks: 2 }]);
    await kit.turn(owner, watched.id, 'secret question');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bystander.frames.filter((frame) => frame.op === 'event')).toEqual([]);
    expect(stranger.frames.filter((frame) => frame.op === 'event')).toEqual([]);
    expect(JSON.stringify([...bystander.frames, ...stranger.frames])).not.toContain('private words');
    bystander.close();
    stranger.close();
  });

  it('never puts the agent\'s own session id or the bridge token on the wire', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const topic = sessionTopic(session.id);
    const live = await kit.connect(owner);
    await live.subscribe(topic);
    await live.subscribe(userTopic(owner.userId!));
    agent.script([{ emit: { type: 'session', nativeSessionId: 'native-conversation-7f3a' } }, { text: 'hi' }]);
    await kit.turn(owner, session.id, 'hello');
    await finished(live, topic);
    const token = agent.lastRun.request.bridge.env.STUDIO_BRIDGE_TOKEN!;
    const wire = JSON.stringify(live.frames) + JSON.stringify(await kit.events(owner, session.id)) + JSON.stringify(await kit.state(owner, session.id));
    expect(wire).not.toContain('native-conversation-7f3a');
    expect(wire).not.toContain(token);
    // The session only says that there is something to resume; one explicit call returns the id for a terminal.
    expect((await owner.get(`/api/sessions/${session.id}`)).body).toMatchObject({ resumable: true });
    expect((await owner.get(`/api/sessions/${session.id}/native-id`)).body).toEqual({ nativeSessionId: 'native-conversation-7f3a' });
    // The next run resumes that conversation.
    await kit.turn(owner, session.id, 'again');
    expect(agent.lastRun.request.nativeSessionId).toBe('native-conversation-7f3a');
    // A link that names the agent's own id resolves to the session.
    expect((await owner.get(`/api/sessions/native-conversation-7f3a`)).body).toMatchObject({ id: session.id });
    live.close();
  });

  it('keeps a run going with nobody connected', async () => {
    const { owner, agent } = kit;
    const session = await kit.session();
    const live = await kit.connect(owner);
    await live.subscribe(sessionTopic(session.id));
    agent.script([{ gate: 'alone' }, { text: 'finished with no audience' }]);
    const sent = await kit.send(owner, session.id, 'work while I am away');
    await agent.reached('alone');
    live.close();
    await until(() => kit.t.studio.context.realtime.connectionCount === 0);
    agent.open('alone');
    const run = await kit.runEnded(owner, sent.body.runId!);
    expect(run.status).toBe('completed');
    expect((await kit.events(owner, session.id)).at(-2)).toMatchObject({ type: 'message.assistant', data: { text: 'finished with no audience' } });
    // Nobody was looking: the result waits as "finished, unseen".
    expect((await owner.get(`/api/sessions/${session.id}`)).body).toMatchObject({ attention: 'unseen' });
  });
});
