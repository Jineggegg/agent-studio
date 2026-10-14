/**
 * Which code blocks in what an agent wrote are commands a person could run,
 * and what exactly would be typed. The terminal types one line at a time and
 * never presses Enter, so a block is turned into a list of one-line commands.
 *
 * A fence tagged as a shell language is taken at its word. An untagged block
 * has to look like nothing but commands — a few short lines, each starting
 * with a well-known program or a path — because a file listing or a piece of
 * output must never be offered as something to run.
 */
const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'shell-session', 'terminal']);

/** Programs common enough that a bare line starting with one of them is a command. */
const KNOWN_PROGRAMS = new Set([
  'git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'node', 'deno', 'tsc', 'tsx', 'vite', 'vitest', 'jest', 'eslint', 'prettier', 'playwright',
  'python', 'python3', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'pytest', 'ruff', 'mypy', 'cargo', 'rustc', 'rustup', 'go', 'make', 'cmake', 'ninja', 'gcc', 'clang',
  'java', 'mvn', 'gradle', 'dotnet', 'ruby', 'bundle', 'gem', 'rake', 'php', 'composer', 'swift', 'xcodebuild', 'flutter', 'dart',
  'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'systemctl', 'journalctl', 'service',
  'ls', 'cd', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'echo', 'printf', 'pwd', 'ln', 'chmod', 'chown', 'du', 'df', 'tree', 'stat', 'file',
  'grep', 'rg', 'find', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail', 'less', 'diff', 'tar', 'zip', 'unzip', 'gzip', 'xargs', 'tee', 'jq',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'ping', 'nc', 'openssl', 'sudo', 'apt', 'apt-get', 'brew', 'dnf', 'yum', 'pacman', 'snap',
  'ps', 'kill', 'pkill', 'top', 'export', 'source', 'env', 'which', 'whoami', 'date', 'sleep', 'open', 'code', 'tmux', 'nohup', 'time', 'sqlite3', 'psql', 'redis-cli',
]);

const UNTAGGED_MAX_LINES = 8;
const PROMPT = /^\s*\$ +/;

/** `a \` followed by `b` is one command; the terminal gets it as one line. */
function joinContinuations(lines: readonly string[]): string[] {
  const out: string[] = [];
  let carry = '';
  for (const line of lines) {
    const text = carry === '' ? line.trim() : `${carry} ${line.trim()}`;
    if (text.endsWith('\\')) {
      carry = text.slice(0, -1).trimEnd();
      continue;
    }
    carry = '';
    out.push(text);
  }
  if (carry !== '') out.push(carry);
  return out;
}

const isComment = (line: string): boolean => line.trimStart().startsWith('#');

function startsWithProgram(line: string): boolean {
  // Leading `VAR=value` assignments are part of the command they precede.
  const words = line.trim().split(/\s+/);
  let index = 0;
  while (index < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  const first = words[index] ?? '';
  if (first === '') return false;
  if (first.startsWith('./') || first.startsWith('../') || first.startsWith('~/') || (first.startsWith('/') && first.length > 1)) return true;
  return KNOWN_PROGRAMS.has(first);
}

/**
 * The commands in a code block, one line each, or null when the block is not
 * something to run. In a transcript of a session ("$ " before each command,
 * output in between) only the lines after a prompt are commands.
 */
export function shellCommands(language: string | undefined, source: string): string[] | null {
  const text = source.replace(/\r\n/g, '\n');
  if (text.trim() === '') return null;
  const tagged = language !== undefined && SHELL_LANGUAGES.has(language.toLowerCase());
  if (language !== undefined && !tagged) return null;

  const lines = text.split('\n');
  if (tagged) {
    if (lines.some((line) => PROMPT.test(line))) {
      const prompted: string[] = [];
      let continuing = false;
      for (const line of lines) {
        if (PROMPT.test(line)) {
          prompted.push(line.replace(PROMPT, ''));
          continuing = line.trimEnd().endsWith('\\');
        } else if (continuing) {
          // The rest of a command broken over lines, with or without the shell's "> " in front.
          prompted.push(line.replace(/^\s*> ?/, ''));
          continuing = line.trimEnd().endsWith('\\');
        }
      }
      const commands = joinContinuations(prompted).filter((line) => line !== '' && !isComment(line));
      return commands.length > 0 ? commands : null;
    }
    const commands = joinContinuations(lines.filter((line) => line.trim() !== '' && !isComment(line))).filter((line) => line !== '');
    return commands.length > 0 ? commands : null;
  }

  // Untagged: only a short block in which every line is plainly a command.
  const meaningful = lines.filter((line) => line.trim() !== '');
  if (meaningful.length === 0 || meaningful.length > UNTAGGED_MAX_LINES) return null;
  const commands = joinContinuations(meaningful.filter((line) => !isComment(line))).filter((line) => line !== '');
  if (commands.length === 0 || !commands.every(startsWithProgram)) return null;
  return commands;
}
