import type { Readable, Writable } from 'node:stream';
import { unavailable } from '../../kernel/errors.js';
interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: unknown;
}
/** Bounded, null-delimited CDP transport. It never listens on a TCP socket. */
export class CdpPipe {
  #next = 1;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #pending = new Map<
    number,
    {
      method: string;
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #input: Writable;
  onEvent: ((method: string, params: Record<string, unknown>, sessionId?: string) => void) | null =
    null;
  constructor(input: Writable, output: Readable) {
    this.#input = input;
    output.on('data', (chunk: Buffer) => this.#data(chunk));
    output.on('error', () => this.close());
    output.on('end', () => this.close());
    input.on('error', () => this.close());
  }
  #data(chunk: Buffer) {
    if (this.#buffer.length + chunk.length > 12 * 1024 * 1024) {
      this.close();
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let end: number;
    while ((end = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + 1);
      let message: CdpMessage;
      try {
        message = JSON.parse(raw.toString('utf8')) as CdpMessage;
      } catch {
        this.close();
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            unavailable(`Browser command failed: ${pending.method}.`, 'browser_command_failed'),
          );
        else pending.resolve(message.result ?? {});
      } else if (message.method)
        this.onEvent?.(message.method, message.params ?? {}, message.sessionId);
    }
  }
  call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#closed || this.#pending.size > 256)
      return Promise.reject(
        unavailable('Browser connection is unavailable.', 'browser_unavailable'),
      );
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(unavailable('Browser command timed out.', 'browser_timeout'));
      }, 25_000);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      item.reject(unavailable('Browser closed.', 'browser_closed'));
    }
    this.#pending.clear();
    this.#input.destroy();
  }
}
