import { create } from 'zustand';
import { prefersReducedMotion } from './media';

/**
 * Light, dark, or automatic (follow the system).
 *
 * /boot.js applies the saved choice before first paint; this module takes over
 * from there. The account preference `appearance.theme` is the authority when
 * signed in ("light" | "dark"; absent means automatic) — `shell/appearance.ts`
 * feeds it in — and a copy is kept on the device for the next cold start.
 */
export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'auto';

/** Shared with public/boot.js. */
export const THEME_STORAGE_KEY = 'studio.theme';
export const THEME_PREFERENCE_KEY = 'appearance.theme';
/** Shared with public/boot.js and the manifest: the browser / status-bar colour of each theme. */
export const THEME_COLORS: Record<Theme, string> = { light: '#f3f1ec', dark: '#100f0e' };

interface ThemeState {
  preference: ThemePreference;
  theme: Theme;
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initialState(): ThemeState {
  if (typeof document === 'undefined') return { preference: 'auto', theme: 'light' };
  const root = document.documentElement;
  const preference = root.dataset.themePreference;
  const theme = root.dataset.theme;
  const pref: ThemePreference = preference === 'light' || preference === 'dark' ? preference : 'auto';
  return { preference: pref, theme: theme === 'dark' || theme === 'light' ? theme : pref === 'auto' ? systemTheme() : pref };
}

export const useThemeStore = create<ThemeState>(initialState);

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function paint(preference: ThemePreference, theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

/** What the browser's view transition hands back; every promise may reject when the transition is skipped. */
interface ViewTransitionLike {
  ready?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
  finished?: Promise<unknown>;
}

/**
 * The theme a cross-fade is on its way to. Until its callback has run, the
 * store still holds the old theme; anything asking for the same theme in the
 * meantime (the account sync re-reading the preference that was just set)
 * must see that it is already under way, not start a second transition that
 * would skip the first.
 */
let underway: { preference: ThemePreference; theme: Theme } | null = null;
/** Each request gets a number; a commit that is not the newest request's does nothing. */
let requested = 0;

/**
 * Apply a theme choice to this page and remember it on the device.
 * `crossFade` blends the whole screen from the old theme to the new one where
 * the browser can; elsewhere the change is immediate. One change makes one
 * transition, and nothing it starts is left to reject unheard.
 */
export function applyThemePreference(preference: ThemePreference, options: { crossFade?: boolean; remember?: boolean } = {}): void {
  const theme = preference === 'auto' ? systemTheme() : preference;
  if (options.remember !== false) {
    try {
      if (preference === 'auto') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  }
  const current = useThemeStore.getState();
  if (underway) {
    if (underway.preference === preference && underway.theme === theme) return;
  } else if (current.preference === preference && current.theme === theme && document.documentElement.dataset.theme === theme) {
    return;
  }

  const request = (requested += 1);
  const commit = () => {
    if (request !== requested) return;
    underway = null;
    paint(preference, theme);
    useThemeStore.setState({ preference, theme });
  };
  const shownTheme = underway?.theme ?? current.theme;
  const startViewTransition = (document as Document & { startViewTransition?: (callback: () => void) => unknown }).startViewTransition;
  if (options.crossFade && shownTheme !== theme && typeof startViewTransition === 'function' && document.visibilityState === 'visible') {
    // A plain cross-fade of the whole page: also what reduced motion wants.
    document.documentElement.dataset.themeFade = prefersReducedMotion() ? 'reduced' : 'full';
    underway = { preference, theme };
    try {
      const transition = startViewTransition.call(document, commit) as ViewTransitionLike;
      // A transition can still be skipped (the tab hides, another change follows quickly): its promises then
      // reject. The update callback runs either way, so nothing is lost — and nothing may reject unheard.
      transition.ready?.catch(() => undefined);
      transition.updateCallbackDone?.catch(() => undefined);
      void transition.finished
        ?.catch(() => undefined)
        .finally(() => {
          // A newer cross-fade still on its way keeps the mark; otherwise the page is settled.
          if (underway === null) delete document.documentElement.dataset.themeFade;
        });
      return;
    } catch {
      underway = null;
      delete document.documentElement.dataset.themeFade;
    }
  }
  commit();
}

/** Follow the system live while the choice is "automatic". */
export function startThemeTracking(): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', () => {
    const { preference } = useThemeStore.getState();
    if (preference === 'auto') applyThemePreference('auto', { crossFade: true, remember: false });
  });
}

/** Erase the device's copy (on sign-out, so the next person does not inherit the look). */
export function forgetThemePreference(): void {
  applyThemePreference('auto');
}

export const useTheme = (): Theme => useThemeStore((state) => state.theme);
export const useThemePreference = (): ThemePreference => useThemeStore((state) => state.preference);
