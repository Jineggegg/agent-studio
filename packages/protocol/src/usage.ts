import { z } from 'zod';
import { calendarDateSchema, timeZoneSchema } from './automation.js';
import { idSchema, timestampSchema } from './common.js';
import { providerBalanceSchema, providerIdSchema } from './providers.js';

/**
 * Wire contracts of the usage feature: what was used, and what is left.
 *
 * Four things, each with its own source and its own honesty rule:
 *
 * - The **report** (`GET /api/usage/report`) adds up the agent runtime's
 *   usage records — one per run and model — by day, week or month, by agent,
 *   by model and by project. Tokens are what the agent reported. Cost is what
 *   the agent reported or the Studio estimated from list prices, and where
 *   neither happened it is *unknown*, never zero (see {@link usageCostSchema}).
 *   One session's or one run's figures are not repeated here: they are the
 *   runtime's, at `GET /api/sessions/:id/usage`.
 * - **Plan windows** (`GET /api/usage/quota`) are what an agent's own
 *   command-line program said about the limits of the account it is signed in
 *   to, the last time it said so during one of the caller's runs. The Studio
 *   calls no usage endpoint of its own, so there is nothing to refresh by
 *   hand (`refreshable: false`): a reading gets newer when that agent runs
 *   again. Every reading carries when it was observed and whether it is still
 *   to be trusted (see {@link quotaFreshnessSchema}).
 * - **API providers** (`GET /api/usage/providers`) have no plan windows. They
 *   have a balance — read from the provider where it documents a way, for the
 *   owner — and an estimate: an amount the user noted on a date ("I topped up
 *   20 on the 3rd") minus what the Studio's records say was spent since.
 * - **Budgets** (`/api/usage/budgets`) are a user's own monthly marks. They
 *   inform; nothing is ever blocked by one.
 *
 * Everything is advisory. A figure that is stale or estimated says so.
 *
 * Whose usage: a user sees their own. The instance owner may ask for
 * everybody's (`scope=all`), broken down per user, and for a project's total.
 * Nothing here ever carries a prompt, an answer or a session's title.
 *
 * Live updates arrive on the caller's `user:<id>` topic as {@link UsageEvent}s.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const USAGE_LIMITS = {
  /** Buckets one report may span, per period. */
  maxDays: 366,
  maxWeeks: 106,
  maxMonths: 60,
  /** What a report covers when no dates are named: the current bucket and the ones before it. */
  defaultDays: 30,
  defaultWeeks: 12,
  defaultMonths: 12,
  /** Rows of one breakdown; the rest are added up in `others`. */
  breakdownRows: 50,
  budgetsPerUser: 20,
  /** A plan-window reading older than this is flagged as stale. */
  quotaStaleAfterMs: 15 * 60 * 1000,
} as const;

/** The thresholds of a budget that are announced, in percent. Each is announced once per month. */
export const BUDGET_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * What the runs behind a figure cost, in US dollars.
 *
 * `complete`  every run reported or was given a cost: `usd` is their sum.
 * `partial`   some runs have a cost and some do not: `usd` is the sum of those
 *             that do, and is therefore too low by an unknown amount.
 * `unknown`   no run has a cost (a subscription agent that reports none, a
 *             model without a price): `usd` is null. This is not zero.
 * `none`      there were no runs at all: `usd` is null.
 */
export const usageCostSchema = z.object({
  usd: z.number().nonnegative().nullable(),
  coverage: z.enum(['complete', 'partial', 'unknown', 'none']),
  /** Runs that have a cost. */
  pricedRuns: z.number().int().nonnegative(),
  /** Runs that have none: they are not in `usd`. */
  unpricedRuns: z.number().int().nonnegative(),
});
export type UsageCost = z.infer<typeof usageCostSchema>;

