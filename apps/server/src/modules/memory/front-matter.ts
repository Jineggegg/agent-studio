/**
 * The on-disk format of a note: a plain Markdown file a person can open in any
 * editor.
 *
 *     ---
 *     title: Deploy rules
 *     tags: [deploy, ops]
 *     author: claude-code
 *     created: 2026-01-05T09:30:00.000Z
 *     updated: 2026-01-07T16:02:11.000Z
 *     ---
 *
 *     Releases go out on Tuesdays…
 *
 *     Keywords: 部署 发布 release
 *
 * **The metadata header** is optional. It is recognised only when the very
 * first line is `---` and a later line (within the first 200 lines / 16 000
 * characters) is `---` or `...`. Between them this small subset of YAML is
 * understood, and nothing else:
 *
 * - `key: value` — the value is the rest of the line, taken literally (no
 *   type guessing, no `#` comments after a value). A value in double quotes is
 *   read as a JSON string; in single quotes `''` stands for one quote.
 * - `key: [a, "b, c", d]` — a list on one line.
 * - `key:` followed by `- item` lines — a list, one item per line.
 * - blank lines and whole-line `#` comments.
 *
 * `title`, `tags`, `author`, `created` and `updated` are used. Any other key
 * is kept exactly as written and put back when the product saves the note.
 * If the header contains anything outside this subset (nested maps, block
 * scalars, continuation lines), **the whole file is treated as body text**: no
 * metadata is taken from it and nothing in it is lost or rewritten.
 *
 * **The keyword line** is optional: when the last non-empty line of the body
 * reads `Keywords: word word …` (or `关键词：…`), those words are the note's
 * search keywords and the line is not part of the body. Keywords keep text in
 * scripts without word spacing findable by short words.
 *
 * Line endings are read as written (LF, CRLF or CR) and written as LF. A
 * byte-order mark is ignored. A file that is not valid UTF-8 text is not
 * parsed at all — see {@link parseNoteFile}.
 */

/** Files larger than this are listed but not read. */
export const MAX_NOTE_FILE_BYTES = 1024 * 1024;

const MAX_HEADER_LINES = 200;
const MAX_HEADER_CHARS = 16_000;
const MAX_LIST_ITEMS = 64;
const MAX_SCALAR_CHARS = 400;

export interface NoteDocument {
  /** From the header; null when there is none. */
  title: string | null;
  tags: string[];
  author: string | null;
  /** Milliseconds since the epoch, or null when absent or unreadable. */
  created: number | null;
  updated: number | null;
  /** Header lines this product does not use, verbatim, in order. */
  extra: string[];
  /** Markdown without the header and the keyword line. LF line endings, no surrounding blank lines. */
  body: string;
  keywords: string[];
}

export type ParsedFile = { ok: true; note: NoteDocument } | { ok: false; reason: 'not_text' | 'too_large' };

const KEYWORD_LINE = /^[ \t]{0,3}(?:keywords?|关键词|关键字)[ \t]*[:：][ \t]*(\S.*)$/iu;
const KEYWORD_SEPARATORS = /[\s,，、;；]+/u;

