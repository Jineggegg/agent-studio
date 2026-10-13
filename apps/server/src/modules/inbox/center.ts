import {
  INBOX_EVENT,
  type ListNotificationsQuery,
  NOTIFICATION_EVENT_OF_KIND,
  type Notification,
  type NotificationKind,
  type NotificationList,
  appLinks,
  safeAppLink,
  userTopic,
} from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { describeError, notFound } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import type { NotificationContent, PushDelivery } from './content.js';
import { type NotificationRow, NotificationStore } from './notifications.js';
import type { NotificationSwitches } from './preferences.js';
import type { DeliveryReport, PushChannel } from './push.js';

/**
 * Why nothing was raised.
 *
 * `no-recipient`  the account is gone or disabled
 * `no-access`     the notification is about a project the user can no longer see
 * `event-off`     the user switched this kind of event off: it goes through no channel
 * `channels-off`  every channel is off
 */
export type NotRaised = 'no-recipient' | 'no-access' | 'event-off' | 'channels-off';

export interface Raised {
  /** Null when the notification went out. */
  readonly skipped: NotRaised | null;
  /** The stored notification, when the in-app channel is on. */
  readonly notification: Notification | null;
  /** What became of the push; resolves when the push services have answered. Null when Web Push is off. */
  readonly push: Promise<DeliveryReport> | null;
}

/** What a caller that needs to know the outcome gets back. */
export interface NotifyResult {
  /**
   * `delivered`      it is in the app's list and/or at least one device's push service accepted it
   * `not-delivered`  a channel was on, but nothing took it (devices exist, none accepted; or push was rate-limited)
   */
  readonly status: 'delivered' | 'not-delivered' | NotRaised;
  readonly inApp: boolean;
  readonly push: DeliveryReport | null;
}

/**
 * The boundary a delivery channel sits behind. Two exist: the app's own list
 * (the store below) and Web Push. A further one — e-mail, a relay — would be
 * a third implementation given the same content, with its own switch in the
 * preferences; none is built in this release.
 */
export interface DeliveryChannel {
  deliver(userId: string, content: NotificationContent, options: { showDetails: boolean; delivery?: PushDelivery }): Promise<DeliveryReport>;
}

/**
 * Turns "this happened, for this user" into stored notifications and pushes,
 * applying the user's switches, and serves the stored list.
 */
export class NotificationCenter {
  readonly store: NotificationStore;
  readonly #context: ModuleContext;
  readonly #switches: NotificationSwitches;
  readonly #push: PushChannel;
  readonly #now: () => number;

  constructor(deps: { context: ModuleContext; switches: NotificationSwitches; push: PushChannel; now: () => number }) {
    this.#context = deps.context;
    this.#switches = deps.switches;
    this.#push = deps.push;
    this.#now = deps.now;
    this.store = new NotificationStore(deps.context.db);
  }

  // ---- raising ---------------------------------------------------------------

  /**
   * Raises a notification for one user. Everything up to and including the
   * stored row happens before this returns; the push goes out afterwards and
   * can be awaited through `push`. Nothing here throws for a reason a
   * notification could have: a failure to notify must never fail what caused it.
   */
  raise(userId: string, content: NotificationContent, options: { delivery?: PushDelivery } = {}): Raised {
    const none = (skipped: NotRaised): Raised => ({ skipped, notification: null, push: null });
    const principal = this.#context.services.agents.principalFor(userId);
    if (!principal) return none('no-recipient');
    // A project the user cannot see (any more) produces nothing for them.
    if (content.projectId !== null && !this.#canSee(principal, content.projectId)) return none('no-access');

    const preferences = this.#switches.read(userId);
    const event = NOTIFICATION_EVENT_OF_KIND[content.kind];
    if (event !== null && !preferences.events[event]) return none('event-off');
    if (!preferences.channels.inApp && !preferences.channels.webPush) return none('channels-off');

    let notification: Notification | null = null;
    if (preferences.channels.inApp) {
      try {
        const row: NotificationRow = {
          id: newId(),
          user_id: userId,
          kind: content.kind,
          title: content.title,
          body: content.body,
          detail: content.detail,
          link: safeAppLink(content.link),
          tag: content.tag,
          session_id: content.sessionId,
          run_id: content.runId,
          project_id: content.projectId,
          created_at: this.#now(),
          read_at: null,
        };
        this.store.put(row);
        notification = this.#present(principal, row, new Map());
        this.#announce(userId, 'added', notification);
      } catch (error) {
        this.#context.log.error({ userId, kind: content.kind, err: describeError(error) }, 'storing a notification failed');
      }
    }

    const push = preferences.channels.webPush
      ? this.#push.deliver(userId, content, { showDetails: preferences.showDetails, ...(options.delivery ? { delivery: options.delivery } : {}) })
      : null;
    return { skipped: null, notification, push };
  }

  /** As {@link raise}, for callers that record what became of it. */
  async notify(userId: string, content: NotificationContent, options: { delivery?: PushDelivery } = {}): Promise<NotifyResult> {
    const raised = this.raise(userId, content, options);
    if (raised.skipped !== null) return { status: raised.skipped, inApp: false, push: null };
    const push = raised.push === null ? null : await raised.push;
    const inApp = raised.notification !== null;
    return { status: inApp || (push?.accepted ?? 0) > 0 ? 'delivered' : 'not-delivered', inApp, push };
  }

  #canSee(principal: Principal, projectId: string): boolean {
    const projects = this.#context.services.projects;
    return projects.find(projectId) !== null && projects.accessOf(principal, projectId) !== null;
  }

