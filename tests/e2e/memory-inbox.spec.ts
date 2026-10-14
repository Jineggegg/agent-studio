import { randomInt } from 'node:crypto';
import { appTile } from './support/home.js';
import { expect, test } from './support/test.js';
import { openNewConversation, send, transcript } from './support/workbench.js';

/** Memory (notes people and agents keep) and the inbox (what is waiting for a person). */

test('a note written in Memory is found again by searching for it', async ({ page }) => {
  // Search splits words on spaces and punctuation: a made-up word of letters only belongs to this test's note alone.
  const tag = Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join('');
  const keyword = `quokka${tag}`;
  const title = `Release checklist ${tag}`;

  await page.goto('/');
  await appTile(page, 'Memory').click();
  await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New note' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New note' });
  await editor.getByRole('textbox', { name: 'Title' }).fill(title);
  await editor
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill(`Before a release, tag the build and tell the ${keyword} channel.`);
  await editor.getByRole('button', { name: 'Save', exact: true }).click();

  // Saved: the editor gives way to the note itself.
  await expect(editor).toHaveCount(0);
  const reader = page.getByRole('dialog', { name: title });
  await expect(reader).toBeVisible();
  await expect(reader.getByText(keyword, { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  await page.getByRole('searchbox', { name: 'Search memory' }).fill(keyword);
  const hit = page.getByRole('button', { name: new RegExp(`^${title}`) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText(keyword);
  await expect(page.getByRole('button', { name: /^Release checklist/ })).toHaveCount(1);

  // A word that is in no note finds nothing, and says so.
  await page.getByRole('searchbox', { name: 'Search memory' }).fill(`${keyword}x`);
  await expect(page.getByText(`Nothing matches “${keyword}x”`)).toBeVisible();
});

test('a request the agent is waiting on shows in the inbox and leads back to its conversation', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const project = await api.createProject({
    name: unique('Waiting'),
    rootDir: freshFolder('inbox'),
  });
  await openNewConversation(page, project.id);
  await send(page, '[[approve]] Waiting for you in the inbox');
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  const conversation = new URL(page.url()).pathname;

  // Left unanswered, it waits in the inbox.
  await page.goto('/');
  await appTile(page, 'Inbox').click();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  const waiting = page.getByRole('region', { name: /^Awaiting approval/ });
  await expect(waiting).toBeVisible();
  const row = waiting
    .getByRole('button', { name: /^View approval: / })
    .filter({ hasText: project.name });
  await expect(row).toBeVisible();
  // What it waits for, in which project, with which agent.
  await expect(row).toContainText('Waiting for approval');
  await expect(row).toContainText('Demo agent');

  // Opening it shows the request in its conversation, where it is answered.
  await row.click();
  await expect(page).toHaveURL(new RegExp(`${conversation}$`));
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(
    transcript(page).getByText('I did not run the tests: The user denied this request.'),
  ).toBeVisible();

  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^View approval: / }).filter({ hasText: project.name }),
  ).toHaveCount(0);
});
