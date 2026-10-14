import { describe, expect, it } from 'vitest';
import { type AnnouncedThreshold, budgetFraction, budgetState, reachedThreshold, thresholdToAnnounce } from './budgets.js';

describe('how far along a budget is', () => {
  it('is what was used over the amount, and may pass one', () => {
    expect(budgetFraction(250, 1000)).toBe(0.25);
    expect(budgetFraction(1500, 1000)).toBe(1.5);
    expect(budgetFraction(0, 1000)).toBe(0);
    expect(budgetFraction(-5, 1000)).toBe(0);
    expect(budgetFraction(10, 0)).toBe(0);
  });

  it('reaches 80 % at exactly four fifths and 100 % at the amount itself', () => {
    expect(reachedThreshold(0)).toBe(0);
    expect(reachedThreshold(0.7999)).toBe(0);
    expect(reachedThreshold(0.8)).toBe(80);
    expect(reachedThreshold(0.9999)).toBe(80);
    expect(reachedThreshold(1)).toBe(100);
    expect(reachedThreshold(2.5)).toBe(100);
    // Sums of costs are floating-point: 0.1 + 0.2 + 0.5 of a budget of 1 is 80 %.
    expect(reachedThreshold(budgetFraction(0.1 + 0.2 + 0.5, 1))).toBe(80);
    expect(reachedThreshold(budgetFraction(0.1 * 8, 1))).toBe(80);
  });

  it('has a state for each stretch', () => {
    expect(budgetState(0.5)).toBe('ok');
    expect(budgetState(0.8)).toBe('warning');
    expect(budgetState(0.99)).toBe('warning');
    expect(budgetState(1)).toBe('exceeded');
    expect(budgetState(3)).toBe('exceeded');
  });
});

describe('which threshold to announce', () => {
  /** Plays usage through a month the way the service does: what was announced is remembered. */
  function play(steps: ReadonlyArray<{ fraction: number; month?: string }>): Array<number | null> {
    let announcedMonth: string | null = null;
    let announcedThreshold: AnnouncedThreshold = 0;
    return steps.map((step) => {
      const month = step.month ?? '2026-10';
      const threshold = thresholdToAnnounce({ fraction: step.fraction, month, announcedMonth, announcedThreshold });
      if (threshold !== null) {
        announcedMonth = month;
        announcedThreshold = threshold;
      }
      return threshold;
    });
  }

  it('announces each threshold once, when usage first reaches it', () => {
    expect(play([{ fraction: 0.5 }, { fraction: 0.79 }, { fraction: 0.8 }, { fraction: 0.85 }, { fraction: 0.99 }, { fraction: 1 }, { fraction: 1.2 }, { fraction: 5 }])).toEqual([
      null,
      null,
      80,
      null,
      null,
      100,
      null,
      null,
    ]);
  });

  it('announces only the higher one when both are passed in one step', () => {
    expect(play([{ fraction: 0.2 }, { fraction: 1.3 }, { fraction: 1.4 }])).toEqual([null, 100, null]);
  });

  it('starts again with a new month', () => {
    expect(play([{ fraction: 0.9 }, { fraction: 1.1 }, { fraction: 0.1, month: '2026-11' }, { fraction: 0.82, month: '2026-11' }, { fraction: 0.9, month: '2026-11' }])).toEqual([80, 100, null, 80, null]);
  });

  it('does not announce 80 % after 100 % was announced, even if usage is counted lower again', () => {
    expect(play([{ fraction: 1 }, { fraction: 0.85 }, { fraction: 1.05 }])).toEqual([100, null, null]);
  });

  it('announces nothing for a budget that starts out past a threshold the person has already seen', () => {
    // Creating or changing a budget records where usage stands; only the next threshold is news.
    expect(thresholdToAnnounce({ fraction: 0.9, month: '2026-10', announcedMonth: '2026-10', announcedThreshold: 80 })).toBeNull();
    expect(thresholdToAnnounce({ fraction: 1, month: '2026-10', announcedMonth: '2026-10', announcedThreshold: 80 })).toBe(100);
    expect(thresholdToAnnounce({ fraction: 0.9, month: '2026-10', announcedMonth: '2026-09', announcedThreshold: 100 })).toBe(80);
  });
});
