import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

/**
 * API-model providers: servers that answer the OpenAI-compatible "chat
 * completions" protocol (DeepSeek, OpenAI, a model server on the owner's own
 * machine, …) and that the Studio drives as agents.
 *
 * ## The model in one page
 *
 * - The owner manages **provider records**: a name, where the server lives, an
 *   editable **model catalogue**, and — write-only — an API key. Every
 *   signed-in user may *use* an enabled provider.
 * - Each enabled provider is one agent. Its id is {@link providerAgentId}
 *   (`api-<provider id>`); it shows up in `GET /api/agents` like the coding
 *   agents do, and sessions are created with that id.
 * - `GET /api/providers` is what a model picker reads. Everyone gets
 *   {@link Provider}; only the owner gets its `settings` (base URL, key hint,
 *   the whole catalogue). For everybody else `settings` is `null`.
 * - **A key can be written and removed, never read.** No answer contains it;
 *   the owner sees `settings.key.configured` and a short `hint` (its last four
 *   characters). Sending a blank `apiKey` in an update keeps the saved key.
 * - Saving or replacing a key, changing the base URL and switching on
 *   `allowPrivateNetwork` each decide where conversations and the key are
 *   sent. They need a signed-in browser (never an API token) that proved its
 *   identity in the last few minutes; otherwise the answer is `403
 *   reauth_required` (or `session_required`). **Changing the base URL removes
 *   the saved key** — the answer says so in `keyCleared`.
 * - Whenever a provider is created, changed or removed, `providers.changed`
 *   is published on the {@link PROVIDERS_TOPIC} realtime topic, which every
 *   signed-in client may subscribe to: re-read the list (and `/api/agents`).
 */

// ---------------------------------------------------------------------------
// Limits and vocabulary
// ---------------------------------------------------------------------------

export const PROVIDER_LIMITS = {
  providers: 20,
  nameChars: 60,
  baseUrlChars: 500,
  /** Entries in one provider's catalogue. */
  models: 200,
  modelIdChars: 200,
  modelNameChars: 80,
  /** Bounds of an API key, after trimming. */
  keyMinChars: 8,
  keyMaxChars: 512,
} as const;

