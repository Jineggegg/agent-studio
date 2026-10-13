import path from 'node:path';
import type { MessageReceipt, Project, Run, ServerFrame, Session, SessionEvent, SessionSnapshot } from '@agent-studio/protocol';
import WebSocket from 'ws';
import type { ConfigOverrides } from '../kernel/config.js';
import type { StudioEvent } from '../kernel/events.js';
import type { StudioModule } from '../kernel/module.js';
import { type AgentsModuleOptions, createAgentsModule } from '../modules/agents/agents.module.js';
import { modules as allModules } from '../modules/index.js';
import { type TestClient, type TestResponse, type TestStudio, createTestStudio } from './harness.js';
import { ScriptedAdapter, scriptedModule } from './scripted-adapter.js';

/**
 * What the agent runtime's integration tests share: a Studio with a scripted
 * agent, a project to work in, and short ways to send, wait and watch.
 */

export interface Live {
  readonly socket: WebSocket;
  readonly frames: ServerFrame[];
  send(frame: unknown): void;
  /** The first frame — already received or still to come — that matches. */
  next<T extends ServerFrame = ServerFrame>(predicate: (frame: ServerFrame) => boolean, timeoutMs?: number): Promise<T>;
  /** Subscribes and resolves with the `subscribed` (or `rejected`) frame. */
  subscribe(topic: string, after?: number): Promise<ServerFrame>;
  /** Every `event` frame received so far on a topic. */
  events(topic: string): Array<Extract<ServerFrame, { op: 'event' }>>;
  close(): void;
}

export interface AgentsKit {
  readonly t: TestStudio;
  readonly agent: ScriptedAdapter;
  readonly owner: TestClient;
  readonly project: Project;
  /** Events published on `internal:runs` since the kit was created. */
  readonly internal: StudioEvent[];
  makeProject(name: string): Promise<Project>;
  share(project: Project, member: TestClient, access?: 'read' | 'write'): Promise<void>;
  session(client?: TestClient, overrides?: Record<string, unknown>): Promise<Session>;
  send(client: TestClient, sessionId: string, text: string, extra?: Record<string, unknown>): Promise<TestResponse<MessageReceipt>>;
  /** Sends a message and waits for the run it starts to end. */
  turn(client: TestClient, sessionId: string, text: string, extra?: Record<string, unknown>): Promise<Run>;
  events(client: TestClient, sessionId: string): Promise<SessionEvent[]>;
  state(client: TestClient, sessionId: string): Promise<SessionSnapshot>;
  runEnded(client: TestClient, runId: string): Promise<Run>;
  idle(client: TestClient, sessionId: string): Promise<void>;
  /** Starts the server on a real port (once): start-up work such as recovery runs, and sockets can connect. */
  listen(): Promise<{ url: string; wsUrl: string; port: number }>;
  connect(client: TestClient): Promise<Live>;
  close(): Promise<void>;
}

let requestCounter = 0;
export const nextRequestId = (): string => `req-${Date.now().toString(36)}-${(requestCounter += 1)}`;

