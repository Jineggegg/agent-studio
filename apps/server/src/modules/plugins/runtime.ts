import { terminate, type ProcessSupervisor } from '../../kernel/process.js';
import { redactSecrets } from '../../kernel/redact.js';
import { LineDecoder, classify, encodeLine, type RpcId } from './framing.js';
import type { Launch } from './isolation.js';
import { HostRefusal } from './permissions.js';

/**
 * One plugin's process and the conversation with it.
 *
 * Everything the process sends is treated as hostile input: messages are
 * size-limited before they are buffered, counted, and classified before they
 * are acted on; what the process fails to read is not queued without bound;
 * what it writes to standard error is kept only as a short tail. A process
 * that breaks any of these rules, or does not answer in time, is ended — there
 * is no way to make a JavaScript program stop what it is doing other than
 * stopping the program.
 */

export interface ProcessLimits {
  /** Time allowed from start to the answer to `initialize`. */
  readonly handshakeTimeoutMs: number;
  /** Largest single message in either direction. */
  readonly maxMessageBytes: number;
  /** Most bytes that may wait for the plugin to read them. */
  readonly maxQueuedBytes: number;
  /** Lines that are not valid messages before the process is ended. */
  readonly maxInvalidMessages: number;
  /** Messages accepted in any one second. */
  readonly maxMessagesPerSecond: number;
  /** Requests to the Studio a plugin may have in progress at once. */
  readonly maxConcurrentHostCalls: number;
  /** Size of the log tail kept per plugin. */
  readonly logTailBytes: number;
  /** Time a process gets to leave after being asked to. */
  readonly stopGraceMs: number;
  /** V8 heap cap (`--max-old-space-size`). */
  readonly memoryMb: number;
}

type ChildProcess = ReturnType<ProcessSupervisor['spawn']>;

/** A call into a plugin that did not produce a result. */
export class PluginCallError extends Error {
  /** `timeout`, `plugin_exited`, `not_running`, `too_large`, or a code the plugin itself reported. */
  readonly code: string;
  /** True when the plugin answered with this error itself, as opposed to failing to answer. */
  readonly reported: boolean;

  constructor(code: string, message: string, reported = false) {
    super(message);
    this.name = 'PluginCallError';
    this.code = code;
    this.reported = reported;
  }
}

export interface ExitInfo {
  /** The Studio asked it to stop. */
  readonly expected: boolean;
  /** A sentence for the owner. */
  readonly reason: string;
}

