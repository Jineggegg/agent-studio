import {
  type AcknowledgeResponse,
  INBOX_LIMITS,
  type Inbox,
  type InboxCounts,
  type InboxItem,
  type InboxSummary,
  type Run,
  type Session,
  appLinks,
  toOneLine,
} from '@agent-studio/protocol';
import { conflict, notFound } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { NotificationCenter } from './center.js';
import type { NotificationSwitches } from './preferences.js';
import { counted, text } from './texts.js';

/** Recent runs looked through for unread results. */
const RECENT_RUNS = 300;

const runNotFound = () => notFound('No such task.', 'task_not_found');

/**
 * The task inbox: one list, four groups, built on every read from what the
 * agent runtime reports — nothing is copied or cached, so a row can never
 * outlive the thing it stands for.
 *
 * Whose tasks: the caller's own. That holds for the instance owner too — an
 * owner does not get everybody's runs here. The one exception is an approval
 * that only an owner may give: it is addressed to the owners, so they see it.
 *
 * The inbox leads to the session and can put a row away. It cannot approve,
 * deny, answer, start, continue or stop anything.
 */
export class TaskInbox {
  readonly #context: ModuleContext;
  readonly #center: NotificationCenter;
  readonly #switches: NotificationSwitches;
  readonly #now: () => number;

  constructor(deps: { context: ModuleContext; center: NotificationCenter; switches: NotificationSwitches; now: () => number }) {
    this.#context = deps.context;
    this.#center = deps.center;
    this.#switches = deps.switches;
    this.#now = deps.now;
  }

  read(principal: Principal): Inbox {
    const { agents, projects } = this.#context.services;
    const runs = agents.runs;
    const now = this.#now();
    const me = principal.userId;

    // Only projects the caller can see now, and none that is archived: there must be a page to open.
    const openProjects = new Map(projects.list(principal).map((project) => [project.id, project.name]));
    const sessions = new Map<string, Session | null>();
    const sessionOf = (sessionId: string): Session | null => {
      if (!sessions.has(sessionId)) {
        let session: Session | null = null;
        try {
          session = agents.getSession(principal, sessionId);
        } catch {
          /* deleted, or not the caller's to see */
        }
        if (session && (session.archived || (session.projectId !== null && !openProjects.has(session.projectId)))) session = null;
        sessions.set(sessionId, session);
      }
      return sessions.get(sessionId) ?? null;
    };
    const runOf = (runId: string): Run | null => {
      try {
        return runs.getRun(principal, runId);
      } catch {
        return null;
      }
    };

    const item = (kind: InboxItem['kind'], run: Run, session: Session, extra: Partial<InboxItem> = {}): InboxItem => {
      const preview = toOneLine(run.text, INBOX_LIMITS.previewChars);
      // A session that was never named shows what was asked instead of the placeholder.
      const title = session.titleSource === 'default' ? preview : session.title;
      return {
        id: `${kind}:${run.id}`,
        kind,
        runId: run.id,
        sessionId: session.id,
        projectId: session.projectId,
        projectName: session.projectId === null ? null : (openProjects.get(session.projectId) ?? null),
        userId: run.userId,
        agentId: session.agentId,
        agentName: agents.adapter(session.agentId)?.displayName ?? session.agentId,
        title: toOneLine(title, INBOX_LIMITS.titleChars) || toOneLine(session.title, INBOX_LIMITS.titleChars),
        preview,
        runStatus: run.status,
        updatedAt: run.finishedAt ?? run.startedAt ?? run.createdAt,
        link: appLinks.session(session.id, session.projectId),
        approval: null,
        error: null,
        interruptedByRestart: false,
        acknowledgeable: false,
        ...extra,
      };
    };

    let truncated = false;
    const bounded = <T>(list: T[], max: number): T[] => {
      if (list.length > max) truncated = true;
      return list.slice(0, max);
    };

    // 1. Awaiting approval: only what is live in this process — an approval is never rebuilt from history.
    const pending = runs
      .listApprovals(principal, { status: 'pending', limit: INBOX_LIMITS.approvals + 1 })
      .filter((approval) => approval.userId === me || (principal.role === 'owner' && approval.requiresOwner))
      .filter((approval) => agents.isRunning(approval.sessionId));
    const approvals: InboxItem[] = [];
    const waitingSessions = new Set<string>();
    for (const approval of bounded(pending, INBOX_LIMITS.approvals)) {
      const session = sessionOf(approval.sessionId);
      const run = session ? runOf(approval.runId) : null;
      if (!session || !run) continue;
      waitingSessions.add(session.id);
      approvals.push(
        item('approval', run, session, {
          id: `approval:${approval.id}`,
          updatedAt: approval.createdAt,
          approval: {
            id: approval.id,
            kind: approval.kind,
            // The tool is named; what it was asked to do is shown in the session only.
            toolName: approval.toolName === null ? null : toOneLine(approval.toolName, INBOX_LIMITS.toolNameChars) || null,
            requiresOwner: approval.requiresOwner,
            expiresAt: approval.expiresAt,
          },
        }),
      );
    }

    // 2. Needs handling: failed or interrupted, neither continued nor dismissed.
    const needsHandling: InboxItem[] = [];
    for (const run of bounded(runs.listRuns(principal, { state: 'unresolved', limit: INBOX_LIMITS.needsHandling + 1 }), INBOX_LIMITS.needsHandling)) {
      const session = sessionOf(run.sessionId);
      if (!session) continue;
      needsHandling.push(
        item('needs-handling', run, session, {
          error: run.error === null ? null : toOneLine(redactSecrets(run.error.message), INBOX_LIMITS.errorChars) || null,
          interruptedByRestart: run.interruptedByRestart,
          acknowledgeable: true,
        }),
      );
    }

    // 4 (collected before 3, which depends on it). In progress, with nothing waiting.
    const running: InboxItem[] = [];
    const busySessions = new Set<string>(waitingSessions);
    for (const run of bounded(runs.listRuns(principal, { state: 'active', limit: INBOX_LIMITS.running + 1 }), INBOX_LIMITS.running)) {
      busySessions.add(run.sessionId);
      if (waitingSessions.has(run.sessionId)) continue;
      const session = sessionOf(run.sessionId);
      if (session) running.push(item('running', run, session));
    }

    // 3. Results to view: finished, unseen, recent; one per session, and not while that session is busy.
    const recent = runs.listRuns(principal, { state: 'all', limit: RECENT_RUNS + 1 });
    const horizon = now - INBOX_LIMITS.resultMaxAgeMs;
    if (recent.length > RECENT_RUNS && recent[RECENT_RUNS]!.createdAt >= horizon) truncated = true;
    const newestPerSession = new Map<string, Run>();
    for (const run of recent) {
      if (run.status !== 'completed' || run.seenAt !== null || run.finishedAt === null || run.finishedAt < horizon) continue;
      if (busySessions.has(run.sessionId)) continue;
      const known = newestPerSession.get(run.sessionId);
      if (!known || (known.finishedAt ?? 0) < run.finishedAt) newestPerSession.set(run.sessionId, run);
    }
    const results: InboxItem[] = [];
    const unread = [...newestPerSession.values()].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const run of unread) {
      if (results.length >= INBOX_LIMITS.results) {
        truncated = true;
        break;
      }
      const session = sessionOf(run.sessionId);
      if (session) results.push(item('result', run, session, { acknowledgeable: true }));
    }

