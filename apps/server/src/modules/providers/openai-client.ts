import type { Readable } from 'node:stream';
import { StudioError, unavailable } from '../../kernel/errors.js';
import { guardedRequest, readBody, type NetPolicy } from '../../kernel/net.js';
import { REDACTED, redactSecrets } from '../../kernel/redact.js';

/**
 * A minimal client for the OpenAI-compatible "chat completions" streaming
 * API, which DeepSeek, OpenAI and many self-hosted model servers speak.
 * Requests go through the guarded HTTP client: the endpoint is configuration,
 * and configuration must not be able to point the server at its own network
 * unless the owner said so.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null | ReadonlyArray<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  /** Present on assistant messages that called tools. */
  readonly tool_calls?: ReadonlyArray<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Present on tool messages: which call this answers. */
  readonly tool_call_id?: string;
  /**
   * The reasoning that came with an assistant message that called tools.
   * DeepSeek's thinking models want it handed back for the rest of the same
   * turn; it is never sent again in a later turn.
   */
  readonly reasoning_content?: string;
}

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object. */
  readonly parameters: Record<string, unknown>;
}

export interface ChatRequest {
  /** e.g. "https://api.deepseek.com" or "https://api.openai.com/v1"; "/chat/completions" is appended. */
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDeclaration[];
  /** `none`: the tools stay declared (so earlier calls in the conversation make sense) but the model must answer in words. Default `auto`. */
  readonly toolChoice?: 'auto' | 'none';
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly policy?: NetPolicy;
  /** Time allowed for the response to start. */
  readonly timeoutMs?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

export type ChatDelta =
  | { readonly type: 'text'; readonly text: string }
  /** Reasoning text, for models that expose it (DeepSeek's reasoner). */
  | { readonly type: 'reasoning'; readonly text: string }
  /** A piece of a tool call; pieces with the same index belong together. */
  | { readonly type: 'tool-call'; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: string };

export class ProviderError extends StudioError {
  readonly retryAfterSeconds: number | undefined;
  /** The HTTP status the provider answered with, when it answered at all. */
  readonly upstreamStatus: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number, upstreamStatus?: number) {
    super(status, code, message);
    this.name = 'ProviderError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.upstreamStatus = upstreamStatus;
  }
}

export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/** Splits a byte stream into server-sent events and yields each event's `data` payload. */
export async function* sseData(stream: Readable, maxEventBytes = 1024 * 1024): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let data: string[] = [];
  const flush = function* (): Generator<string> {
    if (data.length > 0) yield data.join('\n');
    data = [];
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    if (buffer.length > maxEventBytes) throw new ProviderError(502, 'provider_protocol_error', 'The model server sent an oversized event.');
    let newline: number;
    while ((newline = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
      if (line === '') yield* flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      // comments (": keep-alive"), "event:", "id:" and "retry:" lines are irrelevant here
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
  yield* flush();
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function toUsage(raw: RawUsage): TokenUsage {
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    cachedInputTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

async function failure(status: number, headers: Record<string, unknown>, body: Readable, apiKey: string | null): Promise<ProviderError> {
  const text = (await readBody(body, 64 * 1024).catch(() => Buffer.alloc(0))).toString('utf8');
  let detail: string;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message ?? '');
  } catch {
    detail = text;
  }
  // A provider may echo the key back in its error text. The key is removed before the text is cut:
  // a key cut in two at the boundary would no longer be recognised.
  detail = sanitise(detail, apiKey);
  const suffix = detail ? ` (${detail})` : '';
  const retryAfter = Number(headers['retry-after']);
  if (status === 401 || status === 403) return new ProviderError(502, 'provider_auth_failed', `The model provider rejected the API key${suffix}.`, undefined, status);
  if (status === 402) return new ProviderError(502, 'provider_no_credit', `The model provider reports insufficient balance${suffix}.`, undefined, status);
  if (status === 404) return new ProviderError(502, 'provider_model_not_found', `The model provider does not know that model or address${suffix}.`, undefined, status);
  if (status === 429) {
    return new ProviderError(503, 'provider_rate_limited', `The model provider is rate limiting requests${suffix}.`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, status);
  }
  if (status >= 500) return new ProviderError(503, 'provider_unavailable', `The model provider is having trouble (HTTP ${status})${suffix}.`, undefined, status);
  return new ProviderError(502, 'provider_rejected', `The model provider refused the request (HTTP ${status})${suffix}.`, undefined, status);
}

/**
 * Text that may contain the provider's API key, made safe to keep or show:
 * the key itself removed wherever it appears (it may have no recognisable
 * shape), then anything else key-shaped. Cut text only after this.
 */
export function withoutKey(text: string, apiKey: string | null): string {
  return redactSecrets(apiKey ? text.split(apiKey).join(REDACTED) : text);
}

/** Error text from a provider, made safe to keep: the key and anything key-shaped removed, then bounded. */
function sanitise(text: string, apiKey: string | null): string {
  return withoutKey(text, apiKey).slice(0, 300);
}

/** Streams one completion. Throws a {@link ProviderError} with a stable code when the provider refuses. */
export async function* streamChat(request: ChatRequest): AsyncGenerator<ChatDelta> {
  const payload = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools && request.tools.length > 0
      ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: request.toolChoice ?? 'auto' }
      : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const response = await guardedRequest(completionsUrl(request.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'content-length': String(body.length),
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body,
    signal: request.signal,
    timeoutMs: request.timeoutMs ?? 60_000,
    policy: request.policy,
  });
  if (response.status < 200 || response.status >= 300) {
    throw await failure(response.status, response.headers, response.body, request.apiKey);
  }

  let finished = false;
  try {
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break;
      let event: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: RawUsage | null;
        error?: { message?: string };
      };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue; // a keep-alive or a malformed line: skip rather than fail the whole answer
      }
      if (event.error) throw new ProviderError(503, 'provider_stream_error', `The model provider reported an error mid-answer (${sanitise(String(event.error.message ?? 'unknown'), request.apiKey)}).`);
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: 'reasoning', text: reasoning };
        if (delta.content) yield { type: 'text', text: delta.content };
        for (const call of delta.tool_calls ?? []) {
          yield {
            type: 'tool-call',
            index: call.index ?? 0,
            ...(call.id ? { id: call.id } : {}),
            ...(call.function?.name ? { name: call.function.name } : {}),
            ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
          };
        }
      }
      if (event.usage) yield { type: 'usage', usage: toUsage(event.usage) };
      if (choice?.finish_reason) {
        finished = true;
        yield { type: 'finish', reason: choice.finish_reason };
      }
    }
  } catch (error) {
    // A cancelled request surfaces as a broken socket; report it as what it is.
    if (request.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    if (error instanceof StudioError || (error as Error).name === 'AbortError') throw error;
    throw unavailable(`The connection to the model provider broke mid-answer: ${(error as Error).message}`, 'provider_stream_broken');
  } finally {
    response.body.destroy();
  }
  if (!finished && !request.signal?.aborted) {
    throw new ProviderError(503, 'provider_stream_broken', 'The model provider ended the answer without finishing it.');
  }
}

