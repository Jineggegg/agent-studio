import { FIRST_RUN_PORT, OWNER, SETUP_TOKEN } from './support/env.js';
import { type StudioServer, startStudioServer } from './support/server.js';
import { expect, test } from './support/test.js';

/**
 * First run, through the UI. The owner can be created only once per server,
 * and the suite's own server already has one (the global setup made it), so
 * this spec starts a fresh server of its own — with an empty data directory —
 * for each test (each project, each retry), and removes it afterwards.
 */

let server: StudioServer;

test.use({
  storageState: { cookies: [], origins: [] },
  baseURL: `http://127.0.0.1:${FIRST_RUN_PORT}`,
});

test.beforeEach(async () => {
  server = await startStudioServer({ port: FIRST_RUN_PORT });
});

test.afterEach(async () => {
  await server?.stop();
});

test('a fresh Studio asks for its owner, and the form makes one', async ({ page }) => {
  await page.goto('/');
  const form = page.getByRole('form', { name: 'Set up your Studio' });
  await expect(page.getByRole('heading', { name: 'Set up your Studio', level: 1 })).toBeVisible();

  // Checked in the page before anything is sent.
  await form.getByRole('button', { name: 'Create account' }).click();
  await expect(form.getByText('Enter the setup token.')).toBeVisible();

  await form.getByRole('textbox', { name: 'Setup token' }).fill(SETUP_TOKEN);
  await form.getByRole('textbox', { name: 'Username' }).fill(OWNER.username);
  await form.getByRole('textbox', { name: /^Display name/ }).fill(OWNER.displayName);
  await form.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await form.getByLabel('Password again').fill(OWNER.password);
  await form.getByRole('button', { name: 'Create account' }).click();

  // Signed in as the new owner: the launcher, with nothing in it yet but the apps and "New project".
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeAttached();
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
  await expect(page.getByText('No projects yet.', { exact: false })).toBeVisible();

  // The form is gone for good: the server says so, and a reload lands on the launcher again.
  const state = (await (await page.request.get('/api/auth/state')).json()) as {
    needsSetup: boolean;
    user: { username: string; role: string };
  };
  expect(state.needsSetup).toBe(false);
  expect(state.user).toMatchObject({ username: OWNER.username, role: 'owner' });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
});
