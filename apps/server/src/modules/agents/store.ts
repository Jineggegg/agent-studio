import type {
  ApprovalKind,
  ApprovalStatus,
  Attention,
  PermissionMode,
  RiskClass,
  RuleEffect,
  RuleScope,
  RunOrigin,
  RunStatus,
  TitleSource,
} from '@agent-studio/protocol';
import { type Database, type SqlValue, escapeLike, toSql } from '../../kernel/database.js';

/**
 * All SQL of the agent runtime. Nothing here publishes events or checks
 * access: callers pass in who is asking, and every read that serves a client
 * filters on that in the query itself.
 */

export interface SessionRow {
  id: string;
  project_id: string | null;
  user_id: string;
  agent_id: string;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode;
  title: string;
  title_source: TitleSource;
  native_session_id: string | null;
  pinned: number;
  archived_at: number | null;
  chain_id: string | null;
  parent_session_id: string | null;
  attention: Attention;
  draft: string;
  draft_updated_at: number | null;
  last_seq: number;
  last_activity_at: number;
  last_user_message_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  session_id: string;
  seq: number;
  run_id: string | null;
  type: string;
  data: string;
  at: number;
}

export interface RunRow {
  id: string;
  session_id: string;
  user_id: string;
  project_id: string | null;
  agent_id: string;
  request_id: string;
  origin: RunOrigin;
  unattended: number;
  wait_for_approval: number;
  status: RunStatus;
  source_text: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode;
  error_code: string | null;
  error_message: string | null;
  interrupted_by_restart: number;
  continues_run_id: string | null;
  continued_by_run_id: string | null;
  dismissed_at: number | null;
  seen_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface ReceiptRow {
  user_id: string;
  request_id: string;
  session_id: string;
  request_hash: string;
  disposition: 'run' | 'queued' | 'steered';
  run_id: string | null;
  queue_item_id: string | null;
  created_at: number;
}

export interface QueueRow {
  id: string;
  session_id: string;
  user_id: string;
  request_id: string;
  position: number;
  text: string;
  attachment_ids: string;
  quote: string | null;
  created_at: number;
  updated_at: number;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  session_id: string;
  user_id: string;
  project_id: string | null;
  kind: ApprovalKind;
  tool_name: string | null;
  tool_kind: string | null;
  tool_call_id: string | null;
  title: string;
  detail: string;
  risk: RiskClass;
  risk_categories: string;
  reason: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  answers: string | null;
  expires_at: number | null;
  created_at: number;
}

export interface RuleRow {
  id: string;
  scope: RuleScope;
  user_id: string;
  project_id: string | null;
  session_id: string | null;
  effect: RuleEffect;
  tool: string;
  pattern: string | null;
  shared: number;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  session_id: string;
  user_id: string;
  name: string;
  stored_name: string;
  media_type: string;
  size: number;
  sent_at: number | null;
  created_at: number;
}

export interface UsageRow {
  run_id: string;
  model: string;
  session_id: string;
  user_id: string;
  project_id: string | null;
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  context_tokens: number | null;
  context_window: number | null;
  at: number;
}

/**
 * Which sessions a caller may see: their own — or everyone's for the instance
 * owner who asks for it — restricted to projects they can reach right now.
 */
export interface Visibility {
  /** Null: every user's sessions (the instance owner). */
  readonly userId: string | null;
  /** Null: every project. Otherwise only these, plus sessions without a project. */
  readonly projectIds: readonly string[] | null;
}

const SESSION_COLUMNS = {
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission_mode',
  title: 'title',
  titleSource: 'title_source',
  nativeSessionId: 'native_session_id',
  pinned: 'pinned',
  archivedAt: 'archived_at',
  attention: 'attention',
  draft: 'draft',
  draftUpdatedAt: 'draft_updated_at',
  lastActivityAt: 'last_activity_at',
  lastUserMessageAt: 'last_user_message_at',
} as const;
export type SessionPatch = Partial<Record<keyof typeof SESSION_COLUMNS, SqlValue>>;

const RUN_COLUMNS = {
  status: 'status',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  interruptedByRestart: 'interrupted_by_restart',
  seenAt: 'seen_at',
  permissionMode: 'permission_mode',
} as const;
export type RunPatch = Partial<Record<keyof typeof RUN_COLUMNS, SqlValue>>;

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

export class AgentStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  transaction<T>(work: () => T): T {
    return this.#db.transaction(work);
  }

