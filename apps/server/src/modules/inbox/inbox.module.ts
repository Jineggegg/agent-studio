import type { InboxSummary } from '@agent-studio/protocol';
import { describeError } from '../../kernel/errors.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { NotificationCenter, type NotifyResult } from './center.js';
import { type CustomNotification, customContent } from './content.js';
import { RunEventNotifier } from './events.js';
import { ExternalChannels, type ExternalChannelOptions } from './external-channels.js';
import { NotificationSwitches } from './preferences.js';
import { PushChannel, type PushOptions } from './push.js';
import { registerInboxRoutes } from './routes.js';
import { INBOX_MIGRATIONS } from './schema.js';
import { TaskInbox } from './tasks.js';
import type { Language } from './texts.js';

/**
 * The task inbox, notifications and Web Push.
 *
 * ## What raises a notification
 *
 * | Kind                  | Raised when                                                    | Switch               |
 * |-----------------------|----------------------------------------------------------------|----------------------|
 * | `needs-you`           | `approval.pending` (tool, plan, question) on `internal:runs`   | `needsYou`           |
 * | `reply-finished`      | `run.finished` · completed · a run somebody started by hand    | `replyFinished`      |
 * | `background-finished` | `run.finished` · completed · an unattended run                 | `backgroundFinished` |
 * | `run-failed`          | `run.finished` · failed; or another module says a run could not start | `failure`     |
 * | `run-interrupted`     | `run.interrupted` — once per session after a restart           | `failure`            |
 * | `automation`          | the automation module, through {@link InboxService.notify}     | `automation`         |
 * | `plugin`              | `plugin.notification` on `internal:plugins`                    | `plugin`             |
 * | `system`              | a device subscribed                                            | — (always)           |
 *
 * A switch that is off means: not stored and not sent, through any channel.
 * The session a user has visibly on screen raises nothing for that user.
 *
 * ## Channels
 *
 * `inApp` (the stored list, on by default) and `webPush` (on once a device
 * subscribes). SMTP and Bark are configured per account through encrypted settings; see
 * `DeliveryChannel` in center.ts for where one would attach.
 *
 * ## For other modules
 *
 * `context.services.inbox.notify(userId, {...})` raises a notification and
 * says what became of it. It applies the user's switches and the project
 * visibility rule, but not the on-screen rule or duplicate suppression: the
 * caller decides when to speak.
 */
export interface InboxService {
  notify(userId: string, notification: CustomNotification): Promise<NotifyResult>;
  /** The language to write text for this user in. */
  languageOf(userId: string): Language;
  /** Counts and one status line, for a home tile. */
  summary(principal: Principal): InboxSummary;
  /** Resolves when no push message is on its way. For tests and orderly shutdown. */
  idle(): Promise<void>;
}

declare module '../../kernel/module.js' {
  interface Services {
    inbox: InboxService;
  }
}

export interface InboxModuleOptions {
  /** The clock, for the dedupe window, the rate limits and time stamps. */
  readonly now?: () => number;
  readonly dedupeWindowMs?: number;
  readonly push?: PushOptions;
  readonly external?: ExternalChannelOptions;
}

export function createInboxModule(options: InboxModuleOptions = {}): StudioModule {
  // One module object may serve several Studios in one process (tests do this), so nothing is kept per module.
  const instances = new WeakMap<
    ModuleContext,
    {
      push: PushChannel;
      external: ExternalChannels;
      center: NotificationCenter;
      stopListening: () => void;
      stopped: boolean;
    }
  >();

  const shutDown = async (context: ModuleContext): Promise<void> => {
    const instance = instances.get(context);
    if (!instance || instance.stopped) return;
    instance.stopped = true;
    instance.stopListening();
    await instance.push.stop();
    await instance.external.idle();
  };

  return {
    name: 'inbox',
    migrations: INBOX_MIGRATIONS,

    setup(context: ModuleContext) {
      const now = options.now ?? Date.now;
      const switches = new NotificationSwitches(context.services.preferences);
      const push = new PushChannel({ context, switches, options: options.push ?? {}, now });
      const external = new ExternalChannels(context, options.external);
      external.register();
      const center = new NotificationCenter({ context, switches, push, now, external });
      const tasks = new TaskInbox({ context, center, switches, now });
      const notifier = new RunEventNotifier({
        context,
        center,
        switches,
        now,
        ...(options.dedupeWindowMs === undefined ? {} : { dedupeWindowMs: options.dedupeWindowMs }),
      });

      context.services.inbox = {
        notify: (userId, notification) => center.notify(userId, customContent(notification)),
        languageOf: (userId) => switches.language(userId),
        summary: (principal) => tasks.summary(principal),
        idle: async () => {
          await push.idle();
          await external.idle();
        },
      };

      const stopListening = notifier.listen();
      // A browser sign-in ended: the devices it registered stop receiving, at once.
      const stopRevocations = context.bus.on('auth.credential.revoked', (event) => {
        const { credentialId } = event.data as { credentialId?: unknown };
        if (typeof credentialId === 'string') push.credentialRevoked(credentialId);
      });
      instances.set(context, {
        push,
        external,
        center,
        stopped: false,
        stopListening: () => {
          stopListening();
          stopRevocations();
        },
      });

      registerInboxRoutes(context, { center, push, tasks, switches, notifier });

      // Pushes in flight are waited for whenever the server closes, including when it was never formally started.
      context.http.app.addHook('onClose', async () => {
        await shutDown(context);
      });
    },

    start(context) {
      const instance = instances.get(context);
      if (!instance) return;
      try {
        instance.center.store.pruneAged((options.now ?? Date.now)());
        instance.push.housekeeping();
      } catch (error) {
        context.log.warn({ err: describeError(error) }, 'notification housekeeping failed');
      }
    },

    async stop(context) {
      await shutDown(context);
    },
  };
}

export const inboxModule: StudioModule = createInboxModule();