/** Decodes a note file. Anything that is not UTF-8 text is reported, never guessed at. */
export function parseNoteFile(bytes: Uint8Array): ParsedFile {
  if (bytes.byteLength > MAX_NOTE_FILE_BYTES) return { ok: false, reason: 'too_large' };
  if (bytes.includes(0)) return { ok: false, reason: 'not_text' };
  let text: string;
  try {
    // `fatal` refuses malformed sequences instead of replacing them; the BOM is dropped by the decoder.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'not_text' };
  }
  return { ok: true, note: parseNoteText(text) };
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not a JSON string: fall through and take what is between the quotes.
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Splits `a, "b, c", 'd'` on the commas that are outside quotes. */
function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]!;
    if (quote) {
      current += character;
      if (character === '\\' && quote === '"' && index + 1 < inner.length) {
        index += 1;
        current += inner[index]!;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === ',') {
      items.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map(parseScalar).filter((item) => item.length > 0);
}

function parseList(rawValue: string, blockItems: string[] | null): string[] {
  if (blockItems) return blockItems.map(parseScalar).filter((item) => item.length > 0).slice(0, MAX_LIST_ITEMS);
  const value = rawValue.trim();
  if (value === '' || value === '[]') return [];
  if (value.startsWith('[') && value.endsWith(']')) return splitFlowItems(value.slice(1, -1)).slice(0, MAX_LIST_ITEMS);
  // `tags: a, b` — not strictly a list, but what people write.
  return splitFlowItems(value).slice(0, MAX_LIST_ITEMS);
}

function parseTime(raw: string): number | null {
  const value = parseScalar(raw);
  if (value === '' || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}

interface Header {
  title: string | null;
  tags: string[];
  author: string | null;
  created: number | null;
  updated: number | null;
  extra: string[];
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/;

/** Reads the header lines. Returns null when they go beyond the supported subset. */
function parseHeader(lines: readonly string[]): Header | null {
  const header: Header = { title: null, tags: [], author: null, created: null, updated: null, extra: [] };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    if (line.trim() === '') continue;
    if (line.startsWith('#')) {
      header.extra.push(line);
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (!match) return null;
    const key = match[1]!;
    const rawValue = (match[2] ?? '').trim();

    let blockItems: string[] | null = null;
    const blockLines: string[] = [];
    if (rawValue === '') {
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]!);
        if (!item) break;
        (blockItems ??= []).push(item[1]!);
        blockLines.push(lines[index]!);
        index += 1;
      }
    } else if (rawValue === '|' || rawValue === '>' || /^[|>][+-]?$/.test(rawValue) || rawValue.startsWith('{') || rawValue.startsWith('&') || rawValue.startsWith('*')) {
      // Block scalars, inline maps, anchors and aliases are outside the subset.
      return null;
    }

    switch (key) {
      case 'title':
        if (blockItems) return null;
        header.title = parseScalar(rawValue).replace(/\s+/g, ' ').trim().slice(0, MAX_SCALAR_CHARS) || null;
        break;
      case 'tags':
        header.tags = parseList(rawValue, blockItems);
        break;
      case 'author':
        if (blockItems) return null;
        header.author = parseScalar(rawValue).slice(0, MAX_SCALAR_CHARS) || null;
        break;
      case 'created':
        if (blockItems) return null;
        header.created = parseTime(rawValue);
        break;
      case 'updated':
        if (blockItems) return null;
        header.updated = parseTime(rawValue);
        break;
      default:
        header.extra.push(line, ...blockLines);
    }
  }
  return header;
}

/**
 * Finds the header. Returns the lines between the fences and the offset at
 * which the body starts, or null when the text does not open with a header.
 * Only looks at the start of the text, so its cost does not grow with the body.
 */
function splitHeader(text: string): { lines: string[]; bodyStart: number } | null {
  if (!text.startsWith('---')) return null;
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1 || firstBreak > 64 || text.slice(0, firstBreak).trimEnd() !== '---') return null;
  const lines: string[] = [];
  let position = firstBreak + 1;
  while (lines.length <= MAX_HEADER_LINES && position <= MAX_HEADER_CHARS && position <= text.length) {
    let lineEnd = text.indexOf('\n', position);
    if (lineEnd === -1) lineEnd = text.length;
    // A line longer than the whole header may be is not a header line.
    if (lineEnd - position > MAX_HEADER_CHARS) return null;
    const line = text.slice(position, lineEnd).trimEnd();
    if (line === '---' || line === '...') return { lines, bodyStart: Math.min(lineEnd + 1, text.length) };
    lines.push(line);
    if (lineEnd === text.length) return null;
    position = lineEnd + 1;
  }
  return null;
}

/**
 * Drops trailing white space and leading blank lines (indentation of the
 * first line of text is kept — it can be an indented code block). Written
 * without regular expressions so that a huge run of spaces costs nothing.
 */
