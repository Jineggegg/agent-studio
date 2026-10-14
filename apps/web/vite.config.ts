import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

const serverPort = Number(process.env.AGENT_STUDIO_PORT ?? 7420);
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Gives every build an identity. The id is compiled into the bundle and also
 * written to /version.json; a long-lived page compares the two to notice that
 * a newer build has been deployed (see src/pwa/update.ts).
 */
function buildIdentity(): Plugin {
  let buildId = 'dev';
  let builtAt = 0;
  return {
    name: 'agent-studio:build-identity',
    config(_config, { command }) {
      if (command === 'build') {
        builtAt = Date.now();
        buildId = `${builtAt.toString(36)}-${randomBytes(4).toString('hex')}`;
      }
      return {
        define: {
          __BUILD_ID__: JSON.stringify(buildId),
          __BUILD_TIME__: JSON.stringify(builtAt),
          __APP_VERSION__: JSON.stringify(version),
        },
      };
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ buildId, version, builtAt })}\n` });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify({ buildId: 'dev', version, builtAt: 0 }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildIdentity()],
  resolve: {
    alias: {
      '@agent-studio/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5420,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${serverPort}`, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The bundle carries code from many packages whose licences ask for their notices to travel with it.
    license: { fileName: 'third-party-licenses.md' },
    target: 'es2022',
    rolldownOptions: {
      treeshake: {
        // The protocol package is nothing but schema definitions. Declaring its modules free of side effects
        // lets the bundler leave out the contracts of features this build does not use.
        moduleSideEffects: (id) => !id.includes('/packages/protocol/src/'),
      },
    },
  },
});
