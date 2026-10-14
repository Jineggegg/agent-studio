import { OWNER } from './support/env.js';
import { expect, test } from './support/test.js';
import { openNewConversation } from './support/workbench.js';

/** A shell on the server, in the project's folder, through the Terminal panel. */

test('a terminal opens in the project, runs a command and shows its output', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const capability = await api.call<{ available: boolean; reason: string | null }>(
    'GET',
    '/api/terminal/capability',
  );
  test.skip(
    !capability.available,
    `The server cannot open a pseudo-terminal here: ${capability.reason ?? 'no reason given'}`,
  );

  const project = await api.createProject({ name: unique('Shell'), rootDir: freshFolder('shell') });
  await openNewConversation(page, project.id);
  await page.getByRole('button', { name: 'Show project tools' }).click();
  const tools = page.getByRole('complementary', { name: 'Project tools' });
  await tools.getByRole('tab', { name: 'Terminal' }).click();

  // With no terminal yet the panel opens one; a sign-in older than a quarter of an hour is asked to confirm first.
  const open = tools.getByRole('button', { name: 'Open a terminal' });
  const input = tools.getByRole('textbox', { name: 'Terminal input' });
  await expect(open.or(input)).toBeVisible();
  if (await open.isVisible()) await open.click();
  const confirm = page.getByRole('dialog', { name: 'Confirm it’s you' });
  if (await confirm.isVisible()) {
    await confirm.getByLabel('Password', { exact: true }).fill(OWNER.password);
    await confirm.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(tools.getByRole('tab', { name: project.name })).toBeVisible();

  // The shell's prompt is up when the screen shows the project's folder.
  const screen = tools.locator('.xterm-rows');
  await expect(screen).toContainText('$', { timeout: 20_000 });
  await input.focus();
  await page.keyboard.type('echo hello');
  await page.keyboard.press('Enter');

  // The command is echoed after the prompt (a long prompt wraps on a narrow screen, so rows are joined to read it),
  // and its output stands on a line of its own.
  await expect
    .poll(async () => (await screen.innerText()).split('\n').join(''))
    .toContain('$ echo hello');
  await expect
    .poll(async () => (await screen.innerText()).split('\n').map((line) => line.trim()))
    .toContain('hello');
});