export function trimBlankEdges(text: string): string {
  const end = text.trimEnd();
  let start = 0;
  for (;;) {
    let cursor = start;
    while (cursor < end.length && (end[cursor] === ' ' || end[cursor] === '\t')) cursor += 1;
    if (cursor < end.length && end[cursor] === '\n') start = cursor + 1;
    else break;
  }
  return start === 0 ? end : end.slice(start);
}

/**
 * Takes a trailing keyword line off a body. The body comes back without it
 * and without surrounding blank lines.
 */
export function splitKeywordLine(body: string): { body: string; keywords: string[] } {
  const trimmed = trimBlankEdges(body);
  const lastBreak = trimmed.lastIndexOf('\n');
  const lastLine = trimmed.slice(lastBreak + 1);
  // The keyword line is short by nature; a huge last line is body text.
  if (lastLine.length > 2_000) return { body: trimmed, keywords: [] };
  const match = KEYWORD_LINE.exec(lastLine);
  if (!match) return { body: trimmed, keywords: [] };
  const keywords = match[1]!.split(KEYWORD_SEPARATORS).filter((word) => word.length > 0);
  if (keywords.length === 0) return { body: trimmed, keywords: [] };
  return { body: lastBreak === -1 ? '' : trimmed.slice(0, lastBreak).trimEnd(), keywords };
}

/** Reads a note from text. Never throws; text that does not follow the format is simply all body. */
export function parseNoteText(input: string): NoteDocument {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');

  let header: Header | null = null;
  let bodyText = text;
  const split = splitHeader(text);
  if (split) {
    header = parseHeader(split.lines);
    if (header) bodyText = text.slice(split.bodyStart);
  }
  const { body, keywords } = splitKeywordLine(bodyText);
  return {
    title: header?.title ?? null,
    tags: header?.tags ?? [],
    author: header?.author ?? null,
    created: header?.created ?? null,
    updated: header?.updated ?? null,
    extra: header?.extra ?? [],
    body,
    keywords,
  };
}

/** Values a YAML reader would not take as plain text, or that this parser treats specially. */
const NEEDS_QUOTES = /^(?:true|false|null|yes|no|on|off|~|[-+.]?\d[\d_.,:eE+-]*)$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_PLAIN = /[\u0000-\u001f\u007f\u0085\u2028\u2029]|: |:$| #/;

function emitScalar(value: string): string {
  const plain =
    value.length > 0 &&
    value.trim() === value &&
    /^[\p{L}\p{N}_(]/u.test(value) &&
    !UNSAFE_IN_PLAIN.test(value) &&
    !NEEDS_QUOTES.test(value);
  return plain ? value : JSON.stringify(value);
}

function emitListItem(value: string): string {
  return /^[\p{L}\p{N}\p{M}_-]+$/u.test(value) && !NEEDS_QUOTES.test(value) ? value : JSON.stringify(value);
}

export interface NoteDraft {
  title: string;
  tags: readonly string[];
  author: string | null;
  created: number;
  updated: number;
  extra?: readonly string[];
  body: string;
  keywords: readonly string[];
}

/**
 * Writes a note. A header is always written, so a body that itself starts
 * with `---` can never be mistaken for one.
 */
export function serialiseNote(draft: NoteDraft): string {
  const lines = ['---', `title: ${emitScalar(draft.title.replace(/\s+/g, ' ').trim())}`];
  lines.push(`tags: [${draft.tags.map(emitListItem).join(', ')}]`);
  if (draft.author) lines.push(`author: ${emitScalar(draft.author)}`);
  lines.push(`created: ${new Date(draft.created).toISOString()}`);
  lines.push(`updated: ${new Date(draft.updated).toISOString()}`);
  for (const line of draft.extra ?? []) {
    // Kept lines came from a header, so none of them can be a fence; make sure of it.
    const kept = line.replace(/\r?\n/g, ' ');
    if (kept.trimEnd() !== '---' && kept.trimEnd() !== '...') lines.push(kept);
  }
  lines.push('---', '');
  const body = trimBlankEdges(draft.body.replace(/\r\n?/g, '\n'));
  if (body) lines.push(body, '');
  if (draft.keywords.length > 0) lines.push(`Keywords: ${draft.keywords.join(' ')}`, '');
  return lines.join('\n');
}
