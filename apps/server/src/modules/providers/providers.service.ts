import {
  type CreateProviderRequest,
  type DiscoverModelsRequest,
  type DiscoverModelsResponse,
  PROVIDERS_CHANGED_EVENT,
  PROVIDERS_TOPIC,
  PROVIDER_LIMITS,
  type Provider,
  type ProviderBalance,
  type ProviderCheck,
  type ProviderKeyState,
  type ProviderModel,
  type ProviderPreset,
  type ProviderVerifyResult,
  type ProvidersChangedEvent,
  type UpdateProviderRequest,
  type UpdateProviderResponse,
  providerAgentId,
  providerModelIdSchema,
} from '@agent-studio/protocol';
import { StudioError, badRequest, conflict, describeError, forbidden, notFound } from '../../kernel/errors.js';
import { RECENT_AUTH_WINDOW_MS } from '../../kernel/http.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import { ApiModelAdapter, type ProviderAccess } from './api-adapter.js';
import { defaultModelOf, visibleModels } from './catalogue.js';
import { checkApiKey } from './key-rules.js';
import type { ApiAgentLimits } from './limits.js';
import { ProviderError } from './openai-client.js';
import { PROVIDER_PRESETS, findPreset } from './presets.js';
import { type ProviderRecord, ProviderStore } from './providers.store.js';
import { type ProviderFailure, type ProviderTarget, checkBaseUrl, describeFailure, readDeepSeekBalance, wireFor } from './wire.js';

export interface ProvidersOptions {
  readonly limits: ApiAgentLimits;
  /** How long "verify", "discover models" and "balance" may take in all. */
  readonly probeTimeoutMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const keyName = (providerId: string): string => `provider:${providerId}:api-key`;

/** "My Local LLM" → "my-local-llm". A name without Latin letters or digits gives "provider". */
function slug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const lettered = /^[a-z]/.test(base) ? base : base === '' ? 'provider' : `p-${base}`;
  return lettered.slice(0, 28).replace(/-+$/, '');
}

function checkCatalogue(models: readonly ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw badRequest('A model is in the list twice.', undefined, 'invalid_models');
    seen.add(model.id);
  }
  return [...models];
}

/**
 * Provider records, their keys, and the agents that stand for them.
 *
 * Who may do what:
 * - **Any signed-in user** may list providers and use an enabled one. They
 *   learn its name, whether it is ready, and the models to pick from —
 *   nothing about where it lives or what its key looks like.
 * - **Only the owner** creates, changes and removes providers, and sees the
 *   address, the catalogue with prices, and whether a key is saved and since when.
 * - **Nobody reads a key back.** It goes into the encrypted secret store and
 *   leaves it only inside this process, for the request to the provider.
 *
 * Three changes decide where conversations — and the key — are sent: saving
 * a key, changing the base URL, and allowing the private network. Each needs
 * a browser session that proved its identity in the last few minutes; an API
 * token can never make them. A changed base URL always loses the saved key:
 * with a hijacked session and no step-up the key must not follow to a new
 * address, and with step-up asking for it again is still the right habit.
 */
export class ProvidersService {
  readonly #context: ModuleContext;
  readonly #store: ProviderStore;
  readonly #options: ProvidersOptions;
  readonly #adapters = new Map<string, ApiModelAdapter>();
  /** How the newest request to each provider went. In memory only: a restart starts without an opinion. */
  readonly #checks = new Map<string, ProviderCheck>();
  /** Whether a saved key could be decrypted, remembered per key version. */
  readonly #readable = new Map<string, { updatedAt: number; readable: boolean }>();

  constructor(context: ModuleContext, options: ProvidersOptions) {
    this.#context = context;
    this.#store = new ProviderStore(context.db);
    this.#options = options;
  }

  // ---- reading ---------------------------------------------------------------

  /** Every record, for other modules. Never contains a key. */
  records(): ProviderRecord[] {
    return this.#store.list();
  }

  find(providerId: string): ProviderRecord | null {
    return this.#store.find(providerId);
  }

  list(principal: Principal): Provider[] {
    return this.#store.list().map((record) => this.present(record, principal));
  }

