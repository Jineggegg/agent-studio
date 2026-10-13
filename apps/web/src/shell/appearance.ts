import { setPreference, usePreferences } from '@/data/preferences';
import { useSession } from '@/data/session';
import { LANGUAGE_PREFERENCE_KEY, type LanguagePreference, applyLanguagePreference, parseLanguagePreference } from '@/i18n';
import { THEME_PREFERENCE_KEY, type ThemePreference, applyThemePreference, parseThemePreference, startThemeTracking, useThemeStore } from '@/platform/theme';

/**
 * Keeps the look and the language in step with the account.
 *
 * Signed in, the account's preferences decide (so a change made on another
 * device arrives here live); the choice is mirrored on the device so the next
 * cold start paints correctly before any request. Signed out — including
 * right after signing out — the device goes back to following the system, so
 * the next person does not inherit the previous one's look.
 */
export function startAppearanceSync(): void {
  startThemeTracking();

  const sync = () => {
    if (!useSession.getState().authenticated) return;
    const { values } = usePreferences.getState();
    applyThemePreference(parseThemePreference(values[THEME_PREFERENCE_KEY]), { crossFade: true });
    applyLanguagePreference(parseLanguagePreference(values[LANGUAGE_PREFERENCE_KEY]));
  };

  usePreferences.subscribe(sync);
  let wasAuthenticated = useSession.getState().authenticated;
  useSession.subscribe((state) => {
    if (state.authenticated === wasAuthenticated) return;
    wasAuthenticated = state.authenticated;
    if (state.authenticated) {
      sync();
    } else {
      applyThemePreference('auto');
      applyLanguagePreference('auto');
    }
  });
}

/** Choose the theme. Saved to the account when signed in. */
export function chooseTheme(preference: ThemePreference, options: { crossFade?: boolean } = {}): void {
  applyThemePreference(preference, { crossFade: options.crossFade ?? true });
  if (useSession.getState().authenticated) setPreference(THEME_PREFERENCE_KEY, preference === 'auto' ? null : preference);
}

/** The home header's one-tap switch: light ↔ dark, whatever the system says. */
export function toggleTheme(): void {
  chooseTheme(useThemeStore.getState().theme === 'dark' ? 'light' : 'dark');
}

/** Choose the language. Saved to the account when signed in. */
export function chooseLanguage(preference: LanguagePreference): void {
  applyLanguagePreference(preference);
  if (useSession.getState().authenticated) setPreference(LANGUAGE_PREFERENCE_KEY, preference === 'auto' ? null : preference);
}
