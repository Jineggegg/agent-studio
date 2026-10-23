import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAnthropicModels, messagesBody, streamMessages } from './anthropic-client.js';
import type { ChatDelta, ChatRequest } from './openai-client.js';

const base: ChatRequest = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'synthetic-credential',
  model: 'test-model',
  messages: [],
};
const collect = async (input: AsyncIterable<ChatDelta>) => {
  const result: ChatDelta[] = [];
  for await (const item of input) result.push(item);
  return result;
};

describe('Messages request translation', () => {
  it('preserves the system, tool ids, grouped results and inline images', () => {
    const body = messagesBody({
      ...base,
      temperature: 0.3,
      toolChoice: 'none',
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
      messages: [
        { role: 'system', content: 'Instructions' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'a',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"example.txt"}' },
            },
            { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: 'First result' },
        { role: 'tool', tool_call_id: 'b', content: 'Second result' },
      ],
    });
    expect(body).toMatchObject({
      system: 'Instructions',
      tool_choice: { type: 'none' },
      tools: [{ input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'a', input: { path: 'example.txt' } },
            { type: 'tool_use', id: 'b', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a' },
            { type: 'tool_result', tool_use_id: 'b' },
          ],
        },
      ],
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it.each([
    'https://example.test/image.png',
    'data:image/svg+xml;base64,YQ==',
    'file:///etc/passwd',
  ])('rejects unsafe image source %s', (url) => {
    expect(() =>
      messagesBody({
        ...base,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
      }),
    ).toThrow('inline image');
  });
  it('does not turn malformed tool JSON into a new tool call', () => {
    expect(() =>
      messagesBody({
        ...base,
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'write_file', arguments: '{' } },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('Messages transport', () => {
  let server: http.Server;
  let url: string;
  let lastHeaders: http.IncomingHttpHeaders;
  let lastBody: Record<string, unknown>;
  let status = 200;
  let events: unknown[] = [];
  let modelRequests: string[] = [];
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      lastHeaders = request.headers;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (request.url?.startsWith('/v1/models')) {
          modelRequests.push(request.url);
          const second = request.url.includes('after_id=');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              data: [{ id: second ? 'second' : 'first' }],
              has_more: !second,
              last_id: second ? 'second' : 'first',
            }),
          );
          return;
        }
        lastBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        response.writeHead(status, {
          'content-type': 'text/event-stream',
          ...(status === 302 ? { location: 'https://example.test/receive-key' } : {}),
        });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());
  const request = (): ChatRequest => ({
    ...base,
    baseUrl: url,
    policy: { allowPrivateNetwork: true, allowHttp: true },
    messages: [{ role: 'user', content: 'Hello' }],
  });

  it('streams text and tool arguments and counts cumulative cached usage once', async () => {
    status = 200;
    events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 8,
            output_tokens: 1,
          },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call-one', name: 'read_file', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"readme.txt"}' },
      },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    expect(await collect(streamMessages(request()))).toEqual([
      { type: 'text', text: 'Ready' },
      { type: 'tool-call', index: 1, id: 'call-one', name: 'read_file' },
      { type: 'tool-call', index: 1, argumentsDelta: '{"path":' },
      { type: 'tool-call', index: 1, argumentsDelta: '"readme.txt"}' },
      {
        type: 'usage',
        usage: { inputTokens: 16, cachedInputTokens: 8, outputTokens: 9, reasoningTokens: 0 },
      },
      { type: 'finish', reason: 'tool_calls' },
    ]);
    expect(lastHeaders!.authorization).toBe('Bearer synthetic-credential');
    expect(lastHeaders!['anthropic-version']).toBe('2026-10-21');
    expect(lastBody!).toMatchObject({ model: 'test-model', stream: true, max_tokens: 8192 });
  });
  it('rejects truncated responses and errors without exposing provider text', async () => {
    events = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }];
    await expect(collect(streamMessages(request()))).rejects.toMatchObject({
      code: 'provider_stream_broken',
    });
    events = [{ type: 'error', error: { message: 'synthetic-credential secret-prompt' } }];
    await expect(collect(streamMessages(request()))).rejects.toMatchObject({
      code: 'provider_stream_error',
      message: 'The provider reported an error during the answer.',
    });
  });
  it('refuses redirects and never includes raw rejection bodies', async () => {
    status = 302;
    events = [{ error: 'synthetic-credential' }];
    await expect(collect(streamMessages(request()))).rejects.toMatchObject({
      code: 'provider_rejected',
      upstreamStatus: 302,
      message: 'The model provider refused the request.',
    });
    status = 401;
    await expect(collect(streamMessages(request()))).rejects.toMatchObject({
      code: 'provider_auth_failed',
    });
    status = 200;
  });
  it('paginates model discovery without paid inference', async () => {
    modelRequests = [];
    expect(await listAnthropicModels(request())).toEqual(['first', 'second']);
    expect(modelRequests).toEqual([
      '/v1/models?limit=1000',
      '/v1/models?limit=1000&after_id=first',
    ]);
  });
});
