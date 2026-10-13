/**
 * A deliberately conservative reader of shell command lines.
 *
 * It does not execute or fully emulate a shell. Its only job is to find every
 * simple command a command line could run — across `;`, `&&`, `||`, `|`,
 * newlines, subshells, command and process substitutions — with quotes
 * removed, so the permission engine can classify each one. Whatever it cannot
 * read with confidence is reported in `uncertain`, and the engine then asks a
 * human instead of guessing.
 */

export interface ShellWord {
  /** The word after quote removal. Expansions are left as written (`$HOME/x`, `$(…)`). */
  text: string;
  /** Part of the word was quoted or escaped. */
  quoted: boolean;
  /** Starts with an unquoted `~`. */
  tilde: boolean;
  /** Contains an unquoted `*`, `?` or `[`. */
  glob: boolean;
  /** Contains an unquoted brace expansion such as `{a,b}`. */
  brace: boolean;
  /** Names of the variables it expands. */
  variables: string[];
  /** Contains a command or process substitution. */
  substitution: boolean;
  /** The commands inside those substitutions (they are also in the flat command list). */
  nested: ShellCommand[];
}

export interface ShellRedirect {
  /** `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `<<`, `<<-`, `<<<`, `>&`, `<&`. */
  op: string;
  fd: string | null;
  target: ShellWord | null;
  /** The text of a here-document (`<<`). */
  body?: string;
}

export interface ShellCommand {
  assignments: Array<{ name: string; value: ShellWord }>;
  words: ShellWord[];
  redirects: ShellRedirect[];
  /** Its standard input is the output of the previous command. */
  piped: boolean;
  /** Its standard output feeds the next command. */
  pipesOut: boolean;
  /** Where it was found. */
  origin: 'top' | 'substitution' | 'process-substitution' | 'inline';
  /** A here-document feeds it. */
  heredoc: boolean;
}

export interface ParsedShell {
  /** Every simple command, in the order their text ends. */
  commands: ShellCommand[];
  /** Reasons the reading is not trustworthy. Empty when it is. */
  uncertain: string[];
}

interface WordBuilder {
  text: string;
  quoted: boolean;
  tilde: boolean;
  glob: boolean;
  sawBrace: boolean;
  variables: string[];
  substitution: boolean;
  nested: ShellCommand[];
  /** Everything so far was unquoted identifier characters (for spotting NAME=value). */
  plainName: boolean;
  assignmentAt: number;
}

interface State {
  commands: ShellCommand[];
  uncertain: string[];
}

const MAX_DEPTH = 8;
const MAX_LENGTH = 100_000;

const newWord = (): WordBuilder => ({
  text: '',
  quoted: false,
  tilde: false,
  glob: false,
  sawBrace: false,
  variables: [],
  substitution: false,
  nested: [],
  plainName: true,
  assignmentAt: -1,
});

function finishWord(builder: WordBuilder): ShellWord {
  return {
    text: builder.text,
    quoted: builder.quoted,
    tilde: builder.tilde,
    glob: builder.glob,
    brace: builder.sawBrace && /\{[^{}]*(,|\.\.)[^{}]*\}/.test(builder.text),
    variables: builder.variables,
    substitution: builder.substitution,
    nested: builder.nested,
  };
}

/** Decodes the escapes of an ANSI-C quoted string (`$'…'`). */
function decodeAnsiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs, (_match, escape: string) => {
    const kind = escape[0]!;
    if (kind === 'x' || kind === 'u' || kind === 'U') {
      const code = Number.parseInt(escape.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (kind >= '0' && kind <= '7') return String.fromCharCode(Number.parseInt(escape, 8) & 0xff);
    if (kind === 'c') return '';
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
    return simple[kind] ?? kind;
  });
}

class Reader {
  readonly #src: string;
  readonly #state: State;
  readonly #origin: ShellCommand['origin'];
  readonly #depth: number;
  #i: number;

  constructor(src: string, start: number, origin: ShellCommand['origin'], state: State, depth: number) {
    this.#src = src;
    this.#i = start;
    this.#origin = origin;
    this.#state = state;
    this.#depth = depth;
  }

