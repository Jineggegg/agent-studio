import { launcher } from './support/home.js';
import { expect, test } from './support/test.js';
import {
  agentChip,
  chooseDemoAgent,
  composer,
  longScenePartCounts,
  openNewConversation,
  runEnds,
  send,
  sendButton,
  stopButton,
  transcript,
} from './support/workbench.js';

/**
 * Conversations with the demo agent. Its scenes are deterministic: the same
 * marker always plays the same events (apps/server/src/testing/demo-agent.ts).
 */

test('a project made in the UI opens its workbench, and the demo agent answers there', async ({
  page,
  unique,
  freshFolder,
}) => {
  const name = unique('Garden');
  await page.goto('/');
  await launcher(page).getByRole('button', { name: 'New project' }).click();
  const sheet = page.getByRole('dialog', { name: 'New project' });
  await sheet.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await sheet.getByRole('textbox', { name: 'Folder', exact: true }).fill(freshFolder('garden'));
  await sheet.getByRole('switch', { name: /^Create the folder/ }).click();
  await sheet.getByRole('button', { name: 'Create', exact: true }).click();

  // The new project's workbench, on a new conversation.
  await expect(page).toHaveURL(/\/workbench\/p\/[^/]+\/new$/);
  await expect(page.getByRole('heading', { name: 'New conversation', level: 1 })).toBeVisible();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(agentChip(page)).not.toHaveAccessibleName(/Choose an agent/);

  // Every agent is offered in a new project; the demo agent is chosen from the picker.
  await chooseDemoAgent(page);
  await expect(composer(page)).toHaveAccessibleName('Message Demo agent');
  await send(page, 'Hello from the browser tests');

  // The first message creates the conversation; the address follows it.
  await expect(page).toHaveURL(/\/workbench\/p\/[^/]+\/s\/[^/]+$/);
  const chat = transcript(page);
  // The message, then the agent's answer: a step it took, and what it wrote.
  await expect(
    chat.getByText('Hello from the browser tests', { exact: true }).first(),
  ).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Read README.md Done' })).toBeVisible();
  await expect(
    chat.getByRole('paragraph').filter({ hasText: 'You said: Hello from the browser tests' }),
  ).toBeVisible();
  await expect(chat.getByText('This is the demo agent.', { exact: false })).toBeVisible();
  await expect(runEnds(page)).toHaveCount(1);
  await expect(runEnds(page).first()).toContainText('Finished');
  await expect(sendButton(page)).toBeDisabled();
});

test('a tools scene lists each call, and an edit opens on its diff', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const project = await api.createProject({ name: unique('Tools'), rootDir: freshFolder('tools') });
  await openNewConversation(page, project.id);
  await send(page, '[[tools]] Look at the health route');

  const chat = transcript(page);
  await expect(runEnds(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(runEnds(page)).toContainText('Finished');
  for (const name of [
    'Read src/app.ts Done',
    'Search /health — src Done',
    'Run npm test -- --reporter=dot Done',
    'Edit src/app.ts 4 lines added, 2 removed Done',
    'Run npm run lint Failed',
    'Fetch https://example.com/docs/routing Done',
  ]) {
    await expect(chat.getByRole('button', { name, exact: true })).toBeVisible();
  }

  // A command's row opens on its output…
  const tests = chat.getByRole('button', {
    name: 'Run npm test -- --reporter=dot Done',
    exact: true,
  });
  await tests.click();
  await expect(tests).toHaveAttribute('aria-expanded', 'true');
  await expect(chat.getByText('Tests  13 passed (13)', { exact: false })).toBeVisible();

  // …and the edit's row on the change it made, line by line.
  const edit = chat.getByRole('button', {
    name: 'Edit src/app.ts 4 lines added, 2 removed Done',
    exact: true,
  });
  await edit.click();
  const diff = chat.getByRole('group', { name: 'Changes to src/app.ts' });
  await expect(diff).toBeVisible();
  await expect(diff).toContainText('router.get("/version", () => ({ version: config.version }));');
  await expect(diff).toContainText('app.listen(config.port ?? 3000);');
  await expect(
    diff.getByText('router.get("/health", () => "ok");', { exact: false }),
  ).toBeVisible();
});

test('one request is allowed and the next denied, and the agent goes on accordingly', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const project = await api.createProject({
    name: unique('Approvals'),
    rootDir: freshFolder('approvals'),
  });
  await openNewConversation(page, project.id);
  const chat = transcript(page);

  await send(page, '[[approve]] May I run the tests?');
  const allow = page.getByRole('button', { name: 'Allow', exact: true });
  await expect(page.getByText('Demo agent wants to run a command').first()).toBeVisible();
  await expect(chat.getByRole('button', { name: /^Run npm test/ })).toBeVisible();
  await allow.click();
  await expect(chat.getByText('The tests pass, so I will carry on.')).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Run npm test Done', exact: true })).toBeVisible();
  await expect(runEnds(page)).toHaveCount(1);

  await send(page, '[[approve]] And once more?');
  await expect(page.getByText('Demo agent wants to run a command').first()).toBeVisible();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(
    chat.getByText('I did not run the tests: The user denied this request.'),
  ).toBeVisible();
  await expect(
    chat.getByRole('button', { name: 'Run npm test Denied', exact: true }),
  ).toBeVisible();
  await expect(runEnds(page)).toHaveCount(2);
  await expect(runEnds(page).nth(1)).toContainText('Finished');
  // Nothing is left waiting for an answer.
  await expect(page.getByText('Demo agent wants to run a command')).toHaveCount(0);
  await expect(allow).toHaveCount(0);
});

