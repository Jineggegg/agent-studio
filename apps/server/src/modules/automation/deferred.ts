import {
  AUTOMATION_EVENT,
  AUTOMATION_LIMITS,
  type CreateDeferredMessageRequest,
  type DeferredMessage,
  type DeferredReason,
  type DeferredState,
  type ListDeferredMessagesQuery,
  type MessageReceipt,
  type PermissionMode,
  type Session,
  appLinks,
  toOneLine,
  userTopic,
} from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, describeError, isStudioError, notFound, unprocessable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { RunEnded } from './service.js';
import type { AutomationStore, DeferredInternalState, DeferredRow } from './store.js';
import { type AutomationTextKey, say } from './texts.js';

const PUBLIC_STATE: Readonly<Record<DeferredInternalState, DeferredState>> = {
  pending: 'pending',
  sending: 'in-progress',
  queued: 'in-progress',
  running: 'in-progress',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
};
const INTERNAL_STATES: Readonly<Record<DeferredState, readonly DeferredInternalState[]>> = {
  pending: ['pending'],
  'in-progress': ['sending', 'queued', 'running'],
  sent: ['sent'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};
const IN_FLIGHT: readonly DeferredInternalState[] = ['sending', 'queued', 'running'];
/** Finished deferred messages kept per user. */
const KEEP_FINISHED = 200;

const notFoundError = () => notFound('No such scheduled message.', 'deferred_not_found');
const requestIdOf = (id: string): string => `deferred-${id}`;

export function presentDeferred(row: DeferredRow): DeferredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    text: row.text,
    sendAt: row.send_at,
    state: PUBLIC_STATE[row.state],
    queued: row.state === 'queued',
    reason: row.reason,
    detail: row.detail,
    options: { model: row.model, effort: row.effort, permissionMode: row.permission_mode as PermissionMode | null },
    runId: row.run_id,
    dismissed: row.dismissed_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Deferred messages: "send this to that session at 18:00".
 *
 * A message is sent as its author, into their own session, like a message
 * typed at that moment: with the session's ordinary permissions, and waiting
 * for approval where a typed message would (the user is notified). It is not
 * an automation's unattended run.
 *
 * Sending is claimed first (pending → sending, in one statement) and carried
 * out with a request id derived from the message's own id, so the runtime
 * itself refuses to accept it twice. If the session is busy the message goes
 * into the session's queue and runs as its next turn — the running turn is
 * left alone. Nothing is sent a second time, and nothing is retried.
 */
export class DeferredMessages {
  readonly #context: ModuleContext;
  readonly #store: AutomationStore;
  readonly #now: () => number;
  readonly #graceMs: number;

  constructor(deps: { context: ModuleContext; store: AutomationStore; now: () => number; graceMs: number }) {
    this.#context = deps.context;
    this.#store = deps.store;
    this.#now = deps.now;
    this.#graceMs = deps.graceMs;
  }

  #changed(row: DeferredRow): void {
    this.#context.bus.publish(userTopic(row.user_id), AUTOMATION_EVENT.deferredChanged, { id: row.id, sessionId: row.session_id, state: PUBLIC_STATE[row.state] });
  }

  /** Applies a transition and tells the author's pages. False when the row was not in one of the `from` states. */
  #move(id: string, from: readonly DeferredInternalState[], patch: Parameters<AutomationStore['moveDeferred']>[2]): boolean {
    if (!this.#store.moveDeferred(id, from, patch, this.#now())) return false;
    const row = this.#store.deferred(id);
    if (row) this.#changed(row);
    return true;
  }

  // ---- what the author does -----------------------------------------------------

  async create(principal: Principal, body: CreateDeferredMessageRequest): Promise<DeferredMessage> {
    const { agents, projects } = this.#context.services;
    const session = agents.getSession(principal, body.sessionId);
    // An instance owner may look into anyone's session; writing into it — now or later — is its author's alone.
    if (session.userId !== principal.userId) throw notFound('No such session.', 'session_not_found');
    if (session.projectId !== null) {
      const project = projects.requireAccess(principal, session.projectId, 'write');
      if (!projects.isFeatureEnabled(project, 'automation')) throw conflict('Scheduled work is switched off for this project.', 'automation_disabled');
    }
    if (body.permissionMode !== undefined) {
      const capabilities = await agents.adapter(session.agentId)?.capabilities();
      if (capabilities && !capabilities.permissionModes.includes(body.permissionMode)) {
        throw unprocessable('The agent of this session does not have that permission mode.', 'unsupported_permission_mode');
      }
    }
    const now = this.#now();
    if (body.sendAt - now > AUTOMATION_LIMITS.deferredMaxAheadMs) throw badRequest('A message can be scheduled at most a year ahead.', undefined, 'send_time_too_far');
    // A time just gone is sent at the next pass; one further back than the grace window never would be.
    if (now - body.sendAt > this.#graceMs) throw badRequest('That time has already passed.', undefined, 'send_time_passed');
    if (this.#store.countPendingDeferred(principal.userId) >= AUTOMATION_LIMITS.deferredPending) {
      throw conflict(`At most ${AUTOMATION_LIMITS.deferredPending} messages can wait to be sent. Cancel one first.`, 'too_many_deferred');
    }
    const row: DeferredRow = {
      id: newId(),
      user_id: principal.userId,
      session_id: session.id,
      project_id: session.projectId,
      text: body.text,
      model: body.model ?? null,
      effort: body.effort ?? null,
      permission_mode: body.permissionMode ?? null,
      send_at: body.sendAt,
      state: 'pending',
      reason: null,
      detail: null,
      run_id: null,
      dismissed_at: null,
      created_at: now,
      updated_at: now,
    };
    this.#store.insertDeferred(row);
    this.#changed(row);
    return presentDeferred(row);
  }

  list(principal: Principal, query: ListDeferredMessagesQuery): DeferredMessage[] {
    // With a session: everything about it. Without: what still waits.
    const state = query.state ?? (query.sessionId === undefined ? 'pending' : undefined);
    return this.#store
      .listDeferred({
        userId: principal.userId,
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(state === undefined ? {} : { states: INTERNAL_STATES[state] }),
        includeDismissed: false,
        limit: query.limit,
      })
      .map(presentDeferred);
  }

  #own(principal: Principal, id: string): DeferredRow {
    const row = this.#store.deferredOf(principal.userId, id);
    if (!row) throw notFoundError();
    return row;
  }

  /** Only a message that still waits can be cancelled; once it was handed to the session it is that session's business. */
  cancel(principal: Principal, id: string): DeferredMessage {
    this.#own(principal, id);
    if (!this.#move(id, ['pending'], { state: 'cancelled' })) throw conflict('That message was already sent or cancelled.', 'deferred_not_pending');
    return presentDeferred(this.#own(principal, id));
  }

  /** Puts a failed message away. It stays put away. */
  dismiss(principal: Principal, id: string): DeferredMessage {
    const row = this.#own(principal, id);
    if (row.state !== 'failed') throw conflict('Only a message that failed can be dismissed.', 'deferred_not_failed');
    if (row.dismissed_at === null) this.#move(id, ['failed'], { dismissedAt: this.#now() });
    return presentDeferred(this.#own(principal, id));
  }

  // ---- sending -------------------------------------------------------------------

  /** One pass: every message whose time has come is claimed, then sent — one after another, so two for one session keep their order. */
  async dispatchDue(now: number): Promise<number> {
    let sent = 0;
    for (const id of this.#store.dueDeferred(now, 50)) {
      // The claim. Of two passes, one finds the row no longer pending.
      if (!this.#store.moveDeferred(id, ['pending'], { state: 'sending' }, now)) continue;
      const row = this.#store.deferred(id);
      if (!row) continue;
      this.#changed(row);
      try {
        await this.#send(row, now);
      } catch (error) {
        this.#context.log.error({ deferredId: id, err: redactSecrets(describeError(error)) }, 'a deferred message could not be sent');
        await this.#fail(row, 'error', null, 'The message could not be sent because of an internal error.', true);
      }
      sent += 1;
    }
    return sent;
  }

  /** Ends a message as failed with a reason, and — for a message that never became a run — tells its author. */
  async #fail(row: DeferredRow, reason: DeferredReason, key: AutomationTextKey | null, detail: string | null, tell: boolean, session: Session | null = null): Promise<void> {
    const inbox = this.#context.services.inbox;
    const language = inbox.languageOf(row.user_id);
    const sentence = toOneLine(redactSecrets(detail ?? (key === null ? '' : say(language, key))), AUTOMATION_LIMITS.summaryChars);
    if (!this.#move(row.id, IN_FLIGHT, { state: 'failed', reason, detail: sentence })) return;
    this.#store.pruneDeferred(row.user_id, KEEP_FINISHED);
    if (!tell) return;
    // A run that started and failed is reported by the inbox like any other; this is for what never got that far.
    const project = row.project_id === null ? null : this.#context.services.projects.find(row.project_id);
    try {
      await inbox.notify(row.user_id, {
        kind: 'run-failed',
        title: session?.title ?? project?.name ?? '',
        body: say(language, 'notify.deferredNotSent'),
        detail: sentence,
        // Without a session to open, the home screen.
        link: session ? appLinks.session(session.id, session.projectId) : appLinks.home(),
        tag: `deferred:${row.id}`,
        projectId: project?.id ?? null,
        sessionId: session?.id ?? null,
        // A session's title may be the start of a message: a lock screen gets the project's name.
        discreet: { title: project?.name ?? '' },
      });
    } catch (error) {
      this.#context.log.warn({ deferredId: row.id, err: redactSecrets(describeError(error)) }, 'notifying about a deferred message failed');
    }
  }

  async #send(row: DeferredRow, now: number): Promise<void> {
    const { agents, projects } = this.#context.services;
    if (now - row.send_at > this.#graceMs) return this.#fail(row, 'missed', 'deferred.missed', null, true);
    const author = agents.principalFor(row.user_id);
    if (!author) return this.#fail(row, 'account-disabled', 'deferred.accountDisabled', null, false);
    let session: Session;
    try {
      session = agents.getSession(author, row.session_id);
    } catch {
      return this.#fail(row, 'session-gone', 'deferred.sessionGone', null, true);
    }
    if (session.projectId !== null) {
      const project = projects.find(session.projectId);
      // Checked again when it is due: the switch may have been turned off since.
      if (project && !projects.isFeatureEnabled(project, 'automation')) return this.#fail(row, 'automation-off', 'deferred.automationOff', null, true, session);
    }

    let receipt: MessageReceipt;
    try {
      receipt = await agents.sendMessage(
        author,
        session.id,
        {
          requestId: requestIdOf(row.id),
          text: row.text,
          // Busy session: wait in its queue. The running turn is not stopped.
          whenBusy: 'queue',
          ...(row.model === null ? {} : { model: row.model }),
          ...(row.effort === null ? {} : { effort: row.effort }),
          ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode as PermissionMode }),
        },
        // Nobody may be watching, but this is the author's own message: it waits for approval like one, and they are notified.
        { origin: 'scheduled', waitForApproval: true },
      );
    } catch (error) {
      if (!isStudioError(error)) throw error;
      const reason: DeferredReason =
        error.code === 'project_read_only' || error.code === 'not_your_session'
          ? 'access-lost'
          : error.code === 'agent_unavailable'
            ? 'agent-unavailable'
            : error.code === 'queue_full'
              ? 'queue-full'
              : error.code === 'session_not_found'
                ? 'session-gone'
                : 'error';
      const key: AutomationTextKey | null =
        reason === 'access-lost' ? 'deferred.accessLost' : reason === 'agent-unavailable' ? 'deferred.agentUnavailable' : reason === 'queue-full' ? 'deferred.queueFull' : reason === 'session-gone' ? 'deferred.sessionGone' : null;
      // A StudioError's message is written for people.
      return this.#fail(row, reason, key, key === null ? error.message : null, true, session);
    }
    this.#adopt(row.id, receipt);
  }

  /** Records where a message went: into a run, or into the session's queue. */
  #adopt(id: string, receipt: MessageReceipt): void {
    if (receipt.runId === null) {
      this.#move(id, ['sending'], { state: 'queued' });
      return;
    }
    this.#move(id, ['sending', 'queued'], { state: 'running', runId: receipt.runId });
    const run = receipt.run;
    if (run && run.status !== 'accepted' && run.status !== 'running') {
      // Rare: it had ended before this line (or, after a restart, long ago). Set the record right from the run itself.
      this.#settle(this.#store.deferred(id)!, run.status, run.error?.message ?? null);
    }
  }

  #settle(row: DeferredRow, status: RunEnded['status'], error: string | null): void {
    if (row.state !== 'running') return;
    if (status === 'completed' || status === 'stopped') {
      // The message was delivered and its turn is over. A stop is the user's own doing.
      this.#move(row.id, ['running'], { state: 'sent' });
      this.#store.pruneDeferred(row.user_id, KEEP_FINISHED);
      return;
    }
    const language = this.#context.services.inbox.languageOf(row.user_id);
    const detail = status === 'interrupted' ? say(language, 'deferred.interrupted') : toOneLine(redactSecrets(error ?? ''), AUTOMATION_LIMITS.summaryChars);
    // The run exists, so the inbox has it under "needs handling" and has sent its own notice.
    this.#move(row.id, ['running'], { state: 'failed', reason: status === 'interrupted' ? 'interrupted' : 'run-failed', detail });
    this.#store.pruneDeferred(row.user_id, KEEP_FINISHED);
  }

  // ---- following what was sent -----------------------------------------------------

  /** A run started in a session: if it is one of our queued messages being taken, it is running now. */
  runStarted(event: { runId: string; sessionId: string }): void {
    for (const row of this.#store.queuedDeferredOfSession(event.sessionId)) this.#reconcile(row);
  }

  runEnded(event: RunEnded): void {
    const row = this.#store.deferredByRun(event.runId);
    if (row) this.#settle(row, event.status, event.error?.message ?? null);
  }

  /** Asks the runtime what became of a message it was handed: still queued, taken into a run, or withdrawn. */
  #reconcile(row: DeferredRow): void {
    const { agents, inbox } = this.#context.services;
    const author = agents.principalFor(row.user_id);
    if (!author) return;
    let receipt: MessageReceipt;
    try {
      receipt = agents.runs.receipt(author, row.session_id, requestIdOf(row.id));
    } catch {
      if (row.state === 'queued') {
        // Its author took it out of the session's queue.
        this.#move(row.id, ['queued'], { state: 'cancelled', detail: say(inbox.languageOf(row.user_id), 'deferred.withdrawn') });
      }
      return;
    }
    if (receipt.runId !== null || row.state === 'sending') this.#adopt(row.id, receipt);
  }

  /** Each pass: messages waiting in a session's queue are checked against the runtime, in case an event was not seen. */
  reconcileQueued(): void {
    for (const row of this.#store.deferredIn(['queued'])) this.#reconcile(row);
  }

  /**
   * At start-up. A message that was being sent when the previous process
   * ended is looked up by its request id: if the runtime has it, the record
   * follows the runtime; if it does not, it was never sent — and is not sent
   * now. Runs that were in progress have been marked interrupted by the
   * runtime, and the messages that started them say so.
   */
  async recover(): Promise<void> {
    const { agents, inbox } = this.#context.services;
    for (const row of this.#store.deferredIn(IN_FLIGHT)) {
      const author = agents.principalFor(row.user_id);
      if (!author) {
        await this.#fail(row, 'account-disabled', 'deferred.accountDisabled', null, false);
        continue;
      }
      if (row.state === 'running' && row.run_id !== null) {
        try {
          const run = agents.runs.getRun(author, row.run_id);
          if (run.status !== 'accepted' && run.status !== 'running') this.#settle(row, run.status, run.error?.message ?? null);
        } catch {
          await this.#fail(row, 'session-gone', 'deferred.sessionGone', null, false);
        }
        continue;
      }
      let known = true;
      try {
        agents.runs.receipt(author, row.session_id, requestIdOf(row.id));
      } catch {
        known = false;
      }
      if (known) this.#reconcile(row);
      else if (row.state === 'sending') await this.#fail(row, 'interrupted', null, say(inbox.languageOf(row.user_id), 'deferred.interruptedBeforeSend'), true);
      else this.#reconcile(row);
    }
  }
}
