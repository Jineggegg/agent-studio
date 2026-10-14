import type { Approval, RunError, TerminalRunStatus } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';
import type { StackEntry, ToolEntry, TranscriptState } from '../transcript/model';

/**
 * What the agent is doing right now, for the run status row — worked out from
 * the transcript state rather than tracked separately, so it can never
 * disagree with what the transcript shows.
 */
export type Activity =
  /** Accepted; the agent has not started yet. */
  | { phase: 'starting' }
  /** Something waits for a person. */
  | { phase: 'waiting'; approval: Approval; more: number }
  | { phase: 'tool'; tool: ToolEntry }
  | { phase: 'thinking' }
  | { phase: 'writing' }
  /** Running, with nothing particular to name. */
  | { phase: 'working' };

export interface RunProgress {
  activity: Activity;
  /** Server time the run started. */
  since: number;
  steps: number;
  todos: { done: number; total: number } | null;
}

/** The innermost call still running: a sub-agent's own step says more than "sub-agent". */
function deepestRunning(entries: readonly StackEntry[]): ToolEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== 'tool' || entry.status !== 'running') continue;
    return deepestRunning(entry.children) ?? entry;
  }
  return null;
}

export function runProgress(state: TranscriptState): RunProgress | null {
  const active = state.activeRun;
  if (!active) return null;
  const run = state.runs[active.id];
  const base = { since: active.since, steps: run?.steps ?? 0, todos: run?.todos ?? null };

  const waiting = state.pendingApprovals.filter((approval) => approval.runId === active.id);
  if (waiting.length > 0) return { ...base, activity: { phase: 'waiting', approval: waiting[0]!, more: waiting.length - 1 } };
  if (active.status === 'accepted') return { ...base, activity: { phase: 'starting' } };

  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index]!;
    if (item.runId !== active.id) break;
    if (item.kind === 'stack') {
      const tool = deepestRunning(item.entries);
      if (tool) return { ...base, activity: { phase: 'tool', tool } };
      const last = item.entries[item.entries.length - 1];
      if (last?.type === 'thinking' && last.streaming) return { ...base, activity: { phase: 'thinking' } };
    }
    if (item.kind === 'assistant' && item.streaming) return { ...base, activity: { phase: 'writing' } };
    // Only the newest row can be in progress.
    if (item.kind !== 'todos') break;
  }
  const streaming = state.live.streaming.filter((block) => block.runId === active.id);
  const newest = streaming[streaming.length - 1];
  if (newest) return { ...base, activity: { phase: newest.kind === 'thinking' ? 'thinking' : 'writing' } };
  return { ...base, activity: { phase: 'working' } };
}

/** "8 s", "2 min 05 s", "1 h 12 min" — elapsed time that ticks without jumping in width. */
export function formatElapsed(ms: number, labels: { seconds: string; minutes: string; hours: string }): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} ${labels.seconds}`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} ${labels.minutes} ${String(total % 60).padStart(2, '0')} ${labels.seconds}`;
  return `${Math.floor(minutes / 60)} ${labels.hours} ${String(minutes % 60).padStart(2, '0')} ${labels.minutes}`;
}

/** Run errors with words of our own; the server's sentence is shown underneath as the detail. */
const ERROR_TITLES: Record<string, MessageKey> = {
  not_installed: 'workbench.runError.not_installed',
  not_signed_in: 'workbench.runError.not_signed_in',
  rate_limited: 'workbench.runError.rate_limited',
  usage_limit: 'workbench.runError.rate_limited',
  quota_exceeded: 'workbench.runError.rate_limited',
  agent_unavailable: 'workbench.runError.agent_unavailable',
  agent_not_enabled: 'workbench.runError.agent_not_enabled',
  access_revoked: 'workbench.runError.access_revoked',
  project_missing: 'workbench.runError.project_missing',
  server_restart: 'workbench.runError.server_restart',
};

export interface RunOutcome {
  title: MessageKey;
  /** The server's own sentence, when it adds something. */
  detail: string | null;
  tone: 'neutral' | 'positive' | 'warning' | 'danger';
}

export function describeOutcome(status: TerminalRunStatus, error: RunError | null, interruptedByRestart: boolean): RunOutcome {
  if (status === 'completed') return { title: 'workbench.run.completed', detail: null, tone: 'positive' };
  if (status === 'stopped') return { title: 'workbench.run.stopped', detail: null, tone: 'neutral' };
  if (status === 'interrupted') {
    return { title: interruptedByRestart ? 'workbench.run.interruptedByRestart' : 'workbench.run.interrupted', detail: interruptedByRestart ? null : (error?.message ?? null), tone: 'warning' };
  }
  const known = error ? ERROR_TITLES[error.code] : undefined;
  return { title: known ?? 'workbench.run.failed', detail: error?.message ?? null, tone: 'danger' };
}
