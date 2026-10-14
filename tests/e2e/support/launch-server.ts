/**
 * The browser suite's web server: `node --import tsx tests/e2e/support/launch-server.ts`.
 *
 * Playwright starts this before the global setup and sends it SIGTERM when the
 * run ends; it then stops the demo server and deletes the run's data
 * directory, workspace and home directory. Run by hand it does the same on
 * Ctrl+C, which makes it a quick way to look at what the tests see.
 */
import { PORT } from './env.js';
import { startStudioServer } from './server.js';

const server = await startStudioServer({ port: PORT, output: 'inherit' });
console.log(
  `[e2e] demo server at ${server.url}; its data, workspace and home are in ${server.root} until it stops`,
);

let closing = false;
const shutdown = (reason: string, exitCode: number) => {
  if (closing) return;
  closing = true;
  console.log(`[e2e] ${reason}: stopping the demo server and removing ${server.root}`);
  server.stop().then(
    () => process.exit(exitCode),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => shutdown(signal, 0));

// A server that stops by itself takes the launcher with it, so the run fails instead of waiting on a dead port.
void server.exited.then((code) => shutdown(`the demo server stopped by itself (code ${code})`, 1));
