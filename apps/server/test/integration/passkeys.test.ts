import type { AuthState, Passkey } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ORIGIN, TEST_PASSWORD, createTestStudio, type TestClient, type TestStudio } from '../../src/testing/harness.js';
import { SoftAuthenticator } from '../../src/testing/soft-authenticator.js';

let t: TestStudio;
beforeEach(async () => {
  t = await createTestStudio();
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

type CreationOptions = { challenge: string; rp: { id: string }; user: { id: string }; authenticatorSelection: Record<string, string> };
type RequestOptions = { challenge: string; rpId: string; userVerification: string };

async function register(client: TestClient, device: SoftAuthenticator): Promise<Passkey> {
  const options = await client.post<CreationOptions>('/api/auth/passkeys/registration-options');
  expect(options.status).toBe(200);
  const created = await client.post<Passkey>('/api/auth/passkeys/registration', { response: device.create(options.body, TEST_ORIGIN) });
  expect(created.status).toBe(201);
  return created.body;
}

async function loginOptions(): Promise<RequestOptions> {
  const response = await t.anonymous().post<RequestOptions>('/api/auth/passkeys/login-options');
  expect(response.status).toBe(200);
  return response.body;
}

describe('registering a passkey', () => {
  it('requires user verification and a discoverable credential, and stores no private material', async () => {
    const owner = await t.owner();
    const device = new SoftAuthenticator();
    const options = (await owner.post<CreationOptions>('/api/auth/passkeys/registration-options')).body;
    expect(options.rp.id).toBe('localhost');
    expect(options.authenticatorSelection).toMatchObject({ userVerification: 'required', residentKey: 'required' });

    const passkey = (await owner.post<Passkey>('/api/auth/passkeys/registration', { response: device.create(options, TEST_ORIGIN), name: 'Test phone' })).body;
    expect(passkey).toMatchObject({ name: 'Test phone', hostname: 'localhost', usableHere: true, lastUsedAt: null });

    const listed = await owner.get<{ available: boolean; passkeys: Passkey[] }>('/api/auth/passkeys');
    expect(listed.body.available).toBe(true);
    expect(listed.body.passkeys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toMatch(/public_?key|credential_?id/i);
  });

  it('needs a signed-in browser that confirmed its identity recently', async () => {
    const owner = await t.owner();
    expect((await t.anonymous().post('/api/auth/passkeys/registration-options')).status).toBe(401);
    t.studio.context.db.run('UPDATE auth_sessions SET authenticated_at = ?', Date.now() - 16 * 60_000);
    expect((await owner.post('/api/auth/passkeys/registration-options')).body).toMatchObject({ error: { code: 'reauth_required' } });
  });

  it('refuses a response for another origin, without user verification, or to a replayed challenge', async () => {
    const owner = await t.owner();
    const device = new SoftAuthenticator();
    const fresh = async () => (await owner.post<CreationOptions>('/api/auth/passkeys/registration-options')).body;

    const wrongOrigin = await owner.post('/api/auth/passkeys/registration', { response: device.create(await fresh(), TEST_ORIGIN, { origin: 'https://evil.example' }) });
    expect(wrongOrigin.body).toMatchObject({ error: { code: 'passkey_rejected' } });
    const unverified = await owner.post('/api/auth/passkeys/registration', { response: device.create(await fresh(), TEST_ORIGIN, { userVerified: false }) });
    expect(unverified.body).toMatchObject({ error: { code: 'passkey_rejected' } });

    const options = await fresh();
    expect((await owner.post('/api/auth/passkeys/registration', { response: device.create(options, TEST_ORIGIN) })).status).toBe(201);
    const replay = await owner.post('/api/auth/passkeys/registration', { response: new SoftAuthenticator().create(options, TEST_ORIGIN) });
    expect(replay.body).toMatchObject({ error: { code: 'passkey_rejected' } });
  });

  it('does not accept a challenge issued to another session or for another purpose', async () => {
    const laptop = await t.owner();
    const phone = await t.signIn('owner');
    const forLaptop = (await laptop.post<CreationOptions>('/api/auth/passkeys/registration-options')).body;
    const crossSession = await phone.post('/api/auth/passkeys/registration', { response: new SoftAuthenticator().create(forLaptop, TEST_ORIGIN) });
    expect(crossSession.body).toMatchObject({ error: { code: 'passkey_rejected' } });

    const login = await loginOptions();
    const crossPurpose = await laptop.post('/api/auth/passkeys/registration', {
      response: new SoftAuthenticator().create({ ...forLaptop, challenge: login.challenge }, TEST_ORIGIN),
    });
    expect(crossPurpose.body).toMatchObject({ error: { code: 'passkey_rejected' } });
  });

  it('is unavailable on a bare IP address', async () => {
    const owner = await t.owner();
    const headers = { host: '127.0.0.1:7420', origin: 'http://127.0.0.1:7420' };
    const response = await owner.request('POST', '/api/auth/passkeys/registration-options', {}, headers);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: 'passkeys_unavailable' } });
    expect((await owner.request<AuthState>('GET', '/api/auth/state', undefined, headers)).body.passkeysAvailable).toBe(false);
    expect((await owner.get<AuthState>('/api/auth/state')).body.passkeysAvailable).toBe(true);
  });
});

