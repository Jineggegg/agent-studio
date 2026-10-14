import type { ParticipantState, SynthesisState } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { deriveTaskState, isFinal, isUnresolved, isWorking, synthesisStep } from './task-state.js';
import { titleFromPrompt } from './tasks.js';

type Shorthand = ParticipantState | `${'failed' | 'interrupted'}:acknowledged`;

const facts = (participants: readonly Shorthand[], options: { stopped?: boolean; synthesis?: SynthesisState | null } = {}) => ({
  stopped: options.stopped ?? false,
  participants: participants.map((entry) => {
    const [state, acknowledged] = entry.split(':');
    return { state: state as ParticipantState, acknowledged: acknowledged === 'acknowledged' };
  }),
  synthesis: options.synthesis ?? null,
});

describe('the state of a task', () => {
  it('is running while everybody works and nothing waits for the person', () => {
    expect(deriveTaskState(facts(['starting', 'starting', 'starting']))).toBe('running');
    expect(deriveTaskState(facts(['running', 'running']))).toBe('running');
    expect(deriveTaskState(facts(['running', 'completed', 'stopped']))).toBe('running');
  });

  it('needs attention as soon as one participant waits for an approval', () => {
    expect(deriveTaskState(facts(['running', 'waiting-approval', 'running']))).toBe('needs-attention');
    expect(deriveTaskState(facts(['completed', 'waiting-approval']))).toBe('needs-attention');
  });

  it('needs attention while a failure or an interruption is unresolved, also when the others still work', () => {
    expect(deriveTaskState(facts(['running', 'failed']))).toBe('needs-attention');
    expect(deriveTaskState(facts(['completed', 'interrupted']))).toBe('needs-attention');
    expect(deriveTaskState(facts(['completed', 'waiting-approval', 'failed']))).toBe('needs-attention');
    expect(deriveTaskState(facts(['failed', 'failed', 'failed']))).toBe('needs-attention');
    expect(deriveTaskState(facts(['interrupted', 'interrupted']))).toBe('needs-attention');
  });

  it('is completed once everybody has ended and no failure is left unresolved', () => {
    expect(deriveTaskState(facts(['completed', 'completed', 'completed']))).toBe('completed');
    expect(deriveTaskState(facts(['completed', 'failed:acknowledged']))).toBe('completed');
    expect(deriveTaskState(facts(['completed', 'interrupted:acknowledged', 'stopped']))).toBe('completed');
    // Every one of them failed, and the person has seen that: the task is over.
    expect(deriveTaskState(facts(['failed:acknowledged', 'failed:acknowledged']))).toBe('completed');
    // An acknowledged failure does not hide one that is not.
    expect(deriveTaskState(facts(['failed:acknowledged', 'failed']))).toBe('needs-attention');
  });

  it('is stopped when stop was pressed, whatever the participants report afterwards', () => {
    expect(deriveTaskState(facts(['stopped', 'stopped'], { stopped: true }))).toBe('stopped');
    expect(deriveTaskState(facts(['completed', 'stopped', 'failed'], { stopped: true }))).toBe('stopped');
    expect(deriveTaskState(facts(['running', 'waiting-approval'], { stopped: true }))).toBe('stopped');
    expect(deriveTaskState(facts(['completed', 'completed'], { stopped: true, synthesis: 'skipped' }))).toBe('stopped');
  });

  it('is stopped when every participant was stopped one by one, and completed when only some were', () => {
    expect(deriveTaskState(facts(['stopped', 'stopped', 'stopped']))).toBe('stopped');
    expect(deriveTaskState(facts(['stopped', 'completed']))).toBe('completed');
  });

  it('keeps running while a synthesis is due or under way, and is completed however the synthesis ends', () => {
    expect(deriveTaskState(facts(['completed', 'completed'], { synthesis: 'pending' }))).toBe('running');
    expect(deriveTaskState(facts(['completed', 'completed'], { synthesis: 'starting' }))).toBe('running');
    expect(deriveTaskState(facts(['completed', 'completed'], { synthesis: 'running' }))).toBe('running');
    expect(deriveTaskState(facts(['completed', 'completed'], { synthesis: 'waiting-approval' }))).toBe('needs-attention');
    for (const ending of ['completed', 'failed', 'stopped', 'interrupted', 'skipped'] as const) {
      expect(deriveTaskState(facts(['completed', 'completed'], { synthesis: ending })), ending).toBe('completed');
    }
    // A failed participant still asks for attention, whatever the synthesis did.
    expect(deriveTaskState(facts(['completed', 'failed'], { synthesis: 'pending' }))).toBe('needs-attention');
    expect(deriveTaskState(facts(['stopped', 'stopped'], { synthesis: 'skipped' }))).toBe('stopped');
  });

  it('knows which states are the end', () => {
    expect(['running', 'needs-attention', 'completed', 'stopped'].map((state) => isFinal(state as never))).toEqual([false, false, true, true]);
    expect(['starting', 'running', 'waiting-approval', 'completed', 'failed', 'stopped', 'interrupted', 'pending', 'skipped'].map((state) => isWorking(state as never))).toEqual([true, true, true, false, false, false, false, false, false]);
    expect(isUnresolved({ state: 'failed', acknowledged: false })).toBe(true);
    expect(isUnresolved({ state: 'interrupted', acknowledged: false })).toBe(true);
    expect(isUnresolved({ state: 'failed', acknowledged: true })).toBe(false);
    expect(isUnresolved({ state: 'stopped', acknowledged: false })).toBe(false);
  });
});

