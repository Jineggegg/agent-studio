import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  type TerminalAttachedFrame,
  type TerminalServerFrame,
  terminalServerFrameSchema,
  terminalSocketPath,
} from '@agent-studio/protocol';
import WebSocket from 'ws';
import type { StudioModule } from '../../../kernel/module.js';
import type { TestClient } from '../../../testing/harness.js';
import { modules as allModules } from '../../index.js';

/**
 * Test support for the terminal: a WebSocket client that speaks the terminal
 * protocol, and a few helpers. Never imported by production code.
 */

/** The server's module list with some modules swapped for specially configured ones. */
export function modulesWith(...replacements: StudioModule[]): StudioModule[] {
  const byName = new Map(replacements.map((module) => [module.name, module]));
  return allModules.map((module) => byName.get(module.name) ?? module);
}

type FrameOf<T extends TerminalServerFrame['type']> = Extract<TerminalServerFrame, { type: T }>;

export interface TerminalConnection {
  readonly socket: WebSocket;
  /** Every control frame received, in order. */
  readonly frames: TerminalServerFrame[];
  /** Every output byte received, in order. */
  bytes(): Buffer;
  text(): string;
  /** The sequence number this client has reached, kept the way the protocol tells clients to. */
  readonly seq: number;
  sendFrame(frame: unknown): void;
  /** Sends keyboard input. */
  type(data: string | Buffer): void;
  /** The next frame of a type, counting frames that already arrived. Each frame is returned once. */
  next<T extends TerminalServerFrame['type']>(type: T, timeoutMs?: number): Promise<FrameOf<T>>;
  /** Waits for output that appears after everything previously matched. */
  expectOutput(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Makes `expectOutput` ignore everything received so far (a replay, say). Returns that position in `text()`. */
  mark(): number;
  readonly closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly wsUrl: string;
  readonly origin: string;
  readonly client: TestClient | null;
  readonly sessionId: string;
  readonly headers?: Record<string, string>;
  /** Set to false to play a client that never answers the server's pings. */
  readonly autoPong?: boolean;
}

/** Opens the socket of a terminal session. Rejects with `HTTP <status>` when the handshake is refused. */
export function connectTerminal(options: ConnectOptions): Promise<TerminalConnection> {
  return new Promise((resolve, reject) => {
    const { client } = options;
    const socket = new WebSocket(`${options.wsUrl}${terminalSocketPath(options.sessionId)}`, {
      headers: {
        origin: options.origin,
        ...(client?.cookie ? { cookie: client.cookie } : {}),
        ...(client?.bearer ? { authorization: `Bearer ${client.bearer}` } : {}),
        ...options.headers,
      },
      autoPong: options.autoPong ?? true,
    });
    const frames: TerminalServerFrame[] = [];
    const chunks: Buffer[] = [];
    // Decoded as it arrives, so that looking at the text does not get slower as output piles up.
    const decoder = new StringDecoder('utf8');
    let text = '';
    const taken = new Set<TerminalServerFrame>();
    let seq = 0;
    let searchFrom = 0;
    let wake: Array<() => void> = [];
    const notify = () => {
      const waiting = wake;
      wake = [];
      for (const resume of waiting) resume();
    };

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        chunks.push(chunk);
        text += decoder.write(chunk);
        seq += chunk.length;
      } else {
        // Every frame the server sends must be one the protocol package describes.
        const frame = terminalServerFrameSchema.parse(JSON.parse(String(raw)));
        if (frame.type === 'attached') seq = frame.replay.from;
        frames.push(frame);
      }
      notify();
    });
    let ended = false;
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      socket.on('close', (code, reason) => {
        ended = true;
        done({ code, reason: reason.toString('utf8') });
        notify();
      });
    });

    const until = async <R>(what: string, timeoutMs: number, probe: () => R | undefined): Promise<R> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = probe();
        if (found !== undefined) return found;
        const left = deadline - Date.now();
        if (left <= 0 || ended) {
          throw new Error(`${ended ? 'the socket closed' : 'timed out'} waiting for ${what}; output so far: ${JSON.stringify(text.slice(-600))}`);
        }
        await new Promise<void>((resume) => {
          const timer = setTimeout(resume, Math.min(left, 250));
          wake.push(() => {
            clearTimeout(timer);
            resume();
          });
        });
      }
    };

    const connection: TerminalConnection = {
      socket,
      frames,
      closed,
      bytes: () => Buffer.concat(chunks),
      text: () => text,
      get seq() {
        return seq;
      },
      sendFrame: (frame) => socket.send(JSON.stringify(frame)),
      type: (data) => socket.send(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { binary: true }),
      next: (type, timeoutMs = 5000) =>
        until(`a "${type}" frame`, timeoutMs, () => {
          const frame = frames.find((candidate) => candidate.type === type && !taken.has(candidate));
          if (frame) taken.add(frame);
          return frame as FrameOf<typeof type> | undefined;
        }),
      expectOutput: (pattern, timeoutMs = 5000) =>
        until(`output matching ${String(pattern)}`, timeoutMs, () => {
          if (typeof pattern === 'string') {
            const index = text.indexOf(pattern, searchFrom);
            if (index === -1) return undefined;
            searchFrom = index + pattern.length;
            return pattern;
          }
          const match = pattern.exec(text.slice(searchFrom));
          if (!match) return undefined;
          searchFrom += match.index + match[0].length;
          return match[0];
        }),
      mark: () => (searchFrom = text.length),
      close: async () => {
        if (socket.readyState === socket.CLOSED) return;
        socket.close();
        await closed;
      },
    };

    socket.once('open', () => resolve(connection));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`HTTP ${response.statusCode}`));
    });
    // Kept for the life of the socket: a connection the server cuts may report an error after it opened.
    socket.on('error', (error) => reject(error));
  });
}

export interface AttachOptions extends ConnectOptions {
  readonly after?: number | null;
  readonly cols?: number;
  readonly rows?: number;
}

export type AttachedTerminal = TerminalConnection & { readonly attached: TerminalAttachedFrame };

/** Connects, sends the attach frame and waits until the replay is complete. */
export async function attachTerminal(options: AttachOptions): Promise<AttachedTerminal> {
  const connection = await connectTerminal(options);
  connection.sendFrame({
    type: 'attach',
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    ...(options.after === undefined ? {} : { after: options.after }),
  });
  const attached = await connection.next('attached');
  await connection.next('live');
  return Object.assign(connection, { attached });
}

/** Whether a process is still running (a zombie that only awaits collection does not count). */
export function processIsRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5000, what = 'the condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
