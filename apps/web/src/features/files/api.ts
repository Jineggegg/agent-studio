import {
  type CreateEntryRequest,
  type SaveFileRequest,
  UPLOAD_FILE_FIELD,
  UPLOAD_PATH_FIELD,
  fileContentSchema,
  fileContentSearchSchema,
  fileLimitsSchema,
  fileListingSchema,
  fileNameSearchSchema,
  savedFileSchema,
  uploadResultSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * Every request the files panel makes. Paths are project-relative with
 * forward slashes; the empty string is the project folder itself.
 */
const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}/files`;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export interface UploadItem {
  file: File;
  /** Where the file goes under the target folder, when a dropped folder's structure is being recreated. */
  relativePath?: string | undefined;
}

export const filesApi = {
  /** One folder. Ignored entries come along, marked, so that a `.env` stays reachable. */
  list: (projectId: string, path: string, signal?: AbortSignal) => api.get(`${base(projectId)}/list`, { schema: fileListingSchema, query: { path, ignored: 'show' }, ...withSignal(signal) }),
  searchNames: (projectId: string, query: string, limit: number, signal?: AbortSignal) =>
    api.get(`${base(projectId)}/search`, { schema: fileNameSearchSchema, query: { query, limit }, ...withSignal(signal) }),
  searchContent: (projectId: string, query: string, signal?: AbortSignal) =>
    api.get(`${base(projectId)}/grep`, { schema: fileContentSearchSchema, query: { query, limit: 200 }, timeoutMs: 30_000, ...withSignal(signal) }),
  content: (projectId: string, path: string, signal?: AbortSignal) => api.get(`${base(projectId)}/content`, { schema: fileContentSchema, query: { path }, timeoutMs: 30_000, ...withSignal(signal) }),
  save: (projectId: string, request: SaveFileRequest) => api.put(`${base(projectId)}/content`, request, { schema: savedFileSchema, timeoutMs: 60_000 }),
  create: (projectId: string, request: CreateEntryRequest) => api.post(`${base(projectId)}/entries`, request),
  move: (projectId: string, from: string, to: string) => api.post(`${base(projectId)}/move`, { from, to }),
  remove: (projectId: string, path: string, recursive: boolean) => api.post(`${base(projectId)}/delete`, { path, recursive }),
  limits: (signal?: AbortSignal) => api.get('/api/files/limits', { schema: fileLimitsSchema, ...withSignal(signal) }),
  upload: (projectId: string, target: string, items: readonly UploadItem[], options: { overwrite?: boolean; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}) => {
    const form = new FormData();
    for (const item of items) {
      // The path part belongs to the file part that follows it.
      if (item.relativePath) form.append(UPLOAD_PATH_FIELD, item.relativePath);
      form.append(UPLOAD_FILE_FIELD, item.file, item.file.name);
    }
    return api.upload(`${base(projectId)}/upload`, form, {
      schema: uploadResultSchema,
      query: { target, overwrite: options.overwrite ? 'true' : 'false' },
      timeoutMs: 15 * 60_000,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...withSignal(options.signal),
    });
  },
  /** The file's bytes. `inline` is honoured by the server only for the media it is willing to show, and always sandboxed. */
  rawUrl: (projectId: string, path: string, disposition: 'attachment' | 'inline' = 'attachment') => `${base(projectId)}/raw?path=${enc(path)}&disposition=${disposition}`,
  /** A folder as a ZIP of exactly what the tree shows. */
  archiveUrl: (projectId: string, path: string) => `${base(projectId)}/archive?path=${enc(path)}`,
};

export const filesKeys = {
  limits: ['files', 'limits'] as const,
  names: (projectId: string, query: string) => ['files', projectId, 'names', query] as const,
  content: (projectId: string, query: string) => ['files', projectId, 'grep', query] as const,
};
