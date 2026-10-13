import path from 'node:path';
import { unavailable } from '../../kernel/errors.js';
import type { ProcessSupervisor, RunResult } from '../../kernel/process.js';

/**
 * How this server runs git.
 *
 * A repository is data that agents, archives and clones put on disk, and a
 * repository's own configuration can name programs for git to run. So there
 * are two ways of calling git here, and every call picks one on purpose:
 *
 * - `query` — reading (status, diff, log, branches …). Nothing the repository
 *   controls may run: hooks are pointed at nothing, the file-system monitor,
 *   external diff and text-conversion programs, signature checking, content
 *   filters defined in the repository, credential helpers, the ssh command and
 *   every network transport are switched off, and git is told not to take the
 *   optional locks a read would otherwise use to tidy the index.
 *
 * - `act` — something the user asked for by name (commit, switch, merge,
 *   fetch, push …). These behave as git does in a terminal, hooks included,
 *   because a commit that silently skipped the project's hooks would be a lie.
 *   What stays off even here: prompts of any kind, editors, pagers, the
 *   file-system monitor and the `ext::` transport.
 *
 * Arguments are always an array (no shell), the environment is the kernel's
 * scrubbed one, messages are forced to plain English so that failures can be
 * recognised, and every call has a time limit.
 */

export interface GitCallOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly input?: string | Buffer;
  readonly signal?: AbortSignal;
  /** Extra environment, e.g. the commit identity. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface GitQueryOptions extends GitCallOptions {
  /**
   * The command reads file contents from the work tree (status, diff against
   * the folder). Content filters configured in the repository are neutralised
   * for it.
   */
  readonly readsWorktree?: boolean;
  /**
   * Leave path arguments in git's default mode. Only for the one command that
   * refuses the literal mode (`check-ignore`), whose arguments are plain paths anyway.
   */
  readonly plainPathspecs?: boolean;
}

export interface GitTimeouts {
  /** Local reads. */
  query: number;
  /** Local changes (commit hooks can be slow). */
  act: number;
  /** Anything that talks to a remote. */
  network: number;
  /** A whole clone. */
  clone: number;
}

export const DEFAULT_GIT_TIMEOUTS: Readonly<GitTimeouts> = { query: 20_000, act: 60_000, network: 60_000, clone: 15 * 60_000 };

/** Options that come before the subcommand on every call. */
const ALWAYS = [
  '--no-pager',
  '--literal-pathspecs',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotePath=false',
  '-c', 'color.ui=never',
  '-c', 'core.editor=true',
  '-c', 'protocol.ext.allow=never',
  '-c', 'advice.detachedHead=false',
] as const;

const QUERY_ONLY = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.sshCommand=false',
  '-c', 'core.askPass=',
  '-c', 'credential.helper=',
  '-c', 'log.showSignature=false',
  '-c', 'submodule.recurse=false',
  '-c', 'status.submoduleSummary=false',
  '-c', 'diff.ignoreSubmodules=dirty',
  '-c', 'fetch.recurseSubmodules=false',
] as const;

const ALWAYS_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_LITERAL_PATHSPECS: '1',
  // Never wait for a passphrase or host-key answer nobody can give.
  SSH_ASKPASS_REQUIRE: 'never',
  // Plain English messages, so failures can be told apart; UTF-8 so names survive.
  LC_ALL: 'C.UTF-8',
  LANGUAGE: 'C',
} as const;

const REFUSED_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_EXTERNAL_DIFF',
  'GIT_CURL_VERBOSE',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
]);

const QUERY_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  // An allow-list that names no real transport: a read never goes to the network.
  GIT_ALLOW_PROTOCOL: 'none',
} as const;

export class GitExec {
  readonly #processes: ProcessSupervisor;
  readonly timeouts: GitTimeouts;

  constructor(processes: ProcessSupervisor, timeouts: GitTimeouts = { ...DEFAULT_GIT_TIMEOUTS }) {
    this.#processes = processes;
    this.timeouts = timeouts;
  }

