import type { Run, UsageReport } from '@agent-studio/protocol';
import type { StudioEvent } from '../../../kernel/events.js';
import type { StudioModule } from '../../../kernel/module.js';
import { TestClient } from '../../../testing/harness.js';
import type { ScriptStep, ScriptedAdapter } from '../../../testing/scripted-adapter.js';
import { type StudioKit, type StudioKitOptions, TestClock, createStudioKit } from '../../inbox/testing/kit.js';
import { type UsageModuleOptions, createUsageModule } from '../usage.module.js';

/**
 * A Studio whose usage module runs on a clock the test moves, with short ways
 * to make runs that report usage and to place them in time.
 *
 * Usage records are made by real runs of the scripted agent. Only their
 * timestamp is moved afterwards (the runtime stamps them with the real time),
 * which is the one thing a test cannot wait for.
 */
export interface UsageWorld {
  readonly kit: StudioKit;
  readonly clock: TestClock;
  /** Everything published on `internal:usage` since the world was created. */
  readonly internal: StudioEvent[];
  /** One run that reports the given usage. Returns the finished run. */
  run(client: TestClient, sessionId: string, usage: readonly UsageStep[], agent?: ScriptedAdapter): Promise<Run>;
  /** Moves the usage records of a run to an instant. */
  place(runId: string, at: string | number): void;
  report(client: TestClient, query?: string): Promise<UsageReport>;
  /** A client that carries an API token of the given scopes, made by `as`. */
  token(as: TestClient, scopes: readonly string[]): Promise<TestClient>;
}

export interface UsageStep {
  readonly model?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
}

export interface UsageWorldOptions {
  readonly usage?: UsageModuleOptions;
  readonly kit?: StudioKitOptions;
  readonly replace?: Readonly<Record<string, StudioModule>>;
  readonly clock?: TestClock;
}

export const usageSteps = (usage: readonly UsageStep[]): ScriptStep[] => [
  ...usage.map(
    (step): ScriptStep => ({
      emit: {
        type: 'usage',
        model: step.model ?? 'scripted-large',
        inputTokens: step.input ?? 0,
        outputTokens: step.output ?? 0,
        ...(step.cacheRead === undefined ? {} : { cacheReadTokens: step.cacheRead }),
        ...(step.cacheWrite === undefined ? {} : { cacheWriteTokens: step.cacheWrite }),
        ...(step.cost === undefined ? {} : { costUsd: step.cost }),
      },
    }),
  ),
  { text: 'done' },
];

/** Call once per test file; `closeAll` belongs in `afterEach`. */
export function createUsageWorlds(): { start(options?: UsageWorldOptions): Promise<UsageWorld>; closeAll(): Promise<void> } {
  const worlds: UsageWorld[] = [];
  return {
    async start(options = {}) {
      const clock = options.clock ?? new TestClock();
      const kit = await createStudioKit({
        ...options.kit,
        replace: { usage: createUsageModule({ now: clock.now, ...options.usage }), ...options.replace, ...options.kit?.replace },
      });
      const internal: StudioEvent[] = [];
      kit.t.studio.context.bus.onTopic('internal:usage', (event) => internal.push(event));
      const world: UsageWorld = {
        kit,
        clock,
        internal,
        async run(client, sessionId, usage, agent = kit.agent) {
          agent.script(usageSteps(usage));
          return kit.turn(client, sessionId, 'do the work');
        },
        place(runId, at) {
          const instant = typeof at === 'string' ? Date.parse(at) : at;
          const changed = kit.t.studio.context.db.run('UPDATE agent_usage SET at = ? WHERE run_id = ?', instant, runId).changes;
          if (changed === 0) throw new Error(`Run ${runId} recorded no usage.`);
        },
        async report(client, query = '') {
          const response = await client.get<UsageReport>(`/api/usage/report${query === '' ? '' : `?${query}`}`);
          if (response.status !== 200) throw new Error(`Could not read the report: ${response.status} ${JSON.stringify(response.body)}`);
          return response.body;
        },
        async token(as, scopes) {
          const created = await as.post<{ token: string }>('/api/auth/tokens', { name: scopes.join('+'), scopes });
          if (created.status !== 201 && created.status !== 200) throw new Error(`Could not create a token: ${JSON.stringify(created.body)}`);
          const client = new TestClient(kit.t.studio);
          client.bearer = created.body.token;
          return client;
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
