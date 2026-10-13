import {
  AGENT_LIMITS,
  type CreateSessionRequest,
  type MessageReceipt,
  type Run,
  type SendMessageRequest,
  type Session,
  createSessionRequestSchema,
  sendMessageRequestSchema,
} from '@agent-studio/protocol';
import type { z } from 'zod';
import { describeError } from '../../kernel/errors.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import type { AgentAdapter } from './adapter.js';
import { AttachmentFiles, registerAttachmentRoutes } from './attachments.js';
import { BridgeTokens, registerBridgeRoutes } from './bridge.js';
import { registerAgentRoutes } from './routes.js';
import { RunService, type RuntimeOptions, type SendOptions } from './runtime.js';
import { AGENTS_MIGRATIONS } from './schema.js';
import { SessionService } from './sessions.js';
import { AgentStore } from './store.js';

/**
 * The agent runtime: sessions, runs, the event log, the queue, the permission
 * engine, approvals, attachments, usage records and the server side of the
 * MCP bridge. The agents themselves are separate modules that register an
 * {@link AgentAdapter} here.
 *
 * ## Events on `internal:runs`
 *
 * For the notification and automation modules; browsers never see this
 * topic. Subscribe with `context.bus.onTopic('internal:runs', handler)` and
 * switch on `event.type`. Every payload names `runId`, `sessionId`,
 * `projectId` (null outside a project), `userId` (whose run it is) and
 * `agentId`, and carries the session's `title` where a notification would
 * need one. Payloads never contain message text, tool input or error detail
 * beyond a short code and sentence.
 *
 * - `run.started`       `{ …, origin, unattended, title }`
 * - `run.finished`      `{ …, origin, unattended, status: 'completed' | 'failed' | 'stopped',
 *                          error: { code, message } | null, title, durationMs, visibleTo }`
 * - `run.interrupted`   `{ …, origin, title, reason: 'restart', visibleTo: [] }`
 *                       Published once per run when the server starts and
 *                       finds it had been in progress. Nothing is re-run.
 * - `approval.pending`  `{ approvalId, …, kind: 'tool' | 'plan' | 'question', toolName,
 *                          title, risk, requiresOwner, expiresAt, visibleTo }`
 *                       `requiresOwner`: only an instance owner may allow it.
 * - `approval.resolved` `{ approvalId, runId, sessionId, projectId, userId,
 *                          status: 'allowed' | 'denied' | 'expired' | 'cancelled', decidedBy }`
 *
 * `visibleTo` lists the users who had the session visibly on screen when the
 * event happened (they reported it through `PUT /api/sessions/presence`).
 * A notifier should stay quiet for a user in that list: they are looking at
 * it. A finished result is already marked as seen for its owner in that case.
 */

/** How long an approval waits for an answer before it is denied. Change it per deployment here. */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/**
 * How long a question from the agent waits before the server answers it with
 * the options the agent itself marked as recommended (and leaves the rest
 * unanswered). 0 switches the automatic answer off: questions then wait for ever.
 */
export const QUESTION_TTL_MS = 30 * 60 * 1000;
/** How long a stopped agent gets to wind down before its run is ended without it. */
export const STOP_GRACE_MS = 5000;
/** How long a tab's report of what it shows is believed without being repeated. */
export const PRESENCE_TTL_MS = 90 * 1000;

export interface AgentsModuleOptions extends Partial<RuntimeOptions> {
  readonly presenceTtlMs?: number;
}

export type SendMessageInput = z.input<typeof sendMessageRequestSchema>;
export type CreateSessionInput = z.input<typeof createSessionRequestSchema>;

