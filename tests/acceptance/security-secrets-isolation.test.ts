import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.9 — Secrets and isolation, limited to what is observable today (per the
 * brief): nothing under /api returns a stored secret; the data directory and
 * its key file are owner-only (and tightened if found too open); and the
 * server's own output carries no secret. Provider keys, channel credentials
 * and agent-process environment isolation (AT-SEC-102…108, 110…114) are other
 * modules' territory and are listed in the report.
 */

// Every GET route an owner can read right after setup, for the secret sweep.
const OWNER_GET_ROUTES = [
  '/api/health',
  '/api/auth/state',
  '/api/auth/locks',
  '/api/auth/sessions',
  '/api/auth/tokens',
  '/api/auth/passkeys',
  '/api/system/info',
  '/api/preferences',
  '/api/audit?limit=100',
  '/api/projects',
  '/api/projects/pins',
  '/api/users',
  '/api/memory/status',
  '/api/memory/notes',
  '/api/memory/tags',
  '/api/agents',
  '/api/files/limits',
  '/api/terminal/capability',
  '/api/plugins',
  '/api/plugins/sources',
  '/api/remotes/hosts',
];

describe('6.9 secrets are never returned by the API', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-102 (adapted): no GET answer contains the password, the session token, a token secret or a hash', async () => {
    const owner = await studio.owner();
    const sessionToken = owner.cookie!.split('=')[1]!;
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'sweep',
      scopes: ['read', 'write'],
    });
    const tokenSecret = created.body.token;

    for (const url of OWNER_GET_ROUTES) {
      const response = await owner.get(url);
      expect([200, 404], url).toContain(response.status);
      const body = JSON.stringify(response.body);
      expect(body, url).not.toContain(OWNER.password);
      expect(body, url).not.toContain(sessionToken);
      expect(body, url).not.toContain(tokenSecret); // the created access key is never echoed back
      expect(body, url).not.toMatch(/password_hash|"\$?scrypt|\$argon2|-----BEGIN/i);
    }
  });

  it('AT-SEC-037/120: the auth state exposes the anti-forgery token but never the raw session secret', async () => {
    const owner = await studio.owner();
    const sessionToken = owner.cookie!.split('=')[1]!;
    const state = await owner.get<{ csrfToken: string }>('/api/auth/state');
    expect(state.body.csrfToken).toBeTruthy();
    expect(state.body.csrfToken).not.toBe(sessionToken); // the CSRF token is derived, not the session itself
    expect(JSON.stringify(state.body)).not.toContain(sessionToken);
  });

  it('AT-SEC-130: the server output carries no password or session secret', async () => {
    const owner = await studio.owner();
    expect(studio.output()).not.toContain(OWNER.password);
    expect(studio.output()).not.toContain(owner.cookie!.split('=')[1]!);
    expect(studio.output()).not.toMatch(/studio_session=[\w-]{20,}/);
  });
});

describe('6.9 data-directory permissions', () => {
  it('AT-SEC-109: the data directory and its key file are owner-only, and a loosened directory is tightened on start', async () => {
    const studio = await startTestStudio();
    try {
      await studio.owner();
      await studio.stop();
      expect((await stat(studio.dataDir)).mode & 0o077).toBe(0);
      expect((await stat(path.join(studio.dataDir, 'master.key'))).mode & 0o077).toBe(0);

      // Loosen the directory as a careless backup/restore might, then restart.
      await chmod(studio.dataDir, 0o755);
      await studio.restart();
      expect(
        (await stat(studio.dataDir)).mode & 0o077,
        'the data directory should be tightened on start',
      ).toBe(0);
    } finally {
      await studio.destroy();
    }
  });
});