    const newestFirst = (a: InboxItem, b: InboxItem) => b.updatedAt - a.updatedAt;
    approvals.sort(newestFirst);
    needsHandling.sort(newestFirst);
    running.sort(newestFirst);
    return {
      groups: { approvals, needsHandling, results, running },
      counts: { approvals: approvals.length, needsHandling: needsHandling.length, results: results.length, running: running.length },
      truncated,
      checkedAt: now,
    };
  }

  /** Counts and the one line a home tile shows: what waits, else new results, else what runs. */
  summary(principal: Principal): InboxSummary {
    const inbox = this.read(principal);
    const counts: InboxCounts = inbox.counts;
    const language = this.#switches.language(principal.userId);
    const waiting = counts.approvals + counts.needsHandling;
    let status: InboxSummary['status'];
    let line: string;
    if (waiting > 0) {
      status = { code: 'waiting', count: waiting };
      line = counted(language, 'summary.waiting', waiting);
    } else if (counts.results > 0) {
      status = { code: 'results', count: counts.results };
      line = counted(language, 'summary.results', counts.results);
    } else if (counts.running > 0) {
      status = { code: 'running', count: counts.running };
      line = counted(language, 'summary.running', counts.running);
    } else {
      status = { code: 'clear', count: 0 };
      line = text(language, 'summary.clear');
    }
    return { counts, waiting, status, line, unreadNotifications: this.#center.unread(principal.userId), truncated: inbox.truncated, checkedAt: inbox.checkedAt };
  }

  /** The caller's own run, or "not found" — the same answer for a run that does not exist and for somebody else's. */
  #ownRun(principal: Principal, runId: string): Run {
    let run: Run;
    try {
      run = this.#context.services.agents.runs.getRun(principal, runId);
    } catch {
      throw runNotFound();
    }
    // The instance owner may look at anyone's run elsewhere; here everyone puts away only their own.
    if (run.userId !== principal.userId) throw runNotFound();
    return run;
  }

  /**
   * Puts one row away: a finished result is marked read (with the session's
   * earlier unread results), a failed or interrupted run is marked handled.
   * Both go through the runtime, and neither starts anything: a failed run
   * with messages queued behind it is refused, because dismissing it would
   * release that queue.
   */
  acknowledge(principal: Principal, runId: string): AcknowledgeResponse {
    const agents = this.#context.services.agents;
    const run = this.#ownRun(principal, runId);
    if (run.status === 'accepted' || run.status === 'running') {
      throw conflict('That task is still in progress. Open the session to deal with it.', 'task_in_progress');
    }
    const unresolved = (run.status === 'failed' || run.status === 'interrupted') && run.dismissedAt === null && run.continuedByRunId === null;
    // The runtime holds a session's queued messages back while its failure is unresolved, and sends them once it is dismissed.
    if (unresolved && !agents.isRunning(run.sessionId) && agents.runs.queue(principal, run.sessionId).length > 0) {
      throw conflict('Messages are waiting behind this task. Open the session to decide what happens to them.', 'queue_waiting');
    }
    const { alreadyHandled } = agents.runs.dismissRun(principal, runId);
    // What the notifications said about this session has been dealt with as well.
    this.#center.markAllRead(principal.userId, run.sessionId);
    return { acknowledged: true, alreadyHandled };
  }

  /**
   * "Mark all read": only the caller's finished, unread results among the
   * ids are touched. Anything else in the list — a failure, a run in
   * progress, somebody else's run, an unknown id — is passed over in silence.
   */
  acknowledgeResults(principal: Principal, runIds: readonly string[]): number {
    const runs = this.#context.services.agents.runs;
    const unread: Run[] = [];
    for (const runId of runIds) {
      let run: Run;
      try {
        run = runs.getRun(principal, runId);
      } catch {
        continue;
      }
      if (run.userId === principal.userId && run.status === 'completed' && run.seenAt === null) unread.push(run);
    }
    for (const run of unread) {
      runs.dismissRun(principal, run.id);
      this.#center.markAllRead(principal.userId, run.sessionId);
    }
    return unread.length;
  }
}
