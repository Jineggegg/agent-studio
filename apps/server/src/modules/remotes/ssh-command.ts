import { createHash } from 'node:crypto';
import { REMOTE_HOST_ID_PATTERN, REMOTE_TOOLS, type RemoteProgram, isSafeRemoteDirectory } from '@agent-studio/protocol';
import { type RemoteHostConfig, isSafeHostname, isSafeLocalPath, isSafePort, isSafeUser } from './hosts-file.js';

/**
 * Everything that decides how the SSH client is invoked, as pure functions.
 *
 * ## Decisions
 *
 * - **`-F none`.** No SSH configuration file is read, neither the account's
 *   `~/.ssh/config` nor the system-wide one. The operator's hosts file is then
 *   the complete description of a connection: a `ProxyCommand`, `LocalCommand`,
 *   `RemoteCommand`, `Match exec` or forwarding placed in some SSH config by
 *   another program (or another user of the account) can never run as a side
 *   effect of the Studio connecting. The price is that SSH aliases are not
 *   understood; hosts are named by host name, and a bastion is expressed with
 *   `jumpHost`.
 * - **Never interactive at the SSH level** (`BatchMode=yes`, public-key
 *   authentication only), in the status check and in terminal sessions alike.
 *   A password, passphrase or host-key question would otherwise be put to
 *   whoever is looking at the browser; here it fails with a clear message
 *   instead, and the operator fixes the key set-up on the server.
 * - **Host keys are never accepted blindly.** `StrictHostKeyChecking=yes` by
 *   default (the key must already be in the account's `known_hosts`); an
 *   operator may choose `accept-new` per host, which records a first key and
 *   still refuses a changed one. `no` cannot be configured.
 * - **No forwarding of any kind** (agent, X11, ports, tunnels), no local
 *   commands, no connection sharing.
 * - **A jump host is reached with an explicit `ProxyCommand`**, not `-J`:
 *   options given on the command line do not apply to the jump leg of `-J`,
 *   so that leg would fall back to interactive defaults. The proxy command is
 *   a second `ssh -W` carrying the same fixed options for the jump host. SSH
 *   hands that string to a shell, so every word in it must be made of
 *   characters no shell gives a meaning to; the builder refuses anything else.
 * - **`--` precedes the destination**, and every configured value travels as
 *   the argument of its own flag, so no value can be read as an option.
 */

export interface SshInvocation {
  /** `probe`: run the fixed status check, no terminal. `session`: an interactive session in a terminal. */
  readonly mode: 'probe' | 'session';
  readonly host: RemoteHostConfig;
  /** The entry named by `host.jumpHost`, when there is one. */
  readonly jump: RemoteHostConfig | null;
  /** One line for the remote shell; build it with {@link probeCommand} or {@link sessionCommand}. */
  readonly remoteCommand: string;
  readonly connectTimeoutSeconds: number;
  /** Absolute path of the SSH client, used for the jump leg. */
  readonly sshProgram: string;
}

/** A word that means only itself to every common shell. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9._/@:+=,-]+$/;

function assertSafeHost(host: RemoteHostConfig, what: string): void {
  const ok =
    REMOTE_HOST_ID_PATTERN.test(host.id) &&
    isSafeHostname(host.hostname) &&
    (host.user === null || isSafeUser(host.user)) &&
    isSafePort(host.port) &&
    (host.identityFile === null || isSafeLocalPath(host.identityFile)) &&
    (host.hostKeyChecking === 'strict' || host.hostKeyChecking === 'accept-new');
  // The hosts file is validated when it is read. This is the second lock on the same door.
  if (!ok) throw new Error(`The configuration of ${what} is not safe to pass to the SSH client.`);
}

/** Options shared by every connection the Studio makes, to a host or to a jump host. */
function fixedOptions(host: RemoteHostConfig, connectTimeoutSeconds: number): string[] {
  return [
    'BatchMode=yes',
    `ConnectTimeout=${connectTimeoutSeconds}`,
    'ConnectionAttempts=1',
    `StrictHostKeyChecking=${host.hostKeyChecking === 'accept-new' ? 'accept-new' : 'yes'}`,
    'UpdateHostKeys=no',
    'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no',
    'PreferredAuthentications=publickey',
    'ForwardAgent=no',
    'ForwardX11=no',
    'Tunnel=no',
    'PermitLocalCommand=no',
    'ControlMaster=no',
    'ControlPath=none',
    ...(host.identityFile === null ? [] : ['IdentitiesOnly=yes']),
  ];
}

