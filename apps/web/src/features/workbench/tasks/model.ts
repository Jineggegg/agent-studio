import type { StackEntry, TranscriptState } from '../transcript/model';
export interface ConversationTask {
  id: string;
  type: 'run' | 'agent' | 'tool';
  title: string;
  status:
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'unfinished'
    | 'denied'
    | 'accepted'
    | 'interrupted';
  startedAt: number | null;
  finishedAt: number | null;
}
export function conversationTasks(state: TranscriptState): ConversationTask[] {
  const tasks: ConversationTask[] = [];
  for (const run of Object.values(state.runs)) {
    const end = state.items.find((item) => item.kind === 'run-end' && item.runId === run.runId);
    tasks.push({
      id: `run:${run.runId}`,
      type: 'run',
      title: run.agentId ?? '',
      status:
        run.status === 'running' &&
        state.pendingApprovals.some((approval) => approval.runId === run.runId)
          ? 'waiting'
          : run.status,
      startedAt: run.startedAt,
      finishedAt: end?.at ?? null,
    });
  }
  const visit = (entries: StackEntry[], runId: string | null) => {
    for (const entry of entries) {
      if (entry.type !== 'tool') continue;
      tasks.push({
        id: `${runId}:${entry.toolCallId}`,
        type: entry.kind === 'agent' ? 'agent' : 'tool',
        title: entry.title || entry.name,
        status:
          entry.status === 'running' && entry.approval?.status === 'pending'
            ? 'waiting'
            : entry.status === 'ok'
              ? 'completed'
              : entry.status === 'error'
                ? 'failed'
                : entry.status,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
      });
      visit(entry.children, runId);
    }
  };
  for (const item of state.items) if (item.kind === 'stack') visit(item.entries, item.runId);
  return tasks
    .sort(
      (a, b) =>
        Number(b.status === 'running' || b.status === 'accepted' || b.status === 'waiting') -
          Number(a.status === 'running' || a.status === 'accepted' || a.status === 'waiting') ||
        (b.startedAt ?? 0) - (a.startedAt ?? 0),
    )
    .slice(0, 40);
}
