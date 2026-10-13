import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { OWNER, SETUP_TOKEN, serverCommand, startStudio, type RunningStudio } from './support/studio.js';

/**
 * Acceptance tests for sign-in, sessions and the perimeter, traced to the
 * identifiers in docs/requirements/03-auth-security-remote-access.md.
 * Where this implementation deliberately differs from the predecessor the
 * test name says how (see docs/requirements/README.md).
 */

describe('first run and the unauthenticated surface', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startStudio();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-001: a fresh installation says setup is needed and nothing else', async () => {
    const { status, body } = await studio.client().get<Record<string, unknown>>('/api/auth/state');
    expect(status).toBe(200);
    expect(body).toMatchObject({ needsSetup: true, authenticated: false, user: null, csrfToken: null, session: null });
  });

  it('AT-SEC-003/004 (adapted): the first account needs proof of control of the host — a one-time setup token — from any address', async () => {
    const refused = await studio.client().setup(OWNER, 'not-the-setup-token-at-all');
    expect(refused.status).toBe(403);
    expect((await studio.client().get<{ needsSetup: boolean }>('/api/auth/state')).body.needsSetup).toBe(true);
    // The token is on the host, readable only by the service account.
    const tokenFile = path.join(studio.dataDir, 'setup-token');
    expect((await readFile(tokenFile, 'utf8')).trim()).toBe(SETUP_TOKEN);
    expect((await stat(tokenFile)).mode & 0o077).toBe(0);
    expect(studio.output()).toContain(SETUP_TOKEN);
  });

  it('AT-SEC-007: weak passwords are refused before any account exists', async () => {
    for (const password of ['short', 'elevenchars', 'aaaaaaaaaaaaaaaa', 'password1234']) {
      const response = await studio.client().setup({ username: 'owner', password });
      expect(response.status, password).toBe(400);
    }
    expect((await studio.client().get<{ needsSetup: boolean }>('/api/auth/state')).body.needsSetup).toBe(true);
  });

  it('AT-SEC-002: creating the account signs the creator in and closes setup', async () => {
    const owner = await studio.owner();
    const state = await owner.get<Record<string, unknown>>('/api/auth/state');
    expect(state.body).toMatchObject({ needsSetup: false, authenticated: true, user: { username: 'owner', role: 'owner' } });
  });

  it('AT-SEC-005/006: a second account can never be created through setup', async () => {
    const again = await studio.client().setup({ username: 'intruder', password: 'another long passphrase' });
    expect(again.status).toBe(409);
    await expect(stat(path.join(studio.dataDir, 'setup-token'))).rejects.toThrow();
  });

  it('AT-SEC-008: without a session, only health, state and sign-in answer', async () => {
    const anonymous = studio.client();
    expect((await anonymous.get('/api/health')).body).toEqual({ status: 'ok' });
    for (const url of ['/api/system/info', '/api/projects', '/api/users', '/api/preferences', '/api/audit', '/api/auth/sessions', '/api/auth/tokens']) {
      const response = await anonymous.get<{ error: { code: string } }>(url);
      expect(response.status, url).toBe(401);
      expect(response.body.error.code, url).toBe('unauthorized');
    }
  });

  it('AT-SEC-011: unknown API paths answer JSON "not found", with no stack trace', async () => {
    const response = await studio.client().get<{ error: { code: string } }>('/api/no/such/thing');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
    expect(JSON.stringify(response.body)).not.toMatch(/\bat\b.*\.(js|ts):\d+/);
  });
});

