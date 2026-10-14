import {
  LIVE_EVENT,
  type LiveSessionEvent,
  SESSION_EVENT,
  type SessionEvent,
  type SessionSnapshot,
  type SessionUsage,
} from '@agent-studio/protocol';
import type {
  ActiveRun,
  ApprovalItem,
  AssistantItem,
  ContextReading,
  LabelItem,
  LiveState,
  RunInfo,
  RunUsage,
  Segment,
  StackEntry,
  StackItem,
  StreamBlock,
  ThinkingEntry,
  TodosItem,
  ToolEntry,
  TranscriptItem,
  TranscriptState,
} from './model';

/**
 * The session reducer: durable events, live events and snapshots in, a
 * transcript out. Pure — nothing here touches the network, a clock or React —
 * so the rules that must never regress can be tested as plain tables:
 *
 *  - a sequence number is applied once, whatever order events arrive in;
 *  - deltas extend a block only at the offset they name, and the durable
 *    event with the same message id replaces the block;
 *  - a tool call pairs with its result by id; one left open when its run ends
 *    is shown as unfinished;
 *  - what a snapshot says about the run, the approvals and the queue outranks
 *    anything inferred from older events.
 */

/** How much live tool output is kept per call; the stored result replaces it when the call ends. */
export const LIVE_OUTPUT_CHARS = 64_000;

const EMPTY_LIVE: LiveState = { streaming: [], toolOutput: {} };

export function initialTranscript(sessionId: string): TranscriptState {
  return {
    sessionId,
    events: [],
    firstSeq: 0,
    lastSeq: 0,
    hasOlder: false,
    segments: [],
    items: [],
    runs: {},
    requestIds: new Set(),
    live: EMPTY_LIVE,
    activeRun: null,
    pendingApprovals: [],
    queue: [],
    unresolvedRuns: [],
    context: null,
    totals: [],
    snapshotSeq: 0,
    snapshotRun: null,
    gap: null,
  };
}

// ---- folding one run -------------------------------------------------------------

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);

const runIdOf = (event: SessionEvent): string | null => event.data.runId;
const groupKeyOf = (event: SessionEvent): string => runIdOf(event) ?? `n:${event.seq}`;
const messageKey = (runId: string, messageId: string): string => `${runId}:${messageId}`;

/** Bookkeeping for a row while it is being built: what went into it, so `rev` can say when it changed. */
interface Tracked<T extends TranscriptItem = TranscriptItem> {
  item: T;
  count: number;
  max: number;
  extra: string;
}

function liveSignature(runId: string | null, live: LiveState, takesToolOutput: boolean): string {
  if (runId === null) return '';
  let signature = '';
  for (const block of live.streaming) if (block.runId === runId) signature += `${block.messageId}:${block.text.length};`;
  if (takesToolOutput) for (const [toolCallId, text] of Object.entries(live.toolOutput)) signature += `${toolCallId}=${text.length};`;
  return signature;
}

