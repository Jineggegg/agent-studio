import { describe, expect, it } from 'vitest';
import { type StoredQuota, ago, assessFreshness, fullestWindow, mergeQuota, normaliseRateLimitInfo, parseStoredQuota, presentQuota, windowLabel } from './quota.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const seconds = (iso: string): number => Date.parse(iso) / 1000;
const millis = (iso: string): number => Date.parse(iso);

/** What Claude Code 2.1.283 prints, as its adapter documents it. */
const claudeInfo = {
  status: 'allowed_warning',
  rateLimitType: 'five_hour',
  resetsAt: seconds('2026-10-14T15:00:00Z'),
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.37, resetsAt: seconds('2026-10-14T15:00:00Z') },
    seven_day: { utilization: 0.82, resetsAt: seconds('2026-10-19T00:00:00Z') },
  },
};

/** What the Codex adapter passes on. */
const codexInfo = {
  limitId: 'codex',
  limitName: null,
  planType: 'plus',
  primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: millis('2026-10-14T16:30:00Z') },
  secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: millis('2026-10-20T08:00:00Z') },
  credits: { hasCredits: true, unlimited: false, balance: '12.50' },
  reached: null,
};

describe('reading what Claude Code reports', () => {
  it('keeps the windows, turns seconds into milliseconds and names what decided the status', () => {
    expect(normaliseRateLimitInfo(claudeInfo, NOW)).toEqual({
      windows: [
        { id: 'five_hour', usedFraction: 0.37, resetsAt: millis('2026-10-14T15:00:00Z'), windowMinutes: 300, observedAt: NOW },
        { id: 'seven_day', usedFraction: 0.82, resetsAt: millis('2026-10-19T00:00:00Z'), windowMinutes: 10080, observedAt: NOW },
      ],
      status: 'warning',
      limitingWindow: 'five_hour',
      usingOverage: false,
      plan: null,
      credits: null,
    });
  });

  it('maps the three statuses and nothing else', () => {
    const statusOf = (status: unknown) => normaliseRateLimitInfo({ ...claudeInfo, status }, NOW)?.status;
    expect(statusOf('allowed')).toBe('allowed');
    expect(statusOf('allowed_warning')).toBe('warning');
    expect(statusOf('rejected')).toBe('limited');
    expect(statusOf('something_new')).toBeNull();
    expect(statusOf(42)).toBeNull();
  });

  it('keeps unknown fields out, whatever they hold', () => {
    const reading = normaliseRateLimitInfo({ ...claudeInfo, accessToken: 'sk-ant-secret-secret-secret', account: { email: 'someone@example.test' }, note: '<script>' }, NOW)!;
    const text = JSON.stringify(reading);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('overage');
    expect(text).not.toContain('script');
    expect(Object.keys(reading).sort()).toEqual(['credits', 'limitingWindow', 'plan', 'status', 'usingOverage', 'windows']);
  });

  it('treats a value of the wrong kind as not said', () => {
    const reading = normaliseRateLimitInfo(
      {
        status: 'allowed',
        isUsingOverage: 'no',
        unifiedWindows: {
          five_hour: { utilization: '0.5', resetsAt: 'soon' }, // nothing usable: left out
          seven_day: { utilization: Number.NaN, resetsAt: seconds('2026-10-19T00:00:00Z') },
          seven_day_opus: { utilization: -0.2, resetsAt: millis('2026-10-19T00:00:00Z') }, // milliseconds where seconds belong
          'bad id!': { utilization: 0.1, resetsAt: seconds('2026-10-19T00:00:00Z') },
          empty: null,
        },
      },
      NOW,
    )!;
    expect(reading.windows).toEqual([{ id: 'seven_day', usedFraction: null, resetsAt: millis('2026-10-19T00:00:00Z'), windowMinutes: 10080, observedAt: NOW }]);
    expect(reading.usingOverage).toBeNull();
  });

  it('caps an over-used window at full', () => {
    const reading = normaliseRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: seconds('2026-10-14T15:00:00Z') } } }, NOW)!;
    expect(reading.windows[0]!.usedFraction).toBe(1);
  });

  it('adds the deciding window when it is named without being listed', () => {
    const reading = normaliseRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: seconds('2026-10-16T00:00:00Z') }, NOW)!;
    expect(reading).toMatchObject({ status: 'limited', limitingWindow: 'seven_day_opus' });
    expect(reading.windows).toEqual([{ id: 'seven_day_opus', usedFraction: null, resetsAt: millis('2026-10-16T00:00:00Z'), windowMinutes: 10080, observedAt: NOW }]);
  });
});

