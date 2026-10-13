/**
 * Text that the server types into a terminal on a user's behalf: the "run"
 * button next to a command in a chat message.
 *
 * The text comes from a conversation, so it is untrusted: it must not be able
 * to press Enter, to send a control key (Ctrl+C, Ctrl+D, Escape and so on), to
 * start an escape sequence, or to look different on screen from what the
 * shell will receive. Everything it is allowed to do is "appear on the
 * command line"; the user reads it there and decides whether to press Enter.
 */

export interface TypedText {
  /** What will be typed. Never contains a control character other than tab. */
  readonly text: string;
  /** How many characters were taken out. */
  readonly removed: number;
  /** The text had more than one line; nothing should be typed. */
  readonly multiline: boolean;
}

const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;
const NEXT_LINE = 0x85;

/** Carriage return, line feed, and the Unicode characters that also end a line. */
function isLineBreak(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === NEXT_LINE || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

function isForbidden(code: number): boolean {
  if (code === 0x09) return false; // tab is allowed
  if (code < 0x20 || code === 0x7f) return true; // C0 controls: Enter, Escape, Ctrl+letter, delete
  if (code >= 0x80 && code <= 0x9f) return true; // C1 controls, including the one-byte CSI
  if (code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) return true;
  // Characters that reorder or hide text on screen without changing what the shell receives.
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  if (code === 0xfeff) return true;
  // A lone surrogate is not a character; it would be sent as a replacement mark.
  return code >= 0xd800 && code <= 0xdfff;
}

/**
 * Prepares text for typing. Line breaks at the end are dropped (Enter is the
 * user's to press); a line break anywhere else marks the text as multi-line,
 * because joining two commands into one would change what they do.
 */
export function sanitizeTypedText(input: string): TypedText {
  let end = input.length;
  while (end > 0 && isLineBreak(input.charCodeAt(end - 1))) end -= 1;
  const body = input.slice(0, end);

  let text = '';
  let removed = input.length - body.length;
  let multiline = false;
  for (const char of body) {
    const code = char.codePointAt(0)!;
    if (isLineBreak(code)) multiline = true;
    if (isForbidden(code)) removed += char.length;
    else text += char;
  }
  return { text, removed, multiline };
}