function foldRun(events: readonly SessionEvent[], live: LiveState, takesToolOutput: boolean, previous: Segment | undefined): Segment {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const runId = runIdOf(first);
  const tracked: Tracked[] = [];
  const tools = new Map<string, ToolEntry>();
  const owners = new Map<string, Tracked<StackItem>>();
  const approvals = new Map<string, { row?: Tracked<ApprovalItem>; tool?: ToolEntry }>();
  const messageKeys: string[] = [];
  const requestIds: string[] = [];
  const usageByModel = new Map<string, RunUsage>();
  let stack: Tracked<StackItem> | null = null;
  let todos: Tracked<TodosItem> | null = null;
  let label: Tracked<LabelItem> | null = null;
  let context: ContextReading | null = null;
  const run: RunInfo | null =
    runId === null
      ? null
      : { runId, agentId: null, model: null, effort: null, permissionMode: null, origin: null, status: 'accepted', startedAt: null, firstAt: first.at, steps: 0, todos: null, error: null, usage: null };

  const push = <T extends TranscriptItem>(item: T, seq: number): Tracked<T> => {
    const entry: Tracked<T> = { item, count: 1, max: seq, extra: '' };
    tracked.push(entry);
    return entry;
  };
  const touch = (entry: Tracked | undefined, seq: number): void => {
    if (!entry) return;
    entry.count += 1;
    if (seq > entry.max) entry.max = seq;
  };
  /** The turn label goes in front of the first thing the agent produces. */
  const ensureLabel = (seq: number, at: number): void => {
    if (label || runId === null) return;
    label = push({ kind: 'label', key: `label:${runId}`, runId, seq, at, rev: '', agentId: run?.agentId ?? null, model: run?.model ?? null }, seq);
  };
  const openStack = (seq: number, at: number): Tracked<StackItem> => {
    if (stack) return stack;
    ensureLabel(seq, at);
    stack = push({ kind: 'stack', key: `stack:${runId ?? 'n'}:${seq}`, runId, seq, at, rev: '', entries: [] }, seq);
    return stack;
  };
  const closeStack = (): void => {
    stack = null;
  };
  const newTool = (toolCallId: string, seq: number, at: number): ToolEntry => ({
    type: 'tool',
    toolCallId,
    name: '',
    kind: 'other',
    title: '',
    input: undefined,
    inputTruncated: false,
    status: 'running',
    output: '',
    outputOmittedChars: 0,
    liveOutput: '',
    diffs: [],
    diffsTruncated: false,
    children: [],
    startedAt: at,
    finishedAt: null,
    approval: null,
    seq,
  });
  /** Where an entry made by a sub-agent goes: under its parent call, when that call is in view. */
  const place = (entry: StackEntry, parentToolCallId: string | null, seq: number, at: number): Tracked<StackItem> => {
    const parent = parentToolCallId === null ? undefined : tools.get(parentToolCallId);
    if (parent) {
      parent.children.push(entry);
      const owner = owners.get(parent.toolCallId)!;
      touch(owner, seq);
      return owner;
    }
    const target = openStack(seq, at);
    if (target.item.entries.length > 0 || target.count > 1) touch(target, seq);
    target.item.entries.push(entry);
    return target;
  };
  const prose = (data: { messageId: string; text: string; model: string | null; parentToolCallId: string | null; partial: boolean }, seq: number, at: number, streaming: boolean): void => {
    if (runId === null) return;
    const parent = data.parentToolCallId === null ? undefined : tools.get(data.parentToolCallId);
    if (parent) {
      parent.children.push({ type: 'prose', messageId: data.messageId, text: data.text, partial: data.partial, streaming, seq });
      const owner = owners.get(parent.toolCallId)!;
      touch(owner, seq);
      if (streaming) owner.extra += `p${data.text.length}`;
      return;
    }
    ensureLabel(seq, at);
    closeStack();
    if (data.model && label && label.item.model === null) label.item.model = data.model;
    const item: AssistantItem = {
      kind: 'assistant',
      key: `a:${messageKey(runId, data.messageId)}`,
      runId,
      seq,
      at,
      rev: '',
      messageId: data.messageId,
      text: data.text,
      model: data.model,
      partial: data.partial,
      streaming,
    };
    const entry = push(item, seq);
    entry.extra = streaming ? `s${data.text.length}` : data.partial ? 'p' : '';
  };
  const thinking = (data: { messageId: string; text: string; parentToolCallId: string | null; partial: boolean }, seq: number, at: number, streaming: boolean): void => {
    const entry: ThinkingEntry = { type: 'thinking', messageId: data.messageId, text: data.text, partial: data.partial, streaming, seq, at };
    const owner = place(entry, data.parentToolCallId, seq, at);
    if (streaming) owner.extra += `t${data.text.length}`;
  };

  for (const event of events) {
    const { seq, at } = event;
    switch (event.type) {
      case SESSION_EVENT.messageUser: {
        closeStack();
        requestIds.push(event.data.requestId);
        push(
          {
            kind: 'user',
            key: `u:${event.data.requestId}`,
            runId: event.data.runId,
            seq,
            at,
            rev: '',
            requestId: event.data.requestId,
            origin: event.data.origin,
            text: event.data.text,
            attachments: event.data.attachments,
            quote: event.data.quote,
            continuesRunId: event.data.continuesRunId,
          },
          seq,
        );
        break;
      }
      case SESSION_EVENT.runStarted: {
        if (!run) break;
        run.agentId = event.data.agentId;
        run.model = event.data.model;
        run.effort = event.data.effort;
        run.permissionMode = event.data.permissionMode;
        run.origin = event.data.origin;
        run.startedAt = at;
        if (!TERMINAL.has(run.status)) run.status = 'running';
        break;
      }
      case SESSION_EVENT.messageAssistant: {
        messageKeys.push(messageKey(event.data.runId, event.data.messageId));
        prose(event.data, seq, at, false);
        break;
      }
      case SESSION_EVENT.thinking: {
        messageKeys.push(messageKey(event.data.runId, event.data.messageId));
        thinking(event.data, seq, at, false);
        break;
      }
      case SESSION_EVENT.toolStarted: {
        const entry = newTool(event.data.toolCallId, seq, at);
        entry.name = event.data.name;
        entry.kind = event.data.kind;
        entry.title = event.data.title;
        entry.input = event.data.input;
        entry.inputTruncated = event.data.inputTruncated;
        const parent = event.data.parentToolCallId === null ? undefined : tools.get(event.data.parentToolCallId);
        const owner = place(entry, event.data.parentToolCallId, seq, at);
        tools.set(entry.toolCallId, entry);
        owners.set(entry.toolCallId, owner);
        if (!parent && run) run.steps += 1;
        break;
      }
      case SESSION_EVENT.toolFinished: {
        let entry = tools.get(event.data.toolCallId);
        if (!entry) {
          // Its start is on an older page that is not loaded: the result still deserves a row.
          entry = newTool(event.data.toolCallId, seq, at);
          const owner = place(entry, null, seq, at);
          tools.set(entry.toolCallId, entry);
          owners.set(entry.toolCallId, owner);
        } else {
          touch(owners.get(entry.toolCallId), seq);
        }
        entry.status = event.data.status;
        entry.output = event.data.output;
        entry.outputOmittedChars = event.data.outputOmittedChars;
        entry.diffs = event.data.diffs;
        entry.diffsTruncated = event.data.diffsTruncated;
        entry.finishedAt = at;
        entry.liveOutput = '';
        break;
      }
      case SESSION_EVENT.todosUpdated: {
        if (todos) {
          todos.item.items = event.data.items;
          touch(todos, seq);
        } else {
          ensureLabel(seq, at);
          closeStack();
          todos = push({ kind: 'todos', key: `todos:${event.data.runId}`, runId: event.data.runId, seq, at, rev: '', items: event.data.items }, seq);
        }
        if (run) run.todos = { done: event.data.items.filter((item) => item.status === 'completed').length, total: event.data.items.length };
        break;
      }
      case SESSION_EVENT.usageReported: {
        usageByModel.set(event.data.model, {
          inputTokens: event.data.inputTokens,
          outputTokens: event.data.outputTokens,
          cacheReadTokens: event.data.cacheReadTokens,
          cacheWriteTokens: event.data.cacheWriteTokens,
          costUsd: event.data.costUsd,
        });
        if (event.data.contextTokens !== null) context = { tokens: event.data.contextTokens, window: event.data.contextWindow, model: event.data.model, at };
        break;
      }
      case SESSION_EVENT.notice: {
        closeStack();
        push({ kind: 'notice', key: `notice:${seq}`, runId: event.data.runId, seq, at, rev: '', level: event.data.level, code: event.data.code, text: event.data.text }, seq);
        break;
      }
      case SESSION_EVENT.approvalRequested: {
        const approval = event.data.approval;
        const tool = approval.kind === 'tool' && approval.toolCallId !== null ? tools.get(approval.toolCallId) : undefined;
        if (tool) {
          // A tool that has a row waits on that row; nothing is added to the transcript for it.
          tool.approval = { id: approval.id, status: 'pending', note: null, decidedBy: null };
          touch(owners.get(tool.toolCallId), seq);
          approvals.set(approval.id, { tool });
          break;
        }
        ensureLabel(seq, at);
        closeStack();
        const row = push(
          { kind: 'approval', key: `approval:${approval.id}`, runId: event.data.runId, seq, at, rev: '', approval, status: 'pending', note: null, answers: null, decidedBy: null, resolvedAt: null },
          seq,
        );
        approvals.set(approval.id, { row });
        break;
      }
      case SESSION_EVENT.approvalResolved: {
        const known = approvals.get(event.data.approvalId);
        if (known?.tool?.approval) {
          known.tool.approval = { id: event.data.approvalId, status: event.data.status, note: event.data.note, decidedBy: event.data.decidedBy };
          touch(owners.get(known.tool.toolCallId), seq);
        } else if (known?.row) {
          known.row.item.status = event.data.status;
          known.row.item.note = event.data.note;
          known.row.item.answers = event.data.answers;
          known.row.item.decidedBy = event.data.decidedBy;
          known.row.item.resolvedAt = at;
          touch(known.row, seq);
        }
        break;
      }
      case SESSION_EVENT.runFinished: {
        closeStack();
        const usage = sumUsage(usageByModel);
        if (run) {
          run.status = event.data.status;
          run.error = event.data.error;
          run.usage = usage;
        }
        // Whatever was still open when the run ended will never finish.
        for (const [toolCallId, entry] of tools) {
          if (entry.status !== 'running') continue;
          entry.status = 'unfinished';
          entry.liveOutput = '';
          const owner = owners.get(toolCallId);
          if (owner) owner.extra += 'u';
        }
        for (const known of approvals.values()) {
          // An approval the log never resolved cannot still be waiting once its run is over.
          if (known.tool?.approval?.status === 'pending') {
            known.tool.approval = { ...known.tool.approval, status: 'cancelled' };
            const owner = owners.get(known.tool.toolCallId);
            if (owner) owner.extra += 'c';
          } else if (known.row && known.row.item.status === 'pending') {
            known.row.item.status = 'cancelled';
            known.row.extra += 'c';
          }
        }
        push(
          {
            kind: 'run-end',
            key: `end:${event.data.runId}`,
            runId: event.data.runId,
            seq,
            at,
            rev: '',
            status: event.data.status,
            error: event.data.error,
            interruptedByRestart: event.data.interruptedByRestart,
            durationMs: event.data.durationMs,
            steps: run?.steps ?? 0,
            usage,
          },
          seq,
        );
        break;
      }
    }
  }

  // What is being written right now goes on top of what is stored.
  const finished = run !== null && TERMINAL.has(run.status);
  if (runId !== null && !finished) {
    const held = new Set(messageKeys);
    for (const block of live.streaming) {
      if (block.runId !== runId || block.text === '' || held.has(messageKey(runId, block.messageId))) continue;
      const data = { messageId: block.messageId, text: block.text, model: null, parentToolCallId: block.parentToolCallId, partial: false };
      if (block.kind === 'text') prose(data, last.seq, last.at, true);
      else thinking(data, last.seq, last.at, true);
    }
    if (takesToolOutput) {
      for (const [toolCallId, text] of Object.entries(live.toolOutput)) {
        const entry = tools.get(toolCallId);
        if (!entry || entry.status !== 'running') continue;
        entry.liveOutput = text;
        const owner = owners.get(toolCallId);
        if (owner) owner.extra += `o${text.length}`;
      }
    }
  }
  if (run && !run.usage) run.usage = sumUsage(usageByModel);

  // Rows whose content did not change keep their identity, so they are not rendered again.
  const before = new Map<string, TranscriptItem>();
  if (previous) for (const item of previous.items) before.set(item.key, item);
  const items: TranscriptItem[] = tracked.map((entry) => {
    const item = entry.item;
    item.rev = item.kind === 'label' ? `${item.agentId ?? ''}:${item.model ?? ''}` : `${entry.count}.${entry.max}.${entry.extra}`;
    const old = before.get(item.key);
    return old && old.kind === item.kind && old.rev === item.rev ? old : item;
  });

  return {
    key: groupKeyOf(first),
    runId,
    firstSeq: first.seq,
    lastSeq: last.seq,
    count: events.length,
    liveSignature: liveSignature(runId, live, takesToolOutput),
    items,
    run,
    context,
    requestIds,
    messageKeys,
    events: events as SessionEvent[],
  };
}

