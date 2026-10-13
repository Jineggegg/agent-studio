import { defineProject } from 'vitest/config';
import { alias } from './vitest.shared.js';

export default defineProject({
  resolve: { alias },
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
