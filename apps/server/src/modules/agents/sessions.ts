import {
  type ActivitySummary,
  type CreateSessionRequest,
  type Draft,
  type EventPage,
  LIVE_EVENT,
  type ListSessionsQuery,
  type MessageSearchHit,
  type PermissionMode,
  type ProjectActivity,
  SESSION_EVENT,
  type Session,
  type SessionEventData,
  type SessionEventType,
  type SessionList,
  type SessionUsage,
  USER_AGENT_EVENT,
  type UpdateSessionRequest,
  sessionTopic,
  userTopic,
} from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../kernel/errors.js';
import type { EventBus } from '../../kernel/events.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import type { ProjectRecord } from '../projects/projects.service.js';
import type { AgentAdapter } from './adapter.js';
import { effectiveMode } from './permissions.js';
import { DEFAULT_TITLE, presentEvent } from './present.js';
import type { AgentStore, SessionPatch, SessionRow, Visibility } from './store.js';

/** The key under which this module keeps its switch in a project's settings bag. */
export const AUTO_MODE_SETTING = 'agentAutoMode';

/** What a caller wants to do with a session. */
export type SessionNeed =
  /** Read it: the creator and the instance owner. */
  | 'view'
  /** Stop its run, answer for it, remove it: the creator and the instance owner. */
  | 'control'
  /** Type into it: the creator only, and only with write access to the project. */
  | 'write';

export interface SessionAccess {
  readonly row: SessionRow;
  readonly project: ProjectRecord | null;
}

/**
 * What only the server may decide about a new session. None of this is part of
 * the request a client sends: a module passes it when it creates a session
 * for a purpose of its own.
 */
export interface SessionOptions {
  /**
   * A helper session: one the Studio runs for itself (the summary of a
   * handoff, say). It is in nobody's lists — sessions, runs, search, activity —
   * nothing about it is published on `user:<id>` or `internal:runs`, and its
   * runs are offered none of the Studio's tools. It is still an ordinary
   * session to the permission engine, and what it uses is recorded in
   * `agent_usage`. Whoever creates one removes it when it has served.
   */
  readonly hidden?: boolean;
  /**
   * Background the agent is given in front of the first message it gets in
   * this session (the brief of a handoff). The transcript keeps the person's
   * own words; adapters that are handed the conversation as history find the
   * seed at its start. The caller frames it as data — the runtime passes it
   * on as written.
   */
  readonly seed?: string;
}

/** Characters of background one session may be created with. */
export const SESSION_SEED_CHARS = 60_000;

const sessionNotFound = () => notFound('No such session.', 'session_not_found');

/**
 * Sessions as records: who may see them, how they are listed and named,
 * drafts, attention marks and presence — and the two primitives everything
 * else is built on: appending to a session's event log, and telling the
 * right people that something changed.
 */
export class SessionService {
  readonly #store: AgentStore;
  readonly #bus: EventBus;
  readonly #context: ModuleContext;
  readonly #presenceTtlMs: number;
  /** user → tab → what is on screen there. */
  readonly #presence = new Map<string, Map<string, { sessions: Set<string>; at: number }>>();
  #pending: Array<() => void> | null = null;
  /** Ids of the helper sessions, read once and kept in step: they are asked about on every announcement. */
  #hidden: Set<string> | null = null;

  constructor(deps: { context: ModuleContext; store: AgentStore; presenceTtlMs: number }) {
    this.#context = deps.context;
    this.#store = deps.store;
    this.#bus = deps.context.bus;
    this.#presenceTtlMs = deps.presenceTtlMs;
  }

  // ---- writing and announcing ----------------------------------------------

