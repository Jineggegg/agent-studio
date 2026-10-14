import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in OpenAI-compatible model server for the black-box tests, on
 * loopback. A test scripts what the "model" answers next — streamed text, a
 * tool call whose arguments arrive in pieces, an error status with a body, an
 * answer that never comes — and afterwards reads exactly what the Studio sent
 * it (headers, messages, declared tools). It contacts nothing.
 *
 * Answers are taken from a queue, one per request to `/chat/completions`;
 * with the queue empty it answers with one short sentence.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- black-box JSON
type Json = any;

export interface ModelRequest {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: Json;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

type Scripted =
  | { kind: 'text'; pieces: string[]; usage: Usage; delayMs: number; finishReason: string }
  | {
      kind: 'tool';
      calls: Array<{ id: string; name: string; argumentPieces: string[] }>;
      usage: Usage;
      text: string;
    }
  | { kind: 'error'; status: number; body: string }
  | { kind: 'hang'; firstPiece: string };

const usageOf = (prompt = 100, completion = 20): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});

export class FakeModel {
  readonly requests: ModelRequest[] = [];
  #queue: Scripted[] = [];
  #server: Server;
  #open = new Set<ServerResponse>();
  #callCounter = 0;
  /** Model ids that `GET /models` lists. */
  models = ['standin-chat', 'standin-tools'];

  private constructor() {
    this.#server = createServer((request, response) => void this.#handle(request, response));
  }

  static async start(): Promise<FakeModel> {
    const model = new FakeModel();
    await new Promise<void>((resolve) => model.#server.listen(0, '127.0.0.1', () => resolve()));
    return model;
  }

  /** What to configure as the provider's base URL. */
  get baseUrl(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1`;
  }

  /** The requests to the chat endpoint so far. */
  get chats(): ModelRequest[] {
    return this.requests.filter((request) => request.path.endsWith('/chat/completions'));
  }

  /** Next answer: this text, streamed in pieces. */
  say(
    text: string,
    options: {
      pieces?: string[];
      usage?: [prompt: number, completion: number];
      delayMs?: number;
      finishReason?: string;
    } = {},
  ): this {
    const pieces = options.pieces ?? text.match(/\S+\s*/g) ?? [text];
    this.#queue.push({
      kind: 'text',
      pieces,
      usage: usageOf(...(options.usage ?? [100, 20])),
      delayMs: options.delayMs ?? 0,
      finishReason: options.finishReason ?? 'stop',
    });
    return this;
  }

  /** Next answer: a request to call one tool; its JSON arguments are streamed split across several chunks. */
  callTool(
    name: string,
    input: Record<string, unknown>,
    options: { usage?: [number, number]; text?: string } = {},
  ): this {
    return this.callTools([[name, input]], options);
  }

  /** Next answer: several tool calls in one reply. */
  callTools(
    calls: Array<[name: string, input: Record<string, unknown>]>,
    options: { usage?: [number, number]; text?: string } = {},
  ): this {
    this.#queue.push({
      kind: 'tool',
      text: options.text ?? '',
      usage: usageOf(...(options.usage ?? [120, 30])),
      calls: calls.map(([name, input]) => {
        const json = JSON.stringify(input);
        const third = Math.max(1, Math.ceil(json.length / 3));
        return {
          id: `call_standin_${(this.#callCounter += 1)}`,
          name,
          argumentPieces: [
            json.slice(0, third),
            json.slice(third, 2 * third),
            json.slice(2 * third),
          ].filter((piece) => piece !== ''),
        };
      }),
    });
    return this;
  }

  /** Next answer: an HTTP error with this body. */
  fail(status: number, body: string): this {
    this.#queue.push({ kind: 'error', status, body });
    return this;
  }

  /** Next answer: one piece of text, then silence until the client gives up or the test stops the run. */
  hang(firstPiece = 'thinking it over '): this {
    this.#queue.push({ kind: 'hang', firstPiece });
    return this;
  }

  async stop(): Promise<void> {
    for (const response of this.#open) response.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: Json;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    const path = (request.url ?? '').split('?')[0]!;
    this.requests.push({ path, authorization: request.headers.authorization ?? null, body });

    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          object: 'list',
          data: this.models.map((id) => ({ id, object: 'model' })),
        }),
      );
      return;
    }
    if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
      response
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'no such route on the stand-in' } }));
      return;
    }
    const scripted: Scripted = this.#queue.shift() ?? {
      kind: 'text',
      pieces: ['A short answer from the stand-in model.'],
      usage: usageOf(),
      delayMs: 0,
      finishReason: 'stop',
    };
    if (scripted.kind === 'error') {
      response
        .writeHead(scripted.status, { 'content-type': 'application/json' })
        .end(scripted.body);
      return;
    }
    const model = typeof body?.model === 'string' ? body.model : 'standin-chat';
    if (body?.stream !== true) {
      // A plain (non-streamed) completion, for probes.
      const message =
        scripted.kind === 'text'
          ? { role: 'assistant', content: scripted.pieces.join('') }
          : { role: 'assistant', content: 'ok' };
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'cmpl_standin',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: usageOf(),
        }),
      );
      return;
    }

    this.#open.add(response);
    response.on('close', () => this.#open.delete(response));
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (payload: Json) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunk = (delta: Json, finishReason: string | null = null, usage?: Usage) => ({
      id: 'cmpl_standin',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
    send(chunk({ role: 'assistant', content: '' }));
    if (scripted.kind === 'hang') {
      send(chunk({ content: scripted.firstPiece }));
      return; // and nothing more: the connection stays open
    }
    if (scripted.kind === 'text') {
      for (const piece of scripted.pieces) {
        if (scripted.delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
        if (response.destroyed) return;
        send(chunk({ content: piece }));
      }
      send(chunk({}, scripted.finishReason));
    } else {
      if (scripted.text !== '') send(chunk({ content: scripted.text }));
      for (const [index, call] of scripted.calls.entries()) {
        send(
          chunk({
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: '' },
              },
            ],
          }),
        );
        for (const piece of call.argumentPieces)
          send(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
      }
      send(chunk({}, 'tool_calls'));
    }
    // Usage arrives in a last chunk of its own, as with `stream_options.include_usage`.
    send({
      id: 'cmpl_standin',
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: scripted.usage,
    });
    response.write('data: [DONE]\n\n');
    response.end();
  }
}
