import type { Session } from '@agent-studio/protocol';
import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { type SessionListParams, type SessionPage, flattenSessions, listAccepts, removeFromPages, removeSession, upsertInPages, upsertSession, workbenchKeys } from './queries';

vi.mock('../api', () => ({ workbenchApi: {}, SEND_TIMEOUT_MS: 20_000 }));

const P = '01pppppppppppppppppppppppp';
const Q = '01qqqqqqqqqqqqqqqqqqqqqqqq';

let counter = 0;
function session(overrides: Partial<Session> = {}): Session {
  counter += 1;
  return {
    id: `01${String(counter).padStart(24, '0')}`,
    projectId: P,
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
    lastActivityAt: 10,
    lastUserMessageAt: 10,
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  };
}

const project: SessionListParams = { projectId: P, archived: 'exclude', q: '' };
const everything: SessionListParams = { projectId: null, archived: 'exclude', q: '' };
const archived: SessionListParams = { projectId: P, archived: 'only', q: '' };

describe('which list a session belongs in', () => {
  it.each([
    ['its own project', project, {}, true],
    ['another project', project, { projectId: Q }, false],
    ['every project', everything, { projectId: Q }, true],
    ['the archive, when it is not archived', archived, {}, false],
    ['the archive, when it is', archived, { archived: true }, true],
    ['the live list, when it is archived', project, { archived: true }, false],
    ['a search its title matches', { ...project, q: 'api fix' }, { title: 'Fix API tests' }, true],
    ['a search its title does not match', { ...project, q: 'api fix' }, { title: 'Deploy API' }, false],
  ] as const)('%s → %s', (_name, params, overrides, expected) => {
    expect(listAccepts(params, session(overrides))).toBe(expected);
  });
});

describe('keeping cached pages in step with one changed session', () => {
  const a = session();
  const b = session();
  const c = session();
  const pages: SessionPage[] = [
    { sessions: [a, b], hasMore: true },
    { sessions: [c], hasMore: false },
  ];

  it('replaces a session where it is', () => {
    const renamed = { ...c, title: 'Renamed', updatedAt: 20 };
    const next = upsertInPages(pages, project, renamed);
    expect(next[1]!.sessions).toEqual([renamed]);
    expect(next[0]).toBe(pages[0]);
  });

  it('adds one that is new to the list, and takes out one that no longer belongs', () => {
    const created = session();
    expect(upsertInPages(pages, project, created)[0]!.sessions.map((entry) => entry.id)).toEqual([created.id, a.id, b.id]);
    const gone = upsertInPages(pages, project, { ...b, archived: true });
    expect(gone[0]!.sessions).toEqual([a]);
    // …and into the archive it goes, if that list is loaded.
    expect(upsertInPages([{ sessions: [], hasMore: false }], archived, { ...b, archived: true })[0]!.sessions).toHaveLength(1);
  });

  it('changes nothing — the very same array — when there is nothing to change', () => {
    expect(upsertInPages(pages, project, a)).toBe(pages);
    expect(upsertInPages(pages, project, session({ projectId: Q }))).toBe(pages);
    expect(removeFromPages(pages, 'unknown')).toBe(pages);
    // A list that has not been read yet is not invented.
    expect(upsertInPages([], project, session())).toEqual([]);
  });

  it('removes a deleted session', () => {
    expect(removeFromPages(pages, a.id)[0]!.sessions).toEqual([b]);
  });

  it('lists each session once even when two pages carry it', () => {
    const data: InfiniteData<SessionPage, number> = { pages: [{ sessions: [a, b], hasMore: true }, { sessions: [b, c], hasMore: false }], pageParams: [0, 50] };
    expect(flattenSessions(data).map((entry) => entry.id)).toEqual([a.id, b.id, c.id]);
    expect(flattenSessions(undefined)).toEqual([]);
  });
});

describe('live changes in the query cache', () => {
  const seed = (client: QueryClient, params: SessionListParams, sessions: Session[]) =>
    client.setQueryData<InfiniteData<SessionPage, number>>(workbenchKeys.list(params), { pages: [{ sessions, hasMore: false }], pageParams: [0] });
  const read = (client: QueryClient, params: SessionListParams) => flattenSessions(client.getQueryData(workbenchKeys.list(params)));

  it('moves a session between every list that holds it: pinned here, archived there', () => {
    const client = new QueryClient();
    const one = session();
    seed(client, project, [one]);
    seed(client, everything, [one]);
    seed(client, archived, []);

    upsertSession(client, { ...one, pinned: true, updatedAt: 20 });
    expect(read(client, project)[0]!.pinned).toBe(true);
    expect(read(client, everything)[0]!.pinned).toBe(true);

    upsertSession(client, { ...one, archived: true, updatedAt: 30 });
    expect(read(client, project)).toEqual([]);
    expect(read(client, everything)).toEqual([]);
    expect(read(client, archived).map((entry) => entry.id)).toEqual([one.id]);
    expect(client.getQueryData<Session>(workbenchKeys.session(one.id))?.archived).toBe(true);
  });

  it('does not let an older event undo a newer one', () => {
    const client = new QueryClient();
    const one = session({ title: 'New title', updatedAt: 50 });
    seed(client, project, [one]);
    upsertSession(client, one);
    upsertSession(client, { ...one, title: 'Old title', updatedAt: 40 });
    expect(read(client, project)[0]!.title).toBe('New title');
  });

  it('forgets a removed session everywhere', () => {
    const client = new QueryClient();
    const one = session();
    seed(client, project, [one]);
    upsertSession(client, one);
    removeSession(client, one.id);
    expect(read(client, project)).toEqual([]);
    expect(client.getQueryData(workbenchKeys.session(one.id))).toBeUndefined();
  });
});
