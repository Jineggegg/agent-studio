import {
  type Session,
  USER_AGENT_EVENT,
  userAgentEventSchema,
  userTopic,
} from '@agent-studio/protocol';
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { workbenchApi } from '../api';
import { applyRemoteDraft, noteDraftFlag } from '../composer/drafts';
import { matchesTitle } from './grouping';

/**
 * Session lists, the open session and the activity summary — read with
 * TanStack Query, kept current from the user's own live topic so that two
 * devices stay in step: a session created, renamed, pinned, archived or
 * removed on one appears so on the other without a re-read.
 */
export const SESSION_PAGE_SIZE = 50;

export interface SessionListParams {
  groupId?: string;
  /** Null lists every project's sessions. */
  projectId: string | null;
  archived: 'exclude' | 'only';
  /** Words that must all appear in the title. */
  q: string;
}

export interface SessionPage {
  sessions: Session[];
  hasMore: boolean;
}

export const workbenchKeys = {
  all: ['workbench'] as const,
  lists: ['workbench', 'sessions'] as const,
  list: (params: SessionListParams) => ['workbench', 'sessions', params] as const,
  session: (sessionId: string) => ['workbench', 'session', sessionId] as const,
  activity: ['workbench', 'activity'] as const,
  agents: ['workbench', 'agents'] as const,
  projectSettings: (projectId: string) => ['workbench', 'project-settings', projectId] as const,
  search: (q: string, projectId: string | null) => ['workbench', 'search', q, projectId] as const,
  rules: ['workbench', 'rules'] as const,
};

// ---- pure: keeping cached pages in step with one changed session ---------------------

/** Whether a session belongs in a list. */
export function listAccepts(params: SessionListParams, session: Session): boolean {
  if (params.groupId === 'ungrouped' && session.groupId) return false;
  if (params.groupId && params.groupId !== 'ungrouped' && session.groupId !== params.groupId)
    return false;
  if (params.projectId !== null && session.projectId !== params.projectId) return false;
  if ((params.archived === 'only') !== session.archived) return false;
  return matchesTitle(session.title, params.q);
}

/** Puts a changed session into the pages of a list, replaces it there, or takes it out. The same array comes back when nothing changed. */
export function upsertInPages(
  pages: readonly SessionPage[],
  params: SessionListParams,
  session: Session,
): readonly SessionPage[] {
  const accepts = listAccepts(params, session);
  let found = false;
  let changed = false;
  const next = pages.map((page) => {
    const index = page.sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) return page;
    found = true;
    if (accepts && page.sessions[index] === session) return page;
    changed = true;
    const sessions = [...page.sessions];
    if (accepts) sessions[index] = session;
    else sessions.splice(index, 1);
    return { ...page, sessions };
  });
  if (!found && accepts && pages.length > 0) {
    // New to this list. Where it sits on screen is decided by the grouping, not by its place in a page.
    return [{ ...pages[0]!, sessions: [session, ...pages[0]!.sessions] }, ...pages.slice(1)];
  }
  return changed ? next : pages;
}

export function removeFromPages(
  pages: readonly SessionPage[],
  sessionId: string,
): readonly SessionPage[] {
  if (!pages.some((page) => page.sessions.some((entry) => entry.id === sessionId))) return pages;
  return pages.map((page) =>
    page.sessions.some((entry) => entry.id === sessionId)
      ? { ...page, sessions: page.sessions.filter((entry) => entry.id !== sessionId) }
      : page,
  );
}

type ListData = InfiniteData<SessionPage, number>;

function isListParams(value: unknown): value is SessionListParams {
  return typeof value === 'object' && value !== null && 'archived' in value && 'q' in value;
}

