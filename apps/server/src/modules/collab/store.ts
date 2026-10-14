import type { PermissionMode, SynthesisState, TaskIsolation, TaskState } from '@agent-studio/protocol';
import { type Database, type Migration, type SqlValue, toSql } from '../../kernel/database.js';

/**
 * The collab module's own records: handoffs, multi-agent tasks and their
 * participants. Sessions, runs and events stay the agent runtime's — a row
 * here only names them. Every read that serves a client filters on the user
 * it is for in the query itself.
 */
export const COLLAB_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'handoffs, multi-agent tasks, participants',
    sql: `
      -- One conversation continued with another agent. The link itself is the runtime's
      -- (agent_sessions.parent_session_id / chain_id); this is the record of what was passed on.
      CREATE TABLE collab_handoffs (
        id TEXT PRIMARY KEY,
        -- Who handed over.
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        -- Hash of source and options: the same request id with different content is a conflict.
        request_hash TEXT NOT NULL,
        -- The source may be deleted later; the brief it gave stays with the session that received it.
        source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        source_agent_id TEXT NOT NULL,
        source_model TEXT,
        source_title TEXT NOT NULL,
        -- Sequence number of the handoff notice in each session's log.
        source_seq INTEGER,
        target_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL,
        target_model TEXT,
        target_seq INTEGER,
        brief_kind TEXT NOT NULL CHECK (brief_kind IN ('digest', 'summary')),
        -- The brief as the new agent was given it, without its frame. Credentials were removed before it was stored.
        brief TEXT NOT NULL,
        summary_requested INTEGER NOT NULL DEFAULT 0,
        summary_status TEXT NOT NULL CHECK (summary_status IN ('not-requested', 'written', 'unavailable', 'failed', 'timed-out')),
        summary_agent_id TEXT,
        summary_model TEXT,
        summary_reason TEXT,
        note TEXT,
        started INTEGER NOT NULL DEFAULT 0,
        first_run_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX collab_handoffs_request ON collab_handoffs(user_id, request_id);
      CREATE INDEX collab_handoffs_source ON collab_handoffs(source_session_id);
      CREATE UNIQUE INDEX collab_handoffs_target ON collab_handoffs(target_session_id);

      -- One prompt given to several agents.
      CREATE TABLE collab_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        isolation TEXT NOT NULL CHECK (isolation IN ('shared', 'worktrees')),
        state TEXT NOT NULL CHECK (state IN ('running', 'needs-attention', 'completed', 'stopped')),
        -- When "stop" was pressed.
        stopped_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX collab_tasks_request ON collab_tasks(user_id, request_id);
      CREATE INDEX collab_tasks_user ON collab_tasks(user_id, id);
      CREATE INDEX collab_tasks_project ON collab_tasks(project_id, id);

      -- Who works on a task. Positions 1..n are the participants; position 0 is the synthesis, if one was asked for.
      CREATE TABLE collab_task_participants (
        task_id TEXT NOT NULL REFERENCES collab_tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL,
        -- A participant's session outlives the task record, and the record outlives the session.
        session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        -- The project the session lives in: the task's own, or the project of its worktree.
        session_project_id TEXT,
        -- The participant's run; after a continuation, the newest one.
        run_id TEXT,
        -- starting | running | waiting-approval | completed | failed | stopped | interrupted,
        -- and for the synthesis also pending | skipped.
        state TEXT NOT NULL,
        -- A failed or interrupted run that was dismissed in the runtime.
        acknowledged INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        -- Why a synthesis was skipped or could not start.
        note TEXT,
        -- The last thing the agent said in its run, bounded; kept so that a comparison can be made
        -- when everybody has finished. Never returned once the session is gone.
        answer TEXT,
        answer_partial INTEGER NOT NULL DEFAULT 0,
        branch TEXT,
        -- The commit the worktree started at: what "changed" is measured against.
        base_oid TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY (task_id, position)
      ) WITHOUT ROWID;
      CREATE INDEX collab_task_participants_session ON collab_task_participants(session_id) WHERE session_id IS NOT NULL;
    `,
  },
];

export interface HandoffRow {
  id: string;
  user_id: string;
  project_id: string | null;
  request_id: string;
  request_hash: string;
  source_session_id: string | null;
  source_agent_id: string;
  source_model: string | null;
  source_title: string;
  source_seq: number | null;
  target_session_id: string;
  target_agent_id: string;
  target_model: string | null;
  target_seq: number | null;
  brief_kind: 'digest' | 'summary';
  brief: string;
  summary_requested: number;
  summary_status: 'not-requested' | 'written' | 'unavailable' | 'failed' | 'timed-out';
  summary_agent_id: string | null;
  summary_model: string | null;
  summary_reason: string | null;
  note: string | null;
  started: number;
  first_run_id: string | null;
  created_at: number;
}

