import { create } from 'zustand';

/**
 * How the launcher looks on this device — names under the tiles, large
 * icons. Per device on purpose (a phone and a desktop want different
 * things) and kept in this browser only: it names nothing of the person's.
 */
export interface HomeLook {
  showNames: boolean;
  largeIcons: boolean;
}

const STORAGE_KEY = 'studio.home.look';
const DEFAULT_LOOK: HomeLook = { showNames: true, largeIcons: false };

function read(): HomeLook {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LOOK;
    const value = JSON.parse(raw) as Partial<Record<keyof HomeLook, unknown>>;
    return { showNames: value.showNames !== false, largeIcons: value.largeIcons === true };
  } catch {
    return DEFAULT_LOOK;
  }
}

export const useHomeLook = create<HomeLook>(read);

export function setHomeLook(patch: Partial<HomeLook>): void {
  useHomeLook.setState(patch);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(useHomeLook.getState()));
  } catch {
    /* only a convenience */
  }
}