export async function until<T>(probe: () => T | Promise<T>, options: { timeoutMs?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.what ?? 'a condition'}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface KitOptions {
  readonly agents?: AgentsModuleOptions;
  readonly adapters?: readonly ScriptedAdapter[];
  readonly extraModules?: readonly StudioModule[];
  readonly config?: ConfigOverrides;
  /** Reuse the data of an earlier Studio (to simulate a restart): no owner or project is created. */
  readonly restartOf?: AgentsKit;
}

export async function createAgentsKit(options: KitOptions = {}): Promise<AgentsKit> {
  const agent = options.adapters?.[0] ?? new ScriptedAdapter();
  const adapters = options.adapters ?? [agent];
  const previous = options.restartOf;
  const modules = [
    ...allModules.map((module) => (module.name === 'agents' ? createAgentsModule(options.agents ?? {}) : module)),
    scriptedModule(...adapters),
    ...(options.extraModules ?? []),
  ];
  const t = await createTestStudio({
    modules,
    config: { ...(previous ? { dataDir: previous.t.studio.context.config.dataDir, workspaceRoots: [...previous.t.studio.context.config.workspaceRoots] } : {}), ...options.config },
  });
  const internal: StudioEvent[] = [];
  t.studio.context.bus.onTopic('internal:runs', (event) => internal.push(event));

  const owner = previous ? await t.signIn('owner') : await t.owner();
  const sockets: WebSocket[] = [];
  let address: { url: string; wsUrl: string; port: number } | null = null;

  const makeProject = async (name: string): Promise<Project> => {
    const response = await owner.post<Project>('/api/projects', { name, rootDir: path.join(t.workspace, name), createDirectory: true });
    if (response.status !== 201) throw new Error(`Could not create project ${name}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const project = previous ? previous.project : await makeProject('demo');

  const kit: AgentsKit = {
    t,
    agent,
    owner,
    project,
    internal,
    makeProject,
    async share(target, member, access = 'write') {
      const response = await owner.put(`/api/projects/${target.id}/members/${member.userId}`, { access });
      if (response.status !== 204) throw new Error(`Could not share the project: ${JSON.stringify(response.body)}`);
    },
    async session(client = owner, overrides = {}) {
      const response = await client.post<Session>('/api/sessions', { projectId: project.id, agentId: agent.id, ...overrides });
      if (response.status !== 201) throw new Error(`Could not create a session: ${JSON.stringify(response.body)}`);
      return response.body;
    },
    send(client, sessionId, text, extra = {}) {
      return client.post<MessageReceipt>(`/api/sessions/${sessionId}/messages`, { requestId: nextRequestId(), text, ...extra });
    },
    async turn(client, sessionId, text, extra = {}) {
      const receipt = await kit.send(client, sessionId, text, extra);
      if (receipt.status !== 202 || !receipt.body.runId) throw new Error(`The message did not start a run: ${JSON.stringify(receipt.body)}`);
      return kit.runEnded(client, receipt.body.runId);
    },
    async events(client, sessionId) {
      const response = await client.get<{ events: SessionEvent[] }>(`/api/sessions/${sessionId}/events?after=0&limit=1000`);
      if (response.status !== 200) throw new Error(`Could not read events: ${JSON.stringify(response.body)}`);
      return response.body.events;
    },
    async state(client, sessionId) {
      return (await client.get<SessionSnapshot>(`/api/sessions/${sessionId}/state`)).body;
    },
    runEnded(client, runId) {
      return until(
        async () => {
          const run = (await client.get<Run>(`/api/runs/${runId}`)).body;
          return run.status !== 'accepted' && run.status !== 'running' ? run : null;
        },
        { what: `run ${runId} to end` },
      );
    },
    async idle(client, sessionId) {
      await until(async () => (await kit.state(client, sessionId)).run === null, { what: 'the session to be idle' });
    },
    async listen() {
      address ??= await t.listen();
      return address;
    },
    async connect(client) {
      const { url, wsUrl } = await kit.listen();
      return new Promise<Live>((resolve, reject) => {
        const socket = new WebSocket(`${wsUrl}/api/realtime`, {
          headers: { origin: url, ...(client.cookie ? { cookie: client.cookie } : {}), ...(client.bearer ? { authorization: `Bearer ${client.bearer}` } : {}) },
        });
        sockets.push(socket);
        const frames: ServerFrame[] = [];
        const waiters: Array<{ predicate: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }> = [];
        socket.on('message', (raw: WebSocket.RawData) => {
          const frame = JSON.parse(String(raw as Buffer)) as ServerFrame;
          frames.push(frame);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(frame)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        });
        const live: Live = {
          socket,
          frames,
          send: (frame) => socket.send(JSON.stringify(frame)),
          next: <T extends ServerFrame>(predicate: (frame: ServerFrame) => boolean, timeoutMs = 5000) =>
            new Promise<T>((found, timedOut) => {
              const existing = frames.find(predicate);
              if (existing) return found(existing as T);
              const timer = setTimeout(() => timedOut(new Error('Timed out waiting for a frame.')), timeoutMs);
              waiters.push({
                predicate,
                resolve: (frame) => {
                  clearTimeout(timer);
                  found(frame as T);
                },
              });
            }),
          subscribe: (topic, after) => {
            const seen = frames.length;
            live.send({ op: 'subscribe', topic, ...(after === undefined ? {} : { after }) });
            return live.next((frame) => frames.indexOf(frame) >= seen && (frame.op === 'subscribed' || frame.op === 'rejected') && frame.topic === topic);
          },
          events: (topic) => frames.filter((frame): frame is Extract<ServerFrame, { op: 'event' }> => frame.op === 'event' && frame.topic === topic),
          close: () => socket.terminate(),
        };
        socket.once('open', () => resolve(live));
        socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
        socket.once('error', reject);
      });
    },
    async close() {
      for (const socket of sockets.splice(0)) socket.terminate();
      await t.close();
    },
  };
  return kit;
}
