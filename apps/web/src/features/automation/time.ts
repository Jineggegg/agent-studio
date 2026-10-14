/**
 * Time zones and wall-clock times, for schedules. A schedule's times are
 * wall-clock times in a named zone (the automation's), while "next run" and
 * "last run" are instants; these helpers move between the two without ever
 * passing through the device's own zone by accident.
 */

const FALLBACK_ZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

/** The zone this device is set to. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

let zones: string[] | null = null;

/** Every IANA zone this browser knows, UTC first. */
export function allTimeZones(): string[] {
  if (zones) return zones;
  let list: string[];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = FALLBACK_ZONES;
  }
  zones = ['UTC', ...list.filter((zone) => zone !== 'UTC')];
  return zones;
}

/** "GMT+2", "GMT-5:30", "GMT" — the zone's offset at `at`. */
export function zoneOffset(zone: string, at = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at).find((entry) => entry.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** The part of a zone's name people recognise: "New York" for "America/New_York". */
export function zoneCity(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ');
}

export interface WallClock {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  /** 0 = Sunday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What the clock on the wall says at `instant` in `zone`. */
export function wallClock(instant: number, zone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}`, weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))) };
}

/** A calendar date ("2026-10-20") as people write it, without letting any zone shift the day. */
export function formatCalendarDate(date: string, language: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const instant = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return new Intl.DateTimeFormat(language, { ...options, timeZone: 'UTC' }).format(instant);
}

/** "08:30" as this language writes times of day ("8:30 AM", "08:30"). */
export function formatTimeOfDay(time: string, language: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const instant = Date.UTC(2000, 0, 3, Number(match[1]), Number(match[2]));
  return new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(instant);
}

/** An instant as date and time in a zone, in this language. */
export function formatInstant(instant: number, zone: string, language: string, withWeekday = false): string {
  return new Intl.DateTimeFormat(language, {
    timeZone: zone,
    ...(withWeekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}

/** Whether two instants fall on the same calendar day in the device's zone, and how many days apart. */
export function dayDistance(instant: number, now: number): number {
  const day = (value: number) => {
    const date = new Date(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  return Math.round((day(instant) - day(now)) / 86_400_000);
}

/** A local `<input type="datetime-local">` value for an instant: "2026-10-20T14:30". */
export function toLocalInput(instant: number): string {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value means on this device, or null. */
export function fromLocalInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}