/** The wire protocol a provider speaks. One today; the server keeps the door open for more. */
export const providerKindSchema = z.enum(['openai-compatible']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/**
 * How a provider's account balance can be read. `deepseek`: the documented
 * `GET /user/balance` of DeepSeek's API. `none`: the provider documents no
 * such call; only an estimate from the Studio's own usage records is offered.
 */
export const providerBalanceKindSchema = z.enum(['none', 'deepseek']);
export type ProviderBalanceKind = z.infer<typeof providerBalanceKindSchema>;

/** Lowercase letters, digits and hyphens; chosen once and never changed. */
export const providerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Not a valid provider id.');

/** The id of the agent that stands for a provider: what sessions are created with. */
export const providerAgentId = (providerId: string): string => `api-${providerId}`;

/** The provider behind an agent id, or null when the agent is not an API provider. */
export const providerIdOfAgent = (agentId: string): string | null => (agentId.startsWith('api-') && agentId.length > 4 ? agentId.slice(4) : null);

// ---------------------------------------------------------------------------
// The model catalogue
// ---------------------------------------------------------------------------

/** What a million tokens cost, in US dollars. Used only to estimate the cost of a run. */
export const providerModelPricesSchema = z.object({
  input: z.number().min(0).max(100_000),
  /** Input the provider served from its cache. Null: priced like other input. */
  cachedInput: z.number().min(0).max(100_000).nullable().default(null),
  output: z.number().min(0).max(100_000),
});
export type ProviderModelPrices = z.infer<typeof providerModelPricesSchema>;

export const providerModelIdSchema = z
  .string()
  .min(1)
  .max(PROVIDER_LIMITS.modelIdChars)
  .regex(/^[\x21-\x7e]+$/, 'A model id has no spaces or special characters.');

/** One entry of a provider's catalogue, as the owner edits it. */
export const providerModelSchema = z.object({
  /** The id sent to the provider. */
  id: providerModelIdSchema,
  name: z.string().trim().min(1).max(PROVIDER_LIMITS.modelNameChars),
  /** Tokens. Null: unknown — the server then assumes a small window when it trims history, and reports none. */
  contextWindow: z.number().int().min(1_000).max(20_000_000).nullable().default(null),
  /** Attached images may be sent to this model. */
  images: z.boolean().default(false),
  /** The model can call functions: only then does it get the Studio's tools. */
  tools: z.boolean().default(false),
  prices: providerModelPricesSchema.nullable().default(null),
  /** Kept in the catalogue but not offered in pickers. Sessions that already use it keep working. */
  hidden: z.boolean().default(false),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderModelInput = z.input<typeof providerModelSchema>;

/** A model as a picker shows it. */
export const providerModelOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().positive().nullable(),
  images: z.boolean(),
  tools: z.boolean(),
});
export type ProviderModelOption = z.infer<typeof providerModelOptionSchema>;

// ---------------------------------------------------------------------------
// Provider records
// ---------------------------------------------------------------------------

/** What is known about the saved key. Never the key. */
export const providerKeyStateSchema = z.object({
  configured: z.boolean(),
  /** The last characters of the key ("…a1b2"), or "…" for a short one. Null when none is saved. */
  hint: z.string().nullable(),
  updatedAt: timestampSchema.nullable(),
  /** False when a key is stored but can no longer be decrypted (the installation key changed): save it again. */
  readable: z.boolean(),
});
export type ProviderKeyState = z.infer<typeof providerKeyStateSchema>;

/**
 * Stable outcome codes of talking to a provider. They are the `code` of a
 * verification, of a balance reading, and of the error a failed run ends with:
 * `ok`, `provider_not_configured` (no key saved), `provider_key_unreadable`,
 * `provider_auth_failed` (key rejected), `provider_no_credit`,
 * `provider_model_not_found`, `provider_rate_limited`, `provider_unavailable`
 * (the provider's own failure), `provider_rejected` (it refused the request),
 * `provider_context_too_long`, `provider_redirected`, `provider_unreachable`,
 * `provider_address_not_allowed`, `provider_timeout`, `provider_protocol_error`,
 * `provider_stream_broken` (the answer broke off), `provider_empty_answer`,
 * `provider_no_model` (nothing in the catalogue to use), `provider_removed`
 * (removed or switched off by the owner), `provider_error` (anything else).
 */
export const providerCheckSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  /** One readable sentence. Never the provider's own error text. */
  message: z.string(),
  checkedAt: timestampSchema,
});
export type ProviderCheck = z.infer<typeof providerCheckSchema>;

