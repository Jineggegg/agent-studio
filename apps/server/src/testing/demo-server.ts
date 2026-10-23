#!/usr/bin/env node
/* eslint-disable no-console */
import { ConfigError, loadConfig } from '../kernel/config.js';
import { createStudio } from '../kernel/studio.js';
import { createAgentsModule } from '../modules/agents/agents.module.js';
import { modules } from '../modules/index.js';
import { demoAgentModule } from './demo-agent.js';

/**
 * The normal server plus the demo agents, for looking at the workbench and
 * for the browser test suite. Configured like the real one, through
 * `AGENT_STUDIO_*` variables:
 *
 *   AGENT_STUDIO_DATA_DIR=$(mktemp -d) AGENT_STUDIO_PORT=7560 \
 *   AGENT_STUDIO_SETUP_TOKEN=local-setup-token-123456 AGENT_STUDIO_WEB_DIR=apps/web/dist \
 *   npx tsx --tsconfig apps/server/tsconfig.json apps/server/src/testing/demo-server.ts
 *
 * Two extra variables exist only here, to make waiting states short enough to watch:
 *
 *   AGENT_STUDIO_DEMO_APPROVAL_TTL_MS   how long an approval or plan waits before it expires
 *   AGENT_STUDIO_DEMO_QUESTION_TTL_MS   how long a question waits before it is answered by itself
 *
 * This file lives under `src/testing/`, which the production build leaves
 * out; `main.ts` never imports it.
 */

function milliseconds(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new ConfigError(`${name} must be a whole number of milliseconds, got "${raw}".`);
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const approvalTtlMs = milliseconds('AGENT_STUDIO_DEMO_APPROVAL_TTL_MS');
  const questionTtlMs = milliseconds('AGENT_STUDIO_DEMO_QUESTION_TTL_MS');
  const timing = {
    ...(approvalTtlMs === undefined ? {} : { approvalTtlMs }),
    ...(questionTtlMs === undefined ? {} : { questionTtlMs }),
  };

  const composed = [
    ...modules.map((module) =>
      module.name === 'agents' && Object.keys(timing).length > 0
        ? createAgentsModule(timing)
        : module,
    ),
    demoAgentModule(),
  ];
  const studio = await createStudio(config, composed);
  const { url } = await studio.start();

  console.log(`\n  Cloud Harness (demo agents registered) is running at ${url}`);
  if (!config.webDir)
    console.log('  (API only: no web client build was found — set AGENT_STUDIO_WEB_DIR)');
  const setup = studio.context.services.auth.pendingSetupToken();
  if (setup) console.log(`\n  First run — setup token: ${setup.token}\n`);

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
  console.error(error instanceof ConfigError ? `Configuration problem: ${error.message}` : error);
  process.exit(1);
});
