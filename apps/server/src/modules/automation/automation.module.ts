import { AUTOMATION_LIMITS, type ProjectAccess } from '@agent-studio/protocol';
import { describeError } from '../../kernel/errors.js';
import type { StudioEvent } from '../../kernel/events.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { redactSecrets } from '../../kernel/redact.js';
import { DeferredMessages } from './deferred.js';
import { registerAutomationRoutes } from './routes.js';
import { AUTOMATION_MIGRATIONS } from './schema.js';
import { AutomationService, type RunEnded } from './service.js';
import { AutomationStore } from './store.js';

/**
 * Automations and deferred messages.
 *
 * ## The scheduler
 *
 * One loop, one timer. Every pass ({@link AutomationModuleService.tick}) reads
 * the clock once, then for each automation whose time has come:
 *
 * 1. **claims** it in a database transaction — the schedule moves on and the
 *    execution is recorded as open, or as skipped, or as missed;
 * 2. carries out only what it claimed.
 *
 * and likewise for deferred messages (pending → sending is the claim).
 *
 * What follows from that, and holds whatever the timing:
 *
 * - an occurrence is carried out at most once — by two passes at once, by two
 *   processes on one data directory, or across a crash and restart;
 * - an automation never overlaps itself: due again while its previous
 *   execution is open, it is recorded as "skipped: still running";
 * - a run that came due while the server was down is made up once if the
 *   server is back within the grace window (six hours), and recorded as
 *   missed otherwise — only ever the most recent occurrence;
 * - a one-off switches itself off when it is claimed;
 * - nothing is retried: what was open when the process ended is closed as
 *   interrupted at the next start, and stays that way.
 *
 * The clock is a function. Tests pass their own and call `tick()` themselves;
 * production uses the real one and a timer that is stopped in `stop`.
 *
 * ## What it listens to
 *
 * `internal:runs` — `run.started`, `run.finished`, `run.interrupted`: to
 * follow the runs it started to their end, and for the `run-failed` event
 * trigger. `notice` on a session's topic with code `approval_skipped`: the
 * engine denied a request of an unattended run because nobody was there.
 * `project.membership.changed`: a creator who can no longer write in a
 * project has their automations there switched off. Deleting a project or an
 * account removes what belonged to it through the database.
 */
export interface AutomationModuleService {
  /** One scheduler pass at the module's clock. Resolves when everything that was due has been claimed and started. */
  tick(): Promise<{ automations: number; deferred: number }>;
}

declare module '../../kernel/module.js' {
  interface Services {
    automation: AutomationModuleService;
  }
}

export interface AutomationModuleOptions {
  /** The clock every decision about time is made with. */
  readonly now?: () => number;
  /** How late a run may be made up. */
  readonly graceMs?: number;
  /** Time between scheduler passes. 0: no timer — passes happen only when `tick()` is called. */
  readonly tickMs?: number;
  /** Delay before the first pass after start-up. */
  readonly firstTickMs?: number;
}

export const DEFAULT_TICK_MS = 30_000;
export const DEFAULT_FIRST_TICK_MS = 5_000;

interface Instance {
  readonly automations: AutomationService;
  readonly deferred: DeferredMessages;
  readonly tick: () => Promise<{ automations: number; deferred: number }>;
  readonly unsubscribe: Array<() => void>;
  first: NodeJS.Timeout | null;
  timer: NodeJS.Timeout | null;
  passing: Promise<unknown> | null;
  stopped: boolean;
}

