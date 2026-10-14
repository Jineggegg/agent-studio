import { acknowledgeResponseSchema, acknowledgeResultsResponseSchema, inboxSchema, inboxSummarySchema } from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * The task inbox: a live view of the caller's runs. Acknowledging marks a
 * finished run read or handled — it never approves, starts or continues
 * anything; that happens in the session itself.
 */
export const inboxKeys = {
  all: ['inbox'] as const,
  list: ['inbox', 'list'] as const,
  summary: ['inbox', 'summary'] as const,
};

/** A check that stalls this long is abandoned: the last list stays, marked as possibly out of date. */
export const INBOX_READ_TIMEOUT_MS = 20_000;

export const inboxApi = {
  read: (signal?: AbortSignal) => api.get('/api/inbox', { schema: inboxSchema, timeoutMs: INBOX_READ_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
  summary: (signal?: AbortSignal) => api.get('/api/inbox/summary', { schema: inboxSummarySchema, timeoutMs: INBOX_READ_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
  acknowledge: (runId: string) => api.post('/api/inbox/acknowledge', { runId }, { schema: acknowledgeResponseSchema }),
  acknowledgeResults: (runIds: readonly string[]) => api.post('/api/inbox/acknowledge-results', { runIds }, { schema: acknowledgeResultsResponseSchema }),
};
