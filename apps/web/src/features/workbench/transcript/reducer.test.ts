import type { Approval, LiveSessionEvent, Run, SessionEvent, SessionSnapshot } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import type { AssistantItem, StackItem, ToolEntry, TranscriptItem, TranscriptState } from './model';
import { applyEvent, applyEvents, applyLive, applyPage, applySnapshot, applyUsage, hasSeq, initialTranscript, missingRange } from './reducer';

const SESSION = '01ssssssssssssssssssssssss';
const RUN = '01rrrrrrrrrrrrrrrrrrrrrrr1';
const RUN2 = '01rrrrrrrrrrrrrrrrrrrrrrr2';
const USER = '01uuuuuuuuuuuuuuuuuuuuuuuu';

// ---- small builders: one line per event ----------------------------------------

const at = (seq: number) => 1_000_000 + seq * 1000;
const user = (seq: number, text: string, runId = RUN, extra: Partial<Extract<SessionEvent, { type: 'message.user' }>['data']> = {}): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'message.user',
  data: { runId, requestId: `req-${seq}`, origin: 'interactive', text, attachments: [], quote: null, continuesRunId: null, ...extra },
});
const started = (seq: number, runId = RUN): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'run.started',
  data: { runId, agentId: 'demo', model: 'demo-large', effort: null, permissionMode: 'ask', origin: 'interactive' },
});
const said = (seq: number, messageId: string, text: string, runId = RUN, extra: { parentToolCallId?: string; partial?: boolean } = {}): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'message.assistant',
  data: { runId, messageId, text, model: 'demo-large', parentToolCallId: extra.parentToolCallId ?? null, partial: extra.partial ?? false },
});
const thought = (seq: number, messageId: string, text: string, parentToolCallId: string | null = null): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'thinking',
  data: { runId: RUN, messageId, text, parentToolCallId, partial: false },
});
const toolStarted = (seq: number, toolCallId: string, title: string, parentToolCallId: string | null = null): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'tool.started',
  data: { runId: RUN, toolCallId, name: 'Bash', kind: 'execute', title, input: { command: title }, inputTruncated: false, parentToolCallId },
});
const toolFinished = (seq: number, toolCallId: string, status: 'ok' | 'error' | 'denied' = 'ok', output = 'done'): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'tool.finished',
  data: { runId: RUN, toolCallId, status, output, outputOmittedChars: 0, diffs: [], diffsTruncated: false },
});
const todos = (seq: number, statuses: Array<'pending' | 'in_progress' | 'completed'>): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'todos.updated',
  data: { runId: RUN, items: statuses.map((status, index) => ({ text: `step ${index + 1}`, status })) },
});
const finished = (seq: number, status: 'completed' | 'failed' | 'stopped' | 'interrupted' = 'completed', runId = RUN): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'run.finished',
  data: { runId, status, error: status === 'failed' ? { code: 'agent_error', message: 'It broke.' } : null, interruptedByRestart: status === 'interrupted', durationMs: 4200 },
});
const usage = (seq: number, contextTokens: number | null, contextWindow: number | null = 200_000): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'usage.reported',
  data: { runId: RUN, model: 'demo-large', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.01, contextTokens, contextWindow },
});
const approval = (id: string, overrides: Partial<Approval> = {}): Approval => ({
  id,
  runId: RUN,
  sessionId: SESSION,
  projectId: null,
  userId: USER,
  kind: 'tool',
  toolName: 'Bash',
  toolKind: 'execute',
  toolCallId: null,
  title: 'Run npm test',
  command: 'npm test',
  paths: [],
  diff: null,
  input: {},
  plan: null,
  questions: null,
  risk: 'medium',
  riskCategories: [],
  reason: 'It changes something.',
  requiresOwner: false,
  suggestedRule: { tool: 'Bash', pattern: 'npm test *' },
  status: 'pending',
  decidedBy: null,
  decidedAt: null,
  note: null,
  answers: null,
  expiresAt: null,
  createdAt: 1,
  ...overrides,
});
const requested = (seq: number, value: Approval): SessionEvent => ({ seq, at: at(seq), type: 'approval.requested', data: { runId: RUN, approval: value } });
const resolved = (seq: number, approvalId: string, status: 'allowed' | 'denied' | 'expired' | 'cancelled' = 'allowed'): SessionEvent => ({
  seq,
  at: at(seq),
  type: 'approval.resolved',
  data: { runId: RUN, approvalId, status, decidedBy: USER, note: status === 'denied' ? 'not now' : null, answers: null },
});
const delta = (messageId: string, offset: number, text: string, kind: 'message.delta' | 'thinking.delta' = 'message.delta', runId = RUN): LiveSessionEvent => ({
  type: kind,
  data: { runId, messageId, offset, text, parentToolCallId: null },
});
const run = (id: string, status: Run['status'] = 'running'): Run => ({
  id,
  sessionId: SESSION,
  projectId: null,
  userId: USER,
  agentId: 'demo',
  requestId: 'req',
  origin: 'interactive',
  unattended: false,
  status,
  text: 'do it',
  model: null,
  effort: null,
  permissionMode: 'ask',
  error: null,
  interruptedByRestart: false,
  continuesRunId: null,
  continuedByRunId: null,
  dismissedAt: null,
  seenAt: null,
  createdAt: 500,
  startedAt: 600,
  finishedAt: null,
});
const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  sessionId: SESSION,
  lastSeq: 0,
  run: null,
  streaming: [],
  toolOutput: [],
  pendingApprovals: [],
  queue: [],
  unresolvedRuns: [],
  ...overrides,
});