/** What other modules may ask of the agent runtime. */
export interface AgentsService {
  /** Makes an agent available. Call during `setup`. */
  registerAdapter(adapter: AgentAdapter): void;
  adapters(): AgentAdapter[];
  adapter(id: string): AgentAdapter | undefined;
  /**
   * The identity to act under for work the server starts by itself (a
   * schedule, an automation): the account as it is now. Null when the account
   * is gone or disabled — then nothing may be started for it.
   */
  principalFor(userId: string): Principal | null;
  createSession(user: Principal, input: CreateSessionInput): Promise<Session>;
  getSession(user: Principal, sessionId: string): Session;
  /**
   * Sends a message exactly like the workbench does. For a run nobody is
   * watching pass `origin: 'scheduled'` or `'automation'`: whatever would need
   * approval is then denied with a notice in the transcript, unless
   * `waitForApproval` is set.
   */
  sendMessage(user: Principal, sessionId: string, input: SendMessageInput, options?: SendOptions): Promise<MessageReceipt>;
  stop(user: Principal, sessionId: string): Promise<Run>;
  isRunning(sessionId: string): boolean;
  readonly sessions: SessionService;
  readonly runs: RunService;
}

declare module '../../kernel/module.js' {
  interface Services {
    agents: AgentsService;
  }
}

