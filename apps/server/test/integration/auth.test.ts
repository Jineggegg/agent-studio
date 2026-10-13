import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AuthState, CreatedApiToken, DeviceSession, User } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_PASSWORD, TEST_SETUP_TOKEN, TestClient, createTestStudio, type TestStudio } from '../../src/testing/harness.js';

let t: TestStudio;
beforeEach(async () => {
  t = await createTestStudio();
});
afterEach(async () => {
  await t.close();
});

describe('first run', () => {
  it('reports that setup is needed and reveals nothing else', async () => {
    const state = await t.anonymous().get<AuthState>('/api/auth/state');
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ needsSetup: true, authenticated: false, user: null, csrfToken: null });
  });

  it('keeps the setup token in an owner-only file until setup is done', async () => {
    const file = path.join(t.dataDir, 'setup-token');
    expect(readFileSync(file, 'utf8').trim()).toBe(TEST_SETUP_TOKEN);
    expect(statSync(file).mode & 0o077).toBe(0);
    await t.owner();
    expect(existsSync(file)).toBe(false);
  });

  it('refuses setup without the right token', async () => {
    const response = await t.anonymous().post('/api/auth/setup', {
      setupToken: 'wrong-token-wrong-token',
      username: 'mallory',
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'invalid_setup_token' } });
    expect((await t.anonymous().get<AuthState>('/api/auth/state')).body.needsSetup).toBe(true);
  });

  it('creates the owner, signs them in, and closes setup for good', async () => {
    const owner = await t.owner();
    const state = await owner.get<AuthState>('/api/auth/state');
    expect(state.body).toMatchObject({ needsSetup: false, authenticated: true, user: { username: 'owner', role: 'owner' } });

    const again = await t.anonymous().post('/api/auth/setup', {
      setupToken: TEST_SETUP_TOKEN,
      username: 'second',
      password: TEST_PASSWORD,
    });
    expect(again.status).toBe(409);
  });

  it.each([
    ['short', 'too short'],
    ['password123', 'a common password'],
    ['aaaaaaaaaaaa', 'one repeated character'],
  ])('rejects the password %j (%s)', async (password) => {
    const response = await t.anonymous().post('/api/auth/setup', { setupToken: TEST_SETUP_TOKEN, username: 'owner', password });
    expect(response.status).toBe(400);
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    await t.owner();
  });

  it('sets an HttpOnly, SameSite=Strict cookie and never returns the session secret in the body', async () => {
    const client = t.anonymous();
    const response = await client.post<AuthState>('/api/auth/login', { username: 'owner', password: TEST_PASSWORD });
    expect(response.status).toBe(200);
    const cookie = response.raw.cookies.find((entry) => entry.name === 'studio_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(JSON.stringify(response.body)).not.toContain(cookie.value);
    expect(JSON.stringify(response.body)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(response.body)).not.toMatch(/hash/i);
  });

  it('answers a wrong password, an unknown account and a disabled account identically', async () => {
    const owner = await t.signIn('owner');
    await owner.post('/api/users', { username: 'sleeper', password: TEST_PASSWORD });
    const sleeper = (await owner.get<{ users: User[] }>('/api/users')).body.users.find((user) => user.username === 'sleeper')!;
    await owner.patch(`/api/users/${sleeper.id}`, { disabled: true });

    const wrong = await t.anonymous().post('/api/auth/login', { username: 'owner', password: 'not the password' });
    const unknown = await t.anonymous().post('/api/auth/login', { username: 'nobody', password: TEST_PASSWORD });
    const disabled = await t.anonymous().post('/api/auth/login', { username: 'sleeper', password: TEST_PASSWORD });
    for (const response of [wrong, unknown, disabled]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(wrong.body);
    }
  });

  it('locks an account out after repeated failures, even for the right password', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await t.anonymous().post('/api/auth/login', { username: 'owner', password: 'wrong guess here' });
      expect(response.status).toBe(401);
    }
    const locked = await t.anonymous().post('/api/auth/login', { username: 'owner', password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('signs out on the server, so the old cookie stops working', async () => {
    const client = await t.signIn('owner');
    const stolenCookie = client.cookie;
    expect((await client.post('/api/auth/logout')).status).toBe(204);

    const replay = new TestClient(t.studio);
    replay.cookie = stolenCookie;
    expect((await replay.get<AuthState>('/api/auth/state')).body.authenticated).toBe(false);
    expect((await replay.get('/api/system/info')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const client = await t.signIn('owner');
    const idleMs = t.studio.context.config.sessionIdleDays * 24 * 60 * 60 * 1000;
    t.studio.context.db.run('UPDATE auth_sessions SET last_seen_at = ?', Date.now() - idleMs - 1000);
    expect((await client.get('/api/system/info')).status).toBe(401);
  });
});

describe('devices and passwords', () => {
  it('lists signed-in devices and lets the user sign one out', async () => {
    const laptop = await t.owner();
    const phone = await t.signIn('owner');
    const { sessions } = (await laptop.get<{ sessions: DeviceSession[] }>('/api/auth/sessions')).body;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);

    const other = sessions.find((session) => !session.current)!;
    expect((await laptop.delete(`/api/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await phone.get('/api/system/info')).status).toBe(401);
    expect((await laptop.get('/api/system/info')).status).toBe(200);
  });

  it("cannot sign out another user's device", async () => {
    const owner = await t.owner();
    const member = await t.member();
    const ownerSession = (await owner.get<{ sessions: DeviceSession[] }>('/api/auth/sessions')).body.sessions[0]!;
    expect((await member.delete(`/api/auth/sessions/${ownerSession.id}`)).status).toBe(404);
    expect((await owner.get('/api/system/info')).status).toBe(200);
  });

  it('changing the password signs out every other device and requires the current password', async () => {
    const laptop = await t.owner();
    const phone = await t.signIn('owner');
    const refused = await laptop.post('/api/auth/password', { currentPassword: 'not it at all', newPassword: 'a brand new passphrase' });
    expect(refused.status).toBe(401);

    const changed = await laptop.post('/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'a brand new passphrase' });
    expect(changed.status).toBe(204);
    expect((await phone.get('/api/system/info')).status).toBe(401);
    expect((await laptop.get('/api/system/info')).status).toBe(200);
    expect((await t.anonymous().post('/api/auth/login', { username: 'owner', password: TEST_PASSWORD })).status).toBe(401);
    await t.signIn('owner', 'a brand new passphrase');
  });
});

describe('API tokens', () => {
  it('shows the secret once, stores only a hash, and honours scopes', async () => {
    const owner = await t.owner();
    const created = await owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'ci', scopes: ['read'] });
    expect(created.status).toBe(200);
    const secret = created.body.token;
    expect(secret.startsWith('ast_')).toBe(true);

    const listed = await owner.get('/api/auth/tokens');
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    const stored = t.studio.context.db.all<Record<string, unknown>>('SELECT * FROM api_tokens');
    expect(JSON.stringify(stored)).not.toContain(secret);

    const robot = t.anonymous();
    robot.bearer = secret;
    expect((await robot.get('/api/system/info')).status).toBe(200);
    // read scope cannot write, and cannot reach owner-only routes
    expect((await robot.post('/api/auth/logout')).status).toBe(403);
    expect((await robot.get('/api/users')).status).toBe(403);
  });

  it('cannot be used to mint more tokens, change the password or manage people', async () => {
    const owner = await t.owner();
    const { token } = (await owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'all', scopes: ['read', 'write', 'admin'] })).body;
    const robot = t.anonymous();
    robot.bearer = token;
    expect((await robot.get('/api/users')).status).toBe(200);
    expect((await robot.post('/api/auth/tokens', { name: 'more', scopes: ['read'] })).body).toMatchObject({ error: { code: 'session_required' } });
    expect((await robot.post('/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'another passphrase 1' })).status).toBe(403);
    expect((await robot.post('/api/users', { username: 'backdoor', password: TEST_PASSWORD })).status).toBe(403);
  });

  it('stops working when revoked, expired, or when its owner is disabled', async () => {
    const owner = await t.owner();
    const first = (await owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'a', scopes: ['read'] })).body;
    const robot = t.anonymous();
    robot.bearer = first.token;
    expect((await owner.delete(`/api/auth/tokens/${first.record.id}`)).status).toBe(204);
    expect((await robot.get('/api/system/info')).status).toBe(401);

    const second = (await owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'b', scopes: ['read'], expiresInDays: 1 })).body;
    robot.bearer = second.token;
    expect((await robot.get('/api/system/info')).status).toBe(200);
    t.studio.context.db.run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', Date.now() - 1, second.record.id);
    expect((await robot.get('/api/system/info')).status).toBe(401);
  });

  it('rejects an unknown bearer token outright', async () => {
    const robot = t.anonymous();
    robot.bearer = 'ast_' + 'x'.repeat(43);
    const response = await robot.get('/api/auth/state');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: 'invalid_token' } });
  });

  it('lets a member grant only scopes a member has', async () => {
    const member = await t.member();
    expect((await member.post('/api/auth/tokens', { name: 'x', scopes: ['admin'] })).status).toBe(403);
    expect((await member.post('/api/auth/tokens', { name: 'x', scopes: ['read', 'write'] })).status).toBe(200);
  });
});

describe('people and roles', () => {
  it('lets only the owner manage accounts', async () => {
    const owner = await t.owner();
    const member = await t.member('alice');
    expect((await member.get('/api/users')).status).toBe(403);
    expect((await member.post('/api/users', { username: 'eve', password: TEST_PASSWORD })).status).toBe(403);
    const users = (await owner.get<{ users: User[] }>('/api/users')).body.users;
    expect(users.map((user) => user.username).sort()).toEqual(['alice', 'owner']);
    expect(JSON.stringify(users)).not.toMatch(/password|hash/i);
  });

  it('a member cannot promote themselves', async () => {
    await t.owner();
    const member = await t.member('alice');
    expect((await member.patch(`/api/users/${member.userId}`, { role: 'owner' })).status).toBe(403);
  });

  it('disabling an account ends its sessions immediately', async () => {
    const owner = await t.owner();
    const member = await t.member('alice');
    expect((await member.get('/api/system/info')).status).toBe(200);
    expect((await owner.patch(`/api/users/${member.userId}`, { disabled: true })).status).toBe(200);
    expect((await member.get('/api/system/info')).status).toBe(401);
  });

  it('always keeps one active owner', async () => {
    const owner = await t.owner();
    expect((await owner.patch(`/api/users/${owner.userId}`, { role: 'member' })).body).toMatchObject({ error: { code: 'last_owner' } });
    expect((await owner.delete(`/api/users/${owner.userId}`)).status).toBe(409);
  });

  it('refuses duplicate usernames regardless of case', async () => {
    const owner = await t.owner();
    expect((await owner.post('/api/users', { username: 'Alice', password: TEST_PASSWORD })).status).toBe(201);
    expect((await owner.post('/api/users', { username: 'alice', password: TEST_PASSWORD })).status).toBe(409);
  });

  it('asks for a fresh proof of identity before sensitive changes', async () => {
    const owner = await t.owner();
    t.studio.context.db.run('UPDATE auth_sessions SET authenticated_at = ?', Date.now() - 16 * 60 * 1000);
    const stale = await owner.post('/api/users', { username: 'bob', password: TEST_PASSWORD });
    expect(stale.body).toMatchObject({ error: { code: 'reauth_required' } });

    expect((await owner.post('/api/auth/reauth', { password: 'wrong password!' })).status).toBe(401);
    expect((await owner.post('/api/auth/reauth', { password: TEST_PASSWORD })).status).toBe(200);
    expect((await owner.post('/api/users', { username: 'bob', password: TEST_PASSWORD })).status).toBe(201);
  });
});
