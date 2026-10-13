import { defineProject } from 'vitest/config';
import { alias } from './vitest.shared.js';

// Integration tests boot a whole server (in-process, temporary data directory)
// and exercise it through its HTTP and WebSocket surface.
export default defineProject({
  resolve: { alias },
  test: {
    name: 'server-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
