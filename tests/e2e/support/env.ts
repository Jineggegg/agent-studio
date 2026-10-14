import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything the browser suite agrees on: where the server runs, where its
 * throw-away data lives, and who the owner is. Values are fixed (not random)
 * because the Playwright runner and each of its workers load this module on
 * their own and must arrive at the same answers.
 */

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The demo server every spec talks to. Override with E2E_PORT (stay inside 7620–7629 on a shared machine). */
export const PORT = Number(process.env.E2E_PORT ?? 7620);
/** A second, fresh server for the first-run spec: the owner can be created only once per server. */
export const FIRST_RUN_PORT = PORT + 1;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** The built client the server hands out. CI builds it first; locally E2E_WEB_DIR may point at a copy. */
export const WEB_DIR = process.env.E2E_WEB_DIR
  ? path.resolve(process.env.E2E_WEB_DIR)
  : path.join(repoRoot, 'apps/web/dist');

/** Stand-in CLIs (`claude`, `codex`, `gh`), first on the server's PATH so that no real one is ever started. */
export const FIXTURE_BIN = path.join(repoRoot, 'tests/fixtures/bin');

export const SETUP_TOKEN = 'e2e-setup-token-000000000001';
export const OWNER = {
  username: 'owner',
  password: 'a passphrase for the browser tests',
  displayName: 'Erin Owner',
} as const;

/** Signed-in browser state written by the global setup and loaded by most tests. */
export const AUTH_FILE = path.join(repoRoot, 'tests/e2e/.auth/owner.json');

/** The directory a server on `port` keeps everything in; emptied when it starts and removed when it stops. */
export function runRoot(port: number): string {
  return path.join(os.tmpdir(), `agent-studio-e2e-${port}`);
}

/** The server's only workspace root: projects are folders in here. */
export const WORKSPACE = path.join(runRoot(PORT), 'workspace');
