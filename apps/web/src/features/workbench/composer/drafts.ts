import { AGENT_LIMITS } from '@agent-studio/protocol';
import { create } from 'zustand';
import { onSessionEnd } from '@/data/auth';
import { workbenchApi } from '../api';
import { setNewDraft, useDeviceMemory } from '../device';

/**
 * Unsent text, per conversation.
 *
 * A conversation that exists keeps its draft on the server (saved shortly
 * after the last key press, and once more when the page is hidden), so it
 * follows the user to their other devices. A conversation that has not been
 * sent yet has no session to hang a draft on: its text is kept on this device
 * only, per project.
 *
 * A draft arriving from another device replaces the text here unless this
 * device has changes of its own that are not saved yet — the same rule the
 * preferences follow.
 */
export type DraftKey = string;

export const sessionDraftKey = (sessionId: string): DraftKey => `session:${sessionId}`;
export const newChatDraftKey = (projectId: string | null): DraftKey => `new:${projectId ?? ''}`;
/** The session a key belongs to, or null for a conversation that has not been created yet. */
export const sessionOfDraft = (key: DraftKey): string | null => (key.startsWith('session:') ? key.slice('session:'.length) : null);

const SAVE_DELAY_MS = 700;

interface DraftState {
  texts: Record<DraftKey, string>;
  /** Keys whose server copy has been read (or that need none). */
  loaded: Record<DraftKey, boolean>;
}

export const useDrafts = create<DraftState>(() => ({ texts: {}, loaded: {} }));

/** What the server is known to hold, so that an unchanged draft is not saved again. */
const saved = new Map<DraftKey, string>();
const timers = new Map<DraftKey, ReturnType<typeof setTimeout>>();
const loading = new Map<DraftKey, Promise<void>>();
/** Saves on their way to the server: what the server says meanwhile may predate them. */
const inFlight = new Map<DraftKey, number>();
/** When the last save of a key finished: news that arrives just after may still be older than it. */
const settledAt = new Map<DraftKey, number>();
const SETTLE_MS = 3_000;

const sessionOf = (key: DraftKey): string | null => (key.startsWith('session:') ? key.slice('session:'.length) : null);
const projectOf = (key: DraftKey): string | null => (key.startsWith('new:') ? key.slice('new:'.length) : null);

function put(key: DraftKey, text: string, loaded?: boolean): void {
  useDrafts.setState((state) => {
    if (state.texts[key] === text && (loaded === undefined || state.loaded[key] === loaded)) return state;
    return { texts: { ...state.texts, [key]: text }, loaded: loaded === undefined ? state.loaded : { ...state.loaded, [key]: loaded } };
  });
}

export const getDraft = (key: DraftKey): string => useDrafts.getState().texts[key] ?? '';

const isDirty = (key: DraftKey): boolean => {
  const sessionId = sessionOf(key);
  return sessionId !== null && saved.has(key) && saved.get(key) !== getDraft(key);
};

async function save(key: DraftKey, keepalive = false): Promise<void> {
  const sessionId = sessionOf(key);
  if (sessionId === null) return;
  const text = getDraft(key).slice(0, AGENT_LIMITS.messageChars);
  if (saved.get(key) === text) return;
  const before = saved.get(key);
  saved.set(key, text);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  try {
    await workbenchApi.saveDraft(sessionId, text, keepalive);
  } catch {
    // Not saved: the next change (or the next time the page is hidden) tries again.
    if (saved.get(key) === text) {
      if (before === undefined) saved.delete(key);
      else saved.set(key, before);
    }
  } finally {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left <= 0) inFlight.delete(key);
    else inFlight.set(key, left);
    settledAt.set(key, Date.now());
  }
}

/** This device has text the server has not confirmed yet: nothing from elsewhere may replace it. */
const hasLocalChanges = (key: DraftKey): boolean => isDirty(key) || timers.has(key) || inFlight.has(key);