  get(principal: Principal, providerId: string): Provider {
    return this.present(this.#require(providerId), principal);
  }

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS.map((preset) => ({ ...preset, models: preset.models.map((model) => ({ ...model })) }));
  }

  present(record: ProviderRecord, principal: Principal): Provider {
    const key = this.#keyState(record.id);
    return {
      id: record.id,
      agentId: providerAgentId(record.id),
      name: record.name,
      kind: record.kind,
      enabled: record.enabled,
      configured: this.blocked(record) === null,
      models: visibleModels(record).map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, images: model.images, tools: model.tools })),
      defaultModel: defaultModelOf(record),
      settings:
        principal.role !== 'owner'
          ? null
          : {
              baseUrl: record.baseUrl,
              allowPrivateNetwork: record.allowPrivateNetwork,
              keyRequired: record.keyRequired,
              balance: record.balance,
              key,
              catalogue: record.models.map((model) => ({ ...model })),
              preset: record.preset,
              createdBy: record.createdBy,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              lastCheck: this.#checks.get(record.id) ?? null,
            },
    };
  }

  #require(providerId: string): ProviderRecord {
    const record = this.#store.find(providerId);
    if (!record) throw notFound('No such provider.', 'provider_not_found');
    return record;
  }

  // ---- keys ------------------------------------------------------------------

  #keyState(providerId: string): ProviderKeyState {
    const described = this.#context.secrets.describe(keyName(providerId));
    if (!described) return { configured: false, hint: null, updatedAt: null, readable: true };
    let known = this.#readable.get(providerId);
    if (!known || known.updatedAt !== described.updatedAt) {
      let readable = false;
      try {
        readable = this.#context.secrets.reveal(keyName(providerId)) !== null;
      } catch {
        // The installation key changed or the record is damaged: not a crash, a state to report.
      }
      known = { updatedAt: described.updatedAt, readable };
      this.#readable.set(providerId, known);
    }
    return { configured: true, hint: described.hint, updatedAt: described.updatedAt, readable: known.readable };
  }

  /** Why no request can be sent to this provider right now, or null. */
  blocked(record: ProviderRecord): ProviderFailure | null {
    const key = this.#keyState(record.id);
    if (key.configured && !key.readable) {
      return { code: 'provider_key_unreadable', message: `The saved API key of ${record.name} cannot be read any more. The owner has to save it again.` };
    }
    if (record.keyRequired && !key.configured) {
      return { code: 'provider_not_configured', message: `No API key is saved for ${record.name}. The owner can add one in the provider settings.` };
    }
    return null;
  }

  /** Where a request to this provider goes. The only place a key leaves the secret store. */
  #target(record: ProviderRecord): { ok: true; target: ProviderTarget } | { ok: false; failure: ProviderFailure } {
    const failure = this.blocked(record);
    if (failure) return { ok: false, failure };
    try {
      const apiKey = this.#context.secrets.reveal(keyName(record.id));
      return { ok: true, target: { kind: record.kind, baseUrl: record.baseUrl, apiKey, allowPrivateNetwork: record.allowPrivateNetwork } };
    } catch {
      return { ok: false, failure: { code: 'provider_key_unreadable', message: `The saved API key of ${record.name} cannot be read any more. The owner has to save it again.` } };
    }
  }

  #validKey(raw: string): string {
    const checked = checkApiKey(raw);
    // The refusal names the kind of problem; it never repeats what was pasted.
    if (!checked.ok) throw badRequest(checked.message, { reason: checked.problem }, 'invalid_api_key');
    return checked.key;
  }

  /** Redirecting conversations or the key takes a browser session with a fresh proof of identity. */
  #stepUp(user: Principal): void {
    if (user.via !== 'session') throw forbidden('This can only be done from a signed-in browser, not with an API token.', 'session_required');
    if (Date.now() - user.authenticatedAt > RECENT_AUTH_WINDOW_MS) throw forbidden('Confirm your identity to continue.', 'reauth_required');
  }

  #audit(user: Principal, action: string, record: Pick<ProviderRecord, 'id' | 'name'>, detail = ''): void {
    try {
      this.#context.services.audit.record({ category: 'change', action, userId: user.userId, subject: `${record.name} (${record.id})`, detail });
    } catch (error) {
      this.#context.log.error({ err: describeError(error) }, 'writing the audit log failed');
    }
  }

  #announce(providerId: string, action: ProvidersChangedEvent['action']): void {
    const event: ProvidersChangedEvent = { providerId, action };
    this.#context.bus.publish(PROVIDERS_TOPIC, PROVIDERS_CHANGED_EVENT, event);
  }

  // ---- changes (owner) -------------------------------------------------------

  create(user: Principal, input: CreateProviderRequest): Provider {
    this.#stepUp(user);
    if (this.#store.count() >= PROVIDER_LIMITS.providers) {
      throw conflict(`At most ${PROVIDER_LIMITS.providers} providers can be configured. Remove one first.`, 'too_many_providers');
    }
    let id = input.id ?? slug(input.name);
    // "presets" is a route of its own; an agent of another module may already carry the id the provider's agent would get.
    const taken = (candidate: string): boolean =>
      candidate === 'presets' || this.#store.find(candidate) !== null || this.#context.services.agents.adapter(providerAgentId(candidate)) !== undefined;
    if (input.id !== undefined) {
      if (taken(id)) throw conflict('A provider with that id already exists.', 'provider_exists');
    } else {
      const base = id;
      for (let suffix = 2; taken(id); suffix += 1) id = `${base}-${suffix}`;
    }

    const baseUrl = checkBaseUrl(input.baseUrl, input.allowPrivateNetwork);
    const models = checkCatalogue(input.models);
    const defaultModel = input.defaultModel ?? null;
    if (defaultModel !== null && !models.some((model) => model.id === defaultModel)) {
      throw badRequest('The default model is not in the list of models.', undefined, 'invalid_models');
    }
    const apiKey = input.apiKey !== undefined && input.apiKey.trim() !== '' ? this.#validKey(input.apiKey) : null;
    const now = Date.now();
    const record: ProviderRecord = {
      id,
      name: input.name,
      kind: input.kind,
      baseUrl,
      allowPrivateNetwork: input.allowPrivateNetwork,
      keyRequired: input.keyRequired,
      balance: input.balance,
      models,
      defaultModel,
      enabled: input.enabled,
      preset: input.preset !== undefined && findPreset(input.preset) ? input.preset : null,
      createdBy: user.userId,
      createdAt: now,
      updatedAt: now,
    };
    this.#context.db.transaction(() => {
      this.#store.insert(record);
      // A key left behind under this id by anything else must not be picked up.
      this.#context.secrets.delete(keyName(id));
      if (apiKey !== null) this.#context.secrets.put(keyName(id), apiKey);
    });
    this.#readable.delete(id);
    this.#checks.delete(id);
    this.#audit(user, 'provider.created', record, `${new URL(baseUrl).host}${record.allowPrivateNetwork ? ' · private network allowed' : ''}${apiKey === null ? '' : ' · key saved'}`);
    this.#context.log.info({ provider: id, userId: user.userId, keySaved: apiKey !== null }, 'provider created');
    this.#sync(id);
    this.#announce(id, 'created');
    return this.present(record, user);
  }

  update(user: Principal, providerId: string, input: UpdateProviderRequest): UpdateProviderResponse {
    const record = this.#require(providerId);
    const allowPrivateNetwork = input.allowPrivateNetwork ?? record.allowPrivateNetwork;
    // The address is judged again whenever it or the policy it lives under changes.
    const baseUrl =
      input.baseUrl !== undefined || allowPrivateNetwork !== record.allowPrivateNetwork ? checkBaseUrl(input.baseUrl ?? record.baseUrl, allowPrivateNetwork) : record.baseUrl;
    const baseUrlChanged = baseUrl !== record.baseUrl;
    const newKey = input.apiKey !== undefined && input.apiKey.trim() !== '' ? this.#validKey(input.apiKey) : null;
    if (baseUrlChanged || newKey !== null || (allowPrivateNetwork && !record.allowPrivateNetwork)) this.#stepUp(user);

    const models = input.models === undefined ? [...record.models] : checkCatalogue(input.models);
    let defaultModel = input.defaultModel === undefined ? record.defaultModel : input.defaultModel;
    if (input.defaultModel != null && !models.some((model) => model.id === defaultModel)) {
      throw badRequest('The default model is not in the list of models.', undefined, 'invalid_models');
    }
    // A default that was removed from the list is no default any more.
    if (defaultModel !== null && !models.some((model) => model.id === defaultModel)) defaultModel = null;

    const next: ProviderRecord = {
      ...record,
      name: input.name ?? record.name,
      baseUrl,
      allowPrivateNetwork,
      keyRequired: input.keyRequired ?? record.keyRequired,
      balance: input.balance ?? record.balance,
      models,
      defaultModel,
      enabled: input.enabled ?? record.enabled,
      updatedAt: Date.now(),
    };
    const hadKey = this.#context.secrets.describe(keyName(providerId)) !== null;
    const keyCleared = baseUrlChanged && hadKey && newKey === null;
    this.#context.db.transaction(() => {
      this.#store.update(next);
      if (newKey !== null) this.#context.secrets.put(keyName(providerId), newKey);
      else if (keyCleared) this.#context.secrets.delete(keyName(providerId));
    });
    if (baseUrlChanged || newKey !== null || keyCleared) {
      this.#readable.delete(providerId);
      this.#checks.delete(providerId);
    }

    const changed = [
      next.name !== record.name ? 'name' : '',
      baseUrlChanged ? `address → ${new URL(baseUrl).host}` : '',
      allowPrivateNetwork !== record.allowPrivateNetwork ? `private network ${allowPrivateNetwork ? 'allowed' : 'no longer allowed'}` : '',
      next.keyRequired !== record.keyRequired ? 'key requirement' : '',
      next.enabled !== record.enabled ? (next.enabled ? 'enabled' : 'disabled') : '',
      input.models !== undefined || next.defaultModel !== record.defaultModel ? 'models' : '',
      next.balance !== record.balance ? 'balance reading' : '',
      newKey !== null ? (hadKey ? 'key replaced' : 'key saved') : '',
      keyCleared ? 'key removed because the address changed' : '',
    ].filter(Boolean);
    this.#audit(user, 'provider.updated', next, changed.join(' · '));
    this.#context.log.info({ provider: providerId, userId: user.userId, keySaved: newKey !== null, keyCleared }, 'provider updated');
    this.#sync(providerId);
    this.#announce(providerId, 'updated');
    return { provider: this.present(next, user), keyCleared };
  }

  setKey(user: Principal, providerId: string, rawKey: string): Provider {
    const record = this.#require(providerId);
    this.#stepUp(user);
    const apiKey = this.#validKey(rawKey);
    const replaced = this.#context.secrets.describe(keyName(providerId)) !== null;
    this.#context.secrets.put(keyName(providerId), apiKey);
    this.#readable.delete(providerId);
    this.#checks.delete(providerId);
    this.#audit(user, replaced ? 'provider.key.replaced' : 'provider.key.saved', record);
    this.#context.log.info({ provider: providerId, userId: user.userId }, replaced ? 'provider key replaced' : 'provider key saved');
    this.#announce(providerId, 'updated');
    return this.present(record, user);
  }

  /** Always possible: taking a key away needs no proof beyond being the owner. */
  removeKey(user: Principal, providerId: string): Provider {
    const record = this.#require(providerId);
    const removed = this.#context.secrets.delete(keyName(providerId));
    this.#readable.delete(providerId);
    this.#checks.delete(providerId);
    if (removed) {
      this.#audit(user, 'provider.key.removed', record);
      this.#context.log.info({ provider: providerId, userId: user.userId }, 'provider key removed');
      this.#announce(providerId, 'updated');
    }
    return this.present(record, user);
  }

  /** Removes the record and its key. Sessions that used the provider stay readable; their agent is gone. */
  remove(user: Principal, providerId: string): void {
    const record = this.#require(providerId);
    this.#context.db.transaction(() => {
      this.#store.delete(providerId);
      this.#context.secrets.delete(keyName(providerId));
    });
    this.#readable.delete(providerId);
    this.#checks.delete(providerId);
    this.#audit(user, 'provider.deleted', record);
    this.#context.log.info({ provider: providerId, userId: user.userId }, 'provider removed');
    this.#sync(providerId);
    this.#announce(providerId, 'removed');
  }

  // ---- talking to the provider on request (owner) ----------------------------

  /** Runs one bounded exchange with the provider and tells failures apart from running out of time. */
  async #probe<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.probeTimeoutMs);
    try {
      return await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new DOMException('The provider took too long.', 'AbortError');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #failed(record: ProviderRecord, error: unknown, model?: string | null): ProviderFailure {
    const failure = describeFailure(error, { name: record.name, model: model ?? null });
    if (failure.code === 'provider_error') {
      this.#context.log.error({ provider: record.id, err: redactSecrets(describeError(error)) }, 'a request to a model provider failed unexpectedly');
    }
    return failure;
  }

  #remember(providerId: string, outcome: { ok: boolean; code: string; message: string }): ProviderCheck {
    const check: ProviderCheck = { ok: outcome.ok, code: outcome.code, message: outcome.message, checkedAt: Date.now() };
    // The record may have been removed while the request was under way.
    if (this.#store.find(providerId)) this.#checks.set(providerId, check);
    return check;
  }

  /**
   * The cheapest authenticated call: the model listing, which costs nothing.
   * Only when the server has no listing is one token requested from the
   * default model instead.
   */
  async verify(providerId: string): Promise<ProviderVerifyResult> {
    const record = this.#require(providerId);
    const access = this.#target(record);
    if (!access.ok) return { ...this.#remember(providerId, { ok: false, ...access.failure }), method: 'none', modelCount: null };
    const wire = wireFor(record.kind);
    try {
      const models = await this.#probe((signal) => wire.listModels(access.target, signal));
      return { ...this.#remember(providerId, { ok: true, code: 'ok', message: `${record.name} accepted the request and lists ${models.length} model${models.length === 1 ? '' : 's'}.` }), method: 'models', modelCount: models.length };
    } catch (error) {
      const status = error instanceof ProviderError ? error.upstreamStatus : undefined;
      const noListing = status === 404 || status === 405 || status === 501;
      if (!noListing) return { ...this.#remember(providerId, { ok: false, ...this.#failed(record, error) }), method: 'models', modelCount: null };
    }
    const model = defaultModelOf(record) ?? record.models[0]?.id ?? null;
    if (model === null) {
      const message = `${record.name} has no model listing, and no model is named in the catalogue to try instead. Add a model first.`;
      return { ...this.#remember(providerId, { ok: false, code: 'provider_no_model', message }), method: 'none', modelCount: null };
    }
    try {
      await this.#probe((signal) => wire.probe(access.target, model, signal));
      return { ...this.#remember(providerId, { ok: true, code: 'ok', message: `${record.name} accepted a request to ${model}.` }), method: 'completion', modelCount: null };
    } catch (error) {
      return { ...this.#remember(providerId, { ok: false, ...this.#failed(record, error, model) }), method: 'completion', modelCount: null };
    }
  }

  /** Reads the provider's model list and adds what is new to the catalogue — as plain entries the owner then edits. */
  async discover(user: Principal, providerId: string, body: DiscoverModelsRequest): Promise<DiscoverModelsResponse> {
    const record = this.#require(providerId);
    const access = this.#target(record);
    if (!access.ok) throw new StudioError(409, access.failure.code, access.failure.message);
    let listed: string[];
    try {
      listed = await this.#probe((signal) => wireFor(record.kind).listModels(access.target, signal));
    } catch (error) {
      const failure = this.#failed(record, error);
      this.#remember(providerId, { ok: false, ...failure });
      throw new StudioError(502, failure.code, failure.message);
    }
    this.#remember(providerId, { ok: true, code: 'ok', message: `${record.name} lists ${listed.length} model${listed.length === 1 ? '' : 's'}.` });

    // The record may have changed while the provider was asked.
    const current = this.#require(providerId);
    const known = new Set(current.models.map((model) => model.id));
    const fresh = [...new Set(listed)].filter((id) => !known.has(id) && providerModelIdSchema.safeParse(id).success);
    const room = Math.max(0, PROVIDER_LIMITS.models - current.models.length);
    const hidden = body.hidden ?? visibleModels(current).length > 0;
    // Nothing is assumed about a model that was only just heard of: no tools, no images, no price.
    const added: ProviderModel[] = fresh.slice(0, room).map((id) => ({ id, name: id.slice(0, PROVIDER_LIMITS.modelNameChars), contextWindow: null, images: false, tools: false, prices: null, hidden }));
    let next = current;
    if (added.length > 0) {
      next = { ...current, models: [...current.models, ...added], updatedAt: Date.now() };
      this.#store.update(next);
      this.#audit(user, 'provider.models.discovered', next, `${added.length} added`);
      this.#announce(providerId, 'updated');
    }
    return { provider: this.present(next, user), found: listed.length, added: added.map((model) => model.id), skipped: fresh.length - added.length };
  }

  /** The balance where the provider documents a way to read it; always the Studio's own estimate of what was spent. */
  async balance(providerId: string): Promise<ProviderBalance> {
    const record = this.#require(providerId);
    const now = Date.now();
    const spend = this.#store.spend(providerAgentId(providerId), now - 30 * DAY_MS);
    const estimatedSpend = { last30DaysUsd: spend.recentUsd, totalUsd: spend.totalUsd, runs: spend.runs, unpricedRuns: spend.unpricedRuns, since: spend.since };
    const unavailable = (code: string, message: string): ProviderBalance => ({ available: false, code, message, sufficient: null, balances: [], checkedAt: Date.now(), estimatedSpend });

    if (record.balance !== 'deepseek') {
      return unavailable('balance_not_supported', `${record.name} documents no way to read the account balance. The estimate below comes from this Studio's own usage records.`);
    }
    const access = this.#target(record);
    if (!access.ok) return unavailable(access.failure.code, access.failure.message);
    try {
      const read = await this.#probe((signal) => readDeepSeekBalance(access.target, signal));
      return { available: true, code: 'ok', message: `Balance as reported by ${record.name}.`, sufficient: read.sufficient, balances: read.balances, checkedAt: Date.now(), estimatedSpend };
    } catch (error) {
      const failure = this.#failed(record, error);
      return unavailable(failure.code, failure.message);
    }
  }

  // ---- the agents ------------------------------------------------------------

  #accessFor(providerId: string): ProviderAccess {
    return {
      record: () => this.#store.find(providerId),
      target: (record) => this.#target(record),
      blocked: (record) => this.blocked(record),
      lastCheck: () => this.#checks.get(providerId) ?? null,
      report: (outcome) => {
        this.#remember(providerId, outcome);
      },
    };
  }

  /** Makes the agent runtime match the record: registered while the provider exists and is enabled, gone otherwise. */
  #sync(providerId: string): void {
    const record = this.#store.find(providerId);
    const adapter = this.#adapters.get(providerId);
    const agents = this.#context.services.agents;
    if (record?.enabled) {
      if (adapter) return;
      const created = new ApiModelAdapter({ providerId, name: record.name, context: this.#context, access: this.#accessFor(providerId), limits: this.#options.limits });
      try {
        agents.registerAdapter(created);
        this.#adapters.set(providerId, created);
      } catch (error) {
        this.#context.log.error({ provider: providerId, err: describeError(error) }, 'an API provider could not be registered as an agent');
      }
      return;
    }
    if (!adapter) return;
    agents.unregisterAdapter(adapter.id);
    this.#adapters.delete(providerId);
    // No request goes to a provider that was removed or switched off.
    adapter.stopAll();
  }

  /** Registers an agent for every enabled provider. Called once, during set-up. */
  registerAll(): void {
    for (const record of this.#store.list()) this.#sync(record.id);
  }

  /** How many turns of API models are in progress — for tests and health information. */
  get activeTurns(): number {
    let count = 0;
    for (const adapter of this.#adapters.values()) count += adapter.activeTurns;
    return count;
  }
}
