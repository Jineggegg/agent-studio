import { defineConfig } from 'vitest/config';

// One command runs every suite; `--project <name>` selects one.
// Projects: protocol, plugin-sdk, server, server-integration, web, acceptance.
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/server/vitest.config.ts',
      'apps/server/vitest.integration.config.ts',
      'apps/web/vitest.config.ts',
      'tests/acceptance/vitest.config.ts',
    ],
    // Keep the suite gentle on small machines (CI runners, a home server).
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**', 'packages/*/src/**'],
      exclude: ['**/*.test.*', '**/testing/**', '**/test/**'],
    },
  },
});
