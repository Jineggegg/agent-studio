import { AUTOMATION_LIMITS, type AutomationTrigger } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { MISSED_COUNT_CAP, ScheduleError, type ScheduleTrigger, describeInstant, instantOf, latestOccurrence, nextOccurrence, planOverdue, upcomingOccurrences, validateSchedule } from './schedule.js';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const next = (trigger: ScheduleTrigger, timeZone: string, after: string) => iso(nextOccurrence(trigger, timeZone, at(after)));
const HOUR = 60 * 60 * 1000;

const daily = (time: string): ScheduleTrigger => ({ type: 'daily', time });

describe('the next run of each trigger', () => {
  it('once: the instant its wall-clock date and time denote in the zone, and nothing after it', () => {
    const trigger: ScheduleTrigger = { type: 'once', date: '2026-12-24', time: '18:00' };
    expect(next(trigger, 'Asia/Shanghai', '2026-10-13T00:00:00Z')).toBe('2026-12-24T10:00:00.000Z');
    expect(next(trigger, 'America/Los_Angeles', '2026-10-13T00:00:00Z')).toBe('2026-12-25T02:00:00.000Z');
    expect(next(trigger, 'UTC', '2026-12-24T17:59:59Z')).toBe('2026-12-24T18:00:00.000Z');
    expect(next(trigger, 'UTC', '2026-12-24T18:00:00Z')).toBeNull();
    expect(iso(instantOf('2028-02-29', '00:30', 'Europe/Berlin'))).toBe('2028-02-28T23:30:00.000Z');
    expect(() => instantOf('2027-02-30', '08:00', 'UTC')).toThrow(ScheduleError);
  });

  it('hourly: at its minute, every hour', () => {
    const trigger: ScheduleTrigger = { type: 'hourly', minute: 25 };
    expect(next(trigger, 'Europe/Berlin', '2026-10-13T09:10:00Z')).toBe('2026-10-13T09:25:00.000Z');
    expect(next(trigger, 'Europe/Berlin', '2026-10-13T09:25:00Z')).toBe('2026-10-13T10:25:00.000Z');
    // A zone that is half an hour off the hour has its own idea of "minute 25".
    expect(next(trigger, 'Asia/Kolkata', '2026-10-13T09:10:00Z')).toBe('2026-10-13T09:55:00.000Z');
  });

  it('daily: at its time in the zone, whatever the server\'s own zone', () => {
    expect(next(daily('08:00'), 'Asia/Shanghai', '2026-10-13T00:00:00Z')).toBe('2026-10-14T00:00:00.000Z');
    expect(next(daily('08:00'), 'Asia/Shanghai', '2026-10-12T23:59:00Z')).toBe('2026-10-13T00:00:00.000Z');
    expect(next(daily('08:00'), 'America/New_York', '2026-10-13T00:00:00Z')).toBe('2026-10-13T12:00:00.000Z');
    expect(next(daily('23:45'), 'Pacific/Kiritimati', '2026-10-13T00:00:00Z')).toBe('2026-10-13T09:45:00.000Z');
  });

  it('weekdays: Monday to Friday — created on Friday evening, it next runs on Monday morning', () => {
    const trigger: ScheduleTrigger = { type: 'weekdays', time: '08:00' };
    // Friday 2026-10-16 18:00 in Shanghai.
    expect(next(trigger, 'Asia/Shanghai', '2026-10-16T10:00:00Z')).toBe('2026-10-19T00:00:00.000Z');
    // Friday 07:00: later the same day.
    expect(next(trigger, 'Asia/Shanghai', '2026-10-15T23:00:00Z')).toBe('2026-10-16T00:00:00.000Z');
    const week = upcomingOccurrences(trigger, 'Asia/Shanghai', at('2026-10-16T10:00:00Z'), 6).map((ms) => new Date(ms + 8 * HOUR).getUTCDay());
    expect(week).toEqual([1, 2, 3, 4, 5, 1]);
    // A weekend in between that includes a clock change: still 08:00 on the clock on Monday.
    expect(next(trigger, 'Europe/Berlin', '2026-10-23T16:00:00Z')).toBe('2026-10-26T07:00:00.000Z');
    expect(next(trigger, 'Europe/Berlin', '2026-10-16T16:00:00Z')).toBe('2026-10-19T06:00:00.000Z');
  });

  it('weekly: on each chosen day, in order through the week', () => {
    const trigger: ScheduleTrigger = { type: 'weekly', days: [5, 1], time: '17:00' };
    // From Tuesday 2026-10-13: Friday, Monday, Friday …
    expect(upcomingOccurrences(trigger, 'Europe/London', at('2026-10-13T00:00:00Z'), 3).map(iso)).toEqual([
      '2026-10-16T16:00:00.000Z',
      '2026-10-19T16:00:00.000Z',
      '2026-10-23T16:00:00.000Z',
    ]);
    expect(next({ type: 'weekly', days: [0], time: '09:30' }, 'UTC', '2026-10-13T00:00:00Z')).toBe('2026-10-18T09:30:00.000Z');
  });

  it('cron: five fields, read in the zone', () => {
    expect(next({ type: 'cron', expression: '30 6 1 * *' }, 'Asia/Tokyo', '2026-10-13T00:00:00Z')).toBe('2026-10-31T21:30:00.000Z');
    expect(next({ type: 'cron', expression: '0 9 * * MON' }, 'UTC', '2026-10-13T00:00:00Z')).toBe('2026-10-19T09:00:00.000Z');
    expect(next({ type: 'cron', expression: '*/15 9-17 * * 1-5' }, 'UTC', '2026-10-13T17:50:00Z')).toBe('2026-10-14T09:00:00.000Z');
  });
});

