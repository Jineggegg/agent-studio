import type { UsageBucket, UsageCost } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/i18n';
import { windowLabel } from './PlanWindows';
import { bucketLabel, costCaveat, costState, costText, niceTicks, shapeBuckets } from './shape';

const t = getTranslator('en');

function cost(coverage: UsageCost['coverage'], usd: number | null, pricedRuns = 0, unpricedRuns = 0): UsageCost {
  return { coverage, usd, pricedRuns, unpricedRuns };
}

function bucket(key: string, overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key,
    start: 0,
    end: 1,
    current: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    reasoningTokens: null,
    cost: cost('none', null),
    runs: 0,
    sessions: 0,
    ...overrides,
  };
}

describe('chart data', () => {
  const buckets = [
    bucket('2026-10-12'),
    bucket('2026-10-13', { totalTokens: 1200, runs: 2, cost: cost('complete', 0.42, 2) }),
    bucket('2026-10-14', { totalTokens: 800, runs: 3, cost: cost('unknown', null, 0, 3) }),
    bucket('2026-10-15', { totalTokens: 500, runs: 2, cost: cost('partial', 0.1, 1, 1) }),
    bucket('2026-10-16', { totalTokens: 40, runs: 1, cost: cost('complete', 0, 1), current: true }),
  ];

  it('keeps every bucket of the range, empty ones included', () => {
    const data = shapeBuckets(buckets, 'day', 'tokens', t);
    expect(data.map((datum) => datum.key)).toEqual(buckets.map((entry) => entry.key));
    expect(data.map((datum) => datum.state)).toEqual(['none', 'value', 'value', 'value', 'value']);
    expect(data.map((datum) => datum.value)).toEqual([0, 1200, 800, 500, 40]);
    expect(data[4]!.current).toBe(true);
  });

  it('never draws an unknown cost as zero, and marks a partial one as a lower bound', () => {
    const data = shapeBuckets(buckets, 'day', 'cost', t);
    expect(data.map((datum) => datum.state)).toEqual(['none', 'value', 'unknown', 'partial', 'zero']);
    expect(data.map((datum) => datum.value)).toEqual([0, 0.42, 0, 0.1, 0]);
    expect(costState(cost('complete', 0))).toBe('zero');
    expect(costState(cost('unknown', null))).toBe('unknown');
  });

  it('says a cost in words that keep unknown apart from zero', () => {
    expect(costText(cost('unknown', null, 0, 3), t)).toBe('Unknown');
    expect(costText(cost('complete', 0, 1), t)).toBe('$0.00');
    expect(costText(cost('partial', 1.5, 1, 2), t)).toBe('at least $1.50');
    expect(costText(cost('none', null), t)).toBe('No runs');
    expect(costText(cost('complete', 0.0123, 1), t)).toBe('$0.0123');
    expect(costCaveat(cost('partial', 1.5, 1, 2), t)).toBe('2 runs have no cost, so the real amount is higher.');
    expect(costCaveat(cost('complete', 1, 1), t)).toBeNull();
  });

  it('names buckets from their calendar keys, in the report’s own zone', () => {
    expect(bucketLabel('2026-10-14', 'day', t)).toBe('10/14');
    expect(bucketLabel('2026-10-14', 'day', t, true)).toBe('Wed, Oct 14, 2026');
    expect(bucketLabel('2026-10-12', 'week', t, true)).toBe('Week of Oct 12, 2026');
    expect(bucketLabel('2026-10', 'month', t)).toBe('Oct');
    expect(bucketLabel('2026-10', 'month', t, true)).toBe('October 2026');
    expect(bucketLabel('2026-10', 'month', getTranslator('zh-CN'), true)).toBe('2026年10月');
  });

  it('puts axis steps on round numbers that reach past the largest value', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(1200)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(0.42)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(3_400_000)).toEqual([0, 1_000_000, 2_000_000, 3_000_000, 4_000_000]);
  });
});

describe('plan windows', () => {
  it('are named from their length, else from the program', () => {
    expect(windowLabel({ id: 'five_hour', label: 'Five hours', windowMinutes: null }, t)).toBe('5-hour window');
    expect(windowLabel({ id: 'primary', label: 'Primary', windowMinutes: 10_080 }, t)).toBe('Weekly window');
    expect(windowLabel({ id: 'secondary', label: 'Secondary', windowMinutes: 1440 }, t)).toBe('1-day window');
    expect(windowLabel({ id: 'odd', label: 'Odd window', windowMinutes: 45 }, t)).toBe('Odd window');
  });
});
