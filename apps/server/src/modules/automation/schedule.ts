import { AUTOMATION_LIMITS, type AutomationTrigger, isCalendarDate, isTimeZone } from '@agent-studio/protocol';
import { Cron } from 'croner';

/**
 * When automations fire. Everything here is a pure function of a trigger, a
 * time zone and an instant: no clock is read and no timer is started, so the
 * rules can be tested at any date — including the two days a year on which
 * wall-clock time jumps.
 *
 * Calendar arithmetic, time zones and daylight-saving transitions are the
 * library's job (croner): a trigger is turned into a cron pattern and the
 * library is asked for the occurrence after, or before, an instant. What the
 * library does at a transition, and what this module therefore promises:
 *
 * - clocks go forward (02:00 → 03:00): a time inside the gap runs once that
 *   day, an hour later on the clock (02:30 runs at 03:30);
 * - clocks go back (02:00 → 01:00): a time that occurs twice runs once, the
 *   first time; an hourly trigger does not fire again in the repeated hour.
 */

export type ScheduleTrigger = Exclude<AutomationTrigger, { type: 'event' }>;

/** Why a trigger cannot be used. `code` is stable; `message` is for the user. */
export class ScheduleError extends Error {
  readonly code: 'invalid_time_zone' | 'invalid_date' | 'invalid_cron' | 'cron_too_frequent' | 'never_runs' | 'time_passed';