describe('signing in with a passkey', () => {
  it('signs the owner in without a username or password', async () => {
    const owner = await t.owner();
    const device = new SoftAuthenticator();
    await register(owner, device);

    const options = await loginOptions();
    expect(options.userVerification).toBe('required');
    const client = t.anonymous();
    const response = await client.post<AuthState>('/api/auth/passkeys/login', { response: device.get(options, TEST_ORIGIN) });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authenticated: true, user: { username: 'owner' }, session: { method: 'passkey' } });
    client.adopt(response.body);
    expect((await client.get('/api/system/info')).status).toBe(200);
    expect((await client.get<{ passkeys: Passkey[] }>('/api/auth/passkeys')).body.passkeys[0]!.lastUsedAt).not.toBeNull();
  });

  it('refuses a replayed assertion, a tampered signature, a foreign origin and a missing verification', async () => {
    const device = new SoftAuthenticator();
    await register(await t.owner(), device);
    const attempt = (response: Record<string, unknown>) => t.anonymous().post('/api/auth/passkeys/login', { response });

    const options = await loginOptions();
    const assertion = device.get(options, TEST_ORIGIN);
    expect((await attempt(assertion)).status).toBe(200);
    expect((await attempt(assertion)).status).toBe(401);

    expect((await attempt(device.get(await loginOptions(), TEST_ORIGIN, { tamper: true }))).status).toBe(401);
    expect((await attempt(device.get(await loginOptions(), TEST_ORIGIN, { origin: 'https://evil.example' }))).status).toBe(401);
    expect((await attempt(device.get(await loginOptions(), TEST_ORIGIN, { userVerified: false }))).status).toBe(401);
    expect((await attempt(device.get({ ...(await loginOptions()), challenge: 'bm90LWEtcmVhbC1jaGFsbGVuZ2U' }, TEST_ORIGIN))).status).toBe(401);
  });

  it('refuses a challenge older than a minute', async () => {
    const device = new SoftAuthenticator();
    await register(await t.owner(), device);
    const options = await loginOptions();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect((await t.anonymous().post('/api/auth/passkeys/login', { response: device.get(options, TEST_ORIGIN) })).status).toBe(401);
  });

  it('refuses a signature counter that goes backwards (a cloned authenticator)', async () => {
    const device = new SoftAuthenticator();
    await register(await t.owner(), device);
    const attempt = async (counter: number) =>
      (await t.anonymous().post('/api/auth/passkeys/login', { response: device.get(await loginOptions(), TEST_ORIGIN, { counter }) })).status;
    expect(await attempt(10)).toBe(200);
    expect(await attempt(5)).toBe(401);
    expect(await attempt(11)).toBe(200);
  });

  it('works while password sign-in is locked, and lifts the lock', async () => {
    const device = new SoftAuthenticator();
    await register(await t.owner(), device);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await t.anonymous().post('/api/auth/login', { username: 'owner', password: 'wrong guess here' });
    }
    expect((await t.anonymous().post('/api/auth/login', { username: 'owner', password: TEST_PASSWORD })).status).toBe(429);
    expect((await t.anonymous().post('/api/auth/passkeys/login', { response: device.get(await loginOptions(), TEST_ORIGIN) })).status).toBe(200);
    expect((await t.anonymous().post('/api/auth/login', { username: 'owner', password: TEST_PASSWORD })).status).toBe(200);
  });

  it('stops working when the account is disabled or the passkey is removed', async () => {
    const owner = await t.owner();
    const member = await t.member('alice');
    const device = new SoftAuthenticator();
    const passkey = await register(member, device);
    const attempt = async () => (await t.anonymous().post('/api/auth/passkeys/login', { response: device.get(await loginOptions(), TEST_ORIGIN) })).status;
    expect(await attempt()).toBe(200);

    // Another account cannot remove it; its holder can.
    expect((await owner.delete(`/api/auth/passkeys/${passkey.id}`)).status).toBe(404);
    await owner.patch(`/api/users/${member.userId}`, { disabled: true });
    expect(await attempt()).toBe(401);
    await owner.patch(`/api/users/${member.userId}`, { disabled: false });
    expect(await attempt()).toBe(200);

    const again = await t.signIn('alice');
    expect((await again.delete(`/api/auth/passkeys/${passkey.id}`)).status).toBe(204);
    expect(await attempt()).toBe(401);
  });

  it('answers every refusal identically and logs it without detail', async () => {
    const device = new SoftAuthenticator();
    await register(await t.owner(), device);
    const unknownDevice = new SoftAuthenticator();
    unknownDevice.create({ challenge: 'x', rp: { id: 'localhost' }, user: { id: 'x' } }, TEST_ORIGIN);
    const unknown = await t.anonymous().post('/api/auth/passkeys/login', { response: unknownDevice.get(await loginOptions(), TEST_ORIGIN) });
    const tampered = await t.anonymous().post('/api/auth/passkeys/login', { response: device.get(await loginOptions(), TEST_ORIGIN, { tamper: true }) });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(tampered.body);
  });
});