/** Reads a session's draft from the server once. Text typed while it loads is kept. */
export function loadDraft(sessionId: string): Promise<void> {
  const key = sessionDraftKey(sessionId);
  if (useDrafts.getState().loaded[key]) return Promise.resolve();
  const running = loading.get(key);
  if (running) return running;
  const promise = workbenchApi
    .draft(sessionId)
    .then((draft) => {
      const typedMeanwhile = getDraft(key) !== '';
      saved.set(key, draft.text);
      put(key, typedMeanwhile ? getDraft(key) : draft.text, true);
      if (typedMeanwhile) schedule(key);
    })
    .catch(() => {
      // Unreadable (offline, or someone else's session): compose from empty, and do not mark it loaded so a later visit retries.
      put(key, getDraft(key));
    })
    .finally(() => {
      loading.delete(key);
    });
  loading.set(key, promise);
  return promise;
}

function schedule(key: DraftKey): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void save(key);
    }, SAVE_DELAY_MS),
  );
}

/** The user typed. Applied at once; saved a moment after the last change. */
export function setDraft(key: DraftKey, text: string): void {
  put(key, text);
  const projectId = projectOf(key);
  if (projectId !== null) {
    if (projectId !== '') setNewDraft(projectId, text);
    return;
  }
  if (!saved.has(key)) saved.set(key, '');
  schedule(key);
}

/** Save now (the page is being hidden, the conversation is being left). */
export function flushDraft(key: DraftKey, keepalive = false): Promise<void> {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  return save(key, keepalive);
}

export function flushAllDrafts(keepalive = false): void {
  for (const key of [...timers.keys()]) void flushDraft(key, keepalive);
}

/**
 * The text went out as a message. The server empties a session's draft itself
 * when it accepts the message, so nothing is saved from here.
 */
export function clearDraftAfterSend(key: DraftKey): void {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  put(key, '');
  const projectId = projectOf(key);
  if (projectId !== null && projectId !== '') setNewDraft(projectId, '');
  if (sessionOf(key) !== null) saved.set(key, '');
}

/** Another device saved a draft for this session. */
export function applyRemoteDraft(sessionId: string, text: string): void {
  const key = sessionDraftKey(sessionId);
  // Our own unsaved change wins; so does a save of ours that is still on its way.
  if (hasLocalChanges(key)) return;
  if (saved.get(key) === text && getDraft(key) === text) return;
  saved.set(key, text);
  if (key in useDrafts.getState().texts || text !== '') put(key, text);
}

/**
 * The server says whether a session holds a draft. When it says "none" — the text went out as a message from
 * another device, or was cleared there — an untouched copy here is stale and goes too.
 */
export function noteDraftFlag(sessionId: string, hasDraft: boolean): void {
  if (hasDraft) return;
  const key = sessionDraftKey(sessionId);
  if (hasLocalChanges(key) || !saved.has(key) || saved.get(key) === '') return;
  if (Date.now() - (settledAt.get(key) ?? 0) < SETTLE_MS) return;
  saved.set(key, '');
  put(key, '');
}

/** The draft of the unsent conversation in a project, as remembered on this device. */
export function restoreNewDraft(projectId: string | null): void {
  const key = newChatDraftKey(projectId);
  if (useDrafts.getState().loaded[key]) return;
  const remembered = projectId === null ? '' : (useDeviceMemory.getState().newDrafts[projectId] ?? '');
  put(key, getDraft(key) || remembered, true);
}

/**
 * An unsent conversation is moved to another project: its text goes along,
 * and whatever was waiting in the destination comes back in exchange — it is
 * swapped, never overwritten. Nothing moves when there is nothing to move.
 */
export function moveNewDraft(fromProjectId: string, toProjectId: string): boolean {
  if (fromProjectId === toProjectId) return false;
  restoreNewDraft(fromProjectId);
  restoreNewDraft(toProjectId);
  const from = newChatDraftKey(fromProjectId);
  const to = newChatDraftKey(toProjectId);
  const moving = getDraft(from);
  if (moving.trim() === '') return false;
  const waiting = getDraft(to);
  put(to, moving);
  put(from, waiting);
  setNewDraft(toProjectId, moving);
  setNewDraft(fromProjectId, waiting);
  return true;
}

function forgetAll(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  saved.clear();
  loading.clear();
  inFlight.clear();
  settledAt.clear();
  useDrafts.setState({ texts: {}, loaded: {} }, true);
}

if (typeof window !== 'undefined') {
  onSessionEnd(forgetAll);
  // A last save while the page goes away; `keepalive` lets it finish afterwards.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllDrafts(true);
  });
  window.addEventListener('pagehide', () => flushAllDrafts(true));
}

/** For tests. */
export function __resetDraftsForTests(): void {
  forgetAll();
}
