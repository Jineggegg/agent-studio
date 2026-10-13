import { TERMINAL_LAUNCHERS, terminalLauncherKeySchema } from '@agent-studio/protocol';
import type { Principal } from '../../kernel/principal.js';
import type { SandboxProfile } from '../../kernel/process.js';
import type { ProjectRecord } from '../projects/projects.service.js';
import { findExecutable } from './login-shell.js';

/**
 * Launchers: the only programs other than the login shell that a terminal may
 * start. Each one is defined on the server and chosen by its key; a client
 * never names a program, an argument or an environment variable.
 *
 * Other modules add their own with `context.services.terminal.registerLauncher`
 * (from `setup` when they are listed after the terminal module, otherwise
 * from `start`).
 */

export interface LaunchInput {
  readonly user: Principal;
  /** The project the session belongs to, already access-checked. Null only for launchers that allow it. */
  readonly project: ProjectRecord | null;
  /** Present exactly when the launcher declares `remote: true`. Both values have been validated. */
  readonly remote: { readonly hostId: string; readonly directory: string | null } | null;
}

export interface LaunchPlan {
  /** A program name to find on the terminal's PATH, or an absolute path. */
  readonly file: string;
  readonly args: readonly string[];
  /** Added to the scrubbed terminal environment. Names starting with AGENT_STUDIO_ are refused. */
  readonly env?: Readonly<Record<string, string>>;
  /** `project` (the default when there is one) or `neutral`: the account's home directory. */
  readonly cwd?: 'project' | 'neutral';
  /** Default title of the session. */
  readonly title?: string;
  /** Wraps the program in the kernel sandbox, where one is available. */
  readonly sandbox?: SandboxProfile;
  /** For sessions that run elsewhere: recorded with the session and in the audit log. */
  readonly remoteHostId?: string;
  readonly remoteDirectory?: string | null;
}

export interface TerminalLauncher {
  readonly key: string;
  /** English label. */
  readonly title: string;
  readonly kind: 'agent-sign-in' | 'remote' | 'other';
  /** May be started without a project; it then starts in the account's home directory. */
  readonly projectOptional?: boolean;
  /** Takes a remote host id and directory from the request. */
  readonly remote?: boolean;
  /** Decides what to run. Throw a `StudioError` to refuse. */
  plan(input: LaunchInput): LaunchPlan | Promise<LaunchPlan>;
  /** Why this cannot be started here, or null. Must be cheap: it is asked for every capability report. */
  unavailableReason?(environment: Readonly<Record<string, string>>): string | null;
}

/** A launcher that runs one fixed program with fixed arguments. */
export function programLauncher(definition: {
  key: string;
  title: string;
  kind: TerminalLauncher['kind'];
  program: string;
  args: readonly string[];
  projectOptional?: boolean;
  sandbox?: SandboxProfile;
}): TerminalLauncher {
  return {
    key: definition.key,
    title: definition.title,
    kind: definition.kind,
    ...(definition.projectOptional ? { projectOptional: true } : {}),
    plan: () => ({
      file: definition.program,
      args: definition.args,
      title: definition.title,
      ...(definition.sandbox ? { sandbox: definition.sandbox } : {}),
    }),
    unavailableReason: (environment) =>
      findExecutable(definition.program, environment.PATH) === null ? `The ${definition.program} command is not installed on this computer.` : null,
  };
}

/**
 * Sign-in commands of the supported agent CLIs, as their own `--help` gives
 * them. They run inside the same sandbox profile as the agents themselves, so
 * the Studio's data directory is hidden from them, and they may be opened
 * before any project exists (first-run onboarding).
 */
export const BUILT_IN_LAUNCHERS: readonly TerminalLauncher[] = [
  programLauncher({
    key: TERMINAL_LAUNCHERS.claudeLogin,
    title: 'Claude Code sign-in',
    kind: 'agent-sign-in',
    program: 'claude',
    args: ['auth', 'login'],
    projectOptional: true,
    sandbox: { kind: 'mask' },
  }),
  programLauncher({
    key: TERMINAL_LAUNCHERS.codexLogin,
    title: 'Codex sign-in',
    kind: 'agent-sign-in',
    program: 'codex',
    args: ['login'],
    projectOptional: true,
    sandbox: { kind: 'mask' },
  }),
  programLauncher({
    key: TERMINAL_LAUNCHERS.codexLoginDevice,
    title: 'Codex sign-in with a device code',
    kind: 'agent-sign-in',
    program: 'codex',
    args: ['login', '--device-auth'],
    projectOptional: true,
    sandbox: { kind: 'mask' },
  }),
];

export class LauncherRegistry {
  readonly #launchers = new Map<string, TerminalLauncher>();

  constructor(initial: readonly TerminalLauncher[] = BUILT_IN_LAUNCHERS) {
    for (const launcher of initial) this.register(launcher);
  }

  /** Adds a launcher. An existing key is an error unless `replace` says the caller means it. */
  register(launcher: TerminalLauncher, options: { replace?: boolean } = {}): void {
    if (!terminalLauncherKeySchema.safeParse(launcher.key).success) {
      throw new Error(`"${launcher.key}" is not a valid launcher key.`);
    }
    if (this.#launchers.has(launcher.key) && !options.replace) {
      throw new Error(`Terminal launcher "${launcher.key}" is already registered.`);
    }
    this.#launchers.set(launcher.key, launcher);
  }

  get(key: string): TerminalLauncher | null {
    return this.#launchers.get(key) ?? null;
  }

  list(): TerminalLauncher[] {
    return [...this.#launchers.values()];
  }
}
