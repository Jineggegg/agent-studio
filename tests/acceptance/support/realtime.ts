import WebSocket from 'ws';
import type { ApiClient, RunningStudio } from './studio.js';

/**
 * A realtime client for the acceptance tests: one WebSocket at /api/realtime,
 * authenticated like a browser tab (session cookie + Origin). Every frame the
 * server sends is kept, in arrival order, so a test can wait for a specific
 * frame and afterwards assert on the whole sequence.
 *
 * Nothing here knows the server's types: a frame is a bag of JSON.
 */

export interface Frame {
  readonly op: string;
  readonly topic?: string;
  readonly type?: string;
  readonly seq?: number;
  readonly code?: string;
  readonly replayed?: number;
  readonly head?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- black-box JSON
  readonly data?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- black-box JSON
  readonly snapshot?: any;
}

export interface WaitOptions {
  /** Milliseconds before the wait fails. */
  readonly timeout?: number;
  /** Only frames at or after this position (see {@link Realtime.mark}) are considered. */
  readonly from?: number;
  /** What is being waited for, for the failure message. */
  readonly what?: string;
}

const DEFAULT_TIMEOUT = 20_000;

export class Realtime {
  readonly frames: Frame[] = [];
  readonly socket: WebSocket;
  /** Resolves with the close code once the connection has ended. */
  readonly closed: Promise<number>;
  #waiters = new Set<() => void>();
  #closeCode: number | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      this.frames.push(JSON.parse(String(raw)) as Frame);
      this.#wake();
    });
    this.closed = new Promise<number>((resolve) =>
      socket.once('close', (code) => {
        this.#closeCode = code;
        this.#wake();
        resolve(code);
      }),
    );
    // A socket the server closes must not crash the test process.
    socket.on('error', () => {});
  }

  /** Opens a connection as the given signed-in browser and waits for the server's `ready`. */
  static async open(studio: RunningStudio, client: ApiClient): Promise<Realtime> {
    const headers: Record<string, string> = { origin: studio.url };
    if (client.cookie) headers.cookie = client.cookie;
    if (client.bearer) headers.authorization = `Bearer ${client.bearer}`;
    const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, { headers });
    const realtime = new Realtime(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`The realtime handshake was refused with HTTP ${response.statusCode}.`)),
      );
      socket.once('error', reject);
    });
    await realtime.waitFor((frame) => frame.op === 'ready', { what: 'the ready frame' });
    return realtime;
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  /** The position after the newest frame: pass it as `from` to ignore everything received so far. */
  mark(): number {
    return this.frames.length;
  }

  get closeCode(): number | null {
    return this.#closeCode;
  }

  sendFrame(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Waits for the first frame (from `from`) that satisfies the predicate. */
  async waitFor(predicate: (frame: Frame) => boolean, options: WaitOptions = {}): Promise<Frame> {
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
    let scanned = options.from ?? 0;
    for (;;) {
      for (; scanned < this.frames.length; scanned += 1) {
        const frame = this.frames[scanned]!;
        if (predicate(frame)) return frame;
      }
      const left = deadline - Date.now();
      if (left <= 0 || this.#closeCode !== null) {
        const tail = this.frames
          .slice(-12)
          .map(
            (frame) =>
              `${frame.op}${frame.type ? ` ${frame.type}` : ''}${frame.seq ? `#${frame.seq}` : ''}`,
          )
          .join(', ');
        throw new Error(
          `${this.#closeCode !== null ? `The connection closed (${this.#closeCode})` : 'Timed out'} waiting for ${options.what ?? 'a frame'}. Last frames: ${tail || 'none'}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        const waiters = this.#waiters;
        function done(): void {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        }
        waiters.add(done);
      });
    }
  }

  /** Subscribes and returns the server's answer for that topic: `subscribed` or `rejected`. */
  async subscribe(topic: string, after?: number): Promise<Frame> {
    const from = this.mark();
    this.sendFrame(
      after === undefined ? { op: 'subscribe', topic } : { op: 'subscribe', topic, after },
    );
    return this.waitFor(
      (frame) => (frame.op === 'subscribed' || frame.op === 'rejected') && frame.topic === topic,
      {
        from,
        what: `the answer to subscribing to ${topic}`,
      },
    );
  }

  /** Waits for an event of the given type on a topic. */
  event(
    topic: string,
    type: string,
    options: WaitOptions & { where?: (frame: Frame) => boolean } = {},
  ): Promise<Frame> {
    return this.waitFor(
      (frame) =>
        frame.op === 'event' &&
        frame.topic === topic &&
        frame.type === type &&
        (options.where?.(frame) ?? true),
      { what: `${type} on ${topic}`, ...options },
    );
  }

  /** Every event frame received so far on a topic, in arrival order. */
  events(topic: string, from = 0): Frame[] {
    return this.frames.slice(from).filter((frame) => frame.op === 'event' && frame.topic === topic);
  }

  /** The numbered (durable) events received so far on a topic. */
  durable(topic: string, from = 0): Frame[] {
    return this.events(topic, from).filter((frame) => typeof frame.seq === 'number');
  }

  async close(): Promise<void> {
    if (this.#closeCode !== null) return;
    this.socket.close();
    await this.closed;
  }
}

/** Polls `probe` until it returns something other than `undefined`/`null`/`false`, or fails at the deadline. */
export async function until<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  options: { timeout?: number; interval?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${options.what ?? 'a condition'}${last instanceof Error ? `: ${last.message}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.interval ?? 50));
  }
}

/** Fails if `promise` has not settled in time. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
