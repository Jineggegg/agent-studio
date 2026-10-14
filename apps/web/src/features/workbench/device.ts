import type { PermissionMode } from '@agent-studio/protocol';
import { create } from 'zustand';
import { onSessionEnd } from '@/data/auth';

/**
 * What the workbench remembers on this device: how the screen is arranged,
 * where the reader was, and the choices a new conversation starts from.
 *
 * It is not an account preference — a phone and a desktop are arranged
 * differently on purpose — so it lives in localStorage, and because it names
 * the user's projects and conversations it is erased when the session ends.
 */
export type ListScope = 'project' | 'all';

export const INSPECTOR_MIN_WIDTH = 320;
export const INSPECTOR_MAX_WIDTH = 1100;
export const INSPECTOR_DEFAULT_WIDTH = 440;

/**
 * The docked conversation list (tablet and wide). At 240 px the scope switch
 * keeps both its labels, "New conversation" keeps its draft badge, the search
 * field its shortcut hint, and a row a readable part of its title beside the
 * time; beyond 480 px a row gains nothing but empty space, while the chat
 * loses the width it reads best at. 320 is what the list was before it could
 * be resized.
 */
export const LIST_MIN_WIDTH = 240;
export const LIST_MAX_WIDTH = 480;
export const LIST_DEFAULT_WIDTH = 320;

export interface DeviceMemory {
  /** Which list sits beside the chat. */
  scope: ListScope;
  lastProjectId: string | null;
  /** Per project: the conversation last on screen there, or `new` for an unsent one. */
  lastConversation: Record<string, string>;
  /** The docked list is hidden (tablet and wide). */
  listCollapsed: boolean;
  /** How wide the docked list was made, in CSS px. What fits beside the chat is decided when it is drawn. */
  listWidth: number;
  inspector: { open: boolean; panel: string | null; width: number };
  /** What the next new conversation starts with. */
  lastAgentId: string | null;
  lastModel: Record<string, string>;
  lastEffort: Record<string, string>;
  lastMode: Record<string, PermissionMode>;
  /** Unsent text of a conversation that does not exist on the server yet, per project. */
  newDrafts: Record<string, string>;
}

const STORAGE_KEY = 'studio.workbench.device';
const MAX_REMEMBERED = 60;

export const DEFAULT_MEMORY: DeviceMemory = {
  scope: 'project',
  lastProjectId: null,
  lastConversation: {},
  listCollapsed: false,
  listWidth: LIST_DEFAULT_WIDTH,
  inspector: { open: false, panel: null, width: INSPECTOR_DEFAULT_WIDTH },
  lastAgentId: null,
  lastModel: {},
  lastEffort: {},
  lastMode: {},
  newDrafts: {},
};

const MODES: readonly PermissionMode[] = ['plan', 'ask', 'accept-edits', 'auto'];

function stringMap(value: unknown, limit = MAX_REMEMBERED): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries.slice(-limit));
}

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)));
}

export function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return LIST_DEFAULT_WIDTH;
  return Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.round(width)));
}

/** Stored data is never trusted to have the right shape: every field is read defensively. */
export function parseDeviceMemory(raw: unknown): DeviceMemory {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_MEMORY;
  const value = raw as Record<string, unknown>;
  const inspector = (typeof value.inspector === 'object' && value.inspector !== null ? value.inspector : {}) as Record<string, unknown>;
  return {
    scope: value.scope === 'all' ? 'all' : 'project',
    lastProjectId: typeof value.lastProjectId === 'string' ? value.lastProjectId : null,
    lastConversation: stringMap(value.lastConversation),
    listCollapsed: value.listCollapsed === true,
    listWidth: clampListWidth(typeof value.listWidth === 'number' ? value.listWidth : LIST_DEFAULT_WIDTH),
    inspector: {
      open: inspector.open === true,
      panel: typeof inspector.panel === 'string' ? inspector.panel : null,
      width: clampInspectorWidth(typeof inspector.width === 'number' ? inspector.width : INSPECTOR_DEFAULT_WIDTH),
    },
    lastAgentId: typeof value.lastAgentId === 'string' ? value.lastAgentId : null,
    lastModel: stringMap(value.lastModel),
    lastEffort: stringMap(value.lastEffort),
    lastMode: Object.fromEntries(Object.entries(stringMap(value.lastMode)).filter((entry): entry is [string, PermissionMode] => (MODES as readonly string[]).includes(entry[1]))),
    newDrafts: stringMap(value.newDrafts, 20),
  };
}

