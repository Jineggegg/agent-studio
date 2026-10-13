import { createHash } from 'node:crypto';
import { MEMORY_GLOBAL_FOLDER, MEMORY_LIMITS, isSafeMemoryPath } from '@agent-studio/protocol';

/**
 * Names in the memory store.
 *
 * Two different things happen to names, and they must not be confused:
 *
 * - **Addressing** something that exists (a note id, a folder filter) uses the
 *   name exactly as it is on disk. It is only checked for safety, never
 *   rewritten, so a file a person named by hand stays reachable.
 * - **Creating** something (the file for a new title, a new sub-folder, the
 *   folder of a project) normalises the name into a slug, so that every
 *   assistant derives the same file from the same title.
 */

export const GLOBAL_FOLDER = MEMORY_GLOBAL_FOLDER;
export const NOTE_EXTENSION = '.md';

const SLUG_MAX_CHARS = 80;
const SLUG_MAX_BYTES = 200;
const FOLDER_MAX_CHARS = 48;
const MAX_SEGMENT_BYTES = 240;

/** Device names that some file systems refuse as file names. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

function cutToBytes(text: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}

/**
 * Lower-cased, filename-safe form of a title or directory name: letters and
 * digits of any script are kept, everything else becomes a single hyphen, and
 * hyphens at the ends are dropped. "Deploy rules", "Deploy rules." and
 * "-Deploy rules" all give `deploy-rules`. Returns '' when nothing is left.
 */
export function slugify(text: string, maxChars = SLUG_MAX_CHARS): string {
  const folded = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^[-\p{M}]+/u, '')
    .replace(/-+$/, '');
  let slug = cutToBytes([...folded].slice(0, maxChars).join(''), SLUG_MAX_BYTES).replace(/-+$/, '');
  if (RESERVED_NAMES.test(slug)) slug = `${slug}-note`;
  return slug;
}

/** The folder name a project gets from the last segment of its working directory. */
export function folderNameForDirectory(directoryName: string): string {
  return slugify(directoryName, FOLDER_MAX_CHARS) || 'project';
}

/**
 * The name used when `base` is already taken by another project: the same for
 * a given working directory every time, whatever order projects are added in.
 * `attempt` lengthens the suffix should even that collide.
 */
export function disambiguatedFolderName(base: string, rootDir: string, attempt = 0): string {
  const digest = createHash('sha256').update(rootDir).digest('hex');
  return `${base}-${digest.slice(0, 6 + attempt * 4)}`;
}

/** One path segment as it may appear on disk: an ordinary, visible name. */
export function isSafeSegment(segment: string): boolean {
  return isSafeMemoryPath(segment, 1) && !segment.includes('/') && Buffer.byteLength(segment) <= MAX_SEGMENT_BYTES;
}

export interface NoteRef {
  /** `folder/…/name`, as on disk without the extension. */
  readonly id: string;
  /** Top-level folder. */
  readonly folder: string;
  /** Directory of the note: `folder` or `folder/sub/…`. */
  readonly dir: string;
  /** File name without the extension. */
  readonly name: string;
}

/** Checks a note id from a client. Returns null for anything that is not a plain relative path of two or more names. */
export function parseNoteId(raw: unknown): NoteRef | null {
  if (typeof raw !== 'string' || raw.length > MEMORY_LIMITS.noteIdChars) return null;
  if (!isSafeMemoryPath(raw, 2)) return null;
  const segments = raw.split('/');
  // Folder, sub-folders, name: nothing the store would index lies deeper.
  if (segments.length > 2 + MEMORY_LIMITS.subfolderDepth || !segments.every(isSafeSegment)) return null;
  return { id: raw, folder: segments[0]!, dir: segments.slice(0, -1).join('/'), name: segments[segments.length - 1]! };
}

export interface FolderRef {
  /** `folder` or `folder/sub/…`. */
  readonly path: string;
  /** Top-level folder. */
  readonly folder: string;
  /** Segments below the top-level folder. */
  readonly rest: readonly string[];
}

/** Checks a folder path from a client, for addressing folders that exist. */
export function parseFolderPath(raw: unknown): FolderRef | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  if (!isSafeMemoryPath(raw, 1)) return null;
  const segments = raw.split('/');
  if (segments.length > 1 + MEMORY_LIMITS.subfolderDepth || !segments.every(isSafeSegment)) return null;
  return { path: raw, folder: segments[0]!, rest: segments.slice(1) };
}

/**
 * Normalises the sub-folders a client wants a new note in. Each segment is
 * slugged; a segment that slugs to nothing, or too many levels, gives null.
 */
export function normaliseSubfolders(segments: readonly string[]): string[] | null {
  if (segments.length > MEMORY_LIMITS.subfolderDepth) return null;
  const result: string[] = [];
  for (const segment of segments) {
    const slug = slugify(segment, FOLDER_MAX_CHARS);
    if (!slug) return null;
    result.push(slug);
  }
  return result;
}

/** Splits `a/b` into segments for {@link normaliseSubfolders}; null for anything that is not a plain relative path. */
export function splitSubfolder(raw: string): string[] | null {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return [];
  if (!isSafeMemoryPath(trimmed, 1)) return null;
  return trimmed.split('/');
}

/** Collapses white space; null when the result is empty, too long or contains a slash, backslash or control character. */
export function cleanTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length === 0 || [...title].length > MEMORY_LIMITS.titleChars) return null;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(title)) return null;
  return title;
}

/**
 * Tag clean-up: a leading `#` is dropped, the tag is lower-cased, white space
 * becomes a hyphen, anything but letters, digits, `_` and `-` is removed, and
 * duplicates and empties are discarded. The first `max` survive.
 */
export function cleanTags(raw: readonly string[], max: number = MEMORY_LIMITS.tags): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = [
      ...entry
        .normalize('NFKC')
        .trim()
        .replace(/^#+/, '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '')
        .replace(/^[-_]+|[-_]+$/g, ''),
    ]
      .slice(0, MEMORY_LIMITS.tagChars)
      .join('');
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * Keyword clean-up: entries are split on white space and commas (a keyword is
 * one word), control characters are removed, duplicates are dropped without
 * regard to case. The first `max` survive.
 */
export function cleanKeywords(raw: readonly string[], max: number = MEMORY_LIMITS.keywords): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const piece of entry.normalize('NFC').split(/[\s,，、;；]+/u)) {
      // eslint-disable-next-line no-control-regex
      const word = [...piece.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060\ufeff]/g, '')].slice(0, MEMORY_LIMITS.keywordChars).join('');
      const key = word.toLowerCase();
      if (!word || seen.has(key)) continue;
      seen.add(key);
      result.push(word);
      if (result.length >= max) return result;
    }
  }
  return result;
}

/** The author label of a person. */
export function userAuthor(username: string): string {
  return `user:${username.toLowerCase()}`;
}

/**
 * The author label of an assistant, from the id of the adapter the run uses
 * ("claude-code", "codex", "api:openai"…). It can never look like a person.
 */
export function agentAuthor(agentId: string): string {
  const label = agentId
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, '-')
    .replace(/^[-:._]+|[-:._]+$/g, '')
    .slice(0, 48);
  if (!label) return 'agent';
  return label.startsWith('user:') || label === 'user' ? `agent-${label.replace(/:/g, '-')}` : label;
}

/** An author label read from a file: one short printable line, or null. */
export function cleanAuthor(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const author = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (author.length === 0 || author.length > 64 || /[\u0000-\u001f\u007f]/.test(author)) return null;
  return author;
}

export function isPersonAuthor(author: string | null): boolean {
  return author !== null && author.startsWith('user:');
}
