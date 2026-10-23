import { visibleControls } from './support/a11y.js';
import { expect, test } from './support/test.js';

for (const scenario of [
  { name: 'a full size control at a scroll boundary', height: 44, cover: 0, expected: 44 },
  { name: 'a genuinely undersized control', height: 30, cover: 0, expected: 30 },
  { name: 'a control covered by a neighbour', height: 44, cover: 8, expected: 36 },
]) {
  test(`hit areas: ${scenario.name}`, async ({ page }) => {
    await page.setContent(`
      <!doctype html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        #scroll { width: 200px; height: 100px; overflow: auto; }
        #content { position: relative; }
        .spacer { height: 100px; }
        button { display: block; width: 100px; height: ${scenario.height}px; padding: 0; border: 0; }
        #cover { position: absolute; left: 0; top: 100px; width: 100px; height: ${scenario.cover}px; }
      </style>
      <div id="scroll">
        <div id="content">
          <div class="spacer"></div>
          <button type="button">Measured control</button>
          <span id="cover"></span>
          <div class="spacer"></div>
        </div>
      </div>
    `);
    const scrollTop = 100 + scenario.height / 2 - 2;
    await page.locator('#scroll').evaluate((element, top) => {
      element.scrollTop = top;
    }, scrollTop);

    // The centre is visible, but part of the button is above the scroll viewport.
    // It must be measured in full, without ignoring either small sizes or overlap.
    const controls = await visibleControls(page);
    expect(controls).toHaveLength(1);
    const height = controls[0]?.hit.height;
    if (scenario.expected === 44) {
      expect(height).toBeGreaterThanOrEqual(44);
    } else {
      // Browser hit testing rounds edge coordinates to its pixel grid. Both defects
      // must still fail the unchanged 44 px requirement, within one pixel of the box.
      expect(height).toBeLessThan(44);
      expect(height).toBeGreaterThanOrEqual(scenario.expected - 1);
      expect(height).toBeLessThanOrEqual(scenario.expected + 1);
    }
    expect(controls[0]?.hit.width).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#scroll')).toHaveJSProperty('scrollTop', scrollTop);
  });
}