function read(): DeviceMemory {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseDeviceMemory(JSON.parse(raw)) : DEFAULT_MEMORY;
  } catch {
    return DEFAULT_MEMORY;
  }
}

export const useDeviceMemory = create<DeviceMemory>(() => (typeof window === 'undefined' ? DEFAULT_MEMORY : read()));

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function write(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(useDeviceMemory.getState()));
  } catch {
    /* storage full or unavailable: the memory lasts for this page only */
  }
}

function persist(): void {
  if (writeTimer) return;
  // Several changes in one tick (a drag, a burst of key presses) become one write.
  writeTimer = setTimeout(write, 120);
}

/** A change made just before the page goes away (a reload, a closed tab) is written at once rather than lost. */
function flush(): void {
  if (writeTimer) write();
}

export function remember(patch: Partial<DeviceMemory>): void {
  useDeviceMemory.setState(patch);
  persist();
}

/** Bounded so a device that has opened hundreds of projects does not grow its memory for ever. */
function withEntry<T>(map: Record<string, T>, key: string, value: T | null, limit = MAX_REMEMBERED): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [name, item] of Object.entries(map)) if (name !== key) next[name] = item;
  if (value !== null) next[key] = value;
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - limit))) delete next[stale];
  return next;
}

export function rememberConversation(projectId: string, conversation: string | null): void {
  const state = useDeviceMemory.getState();
  if (state.lastProjectId === projectId && (state.lastConversation[projectId] ?? null) === conversation) return;
  remember({ lastProjectId: projectId, lastConversation: withEntry(state.lastConversation, projectId, conversation) });
}

export function forgetConversation(projectId: string, sessionId: string): void {
  const state = useDeviceMemory.getState();
  if (state.lastConversation[projectId] !== sessionId) return;
  remember({ lastConversation: withEntry(state.lastConversation, projectId, null) });
}

export function rememberAgentChoice(choice: { agentId: string; model?: string | null; effort?: string | null; mode?: PermissionMode | null }): void {
  const state = useDeviceMemory.getState();
  const patch: Partial<DeviceMemory> = { lastAgentId: choice.agentId };
  if (choice.model !== undefined) patch.lastModel = withEntry(state.lastModel, choice.agentId, choice.model);
  if (choice.effort !== undefined && choice.model) patch.lastEffort = withEntry(state.lastEffort, `${choice.agentId}:${choice.model}`, choice.effort);
  if (choice.mode !== undefined) patch.lastMode = withEntry(state.lastMode, choice.agentId, choice.mode);
  remember(patch);
}

export function setNewDraft(projectId: string, text: string): void {
  const state = useDeviceMemory.getState();
  const value = text.trim() === '' ? null : text;
  if ((state.newDrafts[projectId] ?? null) === value) return;
  remember({ newDrafts: withEntry(state.newDrafts, projectId, value, 20) });
}

export function setInspectorMemory(patch: Partial<DeviceMemory['inspector']>): void {
  const current = useDeviceMemory.getState().inspector;
  remember({ inspector: { ...current, ...patch, width: clampInspectorWidth(patch.width ?? current.width) } });
}

/** Remembers how wide the docked list was made; double-clicking its edge passes the default. */
export function setListWidth(width: number): void {
  const next = clampListWidth(width);
  if (useDeviceMemory.getState().listWidth !== next) remember({ listWidth: next });
}

function forget(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  useDeviceMemory.setState(DEFAULT_MEMORY, true);
}

if (typeof window !== 'undefined') {
  onSessionEnd(forget);
  window.addEventListener('pagehide', flush);
}

/** For tests. */
export function __resetDeviceMemoryForTests(): void {
  forget();
}
