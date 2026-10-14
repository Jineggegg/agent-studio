import type { TerminalLocalUrl } from '@agent-studio/protocol';

/**
 * What the phone's key bar sends, and how its sticky Ctrl and Alt change the
 * next key — whether that key comes from the bar or from the soft keyboard.
 * Pure functions: the bytes a terminal expects are a matter of convention,
 * and conventions are best pinned down by tests.
 */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false };

const ESC = '\u001b';

/** The control character Ctrl makes of a key, or null when Ctrl+that key means nothing to a terminal. */
export function controlCharacter(key: string): string | null {
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  const code = upper.charCodeAt(0);
  // Ctrl+@ … Ctrl+_ are the 32 control characters; Ctrl+A is 1, Ctrl+C is 3, Ctrl+[ is Escape.
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (key === ' ') return '\u0000';
  if (key === '?') return '\u007f';
  return null;
}

/**
 * Applies the sticky modifiers to what was just typed. Only a single key is
 * changed — pasted text and a word committed by an input method go through
 * as they are — and a key Ctrl cannot change is sent unchanged.
 */
export function applyModifiers(data: string, modifiers: Modifiers): string {
  if ((!modifiers.ctrl && !modifiers.alt) || [...data].length !== 1) return data;
  let out = data;
  if (modifiers.ctrl) out = controlCharacter(data) ?? data;
  // Alt is "Escape, then the key" — what a terminal calls Meta.
  if (modifiers.alt) out = ESC + out;
  return out;
}

export type ArrowKey = 'up' | 'down' | 'right' | 'left';
const ARROW_LETTER: Record<ArrowKey, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * An arrow key as the program expects it: `ESC [ A` normally, `ESC O A` while
 * a full-screen program has asked for "application" cursor keys, and the
 * xterm form `ESC [ 1 ; n A` when a modifier is held.
 */
export function arrowSequence(key: ArrowKey, modifiers: Modifiers, applicationMode: boolean): string {
  const letter = ARROW_LETTER[key];
  const code = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  if (code > 1) return `${ESC}[1;${code}${letter}`;
  return applicationMode ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

export const KEYS = {
  escape: ESC,
  tab: '\t',
  shiftTab: `${ESC}[Z`,
  /** Ctrl+C. */
  interrupt: '\u0003',
  /** Ctrl+D: end of input. */
  endOfInput: '\u0004',
} as const;

// ---- addresses a program printed ---------------------------------------------------------

const LOOPBACK = /^(localhost|.*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host);

/**
 * The address to open for a development server a program announced. "localhost"
 * means the Studio's machine, not the phone in the reader's hand: from
 * another device the Studio's own host name takes its place (and `0.0.0.0`,
 * which is no address to visit, becomes one that is). `substituted` says the
 * address differs from what was printed, so the chip can say so.
 */
export function openableUrl(url: Pick<TerminalLocalUrl, 'url' | 'scheme' | 'host' | 'port'>, pageHostname: string): { href: string; label: string; substituted: boolean } {
  const onServerMachine = isLoopbackHost(pageHostname) || pageHostname === '';
  const wildcard = url.host === '0.0.0.0' || url.host === '[::]';
  const host = !onServerMachine && isLoopbackHost(url.host) ? pageHostname : wildcard ? 'localhost' : url.host;
  let path = '';
  try {
    const parsed = new URL(url.url);
    path = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
  } catch {
    /* as printed, without a path */
  }
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const authority = `${bracketed}:${url.port}`;
  return { href: `${url.scheme}://${authority}${path === '' ? '/' : path}`, label: `${authority}${path}`, substituted: host !== url.host };
}

/**
 * The addresses worth a chip, each once: a program that printed
 * `http://localhost:5173` and `http://localhost:5173/` printed one address,
 * though the server records what was printed. The latest `limit` are kept.
 */
export function distinctUrls<T extends Pick<TerminalLocalUrl, 'url' | 'scheme' | 'host' | 'port'>>(urls: readonly T[], pageHostname: string, limit = 6): { url: T; href: string; label: string; substituted: boolean }[] {
  const seen = new Set<string>();
  const kept: { url: T; href: string; label: string; substituted: boolean }[] = [];
  for (const url of urls) {
    const target = openableUrl(url, pageHostname);
    if (seen.has(target.href)) continue;
    seen.add(target.href);
    kept.push({ url, ...target });
  }
  return kept.slice(-limit);
}

// ---- words under a finger ---------------------------------------------------------------

const WORD = /[^\s"'`()[\]{}<>|;,]/;

/** The run of non-separator characters around `column` in `line`: what a long press selects. Null on blank space. */
export function wordAt(line: string, column: number): { start: number; length: number } | null {
  if (column < 0 || column >= line.length || !WORD.test(line[column]!)) return null;
  let start = column;
  let end = column;
  while (start > 0 && WORD.test(line[start - 1]!)) start -= 1;
  while (end < line.length - 1 && WORD.test(line[end + 1]!)) end += 1;
  return { start, length: end - start + 1 };
}

// ---- font size ---------------------------------------------------------------------------

export const FONT_SIZE = { min: 9, max: 28, default: 14, defaultPhone: 13 } as const;
const FONT_KEY = 'studio.terminal.fontSize';

export const clampFontSize = (size: number): number => Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)));

/** The size this device last chose; a device that never chose gets the default for its screen. */
export function readFontSize(phone: boolean, storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): number {
  try {
    const stored = Number(storage?.getItem(FONT_KEY));
    if (Number.isFinite(stored) && stored >= FONT_SIZE.min && stored <= FONT_SIZE.max) return Math.round(stored);
  } catch {
    /* no storage: the default serves */
  }
  return phone ? FONT_SIZE.defaultPhone : FONT_SIZE.default;
}

export function saveFontSize(size: number, storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage): void {
  try {
    storage?.setItem(FONT_KEY, String(clampFontSize(size)));
  } catch {
    /* this device will not remember */
  }
}
