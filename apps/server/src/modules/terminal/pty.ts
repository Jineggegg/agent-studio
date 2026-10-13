import { ENV_PREFIX } from '../../kernel/config.js';
import { describeError } from '../../kernel/errors.js';

/**
 * The pseudo-terminal behind a session.
 *
 * `kernel/process.ts` is the only place that may create processes with
 * `child_process`; a pseudo-terminal cannot be made that way, so this file is
 * the one sanctioned exception. It keeps the same rules: an executable plus an
 * argument array (never a shell string), a complete environment built by the
 * caller with `context.processes.env(...)`, and nothing named
 * `AGENT_STUDIO_*` in it.
 *
 * The native library is optional. It is loaded on first use; when it is
 * missing or does not load, terminals report themselves unavailable with the
 * reason and the rest of the server is unaffected.
 */

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  /** Bytes go in exactly as given; nothing is decoded or re-encoded. */
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** Stops reading output; the program blocks once the kernel's buffer is full. */
  pause(): void;
  resume(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
}

export interface PtySpawnOptions {
  readonly cwd: string;
  /** The complete environment of the program. */
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyBackend {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
}

export type PtyAvailability =
  | { readonly available: true; readonly backend: PtyBackend }
  | { readonly available: false; readonly reason: string };

export type PtyLoader = () => Promise<PtyAvailability>;

/** The part of the native library's interface that is used here. */
interface NativePty {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string | Buffer) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}

interface NativePtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): NativePty;
}

function assertPlain(value: string, what: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${what} is not a valid process argument.`);
  }
}

export function createPtyBackend(native: NativePtyModule): PtyBackend {
  return {
    spawn(file, args, options) {
      assertPlain(file, 'The executable');
      for (const arg of args) {
        if (typeof arg !== 'string' || arg.includes('\0')) throw new Error('An argument is not a valid process argument.');
      }
      for (const name of Object.keys(options.env)) {
        if (name.startsWith(ENV_PREFIX)) throw new Error(`${name} must not be given to a terminal.`);
      }
      const pty = native.spawn(file, [...args], {
        name: options.env.TERM ?? 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        // Always explicit: the library would otherwise hand over the server's own environment.
        env: { ...options.env },
        // Raw bytes. Decoding here would break characters that straddle two reads.
        encoding: null,
      });
      return {
        pid: pty.pid,
        write: (data) => pty.write(data),
        resize: (cols, rows) => pty.resize(cols, rows),
        pause: () => pty.pause(),
        resume: () => pty.resume(),
        onData: (listener) => {
          pty.onData((data) => listener(typeof data === 'string' ? Buffer.from(data, 'utf8') : data));
        },
        onExit: (listener) => {
          pty.onExit((event) => {
            const signal = typeof event.signal === 'number' && event.signal > 0 ? event.signal : null;
            listener({ exitCode: signal === null ? event.exitCode : null, signal });
          });
        },
      };
    },
  };
}

/** The package name is held in a variable so that building the server never requires the optional package. */
const PTY_PACKAGE = '@lydell/node-pty';

export async function loadNativePty(): Promise<PtyAvailability> {
  if (process.platform === 'win32') {
    return { available: false, reason: 'Terminals are not supported when the server runs on Windows.' };
  }
  try {
    const loaded = (await import(PTY_PACKAGE)) as { spawn?: unknown; default?: { spawn?: unknown } };
    const native = typeof loaded.spawn === 'function' ? loaded : loaded.default;
    if (!native || typeof native.spawn !== 'function') {
      return { available: false, reason: 'The pseudo-terminal library does not have the expected interface.' };
    }
    return { available: true, backend: createPtyBackend(native as NativePtyModule) };
  } catch (error) {
    return { available: false, reason: `The pseudo-terminal library could not be loaded (${describeError(error).split('\n')[0]}).` };
  }
}

/** Loads once and remembers the answer, including a failure. */
export function cachedPtyLoader(load: PtyLoader = loadNativePty): PtyLoader {
  let pending: Promise<PtyAvailability> | null = null;
  return () => (pending ??= load());
}
