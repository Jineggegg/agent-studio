import { z } from 'zod';
import { StudioError } from '../../kernel/errors.js';
import { guardedRequest, readBody } from '../../kernel/net.js';
import {
  ProviderError,
  sseData,
  type ChatDelta,
  type ChatMessage,
  type ChatRequest,
  type TokenUsage,
} from './openai-client.js';

// Native Messages API. See the public references in docs/guides/providers.md.
// Never forward upstream error bodies: they may echo credentials or prompts.
const protocolError = () =>
  new ProviderError(
    502,
    'provider_protocol_error',
    'The provider returned an invalid Messages API response.',
  );
const object = z.record(z.string(), z.unknown());
type Block = Record<string, unknown>;

function contentBlocks(content: ChatMessage['content']): Block[] {
  if (content === null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content
    .map((part): Block => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      // Attachments have already passed the project's image admission check.
      // Remote image URLs are deliberately not fetched or sent to a third party.
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        part.image_url.url,
      );
      if (!match || match[2]!.length > 28 * 1024 * 1024)
        throw new ProviderError(
          400,
          'provider_rejected',
          'The Messages API requires a supported inline image.',
        );
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    })
    .filter((block) => block.type !== 'text' || block.text !== '');
}

/** Translate the existing shared tool loop without changing its approval rules. */
export function messagesBody(request: ChatRequest): Record<string, unknown> {
  const system: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      for (const block of contentBlocks(message.content)) {
        if (block.type !== 'text')
          throw new ProviderError(400, 'provider_rejected', 'System messages must contain text.');
        system.push(String(block.text));
      }
      continue;
    }
    const role = message.role === 'tool' ? 'user' : message.role;
    let content: Block[];
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw protocolError();
      content = [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: contentBlocks(message.content),
        },
      ];
    } else {
      content = contentBlocks(message.content);
      for (const call of message.tool_calls ?? []) {
        let input: Record<string, unknown>;
        try {
          input = object.parse(JSON.parse(call.function.arguments));
        } catch {
          throw protocolError();
        }
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
    }
    if (content.length === 0) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    messages,
    stream: true,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    // API version 2026-10-21 removed sampling-temperature parameters.
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
          tool_choice: { type: request.toolChoice ?? 'auto' },
        }
      : {}),
  };
}

const headers = (apiKey: string | null) => ({
  'anthropic-version': '2026-10-21',
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
});
const endpoint = (base: string, path: string) =>
  `${base.replace(/\/+$/, '').replace(/\/messages$/, '')}/${path}`;
function httpError(status: number): ProviderError {
  const code =
    status === 401 || status === 403
      ? 'provider_auth_failed'
      : status === 402
        ? 'provider_no_credit'
        : status === 404
          ? 'provider_model_not_found'
          : status === 429
            ? 'provider_rate_limited'
            : status >= 500
              ? 'provider_unavailable'
              : 'provider_rejected';
  return new ProviderError(
    status >= 500 ? 503 : 502,
    code,
    'The model provider refused the request.',
    undefined,
    status,
  );
}
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  index: z.number().int().nonnegative().max(1024).optional(),
  message: z.object({ usage: usageSchema.optional() }).optional(),
  usage: usageSchema.optional(),
  content_block: z
    .object({
      type: z.string(),
      id: z.string().max(200).optional(),
      name: z.string().max(200).optional(),
      text: z.string().optional(),
      input: object.optional(),
    })
    .optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      thinking: z.string().optional(),
      partial_json: z.string().optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
});

