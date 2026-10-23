import { COLLAB_LIMITS, createTaskRequestSchema, handoffRequestSchema, idSchema, listTasksQuerySchema } from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { requireBrowserToLoosen } from '../agents/token-modes.js';
import { HandoffService } from './handoff.js';
import { COLLAB_MIGRATIONS, CollabStore } from './store.js';
import { TaskService } from './tasks.js';

/**
 * Working with more than one agent: handing a conversation on, giving one
 * task to several agents, and seeing everything that runs.
 *
 * - `framing.ts`     how text of one conversation is fenced for a model in another (pure)
 * - `digest.ts`      the digest of a conversation, built by rule from its events (pure)
 * - `handoff.ts`     the handoff itself: brief, optional summary, linked session, notices, chain
 * - `task-state.ts`  a task's state, worked out from its participants (pure)
 * - `tasks.ts`       multi-agent tasks, their synthesis, and the list of running work
 * - `store.ts`       SQL
 *
 * ## Routes (schemas in `@agent-studio/protocol`, `collab.ts`)
 *
 * All `access: 'user'`; a token needs scope `read` for GET and `write` for the rest.
 *
 * | Route | Who | |
 * | --- | --- | --- |
 * | `POST /api/sessions/:sessionId/handoff` | whoever may write in the session: its creator, with write access to its project | continue with another agent (201; 200 for a repeated request id) |
 * | `GET /api/sessions/:sessionId/handoffs` | whoever may see the session | the handoff it began with and those that continued it |
 * | `GET /api/sessions/:sessionId/chain` | whoever may see the session | the whole handed-over conversation, in order |
 * | `POST /api/projects/:projectId/tasks` | write access to the project; `worktrees`: the instance owner | start a multi-agent task (201; 200 for a repeated request id) |
 * | `GET /api/projects/:projectId/tasks` | read access to the project | the caller's tasks there; `scope=all`: everybody's, for the instance owner |
 * | `GET /api/tasks` | any user | the caller's tasks in every project they can see |
 * | `GET /api/tasks/:taskId` | its creator and the instance owner | with answers, usage and change summaries |
 * | `POST /api/tasks/:taskId/stop` | its creator and the instance owner | stops every participant that is still working |
 * | `DELETE /api/tasks/:taskId` | its creator and the instance owner | removes the record; the sessions stay |
 * | `GET /api/work/running` | any user | the caller's runs and tasks in progress, with how to stop each |
 *
 * A session or a task the caller may not see answers 404, exactly like one
 * that does not exist.
 *
 * ## Events
 *
 * Consumed: `internal:runs` (`run.started`, `run.finished`,
 * `run.interrupted`, `approval.pending`, `approval.resolved`) and
 * `session.updated` on `user:<id>` topics, to follow the participants of tasks.
 *
 * Published on the `user:<id>` topic of the person who handed over or created
 * the task: `handoff.created`, `task.created`, `task.updated`, `task.removed`
 * (see `collabEventSchema`). Nothing is published on `internal:` topics.
 *
 * ## How a summary is written without anybody seeing a session for it
 *
 * The summary of a handoff is one run in a helper session of the agent
 * runtime (`createSession(…, { hidden: true })`): unattended, in `plan` mode,
 * outside any project for an API model. The runtime leaves such a session out
 * of every list and announces nothing about it; this module follows it on
 * its own `session:<id>` topic and removes it when the answer is in. What it
 * used is in `agent_usage` like any run's, and so in every usage report.
 */
export interface CollabModuleOptions {
  /** How long an agent may take to write the summary of a handoff. Default 90 s. */
  readonly summaryTimeoutMs?: number;
  /** Tasks one user may have in progress at a time. */
  readonly runningTasksPerUser?: number;
}

declare module '../../kernel/module.js' {
  interface Services {
    collab: { readonly handoffs: HandoffService; readonly tasks: TaskService };
  }
}

const sessionParams = z.object({ sessionId: idSchema });
const projectParams = z.object({ projectId: idSchema });
const taskParams = z.object({ taskId: idSchema });

