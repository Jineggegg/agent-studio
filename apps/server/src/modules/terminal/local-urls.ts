import { StringDecoder } from 'node:string_decoder';
import type { TerminalLocalUrl } from '@agent-studio/protocol';

/**
 * Recognises the addresses of local development servers in terminal output
 * ("Local: http://localhost:5173/") so that a client can offer a shortcut to
 * preview them. Detection only: nothing here connects anywhere.
 *
 * Output arrives as arbitrary byte chunks decorated with colour codes, so the
 * scanner decodes incrementally, removes terminal control sequences with a
 * small state machine that survives chunk boundaries, and keeps the unfinished
 * tail of the text until the rest of an address has arrived.
 */

const MAX_URL_LENGTH = 2048;
const MAX_SEQUENCE_LENGTH = 4096;
const SCHEMES = ['http://', 'https://'] as const;

type StripState = 'text' | 'escape' | 'intermediate' | 'csi' | 'osc' | 'osc-escape' | 'string' | 'string-escape';

/** Removes terminal control sequences from text, remembering its place between calls. */
export class ControlSequenceStripper {
  #state: StripState = 'text';
  #sequenceLength = 0;
  #payload = '';
  #links: string[] = [];

  push(text: string): string {
    let out = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]!;
      const code = text.charCodeAt(index);
      switch (this.#state) {
        case 'text':
          if (code === 0x1b) this.#enter('escape');
          else if (code === 0x9b) this.#enter('csi');
          else if (code === 0x9d) this.#enter('osc');
          else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) this.#enter('string');
          // Line breaks and tabs separate words; every other control character prints nothing.
          else if (code === 0x0a || code === 0x0d || code === 0x09 || !(code < 0x20 || (code >= 0x7f && code <= 0x9f))) out += char;
          break;
        case 'escape':
          this.#afterEscape(char, code);
          break;
        case 'intermediate':
          if (code < 0x20 || code > 0x2f) this.#state = 'text';
          break;
        case 'csi':
          if (code === 0x1b) this.#enter('escape');
          else if (code >= 0x40 && code <= 0x7e) this.#state = 'text';
          else if (++this.#sequenceLength > 256) this.#state = 'text';
          break;
        case 'osc':
          if (code === 0x07 || code === 0x9c) this.#finishOsc();
          else if (code === 0x1b) this.#state = 'osc-escape';
          else if (++this.#sequenceLength > MAX_SEQUENCE_LENGTH) this.#state = 'text';
          else this.#payload += char;
          break;
        case 'osc-escape':
          if (char === '\\') this.#finishOsc();
          else this.#afterEscape(char, code); // the string was abandoned for a new sequence
          break;
        case 'string':
          if (code === 0x9c) this.#state = 'text';
          else if (code === 0x1b) this.#state = 'string-escape';
          else if (++this.#sequenceLength > MAX_SEQUENCE_LENGTH) this.#state = 'text';
          break;
        case 'string-escape':
          if (char === '\\') this.#state = 'text';
          else this.#afterEscape(char, code);
          break;
      }
    }
    return out;
  }

  /** Targets of terminal hyperlinks (OSC 8) seen since the last call. */
  takeLinks(): string[] {
    const links = this.#links;
    this.#links = [];
    return links;
  }

  #enter(state: StripState): void {
    this.#state = state;
    this.#sequenceLength = 0;
    this.#payload = '';
  }

  #afterEscape(char: string, code: number): void {
    if (char === '[') this.#enter('csi');
    else if (char === ']') this.#enter('osc');
    else if (char === 'P' || char === 'X' || char === '^' || char === '_') this.#enter('string');
    else if (code >= 0x20 && code <= 0x2f) this.#enter('intermediate');
    else if (code === 0x1b) this.#enter('escape');
    else this.#state = 'text'; // a two-character sequence such as ESC 7
  }

  #finishOsc(): void {
    this.#state = 'text';
    const match = /^8;[^;]*;(.+)$/.exec(this.#payload);
    if (match && match[1]!.length <= MAX_URL_LENGTH && this.#links.length < 16) this.#links.push(match[1]!);
    this.#payload = '';
  }
}

function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)) return true;
  return host === '[::1]' || host === '[::]' || host === '[0:0:0:0:0:0:0:1]';
}

/** Punctuation that ends a sentence or closes a bracket around an address rather than belonging to it. */
function trimTrailingPunctuation(path: string): string {
  let end = path.length;
  while (end > 0) {
    const last = path[end - 1]!;
    if ('.,;:!?\'"*'.includes(last)) end -= 1;
    else if (last === ')' && !path.slice(0, end - 1).includes('(')) end -= 1;
    else if (last === ']' && !path.slice(0, end - 1).includes('[')) end -= 1;
    else if (last === '}' && !path.slice(0, end - 1).includes('{')) end -= 1;
    else break;
  }
  return path.slice(0, end);
}

