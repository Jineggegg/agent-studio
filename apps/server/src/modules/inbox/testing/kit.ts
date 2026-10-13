import path from 'node:path';
import type { MessageReceipt, Project, Run, Session, SessionSnapshot } from '@agent-studio/protocol';
import type { ConfigOverrides } from '../../../kernel/config.js';
import type { StudioEvent } from '../../../kernel/events.js';
import type { StudioModule } from '../../../kernel/module.js';
import { nextRequestId, until } from '../../../testing/agents-kit.js';
import { type TestClient, type TestResponse, type TestStudio, createTestStudio } from '../../../testing/harness.js';
import { ScriptedAdapter, scriptedModule } from '../../../testing/scripted-adapter.js';
import { type AgentsModuleOptions, createAgentsModule } from '../../agents/agents.module.js';
import { modules as allModules } from '../../index.js';

/**
 * A Studio for the inbox and automation tests: every module of the real
 * server, a scripted agent, and the chance to swap a module for one built
 * with test options (a clock, a stand-in push service). It mirrors
 * `createAgentsKit`, which cannot replace modules.
 */

/** A clock tests move by hand. It starts at the real time unless told otherwise. */
export class TestClock {
  #offset = 0;
  #fixed: number | null = null;

  readonly now = (): number => (this.#fixed ?? Date.now()) + this.#offset;

  /** Freezes the clock at an instant; `advance` then moves it from there. */
  set(at: number | string): void {
    this.#fixed = typeof at === 'string' ? Date.parse(at) : at;
    this.#offset = 0;
  }

  advance(ms: number): void {
    this.#offset += ms;
  }
}

export interface StudioKitOptions {
  /** Modules to use instead of the registered ones, by name. */
  readonly replace?: Readonly<Record<string, StudioModule>>;
  readonly agents?: AgentsModuleOptions;
  readonly adapters?: readonly ScriptedAdapter[];
  readonly extraModules?: readonly StudioModule[];
  readonly config?: ConfigOverrides;
  /** Reuse the data of an earlier Studio (to simulate a restart): no owner or project is created. */
  readonly restartOf?: StudioKit;
}

export interface StudioKit {
  readonly t: TestStudio;
  readonly agent: ScriptedAdapter;
  readonly owner: TestClient;
  /** A project with automations switched on. */
  readonly project: Project;
  /** Every event published on the bus since the kit was created. */
  readonly published: StudioEvent[];
  /** Events sent to one user's topic, optionally of one type. */
  userEvents(userId: string | null, type?: string): StudioEvent[];
  makeProject(name: string, extra?: Record<string, unknown>): Promise<Project>;
  share(project: Project, member: TestClient, access?: 'read' | 'write' | null): Promise<void>;
  session(client?: TestClient, overrides?: Record<string, unknown>): Promise<Session>;
  send(client: TestClient, sessionId: string, text: string, extra?: Record<string, unknown>): Promise<TestResponse<MessageReceipt>>;
  /** Sends a message and waits for the run it starts to end. */
  turn(client: TestClient, sessionId: string, text: string, extra?: Record<string, unknown>): Promise<Run>;
  runEnded(client: TestClient, runId: string): Promise<Run>;
  state(client: TestClient, sessionId: string): Promise<SessionSnapshot>;
  /** Reports which sessions a client has visibly on screen. */
  looksAt(client: TestClient, sessionIds: readonly string[], tab?: string): Promise<void>;
  /** Starts the server on a real port (once): start-up work such as recovery runs. */
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

export async function createStudioKit(options: StudioKitOptions = {}): Promise<StudioKit> {
  const agent = options.adapters?.[0] ?? new ScriptedAdapter();
  const adapters = options.adapters ?? [agent];
  const previous = options.restartOf;
  const replaced = { agents: createAgentsModule(options.agents ?? {}), ...options.replace };
  const modules = [
    ...allModules.map((module) => (replaced as Record<string, StudioModule>)[module.name] ?? module),
    scriptedModule(...adapters),
    ...(options.extraModules ?? []),
  ];
  const t = await createTestStudio({
    modules,
    config: {
      ...(previous ? { dataDir: previous.t.studio.context.config.dataDir, workspaceRoots: [...previous.t.studio.context.config.workspaceRoots] } : {}),
      ...options.config,
    },
  });
  const published: StudioEvent[] = [];
  t.studio.context.bus.subscribeAll((event) => published.push(event));

  const owner = previous ? await t.signIn('owner') : await t.owner();
  let address: { url: string; port: number } | null = null;

  const makeProject = async (name: string, extra: Record<string, unknown> = {}): Promise<Project> => {
    const response = await owner.post<Project>('/api/projects', {
      name,
      rootDir: path.join(previous ? previous.t.workspace : t.workspace, name),
      createDirectory: true,
      features: { automation: true },
      ...extra,
    });
    if (response.status !== 201) throw new Error(`Could not create project ${name}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const project = previous ? previous.project : await makeProject('demo');

  const kit: StudioKit = {
    t,
    agent,
    owner,
    project,
    published,
    userEvents: (userId, type) => published.filter((event) => event.topic === `user:${userId}` && (type === undefined || event.type === type)),
    makeProject,
    async share(target, member, access = 'write') {
      const url = `/api/projects/${target.id}/members/${member.userId}`;
      const response = access === null ? await owner.delete(url) : await owner.put(url, { access });
      if (response.status !== 204) throw new Error(`Could not change the project's members: ${JSON.stringify(response.body)}`);
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
    runEnded(client, runId) {
      return until(
        async () => {
          const run = (await client.get<Run>(`/api/runs/${runId}`)).body;
          return run.status !== 'accepted' && run.status !== 'running' ? run : null;
        },
        { what: `run ${runId} to end` },
      );
    },
    async state(client, sessionId) {
      return (await client.get<SessionSnapshot>(`/api/sessions/${sessionId}/state`)).body;
    },
    async looksAt(client, sessionIds, tab = 'tab-0000-test') {
      const response = await client.put('/api/sessions/presence', { clientId: tab, visible: sessionIds });
      if (response.status !== 204) throw new Error(`Could not report presence: ${JSON.stringify(response.body)}`);
    },
    async listen() {
      address ??= await t.listen();
      return address;
    },
    close: () => t.close(),
  };
  return kit;
}

export { nextRequestId, until };
