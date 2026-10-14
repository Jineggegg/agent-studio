import type { FileLimits, UploadResult } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';
import type { UploadItem } from './api';
import { normalizePath } from './tree';

/**
 * The server's rules for names and uploads, mirrored here only so that a
 * refusal can be explained before — or in the reader's language after — the
 * server gives it. The server remains the judge.
 */

export type NameRule = 'blank' | 'tooLong' | 'characters' | 'dots' | 'spaces' | 'reserved' | 'git';

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Which of the server's naming rules `name` breaks, in the order the server checks them; null when it breaks none. */
export function brokenNameRule(name: string): NameRule | null {
  if (name.trim().length === 0) return 'blank';
  if (new TextEncoder().encode(name).length > 255) return 'tooLong';
  if (FORBIDDEN.test(name)) return 'characters';
  if (/^\.+$/.test(name)) return 'dots';
  if (name !== name.trim()) return 'spaces';
  if (RESERVED.test(name)) return 'reserved';
  if (name.toLowerCase() === '.git') return 'git';
  return null;
}

export const nameRuleKey = (rule: NameRule): MessageKey => `files.name.${rule}`;

/**
 * A path as an agent may write it — absolute on the server, with back
 * slashes, with `./` — turned into the project-relative form the files API
 * takes. A path outside the project's folder cannot be opened here.
 */
export function toProjectPath(rootDir: string, raw: string): { path: string } | { outside: true } {
  let path = raw.trim().replace(/\\/g, '/');
  const root = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (path === root) return { path: '' };
  if (root !== '' && path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  else if (path.startsWith('/') || /^[a-zA-Z]:\//.test(path) || path.startsWith('~')) return { outside: true };
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) return { outside: true };
  return { path: normalizePath(parts.join('/')) };
}

// ---- uploads -----------------------------------------------------------------------

export type UploadRefusal = { reason: 'tooMany'; limit: number; count: number } | { reason: 'fileTooLarge'; limit: number; name: string } | { reason: 'totalTooLarge'; limit: number } | { reason: 'empty' };

/** Checked before anything is sent, so a phone does not spend minutes uploading what will be refused. */
export function checkUpload(items: readonly UploadItem[], limits: Pick<FileLimits, 'maxUploadFiles' | 'maxUploadFileBytes' | 'maxUploadTotalBytes'>): UploadRefusal | null {
  if (items.length === 0) return { reason: 'empty' };
  if (items.length > limits.maxUploadFiles) return { reason: 'tooMany', limit: limits.maxUploadFiles, count: items.length };
  let total = 0;
  for (const item of items) {
    if (item.file.size > limits.maxUploadFileBytes) return { reason: 'fileTooLarge', limit: limits.maxUploadFileBytes, name: item.file.name };
    total += item.file.size;
  }
  if (total > limits.maxUploadTotalBytes) return { reason: 'totalTooLarge', limit: limits.maxUploadTotalBytes };
  return null;
}

/** Files an operating system scatters about that nobody means to upload. */
const CLUTTER = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
export const isClutter = (name: string): boolean => CLUTTER.has(name.toLowerCase()) || name.startsWith('._');

export interface UploadOutcome {
  stored: number;
  requested: number;
  /** Not written because something with that name is already there: these can be sent again to replace. */
  existing: string[];
  /** Not written for a reason replacing cannot fix. */
  refused: { name: string; reason: Exclude<UploadResult['skipped'][number]['reason'], 'exists'> }[];
}

export function summarizeUpload(result: UploadResult): UploadOutcome {
  const existing: string[] = [];
  const refused: UploadOutcome['refused'] = [];
  for (const skipped of result.skipped) {
    if (skipped.reason === 'exists') existing.push(skipped.name);
    else refused.push({ name: skipped.name, reason: skipped.reason });
  }
  return { stored: result.stored.length, requested: result.requested, existing, refused };
}

interface DroppedEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (resolve: (file: File) => void, reject: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (resolve: (entries: DroppedEntry[]) => void, reject: (error: unknown) => void) => void };
}

async function walk(entry: DroppedEntry, prefix: string, out: UploadItem[], budget: { left: number }): Promise<void> {
  if (budget.left <= 0 || isClutter(entry.name)) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    budget.left -= 1;
    out.push({ file, relativePath: prefix === '' ? undefined : `${prefix}/${entry.name}` });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  // A directory reader hands its entries over in batches and says "done" with an empty one.
  for (;;) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, prefix === '' ? entry.name : `${prefix}/${entry.name}`, out, budget);
  }
}

/**
 * Everything that was dropped: files as they are, folders walked so their
 * structure can be recreated. `maxFiles` stops a runaway walk of a huge
 * folder just past the point where the upload would be refused anyway.
 */
export async function collectDropped(transfer: DataTransfer, maxFiles: number): Promise<UploadItem[]> {
  // The entries must be taken before the first await: the drop's data is gone once the handler returns.
  const entries: DroppedEntry[] = [];
  const plain: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) plain.push(file);
    }
  }
  if (entries.length === 0 && plain.length === 0) plain.push(...Array.from(transfer.files ?? []));
  const out: UploadItem[] = plain.filter((file) => !isClutter(file.name)).map((file) => ({ file }));
  const budget = { left: maxFiles + 1 - out.length };
  for (const entry of entries) await walk(entry, '', out, budget);
  return out;
}

/**
 * A matching line cut into the stretches that matched and the rest, so the
 * match can be marked. The server matches the text literally and without
 * regard to case; so does this.
 */
export function matchRuns(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.toLowerCase();
  if (needle === '') return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const runs: { text: string; match: boolean }[] = [];
  let from = 0;
  // Lower-casing keeps the length of everything a search line holds in practice; where it would not, nothing is marked.
  if (haystack.length !== text.length) return [{ text, match: false }];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (at > from) runs.push({ text: text.slice(from, at), match: false });
    runs.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), match: false });
  return runs;
}
