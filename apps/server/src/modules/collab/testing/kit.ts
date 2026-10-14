import type {
  Chain,
  CreateTaskResponse,
  HandoffResponse,
  Inbox,
  RunningWork,
  Session,
  SessionEvent,
  SessionHandoffs,
  Task,
  TaskList,
  UploadAttachmentsResponse,
} from '@agent-studio/protocol';
import type { StudioModule } from '../../../kernel/module.js';
import { TestClient, type TestResponse } from '../../../testing/harness.js';
import { type StudioKit, type StudioKitOptions, createStudioKit, nextRequestId, until } from '../../inbox/testing/kit.js';
import { type CollabModuleOptions, createCollabModule } from '../collab.module.js';

/**
 * A Studio for the collab tests: every module of the real server, scripted
 * agents, and short ways to hand over, to start tasks and to wait for them.
 */
export interface CollabWorld {
  readonly kit: StudioKit;
  handoff(client: TestClient, sessionId: string, body: Record<string, unknown>): Promise<TestResponse<HandoffResponse>>;
  /** Hands over and expects it to work. */
  handOver(client: TestClient, sessionId: string, body: Record<string, unknown>): Promise<HandoffResponse>;
  chain(client: TestClient, sessionId: string): Promise<Chain>;
  handoffs(client: TestClient, sessionId: string): Promise<SessionHandoffs>;
  events(client: TestClient, sessionId: string): Promise<SessionEvent[]>;
  createTask(client: TestClient, projectId: string, body: Record<string, unknown>): Promise<TestResponse<CreateTaskResponse>>;
  /** Starts a task and expects it to work. */
  startTask(client: TestClient, projectId: string, body: Record<string, unknown>): Promise<Task>;
  task(client: TestClient, taskId: string): Promise<Task>;
  tasks(client: TestClient, query?: string): Promise<TaskList>;
  /** Waits until a task satisfies the condition, and returns it. */
  taskWhen(client: TestClient, taskId: string, condition: (task: Task) => boolean, what?: string): Promise<Task>;
  running(client: TestClient): Promise<RunningWork>;
  inbox(client: TestClient): Promise<Inbox>;
  sessions(client: TestClient, query?: string): Promise<Session[]>;
  /** A client that carries an API token of the given scopes, made by `as`. */
  token(as: TestClient, scopes: readonly string[]): Promise<TestClient>;
  /** Uploads one file to a session and returns its attachment id. */
  upload(client: TestClient, sessionId: string, name: string, content: string): Promise<string>;
}

export interface CollabWorldOptions {
  readonly collab?: CollabModuleOptions;
  readonly kit?: StudioKitOptions;
  readonly replace?: Readonly<Record<string, StudioModule>>;
}

/** Call once per test file; `closeAll` belongs in `afterEach`. */
export function createCollabWorlds(): { start(options?: CollabWorldOptions): Promise<CollabWorld>; closeAll(): Promise<void> } {
  const worlds: CollabWorld[] = [];
  return {
    async start(options = {}) {
      const kit = await createStudioKit({
        ...options.kit,
        replace: { collab: createCollabModule(options.collab ?? {}), ...options.replace, ...options.kit?.replace },
      });
      const ok = <T>(response: TestResponse<T>, statuses: readonly number[], what: string): T => {
        if (!statuses.includes(response.status)) throw new Error(`${what}: ${response.status} ${JSON.stringify(response.body)}`);
        return response.body;
      };
      const world: CollabWorld = {
        kit,
        handoff: (client, sessionId, body) => client.post<HandoffResponse>(`/api/sessions/${sessionId}/handoff`, { requestId: nextRequestId(), ...body }),
        handOver: async (client, sessionId, body) => ok(await world.handoff(client, sessionId, body), [201], 'The handoff failed'),
        chain: async (client, sessionId) => ok(await client.get<Chain>(`/api/sessions/${sessionId}/chain`), [200], 'Could not read the chain'),
        handoffs: async (client, sessionId) => ok(await client.get<SessionHandoffs>(`/api/sessions/${sessionId}/handoffs`), [200], 'Could not read the handoffs'),
        events: async (client, sessionId) => ok(await client.get<{ events: SessionEvent[] }>(`/api/sessions/${sessionId}/events?after=0&limit=1000`), [200], 'Could not read events').events,
        createTask: (client, projectId, body) => client.post<CreateTaskResponse>(`/api/projects/${projectId}/tasks`, { requestId: nextRequestId(), ...body }),
        startTask: async (client, projectId, body) => ok(await world.createTask(client, projectId, body), [201], 'The task did not start').task,
        task: async (client, taskId) => ok(await client.get<Task>(`/api/tasks/${taskId}`), [200], 'Could not read the task'),
        tasks: async (client, query = '') => ok(await client.get<TaskList>(`/api/tasks${query === '' ? '' : `?${query}`}`), [200], 'Could not list tasks'),
        taskWhen: (client, taskId, condition, what = 'the task to change') =>
          until(
            async () => {
              const task = await world.task(client, taskId);
              return condition(task) ? task : null;
            },
            { what, timeoutMs: 10_000 },
          ),
        running: async (client) => ok(await client.get<RunningWork>('/api/work/running'), [200], 'Could not read running work'),
        inbox: async (client) => ok(await client.get<Inbox>('/api/inbox'), [200], 'Could not read the inbox'),
        sessions: async (client, query = 'archived=include') => ok(await client.get<{ sessions: Session[] }>(`/api/sessions?${query}`), [200], 'Could not list sessions').sessions,
        async token(as, scopes) {
          const created = ok(await as.post<{ token: string }>('/api/auth/tokens', { name: scopes.join('+'), scopes }), [200, 201], 'Could not create a token');
          const client = new TestClient(kit.t.studio);
          client.bearer = created.token;
          return client;
        },
        async upload(client, sessionId, name, content) {
          const boundary = `----studio-test-${Math.random().toString(16).slice(2)}`;
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="${name}"\r\ncontent-type: text/plain\r\n\r\n`),
            Buffer.from(content),
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          const response = await client.request<UploadAttachmentsResponse>('POST', `/api/sessions/${sessionId}/attachments`, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
          return ok(response, [201], 'The upload failed').attachments[0]!.id;
        },
      };
      worlds.push(world);
      return world;
    },
    async closeAll() {
      // Newest first: a restarted Studio shares its data directory with the one before it.
      for (const world of worlds.splice(0).reverse()) await world.kit.close();
    },
  };
}

export const errorOf = (response: { status: number; body: unknown }): [number, string | undefined] => [
  response.status,
  (response.body as { error?: { code?: string } } | undefined)?.error?.code,
];

export { nextRequestId, until };