  constructor(code: ScheduleError['code'], message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

export const isScheduleTrigger = (trigger: AutomationTrigger): trigger is ScheduleTrigger => trigger.type !== 'event';

const [hourOf, minuteOf] = [(time: string) => Number(time.slice(0, 2)), (time: string) => Number(time.slice(3, 5))];

/** The cron pattern of a repeating trigger. Null for a one-off. */
export function cronPatternOf(trigger: ScheduleTrigger): string | null {
  switch (trigger.type) {
    case 'once':
      return null;
    case 'hourly':
      return `${trigger.minute} * * * *`;
    case 'daily':
      return `${minuteOf(trigger.time)} ${hourOf(trigger.time)} * * *`;
    case 'weekdays':
      return `${minuteOf(trigger.time)} ${hourOf(trigger.time)} * * 1-5`;
    case 'weekly':
      return `${minuteOf(trigger.time)} ${hourOf(trigger.time)} * * ${[...trigger.days].sort((a, b) => a - b).join(',')}`;
    case 'cron':
      return trigger.expression;
  }
}

const parsed = new Map<string, Cron>();

/** A parsed pattern. Never scheduled: without a callback the library starts no timer. */
function cronFor(pattern: string, timeZone: string): Cron {
  const key = `${timeZone}\n${pattern}`;
  let cron = parsed.get(key);
  if (!cron) {
    // Five fields only: nothing here needs to fire more often than once a minute.
    cron = new Cron(pattern, { timezone: timeZone, paused: true, mode: '5-part' });
    if (parsed.size >= 500) parsed.delete(parsed.keys().next().value!);
    parsed.set(key, cron);
  }
  return cron;
}

/** The instant a wall-clock date and time denotes in a time zone. */
export function instantOf(date: string, time: string, timeZone: string): number {
  if (!isCalendarDate(date)) throw new ScheduleError('invalid_date', 'That is not a real date.');
  const once = new Cron(`${date}T${time}:00`, { timezone: timeZone, paused: true }).getOnce();
  if (!once) throw new ScheduleError('invalid_date', 'That is not a date and time.');
  return once.getTime();
}

/** The first occurrence strictly after `after`. Null when there is none: a one-off whose time has passed. */
export function nextOccurrence(trigger: ScheduleTrigger, timeZone: string, after: number): number | null {
  if (trigger.type === 'once') {
    const at = instantOf(trigger.date, trigger.time, timeZone);
    return at > after ? at : null;
  }
  return cronFor(cronPatternOf(trigger)!, timeZone).nextRun(new Date(after))?.getTime() ?? null;
}

/** The latest occurrence at or before `at`. Null when there is none. */
export function latestOccurrence(trigger: ScheduleTrigger, timeZone: string, at: number): number | null {
  if (trigger.type === 'once') {
    const once = instantOf(trigger.date, trigger.time, timeZone);
    return once <= at ? once : null;
  }
  // The library answers "strictly before"; ask from the next second and take the first that is not later than `at`.
  const candidates = cronFor(cronPatternOf(trigger)!, timeZone).previousRuns(2, new Date(Math.floor(at / 1000) * 1000 + 1000));
  return candidates.map((candidate) => candidate.getTime()).find((candidate) => candidate <= at) ?? null;
}

/** The next occurrences after `after`, for showing a schedule before it is saved. */
export function upcomingOccurrences(trigger: ScheduleTrigger, timeZone: string, after: number, count: number): number[] {
  const result: number[] = [];
  let cursor = after;
  while (result.length < count) {
    const next = nextOccurrence(trigger, timeZone, cursor);
    if (next === null) break;
    result.push(next);
    cursor = next;
  }
  return result;
}

/**
 * Checks what a schema cannot: that the zone exists, that a cron expression
 * parses, fires at all and not too often, and that a one-off lies ahead.
 * Throws a {@link ScheduleError}.
 */
export function validateSchedule(trigger: ScheduleTrigger, timeZone: string, now: number): void {
  if (!isTimeZone(timeZone)) throw new ScheduleError('invalid_time_zone', 'That is not a time zone.');
  if (trigger.type === 'once') {
    if (instantOf(trigger.date, trigger.time, timeZone) <= now) throw new ScheduleError('time_passed', 'That time has already passed. Choose a later one.');
    return;
  }
  if (trigger.type !== 'cron') return;
  let occurrences: number[];
  try {
    occurrences = upcomingOccurrences(trigger, timeZone, now, 60);
  } catch {
    throw new ScheduleError('invalid_cron', 'That is not a cron expression. Use five fields: minute, hour, day of month, month, day of week.');
  }
  if (occurrences.length === 0) throw new ScheduleError('never_runs', 'That cron expression never matches a date.');
  const minimum = AUTOMATION_LIMITS.minIntervalMinutes * 60_000;
  for (let index = 1; index < occurrences.length; index += 1) {
    if (occurrences[index]! - occurrences[index - 1]! < minimum) {
      throw new ScheduleError('cron_too_frequent', `An automation can run at most every ${AUTOMATION_LIMITS.minIntervalMinutes} minutes.`);
    }
  }
}

export interface OverduePlan {
  /**
   * `run`     execute now, for the occurrence `scheduledFor`.
   * `missed`  too late: nothing runs; `scheduledFor` is the latest occurrence that was missed.
   */
  readonly action: 'run' | 'missed';
  readonly scheduledFor: number;
  /** Occurrences before `scheduledFor` that came and went while nothing was looking (counted up to `MISSED_COUNT_CAP`). */
  readonly earlierMissed: number;
  /** The first occurrence after `now`: where the schedule continues. Null for a one-off. */
  readonly next: number | null;
}

export const MISSED_COUNT_CAP = 100;

/**
 * What to do with an automation whose time has come — possibly long ago,
 * because the server was not running.
 *
 * Only the most recent occurrence is ever made up, and only if it is no
 * older than the grace window: a server that was down for a week does not
 * run a daily automation seven times, and does not run this morning's at
 * midnight. Everything older is counted as missed. The schedule then
 * continues with the first occurrence after now.
 */
export function planOverdue(input: { trigger: ScheduleTrigger; timeZone: string; dueAt: number; now: number; graceMs: number }): OverduePlan {
  const { trigger, timeZone, dueAt, now, graceMs } = input;
  if (trigger.type === 'once') {
    return { action: now - dueAt <= graceMs ? 'run' : 'missed', scheduledFor: dueAt, earlierMissed: 0, next: null };
  }
  const latest = Math.max(dueAt, latestOccurrence(trigger, timeZone, now) ?? dueAt);
  let earlierMissed = 0;
  for (let cursor: number | null = dueAt; cursor !== null && cursor < latest && earlierMissed < MISSED_COUNT_CAP; cursor = nextOccurrence(trigger, timeZone, cursor)) {
    earlierMissed += 1;
  }
  return { action: now - latest <= graceMs ? 'run' : 'missed', scheduledFor: latest, earlierMissed, next: nextOccurrence(trigger, timeZone, now) };
}

/** A wall-clock date and time in a zone, for sentences such as "missed the run of 14 Mar, 08:00". */
export function describeInstant(at: number, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}