function sumUsage(byModel: Map<string, RunUsage>): RunUsage | null {
  if (byModel.size === 0) return null;
  const total: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
  for (const usage of byModel.values()) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
  }
  return total;
}

// ---- the whole transcript ----------------------------------------------------------

/** The index of the last segment that belongs to a run: the one live tool output is drawn into. */
function lastRunSegmentIndex(groups: readonly { runId: string | null }[]): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) if (groups[index]!.runId !== null) return index;
  return -1;
}

function derive(state: TranscriptState, events: SessionEvent[], live: LiveState, eventsChanged: boolean): TranscriptState {
  const previous = state.segments;
  let segments: Segment[];

  if (eventsChanged) {
    const groups: { key: string; runId: string | null; events: SessionEvent[] }[] = [];
    for (const event of events) {
      const key = groupKeyOf(event);
      const current = groups[groups.length - 1];
      if (current && current.key === key) current.events.push(event);
      else groups.push({ key, runId: runIdOf(event), events: [event] });
    }
    const byStart = new Map<string, Segment>();
    const byKey = new Map<string, Segment>();
    for (const segment of previous) {
      byStart.set(`${segment.key}@${segment.firstSeq}`, segment);
      byKey.set(segment.key, segment);
    }
    const liveAt = lastRunSegmentIndex(groups);
    segments = groups.map((group, index) => {
      const first = group.events[0]!;
      const last = group.events[group.events.length - 1]!;
      const old = byStart.get(`${group.key}@${first.seq}`);
      const signature = liveSignature(group.runId, live, index === liveAt);
      if (old && old.count === group.events.length && old.lastSeq === last.seq && old.liveSignature === signature) return old;
      // A run that grew at the front (an older page arrived) is a new fold, but its unchanged rows are still reused.
      return foldRun(group.events, live, index === liveAt, old ?? byKey.get(group.key));
    });
  } else {
    const liveAt = lastRunSegmentIndex(previous);
    segments = previous.map((segment, index) => {
      const signature = liveSignature(segment.runId, live, index === liveAt);
      return segment.liveSignature === signature ? segment : foldRun(segment.events, live, index === liveAt, segment);
    });
  }

  const unchanged = segments.length === previous.length && segments.every((segment, index) => segment === previous[index]);
  const next: TranscriptState = { ...state, events, live };
  if (events.length > 0) {
    next.firstSeq = events[0]!.seq;
    next.lastSeq = events[events.length - 1]!.seq;
  } else {
    next.firstSeq = 0;
    next.lastSeq = 0;
  }
  if (!unchanged) {
    next.segments = segments;
    next.items = segments.flatMap((segment) => segment.items);
    const runs: Record<string, RunInfo> = {};
    const requestIds = new Set<string>();
    let context: ContextReading | null = null;
    for (const segment of segments) {
      if (segment.run) runs[segment.run.runId] = segment.run;
      for (const requestId of segment.requestIds) requestIds.add(requestId);
      if (segment.context) context = segment.context;
    }
    next.runs = runs;
    next.requestIds = requestIds;
    if (context && (!state.context || context.at >= state.context.at)) next.context = context;
  }
  next.activeRun = deriveActiveRun(next);
  return next;
}