export const usageFiguresSchema = z.object({
  /** Input that was not served from a cache. */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Input the provider served from its cache. */
  cacheReadTokens: z.number().int().nonnegative(),
  /** Input written to the provider's cache. */
  cacheWriteTokens: z.number().int().nonnegative(),
  /** The four above added up. */
  totalTokens: z.number().int().nonnegative(),
  /**
   * Tokens the model spent reasoning, where the runtime records them apart
   * from output. It does not today — adapters count reasoning as output — so
   * this is null: not recorded, which is not the same as none.
   */
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cost: usageCostSchema,
  runs: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type UsageFigures = z.infer<typeof usageFiguresSchema>;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const usagePeriodSchema = z.enum(['day', 'week', 'month']);
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;

export const usageReportQuerySchema = z
  .object({
    /** The size of a bucket. Weeks run from Monday to Sunday. */
    period: usagePeriodSchema.default('day'),
    /**
     * Calendar dates in `timeZone`, both inclusive. The report covers the
     * whole buckets they fall in. Without `to`: up to today. Without `from`:
     * the default number of buckets ending at `to`.
     */
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    /** The zone days, weeks and months are cut in. An IANA name; UTC when absent. */
    timeZone: timeZoneSchema.default('UTC'),
    /** `all`: every user's usage, with a per-user breakdown — the instance owner only. */
    scope: z.enum(['mine', 'all']).default('mine'),
    /** Only this user's usage — the instance owner only (anyone may name themselves). */
    userId: idSchema.optional(),
    /** Only what was used in this project. The caller must be able to see it. */
    projectId: idSchema.optional(),
    agentId: z.string().min(1).max(80).optional(),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'The first day comes after the last.',
    path: ['from'],
  });
export type UsageReportQuery = z.infer<typeof usageReportQuerySchema>;

export const usageBucketSchema = usageFiguresSchema.extend({
  /** `2026-10-14` for a day, the Monday's date for a week, `2026-10` for a month. */
  key: z.string(),
  /** The first instant of the bucket and the first instant after it, in `timeZone`. */
  start: timestampSchema,
  end: timestampSchema,
  /** True for the bucket that contains "now": its figures are still growing. */
  current: z.boolean(),
});
export type UsageBucket = z.infer<typeof usageBucketSchema>;

export const usageByAgentSchema = usageFiguresSchema.extend({
  agentId: z.string(),
  /** The agent's name while it is registered; its id otherwise. */
  agentName: z.string(),
});
export type UsageByAgent = z.infer<typeof usageByAgentSchema>;

export const usageByModelSchema = usageFiguresSchema.extend({
  agentId: z.string(),
  model: z.string(),
});
export type UsageByModel = z.infer<typeof usageByModelSchema>;

/**
 * `project`      a project the caller can see now.
 * `none`         runs outside any project (a conversation with an API model).
 * `unavailable`  everything used in projects the caller cannot see any more —
 *                removed, or no longer shared with them — added up in one row
 *                that names none of them.
 */
export const usageByProjectSchema = usageFiguresSchema.extend({
  kind: z.enum(['project', 'none', 'unavailable']),
  projectId: idSchema.nullable(),
  projectName: z.string().nullable(),
});
export type UsageByProject = z.infer<typeof usageByProjectSchema>;

export const usageByUserSchema = usageFiguresSchema.extend({
  userId: idSchema,
  /** Null when the account no longer exists. */
  username: z.string().nullable(),
  displayName: z.string().nullable(),
});
export type UsageByUser = z.infer<typeof usageByUserSchema>;

const breakdown = <T extends z.ZodType>(row: T) =>
  z.object({
    /** Largest first (by tokens), at most {@link USAGE_LIMITS.breakdownRows}. */
    rows: z.array(row),
    /** What the rows left out add up to; null when nothing was left out. */
    others: usageFiguresSchema.extend({ count: z.number().int().positive() }).nullable(),
  });

export const usageReportSchema = z.object({
  period: usagePeriodSchema,
  timeZone: z.string(),
  /** The first and the last calendar date covered, in `timeZone`. */
  from: z.string(),
  to: z.string(),
  /** The same range as instants: `[start, end)`. */
  start: timestampSchema,
  end: timestampSchema,
  scope: z.enum(['mine', 'all']),
  /** The filters that were applied. */
  userId: idSchema.nullable(),
  projectId: idSchema.nullable(),
  agentId: z.string().nullable(),
  totals: usageFiguresSchema,
  /** Every bucket of the range, oldest first, without gaps. */
  buckets: z.array(usageBucketSchema),
  byAgent: breakdown(usageByAgentSchema),
  byModel: breakdown(usageByModelSchema),
  byProject: breakdown(usageByProjectSchema),
  /** Present only for `scope=all`. */
  byUser: breakdown(usageByUserSchema).nullable(),
  /** When the newest record in the range was written; null when there is none. */
  lastRecordedAt: timestampSchema.nullable(),
  /** Where the figures of one session are: replace `:sessionId`. */
  sessionUsageUrl: z.literal('/api/sessions/:sessionId/usage'),
  generatedAt: timestampSchema,
});
export type UsageReport = z.infer<typeof usageReportSchema>;

// ---------------------------------------------------------------------------
// Plan windows ("quota")
// ---------------------------------------------------------------------------

/**
 * One limit of the account an agent is signed in to, as its program reported
 * it. Only what the program said is here: a field it did not mention is null,
 * and nothing is worked out from another field.
 */
export const quotaWindowSchema = z.object({
  /** As the program names it: `five_hour`, `seven_day`, `primary`, `secondary`, … */
  id: z.string(),
  /** A plain English name, for clients that have no words of their own for `id`. */
  label: z.string(),
  /** How much of the window is used, 0–1. Null when the program named the window without a figure. */
  usedFraction: z.number().min(0).max(1).nullable(),
  /** `1 - usedFraction`, for clients that show what is left. */
  remainingFraction: z.number().min(0).max(1).nullable(),
  /** When the window starts again. */
  resetsAt: timestampSchema.nullable(),
  /** The length of the window in minutes (300: five hours, 10080: a week). */
  windowMinutes: z.number().int().positive().nullable(),
  /** When this window was last reported — a report need not mention every window. */
  observedAt: timestampSchema,
  /** The reset time it mentioned has passed: the figure describes a window that is over. */
  resetPassed: z.boolean(),
});
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;

/**
 * `fresh`  observed recently, and no reset time it mentioned has passed.
 * `stale`  older than {@link USAGE_LIMITS.quotaStaleAfterMs}, or past a reset
 *          time it mentioned. Shown as "may be out of date", never as current.
 * `none`   the agent has not reported its limits in any of the caller's runs.
 */
export const quotaFreshnessSchema = z.enum(['fresh', 'stale', 'none']);
export type QuotaFreshness = z.infer<typeof quotaFreshnessSchema>;

export const agentQuotaSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  /** False when the agent is not registered on this Studio at the moment; an old reading is still returned. */
  available: z.boolean(),
  state: quotaFreshnessSchema,
  /** `old` | `reset-passed` for `stale`; null otherwise. */
  staleCode: z.enum(['old', 'reset-passed']).nullable(),
  /** One sentence in English saying why the reading is stale, or that there is none. Null when fresh. */
  staleReason: z.string().nullable(),
  /** When the program last reported anything. Null for `none`. */
  observedAt: timestampSchema.nullable(),
  /**
   * Always false: the Studio asks no usage endpoint, so a reading cannot be
   * renewed on demand. `refreshHint` says in words how it does get renewed.
   */
  refreshable: z.literal(false),
  refreshHint: z.string(),
  windows: z.array(quotaWindowSchema),
  /**
   * What the program said about being allowed to continue: `allowed`,
   * `warning` (close to a limit) or `limited` (a limit was reached). Null when
   * it did not say.
   */
  status: z.enum(['allowed', 'warning', 'limited']).nullable(),
  /** The window that decided `status`, when the program named it. */
  limitingWindow: z.string().nullable(),
  /** The plan as the program names it ("pro", "plus", …). */
  plan: z.string().nullable(),
  /** Whether usage beyond the plan is being drawn on, when the program says. */
  usingOverage: z.boolean().nullable(),
  /** Pay-as-you-go credits of the account, when the program reports them. */
  credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullable() }).nullable(),
});
export type AgentQuota = z.infer<typeof agentQuotaSchema>;

