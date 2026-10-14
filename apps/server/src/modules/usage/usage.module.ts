import {
  USAGE_LIMITS,
  createBudgetRequestSchema,
  idSchema,
  providerIdSchema,
  setProviderNoteRequestSchema,
  updateBudgetRequestSchema,
  usageReportQuerySchema,
  usageSummaryQuerySchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { describeError } from '../../kernel/errors.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { UsageService } from './service.js';
import { USAGE_MIGRATIONS, UsageStore } from './store.js';

/**
 * Usage: what was used, and what is left.
 *
 * - `buckets.ts`  days, weeks and months in a named time zone (pure)
 * - `quota.ts`    an agent's own report of its limits → a few trustworthy fields, and whether they are stale (pure)
 * - `budgets.ts`  the thresholds of a budget (pure)
 * - `store.ts`    SQL: reads of the runtime's `agent_usage`, and this module's three tables
 * - `service.ts`  access rules, reports, readings, notes, budgets, the summary
 *
 * ## Routes (schemas in `@agent-studio/protocol`, `usage.ts`)
 *
 * All `access: 'user'`; a token needs scope `read` for GET and `write` for the rest.
 *
 * | Route | |
 * | --- | --- |
 * | `GET /api/usage/report` | totals, buckets by day / week / month, by agent, model and project. The caller's own; `scope=all`, another `userId`: the instance owner only (403 `owner_required`). `projectId`: a project the caller can see (404 otherwise) |
 * | `GET /api/usage/summary` | one line and one fraction per agent, for a home-screen tile |
 * | `GET /api/usage/quota` | the newest plan-window reading per agent from the caller's own runs, with its age and staleness |
 * | `GET /api/usage/providers` | API providers: the caller's note and the estimate it gives. No request leaves the server |
 * | `GET /api/usage/providers/:providerId` | the same for one provider, plus — for the instance owner — the balance the provider reports (rate-limited) |
 * | `PUT /api/usage/providers/:providerId/note` | "I had this much on that day" |
 * | `DELETE /api/usage/providers/:providerId/note` | clears it, and with it the estimate |
 * | `GET /api/usage/budgets` | the caller's budgets with this month's progress |
 * | `POST /api/usage/budgets` | create (201); 409 `budget_exists`, `too_many_budgets`; 422 `agent_unavailable` |
 * | `PATCH /api/usage/budgets/:budgetId` | change the amount or the time zone; 404 `budget_not_found` for anybody else's |
 * | `DELETE /api/usage/budgets/:budgetId` | |
 *
 * ## Events
 *
 * Consumed: `internal:usage` / `rate-limit.observed` (the adapters document
 * its payload) and `internal:runs` / `run.finished` (to look at budgets when
 * usage has changed).
 *
 * Published on the user's own `user:<id>` topic: `usage.quota.changed`,
 * `usage.budget.changed`, `usage.provider-note.changed` (see `usageEventSchema`).
 *
 * Published on `internal:usage` (server-side only), type `budget.threshold`,
 * once per budget, month and threshold when usage first reaches 80 % or
 * 100 % of the amount (only the higher one when both are passed at once):
 *
 * ```
 * { budgetId, userId,
 *   agentId,          // null for a budget over everything the user runs
 *   metric,           // 'tokens' | 'cost'
 *   amount, used,     // tokens, or US dollars
 *   fraction,         // used / amount
 *   threshold,        // 80 | 100
 *   month, timeZone,  // '2026-10' in that zone
 *   at }
 * ```
 *
 * A budget never blocks a run. It is looked at when one of the user's runs
 * ends, so a threshold passed in the middle of a run is announced at its end.
 */
export interface UsageModuleOptions {
  /** The clock (tests move it). */
  readonly now?: () => number;
  /** How old a plan-window reading may be before it is flagged as stale. */
  readonly quotaStaleAfterMs?: number;
  /** How often one caller may ask for a provider's balance. Default 20 a minute. */
  readonly balanceRateLimit?: { readonly max: number; readonly windowMs: number };
}

declare module '../../kernel/module.js' {
  interface Services {
    usage: UsageService;
  }
}

const providerParams = z.object({ providerId: providerIdSchema });
const budgetParams = z.object({ budgetId: idSchema });

export function createUsageModule(options: UsageModuleOptions = {}): StudioModule {
  return {
    name: 'usage',
    migrations: USAGE_MIGRATIONS,

    setup(context: ModuleContext) {
      const { http, bus, config, log } = context;
      const service = new UsageService(context, new UsageStore(context.db), {
        now: options.now ?? Date.now,
        quotaStaleAfterMs: options.quotaStaleAfterMs ?? USAGE_LIMITS.quotaStaleAfterMs,
      });
      context.services.usage = service;

      // A problem here must never surface in the adapter or the runtime that published the event.
      const guarded = (what: string, work: () => void): void => {
        try {
          work();
        } catch (error) {
          log.error({ err: describeError(error) }, what);
        }
      };
      bus.onTopic('internal:usage', (event) => {
        if (event.type === 'rate-limit.observed') guarded('recording a plan-window reading failed', () => service.observe(event.data));
      });
      bus.onTopic('internal:runs', (event) => {
        if (event.type !== 'run.finished') return;
        const userId = (event.data as { userId?: unknown }).userId;
        if (typeof userId === 'string') guarded('checking budgets failed', () => service.checkBudgets(userId));
      });

      // ---- what was used ---------------------------------------------------------
      http.route({
        method: 'GET',
        url: '/api/usage/report',
        access: 'user',
        query: usageReportQuerySchema,
        handler: ({ user, query }) => service.report(user, query),
      });
      http.route({
        method: 'GET',
        url: '/api/usage/summary',
        access: 'user',
        query: usageSummaryQuerySchema,
        handler: ({ user, query }) => service.summary(user, query.timeZone),
      });

      // ---- what is left ----------------------------------------------------------
      http.route({
        method: 'GET',
        url: '/api/usage/quota',
        access: 'user',
        handler: ({ user }) => service.quota(user),
      });
      http.route({
        method: 'GET',
        url: '/api/usage/providers',
        access: 'user',
        handler: ({ user }) => ({ providers: service.providers(user) }),
      });
      // For the owner this asks the provider for its balance: bounded like the providers module's own route.
      http.route({
        method: 'GET',
        url: '/api/usage/providers/:providerId',
        access: 'user',
        params: providerParams,
        rateLimit: options.balanceRateLimit ?? { max: config.env === 'test' ? 10_000 : 20, windowMs: 60_000 },
        handler: ({ user, params }) => service.provider(user, params.providerId),
      });
      http.route({
        method: 'PUT',
        url: '/api/usage/providers/:providerId/note',
        access: 'user',
        params: providerParams,
        body: setProviderNoteRequestSchema,
        handler: ({ user, params, body }) => service.setNote(user, params.providerId, body),
      });
      http.route({
        method: 'DELETE',
        url: '/api/usage/providers/:providerId/note',
        access: 'user',
        params: providerParams,
        handler: ({ user, params }) => service.clearNote(user, params.providerId),
      });

      // ---- budgets ---------------------------------------------------------------
      http.route({
        method: 'GET',
        url: '/api/usage/budgets',
        access: 'user',
        handler: ({ user }) => ({ budgets: service.budgets(user) }),
      });
      http.route({
        method: 'POST',
        url: '/api/usage/budgets',
        access: 'user',
        body: createBudgetRequestSchema,
        handler: ({ user, body, reply }) => {
          void reply.status(201);
          return service.createBudget(user, body);
        },
      });
      http.route({
        method: 'PATCH',
        url: '/api/usage/budgets/:budgetId',
        access: 'user',
        params: budgetParams,
        body: updateBudgetRequestSchema,
        handler: ({ user, params, body }) => service.updateBudget(user, params.budgetId, body),
      });
      http.route({
        method: 'DELETE',
        url: '/api/usage/budgets/:budgetId',
        access: 'user',
        params: budgetParams,
        handler: ({ user, params }) => service.deleteBudget(user, params.budgetId),
      });
    },
  };
}

export const usageModule: StudioModule = createUsageModule();
