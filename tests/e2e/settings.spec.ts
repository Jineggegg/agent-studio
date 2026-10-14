import type { Page } from '@playwright/test';
import { expect, test } from './support/test.js';

/** Every page the settings list leads to opens with its heading and without an error. */

interface Row {
  readonly href: string;
  readonly title: string;
}

/** The settings list as the person sees it: each row's address and title, in order. */
async function settingsRows(page: Page): Promise<Row[]> {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  const links = page.locator('a[href^="/settings/"]');
  await expect(links.first()).toBeVisible();
  return links.evaluateAll((elements) =>
    elements.map((element) => ({
      href: element.getAttribute('href') ?? '',
      // The account row is titled with the person's name; its page with what it is about.
      title:
        element.getAttribute('href') === '/settings/account'
          ? 'Account & security'
          : (element.querySelector('.ui-row__title')?.textContent ?? '').trim(),
    })),
  );
}

async function expectNoErrorState(page: Page, where: string): Promise<void> {
  for (const words of [
    'This screen ran into a problem',
    'This part of the app did not load',
    'No such settings page',
    'Only the owner can open this',
  ]) {
    await expect(page.getByText(words), `${where}: "${words}"`).toHaveCount(0);
  }
  // Failed reads are drawn as alerts (ErrorState, danger banners); a page that loaded has none.
  await expect(
    page.getByRole('alert').filter({ visible: true }),
    `${where}: an error is shown`,
  ).toHaveCount(0);
}

test('every page in the settings list opens with its heading and no error', async ({
  page,
  layout,
}) => {
  const rows = await settingsRows(page);
  // The foundation's pages and the ones the features add (the list grows as features register theirs).
  expect(rows.map((row) => row.href)).toEqual(
    expect.arrayContaining([
      '/settings/account',
      '/settings/people',
      '/settings/appearance',
      '/settings/projects',
      '/settings/about',
    ]),
  );

  for (const row of rows) {
    await test.step(row.title, async () => {
      if (layout === 'phone') {
        // One screen at a time: the row pushes its page, Back returns to the list.
        await page.goto('/settings');
        await page.locator(`a[href="${row.href}"]`).click();
      } else {
        // The list stays beside the page.
        await page.locator(`a[href="${row.href}"]`).click();
      }
      await expect(page).toHaveURL(new RegExp(`${row.href}$`));
      await expect(page.getByRole('heading', { name: row.title, level: 1 })).toBeVisible();
      // Give lazy content its first read: whatever was loading has either arrived or failed by now.
      await expect(
        page.getByText('Loading…', { exact: true }).filter({ visible: true }),
      ).toHaveCount(0);
      await expectNoErrorState(page, row.href);
    });
  }
});