export interface TaskRow {
  id: string;
  user_id: string;
  project_id: string;
  request_id: string;
  request_hash: string;
  title: string;
  prompt: string;
  isolation: TaskIsolation;
  state: TaskState;
  stopped_at: number | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

/** Position 0 is the synthesis. */
export const SYNTHESIS_POSITION = 0;

export interface ParticipantRow {
  task_id: string;
  position: number;
  agent_id: string;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode;
  session_id: string | null;
  session_project_id: string | null;
  run_id: string | null;
  state: SynthesisState;
  acknowledged: number;
  error_code: string | null;
  error_message: string | null;
  note: string | null;
  answer: string | null;
  answer_partial: number;
  branch: string | null;
  base_oid: string | null;
  started_at: number | null;
  finished_at: number | null;
}

const PARTICIPANT_COLUMNS = {
  sessionId: 'session_id',
  sessionProjectId: 'session_project_id',
  runId: 'run_id',
  state: 'state',
  acknowledged: 'acknowledged',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  note: 'note',
  answer: 'answer',
  answerPartial: 'answer_partial',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
} as const;
export type ParticipantPatch = Partial<Record<keyof typeof PARTICIPANT_COLUMNS, SqlValue>>;

export class CollabStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  transaction<T>(work: () => T): T {
    return this.#db.transaction(work);
  }

  // ---- handoffs ----------------------------------------------------------------

  insertHandoff(row: HandoffRow): void {
    this.#db.run(
      `INSERT INTO collab_handoffs (id, user_id, project_id, request_id, request_hash, source_session_id, source_agent_id, source_model,
         source_title, source_seq, target_session_id, target_agent_id, target_model, target_seq, brief_kind, brief, summary_requested,
         summary_status, summary_agent_id, summary_model, summary_reason, note, started, first_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.user_id,
      row.project_id,
      row.request_id,
      row.request_hash,
      row.source_session_id,
      row.source_agent_id,
      row.source_model,
      row.source_title,
      row.source_seq,
      row.target_session_id,
      row.target_agent_id,
      row.target_model,
      row.target_seq,
      row.brief_kind,
      row.brief,
      row.summary_requested,
      row.summary_status,
      row.summary_agent_id,
      row.summary_model,
      row.summary_reason,
      row.note,
      row.started,
      row.first_run_id,
      row.created_at,
    );
  }

  handoff(id: string): HandoffRow | undefined {
    return this.#db.get<HandoffRow>('SELECT * FROM collab_handoffs WHERE id = ?', id);
  }

  /** The caller's own earlier request with this id, if any. */
  handoffByRequest(userId: string, requestId: string): HandoffRow | undefined {
    return this.#db.get<HandoffRow>('SELECT * FROM collab_handoffs WHERE user_id = ? AND request_id = ?', userId, requestId);
  }

  /** The handoff a session began with. The caller has already been allowed to see that session. */
  handoffByTarget(sessionId: string): HandoffRow | undefined {
    return this.#db.get<HandoffRow>('SELECT * FROM collab_handoffs WHERE target_session_id = ?', sessionId);
  }

  handoffsBySource(sessionId: string): HandoffRow[] {
    return this.#db.all<HandoffRow>('SELECT * FROM collab_handoffs WHERE source_session_id = ? ORDER BY created_at, id', sessionId);
  }

  markHandoffStarted(id: string, runId: string | null): void {
    this.#db.run('UPDATE collab_handoffs SET started = 1, first_run_id = ? WHERE id = ?', runId, id);
  }

  // ---- tasks -------------------------------------------------------------------

  insertTask(row: TaskRow, participants: readonly ParticipantRow[]): void {
    this.#db.transaction(() => {
      this.#db.run(
        `INSERT INTO collab_tasks (id, user_id, project_id, request_id, request_hash, title, prompt, isolation, state, stopped_at, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.user_id,
        row.project_id,
        row.request_id,
        row.request_hash,
        row.title,
        row.prompt,
        row.isolation,
        row.state,
        row.stopped_at,
        row.created_at,
        row.updated_at,
        row.finished_at,
      );
      for (const participant of participants) {
        this.#db.run(
          `INSERT INTO collab_task_participants (task_id, position, agent_id, model, effort, permission_mode, session_id, session_project_id, run_id,
             state, acknowledged, error_code, error_message, note, answer, answer_partial, branch, base_oid, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          participant.task_id,
          participant.position,
          participant.agent_id,
          participant.model,
          participant.effort,
          participant.permission_mode,
          participant.session_id,
          participant.session_project_id,
          participant.run_id,
          participant.state,
          participant.acknowledged,
          participant.error_code,
          participant.error_message,
          participant.note,
          participant.answer,
          participant.answer_partial,
          participant.branch,
          participant.base_oid,
          participant.started_at,
          participant.finished_at,
        );
      }
    });
  }

  /** Lookup with no access check, for the module's own bookkeeping. */
  task(id: string): TaskRow | undefined {
    return this.#db.get<TaskRow>('SELECT * FROM collab_tasks WHERE id = ?', id);
  }

  /** The task if this user created it, or — for the instance owner — whoever did. */
  taskFor(id: string, userId: string, isOwner: boolean): TaskRow | undefined {
    return this.#db.get<TaskRow>('SELECT * FROM collab_tasks WHERE id = ? AND (user_id = ? OR ? = 1)', id, userId, toSql(isOwner));
  }

  taskByRequest(userId: string, requestId: string): TaskRow | undefined {
    return this.#db.get<TaskRow>('SELECT * FROM collab_tasks WHERE user_id = ? AND request_id = ?', userId, requestId);
  }

  /** Tasks of one user that have not come to an end. */
  countOpenTasks(userId: string): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM collab_tasks WHERE user_id = ? AND state IN ('running', 'needs-attention')", userId)!.n;
  }

  openTasks(): TaskRow[] {
    return this.#db.all<TaskRow>("SELECT * FROM collab_tasks WHERE state IN ('running', 'needs-attention') ORDER BY id");
  }

  /**
   * Newest first. `userId` null: every user's (the instance owner who asked).
   * `projectIds` null: every project; otherwise only those — the projects the
   * caller can see now.
   */
  listTasks(options: { userId: string | null; projectId: string | null; projectIds: readonly string[] | null; open: boolean; before: string | null; limit: number }): TaskRow[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (options.userId !== null) {
      clauses.push('user_id = ?');
      params.push(options.userId);
    }
    if (options.projectId !== null) {
      clauses.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.projectIds !== null) {
      // The number of ids varies from call to call, so the list travels as one JSON value.
      clauses.push('project_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(options.projectIds));
    }
    if (options.open) clauses.push("state IN ('running', 'needs-attention')");
    if (options.before !== null) {
      clauses.push('id < ?');
      params.push(options.before);
    }
    return this.#db.all<TaskRow>(`SELECT * FROM collab_tasks ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, options.limit);
  }