describe('reading what Codex reports', () => {
  it('turns percent into a fraction and keeps lengths, reset times, plan and credits', () => {
    expect(normaliseRateLimitInfo(codexInfo, NOW)).toEqual({
      windows: [
        { id: 'primary', usedFraction: 0.125, resetsAt: millis('2026-10-14T16:30:00Z'), windowMinutes: 300, observedAt: NOW },
        { id: 'secondary', usedFraction: 0.64, resetsAt: millis('2026-10-20T08:00:00Z'), windowMinutes: 10080, observedAt: NOW },
      ],
      status: null,
      limitingWindow: null,
      plan: 'plus',
      usingOverage: null,
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    });
  });

  it('reads a sparse report as what it says and no more', () => {
    const reading = normaliseRateLimitInfo({ ...codexInfo, primary: null, credits: null, planType: null }, NOW)!;
    expect(reading.windows.map((window) => window.id)).toEqual(['secondary']);
    expect(reading.credits).toBeNull();
    expect(reading.plan).toBeNull();
  });

  it('says a limit was reached only when Codex says so', () => {
    expect(normaliseRateLimitInfo({ ...codexInfo, reached: 'rate_limit_reached' }, NOW)!.status).toBe('limited');
    expect(normaliseRateLimitInfo({ ...codexInfo, reached: '' }, NOW)!.status).toBeNull();
    // A full window alone is not a statement about being limited.
    expect(normaliseRateLimitInfo({ ...codexInfo, primary: { usedPercent: 100, windowMinutes: 300, resetsAt: null } }, NOW)!.status).toBeNull();
  });

  it('drops values that are implausible for their unit', () => {
    const reading = normaliseRateLimitInfo(
      {
        planType: 'pro <b>',
        primary: { usedPercent: 250, windowMinutes: -5, resetsAt: seconds('2026-10-14T16:30:00Z') }, // seconds where milliseconds belong
        secondary: { usedPercent: 'half', windowMinutes: 10080, resetsAt: null },
        credits: { hasCredits: 'yes', unlimited: false, balance: '1' },
      },
      NOW,
    )!;
    expect(reading.windows).toEqual([{ id: 'primary', usedFraction: 1, resetsAt: null, windowMinutes: null, observedAt: NOW }]);
    expect(reading.plan).toBeNull();
    expect(reading.credits).toBeNull();
  });

  it('keeps a credit balance only when it is a plain number', () => {
    const balanceOf = (balance: unknown) => normaliseRateLimitInfo({ credits: { hasCredits: true, unlimited: false, balance } }, NOW)!.credits!.balance;
    expect(balanceOf('0')).toBe('0');
    expect(balanceOf('1234.5678')).toBe('1234.5678');
    expect(balanceOf('12.50 USD; DROP TABLE')).toBeNull();
    expect(balanceOf(12.5)).toBeNull();
  });
});

describe('a report nobody recognises', () => {
  it('yields nothing', () => {
    for (const info of [null, undefined, 'limited', 42, [], {}, { foo: 1 }, { windows: [{ id: 'x', used: 1 }] }, { status: 'unheard-of' }, { primary: null, secondary: null }]) {
      expect(normaliseRateLimitInfo(info, NOW), JSON.stringify(info)).toBeNull();
    }
  });
});

