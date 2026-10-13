/**
 * What a URL found in untrusted Markdown may be.
 *
 * Only `http:`, `https:` and relative references survive. `javascript:`,
 * `data:`, `vbscript:`, `file:`, custom schemes and protocol-relative
 * `//host` forms are dropped: the link is rendered as plain text and the
 * image as its alternative text.
 */
export type SafeUrl = { kind: 'remote'; href: string; host: string } | { kind: 'relative'; href: string } | null;

// Browsers ignore these inside a scheme, so "java\tscript:" is still a script URL.
// eslint-disable-next-line no-control-regex
const IGNORED_CHARACTERS = /[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g;

export function classifyUrl(raw: string | null | undefined): SafeUrl {
  if (typeof raw !== 'string') return null;
  const url = raw.replace(IGNORED_CHARACTERS, '').trim();
  if (url === '') return null;
  if (url.startsWith('//') || url.startsWith('\\') || url.startsWith('/\\')) return null;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  // A colon after the first "/", "?" or "#" belongs to the path, not to a scheme.
  const firstDelimiter = url.search(/[/?#]/);
  const hasScheme = scheme !== null && (firstDelimiter === -1 || scheme[0].length - 1 < firstDelimiter);
  if (!hasScheme) return { kind: 'relative', href: url };

  const name = scheme[1]!.toLowerCase();
  if (name !== 'http' && name !== 'https') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null; // "https://bank.example@evil.example" tricks
    return { kind: 'remote', href: parsed.href, host: parsed.host };
  } catch {
    return null;
  }
}

/** Inline images that carry their own bytes are harmless in an <img>; SVG is left out to be safe. */
export function isInlineImageData(raw: string): boolean {
  return /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/=\s]+$/.test(raw.trim());
}