function deriveActiveRun(state: TranscriptState): ActiveRun | null {
  // The snapshot is the server's own word, as of `snapshotSeq`. Only newer events can say otherwise.
  if (state.lastSeq <= state.snapshotSeq) return state.snapshotRun;
  for (let index = state.segments.length - 1; index >= 0; index -= 1) {
    const run = state.segments[index]!.run;
    if (!run) continue;
    if (TERMINAL.has(run.status)) return null;
    return { id: run.runId, status: run.status === 'accepted' ? 'accepted' : 'running', since: run.startedAt ?? run.firstAt };
  }
  return state.snapshotRun;
}

/** The first hole in the sequence numbers held, if there is one. */
function findGap(events: readonly SessionEvent[]): TranscriptState['gap'] {
  for (let index = 1; index < events.length; index += 1) {
    const before = events[index - 1]!.seq;
    const after = events[index]!.seq;
    if (after > before + 1) return { after: before, before: after };
  }
  return null;
}

function indexOfSeq(events: readonly SessionEvent[], seq: number): number {
  let low = 0;
  let high = events.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = events[middle]!.seq;
    if (value === seq) return middle;
    if (value < seq) low = middle + 1;
    else high = middle - 1;
  }
  return -(low + 1);
}

/** Whether a sequence number has already been applied. */
export function hasSeq(state: TranscriptState, seq: number): boolean {
  return indexOfSeq(state.events, seq) >= 0;
}

