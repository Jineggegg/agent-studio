import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git, makeSampleRepository } from './support/repo.js';
import { expect, test } from './support/test.js';
import { openNewConversation } from './support/workbench.js';

/** The project's tools beside the chat: edit a file and save it, then commit the change from the Git panel. */

test('a file is opened, edited and saved, and the change is committed from Git', async ({
  page,
  api,
  unique,
  freshFolder,
  layout,
}) => {
  const folder = freshFolder('repo');
  makeSampleRepository(folder);
  const project = await api.createProject({
    name: unique('Repository'),
    rootDir: folder,
    createDirectory: false,
  });
  await openNewConversation(page, project.id);

  await page.getByRole('button', { name: 'Show project tools' }).click();
  const tools = page.getByRole('complementary', { name: 'Project tools' });
  await expect(tools.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  const tree = tools.getByRole('tree', { name: `Files of ${project.name}` });
  await expect(tree.getByRole('treeitem', { name: 'src, folder' })).toBeVisible();
  await tree.getByRole('treeitem', { name: 'README.md' }).click();

  // The editor: the file's text, a Save that waits for a change.
  await expect(tools.getByRole('heading', { name: 'README.md', level: 2 })).toBeVisible();
  const text = tools.getByRole('textbox', { name: 'Text of README.md' });
  await expect(text).toContainText('A small project for the browser tests.');
  const save = tools.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await text.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Edited in the browser.');
  await expect(tools.getByRole('img', { name: 'Unsaved changes' })).toBeVisible();
  await save.click();
  await expect(tools.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await expect(tools.getByRole('img', { name: 'Unsaved changes' })).toHaveCount(0);
  expect(readFileSync(path.join(folder, 'README.md'), 'utf8')).toContain('Edited in the browser.');

  // Git sees the change.
  await tools.getByRole('tab', { name: /^Git/ }).click();
  const change = tools.getByRole('button', { name: 'README.md, modified. Show its changes' });
  await expect(change).toBeVisible();
  await change.click();
  await expect(
    tools.getByRole('group', { name: 'Changes to README.md' }).getByText('Edited in the browser.'),
  ).toBeVisible();

  await tools.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(tools.getByRole('region', { name: 'Staged for the commit' })).toBeVisible();
  // A phone keeps the commit box folded until it is asked for.
  if (layout === 'phone')
    await tools.getByRole('button', { name: 'Commit 1 staged file…' }).click();
  await tools.getByRole('textbox', { name: 'Commit message' }).fill('Say what the sample is for');
  await tools.getByRole('button', { name: 'Commit', exact: true }).click();

  // The first commit from the Studio asks once who is committing (kept with the account afterwards).
  const identity = page.getByRole('dialog', { name: 'Who is committing?' });
  const committed = tools.getByText('Nothing has changed');
  await expect(identity.or(committed)).toBeVisible();
  if (await identity.isVisible()) {
    await identity.getByRole('textbox', { name: 'Name on your commits' }).fill('Erin Owner');
    await identity
      .getByRole('textbox', { name: 'E-mail on your commits' })
      .fill('erin@example.invalid');
    await identity.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(identity).toHaveCount(0);
  }
  await expect(committed).toBeVisible();
  await expect(tools.getByRole('tab', { name: /^Git/ })).toHaveAccessibleName('Git');

  expect(git(folder, 'log', '-1', '--format=%s|%an').trim()).toBe(
    'Say what the sample is for|Erin Owner',
  );
  expect(git(folder, 'status', '--porcelain').trim()).toBe('');
});