export const quotaResponseSchema = z.object({
  /** One entry per agent that runs a program of its own (`kind: 'cli'`) or has ever reported limits. */
  agents: z.array(agentQuotaSchema),
  checkedAt: timestampSchema,
});
export type QuotaResponse = z.infer<typeof quotaResponseSchema>;

// ---------------------------------------------------------------------------
// API providers: balance, noted amount, estimate
// ---------------------------------------------------------------------------

/** Three capital letters. Only a note in `USD` yields an estimate of what is left: spend is recorded in US dollars. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code such as USD.');

/** "I had this much on that day." */
export const providerNoteSchema = z.object({
  amount: z.number().nonnegative(),
  currency: currencyCodeSchema,
  /** The instant the amount was true: spend is counted from here. */
  notedAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProviderNote = z.infer<typeof providerNoteSchema>;

export const setProviderNoteRequestSchema = z.strictObject({
  amount: z.number().min(0).max(1_000_000_000),
  currency: currencyCodeSchema.default('USD'),
  /** Milliseconds since the epoch; not in the future. Now when absent. */
  notedAt: timestampSchema.optional(),
});
export type SetProviderNoteRequest = z.infer<typeof setProviderNoteRequestSchema>;

export const providerUsageSchema = z.object({
  providerId: providerIdSchema,
  /** The agent sessions are created with: `api-<providerId>`. */
  agentId: z.string(),
  name: z.string(),
  /**
   * Whose spend the figures below count. `own`: the caller's runs.
   * `everyone`: all users' runs through this provider — the instance owner,
   * because the balance belongs to the one key everybody uses.
   */
  spendScope: z.enum(['own', 'everyone']),
  note: providerNoteSchema.nullable(),
  /** Null without a note. */
  estimate: z
    .object({
      /** What the records say was spent since the note; null when no run since then has a cost. */
      spentUsd: z.number().nonnegative().nullable(),
      runs: z.number().int().nonnegative(),
      /** Runs since the note without a cost: the estimate is too high by what they cost. */
      unpricedRuns: z.number().int().nonnegative(),
      /** The noted amount minus `spentUsd`. Null when the note is not in USD. May be negative. */
      remaining: z.number().nullable(),
      /** One sentence in English saying how far the estimate can be trusted. */
      caveat: z.string(),
    })
    .nullable(),
  /**
   * The balance as the provider reports it. Only on `GET /api/usage/providers/:providerId`,
   * and only for the instance owner (reading it uses the provider's key); null otherwise.
   */
  balance: providerBalanceSchema.nullable(),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const providerUsageListSchema = z.object({ providers: z.array(providerUsageSchema) });
export type ProviderUsageList = z.infer<typeof providerUsageListSchema>;

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** `tokens`: every token counted in `totalTokens`. `cost`: US dollars, from runs that have a cost. */
export const budgetMetricSchema = z.enum(['tokens', 'cost']);
export type BudgetMetric = z.infer<typeof budgetMetricSchema>;

/**
 * `ok`        below 80 %.
 * `warning`   80 % or more.
 * `exceeded`  100 % or more. Nothing is blocked: a budget informs.
 */
export const budgetStateSchema = z.enum(['ok', 'warning', 'exceeded']);
export type BudgetState = z.infer<typeof budgetStateSchema>;

export const budgetSchema = z.object({
  id: idSchema,
  /** Null: everything the user runs, whatever the agent. */
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  metric: budgetMetricSchema,
  /** Tokens, or US dollars, per calendar month. */
  amount: z.number().positive(),
  /** The zone the month is cut in. */
  timeZone: z.string(),
  /** The month the progress is for: `2026-10`. */
  month: z.string(),
  monthStart: timestampSchema,
  monthEnd: timestampSchema,
  used: z.number().nonnegative(),
  /** `used / amount`; may exceed 1. */
  fraction: z.number().nonnegative(),
  state: budgetStateSchema,
  /**
   * For a cost budget: runs of the month that have no cost and are therefore
   * not in `used`. Above zero, the progress is a lower bound.
   */
  unpricedRuns: z.number().int().nonnegative(),
  /** The highest threshold already announced for this month, or 0. */
  announcedThreshold: z.union([z.literal(0), z.literal(80), z.literal(100)]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Budget = z.infer<typeof budgetSchema>;

export const budgetListSchema = z.object({ budgets: z.array(budgetSchema) });
export type BudgetList = z.infer<typeof budgetListSchema>;

const budgetAmount = z.number().positive().max(1_000_000_000_000);

/** One budget per agent (or overall) and metric: creating a second one is refused (`budget_exists`). */
export const createBudgetRequestSchema = z.strictObject({
  agentId: z.string().min(1).max(80).nullable().default(null),
  metric: budgetMetricSchema,
  amount: budgetAmount,
  timeZone: timeZoneSchema.default('UTC'),
});
export type CreateBudgetRequest = z.infer<typeof createBudgetRequestSchema>;

export const updateBudgetRequestSchema = z
  .strictObject({ amount: budgetAmount.optional(), timeZone: timeZoneSchema.optional() })
  .refine((value) => value.amount !== undefined || value.timeZone !== undefined, { message: 'Nothing to change.' });
export type UpdateBudgetRequest = z.infer<typeof updateBudgetRequestSchema>;

// ---------------------------------------------------------------------------
// The summary for a home-screen tile
// ---------------------------------------------------------------------------

export const usageSummaryQuerySchema = z.object({ timeZone: timeZoneSchema.default('UTC') });

/**
 * One agent in one line and one fraction.
 *
 * What the fraction is depends on what is known, in this order:
 * `quota`   the fullest plan window the agent's program reported (0–1 used);
 * `budget`  the caller's own budget for this agent (may exceed 1);
 * `usage`   neither exists: `fraction` is null and the line says what was
 *           used this month.
 */
export const usageSummaryAgentSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  kind: z.enum(['cli', 'api']),
  basis: z.enum(['quota', 'budget', 'usage']),
  /** A share that is used, never one that is left. */
  fraction: z.number().nonnegative().nullable(),
  /** English, ready to show; the structured fields let a client say it in its own words. */
  line: z.string(),
  /** For `basis: 'quota'`: the window the fraction is of. */
  window: z.object({ id: z.string(), label: z.string(), resetsAt: timestampSchema.nullable() }).nullable(),
  /** The state of the plan-window reading (also when the tile is based on something else). */
  quotaState: quotaFreshnessSchema,
  staleReason: z.string().nullable(),
  observedAt: timestampSchema.nullable(),
  /** The caller's own usage of this agent in the current month and day of `timeZone`. */
  month: z.object({ totalTokens: z.number().int().nonnegative(), cost: usageCostSchema, runs: z.number().int().nonnegative() }),
  today: z.object({ totalTokens: z.number().int().nonnegative(), cost: usageCostSchema, runs: z.number().int().nonnegative() }),
});
export type UsageSummaryAgent = z.infer<typeof usageSummaryAgentSchema>;

export const usageSummarySchema = z.object({
  timeZone: z.string(),
  /** Agents registered now, and any other the caller used this month. */
  agents: z.array(usageSummaryAgentSchema),
  /** The caller's budgets that are at 80 % or more. */
  budgetsAtRisk: z.array(budgetSchema),
  generatedAt: timestampSchema,
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** On the caller's `user:<id>` topic. */
export const USAGE_EVENT = {
  /** An agent's program reported its limits during one of the user's runs. */
  quotaChanged: 'usage.quota.changed',
  /** A budget was created, changed or removed, or crossed a threshold. */
  budgetChanged: 'usage.budget.changed',
  /** The noted amount of a provider was set or cleared. */
  providerNoteChanged: 'usage.provider-note.changed',
} as const;

export const usageEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(USAGE_EVENT.quotaChanged), data: z.object({ quota: agentQuotaSchema }) }),
  z.object({
    type: z.literal(USAGE_EVENT.budgetChanged),
    data: z.object({
      budgetId: idSchema,
      change: z.enum(['created', 'updated', 'removed', 'threshold']),
      /** Null when it was removed. */
      budget: budgetSchema.nullable(),
      /** For `threshold`: the mark that was crossed. */
      threshold: z.union([z.literal(80), z.literal(100)]).nullable(),
    }),
  }),
  z.object({ type: z.literal(USAGE_EVENT.providerNoteChanged), data: z.object({ providerId: providerIdSchema, note: providerNoteSchema.nullable() }) }),
]);
export type UsageEvent = z.infer<typeof usageEventSchema>;

/**
 * Server-side only (`internal:usage`, never sent to a browser): published
 * once when a budget's usage first reaches a threshold in a month, for
 * whatever wants to notify the user.
 */
export const BUDGET_THRESHOLD_BUS_EVENT = 'budget.threshold';

export const budgetThresholdEventSchema = z.object({
  budgetId: idSchema,
  userId: idSchema,
  /** Null for a budget over everything the user runs. */
  agentId: z.string().nullable(),
  metric: budgetMetricSchema,
  amount: z.number().positive(),
  used: z.number().nonnegative(),
  fraction: z.number().nonnegative(),
  threshold: z.union([z.literal(80), z.literal(100)]),
  /** `2026-10`, in `timeZone`. */
  month: z.string(),
  timeZone: z.string(),
  at: timestampSchema,
});
export type BudgetThresholdEvent = z.infer<typeof budgetThresholdEventSchema>;