  /**
   * Reads commands until the end of the text or, when `closing` is set, the
   * parenthesis that closes the substitution. Returns the index after it.
   */
  read(closing: boolean): number {
    const src = this.#src;
    let command: ShellCommand | null = null;
    let word: WordBuilder | null = null;
    let pendingRedirect: { op: string; fd: string | null } | null = null;
    let nextPiped = false;
    let parens = 0;
    const heredocs: Array<{ delimiter: string; stripTabs: boolean; redirect: ShellRedirect }> = [];

    const ensureCommand = (): ShellCommand => {
      if (!command) {
        command = { assignments: [], words: [], redirects: [], piped: nextPiped, pipesOut: false, origin: this.#origin, heredoc: false };
        nextPiped = false;
      }
      return command;
    };
    const ensureWord = (): WordBuilder => (word ??= newWord());
    const endWord = (): void => {
      if (!word) {
        return;
      }
      const builder = word;
      const finished = finishWord(builder);
      word = null;
      const target = ensureCommand();
      if (pendingRedirect) {
        const redirect: ShellRedirect = { ...pendingRedirect, target: finished };
        target.redirects.push(redirect);
        if (redirect.op === '<<' || redirect.op === '<<-') {
          target.heredoc = true;
          heredocs.push({ delimiter: finished.text, stripTabs: redirect.op === '<<-', redirect });
        }
        pendingRedirect = null;
        return;
      }
      if (target.words.length === 0 && builder.assignmentAt > 0) {
        const name = finished.text.slice(0, builder.assignmentAt);
        const value = finished.text.slice(builder.assignmentAt + 1);
        // The shell expands "~" at the start of an assigned value too.
        target.assignments.push({ name, value: { ...finished, text: value, tilde: value.startsWith('~') } });
        return;
      }
      target.words.push(finished);
    };
    const endCommand = (pipesOut: boolean): void => {
      endWord();
      if (pendingRedirect) {
        ensureCommand().redirects.push({ ...pendingRedirect, target: null });
        pendingRedirect = null;
        this.#state.uncertain.push('a redirection has no target');
      }
      const finished = command as ShellCommand | null;
      if (finished && (finished.words.length > 0 || finished.assignments.length > 0 || finished.redirects.length > 0)) {
        finished.pipesOut = pipesOut;
        this.#state.commands.push(finished);
      }
      command = null;
    };
    const append = (text: string, quoted: boolean): void => {
      const builder = ensureWord();
      if (quoted) {
        builder.quoted = true;
        builder.plainName = false;
      } else if (builder.plainName && builder.assignmentAt === -1) {
        for (let k = 0; k < text.length; k += 1) {
          const ch = text[k]!;
          const position = builder.text.length + k;
          if (ch === '=' && position > 0) {
            builder.assignmentAt = position;
            break;
          }
          const identifier = /[A-Za-z0-9_]/.test(ch) && !(position === 0 && /[0-9]/.test(ch));
          if (!identifier) {
            builder.plainName = false;
            break;
          }
        }
      }
      builder.text += text;
    };

    while (this.#i < src.length) {
      const c = src[this.#i]!;

      if (c === '\\') {
        const next = src[this.#i + 1];
        if (next === undefined) {
          this.#state.uncertain.push('the command ends with a backslash');
          this.#i += 1;
        } else if (next === '\n') {
          this.#i += 2;
        } else {
          append(next, true);
          this.#i += 2;
        }
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", this.#i + 1);
        if (end === -1) {
          this.#state.uncertain.push('a quote is not closed');
          append(src.slice(this.#i + 1), true);
          this.#i = src.length;
        } else {
          append(src.slice(this.#i + 1, end), true);
          this.#i = end + 1;
        }
        continue;
      }
      if (c === '"') {
        ensureWord().quoted = true;
        ensureWord().plainName = false;
        this.#i = this.#doubleQuoted(this.#i + 1, ensureWord());
        continue;
      }
      if (c === '$') {
        if (src[this.#i + 1] === "'") {
          const end = this.#ansiEnd(this.#i + 2);
          append(decodeAnsiC(src.slice(this.#i + 2, end)), true);
          this.#i = Math.min(end + 1, src.length);
          continue;
        }
        if (src[this.#i + 1] === '"') {
          this.#i += 1;
          continue;
        }
        const builder = ensureWord();
        builder.plainName = false;
        this.#i = this.#expansion(this.#i, builder);
        continue;
      }
      if (c === '`') {
        const builder = ensureWord();
        builder.plainName = false;
        this.#i = this.#backticks(this.#i, builder);
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        endWord();
        this.#i += 1;
        continue;
      }
      if (c === '\n') {
        endCommand(false);
        this.#i += 1;
        while (heredocs.length > 0) this.#skipHeredoc(heredocs.shift()!);
        continue;
      }
      if (c === '#' && !word) {
        const end = src.indexOf('\n', this.#i);
        this.#i = end === -1 ? src.length : end;
        continue;
      }
      if (c === ';') {
        endCommand(false);
        this.#i += src[this.#i + 1] === ';' ? 2 : 1;
        continue;
      }
      if (c === '&') {
        if (src[this.#i + 1] === '>') {
          endWord();
          const double = src[this.#i + 2] === '>';
          pendingRedirect = { op: double ? '&>>' : '&>', fd: null };
          this.#i += double ? 3 : 2;
          continue;
        }
        endCommand(false);
        this.#i += src[this.#i + 1] === '&' ? 2 : 1;
        continue;
      }
      if (c === '|') {
        if (src[this.#i + 1] === '|') {
          endCommand(false);
          this.#i += 2;
          continue;
        }
        endCommand(true);
        nextPiped = true;
        this.#i += src[this.#i + 1] === '&' ? 2 : 1;
        continue;
      }
      if (c === '(') {
        endCommand(false);
        parens += 1;
        this.#i += 1;
        continue;
      }
      if (c === ')') {
        endCommand(false);
        this.#i += 1;
        if (parens > 0) {
          parens -= 1;
          continue;
        }
        if (closing) return this.#i;
        this.#state.uncertain.push('a parenthesis is not balanced');
        continue;
      }
      if (c === '<' || c === '>') {
        if (src[this.#i + 1] === '(') {
          const builder = ensureWord();
          builder.plainName = false;
          builder.substitution = true;
          builder.text += `${c}(…)`;
          this.#i = this.#nested(this.#i + 2, 'process-substitution', builder);
          continue;
        }
        let fd: string | null = null;
        const current = word as WordBuilder | null;
        if (current && !current.quoted && /^[0-9]+$/.test(current.text)) {
          fd = current.text;
          word = null;
        } else {
          endWord();
        }
        const rest = src.slice(this.#i, this.#i + 3);
        const ops = c === '>' ? ['>>', '>&', '>|', '>'] : ['<<<', '<<-', '<<', '<&', '<>', '<'];
        const op = ops.find((candidate) => rest.startsWith(candidate))!;
        pendingRedirect = { op, fd };
        this.#i += op.length;
        continue;
      }
      if ((c === '{' || c === '}') && !word) {
        const next = src[this.#i + 1];
        if (next === undefined || /[\s;]/.test(next)) {
          // Group braces: only the commands inside matter.
          endCommand(false);
          this.#i += 1;
          continue;
        }
      }

      const builder = ensureWord();
      if (c === '~' && builder.text === '' && !builder.quoted) builder.tilde = true;
      if (c === '*' || c === '?' || c === '[') builder.glob = true;
      if (c === '{') builder.sawBrace = true;
      append(c, false);
      this.#i += 1;
    }

    endCommand(false);
    if (closing) this.#state.uncertain.push('a command substitution is not closed');
    if (parens > 0) this.#state.uncertain.push('a parenthesis is not closed');
    if (heredocs.length > 0) this.#state.uncertain.push('a here-document has no body');
    return this.#i;
  }

  #ansiEnd(from: number): number {
    const src = this.#src;
    let k = from;
    while (k < src.length) {
      if (src[k] === '\\') k += 2;
      else if (src[k] === "'") return k;
      else k += 1;
    }
    this.#state.uncertain.push('a quote is not closed');
    return src.length;
  }

  #doubleQuoted(from: number, builder: WordBuilder): number {
    const src = this.#src;
    let k = from;
    while (k < src.length) {
      const c = src[k]!;
      if (c === '"') return k + 1;
      if (c === '\\') {
        const next = src[k + 1];
        if (next === undefined) break;
        if (next === '\n') {
          k += 2;
          continue;
        }
        builder.text += '$`"\\'.includes(next) ? next : `\\${next}`;
        k += 2;
        continue;
      }
      if (c === '$') {
        k = this.#expansion(k, builder);
        continue;
      }
      if (c === '`') {
        k = this.#backticks(k, builder);
        continue;
      }
      builder.text += c;
      k += 1;
    }
    this.#state.uncertain.push('a quote is not closed');
    return src.length;
  }

  /** Handles what follows a `$`. Returns the index after the expansion. */
  #expansion(at: number, builder: WordBuilder): number {
    const src = this.#src;
    const next = src[at + 1];
    if (next === '(') {
      if (src[at + 2] === '(') {
        // Arithmetic: no command runs unless it nests a substitution.
        let depth = 0;
        let k = at + 1;
        for (; k < src.length; k += 1) {
          if (src[k] === '(') depth += 1;
          else if (src[k] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const body = src.slice(at, k + 1);
        if (k >= src.length) this.#state.uncertain.push('an arithmetic expansion is not closed');
        if (/\$\(|`/.test(body.slice(3))) this.#state.uncertain.push('a substitution hides inside arithmetic');
        builder.variables.push('((…))');
        builder.text += body;
        return Math.min(k + 1, src.length);
      }
      builder.substitution = true;
      builder.text += '$(…)';
      return this.#nested(at + 2, 'substitution', builder);
    }
    if (next === '{') {
      let depth = 0;
      let k = at + 1;
      for (; k < src.length; k += 1) {
        if (src[k] === '{') depth += 1;
        else if (src[k] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (k >= src.length) this.#state.uncertain.push('a variable expansion is not closed');
      const body = src.slice(at + 2, k);
      const name = /^[!#]?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(body)?.[1] ?? '?';
      builder.variables.push(name);
      // Anything beyond a bare name (defaults, substring, indirection) can produce arbitrary text.
      if (body !== name) builder.variables.push('?');
      if (/\$\(|`/.test(body)) {
        builder.substitution = true;
        this.#state.uncertain.push('a substitution hides inside a variable expansion');
      }
      builder.text += src.slice(at, k + 1);
      return Math.min(k + 1, src.length);
    }
    const named = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(at + 1, at + 200));
    if (named) {
      builder.variables.push(named[0]);
      builder.text += `$${named[0]}`;
      return at + 1 + named[0].length;
    }
    if (next !== undefined && /[0-9@*#?$!_-]/.test(next)) {
      builder.variables.push(next);
      builder.text += `$${next}`;
      return at + 2;
    }
    builder.text += '$';
    return at + 1;
  }

  #backticks(at: number, builder: WordBuilder): number {
    const src = this.#src;
    let k = at + 1;
    let body = '';
    let closed = false;
    while (k < src.length) {
      const c = src[k]!;
      if (c === '\\' && k + 1 < src.length) {
        const next = src[k + 1]!;
        body += '`\\$'.includes(next) ? next : `\\${next}`;
        k += 2;
        continue;
      }
      if (c === '`') {
        closed = true;
        k += 1;
        break;
      }
      body += c;
      k += 1;
    }
    if (!closed) this.#state.uncertain.push('a backtick substitution is not closed');
    builder.substitution = true;
    builder.text += '`…`';
    this.#parseSeparately(body, 'substitution', builder);
    return k;
  }

  #nested(from: number, origin: ShellCommand['origin'], builder: WordBuilder): number {
    if (this.#depth >= MAX_DEPTH) {
      this.#state.uncertain.push('substitutions are nested too deeply');
      return this.#src.length;
    }
    const before = this.#state.commands.length;
    const end = new Reader(this.#src, from, origin, this.#state, this.#depth + 1).read(true);
    builder.nested.push(...this.#state.commands.slice(before));
    return end;
  }

  #parseSeparately(text: string, origin: ShellCommand['origin'], builder: WordBuilder): void {
    if (this.#depth >= MAX_DEPTH) {
      this.#state.uncertain.push('substitutions are nested too deeply');
      return;
    }
    const before = this.#state.commands.length;
    new Reader(text, 0, origin, this.#state, this.#depth + 1).read(false);
    builder.nested.push(...this.#state.commands.slice(before));
  }

  #skipHeredoc(heredoc: { delimiter: string; stripTabs: boolean; redirect: ShellRedirect }): void {
    const src = this.#src;
    const lines: string[] = [];
    heredoc.redirect.body = '';
    while (this.#i < src.length) {
      const end = src.indexOf('\n', this.#i);
      const line = src.slice(this.#i, end === -1 ? src.length : end);
      this.#i = end === -1 ? src.length : end + 1;
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
        heredoc.redirect.body = lines.join('\n');
        return;
      }
      lines.push(line);
    }
    heredoc.redirect.body = lines.join('\n');
    this.#state.uncertain.push('a here-document is not terminated');
  }
}

export function parseShell(source: string, origin: ShellCommand['origin'] = 'top'): ParsedShell {
  const state: State = { commands: [], uncertain: [] };
  if (source.length > MAX_LENGTH) {
    state.uncertain.push('the command is too long to read');
    return state;
  }
  if (source.includes('\0')) state.uncertain.push('the command contains a NUL byte');
  new Reader(source, 0, origin, state, 0).read(false);
  return state;
}

/** A command as one line of text with quotes removed and single spaces: what rules are matched against. */
export function commandText(command: ShellCommand, options: { withAssignments?: boolean } = {}): string {
  const parts: string[] = [];
  if (options.withAssignments !== false) {
    for (const assignment of command.assignments) parts.push(`${assignment.name}=${assignment.value.text}`);
  }
  for (const word of command.words) parts.push(word.text);
  return parts.join(' ');
}
