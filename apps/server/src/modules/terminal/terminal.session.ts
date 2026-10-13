import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_PROTOCOL_VERSION,
  type TerminalEndReason,
  type TerminalErrorCode,
  type TerminalLocalUrl,
  type TerminalReplay,
  type TerminalServerFrame,
  type TerminalSession as TerminalSessionInfo,
  terminalClientFrameSchema,
} from '@agent-studio/protocol';
import type { RawData, WebSocket } from 'ws';
import { newId } from '../../kernel/crypto.js';
import type { Principal } from '../../kernel/principal.js';
import { ByteRing, alignReplayStart } from './byte-ring.js';
import { MAX_TIMER_MS, type TerminalLimits } from './limits.js';
import { LocalUrlScanner } from './local-urls.js';
import { type ProcessLister, type TerminalIdentity, terminateTerminal } from './process-table.js';
import type { PtyExit, PtyProcess } from './pty.js';

/** Replayed output is sent in frames of this size. */
const REPLAY_FRAME_BYTES = 64 * 1024;
/** Every inbound frame costs this much input budget on top of its length, so tiny frames cannot flood either. */
const FRAME_COST_BYTES = 64;
const PRESSURE_POLL_MS = 50;
/** After asking a stalled client to close, how long before the connection is cut. */
const CLOSE_PATIENCE_MS = 2000;

type ClientState = 'pending' | 'attached' | 'closed';

interface Client {
  readonly id: string;
  readonly socket: WebSocket;
  readonly principal: Principal;
  state: ClientState;
  cols: number;
  rows: number;
  /** Answered the last ping. */
  alive: boolean;
  /** Position in the order of activity; the highest is the most recently active client. */
  activity: number;
  /** When unsent output first exceeded the high mark, while it has not drained since. */
  overSince: number | null;
  /** Input budget (token bucket). May go negative; the socket is then paused until it recovers. */
  tokens: number;
  tokensAt: number;
  throttle: NodeJS.Timeout | null;
  attachTimer: NodeJS.Timeout | null;
}

export interface SessionExit {
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly reason: TerminalEndReason;
  readonly at: number;
}

export interface SessionInit {
  readonly id: string;
  readonly userId: string;
  /** The browser session that created it; admitted from the start. */
  readonly createdBy: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly launcher: string | null;
  readonly remoteHostId: string | null;
  readonly directory: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly pty: PtyProcess;
  readonly identity: TerminalIdentity;
  readonly limits: TerminalLimits;
  readonly listProcesses: ProcessLister;
  /** Told when something a list would show has changed, and when the session ends. */
  readonly onChange: (session: TerminalSession, what: 'updated' | 'ended') => void;
  /** Told about failures worth a log line. */
  readonly reportProblem: (error: unknown) => void;
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

/**
 * One terminal: a program in a pseudo-terminal, the recent output it
 * produced, and the browsers currently attached to it.
 *
 * The session belongs to the server, not to a connection. Clients come and
 * go; output is kept in a bounded buffer whose bytes are numbered, so that a
 * returning client receives exactly what it missed, or a full redraw when its
 * position has scrolled out of the buffer.
 */
export class TerminalSession {
  readonly id: string;
  readonly userId: string;
  readonly projectId: string | null;
  readonly launcher: string | null;
  readonly remoteHostId: string | null;
  readonly directory: string | null;
  readonly createdAt = Date.now();
  title: string;
  cols: number;
  rows: number;
  lastActivityAt = this.createdAt;
  exit: SessionExit | null = null;
  idleExpiresAt: number | null = null;

  readonly #pty: PtyProcess;
  readonly #identity: TerminalIdentity;
  readonly #limits: TerminalLimits;
  readonly #listProcesses: ProcessLister;
  readonly #onChange: SessionInit['onChange'];
  readonly #reportProblem: SessionInit['reportProblem'];
  readonly #ring: ByteRing;
  readonly #scanner: LocalUrlScanner;
  readonly #clients = new Set<Client>();
  /** Browser sessions that may attach without confirming identity again. */
  readonly #admitted = new Set<string>();