  #announce(userId: string, reason: 'added' | 'read' | 'removed', notification?: Notification): void {
    this.#context.bus.publish(userTopic(userId), INBOX_EVENT.notificationsChanged, {
      unread: this.store.unread(userId),
      reason,
      ...(notification ? { notification } : {}),
    });
  }

  // ---- the stored list -------------------------------------------------------

  /**
   * A stored row as the caller may see it now. When the project or session it
   * was about can no longer be opened by them, the link falls back to the
   * home screen and the references are dropped; the line itself stays.
   */
  #present(principal: Principal, row: NotificationRow, known: Map<string, boolean>): Notification {
    const check = (key: string, probe: () => boolean): boolean => {
      let value = known.get(key);
      if (value === undefined) known.set(key, (value = probe()));
      return value;
    };
    let available = true;
    if (row.project_id !== null) available = check(`p:${row.project_id}`, () => this.#canSee(principal, row.project_id!));
    if (available && row.session_id !== null) {
      available = check(`s:${row.session_id}`, () => {
        try {
          this.#context.services.agents.getSession(principal, row.session_id!);
          return true;
        } catch {
          return false;
        }
      });
    }
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      detail: row.detail,
      link: available ? safeAppLink(row.link) : appLinks.home(),
      targetAvailable: available,
      tag: row.tag,
      sessionId: available ? row.session_id : null,
      runId: available ? row.run_id : null,
      projectId: available ? row.project_id : null,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
  }

  list(principal: Principal, query: ListNotificationsQuery): NotificationList {
    const rows = this.store.list(principal.userId, {
      order: query.order,
      unreadOnly: query.unread === 'only',
      limit: query.limit + 1,
      offset: query.offset,
    });
    const known = new Map<string, boolean>();
    return {
      notifications: rows.slice(0, query.limit).map((row) => this.#present(principal, row, known)),
      hasMore: rows.length > query.limit,
      unread: this.store.unread(principal.userId),
    };
  }

  unread(userId: string): number {
    return this.store.unread(userId);
  }

  markRead(principal: Principal, id: string): { changed: number; unread: number } {
    if (!this.store.find(principal.userId, id)) throw notFound('No such notification.', 'notification_not_found');
    const changed = this.store.markRead(principal.userId, id, this.#now()) ? 1 : 0;
    if (changed > 0) this.#announce(principal.userId, 'read');
    return { changed, unread: this.store.unread(principal.userId) };
  }

  markAllRead(userId: string, sessionId?: string): { changed: number; unread: number } {
    const changed = this.store.markAllRead(userId, this.#now(), sessionId);
    if (changed > 0) this.#announce(userId, 'read');
    return { changed, unread: this.store.unread(userId) };
  }

  /** A kind of notification about a session has been dealt with (its approval was answered, say): it is read for everyone. */
  settle(sessionId: string, kind: NotificationKind): void {
    for (const userId of this.store.markKindRead(sessionId, kind, this.#now())) this.#announce(userId, 'read');
  }

  remove(principal: Principal, id: string): { changed: number; unread: number } {
    if (!this.store.remove(principal.userId, id)) throw notFound('No such notification.', 'notification_not_found');
    this.#announce(principal.userId, 'removed');
    return { changed: 1, unread: this.store.unread(principal.userId) };
  }

  clear(userId: string, scope: 'read' | 'all'): { changed: number; unread: number } {
    const changed = this.store.clear(userId, scope);
    if (changed > 0) this.#announce(userId, 'removed');
    return { changed, unread: this.store.unread(userId) };
  }
}
