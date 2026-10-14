import path from 'node:path';
import type { PermissionMode, RiskCategory, RiskClass, RuleEffect, RuleScope, ToolKind } from '@agent-studio/protocol';
import { isInside } from '../../kernel/paths.js';
import type { Role } from '../../kernel/principal.js';
import { type ShellCommand, type ShellWord, commandText, parseShell } from './shell.js';

/**
 * The permission engine: one pure function that decides what happens to a
 * tool request — allow, deny, or ask a human — from the request itself, the
 * session's permission mode, the rules that apply, and a few facts about the
 * project. It has no side effects and reads no files (a caller may hand it a
 * `realpath` function so symbolic links are followed).
 *
 * Order of evaluation ({@link evaluatePermission}):
 *
 *  1. The hard-deny list — the Studio's own data directory, wiping the file
 *     system root or a home directory, writing to a raw disk, a fork bomb —
 *     is refused in every mode.
 *  2. A matching `deny` rule refuses. Deny rules always win.
 *  3. `plan` mode refuses everything that is not a read or a search.
 *  4. A matching `ask` rule asks.
 *  5. A request the risk classifier calls dangerous asks, even when an allow
 *     rule matches — in every mode except `auto`.
 *  6. `auto` (only where the project has it enabled; otherwise the session
 *     behaves as `ask`) allows.
 *  7. Reads and searches inside the project are allowed; in `accept-edits`
 *     so are file edits inside the project.
 *  8. A matching `allow` rule allows — for a command line only when every
 *     part of it is covered and nothing about it was unclear.
 *  9. Everything else asks. Unknown tools ask. When unsure, ask.
 */

export interface ToolRequest {
  /** The tool's name as the agent calls it; rules match on it. */
  readonly toolName: string;
  readonly kind: ToolKind;
  /** The exact command line, for tools that run one. */
  readonly command?: string | null;
  /** Files or folders the tool reads or changes, absolute or relative to the project. */
  readonly paths?: readonly string[];
  /** The address, for tools that fetch from the network. */
  readonly url?: string | null;
}

export interface EngineRule {
  readonly id: string;
  readonly scope: RuleScope;
  readonly effect: RuleEffect;
  /** Tool name; `*` matches any run of characters. */
  readonly tool: string;
  /** Glob over the command, path or address; null matches every use of the tool. */
  readonly pattern: string | null;
}

export interface PermissionEnvironment {
  /** The project's working directory (a real, absolute path), or null for a session outside any project. */
  readonly projectDir: string | null;
  /** The owner has enabled the `auto` mode for this project. */
  readonly autoEnabled: boolean;
  readonly studioDataDir: string;
  readonly homeDir: string;
  /**
   * Follows symbolic links (resolving the deepest existing ancestor of a path
   * that does not exist yet). Without it paths are compared as written.
   */
  readonly realpath?: (absolute: string) => string;
}

export interface PermissionInput {
  readonly request: ToolRequest;
  readonly mode: PermissionMode;
  /** Only the rules that apply to this run. */
  readonly rules: readonly EngineRule[];
  readonly env: PermissionEnvironment;
}

export interface PermissionOutcome {
  readonly decision: 'allow' | 'deny' | 'ask';
  /** Stable and machine-readable: `hard_deny`, `deny_rule`, `plan_mode`, `ask_rule`, `dangerous`, `mode_auto`, `read_in_project`, `edit_in_project`, `allow_rule`, `unknown_tool`, `unsure`, `needs_approval`. */
  readonly code: string;
  /** One sentence a person can read. */
  readonly reason: string;
  readonly risk: RiskClass;
  readonly categories: RiskCategory[];
  /** `auto` falls back to `ask` where the project has not enabled it. */
  readonly effectiveMode: PermissionMode;
  /** The rule that decided, if one did. */
  readonly ruleId: string | null;
}

export function effectiveMode(mode: PermissionMode, autoEnabled: boolean): PermissionMode {
  return mode === 'auto' && !autoEnabled ? 'ask' : mode;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pathGlobSource(pattern: string): string {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[i + 1]!);
      i += 1;
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(c);
    }
  }
  return source;
}

type GlobToken = { readonly kind: 'literal'; readonly char: string } | { readonly kind: 'one' } | { readonly kind: 'many' };

function textGlobTokens(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      tokens.push({ kind: 'literal', char: pattern[i + 1]! });
      i += 1;
    } else if (c === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'many') tokens.push({ kind: 'many' });
    } else if (c === '?') {
      tokens.push({ kind: 'one' });
    } else {
      tokens.push({ kind: 'literal', char: c });
    }
  }
  return tokens;
}

/** Wildcard matching without backtracking blow-up, so a hostile pattern or command cannot stall the server. */
function matchTokens(tokens: readonly GlobToken[], text: string): boolean {
  let t = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (token && (token.kind === 'one' || (token.kind === 'literal' && token.char === text[t]))) {
      t += 1;
      p += 1;
    } else if (token?.kind === 'many') {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (tokens[p]?.kind === 'many') p += 1;
  return p === tokens.length;
}

/** `*` matches any run of characters; a trailing ` *` also matches nothing at all. */
export function matchesTextGlob(pattern: string, text: string): boolean {
  const tokens = textGlobTokens(pattern);
  if (matchTokens(tokens, text)) return true;
  const n = tokens.length;
  const last = tokens[n - 1];
  const beforeLast = tokens[n - 2];
  if (n >= 3 && last?.kind === 'many' && beforeLast?.kind === 'literal' && beforeLast.char === ' ') {
    return matchTokens(tokens.slice(0, -2), text);
  }
  return false;
}

/** `*` stays within a path segment, `**` crosses segments. */
export function matchesPathGlob(pattern: string, target: string): boolean {
  if (target.length > 8192) return false;
  return new RegExp(`^${pathGlobSource(pattern)}$`, 's').test(target);
}

const hasWildcard = (pattern: string): boolean => /(^|[^\\])[*?]/.test(pattern);

/** Escapes a literal so it can be stored as a pattern that matches only itself. */
export function escapeGlob(text: string): string {
  return text.replace(/[\\*?]/g, '\\$&');
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === segment;
  // A shell wildcard does not match a leading dot unless the pattern spells it out.
  if (segment.startsWith('.') && !pattern.startsWith('.')) return false;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
      } else {
        const body = pattern.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/^!/, '^');
        source += `[${body}]`;
        i = end;
      }
    } else source += escapeRegExp(c);
  }
  try {
    return new RegExp(`^${source}$`, 's').test(segment);
  } catch {
    return true; // an unreadable pattern could match anything
  }
}

type Relation = 'no' | 'ancestor' | 'equal' | 'inside';

/** How a path — possibly containing shell wildcards — relates to a target: could it name the target, something in it, or a folder above it? */
function relate(candidate: string, target: string): Relation {
  const a = candidate.split('/').filter(Boolean);
  const b = target.split('/').filter(Boolean);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] === '**') return 'inside';
    if (!segmentMatches(a[i]!, b[i]!)) return 'no';
  }
  if (a.length === b.length) return 'equal';
  return a.length > b.length ? 'inside' : 'ancestor';
}

