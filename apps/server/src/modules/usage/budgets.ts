import { BUDGET_THRESHOLDS, type BudgetState, type BudgetThreshold } from '@agent-studio/protocol';

/**
 * The arithmetic of a budget's thresholds. Pure functions.
 *
 * A budget never blocks anything. All it does is say, once per month and
 * threshold, that usage has reached 80 % or 100 % of the amount.
 */

export type AnnouncedThreshold = 0 | BudgetThreshold;

/** `used / amount`. An amount of zero cannot be stored; this guards the arithmetic all the same. */
export function budgetFraction(used: number, amount: number): number {
  return amount > 0 ? Math.max(0, used) / amount : 0;
}

/** The highest threshold a fraction has reached, or 0. */
export function reachedThreshold(fraction: number): AnnouncedThreshold {
  let reached: AnnouncedThreshold = 0;
  // Compared in whole thousandths of a percent, so that 0.8 is 80 % and not 79.99999 %.
  const percent = Math.round(fraction * 100_000) / 1000;
  for (const threshold of BUDGET_THRESHOLDS) if (percent >= threshold) reached = threshold;
  return reached;
}

export function budgetState(fraction: number): BudgetState {
  const reached = reachedThreshold(fraction);
  return reached === 100 ? 'exceeded' : reached === 80 ? 'warning' : 'ok';
}

/**
 * The threshold to announce now, or null. `announcedMonth` and
 * `announcedThreshold` are what was last announced; a new month starts from
 * nothing. When both thresholds are passed in one step only the higher is
 * announced — one message says it all.
 */
export function thresholdToAnnounce(input: { fraction: number; month: string; announcedMonth: string | null; announcedThreshold: AnnouncedThreshold }): BudgetThreshold | null {
  const already: AnnouncedThreshold = input.announcedMonth === input.month ? input.announcedThreshold : 0;
  const reached = reachedThreshold(input.fraction);
  return reached > already ? (reached as BudgetThreshold) : null;
}
