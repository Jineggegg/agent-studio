/**
 * "@" in the message field: typing `@app` offers the project's files whose
 * names match, and choosing one puts its path where the `@app` was. Pure
 * text handling; the composer supplies the caret and the search.
 */
export interface MentionToken {
  /** Index of the "@". */
  start: number;
  /** Index just past the last character of the token (where the caret is). */
  end: number;
  /** What follows the "@", up to the caret. May be empty. */
  query: string;
}

export const MENTION_QUERY_MAX = 200;

/**
 * The mention being typed at `caret`, if any. A mention starts with an "@"
 * that opens the text or follows white space — so the "@" of an e-mail
 * address or a package name (`a@b`, `@scope/pkg` is fine, `pkg@1.2` is not) does not
 * open the picker — and runs to the caret without white space.
 */
export function mentionAt(text: string, caret: number): MentionToken | null {
  if (caret < 1 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  if (text[start] !== '@') return null;
  const query = text.slice(start + 1, caret);
  if (query.length > MENTION_QUERY_MAX || query.includes('@')) return null;
  return { start, end: caret, query };
}

/** Replaces the mention with the chosen path and a space, and says where the caret belongs afterwards. */
export function insertMention(text: string, token: MentionToken, path: string): { text: string; caret: number } {
  // The rest of a word the caret was in the middle of goes too: "@ap|p" becomes the path, not "path p".
  let end = token.end;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const inserted = `${path} `;
  const after = text.slice(end);
  return { text: text.slice(0, token.start) + inserted + (after.startsWith(' ') ? after.slice(1) : after), caret: token.start + inserted.length };
}

export interface MentionMatch {
  path: string;
  name: string;
  kind: 'file' | 'directory';
}

export interface MentionSource {
  /** The project's files whose names match, best first. At most ten are shown. */
  search: (query: string, signal: AbortSignal) => Promise<readonly MentionMatch[]>;
}