// ---------------------------------------------------------------------------
// What is sensitive
// ---------------------------------------------------------------------------

/** Relative to a home directory. */
const HOME_CREDENTIALS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.config/gh',
  '.config/gcloud',
  '.config/op',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.claude/.credentials.json',
  '.claude.json',
  '.codex/auth.json',
  '.vault-token',
  '.password-store',
  '.local/share/keyrings',
  '.terraform.d/credentials.tfrc.json',
];
const SYSTEM_CREDENTIALS = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/sudoers.d', '/etc/ssh', '/root', '/proc/self/environ'];
const PRIVATE_KEY_NAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'];
const ENV_FILE = /^\.env(\.(?!(?:example|sample|template|dist|defaults)$)[\w.-]+)?$/i;

/** Folders whose recursive removal is never legitimate. */
const SYSTEM_ROOTS = ['/', '/home', '/Users', '/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/opt', '/root', '/sys', '/proc', '/dev', '/System', '/Library', '/Applications'];
/** A repository's own files that make git run programs: `.git/` (hooks, config), `.gitattributes` (filters), `.gitmodules`. */
const GIT_INTERNALS = /(?:^|\/)\.git(?:\/|$)|\/\.git(?:attributes|modules)$/;
/** Git settings whose value is a program, or that pull in more settings. */
const GIT_PROGRAM_SETTING =
  /^(?:core\.(?:sshcommand|fsmonitor|pager|editor|hookspath|askpass|gitproxy)|alias\.|credential\.|diff\.external|diff\.[^.=]+\.(?:textconv|command)|filter\.|merge\.[^.=]+\.driver|protocol\.ext|remote\.[^.=]+\.(?:uploadpack|receivepack)|gpg\.(?:[^.=]+\.)?program|sequence\.editor|uploadpack\.packobjectshook|include\.|includeif\.)/i;
const BLOCK_DEVICE = /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d|rdisk\d|dm-\d|md\d|loop\d|mapper\/)/;
const HARMLESS_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty', '/dev/zero']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh']);
const OTHER_INTERPRETERS = new Set(['python', 'perl', 'ruby', 'node', 'nodejs', 'deno', 'bun', 'php', 'lua', 'pwsh', 'powershell', 'osascript', 'rscript', 'tclsh', 'groovy']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'http', 'https', 'lwp-download', 'lwp-request', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'tftp']);
const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas', 'sudoedit', 'setcap', 'visudo', 'usermod', 'useradd', 'adduser', 'passwd', 'chpasswd']);
const DISK_TOOLS = new Set(['dd', 'mkfs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'gparted', 'gdisk', 'sgdisk', 'wipefs', 'blkdiscard', 'mkswap', 'diskutil', 'diskpart', 'format']);
/** Programs that run another command given as their arguments. */
const WRAPPERS = new Set(['env', 'nohup', 'time', 'command', 'builtin', 'exec', 'setsid', 'ionice', 'chrt', 'stdbuf', 'nice', 'timeout', 'watch', 'busybox', 'caffeinate', 'unbuffer', 'xargs', 'sudo', 'doas', 'pkexec']);
const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  chrt: ['-p'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k'],
  watch: ['-n', '-d'],
  xargs: ['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a'],
};
const RESERVED = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'coproc']);
const INERT = new Set(['for', 'select', 'done', 'fi', 'esac', 'in', 'function']);
/** Programs that only read, used to decide whether running in a folder outside the project matters. */
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'echo', 'printf', 'wc', 'stat', 'file', 'du', 'df', 'tree', 'which', 'type', 'test', '[', 'true', 'false', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut', 'less', 'more', 'diff', 'cd', 'pushd', 'popd']);
/** Programs that read whole trees, so a home directory or `/` as an argument reaches credentials. */
const BULK_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'tar', 'zip', '7z', 'rsync', 'scp', 'cp', 'du']);
const HIJACK_VARIABLES = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'IFS', 'PROMPT_COMMAND', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF']);
/** Programs whose first argument is a sub-command worth keeping in a remembered rule. */
const SUBCOMMAND_PROGRAMS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'pip', 'pip3', 'poetry', 'uv', 'make', 'dotnet', 'gradle', 'mvn', 'brew', 'apt', 'apt-get', 'systemctl', 'terraform', 'deno', 'composer', 'bundle', 'rake', 'swift', 'flutter', 'helm']);

/** Sub-commands that themselves take a sub-command or a script name. */
const TWO_LEVEL_COMMANDS: Record<string, readonly string[]> = {
  npm: ['run', 'run-script', 'exec'],
  pnpm: ['run', 'exec', 'dlx'],
  yarn: ['run', 'workspace'],
  bun: ['run', 'x'],
  docker: ['compose', 'buildx', 'image', 'container', 'volume', 'network'],
  gh: ['pr', 'issue', 'repo', 'run', 'workflow', 'release', 'api'],
  git: ['stash', 'remote', 'submodule', 'worktree', 'config', 'bisect'],
  go: ['mod', 'tool'],
  uv: ['pip', 'tool'],
  cargo: ['run'],
  kubectl: ['get', 'describe', 'rollout'],
  deno: ['task', 'run'],
  composer: ['run-script'],
  bundle: ['exec'],
};

