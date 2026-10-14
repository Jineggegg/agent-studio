import {
  TERMINAL_CLOSE_CODES,
  type TerminalAttachFrame,
  type TerminalErrorCode,
  type TerminalExitFrame,
  type TerminalLocalUrl,
  type TerminalReplay,
  type TerminalSession,
  terminalServerFrameSchema,
  terminalSocketPath,
} from '@agent-studio/protocol';

/**
 * The client side of the terminal protocol (see `packages/protocol/src/terminal.ts`),
 * with nothing of the browser in it: the socket, the clock and the dice are
 * handed in, so every rule below can be run against a fake socket.
 *
 *  - Binary frames are terminal bytes and nothing else. They are passed on as
 *    bytes, never decoded here — a character may be split across two frames.
 *  - The client keeps one number, the output offset it has reached: set from
 *    the replay marker on `attached`, advanced by the length of every binary
 *    frame, and sent back as `after` on the next attach so that only what was
 *    missed is replayed.
 *  - A `full` replay means the server could not continue from that offset:
 *    the widget is cleared first.
 *  - Why a socket closed decides what happens next — attach again, ask the
 *    person to confirm who they are, sign in again, or stop for good.
 */

export interface TerminalSocket {
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export type TerminalPhase =
  /** The socket is opening, or the attach frame is on its way. */
  | 'connecting'
  /** Attached; what was missed is arriving. */
  | 'replaying'
  /** Output is live and input is taken. */
  | 'live'
  /** The connection dropped; another attempt is scheduled. */
  | 'reconnecting'
  /** The server wants a fresh proof of identity before this browser may attach. */
  | 'needs-identity'
  /** The browser session ended: sign in again. */
  | 'signed-out'
  /** The program ended, or the session was closed, expired or shut down. */
  | 'ended'
  /** No such session (any more), or it is someone else's. */
  | 'gone'
  /** Too many browsers are attached to this session already. */
  | 'crowded'
  /** Terminals are turned off or cannot run on this server. */
  | 'unavailable'
  /** The server refused what this client sent. Attaching afresh may work; repeating by itself would not. */
  | 'failed'
  /** Disposed of by this page. */
  | 'closed';

/** Phases in which nothing more happens until someone acts. */
export const RESTING_PHASES: readonly TerminalPhase[] = ['needs-identity', 'signed-out', 'ended', 'gone', 'crowded', 'unavailable', 'failed', 'closed'];

export type CloseOutcome =
  | { next: 'reattach'; when: 'now' | 'backoff' }
  | { next: 'rest'; phase: Extract<TerminalPhase, 'needs-identity' | 'signed-out' | 'ended' | 'gone' | 'crowded' | 'unavailable' | 'failed'> };

/** What a close code calls for. `exited` is true when an `exit` frame came first. */
export function outcomeOfClose(code: number, exited: boolean): CloseOutcome {
  if (exited || code === TERMINAL_CLOSE_CODES.ended) return { next: 'rest', phase: 'ended' };
  switch (code) {
    case TERMINAL_CLOSE_CODES.authEnded:
      return { next: 'rest', phase: 'signed-out' };
    case TERMINAL_CLOSE_CODES.reauthRequired:
      return { next: 'rest', phase: 'needs-identity' };
    case TERMINAL_CLOSE_CODES.notFound:
      return { next: 'rest', phase: 'gone' };
    case TERMINAL_CLOSE_CODES.tooManyClients:
      return { next: 'rest', phase: 'crowded' };
    case TERMINAL_CLOSE_CODES.unavailable:
      return { next: 'rest', phase: 'unavailable' };
    case TERMINAL_CLOSE_CODES.protocol:
    case 1009: // a frame over the WebSocket layer's own limit
      return { next: 'rest', phase: 'failed' };
    case TERMINAL_CLOSE_CODES.slowConsumer:
      // Nothing is wrong with the session: this page fell behind. Pick up where it left off, at once.
      return { next: 'reattach', when: 'now' };
    default:
      // 1001 (the server is restarting), 1006 (the network went away), and anything unknown: try again, patiently.
      return { next: 'reattach', when: 'backoff' };
  }
}

/** Waits between attempts, in ms; the last one repeats for ever. */
export const RECONNECT_DELAYS_MS: readonly number[] = [400, 1000, 2000, 4000, 8000, 15_000];

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 1), RECONNECT_DELAYS_MS.length) - 1]!;
  // ±20 %, so that several tabs do not knock at the same instant.
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface AttachedInfo {
  session: TerminalSession;
  replay: TerminalReplay;
  /** The first time this client attached, as opposed to coming back after a gap. */
  first: boolean;
}

export interface TerminalClientEvents {
  onPhase(phase: TerminalPhase, detail: { attempt: number; retryInMs: number | null; error: { code: TerminalErrorCode; message: string } | null; closeCode: number | null }): void;
  /** Terminal output, in order, as bytes. */
  onData(bytes: Uint8Array): void;
  /** Clear the widget: what follows is everything that is still kept, from its start. */
  onReset(info: { truncated: boolean }): void;
  onAttached?(info: AttachedInfo): void;
  onSession?(session: TerminalSession): void;
  /** Another attached browser was active more recently and the terminal took its size. */
  onSize?(size: { cols: number; rows: number }): void;
  onUrl?(url: TerminalLocalUrl): void;
  onExit?(exit: TerminalExitFrame): void;
}

