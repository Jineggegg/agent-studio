import WebSocket from 'ws';
import type { ApiClient, RunningStudio } from './studio.js';

/**
 * A terminal client for the acceptance tests: it attaches to a terminal
 * session's WebSocket the way a browser tab would (cookie + Origin), keeps
 * every byte the shell prints and every control frame the server sends, and
 * counts output bytes so that it can re-attach from where it stopped.
 *
 * Binary frames are terminal bytes; text frames are small JSON messages.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- black-box JSON
type Control = any;

export class TerminalClient {
  /** Everything the shell has printed to this client, decoded leniently for matching. */
  output = '';
  /** Output bytes received on this connection. */
  received = 0;
  /** The sequence number reached: `replay.from` plus every byte since. */
  seq = 0;
  readonly controls: Control[] = [];
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  #closeCode: number | null = null;
  #waiters = new Set<() => void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        const bytes = raw as Buffer;
        this.output += bytes.toString('utf8');
        this.received += bytes.length;
        this.seq += bytes.length;
      } else {
        const frame = JSON.parse(String(raw)) as Control;
        if (frame.type === 'attached') this.seq = frame.replay.from;
        this.controls.push(frame);
      }
      this.#wake();
    });
    this.closed = new Promise<number>((resolve) =>
      socket.once('close', (code) => {
        this.#closeCode = code;
        this.#wake();
        resolve(code);
      }),
    );
    socket.on('error', () => {});
  }

  #wake(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  /**
   * Opens the socket and sends the attach frame. Resolves once the server has
   * answered `attached` and finished the replay (`live`), or rejects with the
   * way the attempt ended: `HTTP 401`, `closed 4404`, …
   */
  static async attach(
    studio: RunningStudio,
    client: ApiClient,
    sessionId: string,
    options: {
      cols?: number;
      rows?: number;
      after?: number;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<TerminalClient> {
    const headers: Record<string, string> = {
      origin: options.origin ?? studio.url,
      ...(options.headers ?? {}),
    };
    if (client.cookie) headers.cookie = client.cookie;
    if (client.bearer) headers.authorization = `Bearer ${client.bearer}`;
    const socket = new WebSocket(`${studio.wsUrl}/api/terminal/sessions/${sessionId}/socket`, {
      headers,
    });
    const terminal = new TerminalClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`HTTP ${response.statusCode}`)),
      );
      socket.once('error', (error) => reject(error));
    });
    socket.send(
      JSON.stringify({
        type: 'attach',
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        ...(options.after === undefined ? {} : { after: options.after }),
      }),
    );
    await terminal.until(
      () => terminal.controls.some((frame) => frame.type === 'live') || terminal.closeCode !== null,
      'the terminal to go live',
    );
    if (terminal.closeCode !== null) throw new Error(`closed ${terminal.closeCode}`);
    return terminal;
  }

  get closeCode(): number | null {
    return this.#closeCode;
  }

  /** The `attached` frame: the session and what was replayed. */
  get attached(): Control {
    return this.controls.find((frame) => frame.type === 'attached');
  }

  control(type: string): Control | undefined {
    return this.controls.find((frame) => frame.type === type);
  }

  /** Waits until `condition` holds, the socket closes, or the deadline passes. */
  async until(condition: () => boolean, what: string, timeout = 15_000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (condition()) return;
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(
          `Timed out waiting for ${what}. Terminal output so far:\n${this.output.slice(-600)}`,
        );
      if (this.#closeCode !== null) {
        if (condition()) return;
        throw new Error(
          `The terminal socket closed (${this.#closeCode}) while waiting for ${what}.`,
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

  /** Waits for text to appear in the output (from position `from`), and returns the output from there. */
  async expectOutput(
    text: string | RegExp,
    options: { from?: number; timeout?: number } = {},
  ): Promise<string> {
    const from = options.from ?? 0;
    const found = () =>
      typeof text === 'string'
        ? this.output.slice(from).includes(text)
        : text.test(this.output.slice(from));
    await this.until(found, `the terminal to print ${String(text)}`, options.timeout);
    return this.output.slice(from);
  }

  /** Keyboard input, as bytes. */
  type(text: string): void {
    this.socket.send(Buffer.from(text, 'utf8'), { binary: true });
  }

  /** Types a command and presses Enter. */
  run(command: string): void {
    this.type(`${command}\r`);
  }

  sendControl(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    if (this.#closeCode !== null) return;
    this.socket.close();
    await this.closed;
  }
}

/** How an attempt to open a terminal socket ended, without attaching: `open`, `HTTP 401`, `HTTP 403`, … */
export function terminalHandshake(
  studio: RunningStudio,
  sessionId: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${studio.wsUrl}/api/terminal/sessions/${sessionId}/socket`, {
      headers,
    });
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
    socket.once('unexpected-response', (_request, response) =>
      resolve(`HTTP ${response.statusCode}`),
    );
    socket.once('error', () => resolve('error'));
  });
}
