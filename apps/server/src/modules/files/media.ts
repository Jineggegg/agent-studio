import path from 'node:path';

/**
 * Which files may be shown *inside the browser* straight from the server.
 *
 * Only passive media: images, audio, video and PDF. Anything that a browser
 * could run or that can carry script — HTML, SVG, XML, JavaScript — is not on
 * the list and is only ever sent as a download. A file must also start with
 * the bytes its extension promises, so a script renamed to ".png" is not
 * served as an image.
 */
interface Previewable {
  readonly mediaType: string;
  readonly matches: (head: Buffer) => boolean;
}

const ascii = (head: Buffer, offset: number, text: string): boolean => head.subarray(offset, offset + text.length).toString('latin1') === text;
const bytes = (head: Buffer, ...expected: number[]): boolean => expected.every((value, index) => head[index] === value);
/** ISO base media files (MP4, M4A, MOV, AVIF) start with a box whose type is "ftyp". */
const isoMedia = (head: Buffer): boolean => ascii(head, 4, 'ftyp');

const PREVIEWABLE: Readonly<Record<string, Previewable>> = {
  '.png': { mediaType: 'image/png', matches: (head) => bytes(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  '.jpg': { mediaType: 'image/jpeg', matches: (head) => bytes(head, 0xff, 0xd8, 0xff) },
  '.jpeg': { mediaType: 'image/jpeg', matches: (head) => bytes(head, 0xff, 0xd8, 0xff) },
  '.gif': { mediaType: 'image/gif', matches: (head) => ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a') },
  '.webp': { mediaType: 'image/webp', matches: (head) => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP') },
  '.avif': { mediaType: 'image/avif', matches: isoMedia },
  '.bmp': { mediaType: 'image/bmp', matches: (head) => ascii(head, 0, 'BM') },
  '.ico': { mediaType: 'image/x-icon', matches: (head) => bytes(head, 0x00, 0x00, 0x01, 0x00) },
  '.mp3': { mediaType: 'audio/mpeg', matches: (head) => ascii(head, 0, 'ID3') || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) },
  '.wav': { mediaType: 'audio/wav', matches: (head) => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE') },
  '.ogg': { mediaType: 'audio/ogg', matches: (head) => ascii(head, 0, 'OggS') },
  '.oga': { mediaType: 'audio/ogg', matches: (head) => ascii(head, 0, 'OggS') },
  '.flac': { mediaType: 'audio/flac', matches: (head) => ascii(head, 0, 'fLaC') },
  '.m4a': { mediaType: 'audio/mp4', matches: isoMedia },
  '.mp4': { mediaType: 'video/mp4', matches: isoMedia },
  '.m4v': { mediaType: 'video/mp4', matches: isoMedia },
  '.mov': { mediaType: 'video/quicktime', matches: (head) => isoMedia(head) || ascii(head, 4, 'moov') || ascii(head, 4, 'mdat') || ascii(head, 4, 'wide') || ascii(head, 4, 'free') },
  '.webm': { mediaType: 'video/webm', matches: (head) => bytes(head, 0x1a, 0x45, 0xdf, 0xa3) },
  '.ogv': { mediaType: 'video/ogg', matches: (head) => ascii(head, 0, 'OggS') },
  '.pdf': { mediaType: 'application/pdf', matches: (head) => ascii(head, 0, '%PDF-') },
};

/** How many leading bytes {@link previewType} wants to see. */
export const SNIFF_BYTES = 16;

/** The media type to preview a file as, or null when it must not be shown inline. */
export function previewType(fileName: string, head: Buffer): string | null {
  const entry = PREVIEWABLE[path.extname(fileName).toLowerCase()];
  return entry && entry.matches(head) ? entry.mediaType : null;
}

/** Whether the extension is one that could be previewed at all, before looking at the bytes. */
export function hasPreviewableExtension(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() in PREVIEWABLE;
}

/** A `Content-Disposition` value with the name encoded so that no character can break out of the header. */
export function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Headers for a previewed file. `sandbox` gives the response an origin of its
 * own with scripting off, so even a file that turned out to be active content
 * could not touch the Studio; `default-src 'none'` leaves it nothing to load
 * but itself.
 */
export const PREVIEW_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/** Headers for a download: opaque bytes, never interpreted. */
export const DOWNLOAD_CSP = "sandbox; default-src 'none'";

/** Looks at the first bytes of a text candidate: a NUL byte means binary. */
export function looksBinary(sample: Buffer): boolean {
  return sample.includes(0);
}

export function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