  #visibility(visibility: Visibility, alias: string): { sql: string; params: SqlValue[] } {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (visibility.userId !== null) {
      clauses.push(`${alias}.user_id = ?`);
      params.push(visibility.userId);
    }
    if (visibility.projectIds !== null) {
      if (visibility.projectIds.length === 0) {
        clauses.push(`${alias}.project_id IS NULL`);
      } else {
        clauses.push(`(${alias}.project_id IS NULL OR ${alias}.project_id IN (${placeholders(visibility.projectIds.length)}))`);
        params.push(...visibility.projectIds);
      }
    }
    return { sql: clauses.length === 0 ? '1 = 1' : clauses.join(' AND '), params };
  }

  // ---- sessions ------------------------------------------------------------

  insertSession(row: SessionRow): void {
    this.#db.run(
      `INSERT INTO agent_sessions (id, project_id, user_id, agent_id, model, effort, permission_mode, title, title_source,
         native_session_id, pinned, archived_at, chain_id, parent_session_id, attention, draft, draft_updated_at,
         last_seq, last_activity_at, last_user_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.project_id,
      row.user_id,
      row.agent_id,
      row.model,
      row.effort,
      row.permission_mode,
      row.title,
      row.title_source,
      row.native_session_id,
      row.pinned,
      row.archived_at,
      row.chain_id,
      row.parent_session_id,
      row.attention,
      row.draft,
      row.draft_updated_at,
      row.last_seq,
      row.last_activity_at,
      row.last_user_message_at,
      row.created_at,
      row.updated_at,
    );
  }

  /** Lookup with no access check, for the runtime's own use. */
  session(id: string): SessionRow | undefined {
    return this.#db.get<SessionRow>('SELECT * FROM agent_sessions WHERE id = ?', id);
  }

  /** The session if this user created it, or — for the instance owner — whoever did. */
  sessionFor(id: string, userId: string, isOwner: boolean): SessionRow | undefined {
    return this.#db.get<SessionRow>('SELECT * FROM agent_sessions WHERE id = ? AND (user_id = ? OR ? = 1)', id, userId, toSql(isOwner));
  }

  sessionByNativeId(nativeId: string, userId: string, isOwner: boolean): SessionRow | undefined {
    return this.#db.get<SessionRow>(
      'SELECT * FROM agent_sessions WHERE native_session_id = ? AND (user_id = ? OR ? = 1) ORDER BY created_at DESC LIMIT 1',
      nativeId,
      userId,
      toSql(isOwner),
    );
  }

  listSessions(options: {
    visibility: Visibility;
    projectId?: string;
    archived: 'exclude' | 'only' | 'include';
    words: readonly string[];
    limit: number;
    offset: number;
  }): SessionRow[] {
    const visible = this.#visibility(options.visibility, 's');
    const clauses = [visible.sql];
    const params = [...visible.params];
    if (options.projectId !== undefined) {
      clauses.push('s.project_id = ?');
      params.push(options.projectId);
    }
    if (options.archived === 'exclude') clauses.push('s.archived_at IS NULL');
    if (options.archived === 'only') clauses.push('s.archived_at IS NOT NULL');
    for (const word of options.words) {
      clauses.push("s.title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(word)}%`);
    }
    return this.#db.all<SessionRow>(
      `SELECT s.* FROM agent_sessions s
       WHERE ${clauses.join(' AND ')}
       ORDER BY EXISTS (SELECT 1 FROM agent_runs r WHERE r.session_id = s.id AND r.status IN ('accepted', 'running')) DESC,
                s.pinned DESC,
                COALESCE(s.last_user_message_at, s.created_at) DESC,
                s.id DESC
       LIMIT ? OFFSET ?`,
      ...params,
      options.limit,
      options.offset,
    );
  }

  /** Sessions of one user that carry an attention mark or are running. */
  activeSessions(userId: string): SessionRow[] {
    return this.#db.all<SessionRow>("SELECT * FROM agent_sessions WHERE user_id = ? AND attention != 'none' AND archived_at IS NULL", userId);
  }

  updateSession(id: string, patch: SessionPatch, now: number): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${SESSION_COLUMNS[key as keyof typeof SESSION_COLUMNS]} = ?`);
      params.push(value);
    }
    sets.push('updated_at = ?');
    params.push(now);
    this.#db.run(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  deleteSession(id: string): void {
    this.#db.run('DELETE FROM agent_message_fts WHERE session_id = ?', id);
    this.#db.run('DELETE FROM agent_sessions WHERE id = ?', id);
  }

  sessionIdsOfProject(projectId: string): string[] {
    return this.#db.all<{ id: string }>('SELECT id FROM agent_sessions WHERE project_id = ?', projectId).map((row) => row.id);
  }

  sessionIdsOfUser(userId: string): string[] {
    return this.#db.all<{ id: string }>('SELECT id FROM agent_sessions WHERE user_id = ?', userId).map((row) => row.id);
  }

  allSessionIds(): Set<string> {
    return new Set(this.#db.all<{ id: string }>('SELECT id FROM agent_sessions').map((row) => row.id));
  }

  // ---- event log -----------------------------------------------------------

  /** Appends one event and returns its sequence number. Must run inside a transaction with what it records. */
  appendEvent(sessionId: string, runId: string | null, type: string, data: unknown, at: number): number {
    const row = this.#db.get<{ last_seq: number }>(
      'UPDATE agent_sessions SET last_seq = last_seq + 1, last_activity_at = ? WHERE id = ? RETURNING last_seq',
      at,
      sessionId,
    );
    if (!row) throw new Error('The session no longer exists.');
    this.#db.run(
      'INSERT INTO agent_events (session_id, seq, run_id, type, data, at) VALUES (?, ?, ?, ?, ?, ?)',
      sessionId,
      row.last_seq,
      runId,
      type,
      JSON.stringify(data),
      at,
    );
    return row.last_seq;
  }

  eventsAfter(sessionId: string, after: number, limit: number): EventRow[] {
    return this.#db.all<EventRow>('SELECT * FROM agent_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?', sessionId, after, limit);
  }

  /** The page just before `before` (or the newest page), oldest first. */
  eventsBefore(sessionId: string, before: number | null, limit: number): EventRow[] {
    return this.#db
      .all<EventRow>(
        'SELECT * FROM agent_events WHERE session_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?',
        sessionId,
        before,
        before,
        limit,
      )
      .reverse();
  }

  /** The newest `limit` events after `after`, oldest first — what a reconnecting client is sent. */
  eventsTail(sessionId: string, after: number, limit: number): EventRow[] {
    return this.#db
      .all<EventRow>('SELECT * FROM agent_events WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?', sessionId, after, limit)
      .reverse();
  }

  /** User and assistant messages of a session, oldest first, for adapters that keep no conversation themselves. */
  conversation(sessionId: string, beforeSeq: number, limit: number): Array<{ type: string; data: string }> {
    return this.#db
      .all<{ type: string; data: string }>(
        `SELECT type, data FROM agent_events
         WHERE session_id = ? AND seq < ? AND type IN ('message.user', 'message.assistant')
         ORDER BY seq DESC LIMIT ?`,
        sessionId,
        beforeSeq,
        limit,
      )
      .reverse();
  }

  indexMessage(sessionId: string, seq: number, role: 'user' | 'assistant', text: string): void {
    if (text.trim() === '') return;
    this.#db.run('INSERT INTO agent_message_fts (text, session_id, seq, role) VALUES (?, ?, ?, ?)', text, sessionId, seq, role);
  }

  removeOrphanedIndex(): void {
    this.#db.run('DELETE FROM agent_message_fts WHERE session_id NOT IN (SELECT id FROM agent_sessions)');
  }

  removeIndexOfSessions(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.#db.run('DELETE FROM agent_message_fts WHERE session_id = ?', id);
  }

  searchMessages(options: { query: string; visibility: Visibility; projectId?: string; limit: number }): Array<{
    session_id: string;
    project_id: string | null;
    title: string;
    seq: number;
    role: 'user' | 'assistant';
    text: string;
    at: number;
  }> {
    const visible = this.#visibility(options.visibility, 's');
    const clauses = [visible.sql, 's.archived_at IS NULL'];
    const params = [...visible.params];
    if (options.projectId !== undefined) {
      clauses.push('s.project_id = ?');
      params.push(options.projectId);
    }
    // Three characters make a trigram; anything shorter cannot use the index and is matched by scanning.
    const useIndex = [...options.query].length >= 3;
    const match = useIndex ? 'agent_message_fts MATCH ?' : "f.text LIKE ? ESCAPE '\\'";
    const needle = useIndex ? `"${options.query.replaceAll('"', '""')}"` : `%${escapeLike(options.query)}%`;
    return this.#db.all(
      `SELECT f.session_id, s.project_id, s.title, CAST(f.seq AS INTEGER) AS seq, f.role, f.text, e.at
       FROM agent_message_fts f
       JOIN agent_sessions s ON s.id = f.session_id
       JOIN agent_events e ON e.session_id = f.session_id AND e.seq = CAST(f.seq AS INTEGER)
       WHERE ${match} AND ${clauses.join(' AND ')}
       ORDER BY e.at DESC, f.seq DESC
       LIMIT ?`,
      needle,
      ...params,
      options.limit,
    );
  }

  // ---- runs ----------------------------------------------------------------

  insertRun(row: RunRow): void {
    this.#db.run(
      `INSERT INTO agent_runs (id, session_id, user_id, project_id, agent_id, request_id, origin, unattended, wait_for_approval,
         status, source_text, prompt, model, effort, permission_mode, error_code, error_message, interrupted_by_restart,
         continues_run_id, continued_by_run_id, dismissed_at, seen_at, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.session_id,
      row.user_id,
      row.project_id,
      row.agent_id,
      row.request_id,
      row.origin,
      row.unattended,
      row.wait_for_approval,
      row.status,
      row.source_text,
      row.prompt,
      row.model,
      row.effort,
      row.permission_mode,
      row.error_code,
      row.error_message,
      row.interrupted_by_restart,
      row.continues_run_id,
      row.continued_by_run_id,
      row.dismissed_at,
      row.seen_at,
      row.created_at,
      row.started_at,
      row.finished_at,
    );
  }

  run(id: string): RunRow | undefined {
    return this.#db.get<RunRow>('SELECT * FROM agent_runs WHERE id = ?', id);
  }

  activeRun(sessionId: string): RunRow | undefined {
    return this.#db.get<RunRow>("SELECT * FROM agent_runs WHERE session_id = ? AND status IN ('accepted', 'running')", sessionId);
  }

  latestRun(sessionId: string): RunRow | undefined {
    return this.#db.get<RunRow>('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', sessionId);
  }

  /** Changes a run only if it is still in one of the `from` states. This is what makes the terminal event happen once. */
  transitionRun(id: string, from: readonly RunStatus[], patch: RunPatch): boolean {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${RUN_COLUMNS[key as keyof typeof RUN_COLUMNS]} = ?`);
      params.push(value);
    }
    const result = this.#db.run(
      `UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders(from.length)})`,
      ...params,
      id,
      ...from,
    );
    return result.changes === 1;
  }

  runsInFlight(): RunRow[] {
    return this.#db.all<RunRow>("SELECT * FROM agent_runs WHERE status IN ('accepted', 'running') ORDER BY created_at");
  }

  listRuns(options: {
    userId: string | null;
    state: 'unresolved' | 'active' | 'all';
    projectId?: string;
    sessionId?: string;
    limit: number;
  }): RunRow[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (options.userId !== null) {
      clauses.push('user_id = ?');
      params.push(options.userId);
    }
    if (options.state === 'unresolved') {
      clauses.push("status IN ('failed', 'interrupted') AND dismissed_at IS NULL AND continued_by_run_id IS NULL");
    } else if (options.state === 'active') {
      clauses.push("status IN ('accepted', 'running')");
    }
    if (options.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(options.sessionId);
    }
    return this.#db.all<RunRow>(
      `SELECT * FROM agent_runs ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params,
      options.limit,
    );
  }

  unresolvedRuns(sessionId: string): RunRow[] {
    return this.#db.all<RunRow>(
      `SELECT * FROM agent_runs WHERE session_id = ? AND status IN ('failed', 'interrupted')
         AND dismissed_at IS NULL AND continued_by_run_id IS NULL ORDER BY created_at DESC`,
      sessionId,
    );
  }

  hasUnseenResult(sessionId: string): boolean {
    return this.#db.get("SELECT 1 AS x FROM agent_runs WHERE session_id = ? AND status = 'completed' AND seen_at IS NULL LIMIT 1", sessionId) !== undefined;
  }

  /** Marks the finished results of a session as seen. Failed and interrupted runs are never read this way. */
  markResultsSeen(sessionId: string, at: number): number {
    return this.#db.run("UPDATE agent_runs SET seen_at = ? WHERE session_id = ? AND status IN ('completed', 'stopped') AND seen_at IS NULL", at, sessionId).changes;
  }

  /** The atomic, single claim on a failed or interrupted run. */
  claimContinuation(recordId: string, userId: string, newRunId: string): boolean {
    return (
      this.#db.run(
        `UPDATE agent_runs SET continued_by_run_id = ?
         WHERE id = ? AND user_id = ? AND status IN ('failed', 'interrupted') AND continued_by_run_id IS NULL AND dismissed_at IS NULL`,
        newRunId,
        recordId,
        userId,
      ).changes === 1
    );
  }

  dismissRun(id: string, at: number): boolean {
    return (
      this.#db.run(
        "UPDATE agent_runs SET dismissed_at = ? WHERE id = ? AND status IN ('failed', 'interrupted') AND dismissed_at IS NULL AND continued_by_run_id IS NULL",
        at,
        id,
      ).changes === 1
    );
  }

  // ---- receipts ------------------------------------------------------------

  receipt(userId: string, requestId: string): ReceiptRow | undefined {
    return this.#db.get<ReceiptRow>('SELECT * FROM agent_receipts WHERE user_id = ? AND request_id = ?', userId, requestId);
  }

  insertReceipt(row: ReceiptRow): void {
    this.#db.run(
      `INSERT INTO agent_receipts (user_id, request_id, session_id, request_hash, disposition, run_id, queue_item_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.user_id,
      row.request_id,
      row.session_id,
      row.request_hash,
      row.disposition,
      row.run_id,
      row.queue_item_id,
      row.created_at,
    );
  }

  updateReceipt(userId: string, requestId: string, disposition: ReceiptRow['disposition'], runId: string | null, queueItemId: string | null): void {
    this.#db.run(
      'UPDATE agent_receipts SET disposition = ?, run_id = ?, queue_item_id = ? WHERE user_id = ? AND request_id = ?',
      disposition,
      runId,
      queueItemId,
      userId,
      requestId,
    );
  }

  deleteReceipt(userId: string, requestId: string): void {
    this.#db.run('DELETE FROM agent_receipts WHERE user_id = ? AND request_id = ?', userId, requestId);
  }

  // ---- queue ---------------------------------------------------------------

  queue(sessionId: string): QueueRow[] {
    return this.#db.all<QueueRow>('SELECT * FROM agent_queue WHERE session_id = ? ORDER BY position, created_at, id', sessionId);
  }

  queueItem(sessionId: string, id: string): QueueRow | undefined {
    return this.#db.get<QueueRow>('SELECT * FROM agent_queue WHERE id = ? AND session_id = ?', id, sessionId);
  }

  queueLength(sessionId: string): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_queue WHERE session_id = ?', sessionId)!.n;
  }

  insertQueueItem(row: Omit<QueueRow, 'position'>): QueueRow {
    const last = this.#db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM agent_queue WHERE session_id = ?', row.session_id)!.p;
    const position = (last ?? 0) + 1;
    this.#db.run(
      `INSERT INTO agent_queue (id, session_id, user_id, request_id, position, text, attachment_ids, quote, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.session_id,
      row.user_id,
      row.request_id,
      position,
      row.text,
      row.attachment_ids,
      row.quote,
      row.created_at,
      row.updated_at,
    );
    return { ...row, position };
  }

  updateQueueText(sessionId: string, id: string, text: string, at: number): boolean {
    return this.#db.run('UPDATE agent_queue SET text = ?, updated_at = ? WHERE id = ? AND session_id = ?', text, at, id, sessionId).changes === 1;
  }

  deleteQueueItem(sessionId: string, id: string): boolean {
    return this.#db.run('DELETE FROM agent_queue WHERE id = ? AND session_id = ?', id, sessionId).changes === 1;
  }

  moveQueueItemToFront(sessionId: string, id: string): void {
    const first = this.#db.get<{ p: number | null }>('SELECT MIN(position) AS p FROM agent_queue WHERE session_id = ?', sessionId)!.p;
    this.#db.run('UPDATE agent_queue SET position = ? WHERE id = ? AND session_id = ?', (first ?? 1) - 1, id, sessionId);
  }

  sessionsWithQueue(): string[] {
    return this.#db.all<{ session_id: string }>('SELECT DISTINCT session_id FROM agent_queue').map((row) => row.session_id);
  }

  // ---- approvals -----------------------------------------------------------

  insertApproval(row: ApprovalRow): void {
    this.#db.run(
      `INSERT INTO agent_approvals (id, run_id, session_id, user_id, project_id, kind, tool_name, tool_kind, tool_call_id, title,
         detail, risk, risk_categories, reason, status, decided_by, decided_at, note, answers, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.run_id,
      row.session_id,
      row.user_id,
      row.project_id,
      row.kind,
      row.tool_name,
      row.tool_kind,
      row.tool_call_id,
      row.title,
      row.detail,
      row.risk,
      row.risk_categories,
      row.reason,
      row.status,
      row.decided_by,
      row.decided_at,
      row.note,
      row.answers,
      row.expires_at,
      row.created_at,
    );
  }

  approval(id: string): ApprovalRow | undefined {
    return this.#db.get<ApprovalRow>('SELECT * FROM agent_approvals WHERE id = ?', id);
  }

  /** Resolves an approval if — and only if — it is still pending. The first caller wins. */
  resolveApproval(id: string, status: Exclude<ApprovalStatus, 'pending'>, decidedBy: string | null, at: number, note: string | null, answers: string | null): boolean {
    return (
      this.#db.run(
        "UPDATE agent_approvals SET status = ?, decided_by = ?, decided_at = ?, note = ?, answers = ? WHERE id = ? AND status = 'pending'",
        status,
        decidedBy,
        at,
        note,
        answers,
        id,
      ).changes === 1
    );
  }

  pendingApprovalsOfSession(sessionId: string): ApprovalRow[] {
    return this.#db.all<ApprovalRow>("SELECT * FROM agent_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at, id", sessionId);
  }

  pendingApprovalsOfRun(runId: string): ApprovalRow[] {
    return this.#db.all<ApprovalRow>("SELECT * FROM agent_approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at, id", runId);
  }

  allPendingApprovals(): ApprovalRow[] {
    return this.#db.all<ApprovalRow>("SELECT * FROM agent_approvals WHERE status = 'pending' ORDER BY created_at, id");
  }

  /**
   * Approvals a caller may answer or see: those of their own runs and — for
   * the instance owner — everyone's.
   */
  listApprovals(options: { userId: string; isOwner: boolean; status: 'pending' | 'all'; sessionId?: string; limit: number }): ApprovalRow[] {
    return this.#db.all<ApprovalRow>(
      `SELECT * FROM agent_approvals
       WHERE (user_id = ? OR ? = 1) AND (? = 'all' OR status = 'pending') AND (? IS NULL OR session_id = ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      options.userId,
      toSql(options.isOwner),
      options.status,
      options.sessionId ?? null,
      options.sessionId ?? null,
      options.limit,
    );
  }

  // ---- permission rules ----------------------------------------------------

  insertRule(row: RuleRow): void {
    this.#db.run(
      `INSERT INTO agent_permission_rules (id, scope, user_id, project_id, session_id, effect, tool, pattern, shared, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.scope,
      row.user_id,
      row.project_id,
      row.session_id,
      row.effect,
      row.tool,
      row.pattern,
      row.shared,
      row.created_at,
    );
  }

  rule(id: string): RuleRow | undefined {
    return this.#db.get<RuleRow>('SELECT * FROM agent_permission_rules WHERE id = ?', id);
  }

  findRule(row: Pick<RuleRow, 'scope' | 'user_id' | 'project_id' | 'session_id' | 'effect' | 'tool' | 'pattern'>): RuleRow | undefined {
    return this.#db.get<RuleRow>(
      `SELECT * FROM agent_permission_rules
       WHERE scope = ? AND user_id = ? AND project_id IS ? AND session_id IS ? AND effect = ? AND tool = ? AND pattern IS ?`,
      row.scope,
      row.user_id,
      row.project_id,
      row.session_id,
      row.effect,
      row.tool,
      row.pattern,
    );
  }

  deleteRule(id: string): void {
    this.#db.run('DELETE FROM agent_permission_rules WHERE id = ?', id);
  }

  countRules(userId: string): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_permission_rules WHERE user_id = ?', userId)!.n;
  }

  /** A user's own rules, plus the shared rules of the projects in `projectIds` (null: every project). */
  listRules(options: { userId: string; scope?: RuleScope; projectId?: string; sessionId?: string; sharedProjectIds: readonly string[] | null }): RuleRow[] {
    const shared =
      options.sharedProjectIds === null
        ? { sql: 'shared = 1', params: [] as SqlValue[] }
        : options.sharedProjectIds.length === 0
          ? { sql: '0 = 1', params: [] as SqlValue[] }
          : { sql: `shared = 1 AND project_id IN (${placeholders(options.sharedProjectIds.length)})`, params: [...options.sharedProjectIds] as SqlValue[] };
    return this.#db.all<RuleRow>(
      `SELECT * FROM agent_permission_rules
       WHERE (user_id = ? OR (${shared.sql}))
         AND (? IS NULL OR scope = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR session_id = ?)
       ORDER BY created_at DESC, id DESC`,
      options.userId,
      ...shared.params,
      options.scope ?? null,
      options.scope ?? null,
      options.projectId ?? null,
      options.projectId ?? null,
      options.sessionId ?? null,
      options.sessionId ?? null,
    );
  }

  /** The rules that apply to one run: its user's account rules, their rules and the shared rules of its project, and its session's rules. */
  rulesForRun(run: { userId: string; projectId: string | null; sessionId: string }): RuleRow[] {
    return this.#db.all<RuleRow>(
      `SELECT * FROM agent_permission_rules
       WHERE (scope = 'account' AND user_id = ?)
          OR (scope = 'project' AND project_id IS NOT NULL AND project_id = ? AND (user_id = ? OR shared = 1))
          OR (scope = 'session' AND session_id = ? AND user_id = ?)`,
      run.userId,
      run.projectId,
      run.userId,
      run.sessionId,
      run.userId,
    );
  }

  // ---- attachments ---------------------------------------------------------

  insertAttachment(row: AttachmentRow): void {
    this.#db.run(
      `INSERT INTO agent_attachments (id, session_id, user_id, name, stored_name, media_type, size, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.session_id,
      row.user_id,
      row.name,
      row.stored_name,
      row.media_type,
      row.size,
      row.sent_at,
      row.created_at,
    );
  }

  attachment(sessionId: string, id: string): AttachmentRow | undefined {
    return this.#db.get<AttachmentRow>('SELECT * FROM agent_attachments WHERE id = ? AND session_id = ?', id, sessionId);
  }

  attachmentsOfSession(sessionId: string, pendingOnly: boolean): AttachmentRow[] {
    return this.#db.all<AttachmentRow>(
      'SELECT * FROM agent_attachments WHERE session_id = ? AND (? = 0 OR sent_at IS NULL) ORDER BY created_at, id',
      sessionId,
      toSql(pendingOnly),
    );
  }

  markAttachmentsSent(sessionId: string, ids: readonly string[], at: number): void {
    for (const id of ids) this.#db.run('UPDATE agent_attachments SET sent_at = COALESCE(sent_at, ?) WHERE id = ? AND session_id = ?', at, id, sessionId);
  }

  deleteAttachment(sessionId: string, id: string): void {
    this.#db.run('DELETE FROM agent_attachments WHERE id = ? AND session_id = ?', id, sessionId);
  }

  // ---- usage ---------------------------------------------------------------

  usageRow(runId: string, model: string): UsageRow | undefined {
    return this.#db.get<UsageRow>('SELECT * FROM agent_usage WHERE run_id = ? AND model = ?', runId, model);
  }

  upsertUsage(row: UsageRow): void {
    this.#db.run(
      `INSERT INTO agent_usage (run_id, model, session_id, user_id, project_id, agent_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, context_tokens, context_window, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, model) DO UPDATE SET
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
         cost_usd = excluded.cost_usd, context_tokens = excluded.context_tokens,
         context_window = excluded.context_window, at = excluded.at`,
      row.run_id,
      row.model,
      row.session_id,
      row.user_id,
      row.project_id,
      row.agent_id,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens,
      row.cache_write_tokens,
      row.cost_usd,
      row.context_tokens,
      row.context_window,
      row.at,
    );
  }

  usageTotals(sessionId: string): Array<{ model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number | null }> {
    return this.#db.all(
      `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(cost_usd) AS cost_usd
       FROM agent_usage WHERE session_id = ? GROUP BY model ORDER BY model`,
      sessionId,
    );
  }

  latestContext(sessionId: string): UsageRow | undefined {
    return this.#db.get<UsageRow>(
      'SELECT * FROM agent_usage WHERE session_id = ? AND context_tokens IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1',
      sessionId,
    );
  }
}