const programName = (text: string): string => {
  const base = text.slice(text.lastIndexOf('/') + 1).toLowerCase().replace(/\.exe$/, '');
  if (/^python[0-9.]*$/.test(base)) return 'python';
  if (/^mkfs\./.test(base)) return 'mkfs';
  return base;
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface CommandPart {
  /** The command with its variable assignments, quotes removed. */
  readonly text: string;
  /** The same command in the other ways it can be written — without assignments, without wrappers such as `sudo` or `env`, with the program's bare name — so deny rules see through them. */
  readonly peeled: string[];
  /** May an allow rule cover it? Not when it writes a file by redirection, or only wraps other parts. */
  allowable: boolean;
  /** `bash -c "…"` and the like: covered when the commands inside are. */
  container: boolean;
  redirectsToFile: boolean;
}

export interface Classification {
  readonly categories: RiskCategory[];
  /** One sentence per danger found. */
  readonly findings: string[];
  /** Set when the request is on the hard-deny list. */
  readonly hardDeny: string | null;
  /** Why the request could not be read with confidence. */
  readonly unsure: string[];
  /** Every file the request names resolved inside the project. */
  readonly insideProject: boolean;
  readonly parts: readonly CommandPart[];
  /** The request's files as rules see them: relative to the project when inside it, absolute otherwise. */
  readonly ruleTargets: readonly string[];
}

interface Resolved {
  /** Candidate absolute paths (one per directory the command could be running in). Empty when unknown. */
  readonly candidates: string[];
  readonly unknown: boolean;
}

class Classifier {
  readonly categories = new Set<RiskCategory>();
  readonly findings: string[] = [];
  readonly unsure: string[] = [];
  readonly parts: CommandPart[] = [];
  hardDeny: string | null = null;
  /** Directories the command line could be running in at this point; null is "somewhere unknown". */
  #cwds: Array<string | null>;
  #downloaderSeen = false;
  readonly #env: PermissionEnvironment;
  readonly #credentials: string[];

  constructor(env: PermissionEnvironment) {
    this.#env = env;
    this.#cwds = [env.projectDir];
    this.#credentials = [...HOME_CREDENTIALS.map((relative) => path.join(env.homeDir, relative)), ...SYSTEM_CREDENTIALS];
  }

  flag(category: RiskCategory, finding: string): void {
    this.categories.add(category);
    if (!this.findings.includes(finding)) this.findings.push(finding);
  }

  #deny(reason: string, category: RiskCategory): void {
    this.hardDeny ??= reason;
    this.categories.add(category);
  }

  #doubt(reason: string): void {
    if (!this.unsure.includes(reason)) this.unsure.push(reason);
  }

  // ---- paths ---------------------------------------------------------------

  #real(absolute: string): string {
    if (!this.#env.realpath || /[*?[]/.test(absolute)) return absolute;
    try {
      return this.#env.realpath(absolute);
    } catch {
      return absolute;
    }
  }

  /** Turns a word into the absolute paths it could name. */
  resolveWord(word: ShellWord, extraCwds?: Array<string | null>): Resolved {
    if (word.substitution || word.brace) return { candidates: [], unknown: true };
    let text = word.text;
    for (const name of word.variables) {
      if (name !== 'HOME' && name !== 'PWD') return { candidates: [], unknown: true };
    }
    if (word.variables.includes('HOME')) text = text.replaceAll('${HOME}', this.#env.homeDir).replaceAll('$HOME', this.#env.homeDir);
    if (word.variables.includes('PWD')) text = text.replaceAll('${PWD}', '.').replaceAll('$PWD', '.');
    if (word.tilde) {
      if (text === '~' || text.startsWith('~/')) text = this.#env.homeDir + text.slice(1);
      else return { candidates: [], unknown: true };
    }
    return this.resolveText(text, extraCwds);
  }

  resolveText(written: string, extraCwds?: Array<string | null>): Resolved {
    if (written === '' || written.includes('\0')) return { candidates: [], unknown: true };
    // Programs often expand a leading "~" themselves (--file=~/x), so it is always read as the home directory.
    const text = written === '~' || written.startsWith('~/') ? this.#env.homeDir + written.slice(1) : written;
    if (path.isAbsolute(text)) return { candidates: [this.#real(path.resolve(text))], unknown: false };
    const candidates: string[] = [];
    let unknown = false;
    for (const cwd of extraCwds ?? this.#cwds) {
      if (cwd === null) unknown = true;
      else candidates.push(this.#real(path.resolve(cwd, text)));
    }
    return { candidates: [...new Set(candidates)], unknown };
  }

  /** The directory part of a path up to its first wildcard: `src/*.ts` → `src`. */
  static literalPrefix(absolute: string): string {
    const segments = absolute.split('/');
    const firstGlob = segments.findIndex((segment) => /[*?[]/.test(segment));
    return firstGlob === -1 ? absolute : segments.slice(0, firstGlob).join('/') || '/';
  }

  isInsideProject(resolved: Resolved): boolean {
    const project = this.#env.projectDir;
    if (project === null || resolved.unknown || resolved.candidates.length === 0) return false;
    return resolved.candidates.every((candidate) => isInside(project, Classifier.literalPrefix(candidate)));
  }

  /** Checks that apply to every path a request names, whatever is done with it. */
  inspectPath(resolved: Resolved, shown: string): void {
    for (const candidate of resolved.candidates) {
      const data = relate(candidate, this.#env.studioDataDir);
      if (data === 'equal' || data === 'inside') {
        this.#deny(`${shown} is inside the Studio's own data directory, which agents may never touch.`, 'studio-data');
      }
      for (const location of this.#credentials) {
        const relation = relate(candidate, location);
        if (relation === 'equal' || relation === 'inside') {
          this.flag('credentials', `${shown} is a place where credentials are kept.`);
        }
      }
      const name = candidate.slice(candidate.lastIndexOf('/') + 1);
      const couldBe = (target: string): boolean => segmentMatches(name, target);
      if (ENV_FILE.test(name) || (/[*?[]/.test(name) && couldBe('.env'))) {
        this.flag('credentials', `${shown} is an environment file that usually holds secrets.`);
      }
      if (PRIVATE_KEY_NAMES.includes(name) || (name.startsWith('id_') && PRIVATE_KEY_NAMES.some((key) => couldBe(key)))) {
        this.flag('credentials', `${shown} looks like a private key.`);
      }
    }
  }

  /** A path that is written, created or removed. */
  inspectWrite(resolved: Resolved, shown: string): void {
    this.inspectPath(resolved, shown);
    for (const candidate of resolved.candidates) {
      if (BLOCK_DEVICE.test(candidate)) this.#deny(`${shown} is a raw disk; writing to it destroys what is on it.`, 'catastrophic');
      // Hooks, filters and other programs named in a repository's own files run
      // later, when someone uses git on it — including the Git panel, outside
      // the agent's sandbox.
      if (GIT_INTERNALS.test(candidate)) {
        this.flag('privilege', `${shown} is part of git's own configuration; programs named there run whenever git is used on the repository.`);
      }
    }
    if (resolved.candidates.length > 0 && resolved.candidates.every((candidate) => HARMLESS_DEVICES.has(candidate) || candidate.startsWith('/dev/fd/'))) {
      return;
    }
    if (!this.isInsideProject(resolved)) {
      this.flag('outside-project', resolved.unknown ? `It is not clear where ${shown} points, so it may change files outside the project.` : `${shown} is outside the project folder.`);
    }
  }

  #isWipeTarget(resolved: Resolved): boolean {
    const roots = [...SYSTEM_ROOTS, this.#env.homeDir];
    return resolved.candidates.some((candidate) => {
      if (roots.some((root) => relate(candidate, root) === 'equal')) return true;
      // "~/*" or "/*": everything in a root.
      const parent = candidate.slice(0, candidate.lastIndexOf('/')) || '/';
      const last = candidate.slice(candidate.lastIndexOf('/') + 1);
      return /^[*.?[\]!{},]*\*[*.?[\]!{},]*$/.test(last) && (parent === '/' || parent === this.#env.homeDir);
    });
  }

  // ---- command lines -------------------------------------------------------

  commandLine(source: string, origin: ShellCommand['origin'] = 'top', depth = 0): CommandPart[] {
    if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/.test(source)) {
      this.#deny('This is a fork bomb: it starts copies of itself until the machine stops responding.', 'catastrophic');
    }
    const parsed = parseShell(source, origin);
    for (const reason of parsed.uncertain) this.#doubt(`The command could not be read with confidence: ${reason}.`);
    const created: CommandPart[] = [];
    for (const command of parsed.commands) created.push(this.#command(command, depth));
    return created;
  }

  #command(command: ShellCommand, depth: number): CommandPart {
    const part: CommandPart = {
      text: commandText(command),
      peeled: [],
      allowable: true,
      container: false,
      redirectsToFile: false,
    };
    this.parts.push(part);

    for (const redirect of command.redirects) {
      const target = redirect.target;
      if (!target || redirect.op === '<<' || redirect.op === '<<-' || redirect.op === '<<<') continue;
      if ((redirect.op === '>&' || redirect.op === '<&') && /^[0-9-]+$/.test(target.text)) continue;
      const resolved = this.resolveWord(target);
      const writes = redirect.op !== '<';
      if (writes) {
        this.inspectWrite(resolved, `The redirection target "${target.text}"`);
        if (!resolved.candidates.every((candidate) => HARMLESS_DEVICES.has(candidate)) || resolved.unknown || resolved.candidates.length === 0) {
          part.redirectsToFile = true;
        }
      } else {
        this.inspectPath(resolved, `"${target.text}"`);
      }
    }

    for (const assignment of command.assignments) {
      if (HIJACK_VARIABLES.has(assignment.name)) {
        this.flag('obfuscated', `Setting ${assignment.name} can change which programs a command really runs.`);
      }
      if (assignment.value.substitution || assignment.value.variables.length > 0) this.#doubt('A variable is set from something that is only known when the command runs.');
      else this.inspectPath(this.resolveWord(assignment.value), `"${assignment.value.text}"`);
    }

    let words = command.words;
    while (words.length > 0 && RESERVED.has(words[0]!.text) && !words[0]!.quoted) words = words.slice(1);
    if (words.length === 0) return part;
    if (INERT.has(words[0]!.text) && !words[0]!.quoted) {
      if (words[0]!.text === 'function') this.#doubt('The command defines a function, which can hide what runs later.');
      return part;
    }
    if (words[0]!.text === 'case' && !words[0]!.quoted) this.#doubt('A case statement cannot be read reliably.');

    this.#program(command, words, part, depth, true);
    return part;
  }

  /** Classifies one program invocation; follows wrappers such as `sudo`, `env` and `xargs` to what they run. */
  #program(command: ShellCommand, words: readonly ShellWord[], part: CommandPart, depth: number, outermost: boolean): void {
    const head = words[0]!;
    const args = words.slice(1);
    const written = words.map((word) => word.text).join(' ');
    if ((!outermost || command.assignments.length > 0) && !part.peeled.includes(written)) part.peeled.push(written);

    if (head.substitution || head.variables.length > 0 || head.brace || head.glob) {
      this.flag('obfuscated', 'The program to run is computed when the command runs, which hides what it is.');
      // Whatever it turns out to be, wiping a root is not allowed to slip through.
      const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg.text) || arg.text === '--recursive' || arg.text === '--no-preserve-root');
      if (recursive && args.some((arg) => !arg.text.startsWith('-') && this.#isWipeTarget(this.resolveWord(arg)))) {
        this.#deny('This would recursively remove the file system root or a home directory.', 'catastrophic');
      }
      for (const arg of args) this.#scanArgument(arg);
      return;
    }

    const name = programName(head.text);
    const canonical = [name, ...args.map((arg) => arg.text)].join(' ');
    if (canonical !== part.text && !part.peeled.includes(canonical)) part.peeled.push(canonical);
    if (head.text.includes('/') && !['.', '..'].includes(head.text)) this.inspectPath(this.resolveWord(head), `"${head.text}"`);

    const project = this.#env.projectDir;
    if (project === null) {
      if (!READ_ONLY.has(name)) this.flag('outside-project', 'This session has no project folder, so the command is not confined to one.');
    } else if (this.#cwds.some((cwd) => cwd === null || !isInside(project, cwd)) && !READ_ONLY.has(name)) {
      this.flag('outside-project', 'It runs a command in a folder outside the project.');
    }

    if (PRIVILEGE.has(name)) this.flag('privilege', `"${name}" changes who a command runs as or what an account may do.`);
    if (DOWNLOADERS.has(name)) this.#downloaderSeen = true;

    if (name === 'eval') {
      this.flag('obfuscated', '"eval" runs text as a command, which hides what runs.');
      if (args.some((arg) => arg.nested.some((nested) => nested.words[0] && DOWNLOADERS.has(programName(nested.words[0].text))))) {
        this.flag('download-exec', 'It downloads something and runs it straight away.');
      }
      if (args.every((arg) => !arg.substitution && arg.variables.length === 0)) {
        this.#inline(args.map((arg) => arg.text).join(' '), part, depth);
      }
      return;
    }
    if (['alias', 'trap', 'enable', 'hash', 'shopt', 'setopt'].includes(name)) {
      this.#doubt(`"${name}" can change what later commands do.`);
    }
    if (name === 'source' || name === '.') {
      if (args.some((arg) => arg.substitution)) this.flag('obfuscated', 'It runs a script produced by another command.');
    }

    if (WRAPPERS.has(name)) {
      const inner = this.#unwrap(name, args);
      if (name === 'xargs') this.#doubt('"xargs" passes arguments that are only known when the command runs.');
      if (inner.length > 0) this.#program(command, inner, part, depth, false);
      return;
    }

    if (SHELLS.has(name) || OTHER_INTERPRETERS.has(name)) {
      this.#interpreter(command, name, args, part, depth);
      for (const arg of args) this.#scanArgument(arg);
      return;
    }

    switch (name) {
      case 'cd':
      case 'pushd':
        this.#changeDirectory(args);
        return;
      case 'rm':
      case 'unlink':
      case 'rmdir':
      case 'shred':
        this.#remove(name, args);
        break;
      case 'mv':
        for (const arg of this.#operands(args)) this.inspectWrite(this.resolveWord(arg), `"${arg.text}"`);
        break;
      case 'cp':
      case 'install':
      case 'rsync':
      case 'scp':
      case 'ln':
        this.#copy(name, args);
        break;
      case 'tee':
      case 'touch':
      case 'mkdir':
      case 'truncate':
      case 'mkfifo':
      case 'mknod':
      case 'patch':
        for (const arg of this.#operands(args)) this.inspectWrite(this.resolveWord(arg), `"${arg.text}"`);
        break;
      case 'chmod':
      case 'chown':
      case 'chgrp':
      case 'setfacl':
      case 'chattr':
        this.#changeMode(name, args);
        break;
      case 'find':
        this.#find(command, args, part, depth);
        return;
      case 'git':
        this.#git(args);
        break;
      case 'sed':
      case 'perl-i':
        break;
      case 'curl':
      case 'wget':
        this.#download(name, args);
        break;
      case 'tar':
      case 'unzip':
        this.#extract(name, args);
        break;
      case 'crontab':
        if (args.some((arg) => arg.text === '-r')) this.flag('destructive', '"crontab -r" removes every scheduled job of the account.');
        break;
      default:
        break;
    }

    if (DISK_TOOLS.has(name)) {
      this.flag('destructive', `"${name}" works on disks and partitions and can destroy what is on them.`);
      for (const arg of args) {
        const target = /^(?:of=)?(\/dev\/.+)$/.exec(arg.text)?.[1];
        if (target && BLOCK_DEVICE.test(target) && (name !== 'dd' || arg.text.startsWith('of='))) {
          this.#deny(`"${name}" would overwrite the raw disk ${target}.`, 'catastrophic');
        }
        if (name === 'dd' && arg.text.startsWith('of=')) this.inspectWrite(this.resolveText(arg.text.slice(3)), `"${arg.text.slice(3)}"`);
      }
    }
    if (name === 'sed' && args.some((arg) => /^-[a-zA-Z]*i/.test(arg.text) || arg.text.startsWith('--in-place'))) {
      for (const arg of this.#operands(args).slice(1)) this.inspectWrite(this.resolveWord(arg), `"${arg.text}"`);
    }
    if (BULK_READERS.has(name)) {
      for (const arg of this.#operands(args)) {
        const resolved = this.resolveWord(arg);
        if (resolved.candidates.some((candidate) => candidate === '/' || isInside(candidate, this.#env.homeDir))) {
          this.flag('credentials', `"${arg.text}" contains the places where credentials are kept.`);
        }
      }
    }
    for (const arg of args) this.#scanArgument(arg);
  }

  /** Every argument is looked at as a possible path, so credential locations are caught whatever reads them. */
  #scanArgument(arg: ShellWord): void {
    if (arg.substitution || arg.brace || arg.variables.some((name) => name !== 'HOME' && name !== 'PWD')) {
      this.#doubt('An argument is only known when the command runs.');
      return;
    }
    const text = arg.text;
    if (text.startsWith('-')) {
      const equals = text.indexOf('=');
      if (equals > 0 && equals < text.length - 1) this.inspectPath(this.resolveText(text.slice(equals + 1)), `"${text.slice(equals + 1)}"`);
      return;
    }
    this.inspectPath(this.resolveWord(arg), `"${text}"`);
    const assigned = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/s.exec(text)?.[1];
    if (assigned) this.inspectPath(this.resolveText(assigned), `"${assigned}"`);
  }

  /** Arguments that are not options. */
  #operands(args: readonly ShellWord[]): ShellWord[] {
    const result: ShellWord[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (!optionsEnded && arg.text === '--') optionsEnded = true;
      else if (optionsEnded || !arg.text.startsWith('-') || arg.text === '-') result.push(arg);
    }
    return result;
  }

  #unwrap(name: string, args: readonly ShellWord[]): ShellWord[] {
    const takesValue = WRAPPER_VALUE_OPTIONS[name] ?? [];
    let index = 0;
    while (index < args.length) {
      const text = args[index]!.text;
      if (text === '--') {
        index += 1;
        break;
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
        const variable = text.slice(0, text.indexOf('='));
        if (HIJACK_VARIABLES.has(variable)) this.flag('obfuscated', `Setting ${variable} can change which programs a command really runs.`);
        index += 1;
        continue;
      }
      if (!text.startsWith('-')) break;
      index += takesValue.includes(text) ? 2 : 1;
    }
    if (name === 'timeout' && index < args.length) index += 1; // the duration
    if (name === 'su') return [];
    return args.slice(index);
  }

  #interpreter(command: ShellCommand, name: string, args: readonly ShellWord[], part: CommandPart, depth: number): void {
    const isShell = SHELLS.has(name);
    const codeFlag = (text: string): boolean => {
      if (isShell) return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(text);
      if (name === 'python') return text === '-c';
      if (name === 'perl' || name === 'ruby') return /^-[a-zA-Z]*[eE]$/.test(text);
      if (name === 'php') return text === '-r';
      if (name === 'pwsh' || name === 'powershell') return /^-(c|command|enc|encodedcommand|e)$/i.test(text);
      return ['-e', '--eval', '-p', '--print', '-E'].includes(text);
    };
    const flagAt = args.findIndex((arg) => codeFlag(arg.text));
    if (flagAt !== -1) {
      const code = args[flagAt + 1];
      if (!code) {
        this.#doubt('An interpreter is asked to run code that is not given.');
      } else if (code.substitution || code.variables.length > 0) {
        this.flag('obfuscated', 'It runs code that is produced when the command runs, which hides what runs.');
        if (code.nested.some((nested) => nested.words[0] && DOWNLOADERS.has(programName(nested.words[0].text)))) {
          this.flag('download-exec', 'It downloads something and runs it straight away.');
        }
      } else if (isShell) {
        this.#inline(code.text, part, depth);
      } else {
        this.#doubt(`Code given to ${name} on the command line cannot be checked.`);
      }
      return;
    }

    const fromProcess = args.find((arg) => arg.substitution);
    if (fromProcess) {
      const downloads = fromProcess.nested.some((nested) => nested.words[0] && DOWNLOADERS.has(programName(nested.words[0].text)));
      if (downloads) this.flag('download-exec', 'It downloads something and runs it straight away.');
      else this.flag('obfuscated', 'It runs a script produced by another command, which hides what runs.');
    }
    const operands = this.#operands(args).filter((arg) => arg.text !== '-');
    const readsStandardInput = operands.length === 0 || (isShell && args.some((arg) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg.text)));
    if (readsStandardInput && (command.piped || command.heredoc || command.redirects.some((redirect) => redirect.op === '<<<' || redirect.op === '<'))) {
      if (command.piped && this.#downloaderSeen) this.flag('download-exec', 'It pipes a download into an interpreter, running whatever arrives.');
      else this.flag('obfuscated', `It feeds text into ${name} to be run, which hides what runs.`);
      if (isShell) {
        // What is fed in from the command line itself can still be read, so the worst cases are caught in every mode.
        for (const redirect of command.redirects) {
          if ((redirect.op === '<<' || redirect.op === '<<-') && redirect.body) this.#inline(redirect.body, part, depth);
          if (redirect.op === '<<<' && redirect.target && !redirect.target.substitution && redirect.target.variables.length === 0) {
            this.#inline(redirect.target.text, part, depth);
          }
        }
      }
    }
  }

  #inline(code: string, part: CommandPart, depth: number): void {
    if (depth >= 6) {
      this.#doubt('Commands are nested too deeply to check.');
      return;
    }
    part.container = true;
    this.commandLine(code, 'inline', depth + 1);
  }

  #changeDirectory(args: readonly ShellWord[]): void {
    const target = this.#operands(args)[0];
    if (!target) {
      this.#cwds = [...new Set([...this.#cwds, this.#env.homeDir])];
      return;
    }
    if (target.text === '-') {
      this.#cwds = [...new Set([...this.#cwds, null])];
      return;
    }
    const resolved = this.resolveWord(target);
    this.inspectPath(resolved, `"${target.text}"`);
    // The change may or may not happen (it can fail, or sit in a branch), so both stay possible.
    this.#cwds = [...new Set([...this.#cwds, ...resolved.candidates, ...(resolved.unknown || resolved.candidates.length === 0 ? [null] : [])])];
  }

  #remove(name: string, args: readonly ShellWord[]): void {
    const recursive = name !== 'unlink' && args.some((arg) => (/^-[a-zA-Z]+$/.test(arg.text) && /[rR]/.test(arg.text)) || arg.text === '--recursive');
    if (recursive) this.flag('destructive', 'It deletes folders and everything inside them.');
    if (name === 'shred') this.flag('destructive', 'It overwrites files so they cannot be recovered.');
    if (args.some((arg) => arg.text === '--no-preserve-root')) this.#deny('This would recursively remove the file system root.', 'catastrophic');
    const operands = this.#operands(args);
    if (operands.length === 0) this.#doubt('What would be removed is only known when the command runs.');
    for (const arg of operands) {
      const resolved = this.resolveWord(arg);
      if (recursive && this.#isWipeTarget(resolved)) {
        this.#deny(`This would recursively remove "${arg.text}": the file system root, a system folder or a home directory.`, 'catastrophic');
      }
      this.inspectWrite(resolved, `"${arg.text}"`);
    }
  }

  #copy(name: string, args: readonly ShellWord[]): void {
    const operands = this.#operands(args);
    if (name === 'rsync' && args.some((arg) => arg.text.startsWith('--delete') || arg.text === '--remove-source-files')) {
      this.flag('destructive', 'It deletes files as part of synchronising.');
    }
    const targetOption = args.findIndex((arg) => arg.text === '-t' || arg.text === '--target-directory');
    const explicit = targetOption === -1 ? args.find((arg) => arg.text.startsWith('--target-directory=')) : args[targetOption + 1];
    const destination = explicit ?? operands[operands.length - 1];
    if (!destination) return;
    const text = destination.text.startsWith('--target-directory=') ? destination.text.slice('--target-directory='.length) : destination.text;
    // user@host:path is another machine, not a local file.
    if ((name === 'rsync' || name === 'scp') && /^[^/]+:/.test(text)) return;
    this.inspectWrite(destination === explicit && text !== destination.text ? this.resolveText(text) : this.resolveWord(destination), `"${text}"`);
    if (name === 'ln' && args.some((arg) => /^-[a-zA-Z]*s/.test(arg.text) || arg.text === '--symbolic') && operands.length >= 2) {
      const source = this.resolveWord(operands[0]!);
      if (!this.isInsideProject(source)) {
        this.flag('outside-project', `It creates a link to "${operands[0]!.text}", which is outside the project folder.`);
      }
    }
  }

  #changeMode(name: string, args: readonly ShellWord[]): void {
    if (args.some((arg) => (/^-[a-zA-Z]+$/.test(arg.text) && arg.text.includes('R')) || arg.text === '--recursive')) {
      this.flag('recursive-permissions', `"${name}" changes permissions or ownership of a whole folder tree.`);
    }
    const operands = this.#operands(args);
    const spec = operands[0]?.text ?? '';
    if (name === 'chmod' && (/[ugoa]*\+[rwxXt]*s/.test(spec) || /^[2-7][0-7]{3}$/.test(spec))) {
      this.flag('privilege', 'It sets a set-user-id or set-group-id bit, which lets a program run with someone else\'s rights.');
    }
    if (name === 'chown' && /^(root|0)(:|$)/.test(spec)) this.flag('privilege', 'It hands files to the root account.');
    for (const arg of operands.slice(1)) this.inspectWrite(this.resolveWord(arg), `"${arg.text}"`);
  }

  #find(command: ShellCommand, args: readonly ShellWord[], part: CommandPart, depth: number): void {
    const firstExpression = args.findIndex((arg) => /^[-(!]/.test(arg.text));
    const roots = firstExpression === -1 ? args : args.slice(0, firstExpression);
    const resolvedRoots = roots.map((root) => ({ root, resolved: this.resolveWord(root) }));
    for (const { root, resolved } of resolvedRoots) {
      this.inspectPath(resolved, `"${root.text}"`);
      if (resolved.candidates.some((candidate) => candidate === '/' || isInside(candidate, this.#env.homeDir))) {
        this.flag('credentials', `"${root.text}" contains the places where credentials are kept.`);
      }
    }
    if (args.some((arg) => arg.text === '-delete')) {
      this.flag('destructive', '"find -delete" removes everything it finds.');
      if (resolvedRoots.length === 0) this.inspectWrite(this.resolveText('.'), 'The current folder');
      for (const { root, resolved } of resolvedRoots) {
        if (this.#isWipeTarget(resolved)) this.#deny(`This would delete everything under "${root.text}".`, 'catastrophic');
        this.inspectWrite(resolved, `"${root.text}"`);
      }
    }
    for (let i = 0; i < args.length; i += 1) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]!.text)) continue;
      const end = args.findIndex((arg, index) => index > i && (arg.text === ';' || arg.text === '+'));
      const inner = args.slice(i + 1, end === -1 ? args.length : end);
      if (inner.length > 0) {
        this.#doubt('"find -exec" runs a command on files that are only known when it runs.');
        this.#program(command, inner, part, depth, false);
      }
      if (end === -1) break;
      i = end;
    }
    for (const arg of args) {
      if (/^-(fprint|fprintf|fls)/.test(arg.text)) this.#doubt('"find" is asked to write a file.');
    }
  }

  #git(args: readonly ShellWord[]): void {
    let index = 0;
    let elsewhere = false;
    while (index < args.length) {
      const text = args[index]!.text;
      if (text === '-C' || text === '--git-dir' || text === '--work-tree') {
        const target = args[index + 1];
        if (target) {
          const resolved = this.resolveWord(target);
          this.inspectPath(resolved, `"${target.text}"`);
          if (!this.isInsideProject(resolved)) elsewhere = true;
        }
        index += 2;
      } else if (text === '-c') {
        const setting = args[index + 1]?.text ?? '';
        if (GIT_PROGRAM_SETTING.test(setting)) {
          this.flag('obfuscated', 'A git setting on the command line makes git run another program.');
        }
        index += 2;
      } else if (text.startsWith('--git-dir=') || text.startsWith('--work-tree=')) {
        const resolved = this.resolveText(text.slice(text.indexOf('=') + 1));
        if (!this.isInsideProject(resolved)) elsewhere = true;
        index += 1;
      } else if (text.startsWith('-')) {
        index += 1;
      } else {
        break;
      }
    }
    const sub = args[index]?.text ?? '';
    const rest = args.slice(index + 1).map((arg) => arg.text);
    const has = (...flags: string[]): boolean => rest.some((text) => flags.includes(text));
    const shortHas = (letter: string): boolean => rest.some((text) => /^-[a-zA-Z]+$/.test(text) && text.includes(letter));
    const readOnly = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'ls-tree', 'ls-remote', 'reflog', 'whatchanged'].includes(sub) && !(sub === 'reflog' && has('expire', 'delete'));
    if (elsewhere && !readOnly) this.flag('outside-project', 'It runs git on a repository outside the project folder.');
    const configRead = has('--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list');
    if (sub === 'config' && !configRead && rest.some((text) => GIT_PROGRAM_SETTING.test(text))) {
      this.flag('privilege', 'It sets a git option that names a program, which then runs whenever git is used on the repository.');
    }

    if (sub === 'push') {
      if (has('--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune') || shortHas('f') || shortHas('d') || rest.some((text) => text.startsWith('--force-with-lease=') || /^\+./.test(text) || /^:[^:]/.test(text))) {
        this.flag('destructive', 'It force-pushes or deletes on the remote, which can discard other people\'s commits.');
      }
    } else if (sub === 'reset' && has('--hard')) {
      this.flag('destructive', '"git reset --hard" discards uncommitted work.');
    } else if (sub === 'clean') {
      this.flag('destructive', '"git clean" deletes untracked files.');
    } else if (['rebase', 'filter-branch', 'filter-repo'].includes(sub) || (sub === 'commit' && has('--amend'))) {
      this.flag('destructive', 'It rewrites commit history.');
    } else if ((sub === 'reflog' && has('expire', 'delete')) || (sub === 'gc' && rest.some((text) => text.startsWith('--prune'))) || (sub === 'update-ref' && has('-d', '--delete'))) {
      this.flag('destructive', 'It removes the records git keeps for recovering lost commits.');
    } else if (sub === 'branch' && (has('-D') || (has('--delete', '-d') && has('--force', '-f')))) {
      this.flag('destructive', 'It force-deletes a branch, even one that was never merged.');
    } else if (['checkout', 'switch', 'restore'].includes(sub) && (has('--force', '-f', '--discard-changes') || shortHas('f'))) {
      this.flag('destructive', 'It discards uncommitted changes.');
    } else if (sub === 'stash' && has('clear', 'drop')) {
      this.flag('destructive', 'It throws away stashed work.');
    }
  }

  #download(name: string, args: readonly ShellWord[]): void {
    const valueOptions = name === 'curl' ? ['-o', '--output', '--output-dir', '-K', '--config', '-T', '--upload-file', '-d', '--data', '--data-binary', '-F', '--form', '--cert', '--key', '-E'] : ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-i', '--input-file', '--post-file'];
    const writes = name === 'curl' ? ['-o', '--output', '--output-dir'] : ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file'];
    for (let i = 0; i < args.length; i += 1) {
      const text = args[i]!.text;
      const value = valueOptions.includes(text) ? args[i + 1] : undefined;
      if (!value) continue;
      if (value.text === '-') continue;
      const literal = value.text.replace(/^@/, '');
      const resolved = literal === value.text ? this.resolveWord(value) : this.resolveText(literal);
      if (writes.includes(text)) this.inspectWrite(resolved, `"${value.text}"`);
      else this.inspectPath(resolved, `"${value.text}"`);
      i += 1;
    }
  }

  #extract(name: string, args: readonly ShellWord[]): void {
    const option = name === 'tar' ? ['-C', '--directory'] : ['-d'];
    for (let i = 0; i < args.length; i += 1) {
      if (option.includes(args[i]!.text) && args[i + 1]) this.inspectWrite(this.resolveWord(args[i + 1]!), `"${args[i + 1]!.text}"`);
      if (args[i]!.text.startsWith('--directory=')) this.inspectWrite(this.resolveText(args[i]!.text.slice(12)), `"${args[i]!.text.slice(12)}"`);
    }
  }
}

