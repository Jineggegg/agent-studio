import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { StudioApi } from './api.js';
import { WORKSPACE } from './env.js';

export { expect };

/** The client's three layout classes, from the viewport width alone (as `apps/web/src/platform/layout.ts` decides). */
export type Layout = 'phone' | 'tablet' | 'wide';
export const layoutFor = (width: number): Layout =>
  width <= 699 ? 'phone' : width <= 1023 ? 'tablet' : 'wide';

interface ConsoleLog {
  readonly problems: string[];
  readonly allowed: RegExp[];
}

interface Fixtures {
  /** The owner's API session, for set-up a test is not about. */
  api: StudioApi;
  /**
   * Errors this test provokes on purpose (a refused password answers 401, and
   * the browser logs that). Every other console error, uncaught page error or
   * content-security-policy violation fails the test.
   */
  allowConsoleErrors: (...patterns: RegExp[]) => void;
  layout: Layout;
  /** A name no other test (or project, or retry) uses: `<label> <project> <random>`. */
  unique: (label: string) => string;
  /** A folder path inside the server's workspace root that does not exist yet. */
  freshFolder: (label: string) => string;
  consoleLog: ConsoleLog;
}

/**
 * What a browser reports as an error about something working as specified.
 * Each entry needs a reason a reviewer would accept.
 */
const ENGINE_NOTICES: readonly RegExp[] = [
  // A resize observer whose callback changed a size it watches gets its remaining notifications in the next frame —
  // the specified guard against endless loops — and WebKit announces that through window.onerror.
  /^page error: [^:\n]*: ResizeObserver loop completed with undelivered notifications\./,
  // A same-origin API request still in flight when the test navigates is cancelled, and WebKit logs that as a
  // JavaScript error ("access control checks"), which Playwright reports as a page error. The app's own handling of
  // the failed request is unaffected; a real cross-origin failure cannot happen here (the app makes no such request).
  /^page error: Fetch API cannot load http: ?\/{1,2}127\.0\.0\.1:\d+\/api\/\S* due to access control checks\./,
];

/** Runs in every page before the app: reports blocked content in a way every engine records. */
function reportPolicyViolations() {
  document.addEventListener('securitypolicyviolation', (event) => {
    console.error(
      `[csp] "${event.violatedDirective}" blocked ${event.blockedURI || 'an inline resource'} (${event.sourceFile}:${event.lineNumber})`,
    );
  });
}

export const test = base.extend<Fixtures>({
  consoleLog: [
    async ({ context }, use) => {
      const log: ConsoleLog = { problems: [], allowed: [] };
      await context.addInitScript(reportPolicyViolations);
      context.on('console', (message) => {
        if (message.type() !== 'error') return;
        const where = message.location();
        log.problems.push(
          `console error: ${message.text()}${where.url ? ` (${where.url}:${where.lineNumber})` : ''}`,
        );
      });
      context.on('weberror', (webError) => {
        const error = webError.error();
        log.problems.push(
          `page error: ${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`,
        );
      });
      await use(log);
      const unexpected = log.problems.filter(
        (problem) =>
          !log.allowed.some((pattern) => pattern.test(problem)) &&
          !ENGINE_NOTICES.some((pattern) => pattern.test(problem)),
      );
      expect(unexpected, 'console errors, page errors and CSP violations during the test').toEqual(
        [],
      );
    },
    { auto: true },
  ],

  allowConsoleErrors: async ({ consoleLog }, use) => {
    await use((...patterns) => consoleLog.allowed.push(...patterns));
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright's way of saying "needs no other fixture"
  api: async ({}, use) => {
    const api = await StudioApi.signedIn();
    await use(api);
    await api.dispose();
  },

  layout: async ({ viewport }, use) => {
    await use(layoutFor(viewport?.width ?? 1280));
  },

  // eslint-disable-next-line no-empty-pattern
  unique: async ({}, use, testInfo) => {
    await use((label) => `${label} ${testInfo.project.name} ${randomBytes(3).toString('hex')}`);
  },

  // eslint-disable-next-line no-empty-pattern
  freshFolder: async ({}, use, testInfo) => {
    await use((label) =>
      path.join(
        WORKSPACE,
        `${label}-${testInfo.project.name}-${randomBytes(4).toString('hex')}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-'),
      ),
    );
  },
});