describe('when a synthesis starts', () => {
  it('waits for everybody, and for failures to be dealt with', () => {
    expect(synthesisStep(facts(['running', 'completed'], { synthesis: 'pending' }))).toBe('wait');
    expect(synthesisStep(facts(['waiting-approval', 'completed'], { synthesis: 'pending' }))).toBe('wait');
    expect(synthesisStep(facts(['starting', 'starting'], { synthesis: 'pending' }))).toBe('wait');
    expect(synthesisStep(facts(['completed', 'failed'], { synthesis: 'pending' }))).toBe('wait');
    expect(synthesisStep(facts(['completed', 'interrupted'], { synthesis: 'pending' }))).toBe('wait');
  });

  it('starts when all have ended and at least one finished its run', () => {
    expect(synthesisStep(facts(['completed', 'completed'], { synthesis: 'pending' }))).toBe('start');
    expect(synthesisStep(facts(['completed', 'failed:acknowledged', 'stopped'], { synthesis: 'pending' }))).toBe('start');
  });

  it('is skipped when nobody finished', () => {
    expect(synthesisStep(facts(['stopped', 'stopped'], { synthesis: 'pending' }))).toBe('skip');
    expect(synthesisStep(facts(['failed:acknowledged', 'stopped'], { synthesis: 'pending' }))).toBe('skip');
  });

  it('happens once, and never for a task that was stopped or has none', () => {
    for (const state of ['starting', 'running', 'waiting-approval', 'completed', 'failed', 'stopped', 'interrupted', 'skipped'] as const) {
      expect(synthesisStep(facts(['completed', 'completed'], { synthesis: state })), state).toBeNull();
    }
    expect(synthesisStep(facts(['completed', 'completed'], { synthesis: 'pending', stopped: true }))).toBeNull();
    expect(synthesisStep(facts(['completed', 'completed']))).toBeNull();
  });
});

describe('the name of a task', () => {
  it('is the start of its prompt, on one line', () => {
    expect(titleFromPrompt('  Compare\n\nthe two   caching designs  ')).toBe('Compare the two caching designs');
    expect(titleFromPrompt('x'.repeat(200))).toBe(`${'x'.repeat(79)}…`);
    expect([...titleFromPrompt('字'.repeat(200))]).toHaveLength(80);
  });
});
