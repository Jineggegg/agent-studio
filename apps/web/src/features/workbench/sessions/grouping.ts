import type { ActivitySummary, Session } from '@agent-studio/protocol';
import type { ActivityKind } from '@/ui';

/**
 * How a list of sessions is arranged, and which marks it carries. Pure, so
 * the rules — running first, then pinned, then by the day of the last *user*
 * message; "needs you" outranks everything — are tested without a screen.
 */
export type SectionKind = 'running' | 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier';

export interface SessionSection {
  kind: SectionKind;
  sessions: Session[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a list sorts by: the last time the user spoke. Agent output never reorders rows. */
export const sortTime = (session: Session): number => session.lastUserMessageAt ?? session.createdAt;

const isRunning = (session: Session): boolean => session.activeRunId !== null || session.attention === 'running';

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Which day bucket a moment falls in, by the device's own calendar. */
export function dayBucket(timestamp: number, now: number): Exclude<SectionKind, 'running' | 'pinned'> {
  const today = startOfDay(now);
  if (timestamp >= today) return 'today';
  // Calendar days, not 24-hour spans: daylight-saving days are 23 or 25 hours long.
  const yesterday = startOfDay(today - DAY_MS / 2);
  if (timestamp >= yesterday) return 'yesterday';
  // "This week" is the five calendar days before yesterday, so it is never empty on a Monday.
  let weekStart = yesterday;
  for (let day = 0; day < 5; day += 1) weekStart = startOfDay(weekStart - DAY_MS / 2);
  return timestamp >= weekStart ? 'week' : 'earlier';
}

const ORDER: readonly SectionKind[] = ['running', 'pinned', 'today', 'yesterday', 'week', 'earlier'];

export function groupSessions(sessions: readonly Session[], now: number): SessionSection[] {
  const buckets = new Map<SectionKind, Session[]>();
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const kind: SectionKind = isRunning(session) ? 'running' : session.pinned ? 'pinned' : dayBucket(sortTime(session), now);
    let bucket = buckets.get(kind);
    if (!bucket) buckets.set(kind, (bucket = []));
    bucket.push(session);
  }
  const sections: SessionSection[] = [];
  for (const kind of ORDER) {
    const bucket = buckets.get(kind);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => sortTime(b) - sortTime(a) || (a.id < b.id ? 1 : -1));
    sections.push({ kind, sessions: bucket });
  }
  return sections;
}

/**
 * The mark a session's row carries. The conversation on screen never shows
 * "needs you" or "finished, not seen" — the reader is looking at it — but it
 * does show that it is running.
 */
export function sessionMark(session: Pick<Session, 'attention' | 'activeRunId'>, options: { onScreen?: boolean } = {}): ActivityKind | null {
  if (session.attention === 'needs-you') return options.onScreen ? (session.activeRunId !== null ? 'running' : null) : 'attention';
  if (session.attention === 'running' || session.activeRunId !== null) return 'running';
  if (session.attention === 'unseen') return options.onScreen ? null : 'unseen';
  return null;
}

/**
 * The mark on the button that shows a hidden list: "needs you" when any
 * conversation other than the one on screen waits for the user, else
 * "finished, not seen" when one has an unseen result. Running work alone
 * raises no mark — nothing is being asked of anyone.
 */
export function listMark(sessions: readonly Pick<Session, 'id' | 'attention'>[], openSessionId: string | null): Extract<ActivityKind, 'attention' | 'unseen'> | null {
  let unseen = false;
  for (const session of sessions) {
    if (session.id === openSessionId) continue;
    if (session.attention === 'needs-you') return 'attention';
    if (session.attention === 'unseen') unseen = true;
  }
  return unseen ? 'unseen' : null;
}

export interface ProjectMarks {
  running: number;
  attention: number;
  unseen: number;
}

/** What is going on in each project, from the server's activity summary (a project with nothing going on is absent). */
export function projectMarks(summary: ActivitySummary | undefined, openSessionId: string | null): Map<string | null, ProjectMarks> {
  const marks = new Map<string | null, ProjectMarks>();
  for (const entry of summary?.projects ?? []) {
    marks.set(entry.projectId, {
      running: entry.running,
      attention: entry.attention.filter((id) => id !== openSessionId).length,
      unseen: entry.unseen.filter((id) => id !== openSessionId).length,
    });
  }
  return marks;
}

export function projectMark(marks: ProjectMarks | undefined): ActivityKind | null {
  if (!marks) return null;
  if (marks.attention > 0) return 'attention';
  if (marks.running > 0) return 'running';
  if (marks.unseen > 0) return 'unseen';
  return null;
}

/** Totals across every project, for the launcher's tile. */
export function activityTotals(summary: ActivitySummary | undefined): ProjectMarks {
  const totals: ProjectMarks = { running: 0, attention: 0, unseen: 0 };
  for (const entry of summary?.projects ?? []) {
    totals.running += entry.running;
    totals.attention += entry.attention.length;
    totals.unseen += entry.unseen.length;
  }
  return totals;
}

/** How a row shows when its session was last spoken to: the clock today and yesterday, the weekday this week, the date before that. */
export function rowTimeStyle(timestamp: number, now: number): 'time' | 'weekday' | 'short' {
  const bucket = dayBucket(timestamp, now);
  return bucket === 'today' || bucket === 'yesterday' ? 'time' : bucket === 'week' ? 'weekday' : 'short';
}

/** Whether every word typed appears in the title, whatever the case. */
export function matchesTitle(title: string, query: string): boolean {
  const haystack = title.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
