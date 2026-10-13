import {
  automationHistoryQuerySchema,
  createAutomationRequestSchema,
  createDeferredMessageRequestSchema,
  idSchema,
  listDeferredMessagesQuerySchema,
  schedulePreviewRequestSchema,
  updateAutomationRequestSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext } from '../../kernel/module.js';
import type { DeferredMessages } from './deferred.js';
import type { AutomationService } from './service.js';

const projectParams = z.object({ projectId: idSchema });
const automationParams = z.object({ projectId: idSchema, automationId: idSchema });
const deferredParams = z.object({ deferredId: idSchema });
const empty = z.strictObject({});

/**
 * Who may call what:
 *
 * - reading an automation needs read access to its project;
 * - creating, changing, running and deleting need write access, and the
 *   automation must be the caller's own unless the caller is the instance owner;
 * - a deferred message is its author's alone.
 *
 * A project the caller cannot see answers "not found" before anything about
 * its automations is looked at. API tokens need the `write` scope for
 * everything but the GET routes.
 */
export function registerAutomationRoutes(context: ModuleContext, deps: { automations: AutomationService; deferred: DeferredMessages }): void {
  const { http } = context;
  const { automations, deferred } = deps;

  http.route({
    method: 'GET',
    url: '/api/projects/:projectId/automations',
    access: 'user',
    params: projectParams,
    handler: ({ user, params }) => automations.list(user, params.projectId),
  });

  http.route({
    method: 'GET',
    url: '/api/projects/:projectId/automations/options',
    access: 'user',
    params: projectParams,
    handler: ({ user, params }) => automations.options(user, params.projectId),
  });

  http.route({
    method: 'POST',
    url: '/api/projects/:projectId/automations',
    access: 'user',
    params: projectParams,
    body: createAutomationRequestSchema,
    bodyLimit: 128 * 1024,
    handler: async ({ user, params, body, reply }) => {
      const created = await automations.create(user, params.projectId, body);
      void reply.status(201);
      return created;
    },
  });

  http.route({
    method: 'GET',
    url: '/api/projects/:projectId/automations/:automationId',
    access: 'user',
    params: automationParams,
    handler: ({ user, params }) => automations.get(user, params.projectId, params.automationId),
  });

  http.route({
    method: 'PATCH',
    url: '/api/projects/:projectId/automations/:automationId',
    access: 'user',
    params: automationParams,
    body: updateAutomationRequestSchema,
    bodyLimit: 128 * 1024,
    handler: ({ user, params, body }) => automations.update(user, params.projectId, params.automationId, body),
  });

  http.route({
    method: 'DELETE',
    url: '/api/projects/:projectId/automations/:automationId',
    access: 'user',
    params: automationParams,
    handler: ({ user, params }) => automations.remove(user, params.projectId, params.automationId),
  });

  http.route({
    method: 'POST',
    url: '/api/projects/:projectId/automations/:automationId/run',
    access: 'user',
    params: automationParams,
    body: empty,
    handler: ({ user, params }) => automations.runNow(user, params.projectId, params.automationId),
  });

  http.route({
    method: 'GET',
    url: '/api/projects/:projectId/automations/:automationId/runs',
    access: 'user',
    params: automationParams,
    query: automationHistoryQuerySchema,
    handler: ({ user, params, query }) => automations.history(user, params.projectId, params.automationId, query),
  });

  // When would this schedule fire? Nothing is stored, and nothing about any project is read.
  http.route({
    method: 'POST',
    url: '/api/automations/preview',
    access: 'user',
    scope: 'read',
    body: schedulePreviewRequestSchema,
    handler: ({ body }) => automations.preview(body),
  });

  // ---- deferred messages ---------------------------------------------------------

  http.route({
    method: 'POST',
    url: '/api/deferred-messages',
    access: 'user',
    body: createDeferredMessageRequestSchema,
    handler: async ({ user, body, reply }) => {
      const created = await deferred.create(user, body);
      void reply.status(201);
      return created;
    },
  });

  http.route({
    method: 'GET',
    url: '/api/deferred-messages',
    access: 'user',
    query: listDeferredMessagesQuerySchema,
    handler: ({ user, query }) => ({ messages: deferred.list(user, query) }),
  });

  http.route({
    method: 'POST',
    url: '/api/deferred-messages/:deferredId/cancel',
    access: 'user',
    params: deferredParams,
    body: empty,
    handler: ({ user, params }) => deferred.cancel(user, params.deferredId),
  });

  http.route({
    method: 'POST',
    url: '/api/deferred-messages/:deferredId/dismiss',
    access: 'user',
    params: deferredParams,
    body: empty,
    handler: ({ user, params }) => deferred.dismiss(user, params.deferredId),
  });
}