  updateTask(id: string, patch: { state: TaskState; stoppedAt?: number | null; finishedAt: number | null }, now: number): void {
    if (patch.stoppedAt === undefined) {
      this.#db.run('UPDATE collab_tasks SET state = ?, finished_at = ?, updated_at = ? WHERE id = ?', patch.state, patch.finishedAt, now, id);
    } else {
      this.#db.run('UPDATE collab_tasks SET state = ?, stopped_at = ?, finished_at = ?, updated_at = ? WHERE id = ?', patch.state, patch.stoppedAt, patch.finishedAt, now, id);
    }
  }

  touchTask(id: string, now: number): void {
    this.#db.run('UPDATE collab_tasks SET updated_at = ? WHERE id = ?', now, id);
  }

  deleteTask(id: string): void {
    this.#db.run('DELETE FROM collab_tasks WHERE id = ?', id);
  }

  // ---- participants ------------------------------------------------------------

  /** Participants first, in order; the synthesis (position 0) last. */
  participants(taskId: string): ParticipantRow[] {
    return this.#db.all<ParticipantRow>('SELECT * FROM collab_task_participants WHERE task_id = ? ORDER BY position = 0, position', taskId);
  }

  participant(taskId: string, position: number): ParticipantRow | undefined {
    return this.#db.get<ParticipantRow>('SELECT * FROM collab_task_participants WHERE task_id = ? AND position = ?', taskId, position);
  }

  /** The participant whose session this is, if it is one. A session belongs to at most one task. */
  participantBySession(sessionId: string): ParticipantRow | undefined {
    return this.#db.get<ParticipantRow>('SELECT * FROM collab_task_participants WHERE session_id = ?', sessionId);
  }

  updateParticipant(taskId: string, position: number, patch: ParticipantPatch): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${PARTICIPANT_COLUMNS[key as keyof typeof PARTICIPANT_COLUMNS]} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return;
    this.#db.run(`UPDATE collab_task_participants SET ${sets.join(', ')} WHERE task_id = ? AND position = ?`, ...params, taskId, position);
  }

  /** Moves a participant on only if it is still in one of the `from` states. True for the one caller that did. */
  claimParticipant(taskId: string, position: number, from: readonly string[], to: string): boolean {
    return (
      this.#db.run(
        `UPDATE collab_task_participants SET state = ? WHERE task_id = ? AND position = ? AND state IN (SELECT value FROM json_each(?))`,
        to,
        taskId,
        position,
        JSON.stringify(from),
      ).changes === 1
    );
  }

  /** Answers of sessions that no longer exist are not kept. */
  forgetOrphanedAnswers(taskId: string): void {
    this.#db.run('UPDATE collab_task_participants SET answer = NULL WHERE task_id = ? AND session_id IS NULL AND answer IS NOT NULL', taskId);
  }
}
