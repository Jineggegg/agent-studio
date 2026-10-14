import { AGENT_LIMITS, type Attachment } from '@agent-studio/protocol';

/**
 * Files waiting to go out with the next message.
 *
 * In a conversation that exists they are uploaded as soon as they are picked,
 * so they survive leaving and coming back; in one that has not been sent yet
 * they wait in memory and are uploaded when the first message creates the
 * session. Either way the rules for what may be attached are the server's own
 * limits, checked here first so the user hears about them in words before a
 * single byte is sent.
 */
export type AttachmentStatus = 'waiting' | 'uploading' | 'uploaded' | 'failed';

export interface PendingAttachment {
  /** Local identity; stable while the tile is on screen. */
  localId: string;
  name: string;
  size: number;
  mediaType: string;
  isImage: boolean;
  /** Identifies the content, so the same picture pasted twice is attached once. */
  fingerprint: string;
  /** A blob: address for a local preview, or the server's address once uploaded. */
  previewUrl: string | null;
  status: AttachmentStatus;
  /** 0–1 while uploading. */
  progress: number;
  /** Why it failed, in words. */
  error: string | null;
  /** The server's record, once it is uploaded. */
  remote: Attachment | null;
  /** The file itself, until it is uploaded. */
  file: File | null;
}

export type Rejection = { name: string; reason: 'too-large' | 'empty' | 'too-many' };

export interface Admission<T> {
  accepted: T[];
  rejected: Rejection[];
  /** Copies of something already attached: dropped without comment. */
  duplicates: number;
}

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const isRasterImage = (mediaType: string): boolean => RASTER.has(mediaType.toLowerCase());

/**
 * Decides which of the offered files may be attached: nothing empty, nothing
 * over the size limit, nothing that is already there, and no more than the
 * message can carry in total. The order offered is the order kept.
 */
export function admitFiles<T extends { name: string; size: number; fingerprint: string }>(
  held: readonly { fingerprint: string }[],
  offered: readonly T[],
  limits: { maxFiles: number; maxBytes: number } = { maxFiles: AGENT_LIMITS.attachmentsPerMessage, maxBytes: AGENT_LIMITS.attachmentBytes },
): Admission<T> {
  const known = new Set(held.map((entry) => entry.fingerprint));
  const accepted: T[] = [];
  const rejected: Rejection[] = [];
  let duplicates = 0;
  for (const file of offered) {
    if (known.has(file.fingerprint)) {
      duplicates += 1;
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: 'empty' });
      continue;
    }
    if (file.size > limits.maxBytes) {
      rejected.push({ name: file.name, reason: 'too-large' });
      continue;
    }
    if (held.length + accepted.length >= limits.maxFiles) {
      rejected.push({ name: file.name, reason: 'too-many' });
      continue;
    }
    known.add(file.fingerprint);
    accepted.push(file);
  }
  return { accepted, rejected, duplicates };
}

const SAMPLE_BYTES = 64 * 1024;

function hash(bytes: Uint8Array, seed: number): number {
  // FNV-1a: not cryptography, only a way to tell two pictures apart.
  let value = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    value ^= bytes[index]!;
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}

/**
 * A fingerprint of a file's content: its size, its type and a hash of its
 * first and last 64 kB. The name is left out on purpose — the same screenshot
 * pasted twice arrives under two generated names.
 */
export async function fingerprintFile(file: Blob & { name?: string }): Promise<string> {
  try {
    const head = new Uint8Array(await file.slice(0, SAMPLE_BYTES).arrayBuffer());
    const tail = file.size > SAMPLE_BYTES ? new Uint8Array(await file.slice(Math.max(SAMPLE_BYTES, file.size - SAMPLE_BYTES)).arrayBuffer()) : new Uint8Array();
    return `${file.size}:${file.type}:${hash(head, 2166136261).toString(16)}:${hash(tail, 84696351).toString(16)}`;
  } catch {
    // Unreadable here (a very old browser): fall back to what is known without reading it.
    return `${file.size}:${file.type}:${file.name ?? ''}`;
  }
}

let localCounter = 0;
export const newLocalId = (): string => `local-${Date.now().toString(36)}-${(localCounter += 1)}`;

/** The tile for a file the server already holds (uploaded earlier, restored on return). */
export function fromRemote(attachment: Attachment): PendingAttachment {
  return {
    localId: `remote-${attachment.id}`,
    name: attachment.name,
    size: attachment.size,
    mediaType: attachment.mediaType,
    isImage: attachment.isImage,
    fingerprint: `remote:${attachment.id}`,
    previewUrl: attachment.isImage ? attachment.url : null,
    status: 'uploaded',
    progress: 1,
    error: null,
    remote: attachment,
    file: null,
  };
}

/** "3.4 MB", "812 kB", "96 B" — sizes as people say them. */
export function formatBytes(bytes: number, formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string): string {
  if (bytes < 1000) return `${formatNumber(bytes)} B`;
  if (bytes < 1_000_000) return `${formatNumber(bytes / 1000, { maximumFractionDigits: 0 })} kB`;
  if (bytes < 1_000_000_000) return `${formatNumber(bytes / 1_000_000, { maximumFractionDigits: 1 })} MB`;
  return `${formatNumber(bytes / 1_000_000_000, { maximumFractionDigits: 1 })} GB`;
}
