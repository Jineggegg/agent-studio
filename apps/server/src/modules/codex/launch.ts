import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProcessSupervisor, Sandbox } from '../../kernel/process.js';
import type { BridgeConnection } from '../agents/adapter.js';
import { configOverride, tomlArray, tomlBoolean, tomlInlineTable, tomlString } from './toml.js';

/**
 * How a Codex process is started: its environment, its arguments, and what it
 * is allowed to see.
 *
 * ## Keeping the user's own Codex settings out of a Studio run
 *
 * `codex exec` has `--ignore-user-config` and `--ignore-rules`; the app-server
 * (codex-cli 0.160.0) has neither, and it matters: with the real CLI,
 *
 * - a line in `~/.codex/rules/*.rules` such as
 *   `prefix_rule(pattern=["touch"], decision="allow")` makes that command run
 *   outside Codex's sandbox with no approval request at all, under every
 *   approval policy;
 * - `config.toml` can name MCP servers (started and offered to the model),
 *   mark the project trusted (which loads the project's own `.codex/` config,
 *   rules and hooks), pre-approve MCP tools, add writable roots, and hand
 *   approvals to an automatic reviewer;
 * - `-c` overrides are merged into the user's tables, not put in their place,
 *   so they cannot remove what is there.
 *
 * So the Studio does not rely on overriding. There are two levels:
 *
 * **hidden** — when the Studio's sandbox (bubblewrap) works. Inside the
 * kernel's `mask` profile the adapter adds one more bubblewrap layer in which
 * `config.toml` and `hooks.json` of the Codex home are an empty file and
 * `rules/` is an empty directory. The CLI then runs exactly as with
 * `--ignore-user-config --ignore-rules`: no personal configuration, no saved
 * rules, no trusted project, so no project `.codex/` layer either. The
 * sign-in, the conversations and the rest of the Codex home are untouched,
 * and nothing in it is read, copied or changed by the Studio.
 *
 * **pinned** — without a sandbox nothing can be hidden. The adapter then
 * overrides what can be overridden (below), switches off by name every MCP
 * server the configuration defines, checks the result through the CLI's own
 * `config/read`, and refuses to run when the Codex home has command rules,
 * because those cannot be overridden. The user's other personal settings
 * (model provider, instructions, …) apply in that case.
 *
 * At both levels every thread and turn is started with an explicit approval
 * policy, reviewer and sandbox, and the CLI's answer is checked against them.
 */

export type IsolationLevel = 'hidden' | 'pinned';

export interface CodexCommand {
  readonly file: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly isolation: IsolationLevel;
  /** Where this process will keep its configuration and conversations. */
  readonly codexHome: string;
}

/** Variables that would sign Codex in with a key or point it at another service. Codex uses its own sign-in. */
const CODEX_VARIABLES_KEPT = new Set(['CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_CA_CERTIFICATE']);

export function isModelCredentialVariable(name: string): boolean {
  if (CODEX_VARIABLES_KEPT.has(name)) return false;
  return /^(OPENAI|AZURE_OPENAI|CODEX)_/i.test(name) || /_API_KEY$/i.test(name);
}

/** Files of the Codex home that carry the user's own configuration. */
const HIDDEN_FILES = ['config.toml', 'hooks.json'] as const;
const RULES_DIRECTORY = 'rules';

const BRIDGE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** `dir` and every directory above it, nearest first. */
function withAncestors(dir: string): string[] {
  const all: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    all.push(current);
    const parent = path.dirname(current);
    if (parent === current) return all;
    current = parent;
  }
}

export interface AppServerOptions {
  /** The Studio's MCP bridge for this run; null for a process that runs no turn. */
  readonly bridge: BridgeConnection | null;
  readonly cwd: string | null;
  /** MCP servers of the user's own configuration to switch off by name (pinned level only). */
  readonly disableMcpServers?: readonly string[];
}

/**
 * The arguments of `codex app-server`. Everything is a `-c` override for this
 * one process; nothing is written to the user's configuration.
 */
export function appServerArguments(options: AppServerOptions): string[] {
  const args = ['app-server'];
  const set = (key: string, value: string): void => {
    args.push(...configOverride(key, value));
  };

  // No hooks (a `PermissionRequest` hook could answer an approval before the Studio sees it),
  // no ChatGPT apps and no plugins (both bring tools the Studio's engine would not be asked about).
  set('features.hooks', tomlBoolean(false));
  set('features.apps', tomlBoolean(false));
  set('features.plugins', tomlBoolean(false));
  // Commands the model runs do not inherit variables that look like credentials — the run's bridge token among them.
  set('shell_environment_policy.ignore_default_excludes', tomlBoolean(false));

  // An untrusted project loads no `.codex/` configuration, rules or hooks of its own. Trust is
  // looked up for the project root, which is the working directory or one of the folders above it.
  if (options.cwd !== null) {
    const untrusted = tomlInlineTable([['trust_level', tomlString('untrusted')]]);
    set('projects', tomlInlineTable(withAncestors(options.cwd).map((dir) => [dir, untrusted] as const)));
  }

  const bridge = options.bridge;
  // Overrides are applied in order, each one *setting* the value at its key: a whole `mcp_servers`
  // table written after the bridge's keys would wipe the bridge out (seen with codex-cli 0.160.0).
  // So the table that switches the user's servers off comes first, and the bridge is added to it.
  const disabled = (options.disableMcpServers ?? []).filter((name) => name !== bridge?.serverName);
  if (disabled.length > 0) {
    const off = tomlInlineTable([['enabled', tomlBoolean(false)]]);
    set('mcp_servers', tomlInlineTable(disabled.map((name) => [name, off] as const)));
  }
  if (bridge) {
    if (!BRIDGE_NAME.test(bridge.serverName)) throw new Error('The bridge has a name Codex cannot register.');
    const key = `mcp_servers.${bridge.serverName}`;
    set(`${key}.command`, tomlString(bridge.command));
    set(`${key}.args`, tomlArray(bridge.args));
    // The bridge's variables — the run's token among them — are not written here, where the process
    // list would show them: they are in this process's environment, and Codex forwards the named ones.
    set(`${key}.env_vars`, tomlArray(Object.keys(bridge.env)));
    // The Studio's own tools are decided by the Studio's engine when the bridge calls back, so Codex
    // need not ask a second time; and the tool that answers Claude Code's permission prompts is not for Codex.
    set(`${key}.default_tools_approval_mode`, tomlString('approve'));
    set(`${key}.disabled_tools`, tomlArray([bridge.permissionPromptTool]));
  }
  return args;
}