/**
 * Applies durable events, in whatever order and however often they arrive:
 * live from the socket, replayed after a reconnect, read from a page of
 * history, or fetched to fill a gap. An event whose sequence number is
 * already held changes nothing.
 */
export function applyEvents(state: TranscriptState, incoming: readonly SessionEvent[]): TranscriptState {
  const fresh: SessionEvent[] = [];
  const seen = new Set<number>();
  for (const event of incoming) {
    if (event.seq <= 0 || seen.has(event.seq) || indexOfSeq(state.events, event.seq) >= 0) continue;
    seen.add(event.seq);
    fresh.push(event);
  }
  if (fresh.length === 0) return state;
  fresh.sort((a, b) => a.seq - b.seq);

  let events: SessionEvent[];
  if (state.events.length === 0 || fresh[0]!.seq > state.lastSeq) events = [...state.events, ...fresh];
  else if (fresh[fresh.length - 1]!.seq < state.firstSeq) events = [...fresh, ...state.events];
  else events = [...state.events, ...fresh].sort((a, b) => a.seq - b.seq);

  // What the newest snapshot did not know yet is worked out from the events themselves.
  let { pendingApprovals, unresolvedRuns } = state;
  let live = state.live;
  for (const event of fresh) {
    switch (event.type) {
      case SESSION_EVENT.messageAssistant:
      case SESSION_EVENT.thinking: {
        const { runId, messageId } = event.data;
        if (live.streaming.some((block) => block.runId === runId && block.messageId === messageId)) {
          live = { ...live, streaming: live.streaming.filter((block) => !(block.runId === runId && block.messageId === messageId)) };
        }
        break;
      }
      case SESSION_EVENT.toolFinished: {
        if (event.data.toolCallId in live.toolOutput) {
          const toolOutput = { ...live.toolOutput };
          delete toolOutput[event.data.toolCallId];
          live = { ...live, toolOutput };
        }
        break;
      }
      case SESSION_EVENT.runFinished: {
        const runId = event.data.runId;
        if (live.streaming.some((block) => block.runId === runId) || Object.keys(live.toolOutput).length > 0) {
          live = { streaming: live.streaming.filter((block) => block.runId !== runId), toolOutput: {} };
        }
        if (event.seq > state.snapshotSeq) pendingApprovals = pendingApprovals.filter((approval) => approval.runId !== runId);
        break;
      }
      case SESSION_EVENT.approvalRequested: {
        if (event.seq > state.snapshotSeq && !pendingApprovals.some((approval) => approval.id === event.data.approval.id)) {
          pendingApprovals = [...pendingApprovals, event.data.approval];
        }
        break;
      }
      case SESSION_EVENT.approvalResolved: {
        if (event.seq > state.snapshotSeq) pendingApprovals = pendingApprovals.filter((approval) => approval.id !== event.data.approvalId);
        break;
      }
      case SESSION_EVENT.messageUser: {
        const continued = event.data.continuesRunId;
        if (continued !== null && event.seq > state.snapshotSeq) unresolvedRuns = unresolvedRuns.filter((run) => run.id !== continued);
        break;
      }
      default:
        break;
    }
  }

  const next = derive({ ...state, pendingApprovals, unresolvedRuns }, events, live, true);
  next.gap = findGap(events);
  return next;
}

