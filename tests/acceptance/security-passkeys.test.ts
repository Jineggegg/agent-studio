import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, OWNER, startTestStudio, type RunningStudio } from './support/studio.js';
import { SoftwareAuthenticator } from './support/webauthn.js';

/**
 * 6.4 — Passkeys / WebAuthn (§6.4).
 *
 * Passkeys are offered only on localhost or a named https origin; the harness's
 * base URL is 127.0.0.1, where they are unavailable by design. The positive
 * tests therefore drive the SAME server through http://localhost:<port> with a
 * matching Origin, using the software authenticator in support/webauthn.ts.
 *
 * Registration and removal are gated by a recent sign-in (ADR 0003 step-up),
 * not by re-entering the password, so the password-attempt parts of the
 * predecessor's AT-SEC items are marked "(adapted)".
 */

describe('6.4 passkeys', () => {
  let studio: RunningStudio;
  let base: string;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
    base = `http://localhost:${studio.port}`;
  });
  afterAll(() => studio?.destroy());

  /** A browser bound to the localhost origin, signed in as the owner. */
  async function ownerOnLocalhost(): Promise<ApiClient> {
    const onLoopback = await studio.owner();
    const client = new ApiClient(base);
    client.cookie = onLoopback.cookie;
    client.csrfToken = onLoopback.csrfToken;
    client.userId = onLoopback.userId;
    return client;
  }

  async function registerPasskey(client: ApiClient): Promise<SoftwareAuthenticator> {
    const options = await client.post<Record<string, unknown>>(
      '/api/auth/passkeys/registration-options',
      {},
    );
    expect(options.status).toBe(200);
    const { credential, authenticator } = SoftwareAuthenticator.register(
      options.body as never,
      base,
    );
    const registered = await client.post('/api/auth/passkeys/registration', {
      response: credential,
    });
    expect(registered.status).toBe(201);
    return authenticator;
  }

  it('AT-SEC-047: passkeys are unavailable on the 127.0.0.1 address, with guidance', async () => {
    const loopback = await studio
      .client()
      .post<{ error: { code: string; message: string } }>('/api/auth/passkeys/login-options', {});
    expect(loopback.status).toBe(503);
    expect(loopback.body.error.code).toBe('passkeys_unavailable');
    expect(loopback.body.error.message).toMatch(/https|localhost/);
    // The same request on localhost is served.
    expect((await new ApiClient(base).post('/api/auth/passkeys/login-options', {})).status).toBe(
      200,
    );
  });

  it('AT-SEC-038: the sign-in challenge requires user verification, lists no credentials, and has a fixed shape', async () => {
    const before = await new ApiClient(base).post<Record<string, unknown>>(
      '/api/auth/passkeys/login-options',
      {},
    );
    const owner = await ownerOnLocalhost();
    await registerPasskey(owner);
    const after = await new ApiClient(base).post<Record<string, unknown>>(
      '/api/auth/passkeys/login-options',
      {},
    );
    for (const body of [before.body, after.body]) {
      expect(body.userVerification).toBe('required');
      // No list of credentials is offered, so the challenge reveals nothing about which accounts have passkeys.
      expect((body.allowCredentials as unknown[] | undefined) ?? []).toHaveLength(0);
    }
    expect(Object.keys(before.body).sort()).toEqual(Object.keys(after.body).sort());
  });

  it('AT-SEC-039: a valid assertion with user verification signs in and updates "last used"', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);
    expect(
      (await owner.get<{ passkeys: Array<{ lastUsedAt: number | null }> }>('/api/auth/passkeys'))
        .body.passkeys[0]!.lastUsedAt,
    ).toBeNull();

    const signer = new ApiClient(base);
    const options = await signer.post<Record<string, unknown>>(
      '/api/auth/passkeys/login-options',
      {},
    );
    const login = await signer.post<{ authenticated: boolean }>('/api/auth/passkeys/login', {
      response: authenticator.assert(options.body as never, base),
    });
    expect(login.status).toBe(200);
    expect(login.body.authenticated).toBe(true);
    expect(signer.cookie).toBeTruthy();

    const after = await owner.get<{ passkeys: Array<{ lastUsedAt: number | null }> }>(
      '/api/auth/passkeys',
    );
    expect(after.body.passkeys[0]!.lastUsedAt).toBeGreaterThan(0);
  });

  it('AT-SEC-040: a completed assertion cannot be replayed', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);
    const options = await new ApiClient(base).post<Record<string, unknown>>(
      '/api/auth/passkeys/login-options',
      {},
    );
    const assertion = authenticator.assert(options.body as never, base);
    expect(
      (await new ApiClient(base).post('/api/auth/passkeys/login', { response: assertion })).status,
    ).toBe(200);
    const replay = await new ApiClient(base).post<{ error: { code: string } }>(
      '/api/auth/passkeys/login',
      { response: assertion },
    );
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('invalid_credentials');
  });

  it('AT-SEC-042: a challenge with a byte altered, or one minted by another instance, is refused the same way', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);

    const options = await new ApiClient(base).post<{ challenge: string }>(
      '/api/auth/passkeys/login-options',
      {},
    );
    const originalBytes = Buffer.from(options.body.challenge, 'base64url');
    const alteredBytes = Buffer.from(originalBytes);
    // Flip an actual MAC byte. Changing the last base64url character may change
    // only ignored padding bits, leaving the signed challenge bytes untouched.
    expect(alteredBytes.length).toBeGreaterThan(0);
    alteredBytes[alteredBytes.length - 1] = alteredBytes[alteredBytes.length - 1]! ^ 1;
    const tampered = { ...options.body, challenge: alteredBytes.toString('base64url') };
    expect(Buffer.from(tampered.challenge, 'base64url')).not.toEqual(originalBytes);
    expect(
      (
        await new ApiClient(base).post('/api/auth/passkeys/login', {
          response: authenticator.assert(tampered, base),
        })
      ).status,
    ).toBe(401);

    // A challenge issued by a different Studio (different signing key) is not accepted here.
    const other = await startTestStudio();
    try {
      const foreign = await new ApiClient(`http://localhost:${other.port}`).post<{
        challenge: string;
      }>('/api/auth/passkeys/login-options', {});
      const response = authenticator.assert({ challenge: foreign.body.challenge }, base);
      expect(
        (await new ApiClient(base).post('/api/auth/passkeys/login', { response })).status,
      ).toBe(401);
    } finally {
      await other.destroy();
    }
  });

  it('AT-SEC-043/044 (adapted): an assertion bound to one origin/host is refused at another', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);
    const options = await new ApiClient(base).post<Record<string, unknown>>(
      '/api/auth/passkeys/login-options',
      {},
    );
    // The client data claims a different origin than the one the request is sent to.
    const spoofed = authenticator.assert(options.body as never, base, {
      clientOrigin: 'https://studio.example.com',
    });
    expect(
      (await new ApiClient(base).post('/api/auth/passkeys/login', { response: spoofed })).status,
    ).toBe(401);
    // And the same assertion presented at 127.0.0.1 (a non-passkey address) is refused as unavailable.
    const good = authenticator.assert(
      (await new ApiClient(base).post('/api/auth/passkeys/login-options', {})).body as never,
      base,
    );
    expect(
      (await studio.client().post('/api/auth/passkeys/login', { response: good })).status,
    ).toBe(503);
  });

  it('AT-SEC-045 (adapted): no-UV, a backwards counter, and an unknown credential all get the identical refusal', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);
    const fresh = () =>
      new ApiClient(base).post<Record<string, unknown>>('/api/auth/passkeys/login-options', {});

    const noUv = await new ApiClient(base).post<{ error: unknown }>('/api/auth/passkeys/login', {
      response: authenticator.assert((await fresh()).body as never, base, { userVerified: false }),
    });
    expect(
      (
        await new ApiClient(base).post('/api/auth/passkeys/login', {
          response: authenticator.assert((await fresh()).body as never, base),
        })
      ).status,
    ).toBe(200); // moves counter to >=1
    const backwards = await new ApiClient(base).post<{ error: unknown }>(
      '/api/auth/passkeys/login',
      { response: authenticator.assert((await fresh()).body as never, base, { signCount: 0 }) },
    );
    const unknown = await new ApiClient(base).post<{ error: unknown }>('/api/auth/passkeys/login', {
      response: {
        ...authenticator.assert((await fresh()).body as never, base),
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        rawId: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(noUv.status).toBe(401);
    expect(backwards.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(noUv.body).toEqual(backwards.body);
    expect(backwards.body).toEqual(unknown.body);
  });

  it('AT-SEC-046 (adapted): starting many challenges never blocks a genuine sign-in (issuance is stateless)', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);
    for (let i = 0; i < 200; i += 1)
      await new ApiClient(base).post('/api/auth/passkeys/login-options', {});
    const options = await new ApiClient(base).post<Record<string, unknown>>(
      '/api/auth/passkeys/login-options',
      {},
    );
    expect(
      (
        await new ApiClient(base).post('/api/auth/passkeys/login', {
          response: authenticator.assert(options.body as never, base),
        })
      ).status,
    ).toBe(200);
  });

  it('AT-SEC-049/050 (adapted): registration needs a signed-in browser and a usable address, checked before anything else', async () => {
    // An API token can never register a passkey (session-only).
    const owner = await studio.owner();
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'robot',
      scopes: ['read', 'write'],
    });
    const robot = new ApiClient(base);
    robot.bearer = created.body.token;
    expect(
      (await robot.post<{ error: { code: string } }>('/api/auth/passkeys/registration-options', {}))
        .body.error.code,
    ).toBe('session_required');
    // On a non-passkey address the refusal is "unavailable", decided before any step-up.
    const onLoopback = studio.client();
    onLoopback.cookie = owner.cookie;
    onLoopback.csrfToken = owner.csrfToken;
    expect(
      (
        await onLoopback.post<{ error: { code: string } }>(
          '/api/auth/passkeys/registration-options',
          {},
        )
      ).body.error.code,
    ).toBe('passkeys_unavailable');
    // A recently signed-in browser on localhost can.
    expect(
      (await (await ownerOnLocalhost()).post('/api/auth/passkeys/registration-options', {})).status,
    ).toBe(200);
  });

  it('AT-SEC-051/052 (adapted): a registration challenge is single-use and a duplicate credential is refused', async () => {
    const owner = await ownerOnLocalhost();
    const options = await owner.post<Record<string, unknown>>(
      '/api/auth/passkeys/registration-options',
      {},
    );
    const { credential, authenticator } = SoftwareAuthenticator.register(
      options.body as never,
      base,
    );
    expect(
      (await owner.post('/api/auth/passkeys/registration', { response: credential })).status,
    ).toBe(201);
    // Finishing the same challenge again is refused (single-use).
    expect(
      (await owner.post('/api/auth/passkeys/registration', { response: credential })).status,
    ).toBe(400);
    // Registering the same credential id under a fresh challenge is a duplicate.
    const freshOptions = await owner.post<Record<string, unknown>>(
      '/api/auth/passkeys/registration-options',
      {},
    );
    const dup = SoftwareAuthenticator.register(freshOptions.body as never, base, {
      credentialId: authenticator.credentialId,
    });
    const response = await owner.post<{ error: { code: string } }>(
      '/api/auth/passkeys/registration',
      { response: dup.credential },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('passkey_exists');
  });

  it('AT-SEC-053/054 (adapted): a bad removal is refused and leaves the passkey working; a removed one cannot sign in', async () => {
    const owner = await ownerOnLocalhost();
    const authenticator = await registerPasskey(owner);
    const list = await owner.get<{ passkeys: Array<{ id: string }> }>('/api/auth/passkeys');
    const id = list.body.passkeys[0]!.id;

    // A malformed id is a validation error; an unknown id is not-found.
    expect((await owner.delete('/api/auth/passkeys/not-a-valid-id')).status).toBe(400);
    expect((await owner.delete('/api/auth/passkeys/00000000000000000000000000')).status).toBe(404);
    // Another account cannot remove it (scoped to the owner) — looks like not-found.
    const member = await memberOnLocalhost();
    expect((await member.delete(`/api/auth/passkeys/${id}`)).status).toBe(404);
    // After all that, the passkey still signs in.
    const stillWorks = await new ApiClient(base).post('/api/auth/passkeys/login', {
      response: authenticator.assert(
        (await new ApiClient(base).post('/api/auth/passkeys/login-options', {})).body as never,
        base,
      ),
    });
    expect(stillWorks.status).toBe(200);

    // Now remove it for real; it can no longer sign in.
    expect((await owner.delete(`/api/auth/passkeys/${id}`)).status).toBe(204);
    const afterRemoval = await new ApiClient(base).post('/api/auth/passkeys/login', {
      response: authenticator.assert(
        (await new ApiClient(base).post('/api/auth/passkeys/login-options', {})).body as never,
        base,
      ),
    });
    expect(afterRemoval.status).toBe(401);
  });

  async function memberOnLocalhost(): Promise<ApiClient> {
    const owner = await studio.owner();
    const username = `member-${Math.random().toString(36).slice(2, 8)}`;
    await owner.post('/api/users', {
      username,
      password: 'a member passphrase 12',
      role: 'member',
    });
    const member = new ApiClient(base);
    const login = await member.login({ username, password: 'a member passphrase 12' });
    expect(login.status).toBe(200);
    return member;
  }
});

