import {
  type AgentQuota,
  BUDGET_THRESHOLD_BUS_EVENT,
  type Budget,
  type BudgetThresholdEvent,
  type CreateBudgetRequest,
  type ProviderNote,
  type ProviderUsage,
  type QuotaResponse,
  type SetProviderNoteRequest,
  USAGE_EVENT,
  USAGE_LIMITS,
  type UpdateBudgetRequest,
  type UsageByAgent,
  type UsageByModel,
  type UsageByProject,
  type UsageByUser,
  type UsageCost,
  type UsageFigures,
  type UsageReport,
  type UsageReportQuery,
  type UsageSummary,
  type UsageSummaryAgent,
  idSchema,
  providerAgentId,
  userTopic,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { newId } from '../../kernel/crypto.js';
import {
  badRequest,
  conflict,
  describeError,
  forbidden,
  notFound,
  unprocessable,
} from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import {
  type AnnouncedThreshold,
  budgetFraction,
  budgetState,
  reachedThreshold,
  thresholdToAnnounce,
} from './budgets.js';
import { RangeTooLong, dayOf, formatDate, monthOf, parseDate, resolveRange } from './buckets.js';
import {
  type StoredQuota,
  fullestWindow,
  mergeQuota,
  normaliseRateLimitInfo,
  parseStoredQuota,
  presentQuota,
} from './quota.js';
import type { BudgetRow, FiguresRow, NoteRow, UsageFilter, UsageStore } from './store.js';

export interface UsageOptions {
  /** The clock. Tests move it by hand. */
  readonly now: () => number;
  /** A plan-window reading older than this is stale. */
  readonly quotaStaleAfterMs: number;
}

/** What `rate-limit.observed` on `internal:usage` carries (see the adapters' module comments). */
const rateLimitObservedSchema = z.object({
  agentId: z.string().min(1).max(80),
  userId: idSchema,
  observedAt: z.number().finite().positive(),
  info: z.unknown(),
});

/** Dollar sums come out of floating-point addition; a millionth of a dollar is all the precision there is. */
const dollars = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export function toCost(row: Pick<FiguresRow, 'cost' | 'runs' | 'unpriced'>): UsageCost {
  const coverage =
    row.runs === 0
      ? 'none'
      : row.cost === null
        ? 'unknown'
        : row.unpriced === 0
          ? 'complete'
          : 'partial';
  return {
    usd: row.cost === null ? null : dollars(row.cost),
    coverage,
    pricedRuns: Math.max(0, row.runs - row.unpriced),
    unpricedRuns: row.unpriced,
  };
}

export function toFigures(row: FiguresRow): UsageFigures {
  return {
    inputTokens: row.input,
    outputTokens: row.output,
    cacheReadTokens: row.cache_read,
    cacheWriteTokens: row.cache_write,
    totalTokens: row.input + row.output + row.cache_read + row.cache_write,
    // The runtime does not record reasoning apart from output.
    reasoningTokens: null,
    cost: toCost(row),
    runs: row.runs,
    sessions: row.sessions,
  };
}

const EMPTY: FiguresRow = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  cost: null,
  runs: 0,
  sessions: 0,
  unpriced: 0,
  last_at: null,
};

/** Adds up groups that share no run and no session (different agents, projects or users). */
function addRows(rows: readonly FiguresRow[]): FiguresRow {
  const sum = { ...EMPTY };
  for (const row of rows) {
    sum.input += row.input;
    sum.output += row.output;
    sum.cache_read += row.cache_read;
    sum.cache_write += row.cache_write;
    if (row.cost !== null) sum.cost = (sum.cost ?? 0) + row.cost;
    sum.runs += row.runs;
    sum.sessions += row.sessions;
    sum.unpriced += row.unpriced;
    if (row.last_at !== null && (sum.last_at === null || row.last_at > sum.last_at))
      sum.last_at = row.last_at;
  }
  return sum;
}

const tokensOf = (row: FiguresRow): number =>
  row.input + row.output + row.cache_read + row.cache_write;

