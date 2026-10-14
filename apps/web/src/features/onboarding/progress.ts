import type { Role } from '@agent-studio/protocol';

/**
 * Where a person stands with the welcome guide, kept as an account
 * preference so it follows them to every device: which steps are done or
 * skipped, and whether the guide was finished or put away for good. Once it
 * is either, it is never offered again by itself (it stays in Settings).
 */
export const WELCOME_KEY = 'onboarding.progress';

export const STEPS = ['identity', 'agents', 'project', 'notifications'] as const;
export type StepId = (typeof STEPS)[number];
export type StepOutcome = 'done' | 'skipped';

export interface WelcomeProgress {
  v: 1;
  state: 'open' | 'finished' | 'dismissed';
  steps: Partial<Record<StepId, StepOutcome>>;
  updatedAt: number;
}

/** The owner sets the Studio up; a member gets the lighter version: what concerns their own account and device. */
export function stepsFor(role: Role): StepId[] {
  return role === 'owner' ? [...STEPS] : ['identity', 'notifications'];
}

/** What is stored, if it is something this client understands. */
export function parseProgress(value: unknown): WelcomeProgress | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || (record.state !== 'open' && record.state !== 'finished' && record.state !== 'dismissed')) return null;
  const steps: Partial<Record<StepId, StepOutcome>> = {};
  if (typeof record.steps === 'object' && record.steps !== null) {
    for (const step of STEPS) {
      const outcome = (record.steps as Record<string, unknown>)[step];
      if (outcome === 'done' || outcome === 'skipped') steps[step] = outcome;
    }
  }
  return { v: 1, state: record.state, steps, updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0 };
}

export const freshProgress = (now: number): WelcomeProgress => ({ v: 1, state: 'open', steps: {}, updatedAt: now });

/** The first step of this person's guide that is neither done nor skipped; null when all are. */
export function nextStep(progress: WelcomeProgress | null, role: Role): StepId | null {
  return stepsFor(role).find((step) => !progress?.steps[step]) ?? null;
}

export function markStep(progress: WelcomeProgress | null, step: StepId, outcome: StepOutcome, now: number): WelcomeProgress {
  const base = progress ?? freshProgress(now);
  return { ...base, state: base.state === 'dismissed' ? 'dismissed' : 'open', steps: { ...base.steps, [step]: outcome }, updatedAt: now };
}

export const finishProgress = (progress: WelcomeProgress | null, now: number): WelcomeProgress => ({ ...(progress ?? freshProgress(now)), state: 'finished', updatedAt: now });

export const dismissProgress = (progress: WelcomeProgress | null, now: number): WelcomeProgress => ({ ...(progress ?? freshProgress(now)), state: 'dismissed', updatedAt: now });

/** An account this new is offered the guide: one made before the guide existed is not interrupted by it. */
export const NEW_ACCOUNT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether the launcher offers the guide: only once the account's preferences
 * have been read (so a finished guide never flashes up), never after it was
 * finished or put away, and only to an account made recently — or to anyone
 * who started it and has not finished.
 */
export function shouldOffer(progress: WelcomeProgress | null, options: { loaded: boolean; createdAt: number; now: number }): boolean {
  if (!options.loaded) return false;
  if (progress) return progress.state === 'open';
  return options.now - options.createdAt < NEW_ACCOUNT_MS;
}

/** How many of this person's steps are behind them. */
export function stepsDone(progress: WelcomeProgress | null, role: Role): { done: number; total: number } {
  const steps = stepsFor(role);
  return { done: steps.filter((step) => progress?.steps[step]).length, total: steps.length };
}
