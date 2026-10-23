import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentStatus } from '@agent-studio/protocol';
import { describeError } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import { NOT_INSTALLED_MESSAGE, SIGN_IN_LAUNCHER, presentable } from './errors.js';

/**
 * Everything the adapter knows about the installed `claude` program without
 * starting a conversation: where it is, which version, which options it
 * understands, and whether it is signed in.
 *
 * All of it comes from the CLI's own commands — `--version`, `--help` and
 * `auth status --json` — run in the same scrubbed environment a turn runs in.
 * The Studio never opens the CLI's credential or settings files.
 */

/** Options every turn passes; a CLI whose help does not list them is too old to drive. */
const REQUIRED_OPTIONS = [
  '--print',
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--permission-mode',
  '--mcp-config',
  '--strict-mcp-config',
  '--setting-sources',
  '--resume',
  '--model',
  '--append-system-prompt',
  '--add-dir',
] as const;

/** Aliases the CLI resolves to the newest model of a family. Its help names further ones. */
const BASE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

export interface CliFeatures {
  readonly settings?: boolean;
  /** Values `--effort` accepts, weakest first; empty when the option does not exist. */
  readonly efforts: readonly string[];
  /** Model aliases: those the help text names, then the long-standing ones. */
  readonly modelAliases: readonly string[];
  /** `--replay-user-messages`: the CLI echoes what it takes from its input, which is what makes steering safe. */
  readonly replayUserMessages: boolean;
  /** `--forward-subagent-text`: a sub-agent's prose is printed too, not only its tool calls. */
  readonly forwardSubagentText: boolean;
  /** The name of the ordinary asking mode: `manual` in newer versions, `default` before. */
  readonly askingMode: 'manual' | 'default';
  /** Required options the help text does not mention. */
  readonly missing: readonly string[];
}

export interface AuthState {
  /** Null when the CLI gave no readable answer. */
  readonly signedIn: boolean | null;
  readonly account: string | null;
}

export interface CliInstallation {
  readonly executable: string;
  readonly version: string | null;
  readonly features: CliFeatures;
}

export const DEFAULT_FEATURES: CliFeatures = {
  efforts: [],
  modelAliases: [...BASE_MODEL_ALIASES],
  replayUserMessages: false,
  forwardSubagentText: false,
  askingMode: 'default',
  missing: [],
};

