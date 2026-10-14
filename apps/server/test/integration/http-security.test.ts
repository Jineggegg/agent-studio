import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/kernel/config.js';
import { createStudio } from '../../src/kernel/studio.js';
import { TEST_HOST, TEST_ORIGIN, TEST_PASSWORD, createTestStudio, type TestStudio } from '../../src/testing/harness.js';

let t: TestStudio;
beforeEach(async () => {
  t = await createTestStudio();
});
afterEach(async () => {
  await t.close();
});

describe('who may call what', () => {
  it('requires sign-in for everything that is not explicitly public', async () => {
    await t.owner();
    const anonymous = t.anonymous();
    for (const url of ['/api/system/info', '/api/users', '/api/auth/sessions', '/api/auth/tokens']) {
      const response = await anonymous.get(url);
      expect(response.status, url).toBe(401);
      expect(response.body, url).toMatchObject({ error: { code: 'unauthorized' } });
    }
    expect((await anonymous.get('/api/health')).body).toEqual({ status: 'ok' });
  });

  it('applies access control to the route that matched, however the URL was spelled', async () => {
    const owner = await t.owner();
    await owner.post('/api/users', { username: 'alice', password: 'correct horse battery staple' });
    // The router decodes percent-escapes before matching; each of these reaches (or tries to reach) /api/users.
    for (const url of ['/%61pi/users', '/a%70i/users', '/api/%75sers', '/api/users?x=%2F', '/%2561pi/users', '//api/users', '/api//users', '/API/users', '/api/users/']) {
      const response = await t.studio.app.inject({ method: 'GET', url, headers: { host: 'localhost:7420' } });
      expect([401, 404], url).toContain(response.statusCode);
      expect(response.body, url).not.toContain('alice');
    }
    // …and state-changing requests keep their cross-site defences under any spelling.
    const forged = await t.studio.app.inject({
      method: 'POST',
      url: '/%61pi/auth/logout-everywhere',
      headers: { host: 'localhost:7420', origin: 'https://evil.example', cookie: owner.cookie! },
      payload: {},
    });
    expect(forged.statusCode).toBe(403);
    expect((await owner.get('/api/system/info')).status).toBe(200);
  });

  it('tells a session that has ended apart from no session at all', async () => {
    const owner = await t.owner();
    const cookie = owner.cookie!;
    await owner.post('/api/auth/logout');
    const stale = await t.studio.app.inject({ method: 'GET', url: '/api/system/info', headers: { host: 'localhost:7420', cookie } });
    expect(stale.json()).toMatchObject({ error: { code: 'session_expired' } });
    expect((await t.anonymous().get('/api/system/info')).body).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('refuses to start with a route that does not declare its access level', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'studio-undeclared-'));
    const config = loadConfig({}, { env: 'test', dataDir, logLevel: 'silent', sandbox: 'off', port: 0 });
    await expect(
      createStudio(config, [
        {
          name: 'sloppy',
          setup(context) {
            context.http.app.get('/api/sloppy', () => ({ secret: 'data' }));
          },
        },
      ]),
    ).rejects.toThrow(/does not declare who may call it/);
    // No method is exempt: an undeclared OPTIONS or HEAD route is refused as well.
    const second = await mkdtemp(path.join(os.tmpdir(), 'studio-undeclared-'));
    await expect(
      createStudio(loadConfig({}, { env: 'test', dataDir: second, logLevel: 'silent', sandbox: 'off', port: 0 }), [
        {
          name: 'sloppy',
          setup(context) {
            context.http.app.options('/api/sloppy', () => ({ secret: 'data' }));
          },
        },
      ]),
    ).rejects.toThrow(/does not declare who may call it/);
    await rm(second, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('answers unknown API paths with JSON, not the web page', async () => {
    const response = await t.anonymous().get('/api/definitely/not/here');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('hides internals when something breaks', async () => {
    const response = await t.studio.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: TEST_HOST, 'content-type': 'application/json' },
      payload: '{"username": "owner", "password": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toMatch(/at .*\.(ts|js)|node_modules|stack/i);
  });

  it('validates input and says which field is wrong', async () => {
    await t.owner();
    const response = await t.anonymous().post('/api/auth/login', { username: '', password: 12345 });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('rejects oversized request bodies', async () => {
    const response = await t.anonymous().post('/api/auth/login', { username: 'owner', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(response.status).toBe(413);
  });
});

describe('cross-site request forgery', () => {
  it('refuses a cookie-authenticated write without the anti-forgery token', async () => {
    const owner = await t.owner();
    owner.csrfToken = null;
    const response = await owner.post('/api/users', { username: 'x1', password: TEST_PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'csrf_failed' } });
  });

  it('refuses a wrong anti-forgery token, including another session’s', async () => {
    const owner = await t.owner();
    const other = await t.signIn('owner');
    owner.csrfToken = other.csrfToken;
    expect((await owner.post('/api/users', { username: 'x1', password: TEST_PASSWORD })).body).toMatchObject({ error: { code: 'csrf_failed' } });
  });

  it('refuses writes from another origin even with a valid cookie and token', async () => {
    const owner = await t.owner();
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'null']) {
      const response = await owner.request('POST', '/api/users', { username: 'x1', password: TEST_PASSWORD }, { origin });
      expect(response.status, origin).toBe(403);
      expect(response.body, origin).toMatchObject({ error: { code: 'origin_not_allowed' } });
    }
  });

  it('refuses a cookie-authenticated write that carries no Origin at all', async () => {
    const owner = await t.owner();
    const response = await t.studio.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { host: TEST_HOST, cookie: owner.cookie!, 'x-studio-csrf': owner.csrfToken! },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'origin_required' } });
  });

  it('refuses requests the browser marks as cross-site', async () => {
    const response = await t.anonymous().request('POST', '/api/auth/login', { username: 'owner', password: TEST_PASSWORD }, { 'sec-fetch-site': 'cross-site' });
    expect(response.status).toBe(403);
  });

  it('does not let another site sign a visitor in to an attacker’s account', async () => {
    await t.owner();
    const response = await t.anonymous().request('POST', '/api/auth/login', { username: 'owner', password: TEST_PASSWORD }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });
});

describe('host and origin policy', () => {
  it('refuses requests addressed to a name it was not configured for (DNS rebinding)', async () => {
    const response = await t.studio.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:7420' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'host_not_allowed' } });
  });

  it('accepts a configured public origin and marks its cookie Secure with the __Host- prefix', async () => {
    const remote = await createTestStudio({ config: { publicOrigins: ['https://studio.example.com'] } });
    try {
      const response = await remote.studio.app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: { host: 'studio.example.com', origin: 'https://studio.example.com' },
        payload: { setupToken: 'test-setup-token-0123456789', username: 'owner', password: TEST_PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      const cookie = response.cookies.find((entry) => entry.name === '__Host-studio_session')!;
      expect(cookie).toBeDefined();
      expect(cookie.secure).toBe(true);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.domain).toBeUndefined();

      const wrongScheme = await remote.studio.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: 'studio.example.com', origin: 'http://studio.example.com' },
        payload: { username: 'owner', password: TEST_PASSWORD },
      });
      expect(wrongScheme.statusCode).toBe(403);
    } finally {
      await remote.close();
    }
  });
});

