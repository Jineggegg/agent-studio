import dns from 'node:dns/promises';
import net from 'node:net';
import type { ProviderBalanceEntry, ProviderKind } from '@agent-studio/protocol';
import { StudioError, badRequest, unavailable } from '../../kernel/errors.js';
import { type NetPolicy, checkUrl, classifyAddress } from '../../kernel/net.js';
import { type ChatDelta, type ChatRequest, ProviderError, getJson, listModels, probeCompletion, streamChat } from './openai-client.js';

/**
 * How the Studio talks to a provider.
 *
 * Everything above this file — the tool loop, the routes — works with the
 * neutral vocabulary of `openai-client.ts` (messages, tool declarations,
 * deltas). A provider *kind* is one implementation of {@link ProviderWire};
 * adding another wire protocol means adding one here, translating to and from
 * that vocabulary, and nothing else changes.
 *
 * Every call goes through the guarded HTTP client with the provider's own
 * network policy, so a base URL can never reach further than the owner said:
 *
 * - private-network flag **off**: `https` only, and only public addresses —
 *   checked after name resolution, on the address actually connected to;
 * - flag **on**: loopback and private addresses too, and plain `http` — but
 *   plain http *only* to such addresses, never across the internet;
 * - link-local addresses (cloud metadata services) never; redirects are
 *   never followed.
 */

/** Where one request goes and with what. Built per call from the stored record; never kept. */
export interface ProviderTarget {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly allowPrivateNetwork: boolean;
}

export function policyOf(allowPrivateNetwork: boolean): NetPolicy {
  return allowPrivateNetwork ? { allowPrivateNetwork: true, allowHttp: true } : {};
}

const httpOnlyPrivate = (): StudioError =>
  badRequest('Plain http is only accepted for an address on this machine or the private network. Use https.', undefined, 'insecure_url');

/**
 * Checks a base URL against the provider's policy as far as that is possible
 * without contacting it. Returns the URL in the form it is stored in.
 */
export function checkBaseUrl(raw: string, allowPrivateNetwork: boolean): string {
  const url = checkUrl(raw.trim(), policyOf(allowPrivateNetwork));
  if (url.search !== '' || url.hash !== '') throw badRequest('A base URL has no query string or fragment.', undefined, 'invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && net.isIP(host) !== 0 && classifyAddress(host) !== 'non-public') throw httpOnlyPrivate();
  return url.href.replace(/\/+$/, '');
}

/**
 * The part of the policy the guarded client cannot express: plain http is
 * refused unless every address the host name resolves to is private. Call it
 * before each request to an `http:` provider.
 */
export async function assertTransport(target: Pick<ProviderTarget, 'baseUrl' | 'allowPrivateNetwork'>): Promise<void> {
  const url = checkUrl(target.baseUrl, policyOf(target.allowPrivateNetwork));
  if (url.protocol !== 'http:') return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    if (classifyAddress(host) !== 'non-public') throw httpOnlyPrivate();
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw unavailable('The host name of the provider could not be resolved.', 'upstream_unreachable');
  }
  if (addresses.length === 0 || addresses.some((entry) => classifyAddress(entry.address) !== 'non-public')) throw httpOnlyPrivate();
}

export interface ProviderWire {
  readonly kind: ProviderKind;
  /** Streams one completion. */
  chat(target: ProviderTarget, request: Omit<ChatRequest, 'baseUrl' | 'apiKey' | 'policy'>): AsyncGenerator<ChatDelta>;
  /** The model ids the provider lists. Throws `provider_model_not_found` when it has no listing. */
  listModels(target: ProviderTarget, signal: AbortSignal): Promise<string[]>;
  /** The cheapest authenticated request that is not the listing: resolves when the provider accepted it. */
  probe(target: ProviderTarget, model: string, signal: AbortSignal): Promise<void>;
}

const openAiCompatible: ProviderWire = {
  kind: 'openai-compatible',
  async *chat(target, request) {
    await assertTransport(target);
    yield* streamChat({ ...request, baseUrl: target.baseUrl, apiKey: target.apiKey, policy: policyOf(target.allowPrivateNetwork) });
  },
  async listModels(target, signal) {
    await assertTransport(target);
    return listModels(target.baseUrl, target.apiKey, policyOf(target.allowPrivateNetwork), signal);
  },
  async probe(target, model, signal) {
    await assertTransport(target);
    await probeCompletion({ baseUrl: target.baseUrl, apiKey: target.apiKey, model, policy: policyOf(target.allowPrivateNetwork), signal });
  },
};

const WIRES: Readonly<Record<ProviderKind, ProviderWire>> = { 'openai-compatible': openAiCompatible };

export function wireFor(kind: ProviderKind): ProviderWire {
  return WIRES[kind];
}