/** A session changed (here or elsewhere): every cached list and the session's own entry follow. */
export function upsertSession(queryClient: QueryClient, session: Session): void {
  const current = queryClient.getQueryData<Session>(workbenchKeys.session(session.id));
  // Events can overtake each other; the session that was changed last wins.
  if (current && current.updatedAt > session.updatedAt) return;
  queryClient.setQueryData(workbenchKeys.session(session.id), session);
  for (const [key, data] of queryClient.getQueriesData<ListData>({
    queryKey: workbenchKeys.lists,
  })) {
    const params = key[2];
    if (!data || !isListParams(params)) continue;
    const pages = upsertInPages(data.pages, params, session);
    if (pages !== data.pages)
      queryClient.setQueryData<ListData>(key, { ...data, pages: [...pages] });
  }
}

export function removeSession(queryClient: QueryClient, sessionId: string): void {
  queryClient.removeQueries({ queryKey: workbenchKeys.session(sessionId), exact: true });
  for (const [key, data] of queryClient.getQueriesData<ListData>({
    queryKey: workbenchKeys.lists,
  })) {
    if (!data) continue;
    const pages = removeFromPages(data.pages, sessionId);
    if (pages !== data.pages)
      queryClient.setQueryData<ListData>(key, { ...data, pages: [...pages] });
  }
}

// ---- hooks -------------------------------------------------------------------------

export function useSessionList(params: SessionListParams, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: workbenchKeys.list(params),
    queryFn: ({ pageParam, signal }): Promise<SessionPage> =>
      workbenchApi.listSessions(
        {
          projectId: params.projectId,
          archived: params.archived,
          q: params.q,
          limit: SESSION_PAGE_SIZE,
          offset: pageParam,
        },
        signal,
      ),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, lastOffset) =>
      last.hasMore ? lastOffset + SESSION_PAGE_SIZE : undefined,
    enabled: options.enabled ?? true,
    meta: { live: true },
  });
}

/** Every session loaded for a list, each once. */
export function flattenSessions(data: InfiniteData<SessionPage, unknown> | undefined): Session[] {
  if (!data) return [];
  const seen = new Set<string>();
  const sessions: Session[] = [];
  for (const page of data.pages) {
    for (const session of page.sessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
  }
  return sessions;
}

/** One session, by the Studio's id or the agent's own. Kept current by live events once it is known. */
export function useSessionQuery(sessionId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.session(sessionId ?? ''),
    queryFn: ({ signal }) => workbenchApi.session(sessionId!, signal),
    enabled: sessionId !== null,
    meta: { live: true },
  });
}

/** Which projects have something running, something waiting for the user, or an unseen result. */
export function useActivity(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: workbenchKeys.activity,
    queryFn: ({ signal }) => workbenchApi.activity(signal),
    enabled: options.enabled ?? true,
    meta: { live: true },
  });
}

/**
 * Keeps lists, the open session, drafts and the activity summary current from
 * the user's live topic. Mount it once where the workbench (or its tile) is
 * on show; mounting it twice is harmless.
 */
export function useWorkbenchLiveUpdates(
  handlers: { onRemoved?: (sessionId: string) => void } = {},
): void {
  const user = useUser();
  const queryClient = useQueryClient();
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    const parsed = userAgentEventSchema.safeParse({ type: event.type, data: event.data });
    if (!parsed.success) return; // another feature's event on the same topic
    const message = parsed.data;
    const refreshActivity = () => {
      // A burst of events (a run ending answers its approvals, changes its mark, …) becomes one read.
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void queryClient.invalidateQueries({ queryKey: workbenchKeys.activity });
      }, 300);
    };
    switch (message.type) {
      case USER_AGENT_EVENT.sessionCreated:
      case USER_AGENT_EVENT.sessionUpdated:
        upsertSession(queryClient, message.data.session);
        noteDraftFlag(message.data.session.id, message.data.session.hasDraft);
        refreshActivity();
        break;
      case USER_AGENT_EVENT.sessionRemoved:
        removeSession(queryClient, message.data.sessionId);
        handlersRef.current.onRemoved?.(message.data.sessionId);
        refreshActivity();
        break;
      case USER_AGENT_EVENT.draftChanged:
        applyRemoteDraft(message.data.sessionId, message.data.text);
        break;
      default:
        refreshActivity();
    }
  });
}
