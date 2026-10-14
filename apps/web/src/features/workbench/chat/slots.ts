import type { Project, Role } from '@agent-studio/protocol';
import type { ComponentType } from 'react';

/**
 * A place in the conversation's title bar that other features can fill — the
 * branch and its pull request, say. Typed, small, and nothing more than a
 * list: with no item registered the title bar is exactly as it was.
 *
 *   // src/features/github/index.ts
 *   registerTitleBarItem({ id: 'branch', order: 10, load: () => import('./BranchChip'), available: ({ role }) => role === 'owner' });
 */
export interface TitleBarItemProps {
  project: Project;
  /** The open conversation; null before its first message. */
  sessionId: string | null;
  /** An agent is at work in the open conversation. An item that shows the result of that work re-reads when this turns false. */
  busy: boolean;
  /** There is little room (a phone): draw the short form. */
  compact: boolean;
}

export interface TitleBarItem {
  /** Lower-case and stable. */
  id: string;
  /** Position among the items; lower comes first. Default 100. */
  order?: number;
  /** `() => import('./BranchChip')` — downloaded when the title bar first needs it. The component may render nothing. */
  load: () => Promise<{ default: ComponentType<TitleBarItemProps> }>;
  /** Whether the item has anything to say here. Default: always, inside a project. */
  available?: (context: { project: Project; role: Role }) => boolean;
}

const items: TitleBarItem[] = [];
const listeners = new Set<() => void>();
let version = 0;

/** Add an item to the title bar. Call at module load, from the feature's `index.ts`. */
export function registerTitleBarItem(...added: TitleBarItem[]): void {
  for (const item of added) {
    if (!/^[a-z][a-z0-9-]*$/.test(item.id)) throw new Error(`"${item.id}" is not a valid title bar item id.`);
    if (items.some((existing) => existing.id === item.id)) throw new Error(`The title bar item "${item.id}" is registered twice.`);
    items.push(item);
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The items that apply to this project and person, in display order. */
export function titleBarItems(context: { project: Project; role: Role }): TitleBarItem[] {
  return items.filter((item) => item.available?.(context) ?? true).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function subscribeTitleBarItems(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const titleBarItemsVersion = (): number => version;

/** For tests. */
export function __resetTitleBarItemsForTests(): void {
  items.length = 0;
  version += 1;
}
