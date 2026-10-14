import {
  type CreateMemoryNoteRequest,
  type MoveMemoryNoteRequest,
  type UpdateMemoryNoteRequest,
  memoryFoldersResponseSchema,
  memoryListResponseSchema,
  memoryNoteSchema,
  memoryReindexResponseSchema,
  memorySearchResponseSchema,
  memoryStatusSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * Shared memory: Markdown notes the user and every assistant read and write.
 * Note ids are paths (`my-app/decisions/deploy-rules`) and always travel in
 * the query or the body, never in the URL's path.
 */
export const memoryKeys = {
  all: ['memory'] as const,
  status: ['memory', 'status'] as const,
  folders: ['memory', 'folders'] as const,
  recent: (folder: string | null) => ['memory', 'recent', folder ?? ''] as const,
  search: (q: string, folder: string | null) => ['memory', 'search', q, folder ?? ''] as const,
  note: (id: string) => ['memory', 'note', id] as const,
};

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const memoryApi = {
  status: (signal?: AbortSignal) => api.get('/api/memory/status', { schema: memoryStatusSchema, ...withSignal(signal) }),
  setAgentAccess: (agentAccess: boolean) => api.put('/api/memory/settings', { agentAccess }, { schema: memoryStatusSchema }),
  reindex: () => api.post('/api/memory/reindex', undefined, { schema: memoryReindexResponseSchema, timeoutMs: 120_000 }),
  folders: (signal?: AbortSignal) => api.get('/api/memory/folders', { schema: memoryFoldersResponseSchema, ...withSignal(signal) }),
  recent: (folder: string | null, limit: number, offset: number, signal?: AbortSignal) =>
    api.get('/api/memory/notes', { schema: memoryListResponseSchema, query: { folder: folder ?? undefined, limit, offset }, ...withSignal(signal) }),
  search: (q: string, folder: string | null, signal?: AbortSignal) =>
    api.get('/api/memory/search', { schema: memorySearchResponseSchema, query: { q, folder: folder ?? undefined }, ...withSignal(signal) }),
  note: (id: string, signal?: AbortSignal) => api.get('/api/memory/note', { schema: memoryNoteSchema, query: { id }, ...withSignal(signal) }),
  create: (input: CreateMemoryNoteRequest) => api.post('/api/memory/notes', input, { schema: memoryNoteSchema }),
  update: (input: UpdateMemoryNoteRequest) => api.put('/api/memory/note', input, { schema: memoryNoteSchema }),
  move: (input: MoveMemoryNoteRequest) => api.post('/api/memory/note/move', input, { schema: memoryNoteSchema }),
  remove: (id: string, version: string | null) => api.delete('/api/memory/note', { query: { id, version: version ?? undefined } }),
};