describe('6.4 a passkey sign-in lifts a password lock', () => {
  it('AT-SEC-048: a passkey signs in while password sign-in is locked, and clears that lock', async () => {
    const studio = await startTestStudio();
    const base = `http://localhost:${studio.port}`;
    try {
      const onLoopback = await studio.owner();
      const owner = new ApiClient(base);
      owner.cookie = onLoopback.cookie;
      owner.csrfToken = onLoopback.csrfToken;
      const options = await owner.post<Record<string, unknown>>(
        '/api/auth/passkeys/registration-options',
        {},
      );
      const { credential, authenticator } = SoftwareAuthenticator.register(
        options.body as never,
        base,
      );
      expect(
        (await owner.post('/api/auth/passkeys/registration', { response: credential })).status,
      ).toBe(201);

      // Lock password sign-in for the account.
      for (let i = 0; i < 5; i += 1)
        await studio.client().login({ username: OWNER.username, password: `wrong ${i}` });
      expect((await studio.client().login()).status).toBe(429);

      // The passkey still signs in.
      const signer = new ApiClient(base);
      const login = await signer.post('/api/auth/passkeys/login', {
        response: authenticator.assert(
          (await signer.post('/api/auth/passkeys/login-options', {})).body as never,
          base,
        ),
      });
      expect(login.status).toBe(200);

      // And the password lock has been lifted.
      expect((await studio.client().login()).status).toBe(200);
    } finally {
      await studio.destroy();
    }
  });
});
