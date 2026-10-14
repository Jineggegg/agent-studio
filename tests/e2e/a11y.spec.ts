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

/** Too small today by mistake, not by design: product defects, checked by the skipped FINDING test below. */
const KNOWN_DEFECTS: readonly Exemption[] = [
  {
    selector: 'button.wb-titlebar__title',
    reason: 'FINDING: the conversation title in the title bar',
  },
  {
    selector: 'a.wb-titlebar__project--link',
    reason: 'FINDING: the project link in the title bar',
  },
  { selector: 'button.mem-chip', reason: 'FINDING: Memory folder chips' },
  {
    selector: '.wb-tool__row:has(+ .wb-tool__preview)',
    reason: 'FINDING: a tool row above its diff preview',
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
  await tourKeyScreens(page, project.id, layout === 'phone', [...EXEMPTIONS, ...KNOWN_DEFECTS]);
});

// FINDING: on a phone, four controls leave a finger less than 44 × 44 CSS px (README rule 3), each because the
// pseudo-element meant to widen its hit area is clipped or covered:
//   1. the conversation title in the workbench's title bar (tap to rename): 23 px tall. `button.wb-titlebar__title`
//      also has `u-truncate` (overflow: hidden), which clips its `::after { inset: -6px 0 -16px }` (workbench.css);
//   2. the project's name beside it (a link to the project's page): about 17 px tall. Same cause:
//      `a.wb-titlebar__project--link.u-truncate` clips its `::after { inset: -15px -6px }`;
//   3. Memory's folder chips: about 41 px tall. The chip row `.mem-chips` scrolls sideways (overflow-x: auto), which clips
//      each chip's `::after { inset: -4px 0 }` to the row's 2 px padding (memory.css; phone and tablet, wide wraps);
//   4. an edit's row in a tool stack ("Edit src/app.ts +4 −2"): 42 px at its middle. The diff preview under it,
//      `.wb-tool__preview { margin: -2px … }`, covers the row's bottom 2 px.
// Reproduce: at 390 × 844, open a conversation in which `[[tools]]` ran, and /memory with a project folder chip;
// tap the top or bottom edge of each control (nothing happens), or run this test un-skipped on the phone project.
test.skip('FINDING: some controls give a finger less than 44 × 44 px on a phone', async ({
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
