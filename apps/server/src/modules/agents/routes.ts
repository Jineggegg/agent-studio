import {
  type Agent,
  type AgentProjectSettings,
  agentProjectSettingsSchema,
  approvalDecisionRequestSchema,
  continueRunRequestSchema,
  createPermissionRuleRequestSchema,
  createSessionRequestSchema,
  editQueuedMessageRequestSchema,
  idSchema,
  listApprovalsQuerySchema,
  listEventsQuerySchema,
  listPermissionRulesQuerySchema,
  listRunsQuerySchema,
  listSessionsQuerySchema,
  presenceRequestSchema,
  requestIdSchema,
  saveDraftRequestSchema,
  searchMessagesQuerySchema,
  sendMessageRequestSchema,
  updateSessionRequestSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { describeError, notFound } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { AgentAdapter } from './adapter.js';
import type { AttachmentFiles } from './attachments.js';
import type { RunService } from './runtime.js';
import { AUTO_MODE_SETTING, type SessionService } from './sessions.js';
import type { AgentStore } from './store.js';

const sessionParams = z.object({ sessionId: idSchema });
/** A session may also be looked up by the agent's own id, for links copied from a terminal. */
const sessionLookupParams = z.object({ sessionId: z.string().min(1).max(400) });
const queueParams = z.object({ sessionId: idSchema, itemId: idSchema });
const receiptParams = z.object({ sessionId: idSchema, requestId: requestIdSchema });
const runParams = z.object({ runId: idSchema });
const approvalParams = z.object({ approvalId: idSchema });
const ruleParams = z.object({ ruleId: idSchema });
const projectParams = z.object({ projectId: idSchema });
const agentParams = z.object({ agentId: z.string().min(1).max(80) });

async function describeAgent(context: ModuleContext, adapter: AgentAdapter): Promise<Agent> {
  let status: Agent['status'];
  try {
    status = await adapter.status();
  } catch (error) {
    context.log.warn({ agent: adapter.id, err: describeError(error) }, 'reading an agent\'s status failed');
    status = { installed: false, version: null, signedIn: false, account: null, problem: 'The status of this agent could not be read.' };
  }
  return { id: adapter.id, displayName: adapter.displayName, kind: adapter.kind, capabilities: await adapter.capabilities(), status };
}

export function registerAgentRoutes(
  context: ModuleContext,
  deps: { store: AgentStore; sessions: SessionService; runs: RunService; files: AttachmentFiles; removeSession: (sessionId: string) => Promise<void> },
): void {
  const { http } = context;
  const { sessions, runs } = deps;
  const projects = context.services.projects;

  // ---- agents ---------------------------------------------------------------

  http.route({
    method: 'GET',
    url: '/api/agents',
    access: 'user',
    handler: async () => ({ agents: await Promise.all(runs.adapters().map((adapter) => describeAgent(context, adapter))) }),
  });

  http.route({
    method: 'GET',
    url: '/api/agents/:agentId',
    access: 'user',
    params: agentParams,
    handler: ({ params }) => {
      const adapter = runs.adapter(params.agentId);
      if (!adapter) throw notFound('No such agent.', 'agent_not_found');
      return describeAgent(context, adapter);
    },
  });

  // What the owner allows agents to do in one project.
  http.route({
    method: 'GET',
    url: '/api/agents/projects/:projectId/settings',
    access: 'user',
    params: projectParams,
    handler: ({ user, params }): AgentProjectSettings => {
      const project = projects.requireAccess(user, params.projectId);
      return { autoMode: sessions.autoModeEnabled(project) };
    },
  });

  http.route({
    method: 'PUT',
    url: '/api/agents/projects/:projectId/settings',
    access: 'owner',
    params: projectParams,
    body: agentProjectSettingsSchema,
    handler: ({ user, params, body }): AgentProjectSettings => {
      projects.requireAccess(user, params.projectId, 'write');
      const project = projects.patchSettings(params.projectId, { [AUTO_MODE_SETTING]: body.autoMode });
      context.services.audit.record({
        category: 'change',
        action: body.autoMode ? 'project.auto-mode.enabled' : 'project.auto-mode.disabled',
        userId: user.userId,
        subject: project.name,
      });
      return { autoMode: sessions.autoModeEnabled(project) };
    },
  });

  // ---- sessions ---------------------------------------------------------------

  http.route({
    method: 'POST',
    url: '/api/sessions',
    access: 'user',
    body: createSessionRequestSchema,
    handler: async ({ user, body, reply }) => {
      const session = await sessions.create(user, body, runs.adapter(body.agentId));
      void reply.status(201);
      return session;
    },
  });

  http.route({
    method: 'GET',
    url: '/api/sessions',
    access: 'user',
    query: listSessionsQuerySchema,
    handler: ({ user, query }) => sessions.list(user, query),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/search',
    access: 'user',
    query: searchMessagesQuerySchema,
    handler: ({ user, query }) => ({ hits: sessions.search(user, query) }),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/activity',
    access: 'user',
    handler: ({ user }) => sessions.activity(user),
  });

  http.route({
    method: 'PUT',
    url: '/api/sessions/presence',
    access: 'user',
    body: presenceRequestSchema,
    handler: ({ user, body }) => sessions.reportPresence(user, body.clientId, body.visible),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId',
    access: 'user',
    params: sessionLookupParams,
    handler: ({ user, params }) => sessions.find(user, params.sessionId),
  });

  http.route({
    method: 'PATCH',
    url: '/api/sessions/:sessionId',
    access: 'user',
    params: sessionParams,
    body: updateSessionRequestSchema,
    handler: ({ user, params, body }) => {
      const { row } = sessions.requireSession(user, params.sessionId, 'write');
      return sessions.update(user, params.sessionId, body, runs.adapter(row.agent_id));
    },
  });

  http.route({
    method: 'DELETE',
    url: '/api/sessions/:sessionId',
    access: 'user',
    params: sessionParams,
    handler: async ({ user, params }) => {
      sessions.requireSession(user, params.sessionId, 'control');
      await deps.removeSession(params.sessionId);
    },
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/state',
    access: 'user',
    params: sessionParams,
    handler: ({ user, params }) => {
      sessions.requireSession(user, params.sessionId, 'view');
      return runs.snapshot(params.sessionId);
    },
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/events',
    access: 'user',
    params: sessionParams,
    query: listEventsQuerySchema,
    handler: ({ user, params, query }) => sessions.events(user, params.sessionId, query),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/usage',
    access: 'user',
    params: sessionParams,
    handler: ({ user, params }) => sessions.usage(user, params.sessionId),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/native-id',
    access: 'user',
    params: sessionParams,
    handler: ({ user, params }) => ({ nativeSessionId: sessions.nativeId(user, params.sessionId) }),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/draft',
    access: 'user',
    params: sessionParams,
    handler: ({ user, params }) => sessions.draft(user, params.sessionId),
  });

  http.route({
    method: 'PUT',
    url: '/api/sessions/:sessionId/draft',
    access: 'user',
    params: sessionParams,
    body: saveDraftRequestSchema,
    handler: ({ user, params, body }) => sessions.saveDraft(user, params.sessionId, body.text),
  });

  http.route({
    method: 'POST',
    url: '/api/sessions/:sessionId/seen',
    access: 'user',
    params: sessionParams,
    handler: ({ user, params }) => {
      const { row } = sessions.requireSession(user, params.sessionId, 'view');
      // Only its owner looking at it makes a result "seen".
      if (row.user_id === user.userId) sessions.markSeen(params.sessionId);
      return sessions.find(user, params.sessionId);
    },
  });

  // ---- messages, stop, queue --------------------------------------------------

  http.route({
    method: 'POST',
    url: '/api/sessions/:sessionId/messages',
    access: 'user',
    params: sessionParams,
    body: sendMessageRequestSchema,
    handler: async ({ user, params, body, reply }) => {
      const receipt = await runs.send(user, params.sessionId, body);
      void reply.status(receipt.duplicate ? 200 : 202);
      return receipt;
    },
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/messages/:requestId',
    access: 'user',
    params: receiptParams,
    handler: ({ user, params }) => runs.receipt(user, params.sessionId, params.requestId),
  });

  http.route({
    method: 'POST',
    url: '/api/sessions/:sessionId/stop',
    access: 'user',
    params: sessionParams,
    handler: async ({ user, params }) => ({ run: await runs.stop(user, params.sessionId) }),
  });

  http.route({
    method: 'GET',
    url: '/api/sessions/:sessionId/queue',
    access: 'user',
    params: sessionParams,
    handler: ({ user, params }) => ({ queue: runs.queue(user, params.sessionId) }),
  });

  http.route({
    method: 'PATCH',
    url: '/api/sessions/:sessionId/queue/:itemId',
    access: 'user',
    params: queueParams,
    body: editQueuedMessageRequestSchema,
    handler: ({ user, params, body }) => runs.editQueued(user, params.sessionId, params.itemId, body.text),
  });

  http.route({
    method: 'DELETE',
    url: '/api/sessions/:sessionId/queue/:itemId',
    access: 'user',
    params: queueParams,
    handler: ({ user, params }) => runs.removeQueued(user, params.sessionId, params.itemId),
  });

  http.route({
    method: 'POST',
    url: '/api/sessions/:sessionId/queue/:itemId/send-now',
    access: 'user',
    params: queueParams,
    handler: ({ user, params }) => runs.sendNow(user, params.sessionId, params.itemId),
  });

  // ---- runs -------------------------------------------------------------------

  http.route({
    method: 'GET',
    url: '/api/runs',
    access: 'user',
    query: listRunsQuerySchema,
    handler: ({ user, query }) => ({ runs: runs.listRuns(user, query) }),
  });

  http.route({
    method: 'GET',
    url: '/api/runs/:runId',
    access: 'user',
    params: runParams,
    handler: ({ user, params }) => runs.getRun(user, params.runId),
  });

  http.route({
    method: 'POST',
    url: '/api/runs/:runId/continue',
    access: 'user',
    params: runParams,
    body: continueRunRequestSchema,
    handler: async ({ user, params, body, reply }) => {
      const receipt = await runs.continueRun(user, params.runId, body.requestId);
      void reply.status(receipt.duplicate ? 200 : 202);
      return receipt;
    },
  });

  http.route({
    method: 'POST',
    url: '/api/runs/:runId/dismiss',
    access: 'user',
    params: runParams,
    handler: ({ user, params }) => runs.dismissRun(user, params.runId),
  });

  // ---- approvals --------------------------------------------------------------

  http.route({
    method: 'GET',
    url: '/api/approvals',
    access: 'user',
    query: listApprovalsQuerySchema,
    handler: ({ user, query }) => ({ approvals: runs.listApprovals(user, query) }),
  });

  http.route({
    method: 'GET',
    url: '/api/approvals/:approvalId',
    access: 'user',
    params: approvalParams,
    handler: ({ user, params }) => runs.getApproval(user, params.approvalId),
  });

  http.route({
    method: 'POST',
    url: '/api/approvals/:approvalId/decision',
    access: 'user',
    params: approvalParams,
    body: approvalDecisionRequestSchema,
    handler: ({ user, params, body }) => runs.decide(user, params.approvalId, body),
  });

  // ---- permission rules -------------------------------------------------------

  http.route({
    method: 'GET',
    url: '/api/permission-rules',
    access: 'user',
    query: listPermissionRulesQuerySchema,
    handler: ({ user, query }) => ({ rules: runs.listRules(user, query) }),
  });

  http.route({
    method: 'POST',
    url: '/api/permission-rules',
    access: 'user',
    body: createPermissionRuleRequestSchema,
    handler: ({ user, body, reply }) => {
      const rule = runs.createRule(user, body);
      void reply.status(201);
      return rule;
    },
  });

  http.route({
    method: 'DELETE',
    url: '/api/permission-rules/:ruleId',
    access: 'user',
    params: ruleParams,
    handler: ({ user, params }) => runs.deleteRule(user, params.ruleId),
  });
}