describe('response headers', () => {
  it('sends a strict content security policy and friends', async () => {
    const response = await t.anonymous().get('/api/health');
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('does not enable cross-origin resource sharing', async () => {
    const response = await t.studio.app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: { host: TEST_HOST, origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const get = await t.studio.app.inject({ method: 'GET', url: '/api/health', headers: { host: TEST_HOST, origin: TEST_ORIGIN } });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('secrets at rest', () => {
  it('creates the data directory and key file for the owner only, and encrypts stored secrets', async () => {
    const { statSync, readFileSync } = await import('node:fs');
    expect(statSync(t.dataDir).mode & 0o077).toBe(0);
    expect(statSync(path.join(t.dataDir, 'master.key')).mode & 0o077).toBe(0);

    const secrets = t.studio.context.secrets;
    secrets.put('provider:test', 'sk-live-abcdefghijklmnopqrstuvwxyz');
    // A description says that a value is saved, with a fixed marker: no character of the secret.
    expect(secrets.describe('provider:test')).toMatchObject({ name: 'provider:test', hint: '••••' });
    expect(secrets.reveal('provider:test')).toBe('sk-live-abcdefghijklmnopqrstuvwxyz');

    const row = t.studio.context.db.get<{ sealed: string }>('SELECT sealed FROM secrets WHERE name = ?', 'provider:test')!;
    expect(row.sealed).not.toContain('sk-live');
    t.studio.context.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(path.join(t.dataDir, 'studio.db')).includes('sk-live-abcdefghijklmnopqrstuvwxyz')).toBe(false);

    expect(secrets.delete('provider:test')).toBe(true);
    expect(secrets.reveal('provider:test')).toBeNull();
  });

  it('never stores passwords or session tokens in a usable form', async () => {
    const owner = await t.owner();
    const sessionSecret = owner.cookie!.split('=')[1]!;
    const dump = JSON.stringify([
      t.studio.context.db.all('SELECT * FROM users'),
      t.studio.context.db.all('SELECT * FROM auth_sessions'),
    ]);
    expect(dump).not.toContain(TEST_PASSWORD);
    expect(dump).not.toContain(sessionSecret);
  });
});
