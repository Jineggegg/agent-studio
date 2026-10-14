import { USAGE_LIMITS, type UsagePeriod } from '@agent-studio/protocol';

/**
 * Calendar arithmetic for usage reports: which instants a day, a week or a
 * month covers in a named time zone. Pure functions; the clock is always
 * passed in.
 *
 * A day in a zone is not always 24 hours and does not always start at 00:00
 * (a clock change can remove midnight itself), so a day's start is defined as
 * the first instant whose local date is that day — found from the zone's own
 * rules, never by adding hours.
 */

export interface CalendarDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
}

const HOUR = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    // A handful of zones are in use at a time; the cache only has to stay bounded.
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalTime extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localTime(instant: number, timeZone: string): LocalTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! };
}

/** The calendar date an instant falls on in a zone. */
export function localDate(instant: number, timeZone: string): CalendarDate {
  const { year, month, day } = localTime(instant, timeZone);
  return { year, month, day };
}

/** Dates as one comparable number: 2026-10-14 → 20261014. */
const ordinal = (date: CalendarDate): number => date.year * 10_000 + date.month * 100 + date.day;

export const compareDates = (a: CalendarDate, b: CalendarDate): number => ordinal(a) - ordinal(b);

export function formatDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` → a date. The caller has validated the text. */
export function parseDate(text: string): CalendarDate {
  const [year, month, day] = text.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/** Calendar days later (or earlier, for a negative count), month ends and leap years included. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** The first of the month `months` later (or earlier). */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: 1 };
}

/**
 * The first instant whose local date in `timeZone` is `date` (or later, for a
 * date the zone skipped altogether, as Samoa did with 30 December 2011).
 */
export function startOfDay(date: CalendarDate, timeZone: string): number {
  const target = ordinal(date);
  const onOrAfter = (instant: number): boolean => ordinal(localDate(instant, timeZone)) >= target;
  const wallClock = Date.UTC(date.year, date.month - 1, date.day);

  // Nearly always: the zone's offset around that midnight gives the answer directly.
  const at = localTime(wallClock, timeZone);
  const offset = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - wallClock;
  const guess = wallClock - offset;
  if (onOrAfter(guess) && !onOrAfter(guess - 1)) return guess;

  // Otherwise (a clock change around midnight): search. Offsets lie between -12 and +14 hours,
  // so sixteen hours either side of the wall-clock midnight always brackets the start of the day.
  let before = wallClock - 16 * HOUR;
  let from = wallClock + 16 * HOUR;
  while (from - before > 1) {
    const middle = before + Math.floor((from - before) / 2);
    if (onOrAfter(middle)) from = middle;
    else before = middle;
  }
  return from;
}

/** The date a bucket starts on: the day itself, the Monday of its week, the first of its month. */
export function bucketStartDate(date: CalendarDate, period: UsagePeriod): CalendarDate {
  if (period === 'day') return date;
  if (period === 'month') return { year: date.year, month: date.month, day: 1 };
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** The date the bucket after this one starts on. `start` must be a bucket's first date. */
export function nextBucketDate(start: CalendarDate, period: UsagePeriod): CalendarDate {
  if (period === 'day') return addDays(start, 1);
  if (period === 'week') return addDays(start, 7);
  return addMonths(start, 1);
}

/** `2026-10-14` for a day, the Monday's date for a week, `2026-10` for a month. */
export function bucketKey(start: CalendarDate, period: UsagePeriod): string {
  return period === 'month' ? formatDate(start).slice(0, 7) : formatDate(start);
}

export interface Bucket {
  readonly key: string;
  readonly start: number;
  /** The first instant after the bucket. */
  readonly end: number;
  /** The bucket that contains `now`. */
  readonly current: boolean;
}

export interface ResolvedRange {
  /** The first date of the first bucket and the last date of the last one. */
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  readonly buckets: Bucket[];
}

const MAX_BUCKETS: Readonly<Record<UsagePeriod, number>> = { day: USAGE_LIMITS.maxDays, week: USAGE_LIMITS.maxWeeks, month: USAGE_LIMITS.maxMonths };
const DEFAULT_BUCKETS: Readonly<Record<UsagePeriod, number>> = { day: USAGE_LIMITS.defaultDays, week: USAGE_LIMITS.defaultWeeks, month: USAGE_LIMITS.defaultMonths };

export class RangeTooLong extends Error {
  readonly max: number;
  constructor(period: UsagePeriod, max: number) {
    super(`A report by ${period} covers at most ${max} ${period}s.`);
    this.max = max;
  }
}

/**
 * The buckets a report covers. `from` and `to` are calendar dates in the
 * zone, both inclusive; the range is widened to whole buckets. Without `to`
 * it ends with the bucket that holds `now`; without `from` it is the default
 * number of buckets ending there. Throws {@link RangeTooLong} for more
 * buckets than a report may have.
 */
export function resolveRange(input: { period: UsagePeriod; from?: CalendarDate | undefined; to?: CalendarDate | undefined; timeZone: string; now: number }): ResolvedRange {
  const { period, timeZone, now } = input;
  const today = localDate(now, timeZone);
  const lastStart = bucketStartDate(input.to ?? today, period);
  let firstStart: CalendarDate;
  if (input.from) {
    firstStart = bucketStartDate(input.from, period);
  } else {
    firstStart = lastStart;
    for (let step = 1; step < DEFAULT_BUCKETS[period]; step += 1) firstStart = bucketStartDate(addDays(firstStart, -1), period);
  }

  const buckets: Bucket[] = [];
  let cursor = firstStart;
  let start = startOfDay(cursor, timeZone);
  while (compareDates(cursor, lastStart) <= 0) {
    if (buckets.length >= MAX_BUCKETS[period]) throw new RangeTooLong(period, MAX_BUCKETS[period]);
    const following = nextBucketDate(cursor, period);
    const end = startOfDay(following, timeZone);
    buckets.push({ key: bucketKey(cursor, period), start, end, current: now >= start && now < end });
    cursor = following;
    start = end;
  }
  return { from: firstStart, to: addDays(cursor, -1), buckets };
}

/** The calendar month an instant falls in, in a zone. */
export function monthOf(instant: number, timeZone: string): { key: string; start: number; end: number } {
  const first = bucketStartDate(localDate(instant, timeZone), 'month');
  return { key: bucketKey(first, 'month'), start: startOfDay(first, timeZone), end: startOfDay(addMonths(first, 1), timeZone) };
}

/** The calendar day an instant falls in, in a zone. */
export function dayOf(instant: number, timeZone: string): { key: string; start: number; end: number } {
  const date = localDate(instant, timeZone);
  return { key: formatDate(date), start: startOfDay(date, timeZone), end: startOfDay(addDays(date, 1), timeZone) };
}
