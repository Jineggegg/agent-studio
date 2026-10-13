import { constants, promises as fs } from 'node:fs';
import { REMOTE_TOOLS, type RemoteFailureCode, type RemoteHostStatus, type RemoteTools } from '@agent-studio/protocol';
import type { RunOptions, RunResult } from '../../kernel/process.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { RemoteHostConfig } from './hosts-file.js';
import { PROBE_END_MARKER, PROBE_MARKER, buildSshArgs, probeCommand } from './ssh-command.js';

/**
 * The status check of a remote host: one non-interactive SSH connection that
 * runs a fixed command and reports whether the host answered, how long it
 * took and which tools it has.
 *
 * A screen that polls must not be able to multiply logins on somebody's
 * machine, so results are cached, simultaneous requests for one host share a
 * single connection, an explicit re-check is honoured at most every few
 * seconds, and only a handful of checks run at once.
 */

export interface ProbeSettings {
  /** How long a result is served without connecting again. */
  readonly cacheMs: number;
  /** An explicit re-check within this time of the last one is answered from the cache. */
  readonly minIntervalMs: number;
  /** Hard limit for the whole check. */
  readonly timeoutMs: number;
  /** Limit for establishing the connection (passed to the SSH client). */
  readonly connectTimeoutSeconds: number;
  /** Checks running at the same time, across all hosts. */
  readonly maxConcurrent: number;
}

export const DEFAULT_PROBE_SETTINGS: ProbeSettings = {
  cacheMs: 60_000,
  minIntervalMs: 5_000,
  timeoutMs: 12_000,
  connectTimeoutSeconds: 6,
  maxConcurrent: 4,
};

export interface ProbeDeps {
  run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** The environment the SSH client gets. */
  environment(): Record<string, string>;
  /** Absolute path of the SSH client for that environment, or null when there is none. */
  findSsh(environment: Readonly<Record<string, string>>): string | null;
}

type Failure = NonNullable<RemoteHostStatus['failure']>;
type Result = Omit<RemoteHostStatus, 'cached'>;

const MESSAGES: Record<Exclude<RemoteFailureCode, 'ssh_failed'>, string> = {
  ssh_missing: 'No SSH client is installed on this computer.',
  identity_unreadable: 'The key file configured for this host cannot be read.',
  timeout: 'The connection timed out.',
  auth_failed: 'Authentication failed: the host did not accept the key.',
  host_key_failed: 'Host key verification failed: the host key is unknown or has changed.',
  dns_failed: 'The host name cannot be resolved.',
  connection_refused: 'The connection was refused.',
  network_unreachable: 'The network of the host is unreachable.',
  unexpected_output: 'The host answered, but the check did not run as expected.',
};

const known = (code: Exclude<RemoteFailureCode, 'ssh_failed'>): Failure => ({ code, message: MESSAGES[code] });

/**
 * The key files a connection needs, if they are not all readable: the first
 * that is not. The SSH client would only warn about a missing key and quietly
 * try the account's default keys instead, which is not what was configured.
 */
export async function unreadableIdentity(host: RemoteHostConfig, jump: RemoteHostConfig | null): Promise<string | null> {
  for (const identity of [host.identityFile, jump?.identityFile ?? null]) {
    if (identity === null) continue;
    const readable = await fs.access(identity, constants.R_OK).then(
      () => true,
      () => false,
    );
    if (!readable) return identity;
  }
  return null;
}

export const IDENTITY_UNREADABLE_MESSAGE = MESSAGES.identity_unreadable;

/** One short, safe line out of whatever the SSH client printed. */
function lastLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim())
    .filter((line) => line.length > 0);
  const line = redactSecrets(lines[lines.length - 1] ?? '');
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Maps the outcome of a failed SSH run to a stable reason. Raw multi-line output never leaves this function. */
export function classifyFailure(result: Pick<RunResult, 'code' | 'stderr' | 'timedOut'>): Failure {
  if (result.timedOut) return known('timeout');
  const text = result.stderr.toLowerCase();
  if (/host key verification failed|remote host identification has changed|no \S+ host key is known/.test(text)) return known('host_key_failed');
  if (/permission denied|too many authentication failures|no supported authentication methods|no such identity/.test(text)) return known('auth_failed');
  if (/could not resolve hostname|name or service not known|nodename nor servname|temporary failure in name resolution/.test(text)) return known('dns_failed');
  if (text.includes('connection refused')) return known('connection_refused');
  if (/network is unreachable|no route to host/.test(text)) return known('network_unreachable');
  if (/timed out|timeout/.test(text)) return known('timeout');
  const detail = lastLine(result.stderr);
  return { code: 'ssh_failed', message: detail ? `SSH failed: ${detail}` : 'SSH failed.' };
}

