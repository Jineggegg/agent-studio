import type { MemoryCredentialKind, MemoryFolder, MemoryHighlights, MemoryNoteProblem } from '@agent-studio/protocol';
import type { MessageKey, Translator } from '@/i18n';

export interface Segment {
  text: string;
  marked: boolean;
}

/**
 * Splits text at the server's highlight ranges (half-open UTF-16 offsets).
 * Ranges that overlap, run past the end or arrive out of order are tidied,
 * never trusted to be well-formed.
 */
export function highlightSegments(text: string, highlights: MemoryHighlights): Segment[] {
  const ranges = highlights
    .map(([start, end]) => [Math.max(0, Math.min(start, text.length)), Math.max(0, Math.min(end, text.length))] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) segments.push({ text: text.slice(at, from), marked: false });
    const previous = segments[segments.length - 1];
    // Touching or overlapping ranges become one mark.
    if (previous?.marked && from === at) previous.text += text.slice(from, end);
    else segments.push({ text: text.slice(from, end), marked: true });
    at = end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), marked: false });
  return segments.length > 0 ? segments : [{ text, marked: false }];
}

/**
 * Who last wrote a note, as people know them: "you", a person's name, or an
 * agent's name (an agent's id is its author label). Null when unknown.
 */
export function authorLabel(author: string | null, t: Translator, myUsername: string | null, agentName: (agentId: string) => string | null): string | null {
  if (!author) return null;
  if (author.startsWith('user:')) {
    const name = author.slice(5);
    return myUsername !== null && name === myUsername ? t('memory.author.you') : name;
  }
  const id = author.startsWith('api:') ? `api-${author.slice(4)}` : author;
  return agentName(id) ?? author;
}

/** Whether a note was last written by a person rather than an assistant. */
export const writtenByPerson = (author: string | null): boolean => author !== null && author.startsWith('user:');

/** A folder as people know it: "Global", a project's name, or the folder's own name. */
export function folderLabel(folder: Pick<MemoryFolder, 'name' | 'kind' | 'project'> | undefined, name: string, t: Translator): string {
  if (name === 'global' || folder?.kind === 'global') return t('memory.folder.global');
  if (folder?.project) return folder.project.name;
  return name;
}

export const CREDENTIAL_KEYS: Record<MemoryCredentialKind, MessageKey> = {
  private_key: 'memory.credential.private_key',
  api_key: 'memory.credential.api_key',
  access_token: 'memory.credential.access_token',
  cloud_key: 'memory.credential.cloud_key',
  signed_token: 'memory.credential.signed_token',
  bearer_token: 'memory.credential.bearer_token',
  webhook: 'memory.credential.webhook',
  url_password: 'memory.credential.url_password',
  password: 'memory.credential.password',
  secret_value: 'memory.credential.secret_value',
  random_string: 'memory.credential.random_string',
};

export const PROBLEM_KEYS: Record<MemoryNoteProblem, MessageKey> = {
  unreadable: 'memory.problem.unreadable',
  not_text: 'memory.problem.not_text',
  too_large: 'memory.problem.too_large',
};

/** The kind of credential a refused save was taken for, in words; never the value (the server never sends it). */
export function credentialKind(details: unknown, t: Translator): string {
  const kind = (details as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === 'string' && kind in CREDENTIAL_KEYS ? t(CREDENTIAL_KEYS[kind as MemoryCredentialKind]) : t('memory.credential.unknown');
}

/**
 * The body without a first-level heading that only repeats the title — the
 * reader shows the title already.
 */
export function withoutRepeatedTitle(body: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*#*\s*(\r?\n|$)/.exec(body);
  if (!match) return body;
  const heading = match[1]!.replace(/\s+/g, ' ').trim().toLowerCase();
  return heading === title.replace(/\s+/g, ' ').trim().toLowerCase() ? body.slice(match[0].length).replace(/^\s*\n/, '') : body;
}
