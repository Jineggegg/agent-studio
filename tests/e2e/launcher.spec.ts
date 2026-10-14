import type { StudioApi } from './support/api.js';
import { appTile, launcher } from './support/home.js';
import { expect, test } from './support/test.js';

/** The launcher, the theme switch, and the language. */

test.afterEach(async ({ api }) => {
  // Theme and language belong to the account, which every other test shares: leave them as they were.
  await api.setPreferences({ 'appearance.theme': null, 'appearance.language': null });
});

/** Preferences are saved shortly after a change; wait for the account to hold it before relying on it elsewhere. */
async function savedPreference(api: StudioApi, key: string): Promise<unknown> {
  const { values } = await api.call<{ values: Record<string, unknown> }>('GET', '/api/preferences');
  return values[key] ?? null;
}

test('the launcher shows the day, the apps and the projects, and opens each', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const project = await api.createProject({
    name: unique('Launcher'),
    rootDir: freshFolder('launcher'),
  });
  await page.goto('/');

  // Today's date heads the screen (the browser runs in UTC).
  const today = new Date();
  await expect(
    page.getByText(today.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }),
      { exact: true },
    ),
  ).toBeVisible();

  for (const app of ['Workbench', 'Inbox', 'Memory', 'Usage', 'Settings'])
    await expect(appTile(page, app)).toBeVisible();
  await expect(appTile(page, 'Inbox')).toHaveAccessibleName(/^Inbox (Nothing waiting|\d+ waiting)/);
  await expect(launcher(page).getByRole('button', { name: 'New project' })).toBeAttached();

  // A system tile opens its app; Back returns to the launcher.
  await appTile(page, 'Inbox').click();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await expect(launcher(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // A project tile (on whichever page of tiles it landed) opens the project's workbench.
  await launcher(page).getByRole('button', { name: project.name }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/p/${project.id}/`));
  await expect(page.getByRole('textbox', { name: /^Message / })).toBeVisible();
});

test('the theme switches to dark and back, from the launcher and from Settings', async ({
  page,
  api,
}) => {
  const html = page.locator('html');
  await page.goto('/');
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Switch to dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light' })).toBeVisible();
  // The choice is the account's: once saved, it survives a reload.
  await expect.poll(() => savedPreference(api, 'appearance.theme')).toBe('dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  // Settings has the same choice as a quick control.
  await page.goto('/settings');
  const theme = page.getByRole('radiogroup', { name: 'Theme' }).first();
  await expect(theme.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await theme.getByRole('radio', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(theme.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect.poll(() => savedPreference(api, 'appearance.theme')).toBe('light');
});

// One change makes one view transition (Chromium has them; so does Safari 18+): the account sync re-reading the
// preference that was just set must not start a second one, which would skip the first and leave its promise
// rejecting unheard ("AbortError: Transition was skipped").
test('switching the theme with view transitions raises no error', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The console guard fails the test on the AbortError when the page settles.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-fade', /.+/);
});

test('the language switches to Chinese and back', async ({ page, api, layout }) => {
  const html = page.locator('html');
  await page.goto('/settings/appearance');
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /^Language: / }).click();
  // A menu on tablet and desktop, a sheet of the same items on a phone.
  await page.getByRole('menuitemradio', { name: '简体中文' }).click();
  await expect(html).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { name: '外观', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^语言/ })).toBeVisible();

  // The rest of the app follows, also after a reload.
  await expect.poll(() => savedPreference(api, 'appearance.language')).toBe('zh-CN');
  await page.goto('/');
  const tiles = page.getByRole('group', { name: '应用与项目' });
  await expect(tiles.getByRole('button', { name: /^收件箱/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换到深色' })).toBeVisible();
  await page.reload();
  await expect(html).toHaveAttribute('lang', 'zh-CN');

  await page.goto('/settings/appearance');
  await page.getByRole('button', { name: /^语言/ }).click();
  await page.getByRole('menuitemradio', { name: 'English' }).click();
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
  if (layout !== 'phone')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect.poll(() => savedPreference(api, 'appearance.language')).toBe('en');
});
