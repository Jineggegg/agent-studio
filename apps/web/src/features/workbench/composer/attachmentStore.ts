import type { AttachmentRef } from '@agent-studio/protocol';
import { create } from 'zustand';
import { isApiError } from '@/data/api';
import { onSessionEnd } from '@/data/auth';
import { workbenchApi } from '../api';
import { type Admission, type PendingAttachment, admitFiles, fingerprintFile, fromRemote, isRasterImage, newLocalId } from './attachments';
import { type DraftKey, newChatDraftKey, sessionDraftKey, sessionOfDraft as sessionOf } from './drafts';

/**
 * The files waiting to go out, per conversation (the same keys as drafts).
 * A conversation that exists uploads a file as soon as it is picked; one that
 * has not been sent yet keeps the files here until the first message creates
 * its session.
 */
interface AttachmentStoreState {
  byKey: Record<DraftKey, PendingAttachment[]>;
}

export const useAttachments = create<AttachmentStoreState>(() => ({ byKey: {} }));

const uploads = new Map<string, { controller: AbortController; done: Promise<void> }>();
const loadedSessions = new Set<string>();

export const attachmentsOf = (key: DraftKey): PendingAttachment[] => useAttachments.getState().byKey[key] ?? [];

function setList(key: DraftKey, change: (list: PendingAttachment[]) => PendingAttachment[]): void {
  useAttachments.setState((state) => {
    const before = state.byKey[key] ?? [];
    const after = change(before);
    if (after === before) return state;
    const byKey = { ...state.byKey };
    if (after.length === 0) delete byKey[key];
    else byKey[key] = after;
    return { byKey };
  });
}

function patch(key: DraftKey, localId: string, changes: Partial<PendingAttachment>): void {
  setList(key, (list) => {
    const index = list.findIndex((entry) => entry.localId === localId);
    if (index === -1) return list;
    const copy = [...list];
    copy[index] = { ...copy[index]!, ...changes };
    return copy;
  });
}

function release(attachment: PendingAttachment): void {
  if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl);
}

/** Why an upload failed, in the server's words when it gave any. */
function failureText(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    const rejected = (error.details as { rejected?: { message?: unknown }[] } | null | undefined)?.rejected?.[0]?.message;
    if (typeof rejected === 'string' && rejected !== '') return rejected;
    if (error.status > 0 && error.message) return error.message;
  }
  return fallback;
}

function startUpload(key: DraftKey, sessionId: string, attachment: PendingAttachment, messages: { failed: string }): Promise<void> {
  const file = attachment.file;
  if (!file) return Promise.resolve();
  const controller = new AbortController();
  patch(key, attachment.localId, { status: 'uploading', progress: 0, error: null });
  const done = workbenchApi
    .uploadAttachment(sessionId, file, {
      signal: controller.signal,
      onProgress: (fraction) => patch(key, attachment.localId, { progress: fraction }),
    })
    .then((result) => {
      const remote = result.attachments[0];
      if (!remote) {
        patch(key, attachment.localId, { status: 'failed', error: result.rejected[0]?.message ?? messages.failed });
        return;
      }
      // The local preview stays: swapping to the server's copy would flicker for no gain.
      patch(key, attachment.localId, { status: 'uploaded', progress: 1, remote, file: null });
    })
    .catch((error: unknown) => {
      if (isApiError(error) && error.code === 'aborted') return;
      patch(key, attachment.localId, { status: 'failed', error: failureText(error, messages.failed) });
    })
    .finally(() => {
      uploads.delete(attachment.localId);
    });
  uploads.set(attachment.localId, { controller, done });
  return done;
}

/**
 * Offers files to a conversation. Returns what was refused and why, so the
 * composer can say so in words; duplicates of something already attached are
 * dropped silently (a screenshot pasted twice is one attachment).
 */
export async function addFiles(key: DraftKey, files: readonly File[], messages: { failed: string }): Promise<Admission<File>> {
  const candidates = await Promise.all(files.map(async (file) => ({ file, name: file.name || 'file', size: file.size, fingerprint: await fingerprintFile(file) })));
  const admission = admitFiles(attachmentsOf(key), candidates);
  const added: PendingAttachment[] = admission.accepted.map((candidate) => {
    const image = isRasterImage(candidate.file.type);
    return {
      localId: newLocalId(),
      name: candidate.name,
      size: candidate.size,
      mediaType: candidate.file.type || 'application/octet-stream',
      isImage: image,
      fingerprint: candidate.fingerprint,
      previewUrl: image ? URL.createObjectURL(candidate.file) : null,
      status: 'waiting',
      progress: 0,
      error: null,
      remote: null,
      file: candidate.file,
    };
  });
  if (added.length > 0) {
    setList(key, (list) => [...list, ...added]);
    const sessionId = sessionOf(key);
    if (sessionId !== null) for (const attachment of added) void startUpload(key, sessionId, attachment, messages);
  }
  return { accepted: admission.accepted.map((candidate) => candidate.file), rejected: admission.rejected, duplicates: admission.duplicates };
}

export function retryUpload(key: DraftKey, localId: string, messages: { failed: string }): void {
  const sessionId = sessionOf(key);
  const attachment = attachmentsOf(key).find((entry) => entry.localId === localId);
  if (sessionId === null || !attachment || attachment.status !== 'failed' || !attachment.file) return;
  void startUpload(key, sessionId, attachment, messages);
}