export const applyEvent = (state: TranscriptState, event: SessionEvent): TranscriptState => applyEvents(state, [event]);

/**
 * A page read from the events route. `older` is true for the newest page and
 * for pages read backwards from it: their `hasMore` says whether history
 * continues before what is held.
 */
export function applyPage(state: TranscriptState, page: { events: readonly SessionEvent[]; hasMore: boolean }, direction: 'older' | 'newer'): TranscriptState {
  const next = applyEvents(state, page.events);
  if (direction !== 'older' || next.hasOlder === page.hasMore) return next;
  return { ...next, hasOlder: page.hasMore };
}

function withBlock(streaming: readonly StreamBlock[], block: StreamBlock): StreamBlock[] {
  const index = streaming.findIndex((entry) => entry.runId === block.runId && entry.messageId === block.messageId);
  if (index === -1) return [...streaming, block];
  const next = [...streaming];
  next[index] = block;
  return next;
}

function messageIsDurable(state: TranscriptState, runId: string, messageId: string): boolean {
  const key = messageKey(runId, messageId);
  for (let index = state.segments.length - 1; index >= 0; index -= 1) {
    const segment = state.segments[index]!;
    if (segment.runId === runId) return segment.messageKeys.includes(key);
  }
  return false;
}

/** Applies an event that is not stored: a delta, tool output as it is produced, a change to the queue. */
export function applyLive(state: TranscriptState, event: LiveSessionEvent): TranscriptState {
  switch (event.type) {
    case LIVE_EVENT.messageDelta:
    case LIVE_EVENT.thinkingDelta: {
      const { runId, messageId, offset, text, parentToolCallId } = event.data;
      // Late deltas of a block that is already complete, or of a run that is over, have nothing left to say.
      const run = state.runs[runId];
      if (text === '' || (run && TERMINAL.has(run.status)) || messageIsDurable(state, runId, messageId)) return state;
      const kind = event.type === LIVE_EVENT.messageDelta ? 'text' : 'thinking';
      const held = state.live.streaming.find((block) => block.runId === runId && block.messageId === messageId);
      // A delta extends the block only where it says it starts: anything else is a repeat, or text that was missed
      // and that the next snapshot will bring.
      if ((held?.text.length ?? 0) !== offset) return state;
      const block: StreamBlock = { runId, messageId, kind, text: (held?.text ?? '') + text, parentToolCallId };
      return derive(state, state.events, { ...state.live, streaming: withBlock(state.live.streaming, block) }, false);
    }
    case LIVE_EVENT.toolOutput: {
      const { toolCallId, text } = event.data;
      if (text === '') return state;
      const combined = ((state.live.toolOutput[toolCallId] ?? '') + text).slice(-LIVE_OUTPUT_CHARS);
      return derive(state, state.events, { ...state.live, toolOutput: { ...state.live.toolOutput, [toolCallId]: combined } }, false);
    }
    case LIVE_EVENT.queueChanged:
      return { ...state, queue: event.data.queue };
    default:
      return state;
  }
}