  /**
   * Runs `work` in one database transaction. Events published inside are held
   * back until it commits, so nobody is told about something that was rolled
   * back, and they go out in the order they were recorded.
   */
  atomic<T>(work: () => T): T {
    if (this.#pending) return work();
    this.#pending = [];
    let result: T;
    try {
      result = this.#store.transaction(work);
    } catch (error) {
      this.#pending = null;
      throw error;
    }
    const held = this.#pending;
    this.#pending = null;
    for (const publish of held) publish();
    return result;
  }

  #announce(publish: () => void): void {
    if (this.#pending) this.#pending.push(publish);
    else publish();
  }

  /** Appends a durable event to a session's log and sends it to whoever is watching. Returns its sequence number. */
  append<T extends SessionEventType>(sessionId: string, runId: string | null, type: T, data: SessionEventData<T>): number {
    return this.atomic(() => {
      const at = Date.now();
      const seq = this.#store.appendEvent(sessionId, runId, type, data, at);
      if (type === SESSION_EVENT.messageUser || type === SESSION_EVENT.messageAssistant) {
        const text = (data as { text: string }).text;
        this.#store.indexMessage(sessionId, seq, type === SESSION_EVENT.messageUser ? 'user' : 'assistant', text);
      }
      this.#announce(() => this.#bus.publish(sessionTopic(sessionId), type, data, seq));
      return seq;
    });
  }

  /** Sends something to whoever is watching a session without recording it. */
  live(sessionId: string, type: string, data: unknown): void {
    this.#announce(() => this.#bus.publish(sessionTopic(sessionId), type, data));
  }

  /** Whether a session is a helper session (see {@link SessionOptions.hidden}). */
  isHidden(sessionId: string): boolean {
    this.#hidden ??= new Set(this.#store.hiddenSessionIds());
    return this.#hidden.has(sessionId);
  }

  /**
   * True for an announcement about a helper session. Every payload sent to a
   * user or to the other modules names its session in one of three places.
   */
  #aboutHidden(data: unknown): boolean {
    const value = (data ?? {}) as { sessionId?: unknown; session?: { id?: unknown } | null; approval?: { sessionId?: unknown } | null };
    const sessionId = value.sessionId ?? value.session?.id ?? value.approval?.sessionId;
    return typeof sessionId === 'string' && this.isHidden(sessionId);
  }

