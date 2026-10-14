import {
  type AutomationTrigger,
  automationHistorySchema,
  automationListSchema,
  automationOptionsSchema,
  automationSchema,
  type createAutomationRequestSchema,
  type createDeferredMessageRequestSchema,
  deferredMessageListSchema,
  deferredMessageSchema,
  runAutomationResponseSchema,
  schedulePreviewSchema,
  type updateAutomationRequestSchema,
} from '@agent-studio/protocol';
import type { z } from 'zod';
import { api } from '@/data/api';

/** What a create or edit form sends — the input side of the protocol's schemas. */
export type CreateAutomationInput = z.input<typeof createAutomationRequestSchema>;
export type UpdateAutomationInput = z.input<typeof updateAutomationRequestSchema>;
export type CreateDeferredInput = z.input<typeof createDeferredMessageRequestSchema>;

const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const automationKeys = {
  all: ['automation'] as const,
  project: (projectId: string) => ['automation', projectId] as const,
  list: (projectId: string) => ['automation', projectId, 'list'] as const,
  options: (projectId: string) => ['automation', projectId, 'options'] as const,
  history: (projectId: string, automationId: string) => ['automation', projectId, 'history', automationId] as const,
  preview: (timeZone: string, trigger: AutomationTrigger) => ['automation', 'preview', timeZone, JSON.stringify(trigger)] as const,
  deferred: (sessionId: string) => ['deferred', sessionId] as const,
};

const base = (projectId: string) => `/api/projects/${enc(projectId)}/automations`;

export const automationApi = {
  list: (projectId: string, signal?: AbortSignal) => api.get(base(projectId), { schema: automationListSchema, ...withSignal(signal) }),
  options: (projectId: string, signal?: AbortSignal) => api.get(`${base(projectId)}/options`, { schema: automationOptionsSchema, ...withSignal(signal) }),
  create: (projectId: string, body: CreateAutomationInput) => api.post(base(projectId), body, { schema: automationSchema }),
  update: (projectId: string, automationId: string, body: UpdateAutomationInput) => api.patch(`${base(projectId)}/${enc(automationId)}`, body, { schema: automationSchema }),
  remove: (projectId: string, automationId: string) => api.delete(`${base(projectId)}/${enc(automationId)}`),
  run: (projectId: string, automationId: string) => api.post(`${base(projectId)}/${enc(automationId)}/run`, undefined, { schema: runAutomationResponseSchema, timeoutMs: 30_000 }),
  history: (projectId: string, automationId: string, before: string | undefined, limit: number, signal?: AbortSignal) =>
    api.get(`${base(projectId)}/${enc(automationId)}/runs`, { schema: automationHistorySchema, query: { limit, before }, ...withSignal(signal) }),
  preview: (timeZone: string, trigger: AutomationTrigger, signal?: AbortSignal) =>
    api.post('/api/automations/preview', { timeZone, trigger }, { schema: schedulePreviewSchema, ...withSignal(signal) }),
};

export const deferredApi = {
  create: (body: CreateDeferredInput) => api.post('/api/deferred-messages', body, { schema: deferredMessageSchema }),
  list: (sessionId: string, signal?: AbortSignal) => api.get('/api/deferred-messages', { schema: deferredMessageListSchema, query: { sessionId }, ...withSignal(signal) }),
  cancel: (deferredId: string) => api.post(`/api/deferred-messages/${enc(deferredId)}/cancel`, undefined, { schema: deferredMessageSchema }),
  dismiss: (deferredId: string) => api.post(`/api/deferred-messages/${enc(deferredId)}/dismiss`, undefined, { schema: deferredMessageSchema }),
};