function destinationFlags(host: RemoteHostConfig): string[] {
  return [...(host.identityFile === null ? [] : ['-i', host.identityFile]), '-p', String(host.port), ...(host.user === null ? [] : ['-l', host.user])];
}

/** The command SSH runs to reach `host` through `jump`: a second, equally locked-down SSH client. */
function proxyCommand(jump: RemoteHostConfig, connectTimeoutSeconds: number, sshProgram: string): string {
  const words = [sshProgram, '-F', 'none'];
  for (const option of [...fixedOptions(jump, connectTimeoutSeconds), 'LogLevel=ERROR', 'ProxyCommand=none']) words.push('-o', option);
  words.push(...destinationFlags(jump));
  for (const word of words) {
    if (!SHELL_SAFE_WORD.test(word)) throw new Error('A jump host needs an SSH client path and settings without special characters.');
  }
  // %h and %p are filled in by the outer client; the quotes keep the brackets
  // from being read as a pattern. Quoted the way OpenSSH itself writes it.
  return [...words, '-W', "'[%h]:%p'", '--', jump.hostname].join(' ');
}

/**
 * The complete argument list for the SSH client. Nothing in it comes from a
 * browser except, inside `remoteCommand`, a directory that has been validated
 * and quoted (see {@link sessionCommand}).
 */
export function buildSshArgs(invocation: SshInvocation): string[] {
  const { host, jump, mode, remoteCommand } = invocation;
  const timeout = invocation.connectTimeoutSeconds;
  assertSafeHost(host, 'the remote host');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new Error('The connection time limit is out of range.');
  if (remoteCommand.length === 0 || /[\0\r\n]/.test(remoteCommand)) throw new Error('The remote command must be a single line.');
  if ((host.jumpHost === null) !== (jump === null) || (jump !== null && jump.id !== host.jumpHost)) {
    throw new Error('The jump host does not match the configuration of the remote host.');
  }
  if (jump !== null) {
    assertSafeHost(jump, 'the jump host');
    if (jump.jumpHost !== null) throw new Error('A jump host cannot itself be reached through a jump host.');
  }

  const options = [
    ...fixedOptions(host, timeout),
    'ClearAllForwardings=yes',
    `ProxyCommand=${jump === null ? 'none' : proxyCommand(jump, timeout, invocation.sshProgram)}`,
    ...(mode === 'session'
      ? // A terminal: ask for one remotely, pass every byte through, notice a dead link.
        ['RequestTTY=yes', 'EscapeChar=none', 'ServerAliveInterval=30', 'ServerAliveCountMax=3']
      : ['RequestTTY=no', 'LogLevel=ERROR']),
  ];

  const args = ['-F', 'none'];
  for (const option of options) args.push('-o', option);
  args.push(...destinationFlags(host));
  if (mode === 'probe') args.push('-n');
  // Everything after "--" is the destination and the command, whatever it looks like.
  args.push('--', host.hostname, remoteCommand);
  return args;
}

// ---- what runs on the remote side ----------------------------------------------

/**
 * Quotes one value for a POSIX shell so that it arrives as exactly one
 * argument with exactly these bytes: wrapped in single quotes, with every
 * single quote inside written as `'\''`. Nothing is special between single
 * quotes — not `$`, not a backtick, not a backslash, not a line break.
 */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A NUL byte cannot be passed to a shell.');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The single line handed to the remote login shell: run `script` with a
 * POSIX `sh`, with `args` as its positional parameters. Values are passed as
 * parameters and never pasted into the script, so they cannot become syntax.
 */
export function remoteShellCommand(script: string, args: readonly string[]): string {
  return ['exec', 'sh', '-c', shellQuote(script), 'agent-studio', ...args.map(shellQuote)].join(' ');
}

// The scripts are fixed text. They are written on one line without single
// quotes, backslashes or exclamation marks, so that the remote account's login
// shell — whichever it is — has nothing to interpret before `sh` takes over.

/** Places an agent CLI or tmux is commonly installed that a non-interactive shell does not have on its PATH. */
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; export PATH';

export const PROBE_MARKER = 'agent-studio-probe-1';
export const PROBE_END_MARKER = 'agent-studio-probe-end';