export async function* streamMessages(request: ChatRequest): AsyncGenerator<ChatDelta> {
  const body = Buffer.from(JSON.stringify(messagesBody(request)));
  const response = await guardedRequest(endpoint(request.baseUrl, 'messages'), {
    method: 'POST',
    headers: {
      ...headers(request.apiKey),
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body,
    policy: request.policy,
    signal: request.signal,
    timeoutMs: request.timeoutMs ?? 60_000,
  });
  let stopped = false;
  let finishReason: string | null = null;
  let usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  const tools = new Set<number>();
  try {
    if (response.status < 200 || response.status >= 300) throw httpError(response.status);
    for await (const raw of sseData(response.body)) {
      let event: z.infer<typeof eventSchema>;
      try {
        event = eventSchema.parse(JSON.parse(raw));
      } catch {
        throw protocolError();
      }
      if (event.type === 'error')
        throw new ProviderError(
          503,
          'provider_stream_error',
          'The provider reported an error during the answer.',
        );
      if (event.type === 'message_start' && event.message?.usage) {
        const value = event.message.usage;
        usage = {
          inputTokens:
            (value.input_tokens ?? 0) +
            (value.cache_creation_input_tokens ?? 0) +
            (value.cache_read_input_tokens ?? 0),
          cachedInputTokens: value.cache_read_input_tokens ?? 0,
          outputTokens: value.output_tokens ?? 0,
          reasoningTokens: 0,
        };
      }
      const block = event.content_block;
      if (event.type === 'content_block_start' && block) {
        if (block.type === 'text' && block.text) yield { type: 'text', text: block.text };
        if (block.type === 'tool_use') {
          if (event.index === undefined || !block.id || !block.name || tools.has(event.index))
            throw protocolError();
          tools.add(event.index);
          yield {
            type: 'tool-call',
            index: event.index,
            id: block.id,
            name: block.name,
            ...(block.input && Object.keys(block.input).length
              ? { argumentsDelta: JSON.stringify(block.input) }
              : {}),
          };
        }
      }
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text };
        if (delta?.type === 'thinking_delta' && delta.thinking)
          yield { type: 'reasoning', text: delta.thinking };
        if (delta?.type === 'input_json_delta') {
          if (
            event.index === undefined ||
            !tools.has(event.index) ||
            delta.partial_json === undefined
          )
            throw protocolError();
          yield { type: 'tool-call', index: event.index, argumentsDelta: delta.partial_json };
        }
      }
      if (event.type === 'message_delta') {
        usage = { ...usage, outputTokens: event.usage?.output_tokens ?? usage.outputTokens };
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
      }
      if (event.type === 'message_stop') {
        if (!finishReason) throw protocolError();
        stopped = true;
        yield { type: 'usage', usage };
        yield {
          type: 'finish',
          reason:
            finishReason === 'tool_use'
              ? 'tool_calls'
              : finishReason === 'max_tokens'
                ? 'length'
                : 'stop',
        };
        break;
      }
    }
  } catch (error) {
    if (request.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    if (error instanceof StudioError) throw error;
    throw new ProviderError(
      503,
      'provider_stream_broken',
      'The provider connection ended during the answer.',
    );
  } finally {
    response.body.destroy();
  }
  if (!stopped)
    throw new ProviderError(
      503,
      'provider_stream_broken',
      'The provider did not finish the answer.',
    );
}

const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(200) })).max(1000),
  has_more: z.boolean().optional(),
  last_id: z.string().max(200).nullable().optional(),
});
export async function listAnthropicModels(
  request: Pick<ChatRequest, 'baseUrl' | 'apiKey' | 'policy' | 'signal'>,
): Promise<string[]> {
  const models = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(endpoint(request.baseUrl, 'models'));
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('after_id', cursor);
    const response = await guardedRequest(url.href, {
      headers: { ...headers(request.apiKey), accept: 'application/json' },
      policy: request.policy,
      signal: request.signal,
      timeoutMs: 15_000,
    });
    try {
      if (response.status < 200 || response.status >= 300) throw httpError(response.status);
      const bytes = await readBody(response.body, 2 * 1024 * 1024);
      let result: z.infer<typeof modelsSchema>;
      try {
        result = modelsSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        throw protocolError();
      }
      for (const entry of result.data) models.add(entry.id);
      if (!result.has_more) return [...models];
      if (!result.last_id || cursor === result.last_id) throw protocolError();
      cursor = result.last_id;
    } finally {
      response.body.destroy();
    }
  }
  throw protocolError();
}
