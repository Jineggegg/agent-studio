import {
  createProviderRequestSchema,
  discoverModelsRequestSchema,
  providerIdSchema,
  setProviderKeyRequestSchema,
  updateProviderRequestSchema,
} from '@agent-studio/protocol';
import { z } from 'zod';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { type ApiAgentLimits, DEFAULT_LIMITS } from './limits.js';
import { ProvidersService } from './providers.service.js';
import { PROVIDERS_MIGRATIONS } from './providers.store.js';

declare module '../../kernel/module.js' {
  interface Services {
    providers: ProvidersService;
  }
}

export interface ProvidersModuleOptions {
  /** Overrides of the tool loop's limits (tests use small ones). */
  readonly limits?: Partial<ApiAgentLimits>;
  /** How long "verify", "discover models" and "balance" may take in all. Default 12 s. */
  readonly probeTimeoutMs?: number;
  /** How often one caller may use those three routes. Default 20 a minute. */
  readonly probeRateLimit?: { readonly max: number; readonly windowMs: number };
}

const providerParams = z.object({ providerId: providerIdSchema });

/**
 * API-model providers: the records the owner manages, their write-only keys,
 * and one agent per enabled provider (`api-<id>`), registered with the agent
 * runtime and added or removed as providers change.
 *
 * Routes (schemas in `@agent-studio/protocol`, `providers.ts`):
 *
 * | Route | Who | |
 * | --- | --- | --- |
 * | `GET /api/providers` | user | the list; `settings` only for the owner |
 * | `GET /api/providers/presets` | owner | values that fill the form |
 * | `GET /api/providers/:id` | user | one provider |
 * | `POST /api/providers` | owner, browser session, recent sign-in | create (optionally with a key) |
 * | `PATCH /api/providers/:id` | owner (+ session and recent sign-in for address, private network, key) | change |
 * | `DELETE /api/providers/:id` | owner | remove the provider and its key |
 * | `PUT /api/providers/:id/key` | owner, browser session, recent sign-in | save or replace the key |
 * | `DELETE /api/providers/:id/key` | owner | remove the key |
 * | `POST /api/providers/:id/verify` | owner, rate-limited | check the connection |
 * | `POST /api/providers/:id/discover-models` | owner, rate-limited | add the provider's models to the catalogue |
 * | `GET /api/providers/:id/balance` | owner, rate-limited | balance where documented, plus estimated spend |
 */
export function createProvidersModule(options: ProvidersModuleOptions = {}): StudioModule {
  return {
    name: 'providers',
    migrations: PROVIDERS_MIGRATIONS,

    setup(context: ModuleContext) {
      const { http, config } = context;
      const service = new ProvidersService(context, {
        limits: { ...DEFAULT_LIMITS, ...options.limits },
        probeTimeoutMs: options.probeTimeoutMs ?? 12_000,
      });
      context.services.providers = service;
      // The agent runtime is set up before this module: every enabled provider becomes an agent now.
      service.registerAll();

      const probeRateLimit = options.probeRateLimit ?? { max: config.env === 'test' ? 10_000 : 20, windowMs: 60_000 };

      // ---- reading -----------------------------------------------------------
      http.route({
        method: 'GET',
        url: '/api/providers',
        access: 'user',
        handler: ({ user }) => ({ providers: service.list(user) }),
      });
      http.route({
        method: 'GET',
        url: '/api/providers/presets',
        access: 'owner',
        scope: 'read',
        handler: () => ({ presets: service.presets() }),
      });
      http.route({
        method: 'GET',
        url: '/api/providers/:providerId',
        access: 'user',
        params: providerParams,
        handler: ({ user, params }) => service.get(user, params.providerId),
      });

      // ---- changes (owner) ---------------------------------------------------
      // A new provider names an address conversations will be sent to: a browser session with a fresh sign-in.
      http.route({
        method: 'POST',
        url: '/api/providers',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        body: createProviderRequestSchema,
        handler: ({ user, body, reply }) => {
          void reply.status(201);
          return service.create(user, body);
        },
      });
      // Renaming, the catalogue and the on/off switch need nothing more than being the owner;
      // the service asks for a fresh browser sign-in when the address, the network policy or the key changes.
      http.route({
        method: 'PATCH',
        url: '/api/providers/:providerId',
        access: 'owner',
        params: providerParams,
        body: updateProviderRequestSchema,
        handler: ({ user, params, body }) => service.update(user, params.providerId, body),
      });
      http.route({
        method: 'DELETE',
        url: '/api/providers/:providerId',
        access: 'owner',
        params: providerParams,
        handler: ({ user, params }) => {
          service.remove(user, params.providerId);
        },
      });
      http.route({
        method: 'PUT',
        url: '/api/providers/:providerId/key',
        access: 'owner',
        sessionOnly: true,
        recentAuth: true,
        params: providerParams,
        body: setProviderKeyRequestSchema,
        handler: ({ user, params, body }) => service.setKey(user, params.providerId, body.apiKey),
      });
      // Removing a key always works: no fresh sign-in, and an admin token may do it too.
      http.route({
        method: 'DELETE',
        url: '/api/providers/:providerId/key',
        access: 'owner',
        params: providerParams,
        handler: ({ user, params }) => service.removeKey(user, params.providerId),
      });

      // ---- talking to the provider on request (owner, rate-limited) -----------
      http.route({
        method: 'POST',
        url: '/api/providers/:providerId/verify',
        access: 'owner',
        params: providerParams,
        rateLimit: probeRateLimit,
        handler: ({ params }) => service.verify(params.providerId),
      });
      http.route({
        method: 'POST',
        url: '/api/providers/:providerId/discover-models',
        access: 'owner',
        params: providerParams,
        body: discoverModelsRequestSchema,
        rateLimit: probeRateLimit,
        handler: ({ user, params, body }) => service.discover(user, params.providerId, body),
      });
      http.route({
        method: 'GET',
        url: '/api/providers/:providerId/balance',
        access: 'owner',
        scope: 'read',
        params: providerParams,
        rateLimit: probeRateLimit,
        handler: ({ params }) => service.balance(params.providerId),
      });
    },
  };
}

export const providersModule: StudioModule = createProvidersModule();
