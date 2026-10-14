import type { Locator, Page } from '@playwright/test';

/** The launcher's pages of tiles. */
export const launcher = (page: Page): Locator =>
  page.getByRole('group', { name: 'Apps and projects' });

/**
 * A system app's tile. Its accessible name is the app's name followed by its
 * status ("Inbox 1 waiting"), so it is found by its title, which is the bare
 * name — a project called "Inbox something" has a different title.
 */
export const appTile = (page: Page, name: string): Locator =>
  launcher(page)
    .getByRole('button')
    .and(page.getByTitle(name, { exact: true }));