const fold = (events: SessionEvent[], state: TranscriptState = initialTranscript(SESSION)) => events.reduce(applyEvent, state);
const kinds = (state: TranscriptState) => state.items.map((item) => item.kind);
const texts = (state: TranscriptState) => state.items.filter((item): item is AssistantItem => item.kind === 'assistant').map((item) => item.text);
const stacks = (state: TranscriptState) => state.items.filter((item): item is StackItem => item.kind === 'stack');
const toolsOf = (item: StackItem) => item.entries.filter((entry): entry is ToolEntry => entry.type === 'tool');
const find = <K extends TranscriptItem['kind']>(state: TranscriptState, kind: K) => state.items.find((item): item is Extract<TranscriptItem, { kind: K }> => item.kind === kind);

describe('folding the log into a transcript', () => {
  it('turns a plain turn into: the message, who answers, the answer, where the run ended', () => {
    const state = fold([user(1, 'hi'), started(2), said(3, 'm1', 'Hello.'), finished(4)]);
    expect(kinds(state)).toEqual(['user', 'label', 'assistant', 'run-end']);
    expect(find(state, 'label')).toMatchObject({ agentId: 'demo', model: 'demo-large' });
    expect(find(state, 'run-end')).toMatchObject({ status: 'completed', durationMs: 4200, steps: 0 });
    expect(state.activeRun).toBeNull();
  });

  it('groups consecutive tool calls and the reasoning between them into one stack', () => {
    const state = fold([
      user(1, 'go'),
      started(2),
      said(3, 'm1', 'Looking.'),
      toolStarted(4, 'c1', 'ls'),
      toolFinished(5, 'c1'),
      thought(6, 't1', 'Next the tests.'),
      toolStarted(7, 'c2', 'npm test'),
      toolFinished(8, 'c2', 'error', 'boom'),
      said(9, 'm2', 'One failed.'),
      toolStarted(10, 'c3', 'git status'),
    ]);
    expect(kinds(state)).toEqual(['user', 'label', 'assistant', 'stack', 'assistant', 'stack']);
    const [first, second] = stacks(state);
    expect(first!.entries.map((entry) => entry.type)).toEqual(['tool', 'thinking', 'tool']);
    expect(toolsOf(first!).map((tool) => [tool.title, tool.status, tool.output])).toEqual([
      ['ls', 'ok', 'done'],
      ['npm test', 'error', 'boom'],
    ]);
    expect(toolsOf(second!)[0]).toMatchObject({ title: 'git status', status: 'running' });
    expect(state.runs[RUN]).toMatchObject({ steps: 3, status: 'running' });
    expect(state.activeRun).toMatchObject({ id: RUN, status: 'running', since: at(2) });
  });

  it('shows a call left open when its run ends as unfinished, not as running', () => {
    const state = fold([user(1, 'go'), started(2), toolStarted(3, 'c1', 'sleep 100'), finished(4, 'stopped')]);
    expect(toolsOf(stacks(state)[0]!)[0]!.status).toBe('unfinished');
    expect(find(state, 'run-end')).toMatchObject({ status: 'stopped', steps: 1 });
  });

  it("nests a sub-agent's reasoning, calls and prose under the call that spawned it", () => {
    const state = fold([
      user(1, 'research'),
      started(2),
      toolStarted(3, 'agent', 'Research'),
      thought(4, 't1', 'Schema first.', 'agent'),
      toolStarted(5, 'inner', 'cat schema.sql', 'agent'),
      toolFinished(6, 'inner'),
      said(7, 'm1', 'Two tables.', RUN, { parentToolCallId: 'agent' }),
      toolFinished(8, 'agent', 'ok', 'summary'),
      said(9, 'm2', 'Found it.'),
    ]);
    // The sub-agent's prose is not a top-level message, and its call is not a top-level step.
    expect(kinds(state)).toEqual(['user', 'label', 'stack', 'assistant']);
    expect(texts(state)).toEqual(['Found it.']);
    const parent = toolsOf(stacks(state)[0]!)[0]!;
    expect(parent.children.map((child) => child.type)).toEqual(['thinking', 'tool', 'prose']);
    expect(parent).toMatchObject({ status: 'ok', output: 'summary' });
    expect(state.runs[RUN]!.steps).toBe(1);
  });

  it('keeps one checklist per run and replaces it in place', () => {
    const state = fold([
      user(1, 'plan'),
      started(2),
      todos(3, ['in_progress', 'pending', 'pending']),
      toolStarted(4, 'c1', 'step'),
      toolFinished(5, 'c1'),
      todos(6, ['completed', 'in_progress', 'pending']),
      todos(7, ['completed', 'completed', 'pending']),
    ]);
    expect(kinds(state).filter((kind) => kind === 'todos')).toHaveLength(1);
    expect(find(state, 'todos')!.items.map((item) => item.status)).toEqual(['completed', 'completed', 'pending']);
    // It stays where it first appeared: before the step that followed it.
    expect(kinds(state)).toEqual(['user', 'label', 'todos', 'stack']);
    expect(state.runs[RUN]!.todos).toEqual({ done: 2, total: 3 });
  });

  it('marks a tool row as waiting for approval, then as decided', () => {
    let state = fold([user(1, 'go'), started(2), toolStarted(3, 'c1', 'npm test'), requested(4, approval('a1', { toolCallId: 'c1' }))]);
    expect(kinds(state)).toEqual(['user', 'label', 'stack']);
    expect(toolsOf(stacks(state)[0]!)[0]!.approval).toMatchObject({ id: 'a1', status: 'pending' });
    expect(state.pendingApprovals.map((entry) => entry.id)).toEqual(['a1']);

    state = fold([resolved(5, 'a1', 'denied'), toolFinished(6, 'c1', 'denied', 'not now')], state);
    expect(toolsOf(stacks(state)[0]!)[0]).toMatchObject({ status: 'denied', approval: { status: 'denied', note: 'not now' } });
    expect(state.pendingApprovals).toEqual([]);
  });

  it('gives a plan or a question a row of its own, updated when it is answered', () => {
    const plan = approval('p1', { kind: 'plan', plan: '1. do it', toolName: 'ExitPlanMode', suggestedRule: null });
    let state = fold([user(1, 'plan it'), started(2), requested(3, plan)]);
    expect(kinds(state)).toEqual(['user', 'label', 'approval']);
    expect(find(state, 'approval')).toMatchObject({ status: 'pending' });
    const before = find(state, 'approval');
    state = applyEvent(state, resolved(4, 'p1', 'allowed'));
    expect(find(state, 'approval')).toMatchObject({ status: 'allowed', decidedBy: USER });
    expect(find(state, 'approval')).not.toBe(before);
  });

  it('treats an approval that was never resolved as cancelled once its run is over', () => {
    const state = fold([user(1, 'go'), started(2), requested(3, approval('p1', { kind: 'plan' })), finished(4, 'interrupted')]);
    expect(find(state, 'approval')!.status).toBe('cancelled');
    expect(state.pendingApprovals).toEqual([]);
  });

  it('keeps a notice as a row of its own and does not end the run', () => {
    const state = fold([
      user(1, 'go'),
      started(2),
      { seq: 3, at: at(3), type: 'notice', data: { runId: RUN, level: 'error', code: 'tool_error', text: 'Restarted.' } },
      said(4, 'm1', 'Fine.'),
    ]);
    expect(kinds(state)).toEqual(['user', 'notice', 'label', 'assistant']);
    expect(state.activeRun?.id).toBe(RUN);
  });

  it('separates runs, and shows a steered message inside the run that took it', () => {
    const state = fold([
      user(1, 'first'),
      started(2),
      said(3, 'm1', 'One.'),
      user(4, 'also this', RUN, { origin: 'steer' }),
      said(5, 'm2', 'Two.'),
      finished(6),
      user(7, 'second', RUN2, { origin: 'queued' }),
      started(8, RUN2),
      said(9, 'm1', 'Three.', RUN2),
    ]);
    expect(kinds(state)).toEqual(['user', 'label', 'assistant', 'user', 'assistant', 'run-end', 'user', 'label', 'assistant']);
    // The same message id in two runs is two different rows.
    expect(new Set(state.items.map((item) => item.key)).size).toBe(state.items.length);
    expect(state.segments).toHaveLength(2);
    expect(state.activeRun?.id).toBe(RUN2);
    expect([...state.requestIds]).toEqual(['req-1', 'req-4', 'req-7']);
  });

  it('sums what a run used and remembers the newest context figure', () => {
    const state = fold([user(1, 'go'), started(2), usage(3, 50_000), usage(4, 160_000), finished(5)]);
    expect(state.context).toMatchObject({ tokens: 160_000, window: 200_000, model: 'demo-large' });
    // Each usage event carries the run's totals so far: the last one stands, they are not added up.
    expect(find(state, 'run-end')!.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
  });

  it('tolerates an adapter that reports no context figure at all', () => {
    const state = fold([user(1, 'go'), started(2), usage(3, null, null), finished(4)]);
    expect(state.context).toBeNull();
    expect(find(state, 'run-end')!.usage).not.toBeNull();
  });
});

describe('sequence numbers', () => {
  it.each([
    ['the same event twice', [user(1, 'hi'), started(2), started(2), said(3, 'm1', 'a'), said(3, 'm1', 'a')]],
    ['a replay that overlaps what was delivered live', [user(1, 'hi'), started(2), said(3, 'm1', 'a'), user(1, 'hi'), started(2), said(3, 'm1', 'a')]],
  ])('apply once: %s', (_name, events) => {
    const state = fold(events);
    expect(state.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(kinds(state)).toEqual(['user', 'label', 'assistant']);
  });

  it('returns the very same state for a duplicate, so nothing renders again', () => {
    const state = fold([user(1, 'hi'), started(2)]);
    expect(applyEvent(state, started(2))).toBe(state);
    expect(hasSeq(state, 2)).toBe(true);
    expect(hasSeq(state, 3)).toBe(false);
  });

  it.each([
    ['reversed', [5, 4, 3, 2, 1]],
    ['interleaved', [2, 4, 1, 5, 3]],
    ['tail first, as after a gap', [4, 5, 1, 2, 3]],
  ])('ends with the same transcript whatever the order of arrival: %s', (_name, order) => {
    const ordered = [user(1, 'go'), started(2), toolStarted(3, 'c1', 'ls'), toolFinished(4, 'c1'), said(5, 'm1', 'Done.')];
    const expected = fold(ordered);
    const state = fold(order.map((seq) => ordered[seq - 1]!));
    expect(state.items.map((item) => [item.key, item.kind])).toEqual(expected.items.map((item) => [item.key, item.kind]));
    expect(toolsOf(stacks(state)[0]!)[0]!.status).toBe('ok');
    expect(state.gap).toBeNull();
  });

  it('notices a hole in the numbers, and that it has been filled', () => {
    let state = fold([user(1, 'go'), started(2)]);
    state = applyEvent(state, said(6, 'm9', 'late'));
    expect(state.gap).toEqual({ after: 2, before: 6 });
    expect(missingRange(state, 6)).toEqual({ after: 2 });
    state = applyPage(state, { events: [toolStarted(3, 'c1', 'ls'), toolFinished(4, 'c1'), said(5, 'm1', 'mid')], hasMore: false }, 'newer');
    expect(state.gap).toBeNull();
    expect(missingRange(state, 6)).toBeNull();
    expect(kinds(state)).toEqual(['user', 'label', 'stack', 'assistant', 'assistant']);
  });

  it('knows it is behind when the server holds more than it does', () => {
    const state = fold([user(1, 'go')]);
    expect(missingRange(state, 9)).toEqual({ after: 1 });
    expect(missingRange(state, 1)).toBeNull();
  });
});

describe('paging backwards', () => {
  it('prepends an older page, joins a run that was cut by the page boundary, and keeps untouched rows as they were', () => {
    const newest = [toolFinished(6, 'c1'), said(7, 'm1', 'Done.'), finished(8), user(9, 'again', RUN2), started(10, RUN2), said(11, 'm1', 'Yes.', RUN2)];
    let state = applyPage(initialTranscript(SESSION), { events: newest, hasMore: true }, 'older');
    expect(state.hasOlder).toBe(true);
    // The start of the first run is not loaded yet: its result still shows.
    expect(kinds(state)[0]).toBe('label');
    const secondRunRows = state.items.filter((item) => item.runId === RUN2);

    state = applyPage(state, { events: [user(1, 'go'), started(2), said(3, 'm0', 'Looking.'), toolStarted(5, 'c1', 'ls')], hasMore: false }, 'older');
    expect(state.hasOlder).toBe(false);
    expect(kinds(state)).toEqual(['user', 'label', 'assistant', 'stack', 'assistant', 'run-end', 'user', 'label', 'assistant']);
    expect(toolsOf(stacks(state)[0]!)[0]).toMatchObject({ title: 'ls', status: 'ok' });
    // Rows of the run that did not change are the same objects.
    expect(state.items.filter((item) => item.runId === RUN2)).toEqual(secondRunRows);
    state.items.filter((item) => item.runId === RUN2).forEach((item, index) => expect(item).toBe(secondRunRows[index]));
  });

  it('does not let a page of newer events change whether older history exists', () => {
    let state = applyPage(initialTranscript(SESSION), { events: [user(5, 'x')], hasMore: true }, 'older');
    state = applyPage(state, { events: [started(6)], hasMore: false }, 'newer');
    expect(state.hasOlder).toBe(true);
  });
});

describe('live text', () => {
  const running = () => fold([user(1, 'go'), started(2)]);

  it('grows a block from deltas and replaces it with the durable event, in the same row', () => {
    let state = running();
    state = applyLive(state, delta('m1', 0, 'Hel'));
    state = applyLive(state, delta('m1', 3, 'lo'));
    const streaming = find(state, 'assistant')!;
    expect(streaming).toMatchObject({ text: 'Hello', streaming: true });

    state = applyEvent(state, said(3, 'm1', 'Hello.'));
    const durable = find(state, 'assistant')!;
    expect(durable).toMatchObject({ text: 'Hello.', streaming: false, key: streaming.key });
    expect(texts(state)).toEqual(['Hello.']);
    expect(state.live.streaming).toEqual([]);
  });

  it.each([
    ['a repeated delta', [delta('m1', 0, 'Hel'), delta('m1', 0, 'Hel')], 'Hel'],
    ['a delta from further on than what is held', [delta('m1', 0, 'Hel'), delta('m1', 9, 'zzz')], 'Hel'],
    ['a delta for a block whose start was missed', [delta('m1', 4, 'late')], null],
  ])('ignores %s', (_name, deltas, expected) => {
    const state = deltas.reduce(applyLive, running());
    expect(find(state, 'assistant')?.text ?? null).toBe(expected);
  });

  it('ignores deltas that arrive after the block is complete or the run is over', () => {
    let state = fold([said(3, 'm1', 'Hello.')], running());
    expect(applyLive(state, delta('m1', 0, 'Hel'))).toBe(state);
    state = applyEvent(state, finished(4));
    expect(applyLive(state, delta('m2', 0, 'more'))).toBe(state);
  });

  it('shows reasoning as it is written, inside the stack it belongs to', () => {
    let state = running();
    state = applyLive(state, delta('t1', 0, 'Let me', 'thinking.delta'));
    expect(stacks(state)[0]!.entries[0]).toMatchObject({ type: 'thinking', text: 'Let me', streaming: true });
    state = applyEvent(state, thought(3, 't1', 'Let me think.'));
    expect(stacks(state)).toHaveLength(1);
    expect(stacks(state)[0]!.entries[0]).toMatchObject({ text: 'Let me think.', streaming: false });
  });

  it('shows tool output while the tool runs and drops it for the stored result', () => {
    let state = fold([toolStarted(3, 'c1', 'npm test')], running());
    state = applyLive(state, { type: 'tool.output', data: { runId: RUN, toolCallId: 'c1', text: 'line 1\n' } });
    state = applyLive(state, { type: 'tool.output', data: { runId: RUN, toolCallId: 'c1', text: 'line 2\n' } });
    expect(toolsOf(stacks(state)[0]!)[0]!.liveOutput).toBe('line 1\nline 2\n');
    state = applyEvent(state, toolFinished(4, 'c1', 'ok', 'all of it'));
    expect(toolsOf(stacks(state)[0]!)[0]).toMatchObject({ liveOutput: '', output: 'all of it' });
    expect(state.live.toolOutput).toEqual({});
  });

  it('keeps what a stopped run had written: the partial text is the durable one', () => {
    let state = applyLive(running(), delta('m1', 0, 'Half an ans'));
    state = fold([said(3, 'm1', 'Half an ans', RUN, { partial: true }), finished(4, 'stopped')], state);
    expect(find(state, 'assistant')).toMatchObject({ text: 'Half an ans', partial: true, streaming: false });
    expect(kinds(state)).toEqual(['user', 'label', 'assistant', 'run-end']);
  });

  it('only renders the rows that changed while text streams', () => {
    let state = fold([said(3, 'm0', 'Earlier.')], running());
    const earlier = state.items.find((item) => item.kind === 'assistant')!;
    const first = state.items[0]!;
    state = applyLive(state, delta('m1', 0, 'New'));
    state = applyLive(state, delta('m1', 3, ' text'));
    expect(state.items[0]).toBe(first);
    expect(state.items.find((item) => item.kind === 'assistant')).toBe(earlier);
  });

  it('follows the queue', () => {
    const item = { id: 'q1', sessionId: SESSION, requestId: 'r', text: 'later', attachments: [], quote: null, createdAt: 1, updatedAt: 1 };
    const state = applyLive(running(), { type: 'queue.changed', data: { queue: [item], taken: null } });
    expect(state.queue).toEqual([item]);
  });
});

describe('snapshots', () => {
  it('restore the text streamed so far, the pending approvals, the queue and the run for a late joiner', () => {
    const pending = approval('a1');
    let state = applyPage(initialTranscript(SESSION), { events: [user(1, 'go'), started(2)], hasMore: false }, 'older');
    state = applySnapshot(
      state,
      snapshot({
        lastSeq: 2,
        run: run(RUN),
        streaming: [{ messageId: 'm1', kind: 'text', text: 'So far', parentToolCallId: null }],
        pendingApprovals: [pending],
        unresolvedRuns: [run(RUN2, 'interrupted')],
      }),
    );
    expect(find(state, 'assistant')).toMatchObject({ text: 'So far', streaming: true });
    expect(state.pendingApprovals).toEqual([pending]);
    expect(state.unresolvedRuns.map((entry) => entry.id)).toEqual([RUN2]);
    expect(state.activeRun).toEqual({ id: RUN, status: 'running', since: 600 });

    // The stream carries on from exactly where the snapshot left it.
    state = applyLive(state, delta('m1', 6, ' and more'));
    expect(find(state, 'assistant')!.text).toBe('So far and more');
  });

  it('outrank what older events suggest: no run is in progress when the server says so', () => {
    // After a restart the log ends mid-run until the "interrupted" event arrives.
    let state = fold([user(1, 'go'), started(2), toolStarted(3, 'c1', 'ls')]);
    expect(state.activeRun?.id).toBe(RUN);
    state = applySnapshot(state, snapshot({ lastSeq: 5, run: null }));
    expect(state.activeRun).toBeNull();
    // …and the events that explain it are then applied as usual.
    state = fold([resolved(4, 'gone', 'cancelled'), finished(5, 'interrupted')], state);
    expect(state.activeRun).toBeNull();
    expect(find(state, 'run-end')).toMatchObject({ status: 'interrupted', interruptedByRestart: true });
  });

  it('are in turn outranked by newer events', () => {
    let state = applySnapshot(fold([user(1, 'go'), started(2)]), snapshot({ lastSeq: 2, run: run(RUN), pendingApprovals: [approval('a1')] }));
    state = applyEvent(state, resolved(3, 'a1'));
    expect(state.pendingApprovals).toEqual([]);
    state = applyEvent(state, finished(4));
    expect(state.activeRun).toBeNull();
    state = fold([user(5, 'next', RUN2), started(6, RUN2)], state);
    expect(state.activeRun?.id).toBe(RUN2);
  });

  it('do not resurrect an approval that an older event in a late page mentions', () => {
    let state = applySnapshot(initialTranscript(SESSION), snapshot({ lastSeq: 9, pendingApprovals: [] }));
    state = applyPage(state, { events: [user(1, 'go'), started(2), requested(3, approval('a1', { kind: 'plan' }))], hasMore: false }, 'older');
    expect(state.pendingApprovals).toEqual([]);
  });

  it('replace live text on a resubscription, but only extend it when read over HTTP', () => {
    let state = applyLive(fold([user(1, 'go'), started(2)]), delta('m1', 0, 'A long start'));
    const stale = snapshot({ lastSeq: 2, run: run(RUN), streaming: [{ messageId: 'm1', kind: 'text', text: 'A long', parentToolCallId: null }] });
    expect(find(applySnapshot(state, stale, 'merge'), 'assistant')!.text).toBe('A long start');
    expect(find(applySnapshot(state, stale, 'replace'), 'assistant')!.text).toBe('A long');
    state = applySnapshot(state, snapshot({ lastSeq: 2, run: run(RUN), streaming: [] }), 'replace');
    expect(find(state, 'assistant')).toBeUndefined();
  });

  it('drop the card of a run that was continued, as soon as the continuation appears', () => {
    let state = applySnapshot(fold([user(1, 'go'), finished(2, 'interrupted')]), snapshot({ lastSeq: 2, unresolvedRuns: [run(RUN, 'interrupted')] }));
    state = applyEvent(state, user(3, 'go', RUN2, { origin: 'continue', continuesRunId: RUN }));
    expect(state.unresolvedRuns).toEqual([]);
  });
});

describe('replay after a gap', () => {
  it('ends with every event once and the run state right, when live events, a replay and a page overlap', () => {
    const all = [
      user(1, 'go'),
      started(2),
      said(3, 'm1', 'One.'),
      toolStarted(4, 'c1', 'ls'),
      toolFinished(5, 'c1'),
      said(6, 'm2', 'Two.'),
      usage(7, 12_000),
      finished(8),
    ];
    // Seen live before the connection dropped:
    let state = fold(all.slice(0, 3));
    state = applyLive(state, delta('m2', 0, 'Tw'));
    // Reconnected: the snapshot says the run is over, then the replay overlaps what was held.
    state = applySnapshot(state, snapshot({ lastSeq: 8, run: null }));
    state = applyEvents(state, all.slice(2));
    // A page fetched for the same range arrives late.
    state = applyPage(state, { events: all, hasMore: false }, 'newer');

    expect(state.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(kinds(state)).toEqual(['user', 'label', 'assistant', 'stack', 'assistant', 'run-end']);
    expect(texts(state)).toEqual(['One.', 'Two.']);
    expect(state.activeRun).toBeNull();
    expect(state.live.streaming).toEqual([]);
    expect(state.context?.tokens).toBe(12_000);
  });
});

describe('usage read from the server', () => {
  it('takes the totals, and the context figure unless a newer one arrived live', () => {
    let state = fold([user(1, 'go'), started(2), usage(3, 90_000)]);
    const totals = [{ model: 'demo-large', inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, costUsd: null }];
    state = applyUsage(state, { context: { tokens: 10, window: 100, model: 'old', at: 5 }, totals });
    expect(state.totals).toEqual(totals);
    expect(state.context?.tokens).toBe(90_000);
    state = applyUsage(state, { context: { tokens: 99_000, window: 200_000, model: 'demo-large', at: at(50) }, totals });
    expect(state.context?.tokens).toBe(99_000);
  });
});
