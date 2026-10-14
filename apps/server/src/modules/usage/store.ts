import type { BudgetMetric } from '@agent-studio/protocol';
import type { Database, Migration, SqlValue } from '../../kernel/database.js';

/**
 * All SQL of the usage module.
 *
 * What was used is read from `agent_usage`, the table the agent runtime
 * documents as "the table a usage report aggregates" (one row per run and
 * model). Nothing here writes to it. The module's own tables hold what it is
 * the source of: the newest plan-window reading per user and agent, the
 * amount a user noted for a provider, and budgets.
 *
 * Every read that serves a client takes the user it is for and filters on it
 * in the query itself.
 */
export const USAGE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'plan-window readings, provider notes, budgets',
    sql: `
      -- The newest report of an agent's own program about its account's limits, per user whose run
      -- observed it. "info" is the normalised reading (see quota.ts), never the program's raw answer.
      CREATE TABLE usage_quota_readings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        info TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_id)
      ) WITHOUT ROWID;

      -- "I had this much on that day": spend is counted from noted_at.
      CREATE TABLE usage_provider_notes (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        noted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, provider_id)
      ) WITHOUT ROWID;

      -- A user's own monthly mark. agent_id null: everything the user runs.
      CREATE TABLE usage_budgets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id TEXT,
        metric TEXT NOT NULL CHECK (metric IN ('tokens', 'cost')),
        amount REAL NOT NULL CHECK (amount > 0),
        time_zone TEXT NOT NULL,
        -- The month (YYYY-MM in time_zone) and the highest threshold already announced for it.
        announced_month TEXT,
        announced_threshold INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX usage_budgets_one ON usage_budgets(user_id, COALESCE(agent_id, ''), metric);
    `,
  },
];

/** Which usage records a figure is made of. `null` means "any". */
export interface UsageFilter {
  /** `[start, end)` in milliseconds. */
  readonly start: number;
  readonly end: number;
  readonly userId: string | null;
  readonly projectId: string | null;
  readonly agentId: string | null;
}

export interface FiguresRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Null when no row in the group has a cost. */
  cost: number | null;
  runs: number;
  sessions: number;
  /** Runs with at least one row that has no cost. */
  unpriced: number;
  last_at: number | null;
}

export interface QuotaRow {
  user_id: string;
  agent_id: string;
  observed_at: number;
  info: string;
}

export interface NoteRow {
  user_id: string;
  provider_id: string;
  amount: number;
  currency: string;
  noted_at: number;
  updated_at: number;
}

export interface BudgetRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  metric: BudgetMetric;
  amount: number;
  time_zone: string;
  announced_month: string | null;
  announced_threshold: number;
  created_at: number;
  updated_at: number;
}

const FIGURES = `
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
  SUM(cost_usd) AS cost,
  COUNT(DISTINCT run_id) AS runs,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(DISTINCT CASE WHEN cost_usd IS NULL THEN run_id END) AS unpriced,
  MAX(at) AS last_at`;

