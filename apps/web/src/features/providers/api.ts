import {
  type CreateProviderInput,
  type UpdateProviderInput,
  discoverModelsResponseSchema,
  providerBalanceSchema,
  providerListSchema,
  providerPresetListSchema,
  providerSchema,
  providerVerifyResultSchema,
  updateProviderResponseSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';

/**
 * API-model providers: OpenAI-compatible servers the Studio drives as agents.
 * The owner manages them; everyone signed in may use an enabled one. A key
 * can be written and removed, never read.
 */
const enc = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const providerKeys = {
  all: ['providers'] as const,
  list: ['providers', 'list'] as const,
  presets: ['providers', 'presets'] as const,
};

/** Talking to a provider can take a while: the server allows itself 12 s, plus the way there and back. */
const PROVIDER_CALL_MS = 30_000;

export const providersApi = {
  list: (signal?: AbortSignal) => api.get('/api/providers', { schema: providerListSchema, ...withSignal(signal) }),
  presets: (signal?: AbortSignal) => api.get('/api/providers/presets', { schema: providerPresetListSchema, ...withSignal(signal) }),
  create: (body: CreateProviderInput) => api.post('/api/providers', body, { schema: providerSchema }),
  update: (providerId: string, body: UpdateProviderInput) => api.patch(`/api/providers/${enc(providerId)}`, body, { schema: updateProviderResponseSchema }),
  remove: (providerId: string) => api.delete(`/api/providers/${enc(providerId)}`),
  removeKey: (providerId: string) => api.delete(`/api/providers/${enc(providerId)}/key`, { schema: providerSchema }),
  verify: (providerId: string) => api.post(`/api/providers/${enc(providerId)}/verify`, undefined, { schema: providerVerifyResultSchema, timeoutMs: PROVIDER_CALL_MS }),
  discover: (providerId: string) => api.post(`/api/providers/${enc(providerId)}/discover-models`, {}, { schema: discoverModelsResponseSchema, timeoutMs: PROVIDER_CALL_MS }),
  balance: (providerId: string) => api.get(`/api/providers/${enc(providerId)}/balance`, { schema: providerBalanceSchema, timeoutMs: PROVIDER_CALL_MS }),
};