describe('password sign-in, throttling and sessions', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-012/013: the right password signs in; every failure gets the same answer', async () => {
    expect((await studio.client().login()).status).toBe(200);
    const wrong = await studio.client().login({ username: OWNER.username, password: 'not the right password' });
    const unknown = await studio.client().login({ username: 'who-is-this', password: OWNER.password });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('AT-SEC-014: the session lives in a cookie scripts cannot read and other sites cannot send', async () => {
    const response = await fetch(`${studio.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: JSON.stringify(OWNER),
    });
    const cookie = response.headers.getSetCookie().find((entry) => entry.includes('studio_session'))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toContain(cookie.split(';')[0]!.split('=')[1]!);
  });

  it('AT-SEC-020: sign-out ends the session on the server, not just in the browser', async () => {
    const browser = await studio.owner();
    const stolen = browser.cookie;
    expect((await browser.post('/api/auth/logout')).status).toBe(204);
    const thief = studio.client();
    thief.cookie = stolen;
    expect((await thief.get('/api/system/info')).status).toBe(401);
  });

  it('AT-SEC-021: "sign out everywhere" ends every session, token and live connection at once', async () => {
    const laptop = await studio.owner();
    const phone = await studio.owner();
    const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, { headers: { cookie: phone.cookie!, origin: studio.url } });
    await new Promise((resolve, reject) => (socket.once('open', resolve), socket.once('error', reject)));
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

    expect((await laptop.post('/api/auth/logout-everywhere')).status).toBe(204);
    expect(await closed).toBe(4401);
    expect((await phone.get('/api/system/info')).status).toBe(401);
    expect((await laptop.get('/api/system/info')).status).toBe(401);
  });

  it('AT-SEC-016/017: five wrong passwords lock the account, the lock survives a restart, and the operator can lift it', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await studio.client().login({ username: OWNER.username, password: `wrong guess number ${attempt}` })).status).toBe(401);
    }
    const locked = await studio.client().login();
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);

    await studio.restart();
    expect((await studio.client().login()).status).toBe(429);

    // An already signed-in session is not what the lock is about; the operator command is the recovery path.
    const { spawnSync } = await import('node:child_process');
    const command = serverCommand();
    const unlock = spawnSync(process.execPath, [...command.args, 'unlock'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_STUDIO_DATA_DIR: studio.dataDir, ...command.env },
      encoding: 'utf8',
    });
    expect(unlock.status).toBe(0);
    expect(unlock.stdout).toMatch(/Cleared \d+ lock/);
    expect((await studio.client().login()).status).toBe(200);
  });
});

describe('the perimeter', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-094: a write from another site is refused even with a valid session', async () => {
    const browser = await studio.owner();
    browser.origin = 'https://attacker.example';
    const forged = await browser.post<{ error: { code: string } }>('/api/auth/logout-everywhere');
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('origin_not_allowed');
    browser.origin = studio.url;
    expect((await browser.get('/api/system/info')).status).toBe(200);
  });

  it('AT-SEC-094b: a write without the anti-forgery token is refused', async () => {
    const browser = await studio.owner();
    browser.csrfToken = null;
    const response = await browser.post<{ error: { code: string } }>('/api/auth/logout-everywhere');
    expect(response.body.error.code).toBe('csrf_failed');
  });

  it('AT-SEC-090: no cross-origin reads of the API are enabled', async () => {
    const response = await fetch(`${studio.url}/api/auth/state`, { headers: { origin: 'https://attacker.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${studio.url}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('AT-SEC-091/096: responses forbid framing and carry a content security policy', async () => {
    const response = await fetch(`${studio.url}/api/health`);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('AT-SEC-089: a request addressed to a host name the server was not given is refused', async () => {
    // What a DNS-rebinding page would send: the attacker's name, resolving to this machine.
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: studio.port, path: '/api/health', headers: { host: 'rebind.attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it('AT-SEC-082: a real-time connection needs a session, and refuses another site\'s handshake', async () => {
    const attempt = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, { headers });
        socket.once('open', () => (socket.close(), resolve('open')));
        socket.once('unexpected-response', (_request, response) => resolve(`HTTP ${response.statusCode}`));
        socket.once('error', () => resolve('error'));
      });
    const browser = await studio.owner();
    expect(await attempt({ origin: studio.url })).toBe('HTTP 401');
    expect(await attempt({ origin: 'https://attacker.example', cookie: browser.cookie! })).toBe('HTTP 403');
    expect(await attempt({ origin: studio.url, cookie: browser.cookie! })).toBe('open');
  });

  it('AT-SEC-100: an access key is shown once, carries only its scopes, and cannot manage the account', async () => {
    const browser = await studio.owner();
    const created = await browser.post<{ token: string; record: { id: string } }>('/api/auth/tokens', { name: 'ci', scopes: ['read'] });
    expect(created.status).toBe(200);
    const listed = await browser.get('/api/auth/tokens');
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    const robot = studio.client();
    robot.bearer = created.body.token;
    expect((await robot.get('/api/system/info')).status).toBe(200);
    expect((await robot.post('/api/auth/tokens', { name: 'more', scopes: ['read'] })).status).toBe(403);
    expect((await robot.patch('/api/preferences', { values: { 'appearance.theme': 'dark' } })).status).toBe(403);

    expect((await browser.delete(`/api/auth/tokens/${created.body.record.id}`)).status).toBe(204);
    expect((await robot.get('/api/system/info')).status).toBe(401);
  });

  it('AT-SEC-120: nothing the server keeps on disk contains a usable password or session', async () => {
    const browser = await studio.owner();
    const sessionSecret = browser.cookie!.split('=')[1]!;
    await studio.stop();
    const database = await readFile(path.join(studio.dataDir, 'studio.db'));
    expect(database.includes(OWNER.password)).toBe(false);
    expect(database.includes(sessionSecret)).toBe(false);
    expect((await stat(studio.dataDir)).mode & 0o077).toBe(0);
    expect((await stat(path.join(studio.dataDir, 'master.key'))).mode & 0o077).toBe(0);
    await studio.restart();
  });

  it('AT-SEC-130: the server keeps its own settings out of what it logs', async () => {
    expect(studio.output()).not.toContain(OWNER.password);
    expect(studio.output()).not.toMatch(/studio_session=[\w-]{20,}/);
  });
});
