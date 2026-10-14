import type { Page } from '@playwright/test';
import { type Exemption, visibleControls } from './support/a11y.js';
import { launcher } from './support/home.js';
import { makeSampleRepository } from './support/repo.js';
import { expect, test } from './support/test.js';
import { openNewConversation, runEnds, send, settled } from './support/workbench.js';

/**
 * Accessibility smoke test on a few key screens: every interactive element on
 * screen has an accessible name, and on a phone a hit area of at least
 * 44 × 44 CSS px (README rule 3), measured as described in support/a11y.ts.
 */

const MIN_HIT = 44;

/** Controls allowed below the rule on purpose. Each needs a reason a reviewer would accept. */
const EXEMPTIONS: readonly Exemption[] = [
  // On a phone the permission chip (34 px, widened to 44 by `::after { inset: -5px }`) sits 4 px from the context
  // ring (44 px): their hit areas share one pixel, so each measures 43 px across. Still checked, at 43.
  {
    selector: 'button.wb-ring, button.wb-mode',
    reason: 'shares one pixel with its neighbour in the title bar',
    minimum: MIN_HIT - 1,
  },
];

async function checkScreen(
  page: Page,
  screen: string,
  phone: boolean,
  exemptions: readonly Exemption[],
): Promise<void> {
  const controls = await visibleControls(page, exemptions);
  expect(controls.length, `${screen}: no interactive element was found on screen`).toBeGreaterThan(
    0,
  );
  for (const control of controls) {
    await expect
      .soft(
        page.locator(`[data-e2e-control="${control.id}"]`),
        `${screen}: ${control.description} has no accessible name`,
      )
      .toHaveAccessibleName(/\S/, { timeout: 2000 });
  }
  if (!phone) return;
  const small = controls
    .filter((control) => {
      const minimum = control.exemption === null ? MIN_HIT : (control.exemption.minimum ?? 0);
      return control.hit.width < minimum || control.hit.height < minimum;
    })
    .map(
      (control) =>
        `${control.description}: hit area ${control.hit.width} × ${control.hit.height} (drawn ${control.box.width} × ${control.box.height})`,
    );
  expect
    .soft(small, `${screen}: controls a finger can miss (under ${MIN_HIT} × ${MIN_HIT} CSS px)`)
    .toEqual([]);
}

async function tourKeyScreens(
  page: Page,
  projectId: string,
  phone: boolean,
  exemptions: readonly Exemption[],
): Promise<void> {
  await test.step('launcher', async () => {
    await page.goto('/');
    await expect(launcher(page)).toBeVisible();
    await checkScreen(page, 'launcher', phone, exemptions);
  });

  await test.step('new project sheet', async () => {
    await launcher(page).getByRole('button', { name: 'New project' }).click();
    const sheet = page.getByRole('dialog', { name: 'New project' });
    await expect(sheet).toBeVisible();
    await settled(sheet);
    await checkScreen(page, 'new project sheet', phone, exemptions);
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);
  });

  await test.step('conversation', async () => {
    await openNewConversation(page, projectId);
    await send(page, '[[quick]] [[tools]]');
    await expect(runEnds(page)).toHaveCount(1);
    await checkScreen(page, 'conversation', phone, exemptions);
  });

  await test.step('project tools', async () => {
    await page.getByRole('button', { name: 'Show project tools' }).click();
    const tools = page.getByRole('complementary', { name: 'Project tools' });
    await expect(tools.getByRole('tree')).toBeVisible();
    await settled(tools);
    await checkScreen(page, 'project tools', phone, exemptions);
  });

  for (const [address, heading] of [
    ['/settings', 'Settings'],
    ['/memory', 'Memory'],
    ['/inbox', 'Inbox'],
  ] as const) {
    await test.step(address, async () => {
      await page.goto(address);
      await expect(page.getByRole('heading', { name: heading, level: 1 }).first()).toBeVisible();
      await checkScreen(page, address, phone, exemptions);
    });
  }
}

test('key screens: every control has a name, and on a phone room for a finger', async ({
  page,
  api,
  unique,
  freshFolder,
  layout,
}) => {
  const folder = freshFolder('access');
  makeSampleRepository(folder);
  const project = await api.createProject({
    name: unique('Access'),
    rootDir: folder,
    createDirectory: false,
  });
  await tourKeyScreens(page, project.id, layout === 'phone', EXEMPTIONS);
});

// Four controls once left a finger less than 44 × 44 px because the pseudo-element widening their hit area was
// clipped or covered: the conversation title and the project link in the title bar (each truncated by
// `overflow: hidden` on itself — now on the text inside), Memory's folder chips (clipped by their sideways-scrolling
// row — which now has room above and below), and an edit's tool row (covered by the diff preview's negative margin).
// With no exemption but the deliberate one above, every control on these screens must give a finger 44 × 44 px.
test('on a phone, every control gives a finger at least 44 × 44 px', async ({
  page,
  api,
  unique,
  freshFolder,
  layout,
}) => {
  test.skip(layout !== 'phone', 'The hit-area rule is checked at phone size.');
  const folder = freshFolder('access-strict');
  makeSampleRepository(folder);
  const project = await api.createProject({
    name: unique('Strict'),
    rootDir: folder,
    createDirectory: false,
  });
  await tourKeyScreens(page, project.id, true, EXEMPTIONS);
});