/** The last lines a plugin logged, bounded in bytes. */
export class LogTail {
  readonly #maxBytes: number;
  #lines: string[] = [];
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  add(line: string): void {
    // Control characters would let a plugin forge or hide lines in whatever shows the log.
    // eslint-disable-next-line no-control-regex
    const clean = redactSecrets(line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')).slice(0, 1000);
    this.#lines.push(clean);
    this.#bytes += clean.length + 1;
    while (this.#bytes > this.#maxBytes && this.#lines.length > 1) {
      this.#bytes -= this.#lines.shift()!.length + 1;
    }
  }

  lines(): string[] {
    return [...this.#lines];
  }

  last(): string | null {
    return this.#lines.at(-1) ?? null;
  }
}

export interface ProcessDeps {
  readonly processes: ProcessSupervisor;
  readonly launch: Launch;
  readonly limits: ProcessLimits;
  readonly log: LogTail;
  /** Serves a request from the plugin. Throws {@link HostRefusal} to decline. */
  onHostRequest(method: string, params: unknown): Promise<unknown>;
  onExit(info: ExitInfo): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PluginProcess {
  readonly #deps: ProcessDeps;
  readonly #pending = new Map<RpcId, Pending>();
  #child: ChildProcess | null = null;
  #exited = false;
  #stopping = false;
  #killReason: string | null = null;
  #terminating = false;
  #nextId = 1;
  #invalid = 0;
  #windowStart = 0;
  #windowCount = 0;
  #hostCalls = 0;
  #stderrRest = '';
  #resolveClosed: () => void = () => {};
  readonly #closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(deps: ProcessDeps) {
    this.#deps = deps;
  }

  /** Process id of what was spawned (the sandbox launcher, when there is one). It leads the process group. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get running(): boolean {
    return this.#child !== null && !this.#exited;
  }

  /** Resolves once the process is gone. */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /** Spawns the process and performs the handshake. Rejects — with the process ended — if it does not go well. */
  async start(initialize: Record<string, unknown>): Promise<unknown> {
    if (this.#child) throw new Error('A plugin process is started once.');
    const { launch, limits } = this.#deps;
    const child = this.#deps.processes.spawn(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, stdin: 'pipe' });
    this.#child = child;

    const decoder = new LineDecoder({
      maxBytes: limits.maxMessageBytes,
      onMessage: (message) => this.#receive(message),
      onProblem: (problem) => {
        if (problem === 'oversized') return this.kill('sent a message larger than the limit');
        this.#invalid += 1;
        if (this.#invalid > limits.maxInvalidMessages) this.kill('kept writing things that are not protocol messages to its standard output');
      },
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!this.#exited && this.#killReason === null) decoder.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => this.#stderr(chunk));
    child.stdin?.on('error', () => {
      /* the process went away while being written to; "close" reports it */
    });
    child.once('error', (error) => this.#finish(`could not be started: ${error.message}`));
    child.once('close', (code, signal) => {
      this.#flushStderr();
      this.#finish(signal ? `was ended by ${signal}` : `exited with code ${code ?? 'unknown'}`);
    });

    try {
      return await this.call('initialize', initialize, limits.handshakeTimeoutMs);
    } catch (error) {
      if (!(error instanceof PluginCallError && error.code === 'timeout')) {
        this.kill(`failed to start: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      await this.#closed;
      throw error;
    }
  }

  /**
   * Sends a request and waits for its answer. A process that does not answer
   * within `timeoutMs` is ended: it may be stuck for good, and nothing else
   * can interrupt it.
   */
  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.running) return Promise.reject(new PluginCallError('not_running', 'The plugin is not running.'));
    const id = `s${this.#nextId}`;
    this.#nextId += 1;
    const line = encodeLine({ jsonrpc: '2.0', id, method, params });
    if (line.length > this.#deps.limits.maxMessageBytes) {
      return Promise.reject(new PluginCallError('too_large', 'That is larger than one message to a plugin may be.'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PluginCallError('timeout', `The plugin did not answer within ${Math.ceil(timeoutMs / 1000)} s and was stopped.`));
        this.kill(method === 'initialize' ? 'did not complete the start-up handshake in time' : `did not answer "${method}" within ${timeoutMs} ms`);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(line);
    });
  }

  /** Asks the process to leave, then makes sure it has. */
  async stop(shutdownParams: Record<string, unknown>): Promise<void> {
    const child = this.#child;
    if (!child || this.#exited) return;
    this.#stopping = true;
    const grace = this.#deps.limits.stopGraceMs;
    await this.call('shutdown', shutdownParams, grace).catch(() => {});
    if (!this.#exited) {
      child.stdin?.end();
      const timer = setTimeout(() => this.kill('did not leave when asked'), grace);
      await this.#closed;
      clearTimeout(timer);
    }
  }

  /** Ends the process now, recording why. */
  kill(reason: string): void {
    const child = this.#child;
    if (!child || this.#exited) return;
    // While stopping, a slow goodbye is not a failure worth recording.
    if (!this.#stopping) this.#killReason ??= reason;
    // Once is enough, however many reasons pile up while the process is on its way out.
    if (this.#terminating) return;
    this.#terminating = true;
    terminate(child, 300);
  }

  #write(line: Buffer): void {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed || this.#exited) return;
    if (stdin.writableLength + line.length > this.#deps.limits.maxQueuedBytes) {
      this.kill('is not reading what the Studio sends it');
      return;
    }
    stdin.write(line);
  }

  #reply(id: RpcId, body: { result: unknown } | { error: { code: number; message: string; data: { code: string } } }): void {
    let line = encodeLine({ jsonrpc: '2.0', id, ...body });
    if (line.length > this.#deps.limits.maxMessageBytes) {
      line = encodeLine({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'The answer is larger than one message may be.', data: { code: 'too_large' } },
      });
    }
    this.#write(line);
  }

  #receive(raw: Record<string, unknown>): void {
    const limits = this.#deps.limits;
    const now = Date.now();
    if (now - this.#windowStart >= 1000) {
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    this.#windowCount += 1;
    if (this.#windowCount > limits.maxMessagesPerSecond) return this.kill('flooded the Studio with messages');

    const message = classify(raw);
    switch (message.kind) {
      case 'invalid':
        this.#invalid += 1;
        if (this.#invalid > limits.maxInvalidMessages) this.kill('kept sending malformed messages');
        return;

      case 'result':
      case 'error': {
        const entry = this.#pending.get(message.id);
        if (!entry) return;
        this.#pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.kind === 'result') entry.resolve(message.result);
        else entry.reject(new PluginCallError(message.code, message.message, true));
        return;
      }

      case 'notification':
        if (message.method === 'host.log') {
          const params = (message.params ?? {}) as { level?: unknown; message?: unknown };
          const level = typeof params.level === 'string' && /^(debug|info|warn|error)$/.test(params.level) ? params.level : 'info';
          if (typeof params.message === 'string') this.#deps.log.add(`[${level}] ${params.message}`);
        }
        return;

      case 'request': {
        const { id, method, params } = message;
        if (this.#hostCalls >= limits.maxConcurrentHostCalls) {
          return this.#reply(id, {
            error: { code: -32001, message: 'Too many requests to the Studio are in progress.', data: { code: 'too_many_requests' } },
          });
        }
        this.#hostCalls += 1;
        this.#deps.onHostRequest(method, params).then(
          (result) => {
            this.#hostCalls -= 1;
            this.#reply(id, { result: result === undefined ? null : result });
          },
          (error: unknown) => {
            this.#hostCalls -= 1;
            // Only a deliberate refusal is described to the plugin; anything else stays inside the server.
            const refusal = error instanceof HostRefusal ? error : new HostRefusal('host_error', 'The Studio could not do that.');
            this.#reply(id, { error: { code: -32001, message: refusal.message, data: { code: refusal.code } } });
          },
        );
        return;
      }
    }
  }

  #stderr(chunk: Buffer): void {
    const text = this.#stderrRest + chunk.toString('utf8');
    const lines = text.split('\n');
    this.#stderrRest = (lines.pop() ?? '').slice(0, 4000);
    // A burst of output is cut to what the tail could hold anyway.
    for (const line of lines.slice(-200)) if (line.trim() !== '') this.#deps.log.add(line);
  }

  #flushStderr(): void {
    if (this.#stderrRest.trim() !== '') this.#deps.log.add(this.#stderrRest);
    this.#stderrRest = '';
  }

  #finish(how: string): void {
    if (this.#exited) return;
    this.#exited = true;
    const reason = this.#killReason ?? how;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new PluginCallError('plugin_exited', `The plugin stopped before answering (it ${reason}).`));
    }
    this.#pending.clear();
    this.#resolveClosed();
    this.#deps.onExit({ expected: this.#stopping && this.#killReason === null, reason });
  }
}