export class UsageStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  transaction<T>(work: () => T): T {
    return this.#db.transaction(work);
  }

  // ---- what was used (read-only over the runtime's records) --------------------

  /** The same few statement texts whatever the values: only which filters are present varies. */
  #where(filter: UsageFilter): { sql: string; params: SqlValue[] } {
    const clauses = ['at >= ?', 'at < ?'];
    const params: SqlValue[] = [filter.start, filter.end];
    if (filter.userId !== null) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.projectId !== null) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.agentId !== null) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }
    return { sql: clauses.join(' AND '), params };
  }

  figures(filter: UsageFilter): FiguresRow {
    const where = this.#where(filter);
    return this.#db.get<FiguresRow>(`SELECT ${FIGURES} FROM agent_usage WHERE ${where.sql}`, ...where.params)!;
  }

  byAgent(filter: UsageFilter): Array<FiguresRow & { agent_id: string }> {
    const where = this.#where(filter);
    return this.#db.all(`SELECT agent_id, ${FIGURES} FROM agent_usage WHERE ${where.sql} GROUP BY agent_id`, ...where.params);
  }

  byModel(filter: UsageFilter): Array<FiguresRow & { agent_id: string; model: string }> {
    const where = this.#where(filter);
    return this.#db.all(`SELECT agent_id, model, ${FIGURES} FROM agent_usage WHERE ${where.sql} GROUP BY agent_id, model`, ...where.params);
  }

  byProject(filter: UsageFilter): Array<FiguresRow & { project_id: string | null }> {
    const where = this.#where(filter);
    return this.#db.all(`SELECT project_id, ${FIGURES} FROM agent_usage WHERE ${where.sql} GROUP BY project_id`, ...where.params);
  }

  byUser(filter: UsageFilter): Array<FiguresRow & { user_id: string }> {
    const where = this.#where(filter);
    return this.#db.all(`SELECT user_id, ${FIGURES} FROM agent_usage WHERE ${where.sql} GROUP BY user_id`, ...where.params);
  }

  /**
   * Everything but the named (agent, model) pairs, counted in one go: a run
   * may use several models, so the groups of `byModel` cannot simply be added up.
   */
  figuresExceptModels(filter: UsageFilter, pairs: ReadonlyArray<readonly [agentId: string, model: string]>): FiguresRow {
    const where = this.#where(filter);
    // The number of pairs varies from call to call, so the list travels as one JSON value.
    return this.#db.get<FiguresRow>(
      `SELECT ${FIGURES} FROM agent_usage
       WHERE ${where.sql} AND NOT EXISTS (
         SELECT 1 FROM json_each(?) pair
         WHERE json_extract(pair.value, '$[0]') = agent_usage.agent_id AND json_extract(pair.value, '$[1]') = agent_usage.model
       )`,
      ...where.params,
      JSON.stringify(pairs),
    )!;
  }

  // ---- plan-window readings ----------------------------------------------------

  quota(userId: string, agentId: string): QuotaRow | undefined {
    return this.#db.get<QuotaRow>('SELECT * FROM usage_quota_readings WHERE user_id = ? AND agent_id = ?', userId, agentId);
  }

  quotasOf(userId: string): QuotaRow[] {
    return this.#db.all<QuotaRow>('SELECT * FROM usage_quota_readings WHERE user_id = ? ORDER BY agent_id', userId);
  }

  /** Keeps a reading unless a newer one is already stored. False when it was older. */
  saveQuota(row: QuotaRow): boolean {
    return (
      this.#db.run(
        `INSERT INTO usage_quota_readings (user_id, agent_id, observed_at, info) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, agent_id) DO UPDATE SET observed_at = excluded.observed_at, info = excluded.info
         WHERE excluded.observed_at >= usage_quota_readings.observed_at`,
        row.user_id,
        row.agent_id,
        row.observed_at,
        row.info,
      ).changes === 1
    );
  }

  // ---- provider notes ----------------------------------------------------------

  note(userId: string, providerId: string): NoteRow | undefined {
    return this.#db.get<NoteRow>('SELECT * FROM usage_provider_notes WHERE user_id = ? AND provider_id = ?', userId, providerId);
  }

  saveNote(row: NoteRow): void {
    this.#db.run(
      `INSERT INTO usage_provider_notes (user_id, provider_id, amount, currency, noted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency,
         noted_at = excluded.noted_at, updated_at = excluded.updated_at`,
      row.user_id,
      row.provider_id,
      row.amount,
      row.currency,
      row.noted_at,
      row.updated_at,
    );
  }

  deleteNote(userId: string, providerId: string): boolean {
    return this.#db.run('DELETE FROM usage_provider_notes WHERE user_id = ? AND provider_id = ?', userId, providerId).changes === 1;
  }

  // ---- budgets -----------------------------------------------------------------

  budgetsOf(userId: string): BudgetRow[] {
    return this.#db.all<BudgetRow>('SELECT * FROM usage_budgets WHERE user_id = ? ORDER BY created_at, rowid', userId);
  }

  /** The caller's own budget, or nothing: somebody else's id answers like one that does not exist. */
  budget(userId: string, id: string): BudgetRow | undefined {
    return this.#db.get<BudgetRow>('SELECT * FROM usage_budgets WHERE id = ? AND user_id = ?', id, userId);
  }

  findBudget(userId: string, agentId: string | null, metric: BudgetMetric): BudgetRow | undefined {
    return this.#db.get<BudgetRow>(
      "SELECT * FROM usage_budgets WHERE user_id = ? AND COALESCE(agent_id, '') = ? AND metric = ?",
      userId,
      agentId ?? '',
      metric,
    );
  }

  countBudgets(userId: string): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage_budgets WHERE user_id = ?', userId)!.n;
  }

  insertBudget(row: BudgetRow): void {
    this.#db.run(
      `INSERT INTO usage_budgets (id, user_id, agent_id, metric, amount, time_zone, announced_month, announced_threshold, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.user_id,
      row.agent_id,
      row.metric,
      row.amount,
      row.time_zone,
      row.announced_month,
      row.announced_threshold,
      row.created_at,
      row.updated_at,
    );
  }

  updateBudget(userId: string, id: string, patch: { amount: number; timeZone: string; announcedMonth: string | null; announcedThreshold: number }, now: number): boolean {
    return (
      this.#db.run(
        'UPDATE usage_budgets SET amount = ?, time_zone = ?, announced_month = ?, announced_threshold = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        patch.amount,
        patch.timeZone,
        patch.announcedMonth,
        patch.announcedThreshold,
        now,
        id,
        userId,
      ).changes === 1
    );
  }

  deleteBudget(userId: string, id: string): boolean {
    return this.#db.run('DELETE FROM usage_budgets WHERE id = ? AND user_id = ?', id, userId).changes === 1;
  }

  /**
   * Records that a threshold is being announced for a month — only if it was
   * not announced before. True for the one caller that gets to announce it.
   */
  claimAnnouncement(id: string, month: string, threshold: number): boolean {
    return (
      this.#db.run(
        `UPDATE usage_budgets SET announced_month = ?, announced_threshold = ?
         WHERE id = ? AND (announced_month IS NOT ? OR announced_threshold < ?)`,
        month,
        threshold,
        id,
        month,
        threshold,
      ).changes === 1
    );
  }
}
