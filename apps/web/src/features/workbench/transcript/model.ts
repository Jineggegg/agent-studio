import type {
  Approval,
  ApprovalStatus,
  AttachmentRef,
  FileDiff,
  ModelUsage,
  PermissionMode,
  QuestionAnswer,
  QueuedMessage,
  Run,
  RunError,
  RunOrigin,
  SessionEvent,
  TerminalRunStatus,
  TodoItem,
  ToolKind,
} from '@agent-studio/protocol';

/**
 * What a session's event log becomes on screen.
 *
 * The log is folded one run at a time (a session has at most one run in
 * progress, so a run's events are contiguous) into rows — {@link TranscriptItem}s.
 * Every row has a stable `key` (so a streaming block and the durable event that
 * replaces it are the same row to React) and a `rev` that changes exactly when
 * its content does (so unchanged rows are not rendered again).
 */

interface ItemBase {
  /** Stable across streaming → durable, and across reloads. */
  key: string;
  runId: string | null;
  /** The sequence number of the first event that made this row. */
  seq: number;
  /** Server time of that event. */
  at: number;
  /** Changes when, and only when, the row's content changes. */
  rev: string;
}

export interface UserItem extends ItemBase {
  kind: 'user';
  requestId: string;
  origin: 'interactive' | 'queued' | 'steer' | 'continue' | 'scheduled' | 'automation';
  text: string;
  attachments: AttachmentRef[];
  quote: string | null;
  continuesRunId: string | null;
}

/** Names who is answering: one per run, before its first output. */
export interface LabelItem extends ItemBase {
  kind: 'label';
  agentId: string | null;
  model: string | null;
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant';
  messageId: string;
  text: string;
  model: string | null;
  /** Cut short by a stop or a failure. */
  partial: boolean;
  /** Still arriving: the text grows, and the durable event has not come yet. */
  streaming: boolean;
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'unfinished';

export interface ToolEntry {
  type: 'tool';
  toolCallId: string;
  name: string;
  kind: ToolKind;
  title: string;
  input: unknown;
  inputTruncated: boolean;
  status: ToolStatus;
  output: string;
  outputOmittedChars: number;
  /** Output seen so far while the tool runs (not stored; replaced by `output` at the end). */
  liveOutput: string;
  diffs: FileDiff[];
  diffsTruncated: boolean;
  /** What a sub-agent did: its own reasoning, prose and tool calls. */
  children: StackEntry[];
  startedAt: number;
  finishedAt: number | null;
  /** The approval this call waited for, if any. */
  approval: { id: string; status: ApprovalStatus; note: string | null; decidedBy: string | null } | null;
  seq: number;
}

export interface ThinkingEntry {
  type: 'thinking';
  messageId: string;
  text: string;
  partial: boolean;
  streaming: boolean;
  seq: number;
  at: number;
}

/** Prose written by a sub-agent, shown inside the call that spawned it. */
export interface ProseEntry {
  type: 'prose';
  messageId: string;
  text: string;
  partial: boolean;
  streaming: boolean;
  seq: number;
}

export type StackEntry = ToolEntry | ThinkingEntry | ProseEntry;

/** Consecutive tool calls, and the reasoning between them, as one compact list. */
export interface StackItem extends ItemBase {
  kind: 'stack';
  entries: StackEntry[];
}

/** The agent's to-do list: one per run, replaced in place every time it changes. */
export interface TodosItem extends ItemBase {
  kind: 'todos';
  items: TodoItem[];
}

export interface NoticeItem extends ItemBase {
  kind: 'notice';
  level: 'info' | 'warning' | 'error';
  code: string;
  text: string;
}

/** A plan, a question, or a tool request that has no row of its own to hang on. */
export interface ApprovalItem extends ItemBase {
  kind: 'approval';
  approval: Approval;
  status: ApprovalStatus;
  note: string | null;
  answers: QuestionAnswer[] | null;
  decidedBy: string | null;
  resolvedAt: number | null;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when no model of the run reported a cost. */
  costUsd: number | null;
}

/** Where a run ended: how, how long it took, what it used. */
export interface RunEndItem extends ItemBase {
  kind: 'run-end';
  status: TerminalRunStatus;
  error: RunError | null;
  interruptedByRestart: boolean;
  durationMs: number;
  steps: number;
  usage: RunUsage | null;
}

export type TranscriptItem = UserItem | LabelItem | AssistantItem | StackItem | TodosItem | NoticeItem | ApprovalItem | RunEndItem;

export interface RunInfo {
  runId: string;
  agentId: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode | null;
  origin: RunOrigin | null;
  /** `accepted` until `run.started` is seen. */
  status: 'accepted' | 'running' | TerminalRunStatus;
  /** Server time of `run.started`. */
  startedAt: number | null;
  /** Server time of the first event of the run that is loaded. */
  firstAt: number;
  /** Tool calls made by the agent itself (not by its sub-agents). */
  steps: number;
  todos: { done: number; total: number } | null;
  error: RunError | null;
  usage: RunUsage | null;
}

export interface StreamBlock {
  runId: string;
  messageId: string;
  kind: 'text' | 'thinking';
  text: string;
  parentToolCallId: string | null;
}

export interface LiveState {
  /** Blocks being written that are not durable yet, in order of first arrival. */
  streaming: StreamBlock[];
  /** The newest output of tools still running, by tool call. */
  toolOutput: Record<string, string>;
}

export interface Segment {
  /** The run's id, or `n:<seq>` for events outside any run. */
  key: string;
  runId: string | null;
  firstSeq: number;
  lastSeq: number;
  count: number;
  /** What of the live state went into this fold; a different signature means fold again. */
  liveSignature: string;
  items: TranscriptItem[];
  run: RunInfo | null;
  /** The newest context figure reported inside this segment. */
  context: ContextReading | null;
  /** Request ids of the user messages in this segment. */
  requestIds: string[];
  /** `<runId>:<messageId>` of every completed block of prose or reasoning in this segment. */
  messageKeys: string[];
  /** The events this segment was folded from. */
  events: SessionEvent[];
}

export interface ContextReading {
  tokens: number;
  /** Null when the agent did not say how large its window is. */
  window: number | null;
  model: string;
  at: number;
}

export interface ActiveRun {
  id: string;
  status: 'accepted' | 'running';
  /** Server time the run started (or was accepted, until it starts). */
  since: number;
}

export interface TranscriptState {
  sessionId: string;
  /** Every durable event held, oldest first, each sequence number once. */
  events: SessionEvent[];
  firstSeq: number;
  lastSeq: number;
  /** Older events exist on the server before `firstSeq`. */
  hasOlder: boolean;
  segments: Segment[];
  items: TranscriptItem[];
  runs: Record<string, RunInfo>;
  /** Request ids of every user message in `events`: an optimistic copy with one of these is a duplicate. */
  requestIds: ReadonlySet<string>;
  live: LiveState;
  /** The run in progress, if any. */
  activeRun: ActiveRun | null;
  pendingApprovals: Approval[];
  queue: QueuedMessage[];
  /** Failed or interrupted runs that were neither continued nor dismissed. */
  unresolvedRuns: Run[];
  context: ContextReading | null;
  /** Everything the session has used, per model, as last read from the server. */
  totals: ModelUsage[];
  /** `lastSeq` of the newest snapshot applied; what it says outranks anything folded from older events. */
  snapshotSeq: number;
  /** Whether that snapshot named a run in progress. */
  snapshotRun: ActiveRun | null;
  /** Sequence numbers known to be missing between held events (a reconnect that fell behind the replay window). */
  gap: { after: number; before: number } | null;
}

export type { SessionEvent };
