import {
  type AgentProjectSettings,
  type ApprovalDecisionRequest,
  type CreatePermissionRuleRequest,
  type CreateSessionRequest,
  type PresenceRequest,
  type SendMessageRequest,
  type UpdateSessionRequest,
  activitySummarySchema,
  agentListSchema,
  agentProjectSettingsSchema,
  approvalDecisionResponseSchema,
  attachmentSchema,
  dismissRunResponseSchema,
  draftSchema,
  eventPageSchema,
  fileNameSearchSchema,
  messageReceiptSchema,
  messageSearchResponseSchema,
  permissionRuleListSchema,
  permissionRuleSchema,
  queueSchema,
  queuedMessageSchema,
  runListSchema,
  sendNowResponseSchema,
  sessionListSchema,
  sessionSchema,
  sessionSnapshotSchema,
  sessionUsageSchema,
  stopRunResponseSchema,
  uploadAttachmentsResponseSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { api } from '@/data/api';

/**
 * Every request the workbench makes, in one place, each validated against the
 * protocol's schema. Nothing here keeps state; the stores and hooks do.
 */
const enc = encodeURIComponent;

export interface ListSessionsParams {
  projectId?: string | null;
  q?: string;
  archived?: 'exclude' | 'only' | 'include';
  limit?: number;
  offset?: number;
}

/** Sending waits this long for the receipt before the message is called unconfirmed. */
export const SEND_TIMEOUT_MS = 20_000;

export const workbenchApi = {
  // ---- agents ---------------------------------------------------------------
  agents: (signal?: AbortSignal) => api.get('/api/agents', { schema: agentListSchema, ...(signal ? { signal } : {}) }),
  projectSettings: (projectId: string, signal?: AbortSignal) =>
    api.get(`/api/agents/projects/${enc(projectId)}/settings`, { schema: agentProjectSettingsSchema, ...(signal ? { signal } : {}) }),
  saveProjectSettings: (projectId: string, settings: AgentProjectSettings) =>
    api.put(`/api/agents/projects/${enc(projectId)}/settings`, settings, { schema: agentProjectSettingsSchema }),

  // ---- sessions -------------------------------------------------------------
  listSessions: (params: ListSessionsParams, signal?: AbortSignal) =>
    api.get('/api/sessions', {
      schema: sessionListSchema,
      query: { projectId: params.projectId ?? undefined, q: params.q || undefined, archived: params.archived ?? 'exclude', limit: params.limit ?? 50, offset: params.offset ?? 0 },
      ...(signal ? { signal } : {}),
    }),
  /** Accepts the Studio's id or the agent's own id for the conversation. */
  session: (idOrNativeId: string, signal?: AbortSignal) => api.get(`/api/sessions/${enc(idOrNativeId)}`, { schema: sessionSchema, ...(signal ? { signal } : {}) }),
  createSession: (input: Partial<CreateSessionRequest> & Pick<CreateSessionRequest, 'agentId'>) => api.post('/api/sessions', input, { schema: sessionSchema }),
  updateSession: (sessionId: string, changes: UpdateSessionRequest) => api.patch(`/api/sessions/${enc(sessionId)}`, changes, { schema: sessionSchema }),
  deleteSession: (sessionId: string) => api.delete(`/api/sessions/${enc(sessionId)}`),
  activity: (signal?: AbortSignal) => api.get('/api/sessions/activity', { schema: activitySummarySchema, ...(signal ? { signal } : {}) }),
  search: (q: string, projectId: string | null, signal?: AbortSignal) =>
    api.get('/api/sessions/search', { schema: messageSearchResponseSchema, query: { q, projectId: projectId ?? undefined, limit: 20 }, ...(signal ? { signal } : {}) }),
  presence: (report: PresenceRequest, keepalive = false) => api.put('/api/sessions/presence', report, { keepalive, timeoutMs: 8_000 }),
  seen: (sessionId: string) => api.post(`/api/sessions/${enc(sessionId)}/seen`, undefined, { schema: sessionSchema }),

  // ---- "@" in the message field: a project's files by name ----------------------
  searchFiles: (projectId: string, query: string, signal?: AbortSignal) =>
    api.get(`/api/projects/${enc(projectId)}/files/search`, { schema: fileNameSearchSchema, query: { query, limit: 10 }, timeoutMs: 10_000, ...(signal ? { signal } : {}) }).then((found) => found.results),

  // ---- one session's log ------------------------------------------------------
  state: (sessionId: string, signal?: AbortSignal) => api.get(`/api/sessions/${enc(sessionId)}/state`, { schema: sessionSnapshotSchema, ...(signal ? { signal } : {}) }),
  events: (sessionId: string, range: { before?: number; after?: number; limit: number }, signal?: AbortSignal) =>
    api.get(`/api/sessions/${enc(sessionId)}/events`, { schema: eventPageSchema, query: { before: range.before, after: range.after, limit: range.limit }, ...(signal ? { signal } : {}) }),
  usage: (sessionId: string) => api.get(`/api/sessions/${enc(sessionId)}/usage`, { schema: sessionUsageSchema }),

  // ---- drafts ---------------------------------------------------------------
  draft: (sessionId: string, signal?: AbortSignal) => api.get(`/api/sessions/${enc(sessionId)}/draft`, { schema: draftSchema, ...(signal ? { signal } : {}) }),
  saveDraft: (sessionId: string, text: string, keepalive = false) => api.put(`/api/sessions/${enc(sessionId)}/draft`, { text }, { schema: draftSchema, keepalive }),

  // ---- messages, stop, queue ----------------------------------------------------
  send: (sessionId: string, message: Partial<SendMessageRequest> & Pick<SendMessageRequest, 'requestId'>) =>
    api.post(`/api/sessions/${enc(sessionId)}/messages`, message, { schema: messageReceiptSchema, timeoutMs: SEND_TIMEOUT_MS }),
  /** "Did you get request X?" — 404 `receipt_not_found` is the only negative answer. */
  receipt: (sessionId: string, requestId: string) => api.get(`/api/sessions/${enc(sessionId)}/messages/${enc(requestId)}`, { schema: messageReceiptSchema, timeoutMs: 10_000 }),
  stop: (sessionId: string) => api.post(`/api/sessions/${enc(sessionId)}/stop`, undefined, { schema: stopRunResponseSchema }),
  queue: (sessionId: string) => api.get(`/api/sessions/${enc(sessionId)}/queue`, { schema: queueSchema }),
  editQueued: (sessionId: string, itemId: string, text: string) => api.patch(`/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}`, { text }, { schema: queuedMessageSchema }),
  removeQueued: (sessionId: string, itemId: string) => api.delete(`/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}`),
  sendQueuedNow: (sessionId: string, itemId: string) => api.post(`/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/send-now`, undefined, { schema: sendNowResponseSchema }),

  // ---- attachments ----------------------------------------------------------
  pendingAttachments: (sessionId: string, signal?: AbortSignal) =>
    api.get(`/api/sessions/${enc(sessionId)}/attachments`, { schema: z.object({ attachments: z.array(attachmentSchema) }), query: { pending: 'true' }, ...(signal ? { signal } : {}) }),
  uploadAttachment: (sessionId: string, file: File, options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return api.upload(`/api/sessions/${enc(sessionId)}/attachments`, form, { schema: uploadAttachmentsResponseSchema, ...options });
  },
  removeAttachment: (sessionId: string, attachmentId: string) => api.delete(`/api/sessions/${enc(sessionId)}/attachments/${enc(attachmentId)}`),

  // ---- runs -----------------------------------------------------------------
  activeRuns: (signal?: AbortSignal) => api.get('/api/runs', { schema: runListSchema, query: { state: 'active', limit: 20 }, ...(signal ? { signal } : {}) }),
  continueRun: (runId: string, requestId: string) => api.post(`/api/runs/${enc(runId)}/continue`, { requestId }, { schema: messageReceiptSchema, timeoutMs: SEND_TIMEOUT_MS }),
  dismissRun: (runId: string) => api.post(`/api/runs/${enc(runId)}/dismiss`, undefined, { schema: dismissRunResponseSchema }),

  // ---- approvals and rules ----------------------------------------------------
  decide: (approvalId: string, decision: ApprovalDecisionRequest) => api.post(`/api/approvals/${enc(approvalId)}/decision`, decision, { schema: approvalDecisionResponseSchema }),
  rules: (signal?: AbortSignal) => api.get('/api/permission-rules', { schema: permissionRuleListSchema, ...(signal ? { signal } : {}) }),
  createRule: (rule: Partial<CreatePermissionRuleRequest> & Pick<CreatePermissionRuleRequest, 'scope' | 'effect' | 'tool'>) =>
    api.post('/api/permission-rules', rule, { schema: permissionRuleSchema }),
  deleteRule: (ruleId: string) => api.delete(`/api/permission-rules/${enc(ruleId)}`),
};