export function createCollabModule(options: CollabModuleOptions = {}): StudioModule {
  // One module object may serve several Studios in one process (tests do this), so nothing is kept per module.
  const instances = new WeakMap<ModuleContext, { tasks: TaskService; stop: () => void }>();

  return {
    name: 'collab',
    migrations: COLLAB_MIGRATIONS,

    setup(context: ModuleContext) {
      const { http } = context;
      const store = new CollabStore(context.db);
      const handoffs = new HandoffService(context, store, { summaryTimeoutMs: options.summaryTimeoutMs ?? 90_000 });
      const tasks = new TaskService(context, store, { runningTasksPerUser: options.runningTasksPerUser ?? COLLAB_LIMITS.runningTasksPerUser });
      context.services.collab = { handoffs, tasks };
      // From now on: the runtime's events also reach this module when the server only answers injected requests.
      instances.set(context, { tasks, stop: tasks.listen() });

      // ---- handoff and chains ------------------------------------------------------
      http.route({
        method: 'POST',
        url: '/api/sessions/:sessionId/handoff',
        access: 'user',
        params: sessionParams,
        body: handoffRequestSchema,
        handler: async ({ user, params, body, reply }) => {
          requireBrowserToLoosen(user, body.permissionMode);
          const response = await handoffs.handOff(user, params.sessionId, body);
          void reply.status(response.duplicate ? 200 : 201);
          return response;
        },
      });
      http.route({
        method: 'GET',
        url: '/api/sessions/:sessionId/handoffs',
        access: 'user',
        params: sessionParams,
        handler: ({ user, params }) => handoffs.handoffsOf(user, params.sessionId),
      });
      http.route({
        method: 'GET',
        url: '/api/sessions/:sessionId/chain',
        access: 'user',
        params: sessionParams,
        handler: ({ user, params }) => handoffs.chain(user, params.sessionId),
      });

      // ---- multi-agent tasks ---------------------------------------------------------
      http.route({
        method: 'POST',
        url: '/api/projects/:projectId/tasks',
        access: 'user',
        params: projectParams,
        body: createTaskRequestSchema,
        handler: async ({ user, params, body, reply }) => {
          requireBrowserToLoosen(user, ...body.participants.map((participant) => participant.permissionMode));
          const response = await tasks.create(user, params.projectId, body);
          void reply.status(response.duplicate ? 200 : 201);
          return response;
        },
      });
      http.route({
        method: 'GET',
        url: '/api/projects/:projectId/tasks',
        access: 'user',
        params: projectParams,
        query: listTasksQuerySchema,
        handler: ({ user, params, query }) => tasks.list(user, query, params.projectId),
      });
      http.route({
        method: 'GET',
        url: '/api/tasks',
        access: 'user',
        query: listTasksQuerySchema,
        handler: ({ user, query }) => tasks.list(user, query, null),
      });
      http.route({
        method: 'GET',
        url: '/api/tasks/:taskId',
        access: 'user',
        params: taskParams,
        handler: ({ user, params }) => tasks.get(user, params.taskId),
      });
      http.route({
        method: 'POST',
        url: '/api/tasks/:taskId/stop',
        access: 'user',
        params: taskParams,
        handler: ({ user, params }) => tasks.stop(user, params.taskId),
      });
      http.route({
        method: 'DELETE',
        url: '/api/tasks/:taskId',
        access: 'user',
        params: taskParams,
        handler: ({ user, params }) => tasks.remove(user, params.taskId),
      });

      // ---- everything that runs -------------------------------------------------------
      http.route({
        method: 'GET',
        url: '/api/work/running',
        access: 'user',
        handler: ({ user }) => tasks.running(user),
      });
    },

    start(context) {
      // After the runtime has marked what the last process left behind: tasks are brought in line with their runs.
      instances.get(context)?.tasks.reconcile();
    },

    stop(context) {
      instances.get(context)?.stop();
    },
  };
}

export const collabModule: StudioModule = createCollabModule();
