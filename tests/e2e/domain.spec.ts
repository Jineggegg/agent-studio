import { visibleControls } from './support/a11y.js';
import { expect, test } from './support/test.js';

test('owner can prepare domain configuration without changing the server', async ({
  page,
  layout,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/system/info' && request.method() !== 'GET') {
      writes.push(request.method());
    }
  });
  await page.goto('/settings');
  await page.locator('a[href="/settings/domain"]').click();
  await expect(page.getByRole('heading', { name: 'Your workspace. Your address.' })).toBeVisible();
  await expect(page.getByText('No public address configured')).toBeVisible();
  await page.getByLabel('Your domain', { exact: true }).fill('harness.example.com');
  await page.getByLabel('Local service port', { exact: true }).fill('7421');
  await expect(page.locator('pre[aria-label="Caddyfile"]')).toContainText(
    'reverse_proxy 127.0.0.1:7421',
  );
  await expect(page.getByText('Address not yet listed in server configuration')).toBeVisible();
  const cloudflare = page.getByRole('radio', { name: 'Cloudflare Tunnel', exact: true });
  await cloudflare.focus();
  await page.keyboard.press('Space');
  await expect(cloudflare).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('pre[aria-label="Service URL"]')).toHaveText('http://127.0.0.1:7421');
  await expect(page.getByRole('link', { name: 'Open your address' })).toHaveAttribute(
    'href',
    'https://harness.example.com',
  );
  await expect(page.locator('html')).toHaveAttribute('data-layout', layout);
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel('Your domain', { exact: true }).fill('harness.example.com;echo unsafe');
  await expect(page.getByRole('alert')).toContainText('Enter a full DNS hostname');
  await expect(page.getByRole('button', { name: 'Copy Service URL' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open your address' })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('domain setup controls remain named and usable on a phone', async ({ page, layout }) => {
  test.skip(layout !== 'phone', 'Touch targets are measured at phone size.');
  await page.goto('/settings/domain');
  await page.getByLabel('Your domain', { exact: true }).fill('harness.example.com');
  await expect(page.locator('#launch')).toHaveCount(0);
  const controls = await visibleControls(page, []);
  for (const control of controls) {
    await expect(page.locator(`[data-e2e-control="${control.id}"]`)).toHaveAccessibleName(/\S/);
    expect(control.hit.width, `${control.description}: touch width`).toBeGreaterThanOrEqual(44);
    expect(control.hit.height, `${control.description}: touch height`).toBeGreaterThanOrEqual(44);
  }
});
