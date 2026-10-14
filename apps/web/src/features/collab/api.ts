import {
  type CreateTaskInput,
  type HandoffInput,
  chainSchema,
  createTaskResponseSchema,
  deleteTaskResponseSchema,
  handoffResponseSchema,
  runningWorkSchema,
  sessionHandoffsSchema,
  taskListSchema,
  taskSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * Every request of working with more than one agent — handing a
 * conversation on, multi-agent tasks, the list of running work — each
 * validated against the protocol's schema.
 */
const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export interface TaskListParams {
  /** Null lists the caller's tasks in every project they can see. */
  projectId: string | null;
  state: 'open' | 'all';
}

export const collabKeys = {
  all: ['collab'] as const,
  handoffs: (sessionId: string) => ['collab', 'handoffs', sessionId] as const,
  chain: (sessionId: string) => ['collab', 'chain', sessionId] as const,
  tasks: ['collab', 'tasks'] as const,
  taskList: (params: TaskListParams) => ['collab', 'tasks', 'list', params] as const,
  task: (taskId: string) => ['collab', 'tasks', 'one', taskId] as const,
  running: ['collab', 'running'] as const,
};

export const collabApi = {
  /** A summary written by a model can take up to a minute and a half on the server. */
  handOff: (sessionId: string, request: HandoffInput) => api.post(`/api/sessions/${enc(sessionId)}/handoff`, request, { schema: handoffResponseSchema, timeoutMs: 150_000 }),
  handoffs: (sessionId: string, signal?: AbortSignal) => api.get(`/api/sessions/${enc(sessionId)}/handoffs`, { schema: sessionHandoffsSchema, ...withSignal(signal) }),
  chain: (sessionId: string, signal?: AbortSignal) => api.get(`/api/sessions/${enc(sessionId)}/chain`, { schema: chainSchema, ...withSignal(signal) }),

  createTask: (projectId: string, request: CreateTaskInput) => api.post(`/api/projects/${enc(projectId)}/tasks`, request, { schema: createTaskResponseSchema, timeoutMs: 120_000 }),
  tasks: (params: TaskListParams & { before?: string; limit?: number }, signal?: AbortSignal) =>
    api.get(params.projectId ? `/api/projects/${enc(params.projectId)}/tasks` : '/api/tasks', {
      schema: taskListSchema,
      query: { state: params.state, limit: params.limit ?? 20, before: params.before },
      ...withSignal(signal),
    }),
  task: (taskId: string, signal?: AbortSignal) => api.get(`/api/tasks/${enc(taskId)}`, { schema: taskSchema, ...withSignal(signal) }),
  stopTask: (taskId: string) => api.post(`/api/tasks/${enc(taskId)}/stop`, undefined, { schema: taskSchema }),
  deleteTask: (taskId: string) => api.delete(`/api/tasks/${enc(taskId)}`, { schema: deleteTaskResponseSchema }),

  running: (signal?: AbortSignal) => api.get('/api/work/running', { schema: runningWorkSchema, ...withSignal(signal) }),
  /** Stops one entry of the running list: the route it names, nothing else. */
  stop: (action: { method: 'POST'; url: string }) => {
    if (!/^\/api\/(sessions|tasks)\/[0-9a-z]{26}\/stop$/.test(action.url)) return Promise.reject(new Error('unexpected stop address'));
    return api.post(action.url);
  },
};