/** Reads the answer of the fixed check. Null unless it is complete and well-formed. */
export function parseProbeOutput(stdout: string): RemoteTools | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const begin = lines.indexOf(PROBE_MARKER);
  const end = lines.indexOf(PROBE_END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;
  const found = new Map<string, boolean>();
  for (const line of lines.slice(begin + 1, end)) {
    const match = /^tool ([a-z]+) (yes|no)$/.exec(line);
    if (match) found.set(match[1]!, match[2] === 'yes');
  }
  if (!REMOTE_TOOLS.every((tool) => found.has(tool))) return null;
  return { tmux: found.get('tmux')!, git: found.get('git')!, claude: found.get('claude')!, codex: found.get('codex')! };
}

interface CacheEntry {
  readonly fingerprint: string;
  readonly startedAt: number;
  readonly result: Result;
}

export class RemoteProber {
  readonly #deps: ProbeDeps;
  readonly #settings: ProbeSettings;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, { fingerprint: string; promise: Promise<Result> }>();
  readonly #waiting: Array<() => void> = [];
  #running = 0;
  /** How many SSH connections were actually started. For tests and diagnostics. */
  connections = 0;

  constructor(deps: ProbeDeps, settings: Partial<ProbeSettings> = {}) {
    this.#deps = deps;
    this.#settings = { ...DEFAULT_PROBE_SETTINGS, ...settings };
  }

  async status(host: RemoteHostConfig, jump: RemoteHostConfig | null, options: { refresh?: boolean } = {}): Promise<RemoteHostStatus> {
    // A changed configuration is a different host as far as the cache is concerned.
    const fingerprint = JSON.stringify([host, jump]);
    const cached = this.#cache.get(host.id);
    if (cached && cached.fingerprint === fingerprint) {
      const age = Date.now() - cached.startedAt;
      if (age < (options.refresh ? this.#settings.minIntervalMs : this.#settings.cacheMs)) return { ...cached.result, cached: true };
    }
    const flying = this.#inFlight.get(host.id);
    if (flying && flying.fingerprint === fingerprint) return { ...(await flying.promise), cached: false };

    const startedAt = Date.now();
    const promise = this.#limited(() => this.#probe(host, jump))
      .then((result) => {
        this.#cache.set(host.id, { fingerprint, startedAt, result });
        return result;
      })
      .finally(() => {
        if (this.#inFlight.get(host.id)?.promise === promise) this.#inFlight.delete(host.id);
      });
    this.#inFlight.set(host.id, { fingerprint, promise });
    return { ...(await promise), cached: false };
  }

  /** Forgets results of hosts that are no longer configured. */
  retain(hostIds: ReadonlySet<string>): void {
    for (const id of this.#cache.keys()) if (!hostIds.has(id)) this.#cache.delete(id);
  }

  async #limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#settings.maxConcurrent) await new Promise<void>((resume) => this.#waiting.push(resume));
    else this.#running += 1;
    try {
      return await work();
    } finally {
      // The slot passes straight to the next in line, so a newcomer cannot slip in between.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }

  async #probe(host: RemoteHostConfig, jump: RemoteHostConfig | null): Promise<Result> {
    const checkedAt = Date.now();
    const unreachable = (failure: Failure): Result => ({ hostId: host.id, reachable: false, latencyMs: null, checkedAt, tools: null, failure });

    const environment = this.#deps.environment();
    const ssh = this.#deps.findSsh(environment);
    if (!ssh) return unreachable(known('ssh_missing'));
    if ((await unreadableIdentity(host, jump)) !== null) return unreachable(known('identity_unreadable'));

    let args: string[];
    try {
      args = buildSshArgs({
        mode: 'probe',
        host,
        jump,
        remoteCommand: probeCommand(),
        connectTimeoutSeconds: this.#settings.connectTimeoutSeconds,
        sshProgram: ssh,
      });
    } catch {
      return unreachable({ code: 'ssh_failed', message: 'SSH failed: this host cannot be reached with its current configuration.' });
    }

    let result: RunResult;
    this.connections += 1;
    try {
      result = await this.#deps.run(ssh, args, { env: environment, cwd: '/', timeoutMs: this.#settings.timeoutMs, maxOutputBytes: 16 * 1024 });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return unreachable(missing ? known('ssh_missing') : { code: 'ssh_failed', message: 'SSH failed: the SSH client could not be started.' });
    }
    const latencyMs = Math.max(0, Date.now() - checkedAt);

    // 255 is the SSH client's own failure; any other status came from the remote side.
    if (result.timedOut || result.code === null || result.code === 255) return unreachable(classifyFailure(result));
    const tools = result.code === 0 ? parseProbeOutput(result.stdout) : null;
    if (!tools) return { hostId: host.id, reachable: true, latencyMs, checkedAt, tools: null, failure: known('unexpected_output') };
    return { hostId: host.id, reachable: true, latencyMs, checkedAt, tools, failure: null };
  }
}
