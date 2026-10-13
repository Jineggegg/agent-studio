import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A stand-in for an OpenAI-compatible model server, for tests.
 *
 * It listens on loopback, speaks just enough of the protocol — streamed chat
 * completions, the model listing, DeepSeek's balance call — and does exactly
 * what a test scripts: each chat request takes the next {@link FakeReply}
 * from the queue. It never talks to a real provider and production code
 * never falls back to it.
 *
 *   const model = await FakeOpenAI.start();
 *   model.script({ toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] }, { text: 'Done.' });
 *   …send a message through the Studio…
 *   expect(model.chats[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool' });
 *   await model.close();
 */

export interface FakeUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens: number };
}

export interface FakeToolCall {
  readonly id?: string;
  readonly name: string;
  /** An object is sent as JSON; a string is sent as it is (to script malformed arguments). */
  readonly arguments: unknown;
  /** In how many frames the arguments arrive. Default 3. */
  readonly pieces?: number;
}

export type FakeReply =
  /** A streamed answer. Everything is optional: `{}` is an empty answer that finishes. */
  | {
      readonly text?: string;
      /** In how many frames the text arrives. Default 2. */
      readonly chunks?: number;
      readonly reasoning?: string;
      readonly toolCalls?: readonly FakeToolCall[];
      readonly usage?: FakeUsage;
      /** Default: `tool_calls` when tools are called, else `stop`. */
      readonly finish?: string;
      /** Milliseconds to wait between frames. */
      readonly paceMs?: number;
      /** After the content — `breakOff`: the connection drops without a finish frame. `error`: an error frame. `hang`: nothing more, ever. */
      readonly then?: 'breakOff' | 'error' | 'hang';
      /** The message of the error frame for `then: 'error'`. */
      readonly errorMessage?: string;
      /** Called when the request arrives, before anything is sent. */
      readonly onRequest?: (request: RecordedRequest) => void | Promise<void>;
    }
  /** An HTTP error. `echoKey` puts the key the request carried into the error text, as some providers do. */
  | { readonly status: number; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>>; readonly echoKey?: boolean }
  | { readonly redirect: string; readonly status?: number }
  /** Accepts the request and never answers. */
  | { readonly silent: true };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  /** The bearer token the request carried, if any. */
  readonly key: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
}

const frame = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

function split(text: string, pieces: number): string[] {
  const count = Math.max(1, Math.min(pieces, Math.max(1, text.length)));
  const size = Math.ceil(text.length / count);
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts.length > 0 ? parts : [''];
}

export class FakeOpenAI {
  /** Every request received, oldest first. */
  readonly requests: RecordedRequest[] = [];
  /** What `GET …/models` answers: ids, an HTTP status, or null for "no such endpoint" (404). */
  models: readonly string[] | { readonly status: number } | null = ['fake-model'];
  /** What `GET /user/balance` answers: a body, an HTTP status, or null for 404. */
  balance: unknown = null;
  /** The reply to a chat request when the script is empty. */
  fallback: FakeReply = { text: 'ok' };

  readonly #server: http.Server;
  readonly #sockets = new Set<Socket>();
  readonly #queue: FakeReply[] = [];
  readonly #waiters: Array<{ count: number; resolve: () => void }> = [];
  #openStreams = 0;

