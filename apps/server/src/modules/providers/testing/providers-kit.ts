import path from 'node:path';
import type {
  Approval,
  ApprovalDecisionResponse,
  CreateProviderInput,
  MessageReceipt,
  Project,
  Provider,
  ProviderModelInput,
  Run,
  Session,
  SessionEvent,
  SessionSnapshot,
} from '@agent-studio/protocol';
import type { ConfigOverrides } from '../../../kernel/config.js';
import { nextRequestId, until } from '../../../testing/agents-kit.js';
import { type TestClient, type TestResponse, type TestStudio, createTestStudio } from '../../../testing/harness.js';
import { type AgentsModuleOptions, createAgentsModule } from '../../agents/agents.module.js';
import { modules as allModules } from '../../index.js';
import { type ProvidersModuleOptions, createProvidersModule } from '../providers.module.js';
import { FakeOpenAI } from './fake-openai.js';

/**
 * What the integration tests of the providers module share: a whole Studio,
 * the stand-in model server, a project to work in, and short ways to
 * configure a provider, talk to it and answer its approvals.
 */

export const TEST_KEY = 'sk-test-0123456789abcdefghijklmnopqrstuv';

export const TEST_MODELS: ProviderModelInput[] = [
  { id: 'fake-model', name: 'Fake Model', contextWindow: 64_000, tools: true, prices: { input: 1, cachedInput: 0.1, output: 2 } },
  { id: 'fake-vision', name: 'Fake Vision', contextWindow: 64_000, images: true },
  { id: 'fake-plain', name: 'Fake Plain' },
];

export interface ProvidersKit {
  readonly t: TestStudio;
  readonly model: FakeOpenAI;
  readonly owner: TestClient;
  readonly project: Project;
  makeProject(name: string): Promise<Project>;
  share(project: Project, member: TestClient, access?: 'read' | 'write'): Promise<void>;
  /** Creates a provider that points at the stand-in server, with a key and the private network allowed. */
  provider(overrides?: Partial<CreateProviderInput>): Promise<Provider>;
  /** A session with a provider's agent, in the kit's project unless `projectId` says otherwise. */
  session(provider: Provider, client?: TestClient, overrides?: Record<string, unknown>): Promise<Session>;
  send(client: TestClient, sessionId: string, text: string, extra?: Record<string, unknown>): Promise<TestResponse<MessageReceipt>>;
  /** Sends a message and waits for the run it starts to end. */
  turn(client: TestClient, sessionId: string, text: string, extra?: Record<string, unknown>): Promise<Run>;
  runEnded(client: TestClient, runId: string, timeoutMs?: number): Promise<Run>;
  events(client: TestClient, sessionId: string): Promise<SessionEvent[]>;
  state(client: TestClient, sessionId: string): Promise<SessionSnapshot>;
  /** Waits until `count` approvals are pending in a session. */
  pending(client: TestClient, sessionId: string, count?: number): Promise<Approval[]>;
  decide(client: TestClient, approvalId: string, body: Record<string, unknown>): Promise<TestResponse<ApprovalDecisionResponse>>;
  /** Absolute path of a file in the kit's project. */
  file(...segments: string[]): string;
  close(): Promise<void>;
}

export interface ProvidersKitOptions {
  readonly providers?: ProvidersModuleOptions;
  readonly agents?: AgentsModuleOptions;
  readonly config?: ConfigOverrides;
}

export async function createProvidersKit(options: ProvidersKitOptions = {}): Promise<ProvidersKit> {
  const model = await FakeOpenAI.start();
  const modules = allModules.map((module) =>
    module.name === 'providers' ? createProvidersModule(options.providers ?? {}) : module.name === 'agents' ? createAgentsModule(options.agents ?? {}) : module,
  );
  const t = await createTestStudio({ modules, ...(options.config ? { config: options.config } : {}) });
  const owner = await t.owner();

  const makeProject = async (name: string): Promise<Project> => {
    const response = await owner.post<Project>('/api/projects', { name, rootDir: path.join(t.workspace, name), createDirectory: true });
    if (response.status !== 201) throw new Error(`Could not create project ${name}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const project = await makeProject('demo');
  let providerCount = 0;

  const kit: ProvidersKit = {
    t,
    model,
    owner,
    project,
    makeProject,
    async share(target, member, access = 'write') {
      const response = await owner.put(`/api/projects/${target.id}/members/${member.userId}`, { access });
      if (response.status !== 204) throw new Error(`Could not share the project: ${JSON.stringify(response.body)}`);
    },
    async provider(overrides = {}) {
      providerCount += 1;
      const response = await owner.post<Provider>('/api/providers', {
        id: `fake${providerCount}`,
        name: `Fake ${providerCount}`,
        baseUrl: model.url,
        allowPrivateNetwork: true,
        models: TEST_MODELS,
        // A test that brings its own catalogue gets its first model as the default.
        ...(overrides.models === undefined ? { defaultModel: 'fake-model' } : {}),
        apiKey: TEST_KEY,
        ...overrides,
      });
      if (response.status !== 201) throw new Error(`Could not create a provider: ${JSON.stringify(response.body)}`);
      return response.body;
    },
    async session(provider, client = owner, overrides = {}) {
      const response = await client.post<Session>('/api/sessions', { projectId: project.id, agentId: provider.agentId, ...overrides });
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
    runEnded(client, runId, timeoutMs = 10_000) {
      return until(
        async () => {
          const run = (await client.get<Run>(`/api/runs/${runId}`)).body;
          return run.status !== 'accepted' && run.status !== 'running' ? run : null;
        },
        { what: `run ${runId} to end`, timeoutMs },
      );
    },
    async events(client, sessionId) {
      const response = await client.get<{ events: SessionEvent[] }>(`/api/sessions/${sessionId}/events?after=0&limit=1000`);
      if (response.status !== 200) throw new Error(`Could not read events: ${JSON.stringify(response.body)}`);
      return response.body.events;
    },
    async state(client, sessionId) {
      return (await client.get<SessionSnapshot>(`/api/sessions/${sessionId}/state`)).body;
    },
    pending(client, sessionId, count = 1) {
      return until(
        async () => {
          const approvals = (await kit.state(client, sessionId)).pendingApprovals;
          return approvals.length >= count ? approvals : null;
        },
        { what: `${count} pending approval(s)` },
      );
    },
    decide(client, approvalId, body) {
      return client.post<ApprovalDecisionResponse>(`/api/approvals/${approvalId}/decision`, body);
    },
    file(...segments) {
      return path.join(project.rootDir, ...segments);
    },
    async close() {
      await t.close();
      await model.close();
    },
  };
  return kit;
}

/** The events of one type, with their data typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function eventsOf(events: readonly SessionEvent[], type: string): any[] {
  return events.filter((event) => event.type === type).map((event) => event.data);
}