/** 1234 → "1,234"; 1_250_000 → "1.3M". */
function compact(value: number): string {
  if (value < 10_000) return value.toLocaleString('en-US');
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/**
 * Usage: reports over the runtime's records, the newest plan-window reading
 * per user and agent, provider notes and estimates, budgets, and the summary
 * a home-screen tile shows.
 */
export class UsageService {
  readonly #context: ModuleContext;
  readonly #store: UsageStore;
  readonly #options: UsageOptions;

  constructor(context: ModuleContext, store: UsageStore, options: UsageOptions) {
    this.#context = context;
    this.#store = store;
    this.#options = options;
  }

  #agentName(agentId: string): string {
    return this.#context.services.agents.adapter(agentId)?.displayName ?? agentId;
  }

  #toUser(userId: string, type: string, data: unknown): void {
    this.#context.bus.publish(userTopic(userId), type, data);
  }

  // ---- the report --------------------------------------------------------------

  report(user: Principal, query: UsageReportQuery): UsageReport {
    const isOwner = user.role === 'owner';
    if (query.scope === 'all' && !isOwner)
      throw forbidden("Only the owner of this Studio can see everybody's usage.", 'owner_required');
    if (query.userId !== undefined && query.userId !== user.userId && !isOwner) {
      throw forbidden(
        "Only the owner of this Studio can see another person's usage.",
        'owner_required',
      );
    }
    // Whose records: one named user, everybody (the owner who asked), or the caller.
    const userId = query.userId ?? (query.scope === 'all' ? null : user.userId);
    const projects = this.#context.services.projects;
    if (query.projectId !== undefined) projects.requireAccess(user, query.projectId, 'read');

    const now = this.#options.now();
    let range: ReturnType<typeof resolveRange>;
    try {
      range = resolveRange({
        period: query.period,
        from: query.from === undefined ? undefined : parseDate(query.from),
        to: query.to === undefined ? undefined : parseDate(query.to),
        timeZone: query.timeZone,
        now,
      });
    } catch (error) {
      if (error instanceof RangeTooLong)
        throw badRequest(error.message, { max: error.max }, 'range_too_long');
      throw error;
    }
    const start = range.buckets[0]!.start;
    const end = range.buckets[range.buckets.length - 1]!.end;
    const filter: UsageFilter = {
      start,
      end,
      userId,
      projectId: query.projectId ?? null,
      agentId: query.agentId ?? null,
    };

    const totals = this.#store.figures(filter);
    const largestFirst = <T extends FiguresRow>(rows: T[], name: (row: T) => string): T[] =>
      rows.sort(
        (a, b) => tokensOf(b) - tokensOf(a) || b.runs - a.runs || name(a).localeCompare(name(b)),
      );
    const capped = <T extends FiguresRow, R>(
      rows: T[],
      present: (row: T) => R,
      rest: (left: T[]) => FiguresRow,
    ): { rows: R[]; others: (UsageFigures & { count: number }) | null } => {
      const shown = rows.slice(0, USAGE_LIMITS.breakdownRows);
      const left = rows.slice(USAGE_LIMITS.breakdownRows);
      return {
        rows: shown.map(present),
        others: left.length === 0 ? null : { ...toFigures(rest(left)), count: left.length },
      };
    };

    const byAgent = capped(
      largestFirst(this.#store.byAgent(filter), (row) => row.agent_id),
      (row): UsageByAgent => ({
        ...toFigures(row),
        agentId: row.agent_id,
        agentName: this.#agentName(row.agent_id),
      }),
      addRows,
    );

    const models = largestFirst(
      this.#store.byModel(filter),
      (row) => `${row.agent_id}\n${row.model}`,
    );
    const byModel = capped(
      models,
      (row): UsageByModel => ({ ...toFigures(row), agentId: row.agent_id, model: row.model }),
      // A run may use several models, so what the rows leave out is counted again rather than added up.
      () =>
        this.#store.figuresExceptModels(
          filter,
          models.slice(0, USAGE_LIMITS.breakdownRows).map((row) => [row.agent_id, row.model]),
        ),
    );

    // Projects are named only where the caller can see them now; the rest is one row that names none.
    const visible = new Map(
      projects.list(user, { includeArchived: true }).map((project) => [project.id, project.name]),
    );
    const projectRows = this.#store.byProject(filter);
    const named = largestFirst(
      projectRows.filter((row) => row.project_id !== null && visible.has(row.project_id)),
      (row) => visible.get(row.project_id!) ?? '',
    );
    const outside = projectRows.filter((row) => row.project_id === null);
    const unavailable = projectRows.filter(
      (row) => row.project_id !== null && !visible.has(row.project_id),
    );
    const projectList: Array<{
      row: FiguresRow;
      kind: UsageByProject['kind'];
      projectId: string | null;
      projectName: string | null;
    }> = [
      ...named.map((row) => ({
        row,
        kind: 'project' as const,
        projectId: row.project_id,
        projectName: visible.get(row.project_id!) ?? null,
      })),
      ...(outside.length > 0
        ? [{ row: addRows(outside), kind: 'none' as const, projectId: null, projectName: null }]
        : []),
      ...(unavailable.length > 0
        ? [
            {
              row: addRows(unavailable),
              kind: 'unavailable' as const,
              projectId: null,
              projectName: null,
            },
          ]
        : []),
    ];
    const shownProjects = projectList.slice(0, USAGE_LIMITS.breakdownRows);
    const leftProjects = projectList.slice(USAGE_LIMITS.breakdownRows);
    const byProject = {
      rows: shownProjects.map((entry): UsageByProject => ({
        ...toFigures(entry.row),
        kind: entry.kind,
        projectId: entry.projectId,
        projectName: entry.projectName,
      })),
      others:
        leftProjects.length === 0
          ? null
          : {
              ...toFigures(addRows(leftProjects.map((entry) => entry.row))),
              count: leftProjects.length,
            },
    };

    const auth = this.#context.services.auth;
    const byUser =
      query.scope === 'all'
        ? capped(
            largestFirst(this.#store.byUser(filter), (row) => row.user_id),
            (row): UsageByUser => {
              const account = auth.findUser(row.user_id);
              return {
                ...toFigures(row),
                userId: row.user_id,
                username: account?.username ?? null,
                displayName: account?.displayName ?? null,
              };
            },
            addRows,
          )
        : null;

    return {
      period: query.period,
      timeZone: query.timeZone,
      from: formatDate(range.from),
      to: formatDate(range.to),
      start,
      end,
      scope: query.scope,
      userId,
      projectId: query.projectId ?? null,
      agentId: query.agentId ?? null,
      totals: toFigures(totals),
      buckets: range.buckets.map((bucket) => ({
        ...toFigures(this.#store.figures({ ...filter, start: bucket.start, end: bucket.end })),
        key: bucket.key,
        start: bucket.start,
        end: bucket.end,
        current: bucket.current,
      })),
      byAgent,
      byModel,
      byProject,
      byUser,
      lastRecordedAt: totals.last_at,
      sessionUsageUrl: '/api/sessions/:sessionId/usage',
      generatedAt: now,
    };
  }

  // ---- plan windows ------------------------------------------------------------

  #reading(userId: string, agentId: string): { quota: StoredQuota; observedAt: number } | null {
    const row = this.#store.quota(userId, agentId);
    const quota = row ? parseStoredQuota(row.info) : null;
    return row && quota ? { quota, observedAt: row.observed_at } : null;
  }

  #presentQuota(
    userId: string,
    agentId: string,
    reading = this.#reading(userId, agentId),
  ): AgentQuota {
    return presentQuota({
      agentId,
      agentName: this.#agentName(agentId),
      available: this.#context.services.agents.adapter(agentId) !== undefined,
      quota: reading?.quota ?? null,
      observedAt: reading?.observedAt ?? null,
      now: this.#options.now(),
      staleAfterMs: this.#options.quotaStaleAfterMs,
    });
  }

  /**
   * An agent's program reported its limits during a run. The newest reading
   * per user and agent is kept; an event that cannot be read changes nothing.
   */
  observe(raw: unknown): void {
    const parsed = rateLimitObservedSchema.safeParse(raw);
    if (!parsed.success) return;
    const { agentId, userId } = parsed.data;
    const now = this.#options.now();
    // A report cannot come from the future; a clock that is off does not get to postdate it.
    const observedAt = Math.min(Math.round(parsed.data.observedAt), now);
    const next = normaliseRateLimitInfo(parsed.data.info, observedAt);
    if (!next) return;
    try {
      const previous = this.#reading(userId, agentId);
      if (previous && previous.observedAt > observedAt) return;
      const merged = mergeQuota(previous?.quota ?? null, next, observedAt);
      if (
        !this.#store.saveQuota({
          user_id: userId,
          agent_id: agentId,
          observed_at: observedAt,
          info: JSON.stringify(merged),
        })
      )
        return;
    } catch (error) {
      // The account may be gone by the time its last run reports.
      this.#context.log.warn(
        { agent: agentId, err: describeError(error) },
        'a plan-window reading could not be stored',
      );
      return;
    }
    this.#toUser(userId, USAGE_EVENT.quotaChanged, { quota: this.#presentQuota(userId, agentId) });
  }

  quota(user: Principal): QuotaResponse {
    const readings = new Map(this.#store.quotasOf(user.userId).map((row) => [row.agent_id, row]));
    // Agents that run a program of their own may report limits; anything that ever did is listed too.
    const agentIds = new Set(
      this.#context.services.agents
        .adapters()
        .filter((adapter) => adapter.kind === 'cli')
        .map((adapter) => adapter.id),
    );
    for (const agentId of readings.keys()) agentIds.add(agentId);
    return {
      agents: [...agentIds].sort().map((agentId) => this.#presentQuota(user.userId, agentId)),
      checkedAt: this.#options.now(),
    };
  }

  // ---- API providers -----------------------------------------------------------

  #presentNote(row: NoteRow): ProviderNote {
    return {
      amount: row.amount,
      currency: row.currency,
      notedAt: row.noted_at,
      updatedAt: row.updated_at,
    };
  }

  #providerUsage(
    user: Principal,
    provider: { id: string; agentId: string; name: string },
  ): ProviderUsage {
    // The balance belongs to the one key everybody uses, so the owner's estimate counts everybody's runs.
    const everyone = user.role === 'owner';
    const note = this.#store.note(user.userId, provider.id);
    let estimate: ProviderUsage['estimate'] = null;
    if (note) {
      const spent = this.#store.figures({
        start: note.noted_at,
        end: this.#options.now() + 1,
        userId: everyone ? null : user.userId,
        projectId: null,
        agentId: provider.agentId,
      });
      const spentUsd = spent.cost === null ? null : dollars(spent.cost);
      const inDollars = note.currency === 'USD';
      const caveats: string[] = [];
      if (!inDollars)
        caveats.push(
          `The note is in ${note.currency} and spend is estimated in US dollars, so what is left is not calculated.`,
        );
      if (spent.unpriced > 0)
        caveats.push(
          `${spent.unpriced} run${spent.unpriced === 1 ? '' : 's'} since the note ${spent.unpriced === 1 ? 'has' : 'have'} no price, so more was spent than shown.`,
        );
      caveats.push(
        `An estimate from this Studio's own records at list prices${everyone ? '' : ', counting only your own runs'}; the provider's bill is what counts.`,
      );
      estimate = {
        spentUsd,
        runs: spent.runs,
        unpricedRuns: spent.unpriced,
        remaining: inDollars ? dollars(note.amount - (spentUsd ?? 0)) : null,
        caveat: caveats.join(' '),
      };
    }
    return {
      providerId: provider.id,
      agentId: provider.agentId,
      name: provider.name,
      spendScope: everyone ? 'everyone' : 'own',
      note: note ? this.#presentNote(note) : null,
      estimate,
      balance: null,
    };
  }

  #requireProvider(
    user: Principal,
    providerId: string,
  ): { id: string; agentId: string; name: string } {
    const providers = this.#context.services.providers;
    const found = providers?.list(user).find((provider) => provider.id === providerId);
    if (!found) throw notFound('No such provider.', 'provider_not_found');
    return { id: found.id, agentId: providerAgentId(found.id), name: found.name };
  }

  providers(user: Principal): ProviderUsage[] {
    const providers = this.#context.services.providers?.list(user) ?? [];
    return providers.map((provider) =>
      this.#providerUsage(user, {
        id: provider.id,
        agentId: providerAgentId(provider.id),
        name: provider.name,
      }),
    );
  }

  /** One provider, with its balance as the provider reports it — for the owner, whose key reads it. */
  async provider(user: Principal, providerId: string): Promise<ProviderUsage> {
    const provider = this.#requireProvider(user, providerId);
    const usage = this.#providerUsage(user, provider);
    if (user.role !== 'owner') return usage;
    return { ...usage, balance: await this.#context.services.providers.balance(providerId) };
  }

  setNote(user: Principal, providerId: string, body: SetProviderNoteRequest): ProviderUsage {
    const provider = this.#requireProvider(user, providerId);
    const now = this.#options.now();
    const notedAt = body.notedAt ?? now;
    if (notedAt > now + 60_000)
      throw badRequest('The date of a note cannot be in the future.', undefined, 'noted_in_future');
    this.#store.saveNote({
      user_id: user.userId,
      provider_id: provider.id,
      amount: body.amount,
      currency: body.currency,
      noted_at: Math.min(notedAt, now),
      updated_at: now,
    });
    const usage = this.#providerUsage(user, provider);
    this.#toUser(user.userId, USAGE_EVENT.providerNoteChanged, {
      providerId: provider.id,
      note: usage.note,
    });
    return usage;
  }

  /** Clears the note, and with it the estimate. Works for a provider that no longer exists, too. */
  clearNote(user: Principal, providerId: string): void {
    if (this.#store.deleteNote(user.userId, providerId))
      this.#toUser(user.userId, USAGE_EVENT.providerNoteChanged, { providerId, note: null });
  }

  // ---- budgets -----------------------------------------------------------------

  #budgetProgress(
    row: BudgetRow,
    now: number,
  ): { month: ReturnType<typeof monthOf>; used: number; fraction: number; unpricedRuns: number } {
    const month = monthOf(now, row.time_zone);
    const figures = this.#store.figures({
      start: month.start,
      end: month.end,
      userId: row.user_id,
      projectId: null,
      agentId: row.agent_id,
    });
    // Do not round before comparing a user-configured gate, including sub-microdollar amounts.
    const used = row.metric === 'tokens' ? tokensOf(figures) : (figures.cost ?? 0);
    return {
      month,
      used,
      fraction: budgetFraction(used, row.amount),
      unpricedRuns: row.metric === 'cost' ? figures.unpriced : 0,
    };
  }

  #presentBudget(row: BudgetRow, now = this.#options.now()): Budget {
    const progress = this.#budgetProgress(row, now);
    const announced = row.announced_month === progress.month.key ? row.announced_threshold : 0;
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_id === null ? null : this.#agentName(row.agent_id),
      metric: row.metric,
      amount: row.amount,
      enforce: row.enforce === 1,
      timeZone: row.time_zone,
      month: progress.month.key,
      monthStart: progress.month.start,
      monthEnd: progress.month.end,
      used: progress.used,
      fraction: progress.fraction,
      state: budgetState(progress.fraction),
      unpricedRuns: progress.unpricedRuns,
      announcedThreshold: announced === 100 ? 100 : announced === 80 ? 80 : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  budgets(user: Principal): Budget[] {
    const now = this.#options.now();
    return this.#store.budgetsOf(user.userId).map((row) => this.#presentBudget(row, now));
  }

  /**
   * Runtime/provider boundary: call with the trusted request owner's identity
   * before accepting a run and before starting each model request. Recorded
   * usage only: concurrent/inflight work and unknown costs are not reserved.
   */
  assertRequestAllowed(userId: string, agentId: string): void {
    const now = this.#options.now();
    for (const row of this.#store.budgetsOf(userId)) {
      if (row.enforce !== 1 || (row.agent_id !== null && row.agent_id !== agentId)) continue;
      if (this.#budgetProgress(row, now).used >= row.amount) {
        throw forbidden(
          'Your recorded monthly usage has reached an enabled request limit. Review your budgets in Usage before starting another request.',
          'budget_exhausted',
        );
      }
    }
  }

  /**
   * A new or changed amount starts from where usage stands: what is already
   * past a threshold is not announced — the person has just looked at it.
   */
  #standing(row: BudgetRow, now: number): { month: string; threshold: AnnouncedThreshold } {
    const progress = this.#budgetProgress(row, now);
    return { month: progress.month.key, threshold: reachedThreshold(progress.fraction) };
  }

  createBudget(user: Principal, body: CreateBudgetRequest): Budget {
    if (body.agentId !== null && !this.#context.services.agents.adapter(body.agentId)) {
      throw unprocessable('That agent is not available on this Studio.', 'agent_unavailable');
    }
    if (this.#store.findBudget(user.userId, body.agentId, body.metric)) {
      throw conflict('There is already a budget for that. Change it instead.', 'budget_exists');
    }
    if (this.#store.countBudgets(user.userId) >= USAGE_LIMITS.budgetsPerUser) {
      throw conflict(
        `An account can have at most ${USAGE_LIMITS.budgetsPerUser} budgets.`,
        'too_many_budgets',
      );
    }
    const now = this.#options.now();
    const row: BudgetRow = {
      id: newId(),
      user_id: user.userId,
      agent_id: body.agentId,
      metric: body.metric,
      amount: body.amount,
      time_zone: body.timeZone,
      enforce: body.enforce ? 1 : 0,
      announced_month: null,
      announced_threshold: 0,
      created_at: now,
      updated_at: now,
    };
    const standing = this.#standing(row, now);
    row.announced_month = standing.month;
    row.announced_threshold = standing.threshold;
    this.#store.insertBudget(row);
    const budget = this.#presentBudget(row, now);
    this.#toUser(user.userId, USAGE_EVENT.budgetChanged, {
      budgetId: row.id,
      change: 'created',
      budget,
      threshold: null,
    });
    return budget;
  }

  #requireBudget(user: Principal, budgetId: string): BudgetRow {
    const row = this.#store.budget(user.userId, budgetId);
    if (!row) throw notFound('No such budget.', 'budget_not_found');
    return row;
  }

  updateBudget(user: Principal, budgetId: string, body: UpdateBudgetRequest): Budget {
    const row = this.#requireBudget(user, budgetId);
    const now = this.#options.now();
    const next: BudgetRow = {
      ...row,
      amount: body.amount ?? row.amount,
      time_zone: body.timeZone ?? row.time_zone,
      enforce: body.enforce === undefined ? row.enforce : body.enforce ? 1 : 0,
      updated_at: now,
    };
    const standing = this.#standing(next, now);
    next.announced_month = standing.month;
    next.announced_threshold = standing.threshold;
    this.#store.updateBudget(
      user.userId,
      budgetId,
      {
        amount: next.amount,
        timeZone: next.time_zone,
        enforce: next.enforce,
        announcedMonth: next.announced_month,
        announcedThreshold: next.announced_threshold,
      },
      now,
    );
    const budget = this.#presentBudget(next, now);
    this.#toUser(user.userId, USAGE_EVENT.budgetChanged, {
      budgetId,
      change: 'updated',
      budget,
      threshold: null,
    });
    return budget;
  }

  deleteBudget(user: Principal, budgetId: string): void {
    this.#requireBudget(user, budgetId);
    this.#store.deleteBudget(user.userId, budgetId);
    this.#toUser(user.userId, USAGE_EVENT.budgetChanged, {
      budgetId,
      change: 'removed',
      budget: null,
      threshold: null,
    });
  }

  /**
   * Looks at one user's budgets after their usage changed and announces a
   * threshold that has just been reached: once on `internal:usage` for
   * whatever notifies, once on the user's own topic. Request gating is separate.
   */
  checkBudgets(userId: string): void {
    const now = this.#options.now();
    for (const row of this.#store.budgetsOf(userId)) {
      const progress = this.#budgetProgress(row, now);
      const threshold = thresholdToAnnounce({
        fraction: progress.fraction,
        month: progress.month.key,
        announcedMonth: row.announced_month,
        announcedThreshold:
          row.announced_threshold === 100 ? 100 : row.announced_threshold === 80 ? 80 : 0,
      });
      // The claim is what makes it once: whoever records the announcement first is the one to make it.
      if (
        threshold === null ||
        !this.#store.claimAnnouncement(row.id, progress.month.key, threshold)
      )
        continue;
      const event: BudgetThresholdEvent = {
        budgetId: row.id,
        userId,
        agentId: row.agent_id,
        metric: row.metric,
        amount: row.amount,
        used: progress.used,
        fraction: progress.fraction,
        threshold,
        month: progress.month.key,
        timeZone: row.time_zone,
        at: now,
      };
      this.#context.bus.publish('internal:usage', BUDGET_THRESHOLD_BUS_EVENT, event);
      const budget = this.#presentBudget(
        { ...row, announced_month: progress.month.key, announced_threshold: threshold },
        now,
      );
      this.#toUser(userId, USAGE_EVENT.budgetChanged, {
        budgetId: row.id,
        change: 'threshold',
        budget,
        threshold,
      });
    }
  }

  // ---- the summary -------------------------------------------------------------

  summary(user: Principal, timeZone: string): UsageSummary {
    const now = this.#options.now();
    const month = monthOf(now, timeZone);
    const day = dayOf(now, timeZone);
    const own = { userId: user.userId, projectId: null, agentId: null };
    const monthly = new Map(
      this.#store
        .byAgent({ ...own, start: month.start, end: month.end })
        .map((row) => [row.agent_id, row]),
    );
    const daily = new Map(
      this.#store
        .byAgent({ ...own, start: day.start, end: day.end })
        .map((row) => [row.agent_id, row]),
    );
    const budgets = this.budgets(user);

    const adapters = new Map(
      this.#context.services.agents.adapters().map((adapter) => [adapter.id, adapter]),
    );
    const agentIds = new Set<string>([...adapters.keys(), ...monthly.keys()]);
    const short = (row: FiguresRow) => ({
      totalTokens: tokensOf(row),
      cost: toCost(row),
      runs: row.runs,
    });

    const agents: UsageSummaryAgent[] = [...agentIds].sort().map((agentId) => {
      const adapter = adapters.get(agentId);
      const quota = this.#presentQuota(user.userId, agentId);
      const monthRow = monthly.get(agentId) ?? EMPTY;
      const window = fullestWindow(quota);
      // The agent's own budget that is furthest along, if it has one.
      const budget = budgets
        .filter((entry) => entry.agentId === agentId)
        .sort((a, b) => b.fraction - a.fraction)[0];

      let basis: UsageSummaryAgent['basis'];
      let fraction: number | null;
      let line: string;
      if (window && window.usedFraction !== null) {
        basis = 'quota';
        fraction = window.usedFraction;
        line = `${percent(window.usedFraction)} of the ${window.label.toLowerCase()} used${quota.state === 'stale' ? ' (may be out of date)' : ''}`;
      } else if (budget) {
        basis = 'budget';
        fraction = budget.fraction;
        line = `${percent(budget.fraction)} of this month's ${budget.metric === 'tokens' ? 'token' : 'cost'} budget used`;
      } else {
        basis = 'usage';
        fraction = null;
        const cost = toCost(monthRow);
        line =
          monthRow.runs === 0
            ? 'No usage this month'
            : `${compact(tokensOf(monthRow))} tokens this month${cost.usd === null ? '' : ` · $${cost.usd.toFixed(2)}${cost.coverage === 'partial' ? '+' : ''}`}`;
      }
      return {
        agentId,
        agentName: adapter?.displayName ?? agentId,
        kind: adapter?.kind ?? (agentId.startsWith('api-') ? 'api' : 'cli'),
        basis,
        fraction,
        line,
        window:
          basis === 'quota' && window
            ? { id: window.id, label: window.label, resetsAt: window.resetsAt }
            : null,
        quotaState: quota.state,
        // "Not reported yet" is a reason only where a reading could be expected.
        staleReason: quota.state === 'none' && adapter?.kind !== 'cli' ? null : quota.staleReason,
        observedAt: quota.observedAt,
        month: short(monthRow),
        today: short(daily.get(agentId) ?? EMPTY),
      };
    });

    return {
      timeZone,
      agents,
      budgetsAtRisk: budgets.filter((budget) => budget.state !== 'ok'),
      generatedAt: now,
    };
  }
}