  private constructor(server: http.Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeOpenAI> {
    const server = http.createServer();
    const fake = new FakeOpenAI(server);
    server.on('connection', (socket) => {
      fake.#sockets.add(socket);
      socket.on('close', () => fake.#sockets.delete(socket));
    });
    server.on('request', (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void fake.#handle(request, response, Buffer.concat(chunks).toString('utf8')).catch(() => response.destroy());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The base URL to configure a provider with. */
  get url(): string {
    return `${this.origin}/v1`;
  }

  /** Lines up replies for the next chat requests, in order. */
  script(...replies: FakeReply[]): this {
    this.#queue.push(...replies);
    return this;
  }

  /** Forgets recorded requests and anything still scripted. */
  reset(): void {
    this.requests.length = 0;
    this.#queue.length = 0;
    this.fallback = { text: 'ok' };
  }

  /** The chat-completion requests received, oldest first. */
  get chats(): RecordedRequest[] {
    return this.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/chat/completions'));
  }

  get lastChat(): RecordedRequest {
    const chat = this.chats.at(-1);
    if (!chat) throw new Error('The fake model server has not received a chat request.');
    return chat;
  }

  /** Answers still being streamed (or hanging). */
  get openStreams(): number {
    return this.#openStreams;
  }

  /** Resolves once `count` chat requests have arrived. */
  received(count: number, timeoutMs = 5000): Promise<void> {
    if (this.chats.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The fake model server did not receive ${count} chat request(s) in time.`)), timeoutMs);
      this.#waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(request: http.IncomingMessage, response: http.ServerResponse, raw: string): Promise<void> {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const authorization = request.headers.authorization;
    let body: unknown = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path,
      headers: request.headers,
      key: authorization?.startsWith('Bearer ') ? authorization.slice(7) : null,
      body,
    };
    this.requests.push(recorded);
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));
    };

    if (recorded.method === 'GET' && path.endsWith('/models')) {
      if (this.models === null) return json(404, { error: { message: 'Not found' } });
      if (!Array.isArray(this.models)) return json((this.models as { status: number }).status, { error: { message: `models are unavailable for ${recorded.key ?? 'nobody'}` } });
      return json(200, { object: 'list', data: this.models.map((id) => ({ id, object: 'model' })) });
    }
    if (recorded.method === 'GET' && path === '/user/balance') {
      if (this.balance === null) return json(404, { error: { message: 'Not found' } });
      const status = (this.balance as { status?: unknown }).status;
      if (typeof status === 'number') return json(status, { error: { message: 'no balance for you' } });
      return json(200, this.balance);
    }
    if (recorded.method !== 'POST' || !path.endsWith('/chat/completions')) return json(404, { error: { message: 'Not found' } });

    const chatCount = this.chats.length;
    for (const waiter of [...this.#waiters]) {
      if (chatCount < waiter.count) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const reply = this.#queue.shift() ?? this.fallback;

    if ('silent' in reply) {
      this.#openStreams += 1;
      response.on('close', () => (this.#openStreams -= 1));
      return;
    }
    if ('redirect' in reply) {
      response.writeHead(reply.status ?? 302, { location: reply.redirect }).end();
      return;
    }
    if ('status' in reply) {
      const fallbackBody = { error: { message: reply.echoKey ? `Incorrect API key provided: ${recorded.key ?? ''}. You can find your API key in the console.` : `The fake server answers ${reply.status}.`, type: 'fake_error' } };
      return json(reply.status, reply.body ?? fallbackBody, { ...reply.headers });
    }
    await reply.onRequest?.(recorded);

    // The connection check, not a chat: one token, not streamed.
    if ((body as { stream?: unknown } | null)?.stream === false) {
      return json(200, { id: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }

    this.#openStreams += 1;
    let closed = false;
    response.on('close', () => {
      closed = true;
      this.#openStreams -= 1;
    });
    const send = async (payload: unknown): Promise<void> => {
      if (closed) return;
      response.write(frame(payload));
      if (reply.paceMs) await new Promise((resolve) => setTimeout(resolve, reply.paceMs));
    };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    await send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    if (reply.reasoning) {
      for (const piece of split(reply.reasoning, 2)) await send({ choices: [{ index: 0, delta: { reasoning_content: piece } }] });
    }
    if (reply.text) {
      for (const piece of split(reply.text, reply.chunks ?? 2)) await send({ choices: [{ index: 0, delta: { content: piece } }] });
    }
    const calls = reply.toolCalls ?? [];
    for (const [index, call] of calls.entries()) {
      const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
      await send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id ?? `call_${this.chats.length}_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] } }] });
      for (const piece of split(args, call.pieces ?? 3)) await send({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] });
    }
    if (reply.then === 'hang') return;
    if (reply.then === 'breakOff') {
      // Give what was written time to leave before the connection is cut.
      await new Promise((resolve) => setTimeout(resolve, 30));
      response.destroy();
      return;
    }
    if (reply.then === 'error') {
      await send({ error: { message: reply.errorMessage ?? 'upstream overloaded', type: 'server_error' } });
      response.end();
      return;
    }
    await send({ choices: [{ index: 0, delta: {}, finish_reason: reply.finish ?? (calls.length > 0 ? 'tool_calls' : 'stop') }] });
    if (reply.usage) await send({ choices: [], usage: reply.usage });
    if (!closed) response.end(frame('[DONE]'));
  }
}
