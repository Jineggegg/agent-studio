import { OWNER } from './support/env.js';
import { expect, test } from './support/test.js';

/** Signing in and out, starting from a browser that has never been signed in. */

test.use({ storageState: { cookies: [], origins: [] } });

test('a wrong password is refused in words; the right one signs in; signing out returns to sign-in', async ({
  page,
  layout,
  allowConsoleErrors,
}) => {
  // The refused attempt answers 401, which the browser logs as a failed resource load.
  allowConsoleErrors(/status of 401/);

  await page.goto('/');
  const form = page.getByRole('form', { name: 'Sign in' });
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();

  await form.getByRole('textbox', { name: 'Username' }).fill(OWNER.username);
  await form.getByLabel('Password', { exact: true }).fill('not the password at all');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That username or password is not correct.');
  // Still on the sign-in screen, the username kept for another try.
  await expect(form.getByRole('textbox', { name: 'Username' })).toHaveValue(OWNER.username);

  await form.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);

  // Sign out of this device: Settings → Account & security → Sign out, confirmed.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page).toHaveURL(/\/settings/);
  if (layout === 'phone') {
    await page.getByRole('link', { name: /Account & security/ }).click();
  }
  // Tablet and desktop show the first page, Account & security, beside the list already.
  await expect(page.getByRole('heading', { name: 'Account & security', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const question = page.getByRole('alertdialog', { name: 'Sign out of this device?' });
  await question.getByRole('button', { name: 'Sign out', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  const state = (await (await page.request.get('/api/auth/state')).json()) as {
    authenticated: boolean;
  };
  expect(state.authenticated).toBe(false);
  // Nothing of the session is left to come back to.
  await page.goto('/settings/account');
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
});
