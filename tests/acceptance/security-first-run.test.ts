import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER, SETUP_TOKEN, startTestStudio, type RunningStudio } from './support/studio.js';
import { rawRequest } from './support/raw.js';

/**
 * 6.1 — First run and the unauthenticated surface, traced to the AT-SEC ids in
 * docs/requirements/03-auth-security-remote-access.md §6.1.
 *
 * Intended difference from the predecessor (ADR 0003): the first account is not
 * gated on a loopback peer but on a one-time setup token the server prints and
 * stores owner-only. Tests about locality become tests about that token
 * ("(adapted)").
 *
 * This describe shares one server and creates the owner part-way through, so the
 * tests run in the written order on purpose.
 */

const ANONYMOUS_OK = ['/api/health', '/api/auth/state'];
const PROTECTED = [
  '/api/system/info',
  '/api/users',
  '/api/projects',
  '/api/projects/browse',
  '/api/preferences',
  '/api/audit',
  '/api/auth/sessions',
  '/api/auth/tokens',
  '/api/auth/passkeys',
  '/api/auth/locks',
  '/api/memory/notes',
  '/api/plugins',
  '/api/remotes/hosts',
  '/api/terminal/sessions',
  '/api/agents',
];

describe('6.1 first run and the unauthenticated surface', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-001: setup status says setup is needed and discloses nothing else', async () => {
    const { status, body } = await studio.client().get<Record<string, unknown>>('/api/auth/state');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      needsSetup: true,
      authenticated: false,
      user: null,
      csrfToken: null,
      session: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
  });

  it('AT-SEC-003/004 (adapted): without the setup token the account cannot be created, from any address', async () => {
    const refused = await studio.client().setup(OWNER, 'not-the-right-setup-token');
    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe('invalid_setup_token');
    // A request presenting a foreign Host (what a remote caller sends) is turned away before the body is read.
    const remote = await rawRequest({
      port: studio.port,
      method: 'POST',
      path: '/api/auth/setup',
      host: 'studio.example.com',
      headers: { 'content-type': 'application/json', origin: 'https://studio.example.com' },
      body: JSON.stringify({ setupToken: SETUP_TOKEN, ...OWNER }),
    });
    expect(remote.status).toBe(403);
    expect(
      (await studio.client().get<{ needsSetup: boolean }>('/api/auth/state')).body.needsSetup,
    ).toBe(true);
  });

  it('AT-SEC-002 (adapted): the setup token lives in an owner-only file on the host and is printed once', async () => {
    const tokenFile = path.join(studio.dataDir, 'setup-token');
    expect((await readFile(tokenFile, 'utf8')).trim()).toBe(SETUP_TOKEN);
    expect((await stat(tokenFile)).mode & 0o077).toBe(0);
    expect(studio.output()).toContain(SETUP_TOKEN);
  });

  it('AT-SEC-007: malformed credentials are refused with a validation error and create no account', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['empty body', {}],
      ['empty fields', { setupToken: SETUP_TOKEN, username: '', password: '' }],
      ['short password', { setupToken: SETUP_TOKEN, username: 'owner', password: 'only-eleven' }],
      [
        '129-char username',
        { setupToken: SETUP_TOKEN, username: 'a'.repeat(129), password: OWNER.password },
      ],
      [
        '1025-char password',
        { setupToken: SETUP_TOKEN, username: 'owner', password: 'x'.repeat(1025) },
      ],
      ['non-string values', { setupToken: SETUP_TOKEN, username: 123, password: ['nope'] }],
    ];
    for (const [label, body] of cases) {
      const response = await studio
        .client()
        .post<{ error: { code: string } }>('/api/auth/setup', body);
      expect(response.status, label).toBe(400);
      expect(JSON.stringify(response.body), label).not.toMatch(/\.(ts|js):\d+/);
    }
    expect(
      (await studio.client().get<{ needsSetup: boolean }>('/api/auth/state')).body.needsSetup,
    ).toBe(true);
  });

  it('AT-SEC-002: creating the account with the token signs the creator in as owner and closes setup', async () => {
    const owner = await studio.owner();
    const state = await owner.get<{
      needsSetup: boolean;
      user: { username: string; role: string };
    }>('/api/auth/state');
    expect(state.body).toMatchObject({
      needsSetup: false,
      user: { username: OWNER.username, role: 'owner' },
    });
    // The consumed token file is gone.
    await expect(stat(path.join(studio.dataDir, 'setup-token'))).rejects.toThrow();
  });

  it('AT-SEC-005: once an account exists, any further creation is refused and reveals nothing', async () => {
    for (const body of [
      { setupToken: SETUP_TOKEN, username: 'intruder', password: OWNER.password },
      {},
      { setupToken: SETUP_TOKEN, username: 42, password: false },
    ]) {
      const again = await studio
        .client()
        .post<{ error: { code: string } }>('/api/auth/setup', body);
      expect([400, 403, 409]).toContain(again.status);
      expect(JSON.stringify(again.body)).not.toMatch(new RegExp(`${OWNER.username}|hash`));
    }
    expect((await studio.client().login()).status).toBe(200); // the real owner still signs in
  });

  it('AT-SEC-008: every protected capability refuses an anonymous caller with only an error envelope', async () => {
    const anonymous = studio.client();
    for (const url of ANONYMOUS_OK) expect((await anonymous.get(url)).status).toBe(200);
    for (const url of PROTECTED) {
      const response = await anonymous.get<{ error: { code: string } }>(url);
      expect(response.status, url).toBe(401);
      expect(response.body.error.code, url).toBe('unauthorized');
      expect(Object.keys(response.body), url).toEqual(['error']);
    }
  });

  it('AT-SEC-009: case and slash variants never return what the canonical form hides', async () => {
    // Upper-case or doubled slashes do not match an /api route, so they reach
    // the app shell, a 404, or an outright refusal — never account data.
    for (const variant of ['/API/users', '/api/users/', '/api//users', '//api/users']) {
      const response = await rawRequest({ port: studio.port, method: 'GET', path: variant });
      expect(response.body, variant).not.toMatch(/"role":"owner"/);
      if (response.status === 200) expect(response.body, variant).toContain('<!doctype html>');
      else expect([403, 404], variant).toContain(response.status);
    }
  });

  it('AT-SEC-010: attempts to escape the public file roots never return a file from outside the client', async () => {
    const escapes = [
      '/../package.json',
      '/%2e%2e/package.json',
      '/assets/../../package.json',
      '/../apps/server/src/main.ts',
      '/../../../../etc/hostname',
      '/.env',
      `/../${path.basename(studio.dataDir)}/setup-token`,
    ];
    for (const target of escapes) {
      const response = await rawRequest({ port: studio.port, method: 'GET', path: target });
      // Either the app shell (extensionless → HTML) or a 404; never source, config or the setup token.
      expect(response.body, target).not.toMatch(
        /"name":\s*"agent-studio"|AGENT_STUDIO_|acceptance-setup-token|import .* from/,
      );
      if (response.status === 200) expect(response.body, target).toContain('<!doctype html>');
    }
  });

  it('AT-SEC-011: an unknown API address answers JSON not-found, not the app shell', async () => {
    const response = await studio.client().get<{ error: { code: string } }>('/api/no/such/thing');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
    expect(JSON.stringify(response.body)).not.toContain('<!doctype html>');
  });

  // The router matches the percent-decoded path, so access control must follow the
  // route that was matched, not the spelling of the URL. (Found by this suite and fixed.)
  it('AT-SEC-009/008: however an /api target is spelled, the access check applies', async () => {
    await studio.owner();
    const spellings = ['/%61pi/users', '/a%70i/users', '/api/%75sers', '/api/users?x=1', '/%2561pi/users', '//api/users', '/api//users', '/API/users', '/api/users/'];
    for (const target of spellings) {
      const response = await rawRequest({ port: studio.port, method: 'GET', path: target });
      expect([400, 401, 403, 404], target).toContain(response.status);
      expect(response.body, target).not.toMatch(/"role":"owner"/);
      expect(response.body, target).not.toMatch(/"username"/);
    }
    // Absolute-form targets are for proxies and are refused outright.
    const absolute = await rawRequest({ port: studio.port, method: 'GET', path: `http://127.0.0.1:${studio.port}/api/users` });
    expect([400, 401]).toContain(absolute.status);
    expect(absolute.body).not.toMatch(/"role":"owner"/);
  });

  it('AT-SEC-007: a 2-character username is refused', async () => {
    const response = await startTestStudio().then(async (s) => {
      try {
        return await s.client().setup({ username: 'ab', password: OWNER.password });
      } finally {
        await s.destroy();
      }
    });
    expect(response.status).toBe(400);
  });
});

// Creating the first account and checking that none exists yet are one atomic step.
describe('6.1 AT-SEC-006: simultaneous account creation', () => {
  it('AT-SEC-006: simultaneous account creations yield exactly one account', async () => {
    const studio = await startTestStudio();
    try {
      const clients = [studio.client(), studio.client(), studio.client()];
      const attempts = await Promise.all([
        clients[0]!.setup({ username: 'ownerone', password: OWNER.password }),
        clients[1]!.setup({ username: 'ownertwo', password: OWNER.password }),
        clients[2]!.setup({ username: 'ownerthree', password: OWNER.password }),
      ]);
      expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
      expect(attempts.filter((r) => r.status === 409)).toHaveLength(2);
      const winner = clients[attempts.findIndex((r) => r.status === 200)]!;
      expect((await winner.get<{ users: unknown[] }>('/api/users')).body.users).toHaveLength(1);
    } finally {
      await studio.destroy();
    }
  });
});
