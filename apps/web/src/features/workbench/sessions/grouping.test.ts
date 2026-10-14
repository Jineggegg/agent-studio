import type { Session } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { activityTotals, dayBucket, groupSessions, listMark, matchesTitle, projectMark, projectMarks, rowTimeStyle, sessionMark } from './grouping';

// Wednesday 14 October 2026, 15:00 local time.
const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const daysAgo = (days: number, hour = 12) => new Date(2026, 9, 14 - days, hour, 0, 0).getTime();

let counter = 0;
function session(overrides: Partial<Session> = {}): Session {
  counter += 1;
  const id = `01${String(counter).padStart(24, '0')}`;
  return {
    id,
    projectId: '01pppppppppppppppppppppppp',
    userId: '01uuuuuuuuuuuuuuuuuuuuuuuu',
    agentId: 'demo',
    model: null,
    effort: null,
    permissionMode: 'ask',
    effectivePermissionMode: 'ask',
    title: `Session ${counter}`,
    titleSource: 'auto',
    pinned: false,
    archived: false,
    chainId: null,
    parentSessionId: null,
    attention: 'none',
    activeRunId: null,
    hasDraft: false,
    resumable: false,
    lastSeq: 0,
    lastActivityAt: NOW,
    lastUserMessageAt: NOW,
    createdAt: daysAgo(40),
    updatedAt: NOW,
    ...overrides,
  };
}

describe('day buckets', () => {
  it.each([
    [daysAgo(0, 0), 'today'],
    [daysAgo(0, 14), 'today'],
    [daysAgo(1, 23), 'yesterday'],
    [daysAgo(1, 0), 'yesterday'],
    [daysAgo(2, 23), 'week'],
    [daysAgo(6, 0), 'week'],
    [daysAgo(7, 23), 'earlier'],
    [daysAgo(30), 'earlier'],
  ])('%i → %s', (timestamp, expected) => {
    expect(dayBucket(timestamp, NOW)).toBe(expected);
  });

  it('shows the clock for today and yesterday, the weekday this week, the date before', () => {
    expect(rowTimeStyle(daysAgo(0), NOW)).toBe('time');
    expect(rowTimeStyle(daysAgo(1), NOW)).toBe('time');
    expect(rowTimeStyle(daysAgo(3), NOW)).toBe('weekday');
    expect(rowTimeStyle(daysAgo(20), NOW)).toBe('short');
  });
});

