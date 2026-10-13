import { defineProject } from 'vitest/config';

// Black-box acceptance tests: they start the built server as a separate
// process and talk to it only through its public HTTP and WebSocket surface.
export default defineProject({
  test: {
    name: 'acceptance',
    environment: 'node',
    include: ['**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