export function createAutomationModule(options: AutomationModuleOptions = {}): StudioModule {
  // One module object may serve several Studios in one process (tests do this), so nothing is kept per module.
  const instances = new WeakMap<ModuleContext, Instance>();

  const shutDown = async (context: ModuleContext): Promise<void> => {
    const instance = instances.get(context);
    if (!instance || instance.stopped) return;
    instance.stopped = true;
    if (instance.first) clearTimeout(instance.first);
    if (instance.timer) clearInterval(instance.timer);
    instance.first = instance.timer = null;
    for (const stop of instance.unsubscribe.splice(0)) stop();
    // A pass in flight is allowed to finish what it claimed.
    await instance.passing?.catch(() => undefined);
  };

  return {
    name: 'automation',
    migrations: AUTOMATION_MIGRATIONS,

    setup(context: ModuleContext) {
      const now = options.now ?? Date.now;
      const graceMs = options.graceMs ?? AUTOMATION_LIMITS.graceMs;
      const store = new AutomationStore(context.db);
      const automations = new AutomationService({ context, store, now, graceMs });
      const deferred = new DeferredMessages({ context, store, now, graceMs });

      const tick = async (): Promise<{ automations: number; deferred: number }> => {
        const at = now();
        const ran = await automations.runDue(at);
        deferred.reconcileQueued();
        const sent = await deferred.dispatchDue(at);
        return { automations: ran, deferred: sent };
      };
      context.services.automation = { tick };

      // A fault in here must never surface in the code that published the event.
      const guard = (handler: (event: StudioEvent) => void) => (event: StudioEvent) => {
        try {
          handler(event);
        } catch (error) {
          context.log.error({ type: event.type, err: redactSecrets(describeError(error)) }, 'the automation module failed to handle an event');
        }
      };
      const unsubscribe = [
        context.bus.onTopic(
          'internal:runs',
          guard((event) => {
            const data = event.data as Omit<RunEnded, 'status'> & { status?: RunEnded['status'] };
            if (event.type === 'run.started') deferred.runStarted(data);
            else if (event.type === 'run.finished' || event.type === 'run.interrupted') {
              const ended: RunEnded = { ...data, status: event.type === 'run.interrupted' ? 'interrupted' : (data.status ?? 'failed'), error: data.error ?? null };
              automations.runEnded(ended);
              deferred.runEnded(ended);
            }
          }),
        ),
        context.bus.on(
          'notice',
          guard((event) => {
            const data = event.data as { runId?: unknown; code?: unknown };
            if (event.topic.startsWith('session:') && data.code === 'approval_skipped' && typeof data.runId === 'string') automations.approvalSkipped(data.runId);
          }),
        ),
        context.bus.on(
          'project.membership.changed',
          guard((event) => {
            const { projectId, userId, access } = event.data as { projectId: string; userId: string; access: ProjectAccess | null };
            automations.accessChanged(projectId, userId, access);
          }),
        ),
      ];

      instances.set(context, { automations, deferred, tick, unsubscribe, first: null, timer: null, passing: null, stopped: false });
      registerAutomationRoutes(context, { automations, deferred });
      context.http.app.addHook('onClose', async () => {
        await shutDown(context);
      });
    },

    async start(context) {
      const instance = instances.get(context);
      if (!instance) return;
      // Before anything new is claimed: whatever the previous process left open is closed, and never run again.
      try {
        instance.automations.recover();
        await instance.deferred.recover();
      } catch (error) {
        context.log.error({ err: redactSecrets(describeError(error)) }, 'recovering automations failed');
      }

      const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
      if (tickMs <= 0) return;
      const pass = (): void => {
        // One pass at a time on the timer; a slow pass is not overtaken by the next.
        if (instance.stopped || instance.passing) return;
        instance.passing = instance
          .tick()
          .catch((error: unknown) => context.log.error({ err: redactSecrets(describeError(error)) }, 'a scheduler pass failed'))
          .finally(() => {
            instance.passing = null;
          });
      };
      instance.first = setTimeout(pass, options.firstTickMs ?? DEFAULT_FIRST_TICK_MS);
      instance.first.unref();
      instance.timer = setInterval(pass, tickMs);
      instance.timer.unref();
    },

    async stop(context) {
      await shutDown(context);
    },
  };
}

export const automationModule: StudioModule = createAutomationModule();