export function createAgentsModule(options: AgentsModuleOptions = {}): StudioModule {
  // One module object may serve several Studios in one process (tests do this), so nothing is kept per module.
  const instances = new WeakMap<ModuleContext, { runs: RunService; files: AttachmentFiles; store: AgentStore }>();

  return {
    name: 'agents',
    migrations: AGENTS_MIGRATIONS,

    async setup(context: ModuleContext) {
      const { realtime, bus, http, config, log } = context;
      const agentStore = new AgentStore(context.db);
      const sessions = new SessionService({ context, store: agentStore, presenceTtlMs: options.presenceTtlMs ?? PRESENCE_TTL_MS });
      const attachments = new AttachmentFiles({ dataDir: config.dataDir, store: agentStore, sessions });
      const tokens = new BridgeTokens(config, () => {
        const address = http.app.server.address();
        return typeof address === 'object' && address ? address.port : null;
      });
      const runService = new RunService({
        context,
        store: agentStore,
        sessions,
        tokens,
        options: {
          approvalTtlMs: options.approvalTtlMs ?? APPROVAL_TTL_MS,
          questionTtlMs: options.questionTtlMs ?? QUESTION_TTL_MS,
          stopGraceMs: options.stopGraceMs ?? STOP_GRACE_MS,
        },
        attachmentPath: (row) => attachments.pathOf(row),
      });
      instances.set(context, { runs: runService, files: attachments, store: agentStore });

      /** Deletes a session: its run is stopped first, then its rows, its files and the agent's own copy go. */
      const removeSession = async (sessionId: string): Promise<void> => {
        await runService.stopForRemoval(sessionId);
        const row = agentStore.session(sessionId);
        if (!row) return;
        const project = row.project_id === null ? null : context.services.projects.find(row.project_id);
        sessions.deleteRow(row);
        await attachments.removeSession(sessionId).catch((error: unknown) => log.warn({ sessionId, err: describeError(error) }, 'removing attachments failed'));
        const adapter = runService.adapter(row.agent_id);
        if (row.native_session_id !== null && adapter?.deleteNativeSession) {
          await adapter
            .deleteNativeSession({ nativeSessionId: row.native_session_id, cwd: project?.rootDir ?? null })
            .catch((error: unknown) => log.warn({ sessionId, agent: adapter.id, err: describeError(error) }, "removing the agent's own transcript failed"));
        }
      };

      context.services.agents = {
        registerAdapter: (adapter) => runService.registerAdapter(adapter),
        adapters: () => runService.adapters(),
        adapter: (id) => runService.adapter(id),
        principalFor: (userId) => runService.principalFor(userId),
        createSession: (user, input) => {
          const parsed: CreateSessionRequest = createSessionRequestSchema.parse(input);
          return sessions.create(user, parsed, runService.adapter(parsed.agentId));
        },
        getSession: (user, sessionId) => sessions.find(user, sessionId),
        sendMessage: (user, sessionId, input, sendOptions) => {
          const parsed: SendMessageRequest = sendMessageRequestSchema.parse(input);
          return runService.send(user, sessionId, parsed, sendOptions);
        },
        stop: (user, sessionId) => runService.stop(user, sessionId),
        isRunning: (sessionId) => runService.isRunning(sessionId),
        sessions,
        runs: runService,
      };

      // One topic per session. A subscription is authorised for that session and that caller;
      // nothing about a session is ever sent to a connection that did not ask for it and pass.
      realtime.registerTopic({
        kind: 'session',
        authorize: (principal, sessionId) => /^[0-9a-z]{26}$/.test(sessionId) && sessions.canWatch(principal, sessionId),
        replay: (sessionId, afterSeq) =>
          agentStore
            .eventsTail(sessionId, afterSeq, AGENT_LIMITS.replayEvents)
            .map((row) => ({ seq: row.seq, type: row.type, data: JSON.parse(row.data) as unknown, at: row.at })),
        snapshot: (sessionId) => runService.snapshot(sessionId),
      });

      // A project is about to be removed: its sessions' rows go with it (cascade), so stop what
      // runs there and clear what the database cannot — files and the search index.
      bus.on('project.deleting', (event) => {
        const { projectId } = event.data as { projectId: string };
        const sessionIds = agentStore.sessionIdsOfProject(projectId);
        for (const sessionId of sessionIds) runService.abandon(sessionId);
        agentStore.removeIndexOfSessions(sessionIds);
        for (const sessionId of sessionIds) {
          void attachments.removeSession(sessionId).catch((error: unknown) => log.warn({ sessionId, err: describeError(error) }, 'removing attachments failed'));
        }
      });

      // Access to a project changed: live subscriptions are checked again at once, and a member
      // who can no longer write there does not keep an agent working there.
      bus.on('project.membership.changed', (event) => {
        const { projectId, userId, access } = event.data as { projectId: string; userId: string; access: 'read' | 'write' | null };
        realtime.reauthorize((principal) => principal.userId === userId);
        if (access === 'write') return;
        for (const sessionId of agentStore.sessionIdsOfProject(projectId)) {
          const row = agentStore.session(sessionId);
          if (row?.user_id === userId && runService.isRunning(sessionId)) {
            void runService.stopForRemoval(sessionId).catch((error: unknown) => log.warn({ sessionId, err: describeError(error) }, 'stopping a run failed'));
          }
        }
      });

      // An account was deleted: its rows are gone already; stop its agents and clear its files.
      bus.on('auth.user.deleted', (event) => {
        const { userId } = event.data as { userId: string };
        runService.abandonUser(userId);
        sessions.forgetPresence(userId);
        agentStore.removeOrphanedIndex();
        void attachments.sweep(agentStore.allSessionIds()).catch((error: unknown) => log.warn({ err: describeError(error) }, 'removing attachments failed'));
      });

      registerAgentRoutes(context, { store: agentStore, sessions, runs: runService, files: attachments, removeSession });
      await registerAttachmentRoutes(context, attachments);
      registerBridgeRoutes(context, tokens, runService);

      // Agents are stopped whenever the server closes, including when it was never
      // formally started (as in tests that only inject requests).
      http.app.addHook('onClose', async () => {
        await runService.shutdown();
      });
    },

    async start(context) {
      // Before the server accepts connections: whatever was running when the last
      // process ended is marked interrupted, and nothing is run again by itself.
      const instance = instances.get(context);
      if (!instance) return;
      instance.runs.recover();
      await instance.files
        .sweep(instance.store.allSessionIds())
        .catch((error: unknown) => context.log.warn({ err: describeError(error) }, 'removing attachments failed'));
    },

    async stop(context) {
      await instances.get(context)?.runs.shutdown();
    },
  };
}

export const agentsModule: StudioModule = createAgentsModule();
