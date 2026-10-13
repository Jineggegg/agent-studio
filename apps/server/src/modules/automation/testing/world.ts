import type { Automation, AutomationExecution, AutomationHistory, AutomationList, DeferredMessage } from '@agent-studio/protocol';
import type { TestClient, TestResponse } from '../../../testing/harness.js';
import { TestClock } from '../../inbox/testing/kit.js';
import { type World, type WorldOptions, createWorlds } from '../../inbox/testing/world.js';
import { type AutomationModuleOptions, createAutomationModule } from '../automation.module.js';

/**
 * A Studio whose scheduler runs on a clock the test sets — to any date, such
 * as the morning clocks change — and passes only when the test says `tick()`.
 */
export interface AutomationWorld extends World {
  /** The scheduler's clock. */
  readonly time: TestClock;
  /** One scheduler pass at `time`. */
  tick(): Promise<{ automations: number; deferred: number }>;
}

export interface AutomationWorldOptions extends WorldOptions {
  /** Where the scheduler's clock starts (an ISO instant). Defaults to the real time. */
  readonly at?: string;
  readonly automation?: AutomationModuleOptions;
  /** Reuse the scheduler's clock of a Studio that is being restarted. */
  readonly time?: TestClock;
}

export function createAutomationWorlds(): { start(options?: AutomationWorldOptions): Promise<AutomationWorld>; closeAll(): Promise<void> } {
  const worlds = createWorlds();
  return {
    async start(options = {}) {
      const time = options.time ?? new TestClock();
      if (options.at !== undefined) time.set(options.at);
      const world = await worlds.start({
        ...options,
        replace: {
          // No timer: a pass happens when the test asks for one.
          automation: createAutomationModule({ now: time.now, tickMs: 0, ...options.automation }),
          ...options.replace,
        },
      });
      return { ...world, time, tick: () => world.kit.t.studio.context.services.automation.tick() };
    },
    closeAll: () => worlds.closeAll(),
  };
}

/** A reminder every day at 08:00 UTC, unless told otherwise. */
export const reminder = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Stand-up',
  timeZone: 'UTC',
  trigger: { type: 'daily', time: '08:00' },
  action: { type: 'notify', message: 'Stand-up in five minutes' },
  ...overrides,
});

/** A prompt to the scripted agent every day at 08:00 UTC, in a new session, in `ask` mode, unless told otherwise. */
export const agentRun = (overrides: Record<string, unknown> = {}, action: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Nightly check',
  timeZone: 'UTC',
  trigger: { type: 'daily', time: '08:00' },
  action: { type: 'agent-run', agentId: 'scripted', prompt: 'Check the dependencies and report.', session: { type: 'new' }, permissionMode: 'ask', ...action },
  ...overrides,
});

export const createAutomation = (client: TestClient, projectId: string, body: Record<string, unknown>): Promise<TestResponse<Automation>> =>
  client.post<Automation>(`/api/projects/${projectId}/automations`, body);

/** Creates an automation and fails the test if that did not work. */
export async function automation(client: TestClient, projectId: string, body: Record<string, unknown>): Promise<Automation> {
  const response = await createAutomation(client, projectId, body);
  if (response.status !== 201) throw new Error(`Could not create the automation: ${JSON.stringify(response.body)}`);
  return response.body;
}

export const listAutomations = async (client: TestClient, projectId: string): Promise<AutomationList> =>
  (await client.get<AutomationList>(`/api/projects/${projectId}/automations`)).body;

export const getAutomation = async (client: TestClient, projectId: string, id: string): Promise<Automation> =>
  (await client.get<Automation>(`/api/projects/${projectId}/automations/${id}`)).body;

/** An automation's executions, oldest first. */
export const historyOf = async (client: TestClient, projectId: string, id: string): Promise<AutomationExecution[]> =>
  (await client.get<AutomationHistory>(`/api/projects/${projectId}/automations/${id}/runs?limit=100`)).body.runs.reverse();

export const deferredOf = async (client: TestClient, query = ''): Promise<DeferredMessage[]> =>
  (await client.get<{ messages: DeferredMessage[] }>(`/api/deferred-messages${query}`)).body.messages;
