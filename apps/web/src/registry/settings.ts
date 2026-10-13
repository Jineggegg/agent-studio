import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { MessageKey } from '@/i18n';
import type { Tint } from '@/ui/tints';

/**
 * The settings pages. A feature adds its page in one call:
 *
 *   registerSettingsPage({
 *     id: 'notifications', title: 'settings.notifications.title', group: 'general',
 *     icon: Bell, tint: 'red', load: () => import('./NotificationSettings'),
 *   });
 *
 * and gets: a row in the settings list (with its current value, if it gives
 * one), a deep-linkable address `/settings/<id>`, the split view on tablet and
 * wide, push navigation with scroll restoration on phone.
 */
export type SettingsGroup = 'account' | 'general' | 'assistants' | 'connections' | 'system';

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['account', 'general', 'assistants', 'connections', 'system'];

export interface SettingsPage {
  /** The address segment: the page lives at `/settings/<id>`. Lower-case letters, digits and dashes. */
  id: string;
  title: MessageKey;
  icon: LucideIcon;
  tint: Tint;
  group: SettingsGroup;
  /** Position within the group; lower comes first. Default 100. */
  order?: number;
  /** `owner` hides the page from members and refuses them at its address. Default `user`. */
  access?: 'user' | 'owner';
  /** `() => import('./MyPage')` — the default export renders the page's content (use `SettingsPageBody`). */
  load: () => Promise<{ default: ComponentType }>;
  /** A hook returning the page's current value, shown in grey on its row ("Dark", "2 devices"). */
  useSummary?: () => string | undefined;
  /**
   * For a page one level deeper: the id of the page it belongs to. It gets no
   * row of its own, its parent stays marked in the list, and its back control
   * names the parent.
   */
  parent?: string;
}

/** A control on the settings root itself, changed with one tap and no navigation (appearance, for example). */
export interface SettingsQuickControl {
  id: string;
  order?: number;
  Component: ComponentType;
}

const pages: SettingsPage[] = [];
const quickControls: SettingsQuickControl[] = [];

export function registerSettingsPage(...added: SettingsPage[]): void {
  for (const page of added) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(page.id)) throw new Error(`"${page.id}" is not a valid settings page id.`);
    if (pages.some((existing) => existing.id === page.id)) throw new Error(`The settings page "${page.id}" is registered twice.`);
    pages.push(page);
  }
}

export function registerSettingsQuickControl(control: SettingsQuickControl): void {
  if (quickControls.some((existing) => existing.id === control.id)) throw new Error(`The quick control "${control.id}" is registered twice.`);
  quickControls.push(control);
}

const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 100) - (b.order ?? 100);

/** The pages a user with `role` may see, in display order. */
export function settingsPages(role: 'owner' | 'member'): SettingsPage[] {
  return pages
    .filter((page) => page.access !== 'owner' || role === 'owner')
    .sort((a, b) => SETTINGS_GROUPS.indexOf(a.group) - SETTINGS_GROUPS.indexOf(b.group) || byOrder(a, b));
}

export function findSettingsPage(id: string): SettingsPage | null {
  return pages.find((page) => page.id === id) ?? null;
}

export function settingsQuickControls(): SettingsQuickControl[] {
  return [...quickControls].sort(byOrder);
}

/** The address of a settings page, for links from elsewhere (a widget that says "not configured", a notification). */
export const settingsPath = (id?: string): string => (id ? `/settings/${id}` : '/settings');

/** For tests. */
export function __resetSettingsForTests(): void {
  pages.length = 0;
  quickControls.length = 0;
}