/** True when a rules file holds anything but comments and blank lines. */
function hasRules(file: string): boolean {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .some((line) => {
        const text = line.trim();
        return text !== '' && !text.startsWith('#');
      });
  } catch {
    // Unreadable is not the same as empty: assume there is something in it.
    return true;
  }
}

/** The command-rule files in a Codex home that would pre-approve or change what Codex may run. */
export function savedRuleFiles(codexHome: string): string[] {
  const directory = path.join(codexHome, RULES_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.rules'))
    .map((name) => path.join(directory, name))
    .filter(hasRules);
}

export class CodexLauncher {
  readonly #processes: ProcessSupervisor;
  readonly #sandbox: Sandbox;
  readonly #emptyFile: string;

  constructor(input: { processes: ProcessSupervisor; sandbox: Sandbox; dataDir: string }) {
    this.#processes = input.processes;
    this.#sandbox = input.sandbox;
    // Inside the data directory, which agents can neither read nor write: what stands in for the
    // user's configuration must be something no earlier command could have put text into.
    this.#emptyFile = path.join(input.dataDir, 'codex', 'empty');
  }

  /** What isolation a process started now would get. */
  get isolation(): IsolationLevel {
    return this.#sandbox.status.mode === 'bwrap' ? 'hidden' : 'pinned';
  }

  /**
   * The environment of a Codex process: the kernel's allow-listed one, without
   * anything that would sign Codex in with a key from the server's
   * environment, plus what the caller adds on purpose.
   */
  environment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const env = this.#processes.env();
    for (const name of Object.keys(env)) {
      if (isModelCredentialVariable(name)) delete env[name];
    }
    for (const [name, value] of Object.entries(extra)) {
      if (name.startsWith('AGENT_STUDIO_')) throw new Error(`${name} must not be given to a child process.`);
      env[name] = value;
    }
    // The error stream is only ever read by a program.
    env.NO_COLOR = '1';
    return env;
  }

  /** The Codex home of the processes this launcher starts. */
  get codexHome(): string {
    return CodexLauncher.codexHome(this.environment());
  }

  /** The Codex home a process with this environment uses. */
  static codexHome(env: Readonly<Record<string, string>>): string {
    const explicit = env.CODEX_HOME;
    if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit);
    return path.join(env.HOME ?? os.homedir(), '.codex');
  }

  /**
   * `codex <args>`, sandboxed and isolated as far as this machine allows.
   * `expose` lists files inside the Studio's data directory the process must
   * be able to read (attachments).
   */
  command(args: readonly string[], options: { env?: Readonly<Record<string, string>>; expose?: readonly string[] } = {}): CodexCommand {
    const env = this.environment(options.env);
    const codexHome = CodexLauncher.codexHome(env);
    if (this.#sandbox.status.mode !== 'bwrap') {
      return { file: 'codex', args: [...args], env, isolation: 'pinned', codexHome };
    }
    const hide = this.#hideFlags(codexHome);
    const inner = hide.length === 0 ? { file: 'codex', args: [...args] } : { file: 'bwrap', args: ['--die-with-parent', '--bind', '/', '/', '--dev-bind', '/dev', '/dev', ...hide, '--', 'codex', ...args] };
    const wrapped = this.#sandbox.wrap(inner.file, inner.args, { kind: 'mask', expose: [...(hide.length === 0 ? [] : [this.#emptyFile]), ...(options.expose ?? [])] });
    return { file: wrapped.file, args: wrapped.args, env, isolation: 'hidden', codexHome };
  }

  /** bubblewrap flags that put nothing where the user's Codex configuration is. Only what exists is covered. */
  #hideFlags(codexHome: string): string[] {
    const flags: string[] = [];
    for (const name of HIDDEN_FILES) {
      const target = path.join(codexHome, name);
      if (statSync(target, { throwIfNoEntry: false })?.isFile()) flags.push('--ro-bind', this.#emptyFile, target);
    }
    const rules = path.join(codexHome, RULES_DIRECTORY);
    if (statSync(rules, { throwIfNoEntry: false })?.isDirectory()) flags.push('--tmpfs', rules);
    if (flags.includes(this.#emptyFile)) this.#ensureEmptyFile();
    return flags;
  }

  #ensureEmptyFile(): void {
    const existing = statSync(this.#emptyFile, { throwIfNoEntry: false });
    if (existing?.isFile() && existing.size === 0) return;
    mkdirSync(path.dirname(this.#emptyFile), { recursive: true, mode: 0o700 });
    if (existing) chmodSync(this.#emptyFile, 0o600);
    writeFileSync(this.#emptyFile, '', { mode: 0o444 });
    chmodSync(this.#emptyFile, 0o444);
  }
}
