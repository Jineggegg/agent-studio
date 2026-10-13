import { Monitor, Moon, Sun } from 'lucide-react';
import { type Translator, useT } from '@/i18n';
import { type ThemePreference, useTheme, useThemePreference } from '@/platform/theme';
import { chooseTheme } from '@/shell/appearance';
import { SegmentedControl } from '@/ui';

function themeOptions(t: Translator) {
  return [
    { value: 'light' as const, label: t('appearance.theme.light'), icon: <Sun size={16} aria-hidden="true" /> },
    { value: 'dark' as const, label: t('appearance.theme.dark'), icon: <Moon size={16} aria-hidden="true" /> },
    { value: 'auto' as const, label: t('appearance.theme.autoShort'), icon: <Monitor size={16} aria-hidden="true" /> },
  ];
}

/** "Automatic · dark right now" — in automatic, say what the system currently resolves to. */
export function themeCaption(preference: ThemePreference, theme: 'light' | 'dark', t: Translator): string | undefined {
  if (preference !== 'auto') return undefined;
  return theme === 'dark' ? t('appearance.theme.autoDark') : t('appearance.theme.autoLight');
}

export function ThemeControl() {
  const t = useT();
  const preference = useThemePreference();
  return <SegmentedControl<ThemePreference> label={t('appearance.theme')} value={preference} onChange={(value) => chooseTheme(value)} options={themeOptions(t)} />;
}

/** The one-tap appearance control on the settings root. */
export function ThemeQuickControl() {
  const t = useT();
  const preference = useThemePreference();
  const theme = useTheme();
  return (
    <div className="settings-quick">
      <span className="text-headline">{t('appearance.theme')}</span>
      <ThemeControl />
      {preference === 'auto' && <span className="settings-quick__caption">{themeCaption(preference, theme, t)}</span>}
    </div>
  );
}

/** For the row of the Appearance page: "Dark", "Automatic". */
export function useThemeSummary(): string {
  const t = useT();
  const preference = useThemePreference();
  return preference === 'light' ? t('appearance.theme.light') : preference === 'dark' ? t('appearance.theme.dark') : t('appearance.theme.auto');
}
