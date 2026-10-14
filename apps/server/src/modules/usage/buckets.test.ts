import { describe, expect, it } from 'vitest';
import { RangeTooLong, addDays, addMonths, bucketKey, bucketStartDate, dayOf, formatDate, localDate, monthOf, parseDate, resolveRange, startOfDay } from './buckets.js';

const at = (iso: string): number => Date.parse(iso);
const iso = (instant: number): string => new Date(instant).toISOString();
const HOUR = 60 * 60 * 1000;

describe('the calendar date of an instant', () => {
  it('depends on the zone it is asked in', () => {
    const instant = at('2026-10-31T23:30:00Z');
    expect(formatDate(localDate(instant, 'UTC'))).toBe('2026-10-31');
    expect(formatDate(localDate(instant, 'Asia/Shanghai'))).toBe('2026-11-01');
    expect(formatDate(localDate(instant, 'America/Los_Angeles'))).toBe('2026-10-31');
  });

  it('follows the zone across a year end', () => {
    expect(formatDate(localDate(at('2026-12-31T20:00:00Z'), 'Asia/Tokyo'))).toBe('2027-01-01');
    expect(formatDate(localDate(at('2027-01-01T03:00:00Z'), 'America/New_York'))).toBe('2026-12-31');
  });
});

describe('date arithmetic', () => {
  it('moves over month ends and leap days', () => {
    expect(formatDate(addDays(parseDate('2026-01-31'), 1))).toBe('2026-02-01');
    expect(formatDate(addDays(parseDate('2028-02-28'), 1))).toBe('2028-02-29');
    expect(formatDate(addDays(parseDate('2027-02-28'), 1))).toBe('2027-03-01');
    expect(formatDate(addDays(parseDate('2026-03-01'), -1))).toBe('2026-02-28');
    expect(formatDate(addDays(parseDate('2026-12-31'), 1))).toBe('2027-01-01');
  });

  it('steps months from their first day, whatever day it started on', () => {
    expect(formatDate(addMonths(parseDate('2026-01-31'), 1))).toBe('2026-02-01');
    expect(formatDate(addMonths(parseDate('2026-12-15'), 1))).toBe('2027-01-01');
    expect(formatDate(addMonths(parseDate('2026-03-31'), -1))).toBe('2026-02-01');
  });

  it('starts a week on its Monday and a month on its first', () => {
    // 1 January 2026 is a Thursday.
    expect(formatDate(bucketStartDate(parseDate('2026-01-01'), 'week'))).toBe('2025-12-29');
    expect(formatDate(bucketStartDate(parseDate('2026-01-04'), 'week'))).toBe('2025-12-29'); // Sunday closes the week
    expect(formatDate(bucketStartDate(parseDate('2026-01-05'), 'week'))).toBe('2026-01-05'); // Monday opens the next
    expect(formatDate(bucketStartDate(parseDate('2026-02-28'), 'month'))).toBe('2026-02-01');
    expect(formatDate(bucketStartDate(parseDate('2026-02-28'), 'day'))).toBe('2026-02-28');
    expect(bucketKey(parseDate('2026-02-01'), 'month')).toBe('2026-02');
    expect(bucketKey(parseDate('2025-12-29'), 'week')).toBe('2025-12-29');
  });
});

