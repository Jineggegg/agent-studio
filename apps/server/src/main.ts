#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './kernel/config.js';
import { createStudio } from './kernel/studio.js';
import { modules } from './modules/index.js';

async function main(): Promise<void> {
  // The web client is served from the sibling package's build output unless told otherwise.
  const bundledWeb = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const overrides =
    process.env.AGENT_STUDIO_WEB_DIR === undefined && existsSync(bundledWeb) ? { webDir: bundledWeb } : {};
  const config = loadConfig(process.env, overrides);

  const studio = await createStudio(config, modules);
  const { url } = await studio.start();

  console.log(`\n  Agent Cloud Studio is running at ${url}`);
  if (!config.webDir) console.log('  (API only: no web client build was found)');
  const setup = studio.context.services.auth.pendingSetupToken();
  if (setup) {
    console.log('\n  First run — create the owner account with this one-time setup token:');
    console.log(`\n      ${setup.token}\n`);
    console.log(`  It is also saved in ${setup.file} until setup is complete.\n`);
  }

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n  ${signal} received, shutting down…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    studio.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration problem: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
