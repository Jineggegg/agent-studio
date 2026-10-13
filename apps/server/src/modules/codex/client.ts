import type { FastifyBaseLogger } from 'fastify';
import type { ProcessSupervisor } from '../../kernel/process.js';
import { type RpcId, classifyMessage } from './protocol.js';

/**
 * One connection to a `codex app-server` process: line-delimited JSON over its
 * standard input and output.
 *
 * It does the plumbing and nothing else — pairs answers with requests, hands
 * notifications and the server's own requests to the caller, keeps the tail of
 * the error stream for a failure message, and turns the two things that can go
 * wrong underneath (the process ends; a line is not JSON) into rejections of
 * whatever was waiting.
 */

type Child = ReturnType<ProcessSupervisor['spawn']>;

/** The server answered a request with an error. */
export class RpcError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(method: string, code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
  }
}

/** The process wrote something that is not a protocol message. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** The process ended (or could not be started) while something was still expected of it. */
export class ProcessEnded extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the program could not be started at all. */
  readonly spawnCode: string | null;

  constructor(code: number | null, signal: NodeJS.Signals | null, spawnCode: string | null = null) {
    super(spawnCode ? `The process could not be started (${spawnCode}).` : `The process ended (${signal ?? `exit code ${code}`}).`);
    this.name = 'ProcessEnded';
    this.code = code;
    this.signal = signal;
    this.spawnCode = spawnCode;
  }
}

/** No answer arrived in time. */
export class RequestTimeout extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`No answer to ${method} in time.`);
    this.name = 'RequestTimeout';
    this.method = method;
  }
}

/** Thrown by a request handler to answer the server with an error instead of a result. */
export class RpcRefusal extends Error {
  readonly code: number;

  constructor(message: string, code = -32601) {
    super(message);
    this.name = 'RpcRefusal';
    this.code = code;
  }
}

export interface AppServerHandlers {
  notification(method: string, params: unknown): void;
  /** A request from the server. Resolve with the result; throw {@link RpcRefusal} to refuse. */
  request(method: string, params: unknown): Promise<unknown>;
  /** The connection can no longer be used: the process ended, or wrote something unreadable. Called once. */
  failed(error: ProcessEnded | ProtocolError): void;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | null;
}

/** A line longer than this is not a message: nothing the adapter asks for comes close. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export class AppServerClient {
  readonly #child: Child;
  readonly #handlers: AppServerHandlers;
  readonly #log: FastifyBaseLogger;
  readonly #pending = new Map<RpcId, Pending>();
  #nextId = 1;
  #partial: Buffer[] = [];
  #partialBytes = 0;
  #stderr = '';
  #broken: ProcessEnded | ProtocolError | null = null;
  #ended = false;
  /** Resolves when the process has gone, whatever the reason. Never rejects. */
  readonly exited: Promise<void>;

  constructor(child: Child, handlers: AppServerHandlers, log: FastifyBaseLogger) {
    this.#child = child;
    this.#handlers = handlers;
    this.#log = log;

    child.stdout?.on('data', (chunk: Buffer) => this.#onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // A write after the process has gone must not take the server down with it.
    child.stdin?.on('error', () => {});

    this.exited = new Promise<void>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        this.#ended = true;
        this.#fail(new ProcessEnded(null, null, error.code ?? 'spawn_failed'));
        resolve();
      });
      child.once('close', (code, signal) => {
        this.#ended = true;
        this.#fail(new ProcessEnded(code, signal));
        resolve();
      });
    });
  }

  /** What the process wrote to its error stream last (unredacted: pass it through `redactSecrets` before use). */
  get stderrTail(): string {
    return this.#stderr;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Why the connection stopped working, once it has. */
  get broken(): ProcessEnded | ProtocolError | null {
    return this.#broken;
  }

  request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.#broken) return Promise.reject(this.#broken);
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        options.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.#pending.delete(id);
              reject(new RequestTimeout(method));
            }, options.timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  /** Closes the process's input: an app-server takes that as the end of the connection and exits. */
  end(): void {
    try {
      this.#child.stdin?.end();
    } catch {
      /* already closed */
    }
  }

  #send(message: Record<string, unknown>): void {
    if (this.#broken || !this.#child.stdin || this.#child.stdin.destroyed) return;
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* the close handler reports it */
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#broken) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const piece = chunk.subarray(start, newline);
      const line = this.#partial.length > 0 ? Buffer.concat([...this.#partial, piece]) : piece;
      this.#partial = [];
      this.#partialBytes = 0;
      start = newline + 1;
      this.#onLine(line);
      if (this.#broken) return;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.#partial.push(rest);
      this.#partialBytes += rest.length;
      if (this.#partialBytes > MAX_LINE_BYTES) this.#fail(new ProtocolError('Codex sent a line too long to be a message.'));
    }
  }

  #onLine(raw: Buffer): void {
    const line = raw.toString('utf8').trim();
    if (line === '') return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.#fail(new ProtocolError('Codex wrote something that is not a protocol message.'));
      return;
    }
    const message = classifyMessage(decoded);
    if (!message) {
      this.#log.debug({ keys: decoded !== null && typeof decoded === 'object' ? Object.keys(decoded).slice(0, 8) : typeof decoded }, 'codex: a line that is no message, skipped');
      return;
    }
    switch (message.kind) {
      case 'response':
      case 'error': {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.kind === 'response') pending.resolve(message.result);
        else pending.reject(new RpcError(pending.method, message.code, message.message));
        return;
      }
      case 'notification':
        try {
          this.#handlers.notification(message.method, message.params);
        } catch (error) {
          this.#log.debug({ method: message.method, err: error instanceof Error ? error.name : 'error' }, 'codex: a notification could not be handled, skipped');
        }
        return;
      case 'request':
        this.#answer(message.id, message.method, message.params);
        return;
    }
  }

  #answer(id: RpcId, method: string, params: unknown): void {
    let outcome: Promise<unknown>;
    try {
      outcome = this.#handlers.request(method, params);
    } catch (error) {
      outcome = Promise.reject(error instanceof Error ? error : new Error('handler failed'));
    }
    outcome.then(
      (result) => this.#send({ id, result }),
      (error: unknown) => {
        if (error instanceof RpcRefusal) {
          this.#send({ id, error: { code: error.code, message: error.message } });
          return;
        }
        this.#log.warn({ method, err: error instanceof Error ? error.name : 'error' }, 'codex: a request from the CLI could not be answered');
        this.#send({ id, error: { code: -32603, message: 'The client could not answer this request.' } });
      },
    );
  }

  #fail(error: ProcessEnded | ProtocolError): void {
    if (this.#broken) return;
    this.#broken = error;
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    try {
      this.#handlers.failed(error);
    } catch {
      /* the caller's problem; nothing more to do here */
    }
  }
}