/**
 * Applies the server's picture of the session right now. `replace` is for the
 * one that comes with a (re)subscription — nothing can be newer; `merge` is
 * for one read over HTTP, which a delta may already have overtaken.
 */
export function applySnapshot(state: TranscriptState, snapshot: SessionSnapshot, mode: 'replace' | 'merge' = 'replace'): TranscriptState {
  if (mode === 'merge' && snapshot.lastSeq < state.snapshotSeq) return state;
  const runId = snapshot.run?.id ?? null;
  let streaming: StreamBlock[] =
    runId === null ? [] : snapshot.streaming.map((block) => ({ runId, messageId: block.messageId, kind: block.kind, text: block.text, parentToolCallId: block.parentToolCallId }));
  const toolOutput: Record<string, string> = {};
  for (const entry of snapshot.toolOutput) toolOutput[entry.toolCallId] = entry.text;

  if (mode === 'merge') {
    for (const mine of state.live.streaming) {
      const theirs = streaming.find((block) => block.runId === mine.runId && block.messageId === mine.messageId);
      if (!theirs) {
        if (mine.runId === runId) streaming = [...streaming, mine];
      } else if (mine.text.length > theirs.text.length) {
        streaming = withBlock(streaming, mine);
      }
    }
    for (const [toolCallId, text] of Object.entries(state.live.toolOutput)) {
      if (text.length > (toolOutput[toolCallId]?.length ?? -1) && runId !== null) toolOutput[toolCallId] = text;
    }
  }

  const snapshotRun: ActiveRun | null = snapshot.run
    ? { id: snapshot.run.id, status: snapshot.run.status === 'accepted' ? 'accepted' : 'running', since: snapshot.run.startedAt ?? snapshot.run.createdAt }
    : null;
  return derive(
    {
      ...state,
      pendingApprovals: snapshot.pendingApprovals,
      queue: snapshot.queue,
      unresolvedRuns: snapshot.unresolvedRuns,
      snapshotSeq: snapshot.lastSeq,
      snapshotRun,
    },
    state.events,
    { streaming, toolOutput },
    false,
  );
}

/** What the usage route says the whole session has used. */
export function applyUsage(state: TranscriptState, usage: SessionUsage): TranscriptState {
  const context = usage.context && (!state.context || usage.context.at >= state.context.at) ? usage.context : state.context;
  return { ...state, totals: usage.totals, context };
}

/** The durable events a client still has to fetch to be whole again, or null. */
export function missingRange(state: TranscriptState, serverLastSeq: number): { after: number } | null {
  if (state.gap) return { after: state.gap.after };
  if (serverLastSeq > state.lastSeq) return { after: state.lastSeq };
  return null;
}
