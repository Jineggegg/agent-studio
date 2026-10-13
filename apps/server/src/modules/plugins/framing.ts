/**
 * The wire between the Studio and a plugin process: JSON-RPC 2.0, one message
 * per line. This is the Studio's reading of it; the SDK has its own, and
 * neither side believes the other.
 */

export type FramingProblem = 'oversized' | 'invalid-json' | 'not-an-object';

export interface LineDecoderOptions {
  readonly maxBytes: number;
  onMessage(message: Record<string, unknown>): void;
  onProblem(problem: FramingProblem): void;
}

/**
 * Splits a byte stream into JSON objects. A line longer than `maxBytes` is
 * never held in memory: once the limit is passed the rest of that line is
 * thrown away as it arrives.
 */
export class LineDecoder {
  readonly #options: LineDecoderOptions;
  #parts: Buffer[] = [];
  #size = 0;
  #discarding = false;

  constructor(options: LineDecoderOptions) {
    this.#options = options;
  }

  /** Bytes currently held while waiting for the end of a line. */
  get buffered(): number {
    return this.#size;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf(0x0a);
      if (newline === -1) {
        if (this.#discarding) return;
        if (this.#size + rest.length > this.#options.maxBytes) {
          this.#reset();
          this.#discarding = true;
          this.#options.onProblem('oversized');
          return;
        }
        this.#parts.push(Buffer.from(rest));
        this.#size += rest.length;
        return;
      }
      const head = rest.subarray(0, newline);
      rest = rest.subarray(newline + 1);
      if (this.#discarding) {
        this.#discarding = false;
        continue;
      }
      if (this.#size + head.length > this.#options.maxBytes) {
        this.#reset();
        this.#options.onProblem('oversized');
        continue;
      }
      const line = this.#parts.length === 0 ? head : Buffer.concat([...this.#parts, head]);
      this.#reset();
      this.#emit(line);
    }
  }

  #reset(): void {
    this.#parts = [];
    this.#size = 0;
  }

  #emit(line: Buffer): void {
    const text = line.toString('utf8').trim();
    if (text === '') return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.#options.onProblem('invalid-json');
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.#options.onProblem('not-an-object');
      return;
    }
    this.#options.onMessage(value as Record<string, unknown>);
  }
}

export type RpcId = string | number;

export type RpcMessage =
  | { readonly kind: 'request'; readonly id: RpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'result'; readonly id: RpcId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: RpcId; readonly code: string; readonly message: string }
  | { readonly kind: 'invalid' };

const isId = (value: unknown): value is RpcId =>
  (typeof value === 'string' && value.length > 0 && value.length <= 64) || (typeof value === 'number' && Number.isSafeInteger(value));

/** Sorts a decoded object into what it is under JSON-RPC 2.0. Anything that is none of them is `invalid`. */
export function classify(message: Record<string, unknown>): RpcMessage {
  if (message.jsonrpc !== '2.0') return { kind: 'invalid' };
  if ('method' in message) {
    if (typeof message.method !== 'string' || message.method.length === 0 || message.method.length > 64) return { kind: 'invalid' };
    if (!('id' in message) || message.id === null) return { kind: 'notification', method: message.method, params: message.params };
    if (!isId(message.id)) return { kind: 'invalid' };
    return { kind: 'request', id: message.id, method: message.method, params: message.params };
  }
  if (!isId(message.id)) return { kind: 'invalid' };
  if ('error' in message) {
    const error = message.error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return { kind: 'invalid' };
    const { message: text, data } = error as { message?: unknown; data?: unknown };
    const code = data !== null && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
    return {
      kind: 'error',
      id: message.id,
      code: typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'plugin_error',
      message: typeof text === 'string' ? text.slice(0, 2000) : 'The plugin reported an error.',
    };
  }
  if ('result' in message) return { kind: 'result', id: message.id, result: message.result };
  return { kind: 'invalid' };
}

/** One message as a line of UTF-8 text. */
export function encodeLine(message: unknown): Buffer {
  return Buffer.from(JSON.stringify(message) + '\n', 'utf8');
}