/** DeepSeek's documented `GET /user/balance`: `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`. */
export async function readDeepSeekBalance(target: ProviderTarget, signal: AbortSignal): Promise<{ sufficient: boolean | null; balances: ProviderBalanceEntry[] }> {
  await assertTransport(target);
  const url = new URL('/user/balance', target.baseUrl).href;
  const body = (await getJson(url, target.apiKey, { policy: policyOf(target.allowPrivateNetwork), signal, maxBytes: 64 * 1024 })) as {
    is_available?: unknown;
    balance_infos?: unknown;
  } | null;
  const amount = (value: unknown): string | null => {
    const text = typeof value === 'number' ? String(value) : value;
    return typeof text === 'string' && /^-?\d{1,15}(\.\d{1,8})?$/.test(text) ? text : null;
  };
  const balances: ProviderBalanceEntry[] = [];
  for (const entry of Array.isArray(body?.balance_infos) ? body.balance_infos.slice(0, 10) : []) {
    const info = (entry ?? {}) as Record<string, unknown>;
    const total = amount(info.total_balance);
    const currency = typeof info.currency === 'string' && /^[A-Za-z]{2,8}$/.test(info.currency) ? info.currency.toUpperCase() : null;
    if (total === null || currency === null) continue;
    balances.push({ currency, total, granted: amount(info.granted_balance), toppedUp: amount(info.topped_up_balance) });
  }
  if (balances.length === 0) throw new ProviderError(502, 'provider_protocol_error', 'The provider answered the balance request with something unexpected.');
  return { sufficient: typeof body?.is_available === 'boolean' ? body.is_available : null, balances };
}

// ---------------------------------------------------------------------------
// Failures, in words
// ---------------------------------------------------------------------------

export interface ProviderFailure {
  /** Stable and machine-readable. */
  readonly code: string;
  /** One sentence fit to show to any user: built here, never taken from the provider. */
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

const CONTEXT_OVERFLOW = /context[ _-]?length|context window|maximum context|max(?:imum)? (?:prompt|input) tokens|too many tokens|prompt is too long|reduce the length|input is too long/i;

/**
 * Turns whatever a request to a provider threw into a stable code and a
 * sentence. The provider's own error text is used only to *recognise* a
 * conversation that grew too long; it is never passed on, so nothing a
 * provider echoes (a key, internal details) can reach a transcript.
 */
export function describeFailure(error: unknown, who: { readonly name: string; readonly model?: string | null }): ProviderFailure {
  const name = who.name;
  const status = error instanceof ProviderError ? error.upstreamStatus : undefined;
  const code = error instanceof StudioError ? error.code : (error as { name?: string } | null)?.name === 'AbortError' ? 'aborted' : 'unknown';
  switch (code) {
    case 'provider_auth_failed':
      return { code, message: `${name} rejected the API key. The owner can replace it in the provider settings.` };
    case 'provider_no_credit':
      return { code, message: `${name} reports that the account has no credit left.` };
    case 'provider_model_not_found':
      return { code, message: who.model ? `${name} does not know the model "${who.model}", or the address of the provider is wrong.` : `${name} has nothing at that address. Check the base URL.` };
    case 'provider_rate_limited': {
      const retryAfterSeconds = error instanceof ProviderError ? error.retryAfterSeconds : undefined;
      return {
        code,
        message: `${name} is limiting how fast requests may be sent. Try again ${retryAfterSeconds ? `in ${Math.ceil(retryAfterSeconds)} s` : 'in a moment'}.`,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      };
    }
    case 'provider_unavailable':
      return { code, message: `${name} is having trouble${status ? ` (HTTP ${status})` : ''}. Try again later.` };
    case 'provider_rejected':
      if (status !== undefined && status >= 300 && status < 400) {
        return { code: 'provider_redirected', message: `${name} answered with a redirect (HTTP ${status}), which is never followed. Check the base URL.` };
      }
      if (error instanceof ProviderError && CONTEXT_OVERFLOW.test(error.message)) {
        return { code: 'provider_context_too_long', message: `${name} says the conversation is too long for this model. Start a new conversation, or pick a model with a larger context window.` };
      }
      return { code, message: `${name} refused the request${status ? ` (HTTP ${status})` : ''}.` };
    case 'provider_stream_error':
    case 'provider_stream_broken':
      return { code: 'provider_stream_broken', message: `The answer from ${name} broke off before it was finished.` };
    case 'provider_protocol_error':
    case 'too_large':
      return { code: 'provider_protocol_error', message: `${name} sent something that is not a valid answer. Is the base URL an OpenAI-compatible endpoint?` };
    case 'upstream_unreachable':
      return { code: 'provider_unreachable', message: `${name} could not be reached.` };
    case 'address_not_allowed':
      return { code: 'provider_address_not_allowed', message: `The address of ${name} is one this server may not contact. A model server on this machine or the private network needs "allow private network" switched on by the owner.` };
    case 'insecure_url':
    case 'invalid_url':
      return { code: 'provider_address_not_allowed', message: `The address of ${name} is not accepted: https is required, except for a server on this machine or the private network with "allow private network" switched on.` };
    case 'aborted':
      return { code: 'provider_timeout', message: `${name} took too long to answer.` };
    default:
      return { code: 'provider_error', message: `Talking to ${name} failed unexpectedly.` };
  }
}