describe('the first instant of a day', () => {
  it('is midnight on the wall clock of the zone', () => {
    expect(iso(startOfDay(parseDate('2026-03-01'), 'UTC'))).toBe('2026-03-01T00:00:00.000Z');
    expect(iso(startOfDay(parseDate('2026-03-01'), 'Asia/Shanghai'))).toBe('2026-02-28T16:00:00.000Z');
    expect(iso(startOfDay(parseDate('2026-03-01'), 'America/Los_Angeles'))).toBe('2026-03-01T08:00:00.000Z');
  });

  it('handles zones that are not a whole number of hours from UTC', () => {
    expect(iso(startOfDay(parseDate('2026-01-01'), 'Asia/Kathmandu'))).toBe('2025-12-31T18:15:00.000Z');
    expect(iso(startOfDay(parseDate('2026-07-01'), 'Asia/Kolkata'))).toBe('2026-06-30T18:30:00.000Z');
  });

  it('makes a day 23 hours long when the clocks go forward and 25 when they go back', () => {
    // New York: clocks go forward on 8 March 2026.
    const spring = startOfDay(parseDate('2026-03-08'), 'America/New_York');
    expect(iso(spring)).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfDay(parseDate('2026-03-09'), 'America/New_York') - spring).toBe(23 * HOUR);
    // Berlin: clocks go back on 25 October 2026.
    const autumn = startOfDay(parseDate('2026-10-25'), 'Europe/Berlin');
    expect(iso(autumn)).toBe('2026-10-24T22:00:00.000Z');
    expect(startOfDay(parseDate('2026-10-26'), 'Europe/Berlin') - autumn).toBe(25 * HOUR);
  });

  it('starts a day at one o\'clock where the clock change removed midnight itself', () => {
    // São Paulo, 4 November 2018: 00:00 became 01:00.
    const start = startOfDay(parseDate('2018-11-04'), 'America/Sao_Paulo');
    expect(iso(start)).toBe('2018-11-04T03:00:00.000Z');
    expect(formatDate(localDate(start, 'America/Sao_Paulo'))).toBe('2018-11-04');
    expect(formatDate(localDate(start - 1, 'America/Sao_Paulo'))).toBe('2018-11-03');
  });

  it('gives a day the zone skipped the start of the next one', () => {
    // Samoa went from 29 straight to 31 December 2011.
    const skipped = startOfDay(parseDate('2011-12-30'), 'Pacific/Apia');
    expect(skipped).toBe(startOfDay(parseDate('2011-12-31'), 'Pacific/Apia'));
    expect(formatDate(localDate(skipped, 'Pacific/Apia'))).toBe('2011-12-31');
    expect(formatDate(localDate(skipped - 1, 'Pacific/Apia'))).toBe('2011-12-29');
  });

  it('is always the first instant of that date and never the last of the one before', () => {
    for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/St_Johns']) {
      for (const day of ['2026-01-01', '2026-03-29', '2026-04-05', '2026-10-04', '2026-10-25', '2026-11-01', '2028-02-29']) {
        const date = parseDate(day);
        const start = startOfDay(date, zone);
        expect(formatDate(localDate(start, zone)), `${zone} ${day}`).toBe(day);
        expect(formatDate(localDate(start - 1, zone)), `${zone} ${day} - 1ms`).toBe(formatDate(addDays(date, -1)));
      }
    }
  });
});