  /** The environment for a git child: the kernel's scrubbed baseline plus the switches above. */
  env(cwd: string | null, extra: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
    const env = this.#processes.env({
      ...ALWAYS_ENV,
      // Never wander upwards into a repository that merely contains the folder.
      ...(cwd === null ? {} : { GIT_CEILING_DIRECTORIES: path.dirname(cwd) }),
    });
    // Should an operator have let any of these through to child processes, they stop here:
    // they would point git at another repository, run a program, or dump credentials into its output.
    for (const name of Object.keys(env)) {
      if (REFUSED_ENV.has(name) || name.startsWith('GIT_TRACE') || name.startsWith('GIT_CONFIG_KEY_') || name.startsWith('GIT_CONFIG_VALUE_')) delete env[name];
    }
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    return env;
  }

  async #run(cwd: string | null, args: readonly string[], env: Record<string, string>, options: GitCallOptions, timeoutMs: number): Promise<RunResult> {
    try {
      return await this.#processes.run('git', args, {
        ...(cwd === null ? {} : { cwd }),
        env,
        timeoutMs: options.timeoutMs ?? timeoutMs,
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Either git is missing or the folder is: tell them apart for the caller.
        throw unavailable('Git is not installed on the server, or the project folder is gone.', 'git_unavailable');
      }
      throw error;
    }
  }

  /**
   * Like {@link query}, but allowed to look above the folder for an enclosing
   * repository. Used only to tell "not a repository" from "inside a larger one".
   */
  discover(cwd: string, args: readonly string[], options: GitCallOptions = {}): Promise<RunResult> {
    const env = this.env(null, { ...QUERY_ENV, ...options.env });
    return this.#run(cwd, [...ALWAYS, ...QUERY_ONLY, ...args], env, options, this.timeouts.query);
  }

  /** A read. Runs nothing the repository controls and changes nothing. */
  async query(cwd: string, args: readonly string[], options: GitQueryOptions = {}): Promise<RunResult> {
    const neutralised = options.readsWorktree ? await this.#filterOverrides(cwd) : {};
    const literal = options.plainPathspecs ? { GIT_LITERAL_PATHSPECS: undefined } : {};
    const env = this.env(cwd, { ...QUERY_ENV, ...neutralised, ...literal, ...options.env });
    const always = options.plainPathspecs ? ALWAYS.filter((argument) => argument !== '--literal-pathspecs') : ALWAYS;
    return this.#run(cwd, [...always, ...QUERY_ONLY, ...args], env, options, this.timeouts.query);
  }

  /** A local change the user asked for. Hooks and repository configuration apply, as in a terminal. */
  act(cwd: string, args: readonly string[], options: GitCallOptions = {}): Promise<RunResult> {
    return this.#run(cwd, [...ALWAYS, ...args], this.env(cwd, options.env), options, this.timeouts.act);
  }

  /** Fetch, pull, push: an action that talks to the repository's configured remote. */
  network(cwd: string, args: readonly string[], options: GitCallOptions = {}): Promise<RunResult> {
    return this.#run(cwd, [...ALWAYS, ...args], this.env(cwd, options.env), options, this.timeouts.network);
  }

  /** Arguments and environment for a clone, which runs outside any repository and is streamed by the caller. */
  cloneInvocation(url: string, target: string): { args: string[]; env: Record<string, string> } {
    return {
      args: [...ALWAYS, '-c', 'core.hooksPath=/dev/null', 'clone', '--progress', '--no-recurse-submodules', '--', url, target],
      // Belt and braces with the address check: git itself refuses every transport but these two.
      env: this.env(null, { GIT_ALLOW_PROTOCOL: 'https:ssh' }),
    };
  }

  /**
   * Content filters (`filter.<name>.clean` and friends) are programs. Those
   * defined in the user's or the system's configuration are theirs to trust;
   * those defined inside the repository are not, so for reads they are
   * overridden with nothing. The overrides travel in the environment rather
   * than as `-c` options so that no driver name, however odd, can dodge them.
   */
  async #filterOverrides(cwd: string): Promise<Record<string, string>> {
    const listing = await this.#run(
      cwd,
      [...ALWAYS, ...QUERY_ONLY, 'config', '--show-scope', '--includes', '--name-only', '-z', '--get-regexp', '^filter\\..+\\.(clean|smudge|process)$'],
      this.env(cwd, QUERY_ENV),
      {},
      this.timeouts.query,
    );
    if (listing.code !== 0) return {};
    const fields = listing.stdout.split('\0');
    const drivers = new Set<string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const scope = fields[i]!;
      const key = fields[i + 1]!;
      if (scope !== 'local' && scope !== 'worktree') continue;
      const name = key.slice('filter.'.length, key.lastIndexOf('.'));
      if (name.length > 0) drivers.add(name);
    }
    const env: Record<string, string> = {};
    let count = 0;
    const set = (key: string, value: string) => {
      env[`GIT_CONFIG_KEY_${count}`] = key;
      env[`GIT_CONFIG_VALUE_${count}`] = value;
      count += 1;
    };
    for (const name of drivers) {
      set(`filter.${name}.clean`, '');
      set(`filter.${name}.smudge`, '');
      set(`filter.${name}.process`, '');
      set(`filter.${name}.required`, 'false');
    }
    if (count > 0) env.GIT_CONFIG_COUNT = String(count);
    return env;
  }
}
