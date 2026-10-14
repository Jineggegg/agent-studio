import {
  type CreateTerminalSessionRequest,
  closeTerminalSessionResponseSchema,
  terminalCapabilitySchema,
  terminalSessionListSchema,
  terminalSessionSchema,
  typeTextResponseSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * The terminal's management requests. Note what a client can say when it
 * opens one: a project, a launcher key from the server's list, a remote host
 * by id — never a path, a program or an argument.
 */
const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const terminalApi = {
  /** Never an error for a signed-in user: it says whether terminals can be used here and, if not, why. */
  capability: (signal?: AbortSignal) => api.get('/api/terminal/capability', { schema: terminalCapabilitySchema, ...withSignal(signal) }),
  /** The caller's own sessions; ended ones stay listed for a few minutes. */
  sessions: (projectId: string | null, signal?: AbortSignal) =>
    api.get('/api/terminal/sessions', { schema: terminalSessionListSchema, query: { projectId: projectId ?? undefined }, ...withSignal(signal) }).then((result) => result.sessions),
  session: (sessionId: string, signal?: AbortSignal) => api.get(`/api/terminal/sessions/${enc(sessionId)}`, { schema: terminalSessionSchema, ...withSignal(signal) }),
  /**
   * Needs a recent proof of identity unless this browser already holds a live
   * terminal: the HTTP client shows the step-up dialog on `reauth_required`
   * and repeats the request, so callers only see the session or a refusal.
   */
  create: (request: Partial<CreateTerminalSessionRequest>) => api.post('/api/terminal/sessions', request, { schema: terminalSessionSchema, timeoutMs: 30_000 }),
  rename: (sessionId: string, title: string) => api.patch(`/api/terminal/sessions/${enc(sessionId)}`, { title }, { schema: terminalSessionSchema }),
  /** Ends the session and everything running in it; answers once the server has confirmed. */
  close: (sessionId: string) => api.delete(`/api/terminal/sessions/${enc(sessionId)}`, { schema: closeTerminalSessionResponseSchema, timeoutMs: 30_000 }),
  /** Types text as if from the keyboard. Enter is never pressed: the person does that. */
  type: (sessionId: string, text: string) => api.post(`/api/terminal/sessions/${enc(sessionId)}/input`, { text }, { schema: typeTextResponseSchema }),
};

export const terminalKeys = {
  capability: ['terminal', 'capability'] as const,
  sessions: (projectId: string | null) => ['terminal', 'sessions', projectId ?? ':all'] as const,
  all: ['terminal', 'sessions'] as const,
};

/** The WebSocket address for a same-origin path. */
export function socketUrl(path: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}