const SHAPE = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?([/?#].*)?$/i;

/**
 * Interprets one candidate address. Returns null unless it is an http(s)
 * address of this computer: `localhost` (or a name under it), `127.x.x.x`,
 * `0.0.0.0`, `[::1]` or `[::]`.
 */
export function parseLocalUrl(candidate: string): TerminalLocalUrl | null {
  if (candidate.length > MAX_URL_LENGTH) return null;
  const match = SHAPE.exec(candidate);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase() as 'http' | 'https';
  const host = match[2]!.toLowerCase().replace(/\.+$/, '');
  if (!isLocalHost(host)) return null;
  const port = match[3] === undefined ? (scheme === 'https' ? 443 : 80) : Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const path = trimTrailingPunctuation(match[4] ?? '');
  return { url: `${scheme}://${host}${match[3] === undefined ? '' : `:${port}`}${path}`, scheme, host, port };
}

// scheme, host (name, IPv4 or bracketed IPv6), optional port, optional path/query/fragment.
const CANDIDATE =
  // eslint-disable-next-line no-control-regex
  /https?:\/\/(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::\d{1,5})?(?:[/?#][^\s"'<>`\u0000-\u001f\u007f]*)?/gi;

/** A character that would make the text after the host or port part of a longer, different name. */
const CONTINUES_AUTHORITY = /[A-Za-z0-9_@:%~+=&$-]/;

/** What cannot be part of an address: white space, quotes, angle brackets, control characters. */
// eslint-disable-next-line no-control-regex
const WORD_END = /[\s"'<>`\u0000-\u001f\u007f]/;

function partialSchemeLength(text: string): number {
  const tail = text.slice(-8).toLowerCase();
  for (let length = tail.length; length > 0; length -= 1) {
    const suffix = tail.slice(-length);
    if (SCHEMES.some((scheme) => scheme.startsWith(suffix))) return length;
  }
  return 0;
}

export class LocalUrlScanner {
  readonly #decoder = new StringDecoder('utf8');
  readonly #stripper = new ControlSequenceStripper();
  readonly #seen = new Map<string, TerminalLocalUrl>();
  readonly #maxUrls: number;
  /** Cleaned text that may still be the beginning of an address. */
  #carry = '';

  constructor(options: { maxUrls?: number } = {}) {
    this.#maxUrls = options.maxUrls ?? 64;
  }

  /** Every address seen so far, oldest first. */
  get urls(): TerminalLocalUrl[] {
    return [...this.#seen.values()];
  }

  /** Feeds output. Returns the addresses seen for the first time. */
  push(chunk: Uint8Array): TerminalLocalUrl[] {
    const decoded = this.#decoder.write(chunk);
    if (decoded.length === 0) return [];
    const clean = this.#stripper.push(decoded);
    const found: TerminalLocalUrl[] = [];
    for (const link of this.#stripper.takeLinks()) this.#remember(parseLocalUrl(link), found);
    if (clean.length > 0) {
      this.#carry += clean;
      this.#scan(false, found);
    }
    return found;
  }

  /**
   * Call when output has paused: an address that sits at the very end of the
   * output, with nothing after it, is then taken as complete.
   */
  flush(): TerminalLocalUrl[] {
    const found: TerminalLocalUrl[] = [];
    this.#scan(true, found);
    return found;
  }

  #scan(final: boolean, found: TerminalLocalUrl[]): void {
    const text = this.#carry;
    let keepFrom = text.length;
    for (const match of text.matchAll(CANDIDATE)) {
      const start = match.index;
      const end = start + match[0].length;
      // The word this candidate belongs to is still open when nothing that ends
      // a word follows it yet: "http://localhost:" may become "http://localhost:5173/".
      const open = text.slice(end).search(WORD_END) === -1;
      if (open && !final) {
        keepFrom = start;
        break;
      }
      const next = text[end];
      const hasPath = /^https?:\/\/[^/?#]+[/?#]/i.test(match[0]);
      const isWholeAuthority = hasPath || next === undefined || !CONTINUES_AUTHORITY.test(next);
      if (isWholeAuthority) this.#remember(parseLocalUrl(match[0]), found);
      if (open) {
        keepFrom = start; // judged because output paused, yet it may still grow
        break;
      }
    }
    if (keepFrom === text.length) keepFrom = text.length - partialSchemeLength(text);
    this.#carry = text.slice(Math.max(keepFrom, text.length - MAX_URL_LENGTH));
  }

  #remember(url: TerminalLocalUrl | null, found: TerminalLocalUrl[]): void {
    if (!url || this.#seen.has(url.url) || this.#seen.size >= this.#maxUrls) return;
    this.#seen.set(url.url, url);
    found.push(url);
  }
}
