import { type Locator, type Page, expect } from '@playwright/test';

/**
 * The workbench as a person sees it: a conversation, its message field and
 * its send button. Names are the client's English accessible names.
 */

export const composer = (page: Page): Locator => page.getByRole('textbox', { name: /^Message / });
export const transcript = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversation' });
export const agentChip = (page: Page): Locator =>
  page.getByRole('button', { name: /^Agent and model:/ });
export const sendButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Send', exact: true });
/** The square button that replaces Send while a run is in progress and the field is empty. */
export const stopButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Stop the agent', exact: true });
/** The line that closes a run: "Finished · …", "Stopped · …", "Failed · …". */
export const runEnds = (page: Page): Locator =>
  transcript(page)
    .getByRole('note')
    .filter({ hasText: /^(Finished|Stopped|Failed|Interrupted)/ });

/** Opens a new conversation in a project and waits until it is ready to be written in. */
export async function openNewConversation(page: Page, projectId: string): Promise<void> {
  await page.goto(`/workbench/p/${projectId}/new`);
  await expect(composer(page)).toBeVisible();
  // The agent list arrives after the screen; until then the chip asks for a choice and the field may be replaced once.
  await expect(agentChip(page)).not.toHaveAccessibleName(/Choose an agent/);
}

/** Makes sure a new conversation will go to the demo agent, choosing it in the picker when another one is offered first. */
export async function chooseDemoAgent(page: Page): Promise<void> {
  const chip = agentChip(page);
  if ((await chip.getAttribute('aria-label'))?.startsWith('Agent and model: Demo agent ·')) return;
  await chip.click();
  const picker = page.getByRole('dialog', { name: 'Agent and model' });
  await picker
    .getByRole('region', { name: 'Demo agent', exact: true })
    .getByRole('radio', { name: /^Demo Large/ })
    .click();
  await expect(picker).toBeHidden();
  await expect(chip).toHaveAccessibleName('Agent and model: Demo agent · Demo Large');
}

/** Types a message and presses Send (on a touch keyboard Enter is a new line, so the button is what people use). */
export async function send(page: Page, text: string): Promise<void> {
  const field = composer(page);
  await field.fill(text);
  await sendButton(page).click();
  await expect(field).toHaveValue('');
}

/** Counts each "Part N of 14." of the `[[long]]` scene among the rows the transcript has drawn. */
export async function longScenePartCounts(page: Page): Promise<Map<number, number>> {
  const text = await transcript(page).innerText();
  const counts = new Map<number, number>();
  for (const match of text.matchAll(/Part (\d+) of 14\./g)) {
    const part = Number(match[1]);
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  return counts;
}

/** Waits for CSS transitions and animations under `locator` to end (a drawer sliding in, a sheet rising). */
export async function settled(locator: Locator): Promise<void> {
  await locator.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}
