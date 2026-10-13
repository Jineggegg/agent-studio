/**
 * Writing values for the Codex CLI's `-c key=value` overrides.
 *
 * The CLI parses the value part as TOML and — this is the trap — silently
 * falls back to "the raw text is the string" when it does not parse. A path
 * with a quote in it would therefore not fail: it would become a different
 * value. So every string goes out as a TOML basic string with everything
 * awkward escaped, and nothing is ever passed bare.
 *
 * Checked against codex-cli 0.160.0 by reading the values back through the
 * app-server's `config/read` (spaces, both kinds of quote, backslashes, `=`,
 * `]`, `#`, newlines, tabs, `$(…)`, non-ASCII text, an empty string).
 */

/** A TOML basic string: `"…"` with `"`, `\` and every control character escaped. */
export function tomlString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') out += '\\"';
    else if (character === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    // A lone surrogate is not a character at all; TOML has no way to write one.
    else if (code >= 0xd800 && code <= 0xdfff) out += '\\ufffd';
    else out += character;
  }
  return `${out}"`;
}

export function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

export const tomlBoolean = (value: boolean): string => (value ? 'true' : 'false');

/**
 * An inline table. Keys are always quoted, so a key may be a path or contain
 * dots; `values` are already-encoded TOML values.
 */
export function tomlInlineTable(entries: ReadonlyArray<readonly [key: string, encodedValue: string]>): string {
  return `{${entries.map(([key, value]) => `${tomlString(key)} = ${value}`).join(', ')}}`;
}

const PLAIN_KEY = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * One `-c` override as two arguments. `key` is a dotted path of plain
 * segments; anything else (a path, a name with a dot) has to be written as an
 * inline table on a plain parent key, because the CLI does not unquote key
 * segments.
 */
export function configOverride(key: string, encodedValue: string): [string, string] {
  if (!PLAIN_KEY.test(key)) throw new Error(`"${key}" cannot be used as a Codex configuration key.`);
  return ['-c', `${key}=${encodedValue}`];
}