describe('arranging the list', () => {
  it('puts running first, then pinned, then the days — each newest first', () => {
    const running = session({ title: 'running', activeRunId: '01rrrrrrrrrrrrrrrrrrrrrrrr', attention: 'running', lastUserMessageAt: daysAgo(9) });
    const pinnedOld = session({ title: 'pinned old', pinned: true, lastUserMessageAt: daysAgo(20) });
    const pinnedNew = session({ title: 'pinned new', pinned: true, lastUserMessageAt: daysAgo(2) });
    const today = session({ title: 'today', lastUserMessageAt: daysAgo(0, 9) });
    const todayLater = session({ title: 'today later', lastUserMessageAt: daysAgo(0, 13) });
    const yesterday = session({ title: 'yesterday', lastUserMessageAt: daysAgo(1) });
    const week = session({ title: 'week', lastUserMessageAt: daysAgo(3) });
    const earlier = session({ title: 'earlier', lastUserMessageAt: daysAgo(30) });

    const sections = groupSessions([earlier, week, today, pinnedOld, yesterday, running, todayLater, pinnedNew], NOW);
    expect(sections.map((section) => [section.kind, section.sessions.map((entry) => entry.title)])).toEqual([
      ['running', ['running']],
      ['pinned', ['pinned new', 'pinned old']],
      ['today', ['today later', 'today']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['earlier', ['earlier']],
    ]);
  });

  it('sorts by the last user message: agent output does not move a session up', () => {
    const quiet = session({ title: 'quiet', lastUserMessageAt: daysAgo(0, 10), lastActivityAt: daysAgo(0, 10) });
    const chatty = session({ title: 'chatty', lastUserMessageAt: daysAgo(0, 8), lastActivityAt: daysAgo(0, 14) });
    expect(groupSessions([chatty, quiet], NOW)[0]!.sessions.map((entry) => entry.title)).toEqual(['quiet', 'chatty']);
  });

  it('files a session that has never been spoken to under the day it was made', () => {
    const fresh = session({ lastUserMessageAt: null, createdAt: daysAgo(1) });
    expect(groupSessions([fresh], NOW)[0]!.kind).toBe('yesterday');
  });

  it('shows a session once even when it came in on two pages', () => {
    const one = session();
    expect(groupSessions([one, { ...one }], NOW)[0]!.sessions).toHaveLength(1);
  });

  it('leaves out sections that are empty', () => {
    expect(groupSessions([], NOW)).toEqual([]);
  });
});

describe('attention marks', () => {
  it.each([
    [{ attention: 'running', activeRunId: 'r' }, false, 'running'],
    [{ attention: 'needs-you', activeRunId: 'r' }, false, 'attention'],
    [{ attention: 'needs-you', activeRunId: null }, false, 'attention'],
    [{ attention: 'unseen', activeRunId: null }, false, 'unseen'],
    [{ attention: 'none', activeRunId: null }, false, null],
    // On screen: the reader is looking at it, so nothing is asked of them — but running still shows.
    [{ attention: 'needs-you', activeRunId: 'r' }, true, 'running'],
    [{ attention: 'needs-you', activeRunId: null }, true, null],
    [{ attention: 'unseen', activeRunId: null }, true, null],
    [{ attention: 'running', activeRunId: 'r' }, true, 'running'],
  ] as const)('%o on screen=%s → %s', (state, onScreen, expected) => {
    expect(sessionMark(state, { onScreen })).toBe(expected);
  });

  it('marks the hidden-list button: needs-you wins over unseen, and the open session does not count', () => {
    const a = { id: 'a', attention: 'unseen' } as const;
    const b = { id: 'b', attention: 'needs-you' } as const;
    const c = { id: 'c', attention: 'running' } as const;
    expect(listMark([a, b, c], null)).toBe('attention');
    expect(listMark([a, b, c], 'b')).toBe('unseen');
    expect(listMark([a, c], 'a')).toBeNull();
    expect(listMark([c], null)).toBeNull();
  });

  it('summarises projects from the activity summary', () => {
    const summary = {
      projects: [
        { projectId: 'p', running: 1, runningAgents: ['demo'], attention: [], unseen: [] },
        { projectId: 'q', running: 0, runningAgents: [], attention: ['s1'], unseen: ['s2'] },
        { projectId: 'r', running: 0, runningAgents: [], attention: [], unseen: ['s3'] },
      ],
    };
    const marks = projectMarks(summary, null);
    expect(projectMark(marks.get('p'))).toBe('running');
    expect(projectMark(marks.get('q'))).toBe('attention');
    expect(projectMark(marks.get('r'))).toBe('unseen');
    expect(projectMark(marks.get('idle'))).toBeNull();
    // The session on screen is not counted against its project.
    expect(projectMark(projectMarks(summary, 's1').get('q'))).toBe('unseen');
    expect(activityTotals(summary)).toEqual({ running: 1, attention: 1, unseen: 2 });
    expect(activityTotals(undefined)).toEqual({ running: 0, attention: 0, unseen: 0 });
  });
});

describe('title search', () => {
  it.each([
    ['Fix API tests', 'api fix', true],
    ['Deploy API', 'api fix', false],
    ['Fix API tests', '', true],
    ['Fix API tests', '  TESTS  ', true],
    ['修复登录问题', '登录', true],
  ])('%s / %s → %s', (title, query, expected) => {
    expect(matchesTitle(title, query)).toBe(expected);
  });
});
