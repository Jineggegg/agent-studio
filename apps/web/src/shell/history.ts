/**
 * What this tab's history looks like, as far as the app has seen it.
 *
 * The browser will not say what is behind the current entry, and "back" needs
 * to know: when the user arrived from another page of the app, back returns
 * there; when they arrived cold (a deep link, a notification, a reload into a
 * fresh tab) there is nothing behind, and back goes to the screen's parent
 * instead — replacing the entry, so the browser's own back button cannot
 * bounce them forward again.
 *
 * The stack is kept in sessionStorage so a reload does not forget it.
 */

export interface HistoryEntry {
  /** react-router's key for the entry. */
  key: string;
  pathname: string;
  /** The title of the screen shown at this entry, once it has said so. */
  title?: string;
}

type Action = 'PUSH' | 'POP' | 'REPLACE';

const STORAGE_KEY = 'studio.history';
const MAX_ENTRIES = 60;

let entries: HistoryEntry[] = [];
let index = -1;
const listeners = new Set<() => void>();

function persist(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, index }));
  } catch {
    /* private mode: the stack lasts until the next reload */
  }
}

function restore(): void {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { entries?: unknown; index?: unknown };
    if (!Array.isArray(parsed.entries) || typeof parsed.index !== 'number') return;
    const valid = parsed.entries.filter(
      (entry): entry is HistoryEntry =>
        typeof entry === 'object' && entry !== null && typeof (entry as HistoryEntry).key === 'string' && typeof (entry as HistoryEntry).pathname === 'string',
    );
    if (valid.length !== parsed.entries.length) return;
    entries = valid;
    index = Math.min(Math.max(parsed.index, 0), entries.length - 1);
  } catch {
    /* corrupt: start again */
  }
}

/** Tell the tracker about a navigation. Called for the first location with `initial`. */
export function recordNavigation(action: Action | 'INITIAL', location: { key: string; pathname: string }): void {
  if (action === 'INITIAL') {
    restore();
    const found = entries.findIndex((entry) => entry.key === location.key);
    if (found === -1) {
      // A fresh tab, or an entry we have never seen: nothing is known to be behind it.
      entries = [{ key: location.key, pathname: location.pathname }];
      index = 0;
    } else {
      index = found;
      entries[found] = { ...entries[found]!, pathname: location.pathname };
    }
  } else if (entries[index]?.key === location.key) {
    entries[index] = { ...entries[index]!, pathname: location.pathname };
  } else if (action === 'PUSH') {
    entries = [...entries.slice(0, index + 1), { key: location.key, pathname: location.pathname }];
    if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
    index = entries.length - 1;
  } else if (action === 'REPLACE') {
    entries = [...entries];
    entries[Math.max(index, 0)] = { key: location.key, pathname: location.pathname };
    index = Math.max(index, 0);
  } else {
    const found = entries.findIndex((entry) => entry.key === location.key);
    if (found === -1) {
      entries = [{ key: location.key, pathname: location.pathname }];
      index = 0;
    } else {
      index = found;
    }
  }
  persist();
  for (const listener of [...listeners]) listener();
}

/** The entry behind the one with `key`, when the app knows of one. */
export function entryBefore(key: string): HistoryEntry | null {
  const at = entries.findIndex((entry) => entry.key === key);
  return at > 0 ? (entries[at - 1] ?? null) : null;
}

/** Remember what the screen at `key` is called, so the screen after it can name it on its back control. */
export function setEntryTitle(key: string, title: string): void {
  const at = entries.findIndex((entry) => entry.key === key);
  if (at === -1 || entries[at]!.title === title) return;
  entries[at] = { ...entries[at]!, title };
  persist();
  for (const listener of [...listeners]) listener();
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that changes whenever the stack does (for useSyncExternalStore). */
let version = 0;
subscribeHistory(() => {
  version += 1;
});
export const historyVersion = (): number => version;

/** For tests. */
export function __resetHistoryForTests(): void {
  entries = [];
  index = -1;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
