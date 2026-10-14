import type { Page } from '@playwright/test';
import { launcher } from './support/home.js';
import { expect, test } from './support/test.js';
import {
  composer,
  openNewConversation,
  runEnds,
  send,
  sendButton,
  settled,
} from './support/workbench.js';

/** What only a phone has: the list as a drawer, the tools full screen, the field above the keyboard. */

test.beforeEach(({ layout }) => {
  test.skip(layout !== 'phone', 'The phone layout exists only at phone width.');
});

/** Fails when the page itself can be scrolled sideways (content wider than the screen). */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    window.scrollTo(240, window.scrollY);
    const scrolled = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return { scrollWidth: root.scrollWidth, width: window.innerWidth, scrolled };
  });
  expect(overflow.scrolled, `${where}: the page scrolled sideways`).toBe(0);
  expect(overflow.scrollWidth, `${where}: the page is wider than the screen`).toBeLessThanOrEqual(
    overflow.width,
  );
}

test('the conversation list is a drawer, and the project tools fill the screen', async ({
  page,
  api,
  unique,
  freshFolder,
  viewport,
}) => {
  const project = await api.createProject({
    name: unique('Drawer'),
    rootDir: freshFolder('drawer'),
  });
  await openNewConversation(page, project.id);
  await send(page, '[[quick]] Something for the list');
  await expect(runEnds(page)).toHaveCount(1);
  const width = viewport!.width;
  const height = viewport!.height;

  // No list beside the chat on a phone: a button brings it up from the leading edge, over the chat.
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Show conversations/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Conversations' });
  await expect(drawer).toBeVisible();
  await settled(drawer);
  const box = (await drawer.boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.height)).toBe(height);
  expect(box.width).toBeLessThan(width);
  // The conversation is titled after the first words of its first message.
  const row = drawer.getByRole('button', { name: /^\[\[quick\]\] Something for the\b/ });
  await expect(row).toBeVisible();

  // Escape puts it away; choosing a conversation does too.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await page.getByRole('button', { name: /^Show conversations/ }).click();
  await drawer.getByRole('button', { name: 'New conversation' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/workbench/p/${project.id}/new$`));

  // The project's tools cover the whole screen, and the chat underneath takes no input meanwhile.
  await page.getByRole('button', { name: 'Show project tools' }).click();
  const tools = page.getByRole('complementary', { name: 'Project tools' });
  await expect(tools).toBeVisible();
  await settled(tools);
  const toolsBox = (await tools.boundingBox())!;
  expect([
    Math.round(toolsBox.x),
    Math.round(toolsBox.y),
    Math.round(toolsBox.width),
    Math.round(toolsBox.height),
  ]).toEqual([0, 0, width, height]);
  await expect(tools.getByRole('tablist', { name: 'Project tools' })).toBeVisible();
  await expect(page.locator('main.wb__main')).toHaveAttribute('inert', '');
  await tools.getByRole('button', { name: 'Hide project tools' }).click();
  await expect(tools).toBeHidden();
  await expect(composer(page)).toBeVisible();
});

test('the message field stays above the keyboard, and no screen scrolls sideways', async ({
  page,
  api,
  unique,
  freshFolder,
  viewport,
}) => {
  const project = await api.createProject({
    name: unique('Keyboard'),
    rootDir: freshFolder('keyboard'),
  });
  await openNewConversation(page, project.id);
  const field = composer(page);
  const { width, height } = viewport!;

  const inView = async (limit: number) => {
    const fieldBox = (await field.boundingBox())!;
    const sendBox = (await sendButton(page).boundingBox())!;
    expect(fieldBox.y).toBeGreaterThanOrEqual(0);
    expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(limit);
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(limit);
  };
  await field.focus();
  await inView(height);

  // A soft keyboard takes the bottom of the screen and leaves a shorter visual viewport. Headless browsers have no
  // keyboard, so the viewport is shortened by a typical keyboard's height instead; the app sizes itself to it.
  const keyboard = 336;
  await page.setViewportSize({ width, height: height - keyboard });
  await expect
    .poll(async () => {
      const box = await field.boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(height - keyboard);
  await inView(height - keyboard);
  await field.fill('Typed with the keyboard up');
  await expect(sendButton(page)).toBeEnabled();
  await expect(sendButton(page)).toBeInViewport();
  await page.setViewportSize({ width, height });
  await field.fill('');

  await expectNoSidewaysScroll(page, 'a new conversation');
  await send(page, '[[code]] A long line, a table and a wide code block');
  await expect(runEnds(page)).toHaveCount(1);
  await expectNoSidewaysScroll(page, 'a conversation with wide content');

  for (const [address, heading] of [
    ['/', null],
    ['/settings', 'Settings'],
    ['/settings/account', 'Account & security'],
    ['/memory', 'Memory'],
    ['/inbox', 'Inbox'],
    ['/usage', 'Usage'],
  ] as const) {
    await page.goto(address);
    if (heading)
      await expect(page.getByRole('heading', { name: heading, level: 1 }).first()).toBeVisible();
    else await expect(launcher(page)).toBeVisible();
    await expectNoSidewaysScroll(page, address);
  }
});