/** The part of a provider only the owner sees. */
export const providerSettingsSchema = z.object({
  baseUrl: z.string(),
  /** Loopback and private-network addresses, and plain http to them, may be contacted for this provider. */
  allowPrivateNetwork: z.boolean(),
  /** False for servers that take no key (a model server on the owner's machine). */
  keyRequired: z.boolean(),
  balance: providerBalanceKindSchema,
  key: providerKeyStateSchema,
  /** Every model, hidden ones included, with prices. */
  catalogue: z.array(providerModelSchema),
  /** The preset the record was created from, if any. */
  preset: z.string().nullable(),
  createdBy: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** The outcome of the newest attempt to reach the provider since the server started, if any. */
  lastCheck: providerCheckSchema.nullable(),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export const providerSchema = z.object({
  id: providerIdSchema,
  /** The agent to create sessions with: `api-<id>`. Registered only while the provider is enabled. */
  agentId: z.string(),
  name: z.string(),
  kind: providerKindSchema,
  enabled: z.boolean(),
  /** A key is saved, or none is needed. */
  configured: z.boolean(),
  /** The models a picker offers (hidden ones left out). */
  models: z.array(providerModelOptionSchema),
  defaultModel: z.string().nullable(),
  /** Null for everyone but the owner. */
  settings: providerSettingsSchema.nullable(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerListSchema = z.object({ providers: z.array(providerSchema) });
export type ProviderList = z.infer<typeof providerListSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const providerNameSchema = z.string().trim().min(1).max(PROVIDER_LIMITS.nameChars);
export const providerBaseUrlSchema = z.string().trim().min(1).max(PROVIDER_LIMITS.baseUrlChars);
/** Checked in detail by the server, whose refusals never repeat the value. */
export const providerApiKeyInputSchema = z.string().max(4096);
const providerCatalogueInput = z.array(providerModelSchema).max(PROVIDER_LIMITS.models);

export const createProviderRequestSchema = z.object({
  /** Derived from the name when absent. */
  id: providerIdSchema.optional(),
  name: providerNameSchema,
  kind: providerKindSchema.default('openai-compatible'),
  /** e.g. "https://api.deepseek.com" or "https://api.openai.com/v1"; "/chat/completions" is appended. */
  baseUrl: providerBaseUrlSchema,
  allowPrivateNetwork: z.boolean().default(false),
  keyRequired: z.boolean().default(true),
  balance: providerBalanceKindSchema.default('none'),
  models: providerCatalogueInput.default([]),
  /** Must be in `models`. Null or absent: the first visible model. */
  defaultModel: providerModelIdSchema.nullable().optional(),
  enabled: z.boolean().default(true),
  /** Optional: save a key in the same step. */
  apiKey: providerApiKeyInputSchema.optional(),
  preset: z.string().max(40).optional(),
});
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;
export type CreateProviderInput = z.input<typeof createProviderRequestSchema>;

/** Only the fields that are sent change. */
export const updateProviderRequestSchema = z.object({
  name: providerNameSchema.optional(),
  /** Changing it removes the saved key (unless `apiKey` carries a new one). */
  baseUrl: providerBaseUrlSchema.optional(),
  allowPrivateNetwork: z.boolean().optional(),
  keyRequired: z.boolean().optional(),
  balance: providerBalanceKindSchema.optional(),
  /** The whole catalogue, replacing the stored one. */
  models: providerCatalogueInput.optional(),
  defaultModel: providerModelIdSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  /** A new key. Blank or absent keeps the saved one. */
  apiKey: providerApiKeyInputSchema.optional(),
});
export type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;
export type UpdateProviderInput = z.input<typeof updateProviderRequestSchema>;

export const updateProviderResponseSchema = z.object({
  provider: providerSchema,
  /** The saved key was removed because the base URL changed: ask for it again. */
  keyCleared: z.boolean(),
});
export type UpdateProviderResponse = z.infer<typeof updateProviderResponseSchema>;

export const setProviderKeyRequestSchema = z.object({ apiKey: providerApiKeyInputSchema });
export type SetProviderKeyRequest = z.infer<typeof setProviderKeyRequestSchema>;

/** Why a pasted key was refused (`details.reason` of `invalid_api_key`). */
export const providerKeyProblemSchema = z.enum([
  'empty',
  'too_short',
  'too_long',
  'whitespace',
  'characters',
  'looks_like_url',
  'sign_in_token',
  'admin_key',
  'other_service',
]);
export type ProviderKeyProblem = z.infer<typeof providerKeyProblemSchema>;

// ---------------------------------------------------------------------------
// Verify, discover, balance
// ---------------------------------------------------------------------------

export const providerVerifyResultSchema = providerCheckSchema.extend({
  /** `models`: the free model listing. `completion`: the server has no listing, so one token was requested. `none`: nothing was sent. */
  method: z.enum(['models', 'completion', 'none']),
  /** How many models the provider listed, when it listed any. */
  modelCount: z.number().int().nonnegative().nullable(),
});
export type ProviderVerifyResult = z.infer<typeof providerVerifyResultSchema>;

export const discoverModelsRequestSchema = z.object({
  /** Whether newly found models start hidden. Default: hidden when the catalogue already offers a model, visible when it offers none. */
  hidden: z.boolean().optional(),
});
export type DiscoverModelsRequest = z.infer<typeof discoverModelsRequestSchema>;

export const discoverModelsResponseSchema = z.object({
  provider: providerSchema,
  /** How many models the provider listed. */
  found: z.number().int().nonnegative(),
  /** The ids that were new and are now in the catalogue (with nothing assumed about what they can do). */
  added: z.array(z.string()),
  /** Listed by the provider but left out because the catalogue is full. */
  skipped: z.number().int().nonnegative(),
});
export type DiscoverModelsResponse = z.infer<typeof discoverModelsResponseSchema>;

export const providerBalanceEntrySchema = z.object({
  currency: z.string(),
  /** Decimal amounts as the provider states them. */
  total: z.string(),
  granted: z.string().nullable(),
  toppedUp: z.string().nullable(),
});
export type ProviderBalanceEntry = z.infer<typeof providerBalanceEntrySchema>;

/** What the Studio's own usage records say was spent through this provider. An estimate, never a bill. */
export const providerSpendEstimateSchema = z.object({
  /** Null when no priced run was recorded in the period. */
  last30DaysUsd: z.number().nullable(),
  totalUsd: z.number().nullable(),
  /** Runs recorded for this provider. */
  runs: z.number().int().nonnegative(),
  /** Of those, runs whose model had no price in the catalogue: they are not in the sums. */
  unpricedRuns: z.number().int().nonnegative(),
  since: timestampSchema.nullable(),
});
export type ProviderSpendEstimate = z.infer<typeof providerSpendEstimateSchema>;

export const providerBalanceSchema = z.object({
  /** True when the provider was asked and answered. */
  available: z.boolean(),
  /** `ok`, `balance_not_supported`, or one of the codes of {@link providerCheckSchema}. */
  code: z.string(),
  message: z.string(),
  /** Whether the provider says the balance suffices for requests; null when it does not say. */
  sufficient: z.boolean().nullable(),
  balances: z.array(providerBalanceEntrySchema),
  checkedAt: timestampSchema,
  estimatedSpend: providerSpendEstimateSchema,
});
export type ProviderBalance = z.infer<typeof providerBalanceSchema>;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Values that fill the "add a provider" form. They are a starting point the
 * owner can edit, taken from public documentation at the time of writing —
 * **not verified against the provider**: addresses, model ids and context
 * windows change, and "discover models" reads the current list.
 */
export const providerPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: providerKindSchema,
  /** Empty for the custom preset. */
  baseUrl: z.string(),
  allowPrivateNetwork: z.boolean(),
  keyRequired: z.boolean(),
  balance: providerBalanceKindSchema,
  models: z.array(providerModelSchema),
  defaultModel: z.string().nullable(),
  /** Always false: see above. */
  verified: z.literal(false),
  /** One sentence for the form, in English. */
  note: z.string(),
  /** Where the provider documents its API, for the owner to check the defaults against. */
  docsUrl: z.string().nullable(),
});
export type ProviderPreset = z.infer<typeof providerPresetSchema>;

export const providerPresetListSchema = z.object({ presets: z.array(providerPresetSchema) });
export type ProviderPresetList = z.infer<typeof providerPresetListSchema>;

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** A realtime topic every signed-in client may subscribe to. `providers.changed` on it means: re-read the provider and agent lists. */
export const PROVIDERS_TOPIC = 'system:providers';
export const PROVIDERS_CHANGED_EVENT = 'providers.changed';

/** Deliberately carries nothing but the id: the topic is open to every user. */
export const providersChangedEventSchema = z.object({
  providerId: providerIdSchema,
  action: z.enum(['created', 'updated', 'removed']),
});
export type ProvidersChangedEvent = z.infer<typeof providersChangedEventSchema>;

/**
 * Notices an API-model agent may put into a transcript (the `code` of a
 * `notice` event), besides the runtime's own:
 * `history_truncated`, `images_not_supported`, `attachment_skipped`,
 * `model_fallback`, `answer_truncated`, `answer_filtered`, `tool_limit`,
 * `time_limit`, `context_full`, `sandbox_unavailable`.
 */
export const PROVIDER_NOTICE = {
  historyTruncated: 'history_truncated',
  imagesNotSupported: 'images_not_supported',
  attachmentSkipped: 'attachment_skipped',
  modelFallback: 'model_fallback',
  /** The model reached the most it may write in one answer; what it wrote is kept. */
  answerTruncated: 'answer_truncated',
  /** The provider's content filter withheld part of the answer. */
  answerFiltered: 'answer_filtered',
  /** A limit on tool rounds, tool calls or the size of tool results ended the tool use of a turn. */
  toolLimit: 'tool_limit',
  timeLimit: 'time_limit',
  contextFull: 'context_full',
  sandboxUnavailable: 'sandbox_unavailable',
} as const;
