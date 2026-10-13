import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-studio/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __BUILD_ID__: JSON.stringify('test-build'),
    __BUILD_TIME__: JSON.stringify(0),
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
