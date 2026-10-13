import type { AutomationOutcome, AutomationReason, DeferredReason } from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import type { Database, SqlValue } from '../../kernel/database.js';
import type { OverduePlan } from './schedule.js';

export interface AutomationRow {
  id: string;
  project_id: string;
  created_by: string;
  name: string;
  enabled: number;
  time_zone: string;
  trigger: string;
  action: string;
  event: string | null;
  next_run_at: number | null;
  disabled_reason: 'ran-once' | 'access-lost' | null;
  created_at: number;
  updated_at: number;
}

export interface ExecutionRow {
  id: string;
  automation_id: string;
  trigger: 'schedule' | 'manual' | 'event';
  scheduled_for: number | null;
  started_at: number;
  ended_at: number | null;
  outcome: AutomationOutcome;
  reason: AutomationReason | null;
  summary: string;
  session_id: string | null;
  run_id: string | null;
  denied_count: number;
}

export type DeferredInternalState = 'pending' | 'sending' | 'queued' | 'running' | 'sent' | 'failed' | 'cancelled';

export interface DeferredRow {
  id: string;
  user_id: string;
  session_id: string;
  project_id: string | null;
  text: string;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  send_at: number;
  state: DeferredInternalState;
  reason: DeferredReason | null;
  detail: string | null;
  run_id: string | null;
  dismissed_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * What became of an attempt to claim a due automation.
 *
 * `run`      the occurrence is this caller's to execute: `execution` is open and nobody else can get it
 * `skipped`  recorded as skipped: its previous execution is still going
 * `missed`   recorded as missed: it came due too long ago
 * `nothing`  there was nothing to claim — somebody else has it, or it is no longer due
 */
export type Claim =
  | { readonly kind: 'run'; readonly automation: AutomationRow; readonly execution: ExecutionRow }
  | { readonly kind: 'skipped' | 'missed'; readonly automation: AutomationRow; readonly execution: ExecutionRow }
  | { readonly kind: 'nothing' };

/** The sentences a claim records, supplied by the caller so that this file stays free of wording. */
export interface ClaimTexts {
  missed(plan: OverduePlan): string;
  earlierMissed(plan: OverduePlan, dueAt: number): string;
  stillRunning(): string;
}

/** Everything of an execution but its internal sequence number. */
const EXECUTION_FIELDS = 'id, automation_id, trigger, scheduled_for, started_at, ended_at, outcome, reason, summary, session_id, run_id, denied_count';

const AUTOMATION_COLUMNS = {
  name: 'name',
  enabled: 'enabled',
  timeZone: 'time_zone',
  trigger: 'trigger',
  action: 'action',
  event: 'event',
  nextRunAt: 'next_run_at',
  disabledReason: 'disabled_reason',
} as const;
export type AutomationPatch = Partial<Record<keyof typeof AUTOMATION_COLUMNS, SqlValue>>;

const DEFERRED_COLUMNS = { state: 'state', reason: 'reason', detail: 'detail', runId: 'run_id', dismissedAt: 'dismissed_at' } as const;
export type DeferredPatch = Partial<Record<keyof typeof DEFERRED_COLUMNS, SqlValue>>;

/**
 * All SQL of the automation module. The two guarantees the scheduler rests
 * on are made here, by the database rather than by care:
 *
 * - **An occurrence is claimed exactly once.** {@link claimDue} moves the
 *   automation's next run and records the execution in one transaction, and
 *   only if the automation is still due at the instant it read. Two ticks, two
 *   processes, or a tick after a crash find nothing left to claim. A unique
 *   index on (automation, occurrence) makes a second record impossible.
 * - **An automation never overlaps itself.** A unique index allows one open
 *   execution per automation; a claim that finds one records "skipped".
 */
export class AutomationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  // ---- automations -----------------------------------------------------------