test('a long answer streams in, and stopping it ends the run exactly once', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const project = await api.createProject({ name: unique('Stop'), rootDir: freshFolder('stop') });
  await openNewConversation(page, project.id);
  const chat = transcript(page);

  await send(page, '[[long]]');
  // Streamed: the first part is on screen before all of it has arrived (checked every frame), then fills in.
  await page.waitForFunction(
    () => {
      const paragraphs = document.querySelectorAll('[role="region"][aria-label="Conversation"] p');
      const first = [...paragraphs].find((paragraph) =>
        paragraph.textContent?.startsWith('Part 1 of 14.'),
      );
      return first !== undefined && !first.textContent!.trimEnd().endsWith('without jumping.');
    },
    undefined,
    { polling: 'raf', timeout: 15_000 },
  );
  // The status line under the transcript says what the agent is doing meanwhile.
  await expect(chat.getByRole('status').filter({ hasText: /Writing|Thinking/ })).toBeVisible();
  const firstPart = chat.getByRole('paragraph').filter({ hasText: 'Part 1 of 14.' });
  await expect(firstPart).toContainText(
    'so the view has to keep its place at the bottom without jumping.',
  );

  await expect(chat.getByText('Part 2 of 14.')).toBeVisible();
  await stopButton(page).click();
  await expect(runEnds(page)).toHaveCount(1);
  await expect(runEnds(page)).toContainText('Stopped');
  await expect(chat.getByText('Cut short').first()).toBeVisible();
  await expect(stopButton(page)).toHaveCount(0);

  // One final state: a next run starts and finishes, and the stopped one never turns into anything else.
  await send(page, '[[quick]] Still there?');
  await expect(runEnds(page)).toHaveCount(2);
  await expect(runEnds(page).nth(0)).toContainText('Stopped');
  await expect(runEnds(page).nth(1)).toContainText('Finished');
  await expect(chat.getByText('That was the whole of it.')).toHaveCount(0);
  await expect(chat.getByText('Part 14 of 14.')).toHaveCount(0);
});

test('reloading in the middle of a stream shows every part once', async ({
  page,
  api,
  unique,
  freshFolder,
}) => {
  const project = await api.createProject({
    name: unique('Reload'),
    rootDir: freshFolder('reload'),
  });
  await openNewConversation(page, project.id);
  const chat = transcript(page);

  await send(page, '[[long]]');
  await expect(chat.getByText('Part 2 of 14.')).toBeVisible();
  await page.reload();

  // The conversation comes back mid-run and carries on streaming.
  await expect(chat.getByText('Part 4 of 14.')).toBeVisible({ timeout: 20_000 });
  await expect(stopButton(page)).toBeVisible();
  await stopButton(page).click();
  await expect(runEnds(page)).toHaveCount(1);
  await expect(runEnds(page)).toContainText('Stopped');

  // Each part that is drawn is drawn once, with no gaps between them; the message itself is there once.
  const counts = await longScenePartCounts(page);
  const parts = [...counts.keys()].sort((a, b) => a - b);
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...parts)).toBeGreaterThanOrEqual(4);
  for (const part of parts)
    expect(counts.get(part), `"Part ${part} of 14." is shown ${counts.get(part)} times`).toBe(1);
  expect(parts).toEqual(Array.from({ length: parts.length }, (_, index) => parts[0]! + index));
  await expect(chat.getByText('[[long]]', { exact: true })).toHaveCount(1);
});