/** Looks at a request and says what is risky about it. */
export function classifyRequest(request: ToolRequest, env: PermissionEnvironment): Classification {
  const classifier = new Classifier(env);
  let insideProject = true;
  const ruleTargets: string[] = [];

  for (const raw of request.paths ?? []) {
    const expanded = raw === '~' || raw.startsWith('~/') ? env.homeDir + raw.slice(1) : raw;
    const resolved = classifier.resolveText(expanded);
    if (request.kind === 'edit') classifier.inspectWrite(resolved, `"${raw}"`);
    else classifier.inspectPath(resolved, `"${raw}"`);
    const inside = classifier.isInsideProject(resolved);
    if (!inside) insideProject = false;
    for (const candidate of resolved.candidates) {
      ruleTargets.push(inside && env.projectDir ? path.relative(env.projectDir, candidate).split(path.sep).join('/') || '.' : candidate);
    }
    if (resolved.candidates.length === 0) ruleTargets.push(raw);
  }

  if (typeof request.command === 'string' && request.command.trim() !== '') {
    classifier.commandLine(request.command);
  } else if (request.kind === 'execute') {
    classifier.unsure.push('The command to run was not given.');
  }

  return {
    categories: [...classifier.categories],
    findings: classifier.findings,
    hardDeny: classifier.hardDeny,
    unsure: classifier.unsure,
    insideProject,
    parts: classifier.parts,
    ruleTargets,
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const toolMatches = (rule: EngineRule, toolName: string): boolean => matchesTextGlob(rule.tool, toolName);

function pathMatches(pattern: string, target: string, env: PermissionEnvironment): boolean {
  const expanded = pattern === '~' || pattern.startsWith('~/') ? env.homeDir + pattern.slice(1) : pattern;
  if (!expanded.includes('/')) return matchesPathGlob(expanded, target.slice(target.lastIndexOf('/') + 1));
  return matchesPathGlob(expanded, target);
}

/** Does a rule's pattern cover one part of a command? */
const partMatches = (pattern: string, text: string): boolean => matchesTextGlob(pattern, text);

function ruleMatches(rule: EngineRule, request: ToolRequest, classification: Classification, env: PermissionEnvironment, purpose: 'restrict' | 'allow'): boolean {
  if (!toolMatches(rule, request.toolName)) return false;
  if (rule.pattern === null) {
    // A whole-tool allow rule still has to cover a command part by part, so nothing rides along on it.
    return true;
  }
  const pattern = rule.pattern;

  if (typeof request.command === 'string' && request.command.trim() !== '') {
    const whole = request.command.trim().replace(/\s+/g, ' ');
    if (purpose === 'restrict') {
      // A deny or ask rule applies if it matches the whole line or any command inside it, through wrappers.
      if (partMatches(pattern, whole)) return true;
      return classification.parts.some((part) => partMatches(pattern, part.text) || part.peeled.some((peeled) => partMatches(pattern, peeled)));
    }
    if (!hasWildcard(pattern) && partMatches(pattern, whole)) return true;
    return false; // allow rules are applied per part by coveredByAllowRules
  }

  if (classification.ruleTargets.length > 0) {
    const test = (target: string): boolean => pathMatches(pattern, target, env);
    return purpose === 'restrict' ? classification.ruleTargets.some(test) : classification.ruleTargets.every(test);
  }
  if (typeof request.url === 'string' && request.url !== '') return matchesTextGlob(pattern, request.url);
  return false;
}

/** For a command line: every part must be covered by some allow rule. Returns the first rule used. */
function coveredByAllowRules(rules: readonly EngineRule[], request: ToolRequest, classification: Classification, mode: PermissionMode): EngineRule | null {
  const allowRules = rules.filter((rule) => rule.effect === 'allow' && toolMatches(rule, request.toolName));
  if (allowRules.length === 0 || classification.parts.length === 0) return null;
  let first: EngineRule | null = null;
  for (const part of classification.parts) {
    if (part.container) continue;
    if (part.redirectsToFile && mode !== 'accept-edits') return null;
    const rule = allowRules.find((candidate) => candidate.pattern === null || partMatches(candidate.pattern, part.text));
    if (!rule) return null;
    first ??= rule;
  }
  return first;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const SCOPE_ORDER: Record<RuleScope, number> = { session: 0, project: 1, account: 2 };

export function evaluatePermission(input: PermissionInput): PermissionOutcome {
  const { request, env } = input;
  const mode = effectiveMode(input.mode, env.autoEnabled);
  const classification = classifyRequest(request, env);
  const categories = classification.categories;
  const dangerous = categories.length > 0;
  const isRead = request.kind === 'read' || request.kind === 'search';
  const hasCommand = typeof request.command === 'string' && request.command.trim() !== '';
  const risk: RiskClass = dangerous ? 'dangerous' : isRead && classification.insideProject && !hasCommand ? 'low' : 'medium';
  const rules = [...input.rules].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  const outcome = (decision: PermissionOutcome['decision'], code: string, reason: string, ruleId: string | null = null): PermissionOutcome => ({
    decision,
    code,
    reason,
    risk,
    categories,
    effectiveMode: mode,
    ruleId,
  });

  if (classification.hardDeny) return outcome('deny', 'hard_deny', classification.hardDeny);

  const denyRule = rules.find((rule) => rule.effect === 'deny' && ruleMatches(rule, request, classification, env, 'restrict'));
  if (denyRule) return outcome('deny', 'deny_rule', 'A rule you set blocks this.', denyRule.id);

  if (mode === 'plan' && !isRead) {
    return outcome('deny', 'plan_mode', 'Plan mode only reads and searches; nothing is changed or run until the plan is approved.');
  }

  const askRule = rules.find((rule) => rule.effect === 'ask' && ruleMatches(rule, request, classification, env, 'restrict'));
  if (askRule) return outcome('ask', 'ask_rule', 'A rule you set says to always ask about this.', askRule.id);

  if (dangerous && mode !== 'auto') {
    return outcome('ask', 'dangerous', classification.findings[0] ?? 'This request is risky.');
  }
  if (mode === 'auto') return outcome('allow', 'mode_auto', 'Auto mode is on for this project.');

  if (!hasCommand) {
    if (isRead && classification.insideProject) return outcome('allow', 'read_in_project', 'Reading inside the project is allowed.');
    if (mode === 'accept-edits' && request.kind === 'edit' && (request.paths?.length ?? 0) > 0 && classification.insideProject) {
      return outcome('allow', 'edit_in_project', 'Edits inside the project are accepted in this mode.');
    }
  }

  if (classification.unsure.length > 0) return outcome('ask', 'unsure', classification.unsure[0]!);

  if (hasCommand) {
    const exact = rules.find((rule) => rule.effect === 'allow' && rule.pattern !== null && ruleMatches(rule, request, classification, env, 'allow'));
    if (exact && classification.parts.every((part) => !part.redirectsToFile || mode === 'accept-edits')) {
      return outcome('allow', 'allow_rule', 'A rule you saved allows this command.', exact.id);
    }
    const covering = coveredByAllowRules(rules, request, classification, mode);
    if (covering) return outcome('allow', 'allow_rule', 'Rules you saved allow every part of this command.', covering.id);
  } else {
    const allowRule = rules.find((rule) => rule.effect === 'allow' && ruleMatches(rule, request, classification, env, 'allow'));
    if (allowRule) return outcome('allow', 'allow_rule', 'A rule you saved allows this.', allowRule.id);
  }

  if (request.kind === 'other') return outcome('ask', 'unknown_tool', `The Studio does not know what "${request.toolName}" does, so it asks first.`);
  if (isRead) return outcome('ask', 'needs_approval', 'This reads outside the project folder.');
  return outcome('ask', 'needs_approval', 'This changes something, so it needs your approval.');
}

// ---------------------------------------------------------------------------
// Remembering, and who may decide
// ---------------------------------------------------------------------------

/**
 * The rule "allow and remember" would save for a request, or null when
 * remembering is not offered (dangerous requests, and anything unclear).
 */
export function suggestRule(request: ToolRequest, env: PermissionEnvironment): { tool: string; pattern: string | null } | null {
  const classification = classifyRequest(request, env);
  if (classification.categories.length > 0 || classification.hardDeny) return null;
  if (typeof request.command === 'string' && request.command.trim() !== '') {
    if (classification.unsure.length > 0) return null;
    const parsed = parseShell(request.command);
    const whole = escapeGlob(request.command.trim().replace(/\s+/g, ' '));
    if (parsed.commands.length !== 1) return { tool: request.toolName, pattern: whole };
    const command = parsed.commands[0]!;
    if (command.assignments.length > 0 || command.redirects.length > 0 || command.words.length === 0) return { tool: request.toolName, pattern: whole };
    const program = command.words[0]!.text;
    const name = programName(program);
    const plain = (word: string | undefined): word is string => word !== undefined && /^[A-Za-z][\w:.-]*$/.test(word);
    const second = command.words[1]?.text;
    const third = command.words[2]?.text;
    let kept = program;
    if (SUBCOMMAND_PROGRAMS.has(name) && plain(second)) {
      kept = `${program} ${second}`;
      // "npm run" alone would cover every script; the script (or the second-level command) belongs in the rule.
      if (plain(third) && (TWO_LEVEL_COMMANDS[name] ?? []).includes(second)) kept = `${kept} ${third}`;
    }
    return { tool: request.toolName, pattern: `${escapeGlob(kept)} *` };
  }
  return { tool: request.toolName, pattern: null };
}

export type AuthorityRefusal = 'not_authorized' | 'owner_required' | 'remember_not_allowed';

/**
 * Who may answer an approval. The person whose run is asking and the instance
 * owner may answer; allowing a dangerous request takes the owner; a dangerous
 * request can never be remembered.
 */
export function approvalAuthority(input: {
  decision: 'allow' | 'deny';
  risk: RiskClass;
  remember: boolean;
  deciderRole: Role;
  deciderIsRunUser: boolean;
}): { ok: true } | { ok: false; code: AuthorityRefusal; reason: string } {
  if (!input.deciderIsRunUser && input.deciderRole !== 'owner') {
    return { ok: false, code: 'not_authorized', reason: 'This request is not yours to answer.' };
  }
  if (input.decision === 'allow' && input.risk === 'dangerous') {
    if (input.remember) {
      return { ok: false, code: 'remember_not_allowed', reason: 'A dangerous request can be allowed once, never remembered.' };
    }
    if (input.deciderRole !== 'owner') {
      return { ok: false, code: 'owner_required', reason: 'Only the owner of this Studio can allow a dangerous request.' };
    }
  }
  return { ok: true };
}
