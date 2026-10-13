import { PREFERENCES_CHANGED, type Preferences, preferencesSchema } from '@agent-studio/protocol';
import { z } from 'zod';
import { create } from 'zustand';
import { api, isApiError } from './api';

/**
 * Account preferences: a small key → value map that follows the user to every
 * device. The server is the authority. Locally:
 *
 *  - a change applies at once and is sent after a short pause (several quick
 *    changes travel together); it is flushed when the page is hidden;
 *  - a copy is kept on the device so the next start can draw before the
 *    server has answered;
 *  - a value arriving from another device replaces ours key by key — except
 *    for a key we have changed and not yet saved: there our change wins;
 *  - signing out erases the local copy.
 *
 * Keys are namespaced by feature: "appearance.theme", "home.layout", …
 */

interface PreferencesState {
  values: Preferences;
  /** True once the server's values have been read in this session. */
  loaded: boolean;
  /** The last save did not reach the server; it will be retried. */
  saveFailed: boolean;
}

export const usePreferences = create<PreferencesState>(() => ({ values: {}, loaded: false, saveFailed: false }));

const MIRROR_KEY = 'studio.preferences';
const SAVE_DELAY_MS = 400;
const RETRY_DELAY_MS = 10_000;
const responseSchema = z.object({ values: preferencesSchema });

let userId: string | null = null;
/** Changes made here and not yet confirmed by the server. null = remove. */
const pending = new Map<string, unknown>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;

function writeMirror(): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(MIRROR_KEY, JSON.stringify({ userId, values: usePreferences.getState().values }));
  } catch {
    /* storage full or unavailable: the mirror is only an optimisation */
  }
}

function readMirror(forUser: string): Preferences | null {
  try {
    const raw = window.localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed = z.object({ userId: z.string(), values: preferencesSchema }).safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.userId === forUser ? parsed.data.values : null;
  } catch {
    return null;
  }
}

function withPending(server: Preferences): Preferences {
  const merged: Preferences = { ...server };
  for (const [key, value] of pending) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** A session began: draw from the device's copy straight away. */
export function beginPreferences(forUser: string): void {
  if (userId !== forUser) pending.clear();
  userId = forUser;
  usePreferences.setState({ values: readMirror(forUser) ?? {}, loaded: false, saveFailed: false });
}

/** Read the server's values. Safe to call often; it never undoes an unsaved local change. */
export async function loadPreferences(): Promise<void> {
  if (!userId) return;
  const forUser = userId;
  const { values } = await api.get('/api/preferences', { schema: responseSchema });
  if (userId !== forUser) return;
  usePreferences.setState({ values: withPending(values), loaded: true });
  writeMirror();
}

/** The session ended: forget everything, including the copy on this device. */
export function forgetPreferences(): void {
  userId = null;
  pending.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    window.localStorage.removeItem(MIRROR_KEY);
  } catch {
    /* ignore */
  }
  usePreferences.setState({ values: {}, loaded: false, saveFailed: false });
}

async function save(keepalive = false): Promise<void> {
  if (saving) {
    await saving;
    if (pending.size === 0) return;
  }
  if (!userId || pending.size === 0) return;
  const forUser = userId;
  const sent = new Map(pending);
  saving = (async () => {
    try {
      const { values } = await api.patch('/api/preferences', { values: Object.fromEntries(sent) }, { schema: responseSchema, keepalive });
      if (userId !== forUser) return;
      // Only what was sent, and has not been changed again since, is settled.
      for (const [key, value] of sent) if (Object.is(pending.get(key), value)) pending.delete(key);
      usePreferences.setState({ values: withPending(values), loaded: true, saveFailed: false });
      writeMirror();
    } catch (error) {
      if (userId !== forUser) return;
      if (isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 401) {
        // The server will never accept this change. Drop it and show what the server has.
        for (const key of sent.keys()) pending.delete(key);
        usePreferences.setState({ saveFailed: true });
        void loadPreferences().catch(() => {});
        return;
      }
      usePreferences.setState({ saveFailed: true });
      if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; void save(); }, RETRY_DELAY_MS);
    } finally {
      saving = null;
    }
  })();
  await saving;
}

/** Change preferences. `null` removes a key. Applied locally at once, saved shortly after. */
export function setPreferences(patch: Record<string, unknown>): void {
  const values = { ...usePreferences.getState().values };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete values[key];
      pending.set(key, null);
    } else {
      values[key] = value;
      pending.set(key, value);
    }
  }
  usePreferences.setState({ values });
  writeMirror();
  if (!userId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, SAVE_DELAY_MS);
}

export const setPreference = (key: string, value: unknown): void => setPreferences({ [key]: value });

/** Send unsaved changes now. `keepalive` lets the request finish after the page is hidden. */
export function flushPreferences(keepalive = false): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  return save(keepalive);
}

/** Another device changed something: `values` is the patch it saved (null = removed). */
export function applyRemotePreferences(patch: Record<string, unknown>): void {
  const values = { ...usePreferences.getState().values };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (pending.has(key)) continue; // our own unsaved change wins
    if (value === null || value === undefined) {
      if (key in values) {
        delete values[key];
        changed = true;
      }
    } else if (JSON.stringify(values[key]) !== JSON.stringify(value)) {
      values[key] = value;
      changed = true;
    }
  }
  if (!changed) return;
  usePreferences.setState({ values });
  writeMirror();
}

/** Handles a realtime event from the `user:<id>` topic. */
export function handlePreferencesEvent(event: { type: string; data: unknown }): void {
  if (event.type !== PREFERENCES_CHANGED) return;
  const parsed = z.object({ values: z.record(z.string(), z.unknown()) }).safeParse(event.data);
  if (parsed.success) applyRemotePreferences(parsed.data.values);
}

/**
 * Read one preference in a component. `parse` turns the stored JSON into the
 * value you want and supplies the default — stored data is never trusted to
 * have the right shape:
 *
 *   const mode = usePreference('usage.display', (v) => (v === 'used' ? 'used' : 'remaining'));
 */
export function usePreference<T>(key: string, parse: (value: unknown) => T): T {
  return usePreferences((state) => parse(state.values[key]));
}

export const getPreference = (key: string): unknown => usePreferences.getState().values[key];

/** For tests. */
export function __resetPreferencesForTests(): void {
  userId = null;
  pending.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saving = null;
  usePreferences.setState({ values: {}, loaded: false, saveFailed: false }, true);
}
