#!/usr/bin/env node
// Starts the *built* server the way an operator would, on a free port with a
// throw-away data directory, and checks that it serves the API and the web
// client. Used by CI and by the installation check in the docs.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-studio-smoke-'));

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const server = spawn(process.execPath, [path.join(root, 'apps/server/dist/main.js')], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENT_STUDIO_PORT: String(port),
    AGENT_STUDIO_DATA_DIR: dataDir,
    AGENT_STUDIO_SETUP_TOKEN: 'smoke-test-setup-token-000',
    AGENT_STUDIO_LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));

const base = `http://127.0.0.1:${port}`;
const fail = (message) => {
  console.error(`SMOKE TEST FAILED: ${message}\n--- server output ---\n${output}`);
  server.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
};

try {
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    up = await fetch(`${base}/api/health`).then((response) => response.ok, () => false);
  }
  if (!up) fail('the server did not answer /api/health within 10 seconds');

  const state = await (await fetch(`${base}/api/auth/state`)).json();
  if (state.needsSetup !== true) fail('a fresh instance should need setup');

  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (!page.ok || !html.includes('<div id="root"')) fail('the web client was not served at /');
  if (!page.headers.get('content-security-policy')?.includes("script-src 'self'")) fail('the content security policy is missing');

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: 'smoke-test-setup-token-000', username: 'owner', password: 'smoke test passphrase 1' }),
  });
  if (!setup.ok) fail(`first-run setup failed with HTTP ${setup.status}`);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  const info = await fetch(`${base}/api/system/info`, { headers: { cookie } });
  if (!info.ok) fail('the new owner could not read system info');
  const { version, sandbox } = await info.json();

  const anonymous = await fetch(`${base}/api/system/info`);
  if (anonymous.status !== 401) fail('an anonymous caller was not refused');

  console.log(`Smoke test passed: version ${version}, sandbox ${sandbox.mode}, port ${port}.`);
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('close', resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