function isExecutableFile(file: string): boolean {
  try {
    const stats = statSync(file);
    return stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Finds a program the way a shell would, on the given search path only. */
export function findExecutable(name: string, searchPath: string | undefined): string | null {
  if (name === '' || name.includes('\0')) return null;
  if (name.includes('/')) return path.isAbsolute(name) && isExecutableFile(name) ? name : null;
  for (const directory of (searchPath ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** "2.1.283 (Claude Code)" → "2.1.283". */
export function parseVersion(output: string): string | null {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(output);
  return match ? match[1]! : null;
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** The help text of one option, from its name to the next option, on one line. */
function optionText(help: string, option: string): string | null {
  const lines = help.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s+(-\\w, )?${escapeRegExp(option)}(\\b|,|\\s|$)`).test(line),
  );
  if (start === -1) return null;
  const collected = [lines[start]!];
  for (let at = start + 1; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (/^\s{1,4}-{1,2}[A-Za-z]/.test(line) || /^\S/.test(line)) break;
    collected.push(line);
  }
  return collected.join(' ').replace(/\s+/g, ' ').trim();
}

export function parseHelp(help: string): CliFeatures {
  const has = (option: string): boolean =>
    new RegExp(`(^|[\\s,])${option}(?![\\w-])`, 'm').test(help);

  const effortText = optionText(help, '--effort');
  const effortList = effortText ? /\(([a-z]+(?:,\s*[a-z]+)+)\)/.exec(effortText) : null;
  const efforts = effortList ? effortList[1]!.split(',').map((level) => level.trim()) : [];

  const modelText = optionText(help, '--model') ?? '';
  const named = [...modelText.matchAll(/'([a-z][a-z0-9]*)'/g)].map((match) => match[1]!);
  const modelAliases = [...new Set([...named, ...BASE_MODEL_ALIASES])];

  const modeText = optionText(help, '--permission-mode') ?? '';
  return {
    ...(has('--settings') ? { settings: true } : {}),
    efforts,
    modelAliases,
    replayUserMessages: has('--replay-user-messages'),
    forwardSubagentText: has('--forward-subagent-text'),
    askingMode:
      /"manual"|\bmanual\b/.test(modeText) && !/"default"/.test(modeText) ? 'manual' : 'default',
    missing: REQUIRED_OPTIONS.filter((option) => !has(option)),
  };
}

/** Reads the answer of `claude auth status --json`. Only labels are taken from it, never a credential. */
export function parseAuthStatus(stdout: string): AuthState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { signedIn: null, account: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { signedIn: null, account: null };
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.loggedIn !== 'boolean') return { signedIn: null, account: null };
  if (!fields.loggedIn) return { signedIn: false, account: null };
  const label = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? presentable(value, 120) : null;
  const who = label(fields.email) ?? label(fields.orgName);
  const plan = label(fields.subscriptionType);
  const account = who ? (plan ? `${who} (${plan})` : who) : plan ? `Claude ${plan}` : null;
  return { signedIn: true, account };
}

export interface ClaudeCliOptions {
  /** The program to look for. Default `claude`. */
  readonly command?: string;
  /** How long a status answer is served without asking the CLI again. */
  readonly statusTtlMs?: number;
  /** How long a caller waits for the first status answer before it gets a provisional one. */
  readonly statusWaitMs?: number;
}

const STATUS_TTL_MS = 30_000;
/** A stale answer is still served (while a fresh one is fetched) up to this age. */
const STATUS_STALE_MS = 10 * 60_000;
/** How long a caller waits for the very first answer before it is told "still checking". */
const STATUS_WAIT_MS = 2_000;
const PROBE_TIMEOUT_MS = 20_000;

/** Variables that would change who the CLI is or make it think it runs inside another Claude Code session. */
const STRIPPED_ENV = /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_)/;
/** Where the CLI keeps its sign-in: an operator may point it elsewhere on purpose. */
const KEPT_ENV = new Set(['CLAUDE_CONFIG_DIR']);

export class ClaudeCli {
  readonly #context: ModuleContext;
  readonly #command: string;
  readonly #ttlMs: number;
  readonly #waitMs: number;
  #installation: {
    key: string;
    value: Promise<CliInstallation>;
    known: CliInstallation | null;
  } | null = null;
  #status: { at: number; value: AgentStatus } | null = null;
  #statusInFlight: Promise<AgentStatus> | null = null;

  constructor(context: ModuleContext, options: ClaudeCliOptions = {}) {
    this.#context = context;
    this.#command = options.command ?? 'claude';
    this.#ttlMs = options.statusTtlMs ?? STATUS_TTL_MS;
    this.#waitMs = options.statusWaitMs ?? STATUS_WAIT_MS;
  }

  /**
   * The environment the CLI runs in: the kernel's scrubbed one (nothing named
   * AGENT_STUDIO_*), minus anything an operator's pass-through list might add
   * that carries an API key or marks a surrounding Claude Code session. The
   * CLI uses its own sign-in.
   */
  env(): Record<string, string> {
    const env = this.#context.processes.env();
    for (const name of Object.keys(env)) {
      if (STRIPPED_ENV.test(name) && !KEPT_ENV.has(name)) delete env[name];
    }
    return env;
  }

  /** The executable on the scrubbed PATH, or null. */
  locate(): string | null {
    return findExecutable(this.#command, this.env().PATH);
  }

  async #run(
    executable: string,
    args: readonly string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const wrapped = this.#context.sandbox.wrap(executable, args, { kind: 'mask' });
    return this.#context.processes.run(wrapped.file, wrapped.args, {
      cwd: os.homedir(),
      env: this.env(),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
    });
  }

  /** Version and options of the installed CLI. Asked again only when the program file changes. */
  installation(): Promise<CliInstallation> | null {
    const executable = this.locate();
    if (!executable) {
      this.#installation = null;
      return null;
    }
    let key = executable;
    try {
      const stats = statSync(executable);
      key = `${executable}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      /* it was there a moment ago; the probe will say what is wrong */
    }
    if (this.#installation?.key === key) return this.#installation.value;
    const value = (async (): Promise<CliInstallation> => {
      // One after the other: on a small machine not even two short-lived copies of the CLI at once.
      const version = await this.#run(executable, ['--version']);
      const help = await this.#run(executable, ['--help']);
      return {
        executable,
        version: version.code === 0 ? parseVersion(version.stdout) : null,
        features:
          help.code === 0 && help.stdout.trim() !== '' ? parseHelp(help.stdout) : DEFAULT_FEATURES,
      };
    })();
    const entry: { key: string; value: Promise<CliInstallation>; known: CliInstallation | null } = {
      key,
      value,
      known: null,
    };
    this.#installation = entry;
    value.then(
      (installation) => {
        entry.known = installation;
      },
      () => {
        // A failed probe is not remembered.
        if (this.#installation === entry) this.#installation = null;
      },
    );
    return value;
  }

  async #probeStatus(): Promise<AgentStatus> {
    const pending = this.installation();
    if (!pending)
      return {
        installed: false,
        version: null,
        signedIn: false,
        account: null,
        problem: NOT_INSTALLED_MESSAGE,
      };
    let installation: CliInstallation;
    try {
      installation = await pending;
    } catch (error) {
      return {
        installed: true,
        version: null,
        signedIn: false,
        account: null,
        problem: `Claude Code could not be started: ${presentable(describeError(error), 200)}`,
      };
    }
    const { executable, version, features } = installation;
    if (features.missing.length > 0) {
      return {
        installed: true,
        version,
        signedIn: false,
        account: null,
        problem: `The installed Claude Code${version ? ` (${version})` : ''} is too old for the Studio: it lacks ${features.missing.slice(0, 3).join(', ')}. Update Claude Code.`,
      };
    }
    let auth: AuthState = { signedIn: null, account: null };
    try {
      // Signed out, the command still prints its JSON answer and exits with 1.
      const answer = await this.#run(executable, ['auth', 'status', '--json']);
      if (!answer.timedOut) auth = parseAuthStatus(answer.stdout);
    } catch (error) {
      this.#context.log.debug(
        { err: presentable(describeError(error), 200) },
        'asking Claude Code for its sign-in status failed',
      );
    }
    if (auth.signedIn === true)
      return { installed: true, version, signedIn: true, account: auth.account, problem: null };
    if (auth.signedIn === false) {
      return {
        installed: true,
        version,
        signedIn: false,
        account: null,
        problem: `Claude Code is not signed in on this computer. Open the terminal and start "Claude Code sign-in" (launcher ${SIGN_IN_LAUNCHER}).`,
      };
    }
    // The schema has no "unknown": say so in words instead of guessing.
    return {
      installed: true,
      version,
      signedIn: false,
      account: null,
      problem: `It is not known whether Claude Code is signed in: "claude auth status" gave no readable answer. If a message fails, sign in from the terminal ("Claude Code sign-in", launcher ${SIGN_IN_LAUNCHER}).`,
    };
  }

  #refreshStatus(): Promise<AgentStatus> {
    this.#statusInFlight ??= this.#probeStatus()
      .then((value) => {
        this.#status = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#statusInFlight = null;
      });
    return this.#statusInFlight;
  }

  /**
   * Installed? which version? signed in? Asking the CLI can take seconds (its
   * status command starts the whole program), and this is called for every
   * list of agents a browser loads. So: an answer is kept for a short while;
   * one that has just gone stale is still served while a new one is fetched;
   * and a caller that would have to wait long for the very first answer is
   * told that the check is still going on, rather than made to wait.
   */
  async status(): Promise<AgentStatus> {
    const cached = this.#status;
    const age = cached ? Date.now() - cached.at : Infinity;
    // A program that appeared or vanished changes the answer at once.
    const installed = this.locate() !== null;
    if (cached && cached.value.installed === installed) {
      if (age < this.#ttlMs) return cached.value;
      if (age < STATUS_STALE_MS) {
        void this.#refreshStatus().catch(() => {});
        return cached.value;
      }
    }
    const fresh = this.#refreshStatus();
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.#waitMs);
      timer.unref();
    });
    try {
      const answer = await Promise.race([fresh, waited]);
      if (answer !== null) return answer;
    } finally {
      clearTimeout(timer);
    }
    fresh.catch(() => {});
    return {
      installed: true,
      version: this.#installation?.known?.version ?? null,
      signedIn: false,
      account: null,
      problem: 'Still checking whether Claude Code is signed in. Look again in a moment.',
    };
  }

  /** The status as soon as the CLI has really answered, however long that takes. For the sign-in flow and tests. */
  settledStatus(): Promise<AgentStatus> {
    return this.#statusInFlight ?? this.#refreshStatus();
  }

  /** What a turn just revealed about the sign-in, so the next status does not contradict it. */
  noteSignIn(signedIn: boolean): void {
    if (!this.#status || this.#status.value.signedIn === signedIn) return;
    this.#status = null;
  }

  /** Forget what was cached (used after the sign-in terminal closes, and by tests). */
  forget(): void {
    this.#status = null;
    this.#installation = null;
  }
}
