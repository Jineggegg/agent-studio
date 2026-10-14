import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_PREFIX, type SandboxMode } from './config.js';

/**
 * The only place in the server that creates processes.
 *
 * - Commands are always an executable plus an argument array; no shell is
 *   ever involved, so there is nothing to inject into.
 * - A child's environment is built from an allowlist. The server's own
 *   settings and secrets (everything named AGENT_STUDIO_*) can never be
 *   inherited by an agent, a terminal or a git command.
 * - Where the platform supports it, agent processes run in a sandbox that
 *   hides the server's data directory from them.
 */

const BASELINE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function buildChildEnv(options: {
  passthrough?: readonly string[];
  extra?: Readonly<Record<string, string | undefined>>;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const name of [...BASELINE_ENV, ...(options.passthrough ?? [])]) {
    if (name.startsWith(ENV_PREFIX)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (name.startsWith(ENV_PREFIX)) {
      throw new Error(`${name} must not be given to a child process.`);
    }
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export type SandboxProfile =
  /**
   * Hide the server's own data from the process; everything else is as the
   * user sees it. `hide` names more that this process must not see: an
   * existing directory becomes an empty one, an existing file an empty,
   * read-only file, and a path that does not exist is skipped. `expose` is
   * applied after `hide`, so a path inside a hidden directory can be let back
   * in (read-only).
   */
  | { readonly kind: 'mask'; readonly expose?: readonly string[]; readonly hide?: readonly string[] }
  /** Read-only file system except `writable`; credentials directories hidden; optional network. */
  | {
      readonly kind: 'confine';
      readonly writable: readonly string[];
      readonly network: boolean;
      readonly expose?: readonly string[];
    }
  /**
   * Nothing of the host at all except the system's program and library
   * directories (read-only), `readable` (read-only) and `writable`: no home
   * directory, no /etc, no /run (so no local service sockets), no /tmp, a
   * private /dev and /proc, its own IPC and host-name spaces, and a root that
   * cannot be written to. For code that is not trusted at all (plugins).
   */
  | {
      readonly kind: 'isolate';
      readonly readable: readonly string[];
      readonly writable: readonly string[];
      readonly network: boolean;
    };

/** Program and library directories an isolated process may read. */
const ISOLATE_SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'] as const;

/** What name resolution and TLS need; given to an isolated process only together with the network. */
const ISOLATE_NETWORK_PATHS = [
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
] as const;

/** True when `inner` is `outer` or lies beneath it (lexically). */
function contains(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Places in a home directory that hold credentials, relative to it. */
const CREDENTIAL_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.config/gh',
  '.config/gcloud',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '.claude',
  '.claude.json',
  '.codex',
] as const;

/**
 * The places in a home directory that hold credentials: SSH and GPG keys,
 * cloud and container sign-ins, the GitHub CLI's token, package-registry and
 * Git credentials, and the agent CLIs' own sign-ins. The `confine` profile
 * hides all of them; a caller of the `mask` profile passes the ones its
 * process has no business reading in `hide`.
 */
export function credentialPaths(home: string): string[] {
  return CREDENTIAL_PATHS.map((relative) => path.join(home, relative));
}

export interface SandboxStatus {
  readonly mode: 'bwrap' | 'none';
  /** Why there is no sandbox, when there is none. */
  readonly reason?: string;
}

export class Sandbox {
  readonly status: SandboxStatus;
  readonly #protected: readonly string[];
  /** Where the empty stand-in file is kept when nothing is protected (see {@link Sandbox.#emptyFile}). */
  #scratch: string | null = null;

  private constructor(status: SandboxStatus, protectedPaths: readonly string[]) {
    this.status = status;
    this.#protected = protectedPaths;
  }

  static none(reason: string): Sandbox {
    return new Sandbox({ mode: 'none', reason }, []);
  }

  /**
   * Decides whether a sandbox can be used. `bwrap` demands one and fails
   * loudly without it; `auto` uses one when it works and says so when it
   * does not.
   */
  static async detect(mode: SandboxMode, protectedPaths: readonly string[]): Promise<Sandbox> {
    if (mode === 'off') return Sandbox.none('Turned off by configuration.');
    if (process.platform !== 'linux') {
      if (mode === 'bwrap') throw new Error('The bwrap sandbox is only available on Linux.');
      return Sandbox.none(`No sandbox is available on ${process.platform}.`);
    }
    const probe = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const child = spawn('bwrap', ['--bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: buildChildEnv({}),
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => resolve({ ok: false, detail: error.message }));
      child.on('close', (code) => resolve({ ok: code === 0, detail: stderr.trim() || `exit ${code}` }));
    });
    if (!probe.ok) {
      if (mode === 'bwrap') throw new Error(`The bwrap sandbox is required but does not work here: ${probe.detail}`);
      return Sandbox.none(`bubblewrap is not usable here (${probe.detail}).`);
    }
    return new Sandbox({ mode: 'bwrap' }, protectedPaths);
  }

  /** Rewrites a command so that it runs inside the sandbox; a no-op when there is none. */
  wrap(file: string, args: readonly string[], profile: SandboxProfile): { file: string; args: string[]; sandboxed: boolean } {
    if (this.status.mode !== 'bwrap') return { file, args: [...args], sandboxed: false };
    if (profile.kind === 'isolate') {
      return { file: 'bwrap', args: [...this.#isolate(profile), '--', file, ...args], sandboxed: true };
    }

    const flags: string[] = ['--die-with-parent', '--unshare-pid'];
    if (profile.kind === 'mask') {
      flags.push('--bind', '/', '/');
    } else {
      flags.push('--ro-bind', '/', '/', '--tmpfs', '/tmp');
      for (const writable of profile.writable) {
        if (existsSync(writable)) flags.push('--bind', writable, writable);
      }
      if (!profile.network) flags.push('--unshare-net');
    }
    flags.push('--dev-bind', '/dev', '/dev', '--proc', '/proc');

    const hidden = [...this.#protected];
    if (profile.kind === 'confine') hidden.push(...credentialPaths(os.homedir()));
    for (const target of hidden) {
      if (!existsSync(target)) continue;
      if (statSync(target).isDirectory()) flags.push('--tmpfs', target);
      else flags.push('--ro-bind', '/dev/null', target);
    }
    if (profile.kind === 'mask') flags.push(...this.#hide(profile.hide ?? []));
    for (const exposed of profile.expose ?? []) {
      if (existsSync(exposed)) flags.push('--ro-bind', exposed, exposed);
    }
    return { file: 'bwrap', args: [...flags, '--', file, ...args], sandboxed: true };
  }

  /**
   * The flags that put nothing where the listed paths are. A directory gets an
   * empty file system mounted over it; a file gets an empty regular file bound
   * over it, read-only — a program that insists on reading its configuration
   * file then reads an empty one (the `/dev/null` that covers a protected file
   * cannot even be opened: device nodes are off in these mounts). Symbolic
   * links are followed first: bubblewrap cannot mount on one, and hiding the
   * real place hides it under every name.
   */
  #hide(paths: readonly string[]): string[] {
    const flags: string[] = [];
    let standIn: string | null = null;
    for (const listed of paths) {
      if (!path.isAbsolute(listed)) throw new Error(`Sandbox paths must be absolute, got "${listed}".`);
      const entry = statSync(listed, { throwIfNoEntry: false });
      if (!entry) continue;
      const target = realpathSync(listed);
      if (entry.isDirectory()) {
        flags.push('--tmpfs', target);
      } else {
        standIn ??= this.#emptyFile();
        flags.push('--ro-bind', standIn, target);
      }
    }
    // With nothing protected the stand-in lives in a temporary folder: keep at least this process out of it.
    if (standIn !== null && this.#scratch !== null && path.dirname(standIn) === this.#scratch) flags.push('--tmpfs', this.#scratch);
    return flags;
  }

  /**
   * An empty file to stand in for hidden ones. It is kept inside the first
   * protected directory, which every profile hides, so that no sandboxed
   * process — of this run or any other — can ever put text into it.
   */
  #emptyFile(): string {
    const home = this.#protected.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isDirectory());
    const directory = home === undefined ? (this.#scratch ??= mkdtempSync(path.join(os.tmpdir(), 'agent-studio-sandbox-'))) : path.join(home, 'sandbox');
    const file = path.join(directory, 'empty');
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing?.isFile() && existing.size === 0) return file;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, '', { mode: 0o444, flag: 'wx' });
    return file;
  }

  /** Builds the root of an `isolate` profile from nothing: only what is listed gets in. */
  #isolate(profile: Extract<SandboxProfile, { kind: 'isolate' }>): string[] {
    for (const target of [...profile.readable, ...profile.writable]) {
      if (!path.isAbsolute(target)) throw new Error(`Sandbox paths must be absolute, got "${target}".`);
      // A path *inside* protected data may be handed over on purpose (a plugin's
      // own folder); one that contains the protected data never may.
      if (this.#protected.some((secret) => contains(path.resolve(target), secret))) {
        throw new Error(`"${target}" would expose the server's own data to an isolated process.`);
      }
    }
    const flags: string[] = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try'];
    if (!profile.network) flags.push('--unshare-net');
    for (const directory of ISOLATE_SYSTEM_PATHS) {
      const entry = lstatSync(directory, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) flags.push('--symlink', readlinkSync(directory), directory);
      else if (entry?.isDirectory()) flags.push('--ro-bind', directory, directory);
    }
    if (profile.network) {
      for (const target of ISOLATE_NETWORK_PATHS) {
        if (existsSync(target)) flags.push('--ro-bind', target, target);
      }
    }
    flags.push('--dev', '/dev', '--proc', '/proc');
    for (const target of profile.readable) {
      if (existsSync(target)) flags.push('--ro-bind', target, target);
    }
    for (const target of profile.writable) {
      if (existsSync(target)) flags.push('--bind', target, target);
    }
    // The root and /dev are memory-backed: left writable they would be a way to exhaust RAM.
    flags.push('--remount-ro', '/dev', '--remount-ro', '/');
    return flags;
  }
}

export interface SpawnOptions {
  readonly cwd?: string;
  /** The complete environment. Build it with {@link ProcessSupervisor.env}. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: 'pipe' | 'ignore';
}

export interface RunOptions extends SpawnOptions {
  readonly timeoutMs?: number;
  /** Output beyond this is dropped and `truncated` is set. Default 1 MiB per stream. */
  readonly maxOutputBytes?: number;
  readonly input?: string | Buffer;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

function assertPlain(value: string, what: string): void {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`${what} is not a valid process argument.`);
  }
}

export class ProcessSupervisor {
  readonly #children = new Set<ChildProcess>();
  readonly #passthrough: readonly string[];

  constructor(passthrough: readonly string[] = []) {
    this.#passthrough = passthrough;
  }

  /** The scrubbed environment for a child, plus the variables the caller adds on purpose. */
  env(extra?: Readonly<Record<string, string | undefined>>): Record<string, string> {
    return buildChildEnv({ passthrough: this.#passthrough, ...(extra ? { extra } : {}) });
  }

  spawn(file: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
    assertPlain(file, 'The executable');
    for (const arg of args) assertPlain(arg, 'An argument');
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? this.env(),
      stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
      shell: false,
      // Own process group, so the whole tree can be signalled at once.
      detached: true,
      windowsHide: true,
    });
    this.#children.add(child);
    child.once('close', () => this.#children.delete(child));
    child.once('error', () => this.#children.delete(child));
    return child;
  }

  /** Runs a command to completion and collects bounded output. Never rejects for a non-zero exit. */
  run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const limit = options.maxOutputBytes ?? 1024 * 1024;
    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(file, args, { ...options, stdin: options.input === undefined ? 'ignore' : 'pipe' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;

      const collect = (chunks: Buffer[], size: () => number, add: (n: number) => void) => (chunk: Buffer) => {
        const room = limit - size();
        if (room <= 0) {
          truncated = true;
          return;
        }
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (slice.length < chunk.length) truncated = true;
        chunks.push(slice);
        add(slice.length);
      };
      child.stdout?.on('data', collect(out, () => outBytes, (n) => (outBytes += n)));
      child.stderr?.on('data', collect(err, () => errBytes, (n) => (errBytes += n)));

      const timer =
        options.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              terminate(child, 1500);
            }, options.timeoutMs);
      const onAbort = () => terminate(child, 1500);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();

      const finish = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', (error) => {
        finish();
        reject(error);
      });
      child.once('close', (code, signal) => {
        finish();
        resolve({
          code,
          signal,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          truncated,
          timedOut,
        });
      });
      if (options.input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
      }
    });
  }

  /** Stops every process this supervisor started. Called on shutdown. */
  async shutdown(graceMs = 2000): Promise<void> {
    const pending = [...this.#children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('close', () => resolve());
          terminate(child, graceMs);
        }),
    );
    await Promise.all(pending);
  }

  get running(): number {
    return this.#children.size;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Asks a process tree to stop, then forces it after `graceMs`. */
export function terminate(child: ChildProcess, graceMs = 3000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
