import {
  enablePluginRequestSchema,
  installPluginRequestSchema,
  openPluginPanelRequestSchema,
  pluginHookPayloadSchemas,
  pluginIdSchema,
  pluginPanelIdSchema,
  pluginPanelRpcRequestSchema,
  uninstallPluginRequestSchema,
  type PluginHookEvent,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { notFound } from '../../kernel/errors.js';
import type { StudioEvent } from '../../kernel/events.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { PluginsService, type PluginsOptions } from './service.js';
import { PLUGINS_MIGRATIONS } from './store.js';

declare module '../../kernel/module.js' {
  interface Services {
    plugins: PluginsService;
  }
}

const pluginParams = z.object({ id: pluginIdSchema });
const panelParams = z.object({ id: pluginIdSchema, panelId: pluginPanelIdSchema });
const assetParams = z.object({ grant: z.string().max(200), '*': z.string().max(400) });

/**
 * Plugins: owner-approved extensions whose code runs outside the server, in a
 * process that can do nothing but ask.
 *
 * `createPluginsModule` exists so that tests can shorten time limits; the
 * server uses {@link pluginsModule}, which takes every setting from the
 * configuration.
 */
export function createPluginsModule(options: PluginsOptions = {}): StudioModule {
  return {
    name: 'plugins',
    migrations: PLUGINS_MIGRATIONS,

    setup(context: ModuleContext) {
      const { http, bus } = context;
      const plugins = new PluginsService(context, options);
      context.services.plugins = plugins;
      // As with the server-wide limit, tests are not slowed down; nothing else differs between environments.
      const perMinute = (max: number) => ({ max: context.config.env === 'test' ? 100_000 : max, windowMs: 60_000 });

      // ---- management: the owner only ------------------------------------------
      http.route({ method: 'GET', url: '/api/plugins', access: 'owner', handler: () => plugins.list() });
      http.route({ method: 'GET', url: '/api/plugins/sources', access: 'owner', handler: () => plugins.sources() });

      // Installing, approving, updating and removing code are the owner's, from a
      // browser, with a sign-in that is minutes old — never an API token.
      http.route({
        method: 'POST',
        url: '/api/plugins/install',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        body: installPluginRequestSchema,
        rateLimit: perMinute(20),
        handler: async ({ user, body, request, reply }) => {
          const plugin = await plugins.install(user, body, request.ip);
          void reply.status(201);
          return plugin;
        },
      });
      http.route({ method: 'GET', url: '/api/plugins/:id', access: 'owner', params: pluginParams, handler: ({ params }) => plugins.get(params.id) });
      http.route({
        method: 'POST',
        url: '/api/plugins/:id/enable',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        params: pluginParams,
        body: enablePluginRequestSchema,
        handler: ({ user, params, body, request }) => plugins.enable(user, params.id, body, request.ip),
      });
      http.route({
        method: 'POST',
        url: '/api/plugins/:id/disable',
        access: 'owner',
        sessionOnly: true,
        params: pluginParams,
        handler: ({ user, params, request }) => plugins.disable(user, params.id, request.ip),
      });
      http.route({
        method: 'POST',
        url: '/api/plugins/:id/update',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        params: pluginParams,
        rateLimit: perMinute(20),
        handler: ({ user, params, request }) => plugins.update(user, params.id, request.ip),
      });
      http.route({
        method: 'POST',
        url: '/api/plugins/:id/uninstall',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        params: pluginParams,
        body: uninstallPluginRequestSchema,
        handler: ({ user, params, body, request }) => plugins.uninstall(user, params.id, body.deleteData, request.ip),
      });

      // ---- use: every signed-in user ---------------------------------------------
      http.route({ method: 'GET', url: '/api/plugins/contributions', access: 'user', handler: ({ user }) => plugins.contributions(user) });
      http.route({
        method: 'POST',
        url: '/api/plugins/:id/panels/:panelId/open',
        access: 'user',
        sessionOnly: true,
        params: panelParams,
        body: openPluginPanelRequestSchema,
        rateLimit: perMinute(120),
        handler: ({ user, params, body }) => plugins.openPanel(user, params.id, params.panelId, body),
      });
      http.route({
        method: 'POST',
        url: '/api/plugins/:id/rpc',
        access: 'user',
        sessionOnly: true,
        params: pluginParams,
        body: pluginPanelRpcRequestSchema,
        bodyLimit: 512 * 1024,
        rateLimit: perMinute(600),
        handler: ({ user, params, body }) => plugins.panelRpc(user, params.id, body),
      });

      // ---- panel files: the grant in the address is the credential ---------------------
      // The page these belong to has an opaque origin: what it loads comes without
      // a cookie, so the route is public and never looks at one. An unknown,
      // expired or revoked grant, a path outside the panel's folder and a file
      // type that is not served all get the same answer.
      http.route({
        method: 'GET',
        url: '/api/plugins/panel/:grant/*',
        access: 'public',
        params: assetParams,
        handler: async ({ params, request, reply }) => {
          const asset = await plugins.panelAsset(params.grant, params['*'], http.originOf(request));
          if (!asset) throw notFound();
          void reply.headers(asset.headers);
          return reply.send(asset.body);
        },
      });

      // ---- hooks: a few events, identifiers only ---------------------------------------
      const seen = new Set<string>();
      const deliver = (event: PluginHookEvent, data: unknown, dedupeKey?: string) => {
        const parsed = pluginHookPayloadSchemas[event].safeParse(data);
        if (!parsed.success) return;
        if (dedupeKey) {
          // A run's events are announced to every user who may see the run; plugins hear of each once.
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);
          if (seen.size > 2000) seen.delete(seen.values().next().value!);
        }
        plugins.dispatchHook(event, parsed.data);
      };
      const fromProjects = (event: PluginHookEvent) => (studioEvent: StudioEvent) => {
        if (studioEvent.topic === 'internal:projects') deliver(event, studioEvent.data);
      };
      const fromRuns = (event: PluginHookEvent) => (studioEvent: StudioEvent) => {
        if (!studioEvent.topic.startsWith('user:')) return;
        const runId = (studioEvent.data as { runId?: unknown } | null)?.runId;
        deliver(event, studioEvent.data, typeof runId === 'string' ? `${event}:${runId}` : undefined);
      };
      bus.on('project.created', fromProjects('project.created'));
      bus.on('project.deleted', fromProjects('project.deleted'));
      bus.on('run.started', fromRuns('run.started'));
      bus.on('run.finished', fromRuns('run.finished'));

      // ---- panel grants end with what they were bound to ---------------------------------
      bus.on('auth.credential.revoked', (event) => {
        const { credentialId } = event.data as { credentialId: string };
        plugins.revokeGrants({ credentialId });
      });
      bus.on('auth.user.revoked', (event) => {
        const { userId } = event.data as { userId: string };
        plugins.revokeGrants({ userId });
      });
      bus.on('project.deleted', (event) => {
        const { projectId } = event.data as { projectId: string };
        plugins.revokeGrants({ projectId });
      });
      bus.on('project.membership.changed', (event) => {
        const { projectId, userId } = event.data as { projectId: string; userId: string };
        plugins.revokeGrants({ projectId, userId });
      });
    },

    async start(context) {
      // Offers the tools of plugins that are already enabled. Their processes start when first needed.
      // A Studio without working plugins is still a Studio: a failure here is reported, not fatal.
      await context.services.plugins.ready().catch((error: unknown) => {
        context.log.error({ err: error instanceof Error ? error.message : 'unknown error' }, 'plugins could not be prepared');
      });
    },

    async stop(context) {
      await context.services.plugins.stopAll();
    },
  };
}

export const pluginsModule: StudioModule = createPluginsModule();