export interface ProviderCallOptions {
  readonly policy?: NetPolicy;
  readonly signal?: AbortSignal;
  /** Time allowed for the response to start. */
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** The address of another endpoint next to `/chat/completions`, e.g. `/models`. */
export function siblingUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')}${path}`;
}

/** GETs a JSON document from a provider, with the same failure mapping as a chat request. */
export async function getJson(url: string, apiKey: string | null, options: ProviderCallOptions = {}): Promise<unknown> {
  const response = await guardedRequest(url, {
    headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    timeoutMs: options.timeoutMs ?? 15_000,
    policy: options.policy,
    signal: options.signal,
  });
  if (response.status < 200 || response.status >= 300) throw await failure(response.status, response.headers, response.body, apiKey);
  const text = (await readBody(response.body, options.maxBytes ?? 2 * 1024 * 1024)).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(502, 'provider_protocol_error', 'The model server answered with something that is not JSON.', undefined, response.status);
  }
}

/** Lists model ids from the provider's `/models` endpoint, when it has one. */
export async function listModels(baseUrl: string, apiKey: string | null, policy?: NetPolicy, signal?: AbortSignal): Promise<string[]> {
  const parsed = (await getJson(siblingUrl(baseUrl, '/models'), apiKey, { policy, signal })) as { data?: unknown } | null;
  const entries: unknown[] = Array.isArray(parsed?.data) ? parsed.data : [];
  return entries.map((model) => (model as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 200);
}

/**
 * The cheapest authenticated call a server without a model listing offers:
 * one token, not streamed. Resolves when the provider accepted it; the answer
 * itself is thrown away.
 */
export async function probeCompletion(request: Pick<ChatRequest, 'baseUrl' | 'apiKey' | 'model' | 'policy' | 'signal' | 'timeoutMs'>): Promise<void> {
  const body = Buffer.from(JSON.stringify({ model: request.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }), 'utf8');
  const response = await guardedRequest(completionsUrl(request.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'content-length': String(body.length),
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body,
    signal: request.signal,
    timeoutMs: request.timeoutMs ?? 15_000,
    policy: request.policy,
  });
  if (response.status < 200 || response.status >= 300) throw await failure(response.status, response.headers, response.body, request.apiKey);
  response.body.resume();
  response.body.destroy();
}
