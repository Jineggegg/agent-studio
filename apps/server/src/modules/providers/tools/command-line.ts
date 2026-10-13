/**
 * Decides how a command line written by a model is run.
 *
 * A **simple command** — a program and its arguments, with nothing a shell
 * would interpret — is split into an argument array here and started
 * directly: no shell ever sees it, so there is nothing to inject into.
 *
 * Anything that needs a shell to mean what it says (a pipe, `&&`, a
 * redirection, a variable, a wildcard, a substitution, a shell built-in such
 * as `cd`) is reported as `shell`; the caller then runs `sh -c` — inside the
 * sandbox, or, where there is none, only after a person approved that exact
 * line.
 *
 * The reader is strict on purpose: it accepts plain words, single quotes,
 * double quotes without expansions, and backslash escapes, and calls
 * everything else `shell`. It never guesses.
 */
export type CommandLine =
  | { readonly kind: 'simple'; readonly argv: readonly string[] }
  | { readonly kind: 'shell'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Characters a shell gives a meaning to when they stand unquoted. */
const SHELL_CHARACTERS = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '\n']);

/** First words that are part of the shell itself: there is no such program to start. */
const SHELL_WORDS = new Set([
  'cd', 'pushd', 'popd', 'dirs', 'export', 'unset', 'set', 'shopt', 'source', '.', 'alias', 'unalias', 'eval', 'exec', 'exit', 'return', 'read', 'wait',
  'trap', 'ulimit', 'umask', 'shift', 'local', 'declare', 'typeset', 'readonly', 'let', 'bg', 'fg', 'jobs', 'disown', 'history', 'type', 'hash', 'builtin',
  'command', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'time', 'coproc', '!', '[[', '((',
]);

export const MAX_COMMAND_CHARS = 8_000;
const MAX_ARGUMENTS = 512;

export function parseCommandLine(source: string): CommandLine {
  if (typeof source !== 'string' || source.trim() === '') return { kind: 'invalid', reason: 'The command is empty.' };
  if (source.length > MAX_COMMAND_CHARS) return { kind: 'invalid', reason: `The command is longer than ${MAX_COMMAND_CHARS} characters.` };
  if (source.includes('\0')) return { kind: 'invalid', reason: 'The command contains a NUL character.' };
  const text = source.trim();

  const argv: string[] = [];
  let word = '';
  let inWord = false;
  /** Whether the whole of the current word so far was written without quotes or escapes. */
  let plain = true;
  let shell: string | null = null;
  const needShell = (reason: string): void => {
    shell ??= reason;
  };
  const endWord = (): void => {
    if (!inWord) return;
    if (argv.length === 0 && plain && SHELL_WORDS.has(word)) needShell(`"${word}" is part of the shell, not a program`);
    if (argv.length === 0 && plain && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) needShell('it sets a variable for the command');
    argv.push(word);
    word = '';
    inWord = false;
    plain = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return { kind: 'invalid', reason: 'A single quote is not closed.' };
      word += text.slice(i + 1, end);
      inWord = true;
      plain = false;
      i = end;
      continue;
    }
    if (c === '"') {
      let k = i + 1;
      let closed = false;
      for (; k < text.length; k += 1) {
        const d = text[k]!;
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '\\') {
          const next = text[k + 1];
          if (next === undefined) break;
          if (next === '\n') needShell('a line is continued with a backslash');
          // Inside double quotes a backslash only escapes these; before anything else it stays.
          word += '"\\$`'.includes(next) ? next : `\\${next}`;
          k += 1;
          continue;
        }
        if (d === '$' || d === '`') needShell('it expands a variable or runs a command inside quotes');
        word += d;
      }
      if (!closed) return { kind: 'invalid', reason: 'A double quote is not closed.' };
      inWord = true;
      plain = false;
      i = k;
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) return { kind: 'invalid', reason: 'The command ends with a backslash.' };
      if (next === '\n') needShell('a line is continued with a backslash');
      word += next;
      inWord = true;
      plain = false;
      i += 1;
      continue;
    }
    if (SHELL_CHARACTERS.has(c)) needShell(c === '\n' ? 'it has more than one line' : `it uses "${c}"`);
    if (!inWord && (c === '~' || c === '#')) needShell(c === '~' ? 'it uses "~" for the home directory' : 'it contains a comment');
    word += c;
    inWord = true;
  }
  endWord();

  if (shell !== null) return { kind: 'shell', reason: shell };
  if (argv.length === 0 || argv[0] === '') return { kind: 'invalid', reason: 'The command names no program.' };
  if (argv.length > MAX_ARGUMENTS) return { kind: 'invalid', reason: 'The command has too many arguments.' };
  return { kind: 'simple', argv };
}

/**
 * Programs whose whole purpose is to run another command line, or to hand
 * one to a shell. Started directly they are a shell in all but name, so on a
 * server without a sandbox they get the same treatment as `sh -c`.
 */
const RUNS_COMMANDS = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox', 'toybox',
  'env', 'xargs', 'nohup', 'timeout', 'nice', 'ionice', 'chrt', 'setsid', 'stdbuf', 'unbuffer', 'watch', 'script', 'flock', 'parallel',
  'sudo', 'doas', 'su', 'pkexec', 'runuser', 'chroot', 'unshare', 'nsenter', 'ssh',
]);

export function runsOtherCommands(argv: readonly string[]): boolean {
  const program = (argv[0] ?? '').slice((argv[0] ?? '').lastIndexOf('/') + 1).toLowerCase();
  return RUNS_COMMANDS.has(program);
}
