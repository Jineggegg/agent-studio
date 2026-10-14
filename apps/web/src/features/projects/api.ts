import { type CloneProjectRequest, type ProjectAccess, cloneJobSchema, projectLinkStatusResponseSchema, projectMemberSchema, projectSchema } from '@agent-studio/protocol';
import { z } from 'zod';
import { api } from '@/data/api';

/** The requests behind a project's own page: its links, who it is shared with, and making one by cloning. */
const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const projectsApi = {
  project: (projectId: string, signal?: AbortSignal) => api.get(`/api/projects/${enc(projectId)}`, { schema: projectSchema, ...withSignal(signal) }),
  /** Whether each stored link answers, how, and how fast — never anything the site said. */
  linkStatus: (projectId: string, refresh = false, signal?: AbortSignal) =>
    api
      .get(`/api/projects/${enc(projectId)}/links/status`, { schema: projectLinkStatusResponseSchema, query: refresh ? { refresh: 'true' } : {}, timeoutMs: 40_000, ...withSignal(signal) })
      .then((answer) => answer.links),
  members: (projectId: string, signal?: AbortSignal) =>
    api.get(`/api/projects/${enc(projectId)}/members`, { schema: z.object({ members: z.array(projectMemberSchema) }), ...withSignal(signal) }).then((answer) => answer.members),
  setMember: (projectId: string, userId: string, access: ProjectAccess) => api.put(`/api/projects/${enc(projectId)}/members/${enc(userId)}`, { access }),
  removeMember: (projectId: string, userId: string) => api.delete(`/api/projects/${enc(projectId)}/members/${enc(userId)}`),

  clone: (request: CloneProjectRequest) => api.post('/api/projects/clone', request, { schema: cloneJobSchema, timeoutMs: 30_000 }),
  cloneJob: (cloneId: string, signal?: AbortSignal) => api.get(`/api/projects/clone/${enc(cloneId)}`, { schema: cloneJobSchema, ...withSignal(signal) }),
  cancelClone: (cloneId: string) => api.delete(`/api/projects/clone/${enc(cloneId)}`),
};

export const projectPageKeys = {
  project: (projectId: string) => ['projects', 'one', projectId] as const,
  links: (projectId: string) => ['projects', 'links', projectId] as const,
  members: (projectId: string) => ['projects', 'members', projectId] as const,
};