describe('the days the clocks change', () => {
  // New York: clocks go forward on 2027-03-14 (02:00 → 03:00) and back on 2026-11-01 (02:00 → 01:00).
  const NY = 'America/New_York';

  it('spring forward: an ordinary time keeps its place on the clock — the gap between two runs is 23 hours', () => {
    expect(upcomingOccurrences(daily('08:00'), NY, at('2027-03-12T12:00:00Z'), 4).map(iso)).toEqual([
      '2027-03-12T13:00:00.000Z', // 08:00 EST
      '2027-03-13T13:00:00.000Z',
      '2027-03-14T12:00:00.000Z', // 08:00 EDT
      '2027-03-15T12:00:00.000Z',
    ]);
  });

  it('spring forward: a time that does not exist that day runs once, an hour later on the clock', () => {
    const runs = upcomingOccurrences(daily('02:30'), NY, at('2027-03-12T12:00:00Z'), 4).map(iso);
    expect(runs).toEqual([
      '2027-03-13T07:30:00.000Z', // 02:30 EST
      '2027-03-14T07:30:00.000Z', // there is no 02:30: it runs at 03:30 EDT
      '2027-03-15T06:30:00.000Z', // 02:30 EDT
      '2027-03-16T06:30:00.000Z',
    ]);
    // Once that day, not zero times and not twice.
    expect(runs.filter((run) => run!.startsWith('2027-03-14'))).toHaveLength(1);
    expect(iso(instantOf('2027-03-14', '02:30', NY))).toBe('2027-03-14T07:30:00.000Z');
  });

  it('spring forward: an hourly trigger fires every real hour — nothing is skipped and nothing doubles', () => {
    const runs = upcomingOccurrences({ type: 'hourly', minute: 15 }, NY, at('2027-03-14T04:30:00Z'), 5);
    expect(runs.map(iso)).toEqual(['2027-03-14T05:15:00.000Z', '2027-03-14T06:15:00.000Z', '2027-03-14T07:15:00.000Z', '2027-03-14T08:15:00.000Z', '2027-03-14T09:15:00.000Z']);
  });

  it('fall back: an ordinary time keeps its place on the clock — the gap between two runs is 25 hours', () => {
    expect(upcomingOccurrences(daily('08:00'), NY, at('2026-10-30T13:00:00Z'), 3).map(iso)).toEqual([
      '2026-10-31T12:00:00.000Z', // 08:00 EDT
      '2026-11-01T13:00:00.000Z', // 08:00 EST
      '2026-11-02T13:00:00.000Z',
    ]);
  });

  it('fall back: a time that occurs twice that day runs once, the first time', () => {
    const runs = upcomingOccurrences(daily('01:30'), NY, at('2026-10-30T12:00:00Z'), 4).map(iso);
    expect(runs).toEqual([
      '2026-10-31T05:30:00.000Z', // 01:30 EDT
      '2026-11-01T05:30:00.000Z', // the first 01:30 (EDT); the second, an hour later, is not a run
      '2026-11-02T06:30:00.000Z', // 01:30 EST
      '2026-11-03T06:30:00.000Z',
    ]);
    expect(runs.filter((run) => run!.startsWith('2026-11-01'))).toHaveLength(1);
  });

  it('fall back: an hourly trigger does not fire a second time in the repeated hour', () => {
    const runs = upcomingOccurrences({ type: 'hourly', minute: 15 }, NY, at('2026-11-01T03:30:00Z'), 4).map(iso);
    expect(runs).toEqual(['2026-11-01T04:15:00.000Z', '2026-11-01T05:15:00.000Z', '2026-11-01T07:15:00.000Z', '2026-11-01T08:15:00.000Z']);
  });

  it('the same holds in a zone that changes on another date and in the other hemisphere', () => {
    // Berlin goes forward on 2027-03-28; 02:30 does not exist that day.
    expect(upcomingOccurrences(daily('02:30'), 'Europe/Berlin', at('2027-03-26T12:00:00Z'), 3).map(iso)).toEqual([
      '2027-03-27T01:30:00.000Z',
      '2027-03-28T01:30:00.000Z',
      '2027-03-29T00:30:00.000Z',
    ]);
    // Sydney goes forward on 2026-10-04 and back on 2027-04-04.
    expect(upcomingOccurrences(daily('09:00'), 'Australia/Sydney', at('2026-10-02T12:00:00Z'), 3).map(iso)).toEqual([
      '2026-10-02T23:00:00.000Z',
      '2026-10-03T22:00:00.000Z',
      '2026-10-04T22:00:00.000Z',
    ]);
  });

  it('looking backwards agrees with looking forwards across both changes', () => {
    for (const [trigger, zone, from] of [
      [daily('02:30'), NY, '2027-03-12T12:00:00Z'],
      [daily('01:30'), NY, '2026-10-30T12:00:00Z'],
      [{ type: 'hourly', minute: 15 }, NY, '2026-11-01T03:30:00Z'],
      [{ type: 'weekdays', time: '08:00' }, 'Europe/Berlin', '2026-10-22T12:00:00Z'],
    ] as Array<[ScheduleTrigger, string, string]>) {
      const runs = upcomingOccurrences(trigger, zone, at(from), 6);
      for (let index = 1; index < runs.length; index += 1) {
        // Just before a run the latest one is its predecessor; at it and just after, it is the run itself.
        expect(iso(latestOccurrence(trigger, zone, runs[index]! - 1))).toBe(iso(runs[index - 1]!));
        expect(iso(latestOccurrence(trigger, zone, runs[index]!))).toBe(iso(runs[index]!));
        expect(iso(latestOccurrence(trigger, zone, runs[index]! + 999))).toBe(iso(runs[index]!));
        expect(iso(latestOccurrence(trigger, zone, runs[index]! + 61_000))).toBe(iso(runs[index]!));
      }
    }
  });
});