  insert(row: AutomationRow): void {
    this.#db.run(
      `INSERT INTO automations (id, project_id, created_by, name, enabled, time_zone, trigger, action, event, next_run_at, disabled_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.project_id,
      row.created_by,
      row.name,
      row.enabled,
      row.time_zone,
      row.trigger,
      row.action,
      row.event,
      row.next_run_at,
      row.disabled_reason,
      row.created_at,
      row.updated_at,
    );
  }

  /** An automation of one project. The project is part of the question, so an id from elsewhere finds nothing. */
  find(projectId: string, id: string): AutomationRow | undefined {
    return this.#db.get<AutomationRow>('SELECT * FROM automations WHERE id = ? AND project_id = ?', id, projectId);
  }

  /** For the scheduler, which works from ids it read itself. */
  byId(id: string): AutomationRow | undefined {
    return this.#db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', id);
  }

  ofProject(projectId: string): AutomationRow[] {
    return this.#db.all<AutomationRow>('SELECT * FROM automations WHERE project_id = ? ORDER BY created_at, id', projectId);
  }

  countOfProject(projectId: string): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM automations WHERE project_id = ?', projectId)!.n;
  }

  update(id: string, patch: AutomationPatch, now: number): void {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [now];
    for (const [key, column] of Object.entries(AUTOMATION_COLUMNS)) {
      const value = patch[key as keyof AutomationPatch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    this.#db.run(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  remove(id: string): boolean {
    return this.#db.run('DELETE FROM automations WHERE id = ?', id).changes > 0;
  }

  /** Enabled automations whose time has come, the most overdue first. */
  due(now: number, limit: number): string[] {
    return this.#db
      .all<{ id: string }>('SELECT id FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?', now, limit)
      .map((row) => row.id);
  }

  /** Enabled automations of a project that wait for an event. */
  waitingFor(projectId: string, event: string): AutomationRow[] {
    return this.#db.all<AutomationRow>('SELECT * FROM automations WHERE project_id = ? AND event = ? AND enabled = 1 ORDER BY created_at, id', projectId, event);
  }

  /** Switches off everything one person created in one project. Returns what was switched off. */
  disableOfCreator(projectId: string, userId: string, reason: 'access-lost', now: number): AutomationRow[] {
    return this.#db.transaction(() => {
      const rows = this.#db.all<AutomationRow>('SELECT * FROM automations WHERE project_id = ? AND created_by = ? AND enabled = 1', projectId, userId);
      this.#db.run(
        'UPDATE automations SET enabled = 0, next_run_at = NULL, disabled_reason = ?, updated_at = ? WHERE project_id = ? AND created_by = ? AND enabled = 1',
        reason,
        now,
        projectId,
        userId,
      );
      return rows;
    });
  }

  // ---- claiming ----------------------------------------------------------------

  #insertExecution(row: ExecutionRow): ExecutionRow {
    this.#db.run(
      `INSERT INTO automation_executions (id, automation_id, trigger, scheduled_for, started_at, ended_at, outcome, reason, summary, session_id, run_id, denied_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.automation_id,
      row.trigger,
      row.scheduled_for,
      row.started_at,
      row.ended_at,
      row.outcome,
      row.reason,
      row.summary,
      row.session_id,
      row.run_id,
      row.denied_count,
    );
    return row;
  }

