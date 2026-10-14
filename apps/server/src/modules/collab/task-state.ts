import type { ParticipantState, SynthesisState, TaskState } from '@agent-studio/protocol';

/**
 * The state of a multi-agent task, worked out from its participants. Pure
 * functions: the same facts always give the same answer, which is also what
 * makes a task's state survive a restart.
 *
 * A participant is  starting → running ⇄ waiting-approval → completed | failed | stopped | interrupted.
 * A run that failed or was interrupted and is then continued in its session
 * puts its participant back to `running`; one that is dismissed there (or in
 * the inbox) stays as it ended and is marked `acknowledged`.
 *
 * The task is
 *
 * - `stopped`          once "stop" was pressed — whatever the participants did before;
 * - `needs-attention`  while a participant (or the synthesis) waits for an approval, or while a
 *                      participant's failure or interruption is neither continued nor acknowledged;
 * - `running`          otherwise, while anybody is still working or the synthesis is yet to start;
 * - `stopped`          when all have ended and every one of them was stopped;
 * - `completed`        when all have ended otherwise. A synthesis that failed, was stopped or was
 *                      skipped does not change that: the participants' work is done.
 */

export interface ParticipantFacts {
  readonly state: ParticipantState;
  /** A failed or interrupted run that was dismissed. */
  readonly acknowledged: boolean;
}

export interface TaskFacts {
  /** "Stop" was pressed for the task as a whole. */
  readonly stopped: boolean;
  readonly participants: readonly ParticipantFacts[];
  /** Null when no synthesis was asked for. */
  readonly synthesis: SynthesisState | null;
}

const WORKING: ReadonlySet<string> = new Set(['starting', 'running', 'waiting-approval']);

/** Still at work, or about to be. */
export const isWorking = (state: SynthesisState): boolean => WORKING.has(state);

/** Ended in a way a person has to look at. */
export const isUnresolved = (participant: ParticipantFacts): boolean =>
  (participant.state === 'failed' || participant.state === 'interrupted') && !participant.acknowledged;

export function deriveTaskState(facts: TaskFacts): TaskState {
  if (facts.stopped) return 'stopped';
  const working = facts.participants.some((participant) => isWorking(participant.state)) || (facts.synthesis !== null && isWorking(facts.synthesis));
  const waiting = facts.participants.some((participant) => participant.state === 'waiting-approval') || facts.synthesis === 'waiting-approval';
  const unresolved = facts.participants.some(isUnresolved);
  if (waiting || unresolved) return 'needs-attention';
  if (working || facts.synthesis === 'pending') return 'running';
  if (facts.participants.length > 0 && facts.participants.every((participant) => participant.state === 'stopped')) return 'stopped';
  return 'completed';
}

/**
 * What to do about a synthesis that has not started.
 *
 * `wait`   somebody is still working, or a failure waits for the person: the answers are not all in.
 * `start`  everybody has ended and at least one participant finished its run.
 * `skip`   everybody has ended and nobody finished: there is nothing to compare.
 * Null: there is no synthesis, it is past `pending`, or the task was stopped.
 */
export function synthesisStep(facts: TaskFacts): 'wait' | 'start' | 'skip' | null {
  if (facts.synthesis !== 'pending' || facts.stopped) return null;
  if (facts.participants.some((participant) => isWorking(participant.state)) || facts.participants.some(isUnresolved)) return 'wait';
  return facts.participants.some((participant) => participant.state === 'completed') ? 'start' : 'skip';
}

/** A task that will not change by itself any more. */
export const isFinal = (state: TaskState): boolean => state === 'completed' || state === 'stopped';
