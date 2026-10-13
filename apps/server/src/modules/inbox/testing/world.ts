import type { Approval, Notification, NotificationList } from '@agent-studio/protocol';
import type { StudioModule } from '../../../kernel/module.js';
import type { TestClient } from '../../../testing/harness.js';
import type { PermissionRequest } from '../../agents/adapter.js';
import { type InboxModuleOptions, createInboxModule } from '../inbox.module.js';
import { type StudioKit, type StudioKitOptions, TestClock, createStudioKit, until } from './kit.js';
import { type FakeBrowser, PushStandIn } from './push-stand-in.js';

/**
 * A Studio whose notifications go to a stand-in push service and whose inbox
 * runs on a clock the test moves. Shared by the inbox and automation tests.
 */
export interface World {
  readonly kit: StudioKit;
  readonly push: PushStandIn;
  /** The inbox module's clock: the dedupe window, rate limits, "how old is this result". */
  readonly clock: TestClock;
}

export interface WorldOptions {
  readonly inbox?: InboxModuleOptions;
  readonly kit?: StudioKitOptions;
  /** Further modules to replace, by name (the automation module with its own clock, say). */
  readonly replace?: Readonly<Record<string, StudioModule>>;
  /** Reuse a stand-in and a clock, for a Studio restarted on the same data. */
  readonly push?: PushStandIn;
  readonly clock?: TestClock;
}

/** Call once per test file; `closeAll` belongs in `afterEach`. */
export function createWorlds(): { start(options?: WorldOptions): Promise<World>; closeAll(): Promise<void> } {
  const worlds: World[] = [];
  const standIns = new Set<PushStandIn>();
  return {
    async start(options = {}) {
      const push = options.push ?? (await PushStandIn.start());
      standIns.add(push);
      const clock = options.clock ?? new TestClock();
      const kit = await createStudioKit({
        ...options.kit,
        replace: {
          inbox: createInboxModule({
            now: clock.now,
            ...options.inbox,
            push: { allowedHosts: push.allowedHosts, policy: push.policy, timeoutMs: 2000, ...options.inbox?.push },
          }),
          ...options.replace,
        },
      });
      const world = { kit, push, clock };
      worlds.push(world);
      return world;
    },
    async closeAll() {
      // Newest first: a restarted Studio shares its data directory with the one before it.
      for (const world of worlds.splice(0).reverse()) await world.kit.close();
      for (const standIn of standIns) await standIn.close();
      standIns.clear();
    },
  };
}

export const bash = (command: string): PermissionRequest => ({ toolName: 'Bash', kind: 'execute', title: `Run ${command}`, input: { command }, command });

export async function subscribe(client: TestClient, browser: FakeBrowser, extra: Record<string, unknown> = {}): Promise<void> {
  const response = await client.post('/api/notifications/push/devices', browser.subscription(extra));
  if (response.status !== 200) throw new Error(`Could not subscribe: ${JSON.stringify(response.body)}`);
}

/** The caller's stored notifications, newest first. */
export const notifications = async (client: TestClient): Promise<Notification[]> =>
  (await client.get<NotificationList>('/api/notifications?order=newest&limit=100')).body.notifications;

/** Resolves when every push that was on its way has been answered. */
export const idle = (world: World): Promise<void> => world.kit.t.studio.context.services.inbox.idle();

/** A subscribed device, with the "notifications are on" confirmation already out of the way. */
export async function device(world: World, client: TestClient, name = 'phone'): Promise<FakeBrowser> {
  const browser = world.push.browser(name);
  await subscribe(client, browser);
  await idle(world);
  world.push.received.length = 0;
  await client.post('/api/notifications/clear', { scope: 'all' });
  return browser;
}

export async function pending(kit: StudioKit, client: TestClient, sessionId: string): Promise<Approval> {
  return until(async () => (await kit.state(client, sessionId)).pendingApprovals[0], { what: 'a pending approval' });
}