describe('what is refused', () => {
  const now = at('2026-10-13T12:00:00Z');
  const refusal = (trigger: AutomationTrigger, zone = 'UTC'): string | null => {
    try {
      validateSchedule(trigger as ScheduleTrigger, zone, now);
      return null;
    } catch (error) {
      if (error instanceof ScheduleError) return error.code;
      throw error;
    }
  };

  it('a one-off in the past, and a zone that does not exist', () => {
    expect(refusal({ type: 'once', date: '2026-10-12', time: '09:00' })).toBe('time_passed');
    expect(refusal({ type: 'once', date: '2026-10-13', time: '12:00' })).toBe('time_passed');
    expect(refusal({ type: 'once', date: '2026-10-13', time: '12:01' })).toBeNull();
    // "Today 20:30" is in the past in Shanghai and in the future in Los Angeles.
    expect(refusal({ type: 'once', date: '2026-10-13', time: '19:59' }, 'Asia/Shanghai')).toBe('time_passed');
    expect(refusal({ type: 'once', date: '2026-10-13', time: '19:59' }, 'America/Los_Angeles')).toBeNull();
    expect(refusal(daily('08:00'), 'Mars/Olympus')).toBe('invalid_time_zone');
    expect(refusal(daily('08:00'), '')).toBe('invalid_time_zone');
  });

  it('cron expressions that do not parse, never fire, or fire too often', () => {
    const cron = (expression: string) => refusal({ type: 'cron', expression });
    for (const expression of ['0 8 * * *', '*/5 * * * *', '0,30 9-17 * * 1-5', '15 3 1 1 *', '0 0 29 2 *', '@daily']) expect(cron(expression), expression).toBeNull();
    for (const expression of ['61 8 * * *', '0 25 * * *', 'every day at 8', '* * * *', '0 8 * * * *', '0 0 8 * * * 2027', '0 8 * * 9', '$(reboot) * * * *']) {
      expect(cron(expression), expression).toBe('invalid_cron');
    }
    expect(cron('0 0 31 2 *')).toBe('never_runs');
    for (const expression of ['* * * * *', '*/2 * * * *', '0,1 8 * * *', '*/7 * * * *', '58,59 23 31 12 *']) expect(cron(expression), expression).toBe('cron_too_frequent');
    expect(AUTOMATION_LIMITS.minIntervalMinutes).toBe(5);
  });
});