  /** Tells one user's devices. Nothing is said about a helper session. */
  toUser(userId: string, type: string, data: unknown): void {
    if (this.#aboutHidden(data)) return;
    this.#announce(() => this.#bus.publish(userTopic(userId), type, data));
  }

  /** For the notification and automation modules; see the top of agents.module.ts. Nothing is said about a helper session. */
  internal(type: string, data: unknown): void {
    if (this.#aboutHidden(data)) return;
    this.#announce(() => this.#bus.publish('internal:runs', type, data));
  }

  // ---- access --------------------------------------------------------------

  /**
   * Finds a session the caller may use, or throws. A session the caller
   * cannot see answers exactly like one that does not exist.
   */
  requireSession(principal: Principal, sessionId: string, need: SessionNeed): SessionAccess {
    const row = this.#store.sessionFor(sessionId, principal.userId, principal.role === 'owner');
    if (!row) throw sessionNotFound();
    let project: ProjectRecord | null = null;
    if (row.project_id !== null) {
      const projects = this.#context.services.projects;
      const access = projects.accessOf(principal, row.project_id);
      project = access === null ? null : projects.find(row.project_id);
      if (!project) throw sessionNotFound();
      if (need === 'write' && access !== 'write') throw forbidden('You can view this project but not change it.', 'project_read_only');
    }
    if (need === 'write' && row.user_id !== principal.userId) {
      throw forbidden('Only the person who started this session can write in it.', 'not_your_session');
    }
    return { row, project };
  }

  /** For the realtime hub: may this caller listen to this session? */
  canWatch(principal: Principal, sessionId: string): boolean {
    const row = this.#store.sessionFor(sessionId, principal.userId, principal.role === 'owner');
    if (!row) return false;
    return row.project_id === null || this.#context.services.projects.accessOf(principal, row.project_id) !== null;
  }

  /** The sessions a caller's lists cover: their own (or everyone's, for the owner who asks) in projects they can reach now. */
  visibility(principal: Principal, scope: 'mine' | 'all' = 'mine'): Visibility {
    const everyone = scope === 'all' && principal.role === 'owner';
    const projectIds = this.#context.services.projects.list(principal).map((project) => project.id);
    return { userId: everyone ? null : principal.userId, projectIds };
  }

  // ---- presenting ----------------------------------------------------------

  autoModeEnabled(project: ProjectRecord | null): boolean {
    return project !== null && project.settings[AUTO_MODE_SETTING] === true;
  }

  effectiveModeOf(row: SessionRow, project: ProjectRecord | null): PermissionMode {
    return effectiveMode(row.permission_mode, this.autoModeEnabled(project));
  }

  present(row: SessionRow, project?: ProjectRecord | null): Session {
    const record = project === undefined ? (row.project_id === null ? null : this.#context.services.projects.find(row.project_id)) : project;
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      agentId: row.agent_id,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permission_mode,
      effectivePermissionMode: this.effectiveModeOf(row, record),
      title: row.title,
      titleSource: row.title_source,
      pinned: row.pinned === 1,
      archived: row.archived_at !== null,
      chainId: row.chain_id,
      parentSessionId: row.parent_session_id,
      attention: row.attention,
      activeRunId: this.#store.activeRun(row.id)?.id ?? null,
      hasDraft: row.draft.trim() !== '',
      resumable: row.native_session_id !== null,
      lastSeq: row.last_seq,
      lastActivityAt: row.last_activity_at,
      lastUserMessageAt: row.last_user_message_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Re-reads a session and tells its lists and its watchers that it changed. */
  announceUpdate(sessionId: string): Session | null {
    const row = this.#store.session(sessionId);
    if (!row) return null;
    const session = this.present(row);
    this.toUser(row.user_id, USER_AGENT_EVENT.sessionUpdated, { session });
    this.live(sessionId, LIVE_EVENT.sessionUpdated, { session });
    return session;
  }

  // ---- attention -----------------------------------------------------------

  /**
   * Recomputes a session's mark from its runs and approvals. Because it is
   * derived from stored rows and written back, it survives a restart.
   */
  refreshAttention(sessionId: string, options: { announce?: boolean } = {}): void {
    const row = this.#store.session(sessionId);
    if (!row) return;
    const active = this.#store.activeRun(sessionId);
    let attention: SessionRow['attention'] = 'none';
    if (active) attention = this.#store.pendingApprovalsOfRun(active.id).length > 0 ? 'needs-you' : 'running';
    else if (this.#store.unresolvedRuns(sessionId).length > 0) attention = 'needs-you';
    else if (this.#store.hasUnseenResult(sessionId)) attention = 'unseen';
    const changed = attention !== row.attention;
    if (changed) this.#store.updateSession(sessionId, { attention }, Date.now());
    if (changed || options.announce) this.announceUpdate(sessionId);
  }

  /** The users who have this session visibly on screen right now. */
  viewers(sessionId: string): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [userId, tabs] of this.#presence) {
      for (const [tab, entry] of tabs) {
        if (now - entry.at > this.#presenceTtlMs) tabs.delete(tab);
        else if (entry.sessions.has(sessionId) && !result.includes(userId)) result.push(userId);
      }
      if (tabs.size === 0) this.#presence.delete(userId);
    }
    return result;
  }

  /** A tab reports what it shows. Finished results in those sessions count as seen. */
  reportPresence(principal: Principal, clientId: string, visible: readonly string[]): void {
    let tabs = this.#presence.get(principal.userId);
    if (!tabs) this.#presence.set(principal.userId, (tabs = new Map()));
    // Only sessions the caller may really see count; anything else is dropped without comment.
    const sessions = new Set(visible.filter((sessionId) => this.canWatch(principal, sessionId)));
    if (sessions.size === 0) tabs.delete(clientId);
    else tabs.set(clientId, { sessions, at: Date.now() });
    if (tabs.size > 64) tabs.delete(tabs.keys().next().value!);
    for (const sessionId of sessions) {
      const row = this.#store.session(sessionId);
      if (row && row.user_id === principal.userId) this.markSeen(sessionId);
    }
  }

  forgetPresence(userId: string): void {
    this.#presence.delete(userId);
  }

  markSeen(sessionId: string): void {
    if (this.#store.markResultsSeen(sessionId, Date.now()) > 0) this.refreshAttention(sessionId);
  }

  activity(principal: Principal): ActivitySummary {
    const visible = new Set(this.#context.services.projects.list(principal).map((project) => project.id));
    const byProject = new Map<string | null, ProjectActivity>();
    for (const row of this.#store.activeSessions(principal.userId)) {
      if (row.project_id !== null && !visible.has(row.project_id)) continue;
      let entry = byProject.get(row.project_id);
      if (!entry) byProject.set(row.project_id, (entry = { projectId: row.project_id, running: 0, runningAgents: [], attention: [], unseen: [] }));
      if (this.#store.activeRun(row.id)) {
        entry.running += 1;
        if (!entry.runningAgents.includes(row.agent_id)) entry.runningAgents.push(row.agent_id);
      }
      if (row.attention === 'needs-you') entry.attention.push(row.id);
      if (row.attention === 'unseen') entry.unseen.push(row.id);
    }
    return { projects: [...byProject.values()] };
  }

  // ---- create, read, change, remove ----------------------------------------

  async create(principal: Principal, input: CreateSessionRequest, adapter: AgentAdapter | undefined, options: SessionOptions = {}): Promise<Session> {
    if (!adapter) throw unprocessable('That agent is not available on this Studio.', 'agent_unavailable');
    if (options.seed !== undefined && options.seed.length > SESSION_SEED_CHARS) throw new Error('The background for a new session is too long.');
    let project: ProjectRecord | null = null;
    if (input.projectId === null) {
      // Only a plain chat model may work outside a project: it has no working directory to be confined to.
      if (adapter.kind !== 'api') throw badRequest('Choose the project this session works in.', undefined, 'project_required');
    } else {
      project = this.#context.services.projects.requireAccess(principal, input.projectId, 'write');
      if (!this.#context.services.projects.isAgentEnabled(project, adapter.id)) {
        throw unprocessable('That agent is not offered in this project.', 'agent_not_enabled');
      }
    }
    const capabilities = await adapter.capabilities();
    const permissionMode = input.permissionMode ?? (capabilities.permissionModes.includes('ask') ? 'ask' : capabilities.permissionModes[0] ?? 'ask');
    if (!capabilities.permissionModes.includes(permissionMode)) {
      throw unprocessable(`${adapter.displayName} does not have that permission mode.`, 'unsupported_permission_mode');
    }

    let chainId: string | null = null;
    if (input.parentSessionId !== undefined) {
      const parent = this.requireSession(principal, input.parentSessionId, 'write').row;
      if (parent.project_id !== input.projectId) throw badRequest('A handoff stays inside its project.', undefined, 'parent_in_other_project');
      chainId = parent.chain_id ?? parent.id;
    }

    const now = Date.now();
    const row: SessionRow = {
      id: newId(),
      project_id: input.projectId,
      user_id: principal.userId,
      agent_id: adapter.id,
      model: input.model ?? capabilities.defaultModel,
      effort: input.effort ?? null,
      permission_mode: permissionMode,
      title: input.title ?? DEFAULT_TITLE,
      title_source: input.title === undefined ? 'default' : 'manual',
      native_session_id: null,
      pinned: 0,
      archived_at: null,
      chain_id: chainId,
      parent_session_id: input.parentSessionId ?? null,
      attention: 'none',
      draft: '',
      draft_updated_at: null,
      last_seq: 0,
      last_activity_at: now,
      last_user_message_at: null,
      created_at: now,
      updated_at: now,
      hidden: options.hidden === true ? 1 : 0,
      seed: options.seed === undefined || options.seed === '' ? null : options.seed,
    };
    this.#store.insertSession(row);
    // Known as a helper before anything is announced about it.
    if (row.hidden === 1) (this.#hidden ??= new Set(this.#store.hiddenSessionIds())).add(row.id);
    const session = this.present(row, project);
    this.toUser(principal.userId, USER_AGENT_EVENT.sessionCreated, { session });
    return session;
  }

  /**
   * The conversation a session belongs to after handoffs, oldest first: the
   * session the chain started from and every session created as a
   * continuation of it — those the caller may see. A session that was never
   * handed over is a chain of one. Sessions deleted since are simply absent:
   * the ones that remain keep their order.
   */
  chain(principal: Principal, sessionId: string): Session[] {
    const { row } = this.requireSession(principal, sessionId, 'view');
    const rootId = row.chain_id ?? row.id;
    const projects = new Map<string, ProjectRecord | null>();
    const projectOf = (member: SessionRow): ProjectRecord | null => {
      if (member.project_id === null) return null;
      if (!projects.has(member.project_id)) projects.set(member.project_id, this.#context.services.projects.find(member.project_id));
      return projects.get(member.project_id) ?? null;
    };
    const members = this.#store
      .chain(rootId, principal.userId, principal.role === 'owner')
      .filter((member) => member.project_id === null || this.#context.services.projects.accessOf(principal, member.project_id) !== null);
    // A session comes after the one it continues. Creation times alone would do, were they not
    // milliseconds: two sessions made in the same one have no order of their own.
    const known = new Set(members.map((member) => member.id));
    const placed = new Set<string>();
    const ordered: SessionRow[] = [];
    let waiting = [...members.filter((member) => member.id === rootId), ...members.filter((member) => member.id !== rootId)];
    while (waiting.length > 0) {
      const next = waiting.find((member) => member.parent_session_id === null || !known.has(member.parent_session_id) || placed.has(member.parent_session_id)) ?? waiting[0]!;
      ordered.push(next);
      placed.add(next.id);
      waiting = waiting.filter((member) => member !== next);
    }
    return ordered.map((member) => this.present(member, projectOf(member)));
  }

  /** Accepts the Studio's id or — for links copied from a terminal — the agent's own id. */
  find(principal: Principal, idOrNativeId: string): Session {
    const direct = /^[0-9a-z]{26}$/.test(idOrNativeId) ? this.#store.sessionFor(idOrNativeId, principal.userId, principal.role === 'owner') : undefined;
    const row = direct ?? this.#store.sessionByNativeId(idOrNativeId, principal.userId, principal.role === 'owner');
    if (!row) throw sessionNotFound();
    const access = this.requireSession(principal, row.id, 'view');
    return this.present(access.row, access.project);
  }

  list(principal: Principal, query: ListSessionsQuery): SessionList {
    let visibility = this.visibility(principal, query.scope);
    if (query.projectId !== undefined) {
      // Naming a project also reaches an archived one, as long as the caller may see it.
      this.#context.services.projects.requireAccess(principal, query.projectId);
      visibility = { userId: visibility.userId, projectIds: [query.projectId] };
    }
    const words = (query.q ?? '').split(/\s+/u).filter(Boolean).slice(0, 8);
    const rows = this.#store.listSessions({
      visibility,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      archived: query.archived,
      words,
      limit: query.limit + 1,
      offset: query.offset,
    });
    const projects = new Map<string, ProjectRecord | null>();
    const projectOf = (row: SessionRow): ProjectRecord | null => {
      if (row.project_id === null) return null;
      if (!projects.has(row.project_id)) projects.set(row.project_id, this.#context.services.projects.find(row.project_id));
      return projects.get(row.project_id) ?? null;
    };
    return {
      sessions: rows.slice(0, query.limit).map((row) => this.present(row, projectOf(row))),
      hasMore: rows.length > query.limit,
    };
  }

  async update(principal: Principal, sessionId: string, changes: UpdateSessionRequest, adapter: AgentAdapter | undefined): Promise<Session> {
    const { row } = this.requireSession(principal, sessionId, 'write');
    const patch: SessionPatch = {};
    if (changes.title !== undefined) {
      patch.title = changes.title;
      patch.titleSource = 'manual';
    }
    if (changes.pinned !== undefined) patch.pinned = changes.pinned ? 1 : 0;
    if (changes.archived !== undefined) {
      if (changes.archived && this.#store.activeRun(sessionId)) throw conflict('Stop the run before archiving this session.', 'session_busy');
      patch.archivedAt = changes.archived ? (row.archived_at ?? Date.now()) : null;
    }
    if (changes.model !== undefined) patch.model = changes.model;
    if (changes.effort !== undefined) patch.effort = changes.effort;
    if (changes.permissionMode !== undefined) {
      await this.assertModeSupported(adapter, changes.permissionMode);
      patch.permissionMode = changes.permissionMode;
    }
    this.#store.updateSession(sessionId, patch, Date.now());
    return this.announceUpdate(sessionId)!;
  }

  async assertModeSupported(adapter: AgentAdapter | undefined, mode: PermissionMode): Promise<void> {
    if (!adapter) throw unprocessable('That agent is not available on this Studio.', 'agent_unavailable');
    const capabilities = await adapter.capabilities();
    if (!capabilities.permissionModes.includes(mode)) {
      throw unprocessable(`${adapter.displayName} does not have that permission mode.`, 'unsupported_permission_mode');
    }
  }

  /** A better name from the first message or from the agent. A name the user typed is never touched. */
  rename(sessionId: string, title: string, source: 'auto' | 'agent'): boolean {
    const row = this.#store.session(sessionId);
    if (!row || row.title_source === 'manual' || row.title === title) return false;
    if (source === 'auto' && row.title_source !== 'default') return false;
    this.#store.updateSession(sessionId, { title, titleSource: source }, Date.now());
    return true;
  }

  saveDraft(principal: Principal, sessionId: string, text: string): Draft {
    this.requireSession(principal, sessionId, 'write');
    const now = Date.now();
    const before = this.#store.session(sessionId)!;
    this.#store.updateSession(sessionId, { draft: text, draftUpdatedAt: now }, now);
    const draft: Draft = { sessionId, text, updatedAt: now };
    this.toUser(principal.userId, USER_AGENT_EVENT.draftChanged, draft);
    // The "draft" tag in lists only changes when a draft appears or disappears.
    if ((before.draft.trim() === '') !== (text.trim() === '')) this.announceUpdate(sessionId);
    return draft;
  }

  draft(principal: Principal, sessionId: string): Draft {
    const { row } = this.requireSession(principal, sessionId, 'write');
    return { sessionId, text: row.draft, updatedAt: row.draft_updated_at };
  }

  nativeId(principal: Principal, sessionId: string): string {
    const { row } = this.requireSession(principal, sessionId, 'write');
    if (row.native_session_id === null) throw conflict('The agent has not started a conversation of its own yet.', 'native_id_not_assigned');
    return row.native_session_id;
  }

  events(principal: Principal, sessionId: string, query: { after?: number | undefined; before?: number | undefined; limit: number }): EventPage {
    const { row } = this.requireSession(principal, sessionId, 'view');
    if (query.after !== undefined) {
      const rows = this.#store.eventsAfter(sessionId, query.after, query.limit + 1);
      return { events: rows.slice(0, query.limit).map(presentEvent), hasMore: rows.length > query.limit, lastSeq: row.last_seq };
    }
    const rows = this.#store.eventsBefore(sessionId, query.before ?? null, query.limit + 1);
    // One extra row was read from the old end to learn whether more exist.
    const page = rows.length > query.limit ? rows.slice(1) : rows;
    return { events: page.map(presentEvent), hasMore: rows.length > query.limit, lastSeq: row.last_seq };
  }

  usage(principal: Principal, sessionId: string): SessionUsage {
    this.requireSession(principal, sessionId, 'view');
    const latest = this.#store.latestContext(sessionId);
    return {
      context: latest ? { tokens: latest.context_tokens!, window: latest.context_window, model: latest.model, at: latest.at } : null,
      totals: this.#store.usageTotals(sessionId).map((row) => ({
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        costUsd: row.cost_usd,
      })),
    };
  }

  search(principal: Principal, query: { q: string; projectId?: string | undefined; limit: number }): MessageSearchHit[] {
    let visibility = this.visibility(principal);
    if (query.projectId !== undefined) {
      this.#context.services.projects.requireAccess(principal, query.projectId);
      visibility = { userId: visibility.userId, projectIds: [query.projectId] };
    }
    const rows = this.#store.searchMessages({
      query: query.q,
      visibility,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      limit: query.limit,
    });
    return rows.map((row) => {
      const at = row.text.toLowerCase().indexOf(query.q.toLowerCase());
      const start = at === -1 ? 0 : Math.max(0, at - 60);
      const end = Math.min(row.text.length, (at === -1 ? 0 : at + query.q.length) + 90);
      const prefix = start > 0 ? '…' : '';
      return {
        sessionId: row.session_id,
        projectId: row.project_id,
        title: row.title,
        seq: row.seq,
        role: row.role,
        snippet: `${prefix}${row.text.slice(start, end)}${end < row.text.length ? '…' : ''}`,
        matchStart: at === -1 ? -1 : at - start + prefix.length,
        matchLength: at === -1 ? 0 : query.q.length,
        at: row.at,
      };
    });
  }

  /** Removes the row and everything that hangs off it. Files on disk are the caller's to remove. */
  deleteRow(row: SessionRow): void {
    this.#store.deleteSession(row.id);
    this.toUser(row.user_id, USER_AGENT_EVENT.sessionRemoved, { sessionId: row.id, projectId: row.project_id });
    this.#hidden?.delete(row.id);
  }
}