/** Takes a file off the message. One that is already on the server is removed there too. */
export function removeAttachment(key: DraftKey, localId: string): void {
  const attachment = attachmentsOf(key).find((entry) => entry.localId === localId);
  if (!attachment) return;
  uploads.get(localId)?.controller.abort();
  setList(key, (list) => list.filter((entry) => entry.localId !== localId));
  release(attachment);
  const sessionId = sessionOf(key);
  if (sessionId !== null && attachment.remote) {
    void workbenchApi.removeAttachment(sessionId, attachment.remote.id).catch(() => {
      /* already gone, or unreachable: the server caps and sweeps what is never sent */
    });
  }
}

/** Shows the files a session already holds unsent (uploaded earlier, on this device or another). Read once per session. */
export async function loadPendingAttachments(sessionId: string): Promise<void> {
  if (loadedSessions.has(sessionId)) return;
  loadedSessions.add(sessionId);
  try {
    const { attachments } = await workbenchApi.pendingAttachments(sessionId);
    const key = sessionDraftKey(sessionId);
    setList(key, (list) => {
      const known = new Set(list.map((entry) => entry.remote?.id).filter(Boolean));
      const missing = attachments.filter((attachment) => attachment.pending && !known.has(attachment.id)).map(fromRemote);
      return missing.length === 0 ? list : [...missing, ...list];
    });
  } catch {
    loadedSessions.delete(sessionId);
  }
}

/** Resolves once nothing in the conversation is still uploading. */
export async function uploadsSettled(key: DraftKey): Promise<void> {
  for (;;) {
    const running = attachmentsOf(key)
      .map((entry) => uploads.get(entry.localId)?.done)
      .filter((promise): promise is Promise<void> => promise !== undefined);
    if (running.length === 0) return;
    await Promise.all(running);
  }
}

/**
 * The first message of a new conversation created its session: the files that
 * were waiting locally are uploaded to it. Resolves when every one has either
 * arrived or failed.
 */
export async function adoptAttachments(fromKey: DraftKey, sessionId: string, messages: { failed: string }): Promise<void> {
  const toKey = sessionDraftKey(sessionId);
  const moving = attachmentsOf(fromKey);
  if (moving.length === 0) return;
  loadedSessions.add(sessionId);
  setList(fromKey, () => []);
  setList(toKey, (list) => [...list, ...moving]);
  await Promise.all(moving.filter((entry) => entry.status !== 'uploaded').map((entry) => startUpload(toKey, sessionId, entry, messages)));
}

export interface ReadyAttachments {
  ids: string[];
  refs: AttachmentRef[];
  /** Files that did not make it to the server; the message must not go without the user knowing. */
  failed: PendingAttachment[];
}

/** What can go out with a message right now. */
export function readyAttachments(key: DraftKey): ReadyAttachments {
  const list = attachmentsOf(key);
  const uploaded = list.filter((entry) => entry.status === 'uploaded' && entry.remote);
  return {
    ids: uploaded.map((entry) => entry.remote!.id),
    refs: uploaded.map((entry) => ({ id: entry.remote!.id, name: entry.name, mediaType: entry.mediaType, size: entry.size, isImage: entry.isImage, url: entry.remote!.url })),
    failed: list.filter((entry) => entry.status === 'failed'),
  };
}

/** The message carrying these files was accepted: they are no longer waiting. */
export function clearSentAttachments(key: DraftKey, attachmentIds: readonly string[]): void {
  const sent = new Set(attachmentIds);
  setList(key, (list) => {
    const rest = list.filter((entry) => !(entry.remote && sent.has(entry.remote.id)));
    return rest.length === list.length ? list : rest;
  });
}

/** The message was refused: its files are still on the server, unsent, and wait in the composer again. */
export function restoreAttachments(key: DraftKey, refs: readonly AttachmentRef[], sessionId: string): void {
  setList(key, (list) => {
    const known = new Set(list.map((entry) => entry.remote?.id).filter(Boolean));
    const back = refs
      .filter((ref) => !known.has(ref.id))
      .map((ref) => fromRemote({ ...ref, sessionId, pending: true, createdAt: 0 }));
    return back.length === 0 ? list : [...list, ...back];
  });
}

/** An unsent conversation moves to another project: its files go along, and the ones waiting there come back in exchange. */
export function moveNewAttachments(fromProjectId: string, toProjectId: string): void {
  if (fromProjectId === toProjectId) return;
  const from = newChatDraftKey(fromProjectId);
  const to = newChatDraftKey(toProjectId);
  const moving = attachmentsOf(from);
  const waiting = attachmentsOf(to);
  if (moving.length === 0 && waiting.length === 0) return;
  setList(from, () => waiting);
  setList(to, () => moving);
}

function forgetAll(): void {
  for (const upload of uploads.values()) upload.controller.abort();
  uploads.clear();
  loadedSessions.clear();
  for (const list of Object.values(useAttachments.getState().byKey)) list.forEach(release);
  useAttachments.setState({ byKey: {} }, true);
}

if (typeof window !== 'undefined') onSessionEnd(forgetAll);

/** For tests. */
export function __resetAttachmentsForTests(): void {
  forgetAll();
}
