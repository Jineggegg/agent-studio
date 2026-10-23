import { expect, test } from './support/test.js';

test('new tools open with empty private configuration and no horizontal overflow', async ({
  page,
}) => {
  for (const [route, title, text] of [
    ['/mailbox', 'Mailbox', 'Connect a mailbox to read your mail'],
    [
      '/tool-library',
      'Tools and skills',
      'Your MCP connections, skill instructions and reusable prompts.',
    ],
    ['/browser', 'Agent browser', 'The instance owner has not configured Chromium.'],
    ['/settings/devices', 'Devices', 'No paired devices.'],
  ]) {
    await page.goto(route!);
    await expect(page.getByRole('heading', { name: title!, level: 1 })).toBeVisible();
    await expect(page.getByText(text!, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ visible: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(2);
  }
});

test('a reusable command can be created and edited without contacting an external service', async ({
  page,
  layout,
}) => {
  const name = `e2e-${layout}-${Date.now()}`;
  await page.goto('/tool-library');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // A skill and a slash command share the editor, but have distinct invocation prefixes.
  await dialog.getByLabel('Name (lowercase letters and hyphens)').fill(name);
  await dialog
    .getByLabel('Instructions', { exact: true })
    .fill('Review this synthetic example: $ARGUMENTS');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const card = page.locator('.library-card').filter({ hasText: name });
  await expect(card.getByText(`/skill:${name}`, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Review this synthetic example: $ARGUMENTS',
  );
  await dialog
    .getByLabel('Instructions', { exact: true })
    .fill('Explain this synthetic example: $ARGUMENTS');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByText(/Version 2/)).toBeVisible();
});

test('mail credentials stay masked in an otherwise empty setup', async ({ page }) => {
  await page.goto('/mailbox');
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('OAuth access token', { exact: true })).toHaveAttribute(
    'type',
    'password',
  );
  await expect(dialog.getByLabel('OAuth access token', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Save account', exact: true })).toBeDisabled();
});
