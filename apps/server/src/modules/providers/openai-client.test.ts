import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError, completionsUrl, getJson, listModels, probeCompletion, siblingUrl, sseData, streamChat, type ChatDelta } from './openai-client.js';

const local = { allowHttp: true, allowPrivateNetwork: true } as const;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('sseData', () => {
  it('reassembles events split at arbitrary byte boundaries, including inside multi-byte characters', async () => {
    const text = 'data: {"a":"你好"}\n\n: keep-alive\n\ndata: first line\ndata: second line\r\n\r\nevent: ignored\ndata: last';
    const bytes = Buffer.from(text, 'utf8');
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
      expect(await collect(sseData(Readable.from(chunks))), `chunk size ${size}`).toEqual(['{"a":"你好"}', 'first line\nsecond line', 'last']);
    }
  });

  it('refuses an event that never ends', async () => {
    const endless = Readable.from([Buffer.alloc(2000, 'x')]);
    await expect(collect(sseData(endless, 1000))).rejects.toMatchObject({ code: 'provider_protocol_error' });
  });
});

describe('streamChat', () => {
  let server: http.Server;
  let base: string;
  let lastRequest: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> } | null = null;
  let respond: (response: http.ServerResponse) => void = () => {};

  const sse = (events: unknown[]) => (response: http.ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
    response.end();
  };

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        lastRequest = { headers: request.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        if (request.url === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 42 }] }));
          return;
        }
        respond(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => {
    server.close();
  });

  const chat = (overrides: Partial<Parameters<typeof streamChat>[0]> = {}) =>
    streamChat({ baseUrl: base, apiKey: 'sk-test-key-0123456789abcdef', model: 'model-a', messages: [{ role: 'user', content: 'hi' }], policy: local, ...overrides });

  it('streams text, reasoning, usage and the finish reason, and sends a well-formed request', async () => {
    respond = sse([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } } },
      '[DONE]',
    ]);
    const deltas = await collect(chat({ temperature: 0.2 }));
    expect(deltas).toEqual<ChatDelta[]>([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 8, reasoningTokens: 2 } },
    ]);
    expect(lastRequest!.headers.authorization).toBe('Bearer sk-test-key-0123456789abcdef');
    expect(lastRequest!.body).toMatchObject({ model: 'model-a', stream: true, stream_options: { include_usage: true }, temperature: 0.2 });
    expect(lastRequest!.body).not.toHaveProperty('tools');
  });

  it('streams tool calls piece by piece and declares the tools', async () => {
    respond = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]);
    const deltas = await collect(chat({ tools: [{ name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }));
    expect(deltas.filter((delta) => delta.type === 'tool-call')).toEqual([
      { type: 'tool-call', index: 0, id: 'call_1', name: 'read_file' },
      { type: 'tool-call', index: 0, argumentsDelta: '{"path":' },
      { type: 'tool-call', index: 0, argumentsDelta: '"a.txt"}' },
    ]);
    expect(deltas.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
    expect(lastRequest!.body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ]);
  });

  it.each([
    [401, 'provider_auth_failed'],
    [402, 'provider_no_credit'],
    [404, 'provider_model_not_found'],
    [429, 'provider_rate_limited'],
    [500, 'provider_unavailable'],
    [400, 'provider_rejected'],
  ])('maps HTTP %i to %s without leaking the key', async (status, code) => {
    respond = (response) => {
      response
        .writeHead(status, { 'content-type': 'application/json', 'retry-after': '7' })
        .end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-test-key-0123456789abcdef. Check your key.' } }));
    };
    const error = await collect(chat()).then(
      () => null,
      (thrown: Error & { code: string; retryAfterSeconds?: number }) => thrown,
    );
    expect(error).toMatchObject({ code });
    expect(error!.message).not.toContain('sk-test-key-0123456789abcdef');
    if (status === 429) expect(error!.retryAfterSeconds).toBe(7);
  });

  it('reports an answer that stops without finishing', async () => {
    respond = sse([{ choices: [{ delta: { content: 'half an ans' } }] }]);
    await expect(collect(chat())).rejects.toMatchObject({ code: 'provider_stream_broken' });
  });

  it('reports an error the provider sends mid-stream', async () => {
    respond = sse([{ choices: [{ delta: { content: 'so far so' } }] }, { error: { message: 'upstream overloaded' } }]);
    await expect(collect(chat())).rejects.toMatchObject({ code: 'provider_stream_error' });
  });

  it('stops promptly when aborted', async () => {
    respond = (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'one' } }] })}\n\n`);
      // …and then never finishes.
    };
    const controller = new AbortController();
    const seen: ChatDelta[] = [];
    const run = (async () => {
      for await (const delta of chat({ signal: controller.signal })) {
        seen.push(delta);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([{ type: 'text', text: 'one' }]);
  });

  it('refuses a local endpoint unless the owner allowed the private network', async () => {
    respond = sse(['[DONE]']);
    await expect(collect(chat({ policy: {} }))).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(collect(chat({ baseUrl: 'https://127.0.0.1:1/v1', policy: {} }))).rejects.toMatchObject({ code: 'address_not_allowed' });
    await expect(collect(chat({ baseUrl: 'https://169.254.169.254/v1', policy: local }))).rejects.toMatchObject({ code: 'address_not_allowed' });
  });

  it('can keep tools declared while telling the model to answer in words', async () => {
    respond = sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }, '[DONE]']);
    const tools = [{ name: 'read_file', description: 'Reads a file.', parameters: { type: 'object' } }];
    await collect(chat({ tools, toolChoice: 'none' }));
    expect(lastRequest!.body).toMatchObject({ tool_choice: 'none', tools: [{ type: 'function', function: { name: 'read_file' } }] });
    await collect(chat({ tools }));
    expect(lastRequest!.body.tool_choice).toBe('auto');
    // Without tools there is no choice to state.
    await collect(chat({ toolChoice: 'none' }));
    expect(lastRequest!.body).not.toHaveProperty('tool_choice');
  });

  it('passes reasoning back with an assistant message that called tools', async () => {
    respond = sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);
    await collect(
      chat({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }], reasoning_content: 'thinking it through' },
          { role: 'tool', tool_call_id: 'c1', content: 'file text' },
        ],
      }),
    );
    expect((lastRequest!.body.messages as Array<Record<string, unknown>>)[1]).toMatchObject({ role: 'assistant', reasoning_content: 'thinking it through' });
  });

  it('remembers the status the provider answered with', async () => {
    for (const status of [401, 402, 404, 429, 500, 400, 302]) {
      respond = (response) => {
        response.writeHead(status, { 'content-type': 'application/json' }).end('{}');
      };
      const error = await collect(chat()).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).upstreamStatus).toBe(status);
    }
  });

  it('keeps the key out of an error the provider sends mid-stream', async () => {
    // A key in no well-known shape: only knowing it lets it be removed.
    const apiKey = 'local-key-without-a-known-shape';
    respond = sse([{ choices: [{ delta: { content: 'so far' } }] }, { error: { message: `quota exceeded for ${apiKey}` } }]);
    const error = (await collect(chat({ apiKey })).then(
      () => null,
      (thrown: Error) => thrown,
    ))!;
    expect(error).toMatchObject({ code: 'provider_stream_error' });
    expect(error.message).not.toContain(apiKey);
    expect(error.message).toContain('[redacted]');
  });

  it('checks a key with one token, not streamed, when asked to', async () => {
    respond = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'p' } }] }));
    };
    await expect(probeCompletion({ baseUrl: base, apiKey: 'sk-test-key-0123456789abcdef', model: 'model-a', policy: local })).resolves.toBeUndefined();
    expect(lastRequest!.body).toEqual({ model: 'model-a', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
    expect(lastRequest!.headers.authorization).toBe('Bearer sk-test-key-0123456789abcdef');
    respond = (response) => {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key sk-test-key-0123456789abcdef' } }));
    };
    const refused = await probeCompletion({ baseUrl: base, apiKey: 'sk-test-key-0123456789abcdef', model: 'model-a', policy: local }).then(
      () => null,
      (thrown: Error) => thrown,
    );
    expect(refused).toMatchObject({ code: 'provider_auth_failed', upstreamStatus: 401 });
    expect(refused!.message).not.toContain('sk-test-key-0123456789abcdef');
    await expect(probeCompletion({ baseUrl: base, apiKey: null, model: 'model-a', policy: {} })).rejects.toMatchObject({ code: 'insecure_url' });
  });

  it('reads JSON from a neighbouring endpoint and says so when it is not JSON', async () => {
    expect(siblingUrl('https://host/v1/', '/models')).toBe('https://host/v1/models');
    expect(siblingUrl('https://host/v1/chat/completions', '/models')).toBe('https://host/v1/models');
    respond = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hello: 'world' }));
    };
    expect(await getJson(`${base}/anything`, 'k', { policy: local })).toEqual({ hello: 'world' });
    expect(lastRequest!.headers.authorization).toBe('Bearer k');
    respond = (response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html>not a model server</html>');
    };
    await expect(getJson(`${base}/anything`, null, { policy: local })).rejects.toMatchObject({ code: 'provider_protocol_error' });
    // No more is buffered than the caller allowed.
    await expect(getJson(`${base}/anything`, null, { policy: local, maxBytes: 5 })).rejects.toMatchObject({ code: 'too_large' });
    await expect(getJson(`${base}/anything`, null, { policy: {} })).rejects.toMatchObject({ code: 'insecure_url' });
  });

  it('lists models and builds endpoint addresses', async () => {
    expect(await listModels(base, 'k', local)).toEqual(['model-a', 'model-b']);
    expect(completionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
    expect(completionsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(completionsUrl('https://host/v1/chat/completions')).toBe('https://host/v1/chat/completions');
  });
});