export interface TerminalTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface TerminalClientOptions {
  sessionId: string;
  /** Opens the socket for a same-origin path. The one place a WebSocket is made. */
  createSocket: (path: string) => TerminalSocket;
  /** The widget's current size, asked for at every attach. */
  size: () => { cols: number; rows: number };
  events: TerminalClientEvents;
  timers?: TerminalTimers;
  random?: () => number;
  /**
   * Asked when the socket fails twice without ever opening — a refused
   * handshake looks like any other failed connection to a browser. `gone`
   * and `unavailable` stop the retries; `unreachable` keeps them going.
   */
  probe?: () => Promise<'ok' | 'gone' | 'unavailable' | 'unreachable'>;
}

/** A binary frame as bytes, whichever form the socket delivered it in. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const DEFAULT_INPUT_FRAME = 64 * 1024;
const encoder = new TextEncoder();

export class TerminalClient {
  readonly sessionId: string;
  #options: TerminalClientOptions;
  #timers: TerminalTimers;
  #socket: TerminalSocket | null = null;
  #phase: TerminalPhase = 'closed';
  /** Output offset reached; null until the first `attached`. */
  #seq: number | null = null;
  #attachedOnce = false;
  #exited = false;
  #attempt = 0;
  #failedOpens = 0;
  #retry: unknown = null;
  #heartbeat: unknown = null;
  #heartbeatMs = 30_000;
  #heard = false;
  #maxInputFrame = DEFAULT_INPUT_FRAME;
  #lastError: { code: TerminalErrorCode; message: string } | null = null;
  #disposed = false;

  constructor(options: TerminalClientOptions) {
    this.sessionId = options.sessionId;
    this.#options = options;
    this.#timers = options.timers ?? { set: (callback, ms) => globalThis.setTimeout(callback, ms), clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  get phase(): TerminalPhase {
    return this.#phase;
  }

  /** The output offset reached so far: what the next attach sends as `after`. */
  get seq(): number | null {
    return this.#seq;
  }

  /** Whether typed input would reach the program right now. */
  get writable(): boolean {
    return this.#socket !== null && (this.#phase === 'live' || this.#phase === 'replaying');
  }

  /** Open the socket and attach. Safe to call again after a resting phase (identity confirmed, "try again"). */
  connect(): void {
    if (this.#disposed || this.#socket) return;
    this.#clearRetry();
    this.#exited = false;
    this.#lastError = null;
    this.#open();
  }

  /**
   * Attach from scratch, forgetting the offset reached: the server replays
   * everything it still keeps and the widget is cleared. For "the screen
   * looks wrong" and after a protocol refusal.
   */
  reattachFresh(): void {
    if (this.#disposed) return;
    this.#seq = null;
    this.#dropSocket();
    this.#clearRetry();
    this.#attempt = 0;
    this.#exited = false;
    this.#open();
  }

  /** The page came back to the foreground, or the network returned: do not sit out the rest of a back-off. */
  wake(): void {
    if (this.#disposed || this.#phase !== 'reconnecting') return;
    this.#clearRetry();
    this.#open();
  }

  /** Keyboard input. Returns false when it could not be sent (not attached): nothing is queued, nothing is typed later by surprise. */
  send(data: string | Uint8Array): boolean {
    const socket = this.#socket;
    if (!socket || !this.writable) return false;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (bytes.byteLength === 0) return true;
    for (let offset = 0; offset < bytes.byteLength; offset += this.#maxInputFrame) {
      // Each frame gets a buffer of its own: exactly these bytes, whatever larger buffer they were cut from.
      const frame = new Uint8Array(Math.min(bytes.byteLength - offset, this.#maxInputFrame));
      frame.set(bytes.subarray(offset, offset + frame.byteLength));
      socket.send(frame.buffer);
    }
    return true;
  }

  /** Tell the server the widget's size. Before attaching it is simply what the attach frame will carry. */
  resize(cols: number, rows: number): void {
    if (!this.#socket || !this.writable) return;
    this.#socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /** Close the socket and stop for good. The session on the server keeps running. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearRetry();
    this.#dropSocket();
    this.#phase = 'closed';
  }

  // ---- internals ---------------------------------------------------------------------

  #setPhase(phase: TerminalPhase, extra: { retryInMs?: number | null; closeCode?: number | null } = {}): void {
    this.#phase = phase;
    this.#options.events.onPhase(phase, { attempt: this.#attempt, retryInMs: extra.retryInMs ?? null, error: this.#lastError, closeCode: extra.closeCode ?? null });
  }

  #clearRetry(): void {
    if (this.#retry !== null) this.#timers.clear(this.#retry);
    this.#retry = null;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) this.#timers.clear(this.#heartbeat);
    this.#heartbeat = null;
  }

  #dropSocket(): void {
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      /* already closed */
    }
  }

  #open(): void {
    let socket: TerminalSocket;
    this.#setPhase('connecting');
    try {
      socket = this.#options.createSocket(terminalSocketPath(this.sessionId));
    } catch {
      return this.#closed(1006, false);
    }
    this.#socket = socket;
    socket.binaryType = 'arraybuffer';
    let opened = false;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      opened = true;
      const { cols, rows } = this.#options.size();
      const frame: TerminalAttachFrame = { type: 'attach', cols, rows, ...(this.#seq === null ? {} : { after: this.#seq }) };
      socket.send(JSON.stringify(frame));
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      this.#heard = true;
      this.#message(event.data);
    };
    socket.onerror = () => {
      /* a close always follows, and says more */
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#stopHeartbeat();
      this.#closed(event.code, opened);
    };
  }

  #message(data: unknown): void {
    if (typeof data !== 'string') {
      const bytes = toBytes(data);
      if (!bytes) return;
      // Output only counts once the server has said where it starts.
      if (this.#seq === null) return;
      this.#seq += bytes.byteLength;
      this.#options.events.onData(bytes);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const frame = terminalServerFrameSchema.safeParse(parsed);
    // A frame this client does not know is one a newer server added: ignored, never fatal.
    if (!frame.success) return;
    const message = frame.data;
    const events = this.#options.events;
    switch (message.type) {
      case 'attached': {
        const first = !this.#attachedOnce;
        this.#attachedOnce = true;
        this.#attempt = 0;
        this.#failedOpens = 0;
        this.#lastError = null;
        this.#maxInputFrame = Math.max(1, message.limits.maxInputFrameBytes);
        this.#heartbeatMs = Math.max(5_000, message.limits.heartbeatMs);
        if (message.replay.mode === 'full') events.onReset({ truncated: message.replay.truncated });
        this.#seq = message.replay.from;
        this.#setPhase('replaying');
        events.onAttached?.({ session: message.session, replay: message.replay, first });
        events.onSession?.(message.session);
        this.#startHeartbeat();
        break;
      }
      case 'live':
        // The server's count is the truth; a drift here would otherwise repeat or skip output at the next attach.
        if (this.#seq !== message.seq) this.#seq = message.seq;
        this.#setPhase('live');
        break;
      case 'resize':
        events.onSize?.({ cols: message.cols, rows: message.rows });
        break;
      case 'session':
        events.onSession?.(message.session);
        break;
      case 'url':
        events.onUrl?.(message.url);
        break;
      case 'exit':
        this.#exited = true;
        events.onExit?.(message);
        break;
      case 'error':
        this.#lastError = { code: message.code, message: message.message };
        break;
      case 'pong':
        break;
    }
  }

  /** A connection that says nothing at all for two beats is dead even if the browser has not noticed. */
  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heard = true;
    let silentBeats = 0;
    const beat = () => {
      const socket = this.#socket;
      if (!socket) return;
      if (this.#heard) silentBeats = 0;
      else silentBeats += 1;
      this.#heard = false;
      if (silentBeats >= 2) {
        this.#dropSocket();
        return this.#closed(1006, true);
      }
      try {
        socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      } catch {
        /* the close that follows deals with it */
      }
      this.#heartbeat = this.#timers.set(beat, this.#heartbeatMs);
    };
    this.#heartbeat = this.#timers.set(beat, this.#heartbeatMs);
  }

  #closed(code: number, opened: boolean): void {
    if (this.#disposed) return;
    const outcome = outcomeOfClose(code, this.#exited);
    if (outcome.next === 'rest') return this.#setPhase(outcome.phase, { closeCode: code });

    this.#failedOpens = opened ? 0 : this.#failedOpens + 1;
    if (!opened && this.#failedOpens >= 2 && this.#options.probe) {
      // The handshake itself is being refused, or the server is away. Find out which before knocking again.
      const probe = this.#options.probe;
      this.#failedOpens = 0;
      void probe().then(
        (answer) => {
          if (this.#disposed || this.#socket) return;
          if (answer === 'gone') return this.#setPhase('gone', { closeCode: code });
          if (answer === 'unavailable') return this.#setPhase('unavailable', { closeCode: code });
          this.#schedule(outcome.when, code);
        },
        () => {
          if (!this.#disposed && !this.#socket) this.#schedule(outcome.when, code);
        },
      );
      this.#setPhase('reconnecting', { closeCode: code });
      return;
    }
    this.#schedule(outcome.when, code);
  }

  #schedule(when: 'now' | 'backoff', closeCode: number): void {
    this.#attempt += 1;
    const delay = when === 'now' && this.#attempt === 1 ? 0 : reconnectDelay(this.#attempt, this.#options.random);
    this.#setPhase('reconnecting', { retryInMs: delay, closeCode });
    this.#clearRetry();
    this.#retry = this.#timers.set(() => {
      this.#retry = null;
      if (!this.#disposed && !this.#socket) this.#open();
    }, delay);
  }
}
