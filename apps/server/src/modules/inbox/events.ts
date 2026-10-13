import { INBOX_EVENT, NOTIFICATION_LIMITS, PLUGIN_BUS_EVENT, type Session, pluginNotificationEventSchema, userTopic } from '@agent-studio/protocol';
import { describeError } from '../../kernel/errors.js';
import type { StudioEvent } from '../../kernel/events.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import type { NotificationCenter } from './center.js';
import {
  type NotificationContent,
  type SessionContext,
  dedupeKeys,
  needsYouContent,
  pluginContent,
  pushDelivery,
  runFailedContent,
  runFinishedContent,
  runInterruptedContent,
} from './content.js';
import { DedupeWindow } from './limits.js';
import type { NotificationSwitches } from './preferences.js';

/** What every event on `internal:runs` names (see the top of agents.module.ts). */
interface RunReference {
  readonly runId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly userId: string;
  readonly agentId: string;
}

interface RunFinished extends RunReference {
  readonly origin: string;
  readonly unattended: boolean;
  readonly status: 'completed' | 'failed' | 'stopped';
  readonly error: { code: string; message: string } | null;
  readonly title: string;
  readonly visibleTo: readonly string[];
}

interface RunInterrupted extends RunReference {
  readonly title: string;
}

interface ApprovalPending extends RunReference {
  readonly approvalId: string;
  readonly kind: 'tool' | 'plan' | 'question';
  readonly toolName: string | null;
  readonly title: string;
  readonly requiresOwner: boolean;
  readonly expiresAt: number | null;
  readonly visibleTo: readonly string[];
}

interface ApprovalResolved {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Listens to what the agent runtime and the plugins announce and raises
 * notifications for it. The rules that are not negotiable live here:
 *
 * - nothing for a user who has the session visibly on screen (`visibleTo`) —
 *   and only that user: somebody else looking does not silence the owner;
 * - the same event for the same session once within the dedupe window;
 * - after a restart, one notice per session whose run was cut short;
 * - nothing for a project the user can no longer see (checked by the centre).
 *
 * Runs started by an automation are reported by the automation module, which
 * knows the automation's name and whether anything was denied; this listener
 * leaves their endings alone.
 */
export class RunEventNotifier {
  readonly #context: ModuleContext;
  readonly #center: NotificationCenter;
  readonly #switches: NotificationSwitches;
  readonly #now: () => number;
  readonly #recent: DedupeWindow;
  /** Sessions already told about an interruption since this process started. */
  readonly #interrupted = new Set<string>();
  /** The attention mark last seen per session, to tell a real change from any other session update. */
  readonly #attention = new Map<string, string>();

  constructor(deps: { context: ModuleContext; center: NotificationCenter; switches: NotificationSwitches; now: () => number; dedupeWindowMs?: number }) {
    this.#context = deps.context;
    this.#center = deps.center;
    this.#switches = deps.switches;
    this.#now = deps.now;
    this.#recent = new DedupeWindow(deps.dedupeWindowMs ?? NOTIFICATION_LIMITS.dedupeWindowMs, deps.now);
  }