describe('the buckets of a report', () => {
  it('covers thirty days ending today when no dates are named', () => {
    const now = at('2026-10-14T09:00:00Z');
    const range = resolveRange({ period: 'day', timeZone: 'UTC', now });
    expect(range.buckets).toHaveLength(30);
    expect(formatDate(range.from)).toBe('2026-09-15');
    expect(formatDate(range.to)).toBe('2026-10-14');
    expect(range.buckets[0]!.key).toBe('2026-09-15');
    expect(range.buckets[29]).toEqual({ key: '2026-10-14', start: at('2026-10-14T00:00:00Z'), end: at('2026-10-15T00:00:00Z'), current: true });
    expect(range.buckets.filter((bucket) => bucket.current)).toHaveLength(1);
  });

  it('covers twelve Monday-to-Sunday weeks, this week last', () => {
    // 14 October 2026 is a Wednesday.
    const range = resolveRange({ period: 'week', timeZone: 'UTC', now: at('2026-10-14T09:00:00Z') });
    expect(range.buckets).toHaveLength(12);
    expect(range.buckets[11]).toMatchObject({ key: '2026-10-12', start: at('2026-10-12T00:00:00Z'), end: at('2026-10-19T00:00:00Z'), current: true });
    expect(range.buckets[0]!.key).toBe('2026-07-27');
    expect(formatDate(range.to)).toBe('2026-10-18');
  });

  it('covers twelve calendar months, this month last', () => {
    const range = resolveRange({ period: 'month', timeZone: 'UTC', now: at('2026-10-14T09:00:00Z') });
    expect(range.buckets.map((bucket) => bucket.key)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(range.buckets[3]).toMatchObject({ start: at('2026-02-01T00:00:00Z'), end: at('2026-03-01T00:00:00Z') });
    expect(formatDate(range.from)).toBe('2025-11-01');
    expect(formatDate(range.to)).toBe('2026-10-31');
  });

  it('leaves no gap and no overlap between buckets, also across clock changes', () => {
    for (const zone of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
      const range = resolveRange({ period: 'day', from: parseDate('2026-01-01'), to: parseDate('2026-12-31'), timeZone: zone, now: at('2026-06-01T00:00:00Z') });
      expect(range.buckets).toHaveLength(365);
      for (let index = 1; index < range.buckets.length; index += 1) expect(range.buckets[index]!.start).toBe(range.buckets[index - 1]!.end);
      const lengths = new Set(range.buckets.map((bucket) => (bucket.end - bucket.start) / HOUR));
      if (zone === 'UTC' || zone === 'Asia/Kathmandu') expect([...lengths]).toEqual([24]);
      else expect(lengths.size).toBe(3); // one shorter day, one longer day, and all the others
    }
  });

  it('puts an instant near a month end into different months in different zones', () => {
    // Half past eleven at night on 31 January in New York: already February in London and Tokyo.
    const now = at('2026-02-01T04:30:00Z');
    expect(monthOf(now, 'America/New_York').key).toBe('2026-01');
    expect(monthOf(now, 'UTC').key).toBe('2026-02');
    expect(monthOf(now, 'Asia/Tokyo').key).toBe('2026-02');
    expect(resolveRange({ period: 'month', timeZone: 'America/New_York', now }).buckets.at(-1)).toMatchObject({ key: '2026-01', current: true });
    expect(resolveRange({ period: 'month', timeZone: 'UTC', now }).buckets.at(-1)).toMatchObject({ key: '2026-02', current: true });
    // The month in New York is the wall-clock month there: it ends at five in the morning UTC.
    expect(iso(monthOf(now, 'America/New_York').end)).toBe('2026-02-01T05:00:00.000Z');
    expect(iso(monthOf(now, 'America/New_York').start)).toBe('2026-01-01T05:00:00.000Z');
  });

  it('gives February the days it has', () => {
    const leap = resolveRange({ period: 'day', from: parseDate('2028-02-27'), to: parseDate('2028-03-01'), timeZone: 'UTC', now: 0 });
    expect(leap.buckets.map((bucket) => bucket.key)).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
    const plain = resolveRange({ period: 'day', from: parseDate('2027-02-27'), to: parseDate('2027-03-01'), timeZone: 'UTC', now: 0 });
    expect(plain.buckets.map((bucket) => bucket.key)).toEqual(['2027-02-27', '2027-02-28', '2027-03-01']);
    const month = resolveRange({ period: 'month', from: parseDate('2028-02-10'), to: parseDate('2028-02-20'), timeZone: 'UTC', now: 0 });
    expect(month.buckets).toHaveLength(1);
    expect((month.buckets[0]!.end - month.buckets[0]!.start) / (24 * HOUR)).toBe(29);
  });

  it('widens named dates to whole buckets', () => {
    const weeks = resolveRange({ period: 'week', from: parseDate('2026-01-01'), to: parseDate('2026-01-07'), timeZone: 'UTC', now: 0 });
    expect(weeks.buckets.map((bucket) => bucket.key)).toEqual(['2025-12-29', '2026-01-05']);
    expect([formatDate(weeks.from), formatDate(weeks.to)]).toEqual(['2025-12-29', '2026-01-11']);
    const months = resolveRange({ period: 'month', from: parseDate('2026-01-31'), to: parseDate('2026-03-01'), timeZone: 'Asia/Shanghai', now: 0 });
    expect(months.buckets.map((bucket) => bucket.key)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(iso(months.buckets[0]!.start)).toBe('2025-12-31T16:00:00.000Z');
    expect(months.buckets.every((bucket) => !bucket.current)).toBe(true);
  });

  it('ends with the bucket of the last named date when only that is given', () => {
    const range = resolveRange({ period: 'day', to: parseDate('2026-03-02'), timeZone: 'UTC', now: at('2026-10-14T00:00:00Z') });
    expect(range.buckets).toHaveLength(30);
    expect(range.buckets.at(-1)!.key).toBe('2026-03-02');
    expect(range.buckets[0]!.key).toBe('2026-02-01');
  });

  it('refuses more buckets than a report may have', () => {
    expect(() => resolveRange({ period: 'day', from: parseDate('2025-01-01'), to: parseDate('2026-06-01'), timeZone: 'UTC', now: 0 })).toThrow(RangeTooLong);
    expect(() => resolveRange({ period: 'week', from: parseDate('2020-01-01'), to: parseDate('2026-06-01'), timeZone: 'UTC', now: 0 })).toThrow(RangeTooLong);
    expect(() => resolveRange({ period: 'month', from: parseDate('2020-01-01'), to: parseDate('2026-06-01'), timeZone: 'UTC', now: 0 })).toThrow(RangeTooLong);
    // Exactly the most a report may have is fine.
    expect(resolveRange({ period: 'day', from: parseDate('2028-01-01'), to: parseDate('2028-12-31'), timeZone: 'UTC', now: 0 }).buckets).toHaveLength(366);
    expect(resolveRange({ period: 'month', from: parseDate('2021-01-01'), to: parseDate('2025-12-31'), timeZone: 'UTC', now: 0 }).buckets).toHaveLength(60);
  });

  it('names the day an instant falls on', () => {
    const day = dayOf(at('2026-03-08T04:59:59Z'), 'America/New_York');
    expect(day.key).toBe('2026-03-07');
    expect(iso(day.end)).toBe('2026-03-08T05:00:00.000Z');
    expect(dayOf(at('2026-03-08T05:00:00Z'), 'America/New_York').key).toBe('2026-03-08');
  });
});
