import { type LanguagePreference, LANGUAGES, useLanguage, useLanguagePreference, useT } from '@/i18n';
import { useTheme, useThemePreference } from '@/platform/theme';
import { chooseLanguage } from '@/shell/appearance';
import { List, ListRow, Select } from '@/ui';
import { ThemeControl, themeCaption } from '../appearance';

/** Theme and language. Both follow the account to every device. */
export default function AppearancePage() {
  const t = useT();
  const preference = useThemePreference();
  const theme = useTheme();
  const languagePreference = useLanguagePreference();
  const language = useLanguage();
  const systemLanguage = LANGUAGES.find((item) => item.code === language)?.name ?? '';

  return (
    <>
      <List header={t('appearance.theme')} footer={themeCaption(preference, theme, t) ?? t('appearance.theme.hint')}>
        <div role="listitem" className="settings-quick">
          <ThemeControl />
        </div>
      </List>

      <List header={t('appearance.language')} footer={t('appearance.language.hint')}>
        <ListRow
          title={t('appearance.language')}
          control={
            <Select<LanguagePreference>
              label={t('appearance.language')}
              value={languagePreference}
              onChange={chooseLanguage}
              quiet
              options={[
                { value: 'auto', label: t('appearance.language.auto'), hint: languagePreference === 'auto' ? systemLanguage : undefined } as { value: LanguagePreference; label: string; hint?: string },
                ...LANGUAGES.map((item) => ({ value: item.code as LanguagePreference, label: item.name })),
              ]}
            />
          }
        />
      </List>
    </>
  );
}
