import { remoteHostListSchema, remoteHostStatusSchema } from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * Remote machines are defined by the operator in a file on the server and are
 * read-only here: a browser lists them, asks whether one is reachable, and
 * names one by its id when it opens a terminal there. It never supplies a
 * host name, a user, a key or a command.
 */
const enc = encodeURIComponent;

export const remotesApi = {
  hosts: (signal?: AbortSignal) => api.get('/api/remotes/hosts', { schema: remoteHostListSchema, ...(signal ? { signal } : {}) }),
  /** One non-interactive check, cached on the server; `refresh` asks for a new one (at most every few seconds). */
  status: (hostId: string, refresh = false, signal?: AbortSignal) =>
    api.get(`/api/remotes/hosts/${enc(hostId)}/status`, { schema: remoteHostStatusSchema, query: refresh ? { refresh: 1 } : {}, timeoutMs: 30_000, ...(signal ? { signal } : {}) }),
};

export const remotesKeys = {
  hosts: ['remotes', 'hosts'] as const,
  status: (hostId: string) => ['remotes', 'status', hostId] as const,
};