describe('a run whose time came while nobody was looking', () => {
  const zone = 'Europe/Berlin';
  const grace = AUTOMATION_LIMITS.graceMs;
  // Daily at 08:00 Berlin (06:00 UTC in October).
  const plan = (dueAt: string, now: string, trigger: ScheduleTrigger = daily('08:00')) => {
    const result = planOverdue({ trigger, timeZone: zone, dueAt: at(dueAt), now: at(now), graceMs: grace });
    return { ...result, scheduledFor: iso(result.scheduledFor), next: iso(result.next) };
  };

  it('on time: it runs, and the schedule moves to the next occurrence', () => {
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T06:00:20Z')).toEqual({ action: 'run', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 0, next: '2026-10-14T06:00:00.000Z' });
  });

  it('down from 07:00 to 10:00: made up once, shortly after the start', () => {
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T08:00:05Z')).toEqual({ action: 'run', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 0, next: '2026-10-14T06:00:00.000Z' });
  });

  it('back at 15:00: too late — recorded as missed, and tomorrow is next', () => {
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T13:00:00Z')).toEqual({ action: 'missed', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 0, next: '2026-10-14T06:00:00.000Z' });
  });

  it('the boundary is the grace window exactly', () => {
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T12:00:00Z').action).toBe('run');
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T12:00:00.001Z').action).toBe('missed');
    expect(grace).toBe(6 * HOUR);
  });

  it('down for days: only the most recent occurrence is made up, the earlier ones are counted', () => {
    // Due on the 10th; back on the 13th at 07:30 UTC (09:30 in Berlin).
    expect(plan('2026-10-10T06:00:00Z', '2026-10-13T07:30:00Z')).toEqual({ action: 'run', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 3, next: '2026-10-14T06:00:00.000Z' });
    // Back in the evening: today's is too old as well.
    expect(plan('2026-10-10T06:00:00Z', '2026-10-13T18:00:00Z')).toEqual({ action: 'missed', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 3, next: '2026-10-14T06:00:00.000Z' });
  });

  it('an hourly automation after a long night runs once, not once per hour', () => {
    const hourly: ScheduleTrigger = { type: 'hourly', minute: 0 };
    expect(plan('2026-10-12T20:00:00Z', '2026-10-13T06:10:00Z', hourly)).toEqual({ action: 'run', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 10, next: '2026-10-13T07:00:00.000Z' });
    // The count stops at a cap; the plan does not get slower with the length of the outage.
    const long = plan('2026-01-01T00:00:00Z', '2026-10-13T06:10:00Z', hourly);
    expect(long).toMatchObject({ action: 'run', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: MISSED_COUNT_CAP });
  });

  it('a one-off is made up within the window and missed after it, and never has a next run', () => {
    const once: ScheduleTrigger = { type: 'once', date: '2026-10-13', time: '08:00' };
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T09:00:00Z', once)).toEqual({ action: 'run', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 0, next: null });
    expect(plan('2026-10-13T06:00:00Z', '2026-10-13T12:30:00Z', once)).toEqual({ action: 'missed', scheduledFor: '2026-10-13T06:00:00.000Z', earlierMissed: 0, next: null });
  });

  it('the outage spans a clock change: the run made up is still the one at 08:00 on the clock', () => {
    // Berlin goes back on 2026-10-25. Due on Friday the 23rd; back on Monday the 26th at 08:30 (07:30 UTC).
    expect(plan('2026-10-23T06:00:00Z', '2026-10-26T07:30:00Z')).toEqual({ action: 'run', scheduledFor: '2026-10-26T07:00:00.000Z', earlierMissed: 3, next: '2026-10-27T07:00:00.000Z' });
  });
});

describe('describing an instant', () => {
  it('uses the automation\'s zone, not the server\'s', () => {
    expect(describeInstant(at('2026-10-13T06:00:00Z'), 'Europe/Berlin', 'en')).toBe('Oct 13, 08:00');
    expect(describeInstant(at('2026-10-13T06:00:00Z'), 'Asia/Shanghai', 'en')).toBe('Oct 13, 14:00');
    expect(describeInstant(at('2026-10-13T06:00:00Z'), 'Asia/Shanghai', 'zh-CN')).toContain('14:00');
  });
});