export const PROBE_SCRIPT = [
  REMOTE_PATH,
  `echo ${PROBE_MARKER}`,
  `for tool in ${REMOTE_TOOLS.join(' ')}; do if command -v "$tool" >/dev/null 2>&1; then echo "tool $tool yes"; else echo "tool $tool no"; fi; done`,
  `echo ${PROBE_END_MARKER}`,
].join('; ');

/**
 * Parameters: $1 directory (empty: stay in the home directory), $2 tmux
 * session name, $3 program (shell, claude, codex), $4 a tag for the Studio
 * user.
 *
 * With tmux the session is created or, if it already exists, re-attached, so
 * work survives a disconnect. An agent CLI gets a configuration directory of
 * its own, so signing in through the Studio never touches the login the
 * owner of the remote account uses there.
 */
export const SESSION_SCRIPT = [
  REMOTE_PATH,
  'if [ -n "$1" ]; then cd -- "$1" || { echo "agent-studio: cannot open the directory $1 on this host" >&2; exit 66; }; fi',
  [
    'case "$3" in',
    'shell) program= ;;',
    'claude|codex) program=$(command -v "$3") || { echo "agent-studio: $3 is not installed on this host" >&2; exit 127; };',
    'config="$HOME/.agent-studio-remote/$4/$3";',
    'mkdir -p "$config" && chmod 700 "$HOME/.agent-studio-remote" "$HOME/.agent-studio-remote/$4" "$config" || { echo "agent-studio: cannot prepare $config" >&2; exit 73; } ;;',
    '*) echo "agent-studio: unknown program" >&2; exit 64 ;;',
    'esac',
  ].join(' '),
  [
    'if command -v tmux >/dev/null 2>&1; then case "$3" in',
    'shell) exec tmux new-session -A -s "$2" ;;',
    'claude) exec tmux new-session -A -s "$2" env "CLAUDE_CONFIG_DIR=$config" "$program" ;;',
    'codex) exec tmux new-session -A -s "$2" env "CODEX_HOME=$config" "$program" ;;',
    'esac; fi',
  ].join(' '),
  'echo "agent-studio: tmux is not installed on this host, so this session ends when you disconnect" >&2',
  [
    'case "$3" in',
    'shell) exec "${SHELL:-/bin/sh}" -l ;;',
    'claude) CLAUDE_CONFIG_DIR="$config"; export CLAUDE_CONFIG_DIR; exec "$program" ;;',
    'codex) CODEX_HOME="$config"; export CODEX_HOME; exec "$program" ;;',
    'esac',
  ].join(' '),
].join('; ');

export function probeCommand(): string {
  return remoteShellCommand(PROBE_SCRIPT, []);
}

const TMUX_NAME = /^[a-z0-9-]{1,64}$/;
const USER_TAG = /^[a-z0-9]{1,32}$/;
const PROGRAMS: readonly RemoteProgram[] = ['shell', 'claude', 'codex'];

export interface RemoteSessionRequest {
  readonly program: RemoteProgram;
  /** The one value a client influences. Validated here again, then quoted, then passed as a parameter. */
  readonly directory: string | null;
  readonly sessionName: string;
  readonly userTag: string;
}

export function sessionCommand(request: RemoteSessionRequest): string {
  if (!PROGRAMS.includes(request.program)) throw new Error('That program cannot be started on a remote host.');
  if (request.directory !== null && !isSafeRemoteDirectory(request.directory)) throw new Error('That remote directory is not acceptable.');
  if (!TMUX_NAME.test(request.sessionName) || !USER_TAG.test(request.userTag)) throw new Error('The remote session name is not acceptable.');
  return remoteShellCommand(SESSION_SCRIPT, [request.directory ?? '', request.sessionName, request.program, request.userTag]);
}

const digest = (...parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex');

/**
 * The tmux session a user returns to: the same user, program and directory
 * always give the same name, and the name is never taken from a client.
 */
export function deriveSessionName(userId: string, program: RemoteProgram, directory: string | null): string {
  return `studio-${program}-${digest(userId, program, directory ?? '~').slice(0, 12)}`;
}

/** Separates the agent sign-ins of different Studio users on one remote account. */
export function deriveUserTag(userId: string): string {
  return `u${digest('user', userId).slice(0, 12)}`;
}