  /** Subscribes to the bus. Returns a function that ends the subscriptions. */
  listen(): () => void {
    const bus = this.#context.bus;
    const guard = (handler: (event: StudioEvent) => void) => (event: StudioEvent) => {
      // A notification problem must never surface in the code that published the event.
      try {
        handler(event);
      } catch (error) {
        this.#context.log.error({ type: event.type, err: describeError(error) }, 'raising a notification failed');
      }
    };
    const stops = [
      bus.onTopic(
        'internal:runs',
        guard((event) => this.#onRunEvent(event)),
      ),
      bus.onTopic(
        'internal:plugins',
        guard((event) => {
          if (event.type === PLUGIN_BUS_EVENT.notification) this.#onPluginNotification(event.data);
        }),
      ),
      bus.on(
        'session.updated',
        guard((event) => this.#onSessionUpdated(event)),
      ),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  #inboxChanged(userId: string, reason: 'run' | 'approval' | 'acknowledged' | 'attention'): void {
    this.#context.bus.publish(userTopic(userId), INBOX_EVENT.inboxChanged, { reason });
  }

  /** For the routes: an acknowledgement changed the caller's inbox. */
  acknowledged(userId: string): void {
    this.#inboxChanged(userId, 'acknowledged');
  }

  #owners(except: string): string[] {
    return this.#context.services.auth
      .listUsers()
      .filter((user) => user.role === 'owner' && !user.disabled && user.id !== except)
      .map((user) => user.id);
  }

  #onRunEvent(event: StudioEvent): void {
    switch (event.type) {
      case 'run.started':
        this.#inboxChanged((event.data as RunReference).userId, 'run');
        return;
      case 'run.finished':
        this.#inboxChanged((event.data as RunReference).userId, 'run');
        this.#onRunFinished(event.data as RunFinished);
        return;
      case 'run.interrupted':
        this.#inboxChanged((event.data as RunReference).userId, 'run');
        this.#onRunInterrupted(event.data as RunInterrupted);
        return;
      case 'approval.pending': {
        const data = event.data as ApprovalPending;
        this.#inboxChanged(data.userId, 'approval');
        if (data.requiresOwner) for (const owner of this.#owners(data.userId)) this.#inboxChanged(owner, 'approval');
        this.#onApprovalPending(data);
        return;
      }
      case 'approval.resolved': {
        const data = event.data as ApprovalResolved;
        this.#inboxChanged(data.userId, 'approval');
        for (const owner of this.#owners(data.userId)) this.#inboxChanged(owner, 'approval');
        // Once nothing waits in the session any more, the "needs you" line is history.
        if ((this.#context.services.agents.runs.snapshot(data.sessionId)?.pendingApprovals.length ?? 0) === 0) this.#center.settle(data.sessionId, 'needs-you');
        return;
      }
      default:
    }
  }

  /** A session's attention mark changed for a reason no run event tells (it was opened, a result was read elsewhere). */
  #onSessionUpdated(event: StudioEvent): void {
    if (!event.topic.startsWith('user:')) return;
    const session = (event.data as { session?: Pick<Session, 'id' | 'attention'> }).session;
    if (!session || typeof session.id !== 'string') return;
    if (this.#attention.get(session.id) === session.attention) return;
    this.#attention.delete(session.id);
    this.#attention.set(session.id, session.attention);
    if (this.#attention.size > 2000) this.#attention.delete(this.#attention.keys().next().value!);
    this.#inboxChanged(event.topic.slice('user:'.length), 'attention');
  }

  // ---- what is known about the session ----------------------------------------

  #sessionContext(viewer: Principal, reference: RunReference & { title: string }): SessionContext | null {
    const { agents, projects } = this.#context.services;
    let session: Session;
    try {
      session = agents.getSession(viewer, reference.sessionId);
    } catch {
      // Gone, or not theirs to see: there is nothing to open, so there is nothing to say.
      return null;
    }
    const project = session.projectId === null ? null : projects.find(session.projectId);
    return {
      language: this.#switches.language(viewer.userId),
      sessionId: session.id,
      projectId: session.projectId,
      projectName: project?.name ?? null,
      sessionTitle: session.title,
      titleIsName: session.titleSource === 'manual' || session.titleSource === 'agent',
      agentName: agents.adapter(session.agentId)?.displayName ?? session.agentId,
    };
  }

  #raise(userId: string, content: NotificationContent, delivery = pushDelivery(content.kind)): void {
    const raised = this.#center.raise(userId, content, { delivery });
    // The push travels on its own; whatever becomes of it is no concern of the run.
    if (raised.push) void raised.push.catch(() => undefined);
  }

  // ---- the events --------------------------------------------------------------

  #onRunFinished(data: RunFinished): void {
    // A stop is the user's own doing; an automation's run is reported by the automation.
    if (data.status === 'stopped' || data.origin === 'automation') return;
    if (data.visibleTo.includes(data.userId)) return;
    const viewer = this.#context.services.agents.principalFor(data.userId);
    if (!viewer) return;
    const context = this.#sessionContext(viewer, data);
    if (!context) return;

    if (data.status === 'failed') {
      if (!this.#recent.admit(dedupeKeys.runFailed(data.userId, data.sessionId, data.error?.code ?? null))) return;
      this.#raise(data.userId, runFailedContent(context, { runId: data.runId, detail: data.error?.message ?? null }));
      return;
    }
    if (!this.#recent.admit(dedupeKeys.runFinished(data.userId, data.sessionId, data.runId))) return;
    this.#raise(data.userId, runFinishedContent(context, { runId: data.runId, unattended: data.unattended, detail: this.#promptOf(viewer, data.runId) }));
  }

  /** The start of the request that started a run: detail for the app's list, never for a lock screen by default. */
  #promptOf(viewer: Principal, runId: string): string | null {
    try {
      return this.#context.services.agents.runs.getRun(viewer, runId).text;
    } catch {
      return null;
    }
  }

  #onRunInterrupted(data: RunInterrupted): void {
    // Whatever waited for an answer in that run is void now.
    this.#center.settle(data.sessionId, 'needs-you');
    // One notice per session, however many of its runs were cut short.
    if (this.#interrupted.has(data.sessionId)) return;
    this.#interrupted.add(data.sessionId);
    const viewer = this.#context.services.agents.principalFor(data.userId);
    if (!viewer) return;
    const context = this.#sessionContext(viewer, data);
    if (!context) return;
    this.#raise(data.userId, runInterruptedContent(context, { runId: data.runId }));
  }

  #onApprovalPending(data: ApprovalPending): void {
    const { agents, auth } = this.#context.services;
    const expiresInMs = data.expiresAt === null ? null : data.expiresAt - this.#now();
    const delivery = pushDelivery('needs-you', { expiresInMs });
    // A member cannot allow a dangerous request: the owners have to hear of it too.
    const recipients = [{ userId: data.userId, onBehalfOf: null as string | null }];
    if (data.requiresOwner) {
      const person = auth.findUser(data.userId)?.displayName ?? '';
      for (const owner of this.#owners(data.userId)) recipients.push({ userId: owner, onBehalfOf: person });
    }
    for (const recipient of recipients) {
      // Presence counts per person: somebody else looking at the session does not silence this one.
      if (data.visibleTo.includes(recipient.userId)) continue;
      const viewer = agents.principalFor(recipient.userId);
      if (!viewer) continue;
      const context = this.#sessionContext(viewer, data);
      if (!context) continue;
      if (!this.#recent.admit(dedupeKeys.needsYou(recipient.userId, data.sessionId, data.kind, data.toolName))) continue;
      let detail: string | null = null;
      try {
        const approval = agents.runs.getApproval(viewer, data.approvalId);
        detail = approval.kind === 'tool' ? (approval.command ?? approval.title) : approval.kind === 'question' ? approval.title : null;
      } catch {
        /* answered already: the name of the tool is enough */
      }
      this.#raise(
        recipient.userId,
        needsYouContent(context, { runId: data.runId, kind: data.kind, toolName: data.toolName, onBehalfOf: recipient.onBehalfOf, detail }),
        delivery,
      );
    }
  }

  #onPluginNotification(raw: unknown): void {
    const parsed = pluginNotificationEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    const project = event.projectId === null ? null : this.#context.services.projects.find(event.projectId);
    // About a project that no longer exists: nothing to point at.
    if (event.projectId !== null && project === null) return;
    this.#raise(
      event.userId,
      pluginContent(this.#switches.language(event.userId), {
        pluginId: event.pluginId,
        pluginName: event.pluginName,
        title: event.title,
        body: event.body,
        projectId: event.projectId,
        projectName: project?.name ?? null,
      }),
    );
  }
}