  #execution(automationId: string, trigger: ExecutionRow['trigger'], scheduledFor: number | null, now: number, ended: { outcome: AutomationOutcome; reason: AutomationReason; summary: string } | null): ExecutionRow {
    return {
      id: newId(),
      automation_id: automationId,
      trigger,
      scheduled_for: scheduledFor,
      started_at: now,
      ended_at: ended ? now : null,
      outcome: ended?.outcome ?? 'started',
      reason: ended?.reason ?? null,
      summary: ended?.summary ?? '',
      session_id: null,
      run_id: null,
      denied_count: 0,
    };
  }

  #recorded(automationId: string, scheduledFor: number): boolean {
    return this.#db.get('SELECT 1 AS x FROM automation_executions WHERE automation_id = ? AND scheduled_for = ?', automationId, scheduledFor) !== undefined;
  }

  openOf(automationId: string): ExecutionRow | undefined {
    return this.#db.get<ExecutionRow>(`SELECT ${EXECUTION_FIELDS} FROM automation_executions WHERE automation_id = ? AND ended_at IS NULL`, automationId);
  }

  /**
   * Claims a due automation. In one transaction: the schedule moves on (a
   * one-off switches itself off), and what happens to the occurrence is
   * recorded — an open execution for the caller to carry out, or "skipped",
   * or "missed". After this returns `run`, executing is the caller's duty and
   * nobody else's; if the process dies first, the open execution is what the
   * next start finds and closes as interrupted. Nothing is ever run from it again.
   */
  claimDue(automationId: string, now: number, planFor: (row: AutomationRow) => OverduePlan, texts: ClaimTexts): Claim {
    return this.#db.transaction((): Claim => {
      const row = this.#db.get<AutomationRow>('SELECT * FROM automations WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', automationId, now);
      if (!row) return { kind: 'nothing' };
      const dueAt = row.next_run_at!;
      const plan = planFor(row);
      const oneOff = plan.next === null;
      const moved = this.#db.run(
        `UPDATE automations SET next_run_at = ?, enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END, disabled_reason = CASE WHEN ? = 1 THEN 'ran-once' ELSE disabled_reason END
         WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
        plan.next,
        oneOff ? 1 : 0,
        oneOff ? 1 : 0,
        automationId,
        dueAt,
      ).changes;
      if (moved !== 1) return { kind: 'nothing' };
      const automation: AutomationRow = { ...row, next_run_at: plan.next, enabled: oneOff ? 0 : row.enabled, disabled_reason: oneOff ? 'ran-once' : row.disabled_reason };

      // An occurrence that already has a record is never recorded — or run — a second time.
      if (this.#recorded(automationId, plan.scheduledFor)) return { kind: 'nothing' };
      if (plan.action === 'missed') {
        return { kind: 'missed', automation, execution: this.#insertExecution(this.#execution(automationId, 'schedule', plan.scheduledFor, now, { outcome: 'missed', reason: 'server-down', summary: texts.missed(plan) })) };
      }
      if (plan.earlierMissed > 0 && plan.scheduledFor !== dueAt && !this.#recorded(automationId, dueAt)) {
        this.#insertExecution(this.#execution(automationId, 'schedule', dueAt, now, { outcome: 'missed', reason: 'server-down', summary: texts.earlierMissed(plan, dueAt) }));
      }
      if (this.openOf(automationId)) {
        return { kind: 'skipped', automation, execution: this.#insertExecution(this.#execution(automationId, 'schedule', plan.scheduledFor, now, { outcome: 'skipped', reason: 'still-running', summary: texts.stillRunning() })) };
      }
      return { kind: 'run', automation, execution: this.#insertExecution(this.#execution(automationId, 'schedule', plan.scheduledFor, now, null)) };
    });
  }

  /**
   * Opens an execution that is not an occurrence of the schedule ("run now",
   * an event). Null when one is already open: the automation is busy.
   */
  claimNow(automationId: string, trigger: 'manual' | 'event', now: number): ExecutionRow | null {
    return this.#db.transaction(() => {
      if (!this.byId(automationId) || this.openOf(automationId)) return null;
      return this.#insertExecution(this.#execution(automationId, trigger, null, now, null));
    });
  }

  /** Records that an event came while the automation was still busy with the previous one. */
  recordSkipped(automationId: string, trigger: 'event', now: number, summary: string): ExecutionRow {
    return this.#insertExecution(this.#execution(automationId, trigger, null, now, { outcome: 'skipped', reason: 'still-running', summary }));
  }

  // ---- executions ----------------------------------------------------------------

  execution(id: string): ExecutionRow | undefined {
    return this.#db.get<ExecutionRow>(`SELECT ${EXECUTION_FIELDS} FROM automation_executions WHERE id = ?`, id);
  }

  /** Notes the session and run an execution started. It stays open until that run ends. */
  attachRun(id: string, sessionId: string, runId: string | null, summary: string): void {
    this.#db.run('UPDATE automation_executions SET session_id = ?, run_id = ?, summary = ? WHERE id = ? AND ended_at IS NULL', sessionId, runId, summary, id);
  }

  /** Closes an execution: once. False when it was closed already. */
  finish(id: string, result: { outcome: AutomationOutcome; reason: AutomationReason | null; summary: string; endedAt: number }): boolean {
    return (
      this.#db.run(
        'UPDATE automation_executions SET ended_at = ?, outcome = ?, reason = ?, summary = ? WHERE id = ? AND ended_at IS NULL',
        result.endedAt,
        result.outcome,
        result.reason,
        result.summary,
        id,
      ).changes === 1
    );
  }

  openByRun(runId: string): ExecutionRow | undefined {
    return this.#db.get<ExecutionRow>(`SELECT ${EXECUTION_FIELDS} FROM automation_executions WHERE run_id = ? AND ended_at IS NULL`, runId);
  }

  /** One more request of an execution's run was denied because nobody was there to approve it. */
  countDenied(runId: string): void {
    this.#db.run('UPDATE automation_executions SET denied_count = denied_count + 1 WHERE run_id = ? AND ended_at IS NULL', runId);
  }

  openExecutions(): ExecutionRow[] {
    return this.#db.all<ExecutionRow>(`SELECT ${EXECUTION_FIELDS} FROM automation_executions WHERE ended_at IS NULL ORDER BY seq`);
  }

  latest(automationId: string): ExecutionRow | undefined {
    return this.#db.get<ExecutionRow>(`SELECT ${EXECUTION_FIELDS} FROM automation_executions WHERE automation_id = ? ORDER BY seq DESC LIMIT 1`, automationId);
  }

  /** Newest first, in the order they were recorded. `before` is the id of the oldest execution already seen. */
  history(automationId: string, limit: number, before?: string): ExecutionRow[] {
    return this.#db.all<ExecutionRow>(
      `SELECT ${EXECUTION_FIELDS} FROM automation_executions
       WHERE automation_id = ? AND (? IS NULL OR seq < (SELECT seq FROM automation_executions WHERE id = ? AND automation_id = ?))
       ORDER BY seq DESC LIMIT ?`,
      automationId,
      before ?? null,
      before ?? null,
      automationId,
      limit,
    );
  }

  /** Keeps the newest `keep` executions of an automation (an open one is never removed). */
  pruneHistory(automationId: string, keep: number): number {
    return this.#db.run(
      `DELETE FROM automation_executions WHERE automation_id = ? AND ended_at IS NOT NULL AND seq NOT IN (
         SELECT seq FROM automation_executions WHERE automation_id = ? ORDER BY seq DESC LIMIT ?
       )`,
      automationId,
      automationId,
      keep,
    ).changes;
  }

  // ---- deferred messages ---------------------------------------------------------

  insertDeferred(row: DeferredRow): void {
    this.#db.run(
      `INSERT INTO deferred_messages (id, user_id, session_id, project_id, text, model, effort, permission_mode, send_at, state, reason, detail, run_id, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.user_id,
      row.session_id,
      row.project_id,
      row.text,
      row.model,
      row.effort,
      row.permission_mode,
      row.send_at,
      row.state,
      row.reason,
      row.detail,
      row.run_id,
      row.dismissed_at,
      row.created_at,
      row.updated_at,
    );
  }

  /** One of a user's own deferred messages; anybody else's does not exist for them. */
  deferredOf(userId: string, id: string): DeferredRow | undefined {
    return this.#db.get<DeferredRow>('SELECT * FROM deferred_messages WHERE id = ? AND user_id = ?', id, userId);
  }

  deferred(id: string): DeferredRow | undefined {
    return this.#db.get<DeferredRow>('SELECT * FROM deferred_messages WHERE id = ?', id);
  }

  listDeferred(options: { userId: string; sessionId?: string; projectId?: string; states?: readonly DeferredInternalState[]; includeDismissed: boolean; limit: number }): DeferredRow[] {
    const clauses = ['user_id = ?'];
    const params: SqlValue[] = [options.userId];
    if (options.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.states !== undefined) {
      clauses.push(`state IN (${options.states.map(() => '?').join(', ')})`);
      params.push(...options.states);
    }
    if (!options.includeDismissed) clauses.push('dismissed_at IS NULL');
    return this.#db.all<DeferredRow>(`SELECT * FROM deferred_messages WHERE ${clauses.join(' AND ')} ORDER BY send_at, id LIMIT ?`, ...params, options.limit);
  }

  countPendingDeferred(userId: string): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deferred_messages WHERE user_id = ? AND state = 'pending'", userId)!.n;
  }

  dueDeferred(now: number, limit: number): string[] {
    return this.#db.all<{ id: string }>("SELECT id FROM deferred_messages WHERE state = 'pending' AND send_at <= ? ORDER BY send_at, id LIMIT ?", now, limit).map((row) => row.id);
  }

  deferredIn(states: readonly DeferredInternalState[]): DeferredRow[] {
    return this.#db.all<DeferredRow>(`SELECT * FROM deferred_messages WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY send_at, id`, ...states);
  }

  deferredByRun(runId: string): DeferredRow | undefined {
    return this.#db.get<DeferredRow>("SELECT * FROM deferred_messages WHERE run_id = ? AND state = 'running'", runId);
  }

  queuedDeferredOfSession(sessionId: string): DeferredRow[] {
    return this.#db.all<DeferredRow>("SELECT * FROM deferred_messages WHERE session_id = ? AND state = 'queued' ORDER BY send_at, id", sessionId);
  }

  /**
   * Moves a deferred message from one of the states in `from` to what the
   * patch says — and only from there. This is the claim (pending → sending):
   * of two attempts, one finds the row no longer pending and gets false.
   */
  moveDeferred(id: string, from: readonly DeferredInternalState[], patch: DeferredPatch, now: number): boolean {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [now];
    for (const [key, column] of Object.entries(DEFERRED_COLUMNS)) {
      const value = patch[key as keyof DeferredPatch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    return this.#db.run(`UPDATE deferred_messages SET ${sets.join(', ')} WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`, ...params, id, ...from).changes === 1;
  }

  /** Keeps a user's finished deferred messages from piling up: the newest `keep` stay. */
  pruneDeferred(userId: string, keep: number): number {
    return this.#db.run(
      `DELETE FROM deferred_messages WHERE user_id = ? AND state IN ('sent', 'failed', 'cancelled') AND id NOT IN (
         SELECT id FROM deferred_messages WHERE user_id = ? AND state IN ('sent', 'failed', 'cancelled') ORDER BY updated_at DESC, id DESC LIMIT ?
       )`,
      userId,
      userId,
      keep,
    ).changes;
  }
}
