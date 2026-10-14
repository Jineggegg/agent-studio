import {
  type UsagePeriod,
  budgetListSchema,
  budgetSchema,
  type createBudgetRequestSchema,
  providerUsageListSchema,
  providerUsageSchema,
  quotaResponseSchema,
  type setProviderNoteRequestSchema,
  type updateBudgetRequestSchema,
  usageReportSchema,
  usageSummarySchema,
} from '@agent-studio/protocol';
import type { z } from 'zod';
import { api } from '@/data/api';

export type CreateBudgetInput = z.input<typeof createBudgetRequestSchema>;
export type UpdateBudgetInput = z.input<typeof updateBudgetRequestSchema>;
export type ProviderNoteInput = z.input<typeof setProviderNoteRequestSchema>;

const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export interface ReportParams {
  period: UsagePeriod;
  timeZone: string;
  scope: 'mine' | 'all';
}

export const usageKeys = {
  all: ['usage'] as const,
  report: (params: ReportParams) => ['usage', 'report', params.scope, params.period, params.timeZone] as const,
  summary: (timeZone: string) => ['usage', 'summary', timeZone] as const,
  quota: ['usage', 'quota'] as const,
  providers: ['usage', 'providers'] as const,
  provider: (providerId: string) => ['usage', 'provider', providerId] as const,
  budgets: ['usage', 'budgets'] as const,
};

export const usageApi = {
  report: (params: ReportParams, signal?: AbortSignal) => api.get('/api/usage/report', { schema: usageReportSchema, query: { period: params.period, timeZone: params.timeZone, scope: params.scope }, ...withSignal(signal) }),
  summary: (timeZone: string, signal?: AbortSignal) => api.get('/api/usage/summary', { schema: usageSummarySchema, query: { timeZone }, ...withSignal(signal) }),
  quota: (signal?: AbortSignal) => api.get('/api/usage/quota', { schema: quotaResponseSchema, ...withSignal(signal) }),
  providers: (signal?: AbortSignal) => api.get('/api/usage/providers', { schema: providerUsageListSchema, ...withSignal(signal) }),
  /** Reads the balance from the provider itself (owner only): rate-limited, so only on request. */
  provider: (providerId: string) => api.get(`/api/usage/providers/${enc(providerId)}`, { schema: providerUsageSchema, timeoutMs: 30_000 }),
  setNote: (providerId: string, body: ProviderNoteInput) => api.put(`/api/usage/providers/${enc(providerId)}/note`, body, { schema: providerUsageSchema }),
  clearNote: (providerId: string) => api.delete(`/api/usage/providers/${enc(providerId)}/note`),
  budgets: (signal?: AbortSignal) => api.get('/api/usage/budgets', { schema: budgetListSchema, ...withSignal(signal) }),
  createBudget: (body: CreateBudgetInput) => api.post('/api/usage/budgets', body, { schema: budgetSchema }),
  updateBudget: (budgetId: string, body: UpdateBudgetInput) => api.patch(`/api/usage/budgets/${enc(budgetId)}`, body, { schema: budgetSchema }),
  removeBudget: (budgetId: string) => api.delete(`/api/usage/budgets/${enc(budgetId)}`),
};