  #activityClock = 0;
  #paused = false;
  #endReason: TerminalEndReason | null = null;
  #termination: Promise<number[]> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #lifetimeTimer: NodeJS.Timeout | null = null;
  #pressureTimer: NodeJS.Timeout | null = null;
  #urlTimer: NodeJS.Timeout | null = null;
  #exited: () => void = () => {};
  readonly #whenExited = new Promise<void>((resolve) => {
    this.#exited = resolve;
  });

  constructor(init: SessionInit) {
    this.id = init.id;
    this.userId = init.userId;
    this.projectId = init.projectId;
    this.launcher = init.launcher;
    this.remoteHostId = init.remoteHostId;
    this.directory = init.directory;
    this.title = init.title;
    this.cols = init.cols;
    this.rows = init.rows;
    this.#pty = init.pty;
    this.#identity = init.identity;
    this.#limits = init.limits;
    this.#listProcesses = init.listProcesses;
    this.#onChange = init.onChange;
    this.#reportProblem = init.reportProblem;
    this.#ring = new ByteRing(init.limits.replayBufferBytes);
    this.#scanner = new LocalUrlScanner({ maxUrls: init.limits.maxUrlsPerSession });
    this.#admitted.add(init.createdBy);

    this.#pty.onData((chunk) => this.#onOutput(chunk));
    this.#pty.onExit((exit) => this.#onExit(exit));

    this.#lifetimeTimer = setTimeout(() => void this.terminate('lifetime'), Math.min(init.limits.maxLifetimeMs, MAX_TIMER_MS));
    this.#lifetimeTimer.unref();
    // Nobody is attached yet: the idle window starts now.
    this.#startIdleTimer();
  }

  // ---- what others may know ------------------------------------------------

  get alive(): boolean {
    return this.exit === null;
  }

  get pid(): number {
    return this.#pty.pid;
  }

  get attachedClients(): number {
    let count = 0;
    for (const client of this.#clients) if (client.state === 'attached') count += 1;
    return count;
  }

  get seq(): number {
    return this.#ring.end;
  }

  get urls(): TerminalLocalUrl[] {
    return this.#scanner.urls;
  }

  isAdmitted(credentialId: string): boolean {
    return this.#admitted.has(credentialId);
  }

  admit(credentialId: string): void {
    this.#admitted.add(credentialId);
  }

  describe(attachable: boolean): TerminalSessionInfo {
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.title,
      launcher: this.launcher,
      remoteHostId: this.remoteHostId,
      directory: this.directory,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      attachedClients: this.attachedClients,
      alive: this.alive,
      exitCode: this.exit?.exitCode ?? null,
      signal: this.exit?.signal ?? null,
      endReason: this.exit?.reason ?? null,
      cols: this.cols,
      rows: this.rows,
      seq: this.seq,
      urls: this.urls,
      attachable,
      idleExpiresAt: this.idleExpiresAt,
      expiresAt: this.createdAt + this.#limits.maxLifetimeMs,
    };
  }

  // ---- changes from the management API --------------------------------------

  rename(title: string): void {
    this.title = title;
    this.#announceChange();
  }

  /** Types bytes into the program, as the keyboard would. */
  write(data: Buffer): void {
    if (!this.alive || data.length === 0) return;
    this.lastActivityAt = Date.now();
    this.#pty.write(data);
  }

  /**
   * Ends the terminal: every process of its session is hung up, then killed
   * if it lingers. Resolves with the pids that are still there afterwards —
   * normally none. Safe to call more than once; later callers get the same
   * answer.
   */
  terminate(reason: TerminalEndReason): Promise<number[]> {
    if (this.alive) this.#endReason ??= reason;
    this.#termination ??= this.#endProcesses();
    return this.#termination;
  }

  async #endProcesses(): Promise<number[]> {
    let remaining: number[];
    try {
      remaining = await terminateTerminal(this.#identity, {
        list: this.#listProcesses,
        graceMs: this.#limits.terminateGraceMs,
        killWaitMs: this.#limits.killWaitMs,
      });
    } catch (error) {
      // The process table could not be read. End at least the program itself.
      this.#reportProblem(error);
      remaining = await this.#endLeaderOnly();
    }
    // The library reports the exit a moment after the process is gone.
    if (this.alive) await this.#exitWithin(1000);
    // No exit was reported, so the program has not been collected and its pid is
    // still its own: whatever the process table said, end it directly.
    if (this.alive) remaining = await this.#endLeaderOnly();
    if (this.alive) this.#onExit({ exitCode: null, signal: null });
    return remaining;
  }

  async #endLeaderOnly(): Promise<number[]> {
    for (const [signal, patience] of [
      ['SIGHUP', this.#limits.terminateGraceMs],
      ['SIGKILL', this.#limits.killWaitMs],
    ] as const) {
      if (!this.alive) return [];
      try {
        process.kill(this.#pty.pid, signal);
      } catch {
        return [];
      }
      await this.#exitWithin(patience);
    }
    return this.alive ? [this.#pty.pid] : [];
  }

  #exitWithin(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void this.#whenExited.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---- connections ----------------------------------------------------------

  /** Takes over a freshly upgraded socket. The client must send its attach frame next. */
  accept(socket: WebSocket, principal: Principal): void {
    // Connections that have not attached yet are bounded too, a few times the number that may attach.
    if (this.#clients.size >= this.#limits.maxClientsPerSession * 4) {
      socket.on('error', () => {});
      socket.send(JSON.stringify({ type: 'error', code: 'too_many_clients', message: 'Too many connections to this terminal.' } satisfies TerminalServerFrame));
      socket.close(TERMINAL_CLOSE_CODES.tooManyClients, 'too_many_clients');
      return;
    }
    const client: Client = {
      id: newId(),
      socket,
      principal,
      state: 'pending',
      cols: this.cols,
      rows: this.rows,
      alive: true,
      activity: 0,
      overSince: null,
      tokens: this.#limits.inputBurstBytes,
      tokensAt: Date.now(),
      throttle: null,
      attachTimer: null,
    };
    this.#clients.add(client);
    client.attachTimer = setTimeout(
      () => this.#refuse(client, 'attach_expected', 'The attach frame did not arrive.', TERMINAL_CLOSE_CODES.protocol),
      this.#limits.attachTimeoutMs,
    );
    client.attachTimer.unref();

    socket.on('message', (raw, isBinary) => this.#onMessage(client, toBuffer(raw), isBinary));
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.#forget(client));
    socket.on('error', () => this.#forget(client));
  }

  /** Called on every heartbeat of the service. */
  heartbeat(isCredentialLive: (principal: Principal) => boolean): void {
    for (const client of [...this.#clients]) {
      if (!isCredentialLive(client.principal)) {
        this.#close(client, TERMINAL_CLOSE_CODES.authEnded, 'session ended');
        continue;
      }
      if (!client.alive) {
        client.socket.terminate();
        this.#forget(client);
        continue;
      }
      client.alive = false;
      if (client.socket.readyState === client.socket.OPEN) client.socket.ping();
    }
  }

  /** A browser session was signed out: its connections end now and it must prove itself again later. */
  revokeCredential(credentialId: string): void {
    this.#admitted.delete(credentialId);
    for (const client of [...this.#clients]) {
      if (client.principal.credentialId === credentialId) this.#close(client, TERMINAL_CLOSE_CODES.authEnded, 'session ended');
    }
  }

  #onMessage(client: Client, data: Buffer, isBinary: boolean): void {
    if (client.state === 'closed') return;
    this.#charge(client, data.length);

    if (isBinary) {
      if (client.state !== 'attached') {
        return this.#refuse(client, 'attach_expected', 'Send the attach frame before any input.', TERMINAL_CLOSE_CODES.protocol);
      }
      if (data.length > this.#limits.maxInputFrameBytes) {
        return this.#refuse(client, 'frame_too_large', 'That input frame is too large.', TERMINAL_CLOSE_CODES.protocol);
      }
      if (!this.alive || data.length === 0) return;
      this.#markActive(client);
      this.#pty.write(data);
      return;
    }

    if (data.length > this.#limits.maxControlFrameBytes) {
      return this.#refuse(client, 'frame_too_large', 'That control frame is too large.', TERMINAL_CLOSE_CODES.protocol);
    }
    const parsed = (() => {
      try {
        return terminalClientFrameSchema.safeParse(JSON.parse(data.toString('utf8')));
      } catch {
        return null;
      }
    })();
    if (!parsed?.success) {
      return this.#refuse(client, 'malformed_frame', 'That frame is not part of the terminal protocol.', TERMINAL_CLOSE_CODES.protocol);
    }
    const frame = parsed.data;
    if (frame.type === 'ping') {
      return this.#send(client, { type: 'pong', ...(frame.t === undefined ? {} : { t: frame.t }) });
    }
    if (frame.type === 'attach') {
      if (client.state !== 'pending') {
        return this.#refuse(client, 'already_attached', 'This connection is already attached.', TERMINAL_CLOSE_CODES.protocol);
      }
      return this.#attach(client, frame.after ?? null, frame.cols, frame.rows);
    }
    // resize
    if (client.state !== 'attached') {
      return this.#refuse(client, 'attach_expected', 'Send the attach frame first.', TERMINAL_CLOSE_CODES.protocol);
    }
    client.cols = frame.cols;
    client.rows = frame.rows;
    this.#markActive(client);
  }

  #attach(client: Client, after: number | null, cols: number, rows: number): void {
    if (client.attachTimer) clearTimeout(client.attachTimer);
    client.attachTimer = null;
    if (this.attachedClients >= this.#limits.maxClientsPerSession) {
      return this.#refuse(client, 'too_many_clients', 'Too many devices are attached to this terminal.', TERMINAL_CLOSE_CODES.tooManyClients);
    }
    client.state = 'attached';
    client.cols = cols;
    client.rows = rows;
    this.#stopIdleTimer();
    this.lastActivityAt = Date.now();

    // Everything below happens in one turn of the event loop, so no output can
    // slip between the replay and the live stream.
    const { marker, bytes } = this.#replay(after);
    this.#send(client, {
      type: 'attached',
      protocol: TERMINAL_PROTOCOL_VERSION,
      clientId: client.id,
      session: this.describe(true),
      replay: marker,
      limits: { maxInputFrameBytes: this.#limits.maxInputFrameBytes, heartbeatMs: this.#limits.heartbeatMs },
    });
    for (let offset = 0; offset < bytes.length; offset += REPLAY_FRAME_BYTES) {
      this.#sendBytes(client, bytes.subarray(offset, offset + REPLAY_FRAME_BYTES));
    }
    this.#send(client, { type: 'live', seq: marker.to });

    if (this.exit) {
      // A terminal that has already ended can still be read once more.
      this.#send(client, this.#exitFrame(this.exit));
      this.#close(client, TERMINAL_CLOSE_CODES.ended, this.exit.reason);
      return;
    }
    // The newcomer is the most recently active client: the terminal takes its size.
    this.#markActive(client);
    this.#announceChange();
  }

  #replay(after: number | null): { marker: TerminalReplay; bytes: Buffer } {
    const start = this.#ring.start;
    const end = this.#ring.end;
    if (after !== null && after >= start && after <= end) {
      return { marker: { mode: 'delta', from: after, to: end, truncated: false }, bytes: this.#ring.read(after) };
    }
    let bytes = this.#ring.read(start);
    let from = start;
    const truncated = start > 0;
    if (truncated) {
      const skip = alignReplayStart(bytes);
      bytes = bytes.subarray(skip);
      from += skip;
    }
    return { marker: { mode: 'full', from, to: end, truncated }, bytes };
  }

  /** Marks a client as the one whose size the terminal follows. */
  #markActive(client: Client): void {
    client.activity = ++this.#activityClock;
    this.lastActivityAt = Date.now();
    this.#applySize(client.cols, client.rows);
  }

  #applySize(cols: number, rows: number): void {
    if (!this.alive || (cols === this.cols && rows === this.rows)) return;
    try {
      this.#pty.resize(cols, rows);
    } catch {
      return; // the program is already going away
    }
    this.cols = cols;
    this.rows = rows;
    this.#broadcast({ type: 'resize', cols, rows });
  }

  /** Takes input budget from a client and slows it down when it has overdrawn. */
  #charge(client: Client, bytes: number): void {
    const now = Date.now();
    const refill = ((now - client.tokensAt) / 1000) * this.#limits.inputBytesPerSecond;
    client.tokens = Math.min(this.#limits.inputBurstBytes, client.tokens + refill) - (bytes + FRAME_COST_BYTES);
    client.tokensAt = now;
    if (client.tokens >= 0 || client.throttle) return;
    // Not reading from the socket pushes back through TCP: nothing is lost, the sender just waits.
    client.socket.pause();
    const recover = () => {
      client.throttle = null;
      if (client.state === 'closed') return;
      const elapsed = Date.now() - client.tokensAt;
      const balance = client.tokens + (elapsed / 1000) * this.#limits.inputBytesPerSecond;
      if (balance < 0) {
        client.throttle = setTimeout(recover, Math.ceil((-balance / this.#limits.inputBytesPerSecond) * 1000) + 1);
        client.throttle.unref();
        return;
      }
      client.socket.resume();
    };
    client.throttle = setTimeout(recover, Math.ceil((-client.tokens / this.#limits.inputBytesPerSecond) * 1000) + 1);
    client.throttle.unref();
  }

  // ---- output ---------------------------------------------------------------

  #onOutput(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#ring.write(chunk);
    this.lastActivityAt = Date.now();
    for (const client of [...this.#clients]) {
      if (client.state === 'attached') this.#sendBytes(client, chunk);
    }
    this.#reportUrls(this.#scanner.push(chunk));
    if (this.#urlTimer) clearTimeout(this.#urlTimer);
    this.#urlTimer = setTimeout(() => {
      this.#urlTimer = null;
      this.#reportUrls(this.#scanner.flush());
    }, this.#limits.urlFlushMs);
    this.#urlTimer.unref();
    this.#checkPressure();
  }

  #reportUrls(urls: TerminalLocalUrl[]): void {
    for (const url of urls) this.#broadcast({ type: 'url', url });
    if (urls.length > 0) this.#onChange(this, 'updated');
  }

  /**
   * Back-pressure. Output is only ever queued per client up to the hard mark:
   * above the high mark the program is paused (it blocks on its own writes),
   * and a client that does not drain within the grace period is dropped so
   * that the others, and the program, can continue.
   */
  #checkPressure(): void {
    const now = Date.now();
    for (const client of [...this.#clients]) {
      if (client.state !== 'attached') continue;
      const queued = client.socket.bufferedAmount;
      if (queued > this.#limits.clientBufferHighBytes) client.overSince ??= now;
      else if (queued <= this.#limits.clientBufferLowBytes) client.overSince = null;
      if (client.overSince !== null && now - client.overSince > this.#limits.slowClientGraceMs) this.#dropSlow(client);
    }
    let anyHigh = false;
    let allLow = true;
    for (const client of this.#clients) {
      if (client.state !== 'attached') continue;
      const queued = client.socket.bufferedAmount;
      if (queued > this.#limits.clientBufferHighBytes) anyHigh = true;
      if (queued > this.#limits.clientBufferLowBytes) allLow = false;
    }
    if (!this.#paused && anyHigh && this.alive) {
      this.#paused = true;
      this.#pty.pause();
    } else if (this.#paused && allLow) {
      this.#paused = false;
      if (this.alive) this.#pty.resume();
    }
    const watch = this.alive && (this.#paused || !allLow);
    if (watch && !this.#pressureTimer) {
      this.#pressureTimer = setTimeout(() => {
        this.#pressureTimer = null;
        this.#checkPressure();
      }, PRESSURE_POLL_MS);
      this.#pressureTimer.unref();
    }
  }

  #sendBytes(client: Client, bytes: Buffer): void {
    const socket = client.socket;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.#limits.clientBufferHardBytes) return this.#dropSlow(client);
    socket.send(bytes, { binary: true });
  }

  #dropSlow(client: Client): void {
    const socket = client.socket;
    this.#refuse(client, 'slow_consumer', 'This connection is not keeping up. Attach again to continue.', TERMINAL_CLOSE_CODES.slowConsumer);
    // The close frame sits behind everything the client has not read; do not wait for it for long.
    const cut = setTimeout(() => socket.terminate(), CLOSE_PATIENCE_MS);
    cut.unref();
    socket.once('close', () => clearTimeout(cut));
  }

  #send(client: Client, frame: TerminalServerFrame): void {
    const socket = client.socket;
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  #broadcast(frame: TerminalServerFrame): void {
    for (const client of this.#clients) if (client.state === 'attached') this.#send(client, frame);
  }

  /** Tells attached clients and list views that the title or the audience changed. */
  #announceChange(): void {
    this.#broadcast({ type: 'session', session: this.describe(true) });
    this.#onChange(this, 'updated');
  }

  // ---- leaving and ending ---------------------------------------------------

  #refuse(client: Client, code: TerminalErrorCode, message: string, closeCode: number): void {
    this.#send(client, { type: 'error', code, message });
    this.#close(client, closeCode, code);
  }

  #close(client: Client, code: number, reason: string): void {
    try {
      client.socket.close(code, reason);
    } catch {
      client.socket.terminate();
    }
    this.#forget(client);
  }

  /** Removes a client from the session. Runs once per client, whoever notices the departure first. */
  #forget(client: Client): void {
    if (client.state === 'closed') return;
    const wasAttached = client.state === 'attached';
    client.state = 'closed';
    if (client.attachTimer) clearTimeout(client.attachTimer);
    if (client.throttle) clearTimeout(client.throttle);
    client.attachTimer = null;
    client.throttle = null;
    this.#clients.delete(client);
    if (!wasAttached) return;

    this.lastActivityAt = Date.now();
    let next: Client | null = null;
    for (const other of this.#clients) {
      if (other.state === 'attached' && (next === null || other.activity > next.activity)) next = other;
    }
    if (next) this.#applySize(next.cols, next.rows);
    else if (this.alive) this.#startIdleTimer();
    this.#checkPressure();
    if (this.alive) this.#announceChange();
  }

  #startIdleTimer(): void {
    this.#stopIdleTimer();
    const delay = Math.min(this.#limits.idleTimeoutMs, MAX_TIMER_MS);
    this.idleExpiresAt = Date.now() + delay;
    this.#idleTimer = setTimeout(() => void this.terminate('idle'), delay);
    this.#idleTimer.unref();
  }

  #stopIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.idleExpiresAt = null;
  }

  #exitFrame(exit: SessionExit): TerminalServerFrame {
    return { type: 'exit', exitCode: exit.exitCode, signal: exit.signal, reason: exit.reason, seq: this.seq };
  }

  #onExit(result: PtyExit): void {
    if (this.exit) return;
    const exit: SessionExit = {
      exitCode: result.exitCode,
      signal: result.signal,
      reason: this.#endReason ?? 'exited',
      at: Date.now(),
    };
    this.exit = exit;
    this.lastActivityAt = exit.at;
    this.#stopIdleTimer();
    for (const timer of [this.#lifetimeTimer, this.#pressureTimer, this.#urlTimer]) if (timer) clearTimeout(timer);
    this.#lifetimeTimer = this.#pressureTimer = this.#urlTimer = null;
    this.#reportUrls(this.#scanner.flush());

    const closeCode = exit.reason === 'shutdown' ? TERMINAL_CLOSE_CODES.goingAway : TERMINAL_CLOSE_CODES.ended;
    for (const client of [...this.#clients]) {
      if (client.state === 'attached') this.#send(client, this.#exitFrame(exit));
      this.#close(client, closeCode, exit.reason);
    }
    // Whatever the program left running in its session goes with it.
    this.#termination ??= this.#endProcesses();
    this.#exited();
    this.#onChange(this, 'ended');
  }
}
