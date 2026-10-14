import type { ModelUsage, ParticipantState, SynthesisState, Task, TaskParticipant, TaskState, WorkOrigin } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';

/** The words and tone for the states of tasks, participants and running work. Pure. */

export type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';

export const TASK_STATE: Record<TaskState, { label: MessageKey; tone: Tone }> = {
  running: { label: 'collab.task.state.running', tone: 'accent' },
  'needs-attention': { label: 'collab.task.state.attention', tone: 'warning' },
  completed: { label: 'collab.task.state.completed', tone: 'positive' },
  stopped: { label: 'collab.task.state.stopped', tone: 'neutral' },
};

export const PARTICIPANT_STATE: Record<ParticipantState, { label: MessageKey; tone: Tone }> = {
  starting: { label: 'collab.participant.starting', tone: 'neutral' },
  running: { label: 'collab.participant.running', tone: 'accent' },
  'waiting-approval': { label: 'collab.participant.waiting', tone: 'warning' },
  completed: { label: 'collab.participant.completed', tone: 'positive' },
  failed: { label: 'collab.participant.failed', tone: 'danger' },
  stopped: { label: 'collab.participant.stopped', tone: 'neutral' },
  interrupted: { label: 'collab.participant.interrupted', tone: 'warning' },
};

export function synthesisState(state: SynthesisState): { label: MessageKey; tone: Tone } {
  if (state === 'pending') return { label: 'collab.synthesis.pending', tone: 'neutral' };
  if (state === 'skipped') return { label: 'collab.synthesis.skipped', tone: 'neutral' };
  return PARTICIPANT_STATE[state];
}

/** A failure or interruption that was dismissed no longer asks for anything. */
export function participantState(participant: Pick<TaskParticipant, 'state' | 'acknowledged'>): { label: MessageKey; tone: Tone } {
  const base = PARTICIPANT_STATE[participant.state];
  if (participant.acknowledged && (participant.state === 'failed' || participant.state === 'interrupted')) return { ...base, tone: 'neutral' };
  return base;
}

export const ORIGIN_WORDS: Record<WorkOrigin, MessageKey> = {
  interactive: 'collab.origin.interactive',
  queued: 'collab.origin.queued',
  continue: 'collab.origin.continue',
  scheduled: 'collab.origin.scheduled',
  automation: 'collab.origin.automation',
  'task-participant': 'collab.origin.task',
  'task-synthesis': 'collab.origin.synthesis',
};

/** Whether anything in the task still works (and can therefore be stopped). */
export const taskActive = (task: Pick<Task, 'state'>): boolean => task.state === 'running' || task.state === 'needs-attention';

/** How far a task has got: participants that have ended, of all. */
export function taskProgress(task: Pick<Task, 'participants'>): { ended: number; total: number } {
  const ended = task.participants.filter((participant) => ['completed', 'failed', 'stopped', 'interrupted'].includes(participant.state)).length;
  return { ended, total: task.participants.length };
}

/** Everything a participant's session used, summed over models. */
export function usageTotals(usage: readonly ModelUsage[] | null): { tokens: number; costUsd: number | null } | null {
  if (!usage || usage.length === 0) return null;
  let tokens = 0;
  let cost: number | null = null;
  for (const entry of usage) {
    tokens += entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
    if (entry.costUsd !== null) cost = (cost ?? 0) + entry.costUsd;
  }
  return { tokens, costUsd: cost };
}

/** An answer longer than this starts folded. */
export const ANSWER_FOLD_CHARS = 1200;