describe('laying a new report over what was known', () => {
  const first = normaliseRateLimitInfo(codexInfo, NOW - HOUR)!;

  it('replaces the windows it mentions and keeps the others with their own time', () => {
    const next = normaliseRateLimitInfo({ primary: { usedPercent: 40, windowMinutes: 300, resetsAt: millis('2026-10-14T16:30:00Z') }, secondary: null, credits: null, reached: null }, NOW)!;
    const merged = mergeQuota(first, next, NOW);
    expect(merged.windows).toEqual([
      { id: 'primary', usedFraction: 0.4, resetsAt: millis('2026-10-14T16:30:00Z'), windowMinutes: 300, observedAt: NOW },
      { id: 'secondary', usedFraction: 0.64, resetsAt: millis('2026-10-20T08:00:00Z'), windowMinutes: 10080, observedAt: NOW - HOUR },
    ]);
    // What it did not mention again stays known; what it says about its status does not.
    expect(merged.plan).toBe('plus');
    expect(merged.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' });
  });

  it('never carries "limited" over from an older report', () => {
    const limited = normaliseRateLimitInfo({ ...codexInfo, reached: 'rate_limit_reached' }, NOW - HOUR)!;
    const merged = mergeQuota(limited, normaliseRateLimitInfo(codexInfo, NOW)!, NOW);
    expect(merged.status).toBeNull();
  });

  it('forgets a window nobody has mentioned for more than a week', () => {
    const old = normaliseRateLimitInfo(codexInfo, NOW - 9 * 24 * HOUR)!;
    const next = normaliseRateLimitInfo({ primary: { usedPercent: 1, windowMinutes: 300, resetsAt: null }, secondary: null }, NOW)!;
    expect(mergeQuota(old, next, NOW).windows.map((window) => window.id)).toEqual(['primary']);
  });

  it('is the new report alone when nothing was known', () => {
    const next = normaliseRateLimitInfo(claudeInfo, NOW)!;
    expect(mergeQuota(null, next, NOW)).toEqual(next);
  });

  it('survives being stored and read back', () => {
    const stored = JSON.stringify(mergeQuota(null, first, NOW));
    expect(parseStoredQuota(stored)).toEqual(first);
    expect(parseStoredQuota('not json')).toBeNull();
    expect(parseStoredQuota('{"windows":"none"}')).toBeNull();
    expect(parseStoredQuota('[]')).toBeNull();
  });
});

describe('how far a reading can be trusted', () => {
  const quota = normaliseRateLimitInfo(claudeInfo, NOW)!;
  const assess = (now: number, observedAt = NOW, reading: StoredQuota | null = quota) =>
    assessFreshness({ quota: reading, observedAt: reading ? observedAt : null, now, staleAfterMs: 15 * MINUTE, agentName: 'Claude Code' });

  it('is fresh while it is recent and no window it describes has started again', () => {
    expect(assess(NOW)).toEqual({ state: 'fresh', staleCode: null, staleReason: null });
    expect(assess(NOW + 15 * MINUTE).state).toBe('fresh');
  });

  it('goes stale with age, and says how old it is and how it gets renewed', () => {
    const stale = assess(NOW + 42 * MINUTE);
    expect(stale.state).toBe('stale');
    expect(stale.staleCode).toBe('old');
    expect(stale.staleReason).toBe('Claude Code reported this 42 minutes ago, and the account may have been used since. It is renewed the next time Claude Code runs.');
  });

  it('goes stale the moment a reset time it mentioned has passed, however recent it is', () => {
    const justObserved = Date.parse('2026-10-14T14:59:00Z');
    expect(assess(Date.parse('2026-10-14T14:59:59Z'), justObserved).state).toBe('fresh');
    const stale = assess(Date.parse('2026-10-14T15:00:00Z'), justObserved);
    expect(stale).toMatchObject({ state: 'stale', staleCode: 'reset-passed' });
    expect(stale.staleReason).toContain('5-hour window');
    expect(stale.staleReason).toContain('2026-10-14 15:00 UTC');
    expect(stale.staleReason).toContain('the next time Claude Code runs');
  });

  it('gives the passed reset as the reason even when the reading is old as well', () => {
    expect(assess(NOW + 6 * HOUR).staleCode).toBe('reset-passed');
  });

  it('says that nothing was reported yet when that is so', () => {
    expect(assess(NOW, NOW, null)).toEqual({ state: 'none', staleCode: null, staleReason: 'Claude Code has not reported its limits yet. It does so while it runs.' });
  });
});

describe('what a client is given', () => {
  it('carries the time of the observation, what is left, and that nothing can be refreshed by hand', () => {
    const quota = normaliseRateLimitInfo(claudeInfo, NOW)!;
    const shown = presentQuota({ agentId: 'claude-code', agentName: 'Claude Code', available: true, quota, observedAt: NOW, now: NOW + MINUTE, staleAfterMs: 15 * MINUTE });
    expect(shown).toMatchObject({ agentId: 'claude-code', state: 'fresh', observedAt: NOW, refreshable: false, status: 'warning', limitingWindow: 'five_hour', usingOverage: false, plan: null, credits: null });
    expect(shown.refreshHint).toContain('asks no usage service');
    expect(shown.windows[0]).toEqual({
      id: 'five_hour',
      label: '5-hour window',
      usedFraction: 0.37,
      remainingFraction: 1 - 0.37,
      resetsAt: Date.parse('2026-10-14T15:00:00Z'),
      windowMinutes: 300,
      observedAt: NOW,
      resetPassed: false,
    });
    expect(shown.windows[0]!.remainingFraction).toBeCloseTo(0.63, 10);
    expect(shown.windows[1]).toMatchObject({ id: 'seven_day', label: 'Weekly window', usedFraction: 0.82 });
    expect(shown.windows[1]!.remainingFraction).toBeCloseTo(0.18, 10);
  });

  it('marks the windows that have started again and leaves them out of the one-line summary', () => {
    const quota = normaliseRateLimitInfo(claudeInfo, NOW)!;
    const later = presentQuota({ agentId: 'claude-code', agentName: 'Claude Code', available: true, quota, observedAt: NOW, now: Date.parse('2026-10-14T15:30:00Z'), staleAfterMs: 15 * MINUTE });
    expect(later.state).toBe('stale');
    expect(later.windows.map((window) => window.resetPassed)).toEqual([true, false]);
    expect(fullestWindow(later)?.id).toBe('seven_day');
    const before = presentQuota({ agentId: 'claude-code', agentName: 'Claude Code', available: true, quota, observedAt: NOW, now: NOW, staleAfterMs: 15 * MINUTE });
    expect(fullestWindow(before)?.id).toBe('seven_day'); // 82 % is fuller than 37 %
  });

  it('answers for an agent that never reported', () => {
    const shown = presentQuota({ agentId: 'codex', agentName: 'Codex', available: false, quota: null, observedAt: null, now: NOW, staleAfterMs: 15 * MINUTE });
    expect(shown).toMatchObject({ state: 'none', observedAt: null, windows: [], status: null, available: false, refreshable: false });
    expect(fullestWindow(shown)).toBeNull();
  });

  it('names windows from their length, and from their id when that is all there is', () => {
    expect(windowLabel('primary', 300)).toBe('5-hour window');
    expect(windowLabel('secondary', 10080)).toBe('Weekly window');
    expect(windowLabel('seven_day_opus', 10080)).toBe('Weekly window (opus)');
    expect(windowLabel('primary', 1440)).toBe('Daily window');
    expect(windowLabel('primary', 4320)).toBe('3-day window');
    expect(windowLabel('primary', 120)).toBe('2-hour window');
    expect(windowLabel('primary', 45)).toBe('45-minute window');
    expect(windowLabel('primary', null)).toBe('Primary window');
    expect(windowLabel('monthly_cap', null)).toBe('Monthly cap window');
  });

  it('says how long ago in the largest unit that fits', () => {
    expect(ago(20_000)).toBe('less than a minute');
    expect(ago(MINUTE)).toBe('1 minute');
    expect(ago(59 * MINUTE)).toBe('59 minutes');
    expect(ago(HOUR)).toBe('1 hour');
    expect(ago(47 * HOUR)).toBe('47 hours');
    expect(ago(72 * HOUR)).toBe('3 days');
  });
});
