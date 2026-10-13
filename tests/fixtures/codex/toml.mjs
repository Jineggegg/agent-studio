/*
 * The small part of TOML the Codex stand-in needs: the values of `-c key=value`
 * overrides (strings, booleans, numbers, arrays, inline tables) and simple
 * configuration files (`[table."sub table"]` headers and `key = value` lines).
 *
 * It is strict about strings on purpose. The Studio's adapter has to quote
 * hostile paths correctly for the real CLI; a parser that forgave sloppy
 * quoting would let a quoting bug pass the tests.
 */

class TomlError extends Error {}

function parser(text) {
  let at = 0;
  const peek = () => text[at];
  const fail = (what) => {
    throw new TomlError(`${what} at ${at}`);
  };
  const skipSpace = () => {
    while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at += 1;
  };
  const skipBlank = () => {
    for (;;) {
      while (at < text.length && /[ \t\r\n]/.test(text[at])) at += 1;
      if (text[at] !== '#') return;
      while (at < text.length && text[at] !== '\n') at += 1;
    }
  };

  function basicString() {
    at += 1;
    let out = '';
    for (;;) {
      if (at >= text.length) fail('unterminated string');
      const character = text[at];
      const code = character.codePointAt(0);
      if (character === '"') {
        at += 1;
        return out;
      }
      if (code < 0x20 && character !== '\t') fail('control character in string');
      if (code === 0x7f) fail('control character in string');
      if (character !== '\\') {
        out += character;
        at += 1;
        continue;
      }
      const escape = text[at + 1];
      at += 2;
      if (escape === 'b') out += '\b';
      else if (escape === 't') out += '\t';
      else if (escape === 'n') out += '\n';
      else if (escape === 'f') out += '\f';
      else if (escape === 'r') out += '\r';
      else if (escape === 'e') out += '\u001b';
      else if (escape === '"') out += '"';
      else if (escape === '\\') out += '\\';
      else if (escape === 'u' || escape === 'U') {
        const length = escape === 'u' ? 4 : 8;
        const hex = text.slice(at, at + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail('bad unicode escape');
        const value = Number.parseInt(hex, 16);
        if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) fail('escape is not a character');
        out += String.fromCodePoint(value);
        at += length;
      } else fail('unknown escape');
    }
  }

  function literalString() {
    const end = text.indexOf("'", at + 1);
    if (end === -1) fail('unterminated string');
    const out = text.slice(at + 1, end);
    if (out.includes('\n')) fail('newline in string');
    at = end + 1;
    return out;
  }

  function key() {
    skipSpace();
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(at));
    if (!match) fail('expected a key');
    at += match[0].length;
    return match[0];
  }

  function dottedKey() {
    const parts = [key()];
    for (;;) {
      skipSpace();
      if (peek() !== '.') return parts;
      at += 1;
      parts.push(key());
    }
  }

  function value() {
    skipSpace();
    const character = peek();
    if (character === '"') {
      if (text.startsWith('"""', at)) fail('multi-line strings are not supported');
      return basicString();
    }
    if (character === "'") {
      if (text.startsWith("'''", at)) fail('multi-line strings are not supported');
      return literalString();
    }
    if (character === '[') {
      at += 1;
      const items = [];
      for (;;) {
        skipBlank();
        if (peek() === ']') {
          at += 1;
          return items;
        }
        items.push(value());
        skipBlank();
        if (peek() === ',') at += 1;
        else if (peek() !== ']') fail('expected , or ]');
      }
    }
    if (character === '{') {
      at += 1;
      const table = {};
      skipSpace();
      if (peek() === '}') {
        at += 1;
        return table;
      }
      for (;;) {
        const path = dottedKey();
        skipSpace();
        if (peek() !== '=') fail('expected =');
        at += 1;
        assign(table, path, value());
        skipSpace();
        if (peek() === ',') {
          at += 1;
          continue;
        }
        if (peek() === '}') {
          at += 1;
          return table;
        }
        fail('expected , or }');
      }
    }
    const word = /^[A-Za-z0-9_+.:-]+/.exec(text.slice(at));
    if (!word) fail('expected a value');
    at += word[0].length;
    if (word[0] === 'true') return true;
    if (word[0] === 'false') return false;
    if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(word[0])) return Number(word[0].replace(/_/g, ''));
    return fail('not a TOML value');
  }

  return {
    value,
    dottedKey,
    skipSpace,
    skipBlank,
    done: () => at >= text.length,
    peek,
    advance: () => {
      at += 1;
    },
    fail,
  };
}

export function assign(target, path, value) {
  let table = target;
  for (const part of path.slice(0, -1)) {
    if (table[part] === null || typeof table[part] !== 'object' || Array.isArray(table[part])) table[part] = {};
    table = table[part];
  }
  table[path[path.length - 1]] = value;
}

/** Deep-merges tables, the way Codex layers its configuration: later wins, tables are merged, everything else replaced. */
export function merge(base, over) {
  const out = { ...base };
  for (const [name, value] of Object.entries(over)) {
    const existing = out[name];
    const bothTables = value !== null && typeof value === 'object' && !Array.isArray(value) && existing !== null && typeof existing === 'object' && !Array.isArray(existing);
    out[name] = bothTables ? merge(existing, value) : value;
  }
  return out;
}

/** One TOML value, the whole text. Throws when it is not one. */
export function parseValue(text) {
  const read = parser(text.trim());
  const result = read.value();
  read.skipSpace();
  if (!read.done()) read.fail('unexpected text after the value');
  return result;
}

/**
 * A `-c key=value` override. Like the real CLI: the key is a dotted path of
 * plain segments (quotes in it are *not* interpreted), and a value that is
 * not TOML is taken as the literal string.
 */
export function parseOverride(argument) {
  const equals = argument.indexOf('=');
  if (equals <= 0) return null;
  const path = argument.slice(0, equals).trim().split('.');
  const raw = argument.slice(equals + 1);
  let value;
  try {
    value = parseValue(raw);
  } catch {
    value = raw;
  }
  return { path, value };
}

/** A configuration file. Throws on anything outside the supported subset. */
export function parseDocument(text) {
  const root = {};
  let table = root;
  const read = parser(text);
  for (;;) {
    read.skipBlank();
    if (read.done()) return root;
    if (read.peek() === '[') {
      read.advance();
      const path = read.dottedKey();
      read.skipSpace();
      if (read.peek() !== ']') read.fail('expected ]');
      read.advance();
      table = root;
      for (const part of path) {
        if (table[part] === null || typeof table[part] !== 'object') table[part] = {};
        table = table[part];
      }
      continue;
    }
    const path = read.dottedKey();
    read.skipSpace();
    if (read.peek() !== '=') read.fail('expected =');
    read.advance();
    assign(table, path, read.value());
  }
}
