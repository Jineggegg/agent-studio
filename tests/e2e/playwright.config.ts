import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { AUTH_FILE, BASE_URL, PORT, repoRoot } from './support/env.js';

/**
 * Browser tests: the built web client, served by the demo server (the real
 * server plus scripted demo agents), driven at phone, tablet and desktop size.
 *
 *   npm run build && npm run test:e2e
 *
 * See tests/e2e/README.md for running a single project, WebKit, and machines
 * without the browser's system libraries.
 */

const CI = Boolean(process.env.CI);
/** WebKit — the engine of Safari on iPhone — runs when this is set (CI sets it). */
const WEBKIT = Boolean(process.env.E2E_WEBKIT);

const phone = {
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: path.join(repoRoot, 'test-results'),
  globalSetup: './global-setup.ts',
  // One browser at a time: the suite shares one server, and machines running it may be small.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ...(CI ? [['github'] as const] : []),
    ['html', { outputFolder: path.join(repoRoot, 'playwright-report'), open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    // Signed in as the owner (written by the global setup); specs about signing in start from nothing instead.
    storageState: AUTH_FILE,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], ...phone, browserName: 'chromium' },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Galaxy Tab S9'],
        viewport: { width: 820, height: 1180 },
        screen: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        browserName: 'chromium',
      },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        browserName: 'chromium',
      },
    },
    ...(WEBKIT
      ? [
          {
            name: 'phone-webkit',
            use: {
              ...devices['iPhone 13'],
              ...phone,
              deviceScaleFactor: 3,
              browserName: 'webkit' as const,
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: 'node --import tsx tests/e2e/support/launch-server.ts',
    cwd: repoRoot,
    url: `${BASE_URL}/api/health`,
    // Every run starts from nothing: never attach to a server that is already there.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // SIGTERM lets the launcher stop the server and delete the run's data, workspace and home directory.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: { E2E_PORT: String(PORT) },
  },
});
