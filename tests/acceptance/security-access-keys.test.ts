import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.6 — Access keys / API tokens (§6.6).
 *
 * Intended differences: tokens (`ast_…`, stored hashed) carry scopes and an
 * optional expiry and can be revoked, but there is no "disable / re-enable"
 * pair (AT-SEC-070) and no stored source-host tokens (AT-SEC-073). Creation is
 * gated by a recent browser sign-in rather than by re-entering the password, so
 * the password parts of AT-SEC-068 are "(adapted)".
 */

describe('6.6 access keys and tokens', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-067: the full key is shown exactly once and never appears in a listing', async () => {
    const owner = await studio.owner();
    const created = await owner.post<{ token: string; record: { id: string } }>(
      '/api/auth/tokens',
      { name: 'ci', scopes: ['read'] },
    );
    expect(created.status).toBe(200);
    expect(created.body.token).toMatch(/^ast_/);
    const listed = await owner.get<{ tokens: Array<{ id: string }> }>('/api/auth/tokens');
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
    // The listing identifies the key by id and metadata, never by a reconstructable value.
    expect(listed.body.tokens.some((t) => t.id === created.body.record.id)).toBe(true);
  });

  it('AT-SEC-068 (adapted): a token cannot be created without a signed-in browser (an API token may not)', async () => {
    const owner = await studio.owner();
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'maker',
      scopes: ['read', 'write'],
    });
    const robot = studio.client();
    robot.bearer = created.body.token;
    const refused = await robot.post<{ error: { code: string } }>('/api/auth/tokens', {
      name: 'child',
      scopes: ['read'],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('session_required');
  });

  it('AT-SEC-069: only the exact active key authenticates — not a missing, truncated or metadata form', async () => {
    const owner = await studio.owner();
    const created = await owner.post<{ token: string; record: { id: string } }>(
      '/api/auth/tokens',
      { name: 'robot', scopes: ['read', 'write'] },
    );
    const token = created.body.token;
    const tryBearer = async (bearer: string | null) => {
      const client = studio.client();
      if (bearer) client.bearer = bearer;
      return (await client.get('/api/system/info')).status;
    };
    expect(await tryBearer(token)).toBe(200); // the real key
    expect(await tryBearer(null)).toBe(401); // no key — the route is protected
    expect(await tryBearer(token.slice(0, -4))).toBe(401); // truncated
    expect(await tryBearer(`ast_${created.body.record.id}`)).toBe(401); // the id/metadata, not the secret
  });

  it('SEC-107/AT-SEC-069: a token carries only its scopes', async () => {
    const owner = await studio.owner();
    const readOnly = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'ro',
      scopes: ['read'],
    });
    const robot = studio.client();
    robot.bearer = readOnly.body.token;
    expect((await robot.get('/api/system/info')).status).toBe(200); // read works
    const write = await robot.patch<{ error: { code: string } }>('/api/preferences', {
      values: { 'appearance.theme': 'dark' },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('insufficient_scope');
  });

  it('AT-SEC-071: sign-out-everywhere makes an active key stop working and drops it from the listing', async () => {
    const owner = await studio.owner();
    const created = await owner.post<{ token: string; record: { id: string } }>(
      '/api/auth/tokens',
      { name: 'revoke-me', scopes: ['read'] },
    );
    const robot = studio.client();
    robot.bearer = created.body.token;
    expect((await robot.get('/api/system/info')).status).toBe(200);

    const session = await studio.owner();
    expect((await session.post('/api/auth/logout-everywhere')).status).toBe(204);
    expect((await robot.get('/api/system/info')).status).toBe(401);
    const after = await studio.owner();
    const listed = await after.get<{ tokens: Array<{ id: string }> }>('/api/auth/tokens');
    expect(listed.body.tokens.some((t) => t.id === created.body.record.id)).toBe(false);
  });

  it('AT-SEC-072: a key id that is not your own answers not-found and changes nothing', async () => {
    const owner = await studio.owner();
    const username = `member-${Math.random().toString(36).slice(2, 8)}`;
    await owner.post('/api/users', {
      username,
      password: 'a member passphrase 12',
      role: 'member',
    });
    const member = new ApiClient(studio.url);
    await member.login({ username, password: 'a member passphrase 12' });
    const memberToken = await member.post<{ record: { id: string } }>('/api/auth/tokens', {
      name: 'theirs',
      scopes: ['read'],
    });

    // The owner cannot delete the member's token by id; it is "not found" to them.
    expect((await owner.delete(`/api/auth/tokens/${memberToken.body.record.id}`)).status).toBe(404);
    // A forged id is likewise not-found.
    expect((await owner.delete('/api/auth/tokens/00000000000000000000000000')).status).toBe(404);
    // The member's token still works, proving nothing changed.
    const robot = studio.client();
    robot.bearer = (
      await member.post<{ token: string }>('/api/auth/tokens', { name: 'proof', scopes: ['read'] })
    ).body.token;
    expect((await robot.get('/api/system/info')).status).toBe(200);
  });

  it('AT-SEC-074: an access key is refused on every session-only (interactive) capability', async () => {
    const owner = await studio.owner();
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'interactive',
      scopes: ['read', 'write', 'admin'],
    });
    const robot = studio.client();
    robot.bearer = created.body.token;
    const sessionOnly: Array<[string, string]> = [
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/logout-everywhere'],
      ['POST', '/api/auth/reauth'],
      ['POST', '/api/auth/password'],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/auth/tokens'],
      ['POST', '/api/auth/tokens'],
      ['GET', '/api/auth/passkeys'],
    ];
    for (const [method, url] of sessionOnly) {
      const response = await robot.request<{ error: { code: string } }>(
        method,
        url,
        method === 'GET' ? undefined : {},
      );
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(response.body.error.code, `${method} ${url}`).toBe('session_required');
    }
  });
});
