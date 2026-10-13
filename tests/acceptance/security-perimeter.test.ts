import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER, startStudio, type RunningStudio } from './support/studio.js';
import { rawRequest } from './support/raw.js';

/**
 * 6.8 — Perimeter (§6.8). These run under the default (production) env so the
 * Fastify rate-limit plugin and body limits behave as deployed. Where the
 * product's numeric limits differ from §5.1 (pre-auth body cap, message cap)
 * the test asserts the observable contract and says "(adapted)".
 *
 * Entry-class items (AT-SEC-097/098/100) and the in-flight cap (AT-SEC-086) are
 * not exercised: the harness reaches the server only over loopback with one
 * source address and the trusted-proxy switch off. See the report.
 */

describe('6.8 perimeter shape (headers, CORS, methods, errors)', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-095/096: the app shell, a sub-path and the API all carry CSP, anti-framing, no-sniff and referrer headers', async () => {
    for (const path of ['/', '/settings', '/api/health']) {
      const response = await fetch(`${studio.url}${path}`);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("script-src 'self'"); // no inline/foreign script
      expect(csp, path).not.toContain("'unsafe-eval'");
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(response.headers.get('strict-transport-security'), path).toBeTruthy();
    }
  });

  it('AT-SEC-093: the API enables no cross-origin reads; a pre-flight is not granted', async () => {
    const read = await fetch(`${studio.url}/api/auth/state`, {
      headers: { origin: 'https://attacker.example' },
    });
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${studio.url}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it("AT-SEC-094 (new): a signed-in browser's write from another origin, or without the anti-forgery token, is refused", async () => {
    const browser = await studio.owner();
    browser.origin = 'https://attacker.example';
    const foreign = await browser.post<{ error: { code: string } }>('/api/auth/logout-everywhere');
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('origin_not_allowed');
    browser.origin = studio.url;
    browser.csrfToken = null;
    const noCsrf = await browser.post<{ error: { code: string } }>('/api/auth/logout-everywhere');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('csrf_failed');
    // Neither changed anything: a correctly-formed request still works.
    const fresh = await studio.owner();
    expect((await fresh.get('/api/system/info')).status).toBe(200);
  });

  it('AT-SEC-011: unknown routes and the wrong method answer a uniform JSON error, never the shell', async () => {
    const unknown = await studio.client().get<{ error: { code: string } }>('/api/no/such/route');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
    // A method the route does not define is a 404 (the route is matched by method+path).
    const wrongMethod = await rawRequest({
      port: studio.port,
      method: 'DELETE',
      path: '/api/health',
    });
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.body).not.toContain('<!doctype html>');
  });

  it('AT-SEC-089: malformed JSON is a short 400 with no stack trace, and the log gains none', async () => {
    const response = await rawRequest({
      port: studio.port,
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: '{"username": "owner", ',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatch(/"code":"bad_request"/);
    expect(response.body).not.toMatch(/\.(ts|js):\d+/);
    expect(studio.output()).not.toMatch(/at .*\.(ts|js):\d+/);
  });

  it('AT-SEC-045/SEC-045: every error body is {error:{code,message}} with no stack trace or file path', async () => {
    const owner = await studio.owner();
    const errors = [
      await studio.client().get('/api/system/info'), // 401
      await studio.client().get('/api/no/such'), // 404
      await owner.post('/api/auth/tokens', { name: '', scopes: [] }), // 400 validation
      await studio.client().post('/api/auth/login', { username: 'x' }), // 400 validation
    ];
    for (const response of errors) {
      const body = response.body as { error?: { code?: unknown; message?: unknown } };
      expect(body.error, String(response.status)).toBeDefined();
      expect(typeof body.error!.code).toBe('string');
      expect(typeof body.error!.message).toBe('string');
      expect(JSON.stringify(body)).not.toMatch(/\/home\/|\.(ts|js):\d+|node_modules/);
    }
  });

  it('AT-SEC-087 (adapted): a body over the pre-authentication limit is refused as too large', async () => {
    const tooLarge = await fetch(`${studio.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: studio.url },
      body: JSON.stringify({ username: 'owner', password: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toMatch(/"code":"too_large"/);
  });

  it('AT-SEC-088 (adapted): a large body to a protected route is rejected as unauthenticated before it is processed', async () => {
    // The access check runs before the body is parsed, so a big anonymous body to
    // a protected route is a 401, not a 413 — the server never ingests it.
    const response = await rawRequest({
      port: studio.port,
      method: 'PATCH',
      path: '/api/preferences',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { blob: 'x'.repeat(200 * 1024) } }),
    });
    expect(response.status).toBe(401);
  });

  it('AT-SEC-089/W-14: a request with a foreign Host (DNS-rebinding) is refused', async () => {
    const response = await rawRequest({
      port: studio.port,
      method: 'GET',
      path: '/api/health',
      host: 'rebind.attacker.example',
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/"code":"host_not_allowed"/);
  });
});

describe('6.8 rate limiting and client identity', () => {
  it('AT-SEC-084 (adapted): an anonymous sign-in burst is refused with "too many" and a Retry-After', async () => {
    const studio = await startStudio();
    try {
      await studio.owner();
      let limited: { status: number; headers: Headers } | null = null;
      for (let i = 0; i < 40 && !limited; i += 1) {
        const response = await studio.client().login({ username: `burst-${i}`, password: 'wrong' });
        if (response.status === 429) limited = response;
      }
      expect(limited, 'expected a 429 within the documented anonymous budget').not.toBeNull();
      expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await studio.destroy();
    }
  });

  it('AT-SEC-099 (adapted): a forwarded-for header from a direct client is ignored (counted by connection address)', async () => {
    const studio = await startStudio();
    try {
      await studio.owner();
      // Distinct usernames (so no one account locks) with a different forged X-Forwarded-For each time.
      // With the trusted-proxy switch off, all are still one client (127.0.0.1) and hit the per-address budget.
      let throttled = false;
      for (let i = 0; i < 30 && !throttled; i += 1) {
        const response = await rawRequest({
          port: studio.port,
          method: 'POST',
          path: '/api/auth/login',
          headers: {
            'content-type': 'application/json',
            origin: studio.url,
            'x-forwarded-for': `10.0.0.${i}`,
          },
          body: JSON.stringify({ username: `xff-${i}`, password: 'wrong' }),
        });
        if (response.status === 429) throttled = true;
      }
      expect(throttled, 'the forged X-Forwarded-For did not create fresh budgets').toBe(true);
    } finally {
      await studio.destroy();
    }
  });

  it('AT-SEC-101 (adapted): after a burst of refusals the server output holds no full address or credential', async () => {
    const studio = await startStudio();
    try {
      await studio.owner();
      for (let i = 0; i < 30; i += 1)
        await studio.client().login({ username: `noise-${i}`, password: OWNER.password });
      const output = studio.output();
      expect(output).not.toContain(OWNER.password);
      // The refusals add no per-request log lines: the only address in the whole
      // output is the bind address printed in the startup banner — no client
      // addresses are logged for the burst.
      const addresses = output.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
      expect(addresses.every((address) => address === '127.0.0.1')).toBe(true);
      expect(addresses.length).toBeLessThanOrEqual(1);
    } finally {
      await studio.destroy();
    }
  });
});

describe('6.8 a configured public origin', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startStudio({
      env: { AGENT_STUDIO_PUBLIC_ORIGINS: 'https://studio.example.com' },
    });
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-094/W-01: at a configured https origin the session cookie is Secure and __Host- prefixed', async () => {
    const accepted = await rawRequest({
      port: studio.port,
      method: 'POST',
      path: '/api/auth/login',
      host: 'studio.example.com',
      headers: { 'content-type': 'application/json', origin: 'https://studio.example.com' },
      body: JSON.stringify(OWNER),
    });
    expect(accepted.status).toBe(200);
    const setCookie = ([] as string[]).concat(accepted.headers['set-cookie'] ?? []);
    const session = setCookie.find((c) => c.includes('studio_session'))!;
    expect(session).toMatch(/^__Host-studio_session=/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Strict/i);
  });

  it('AT-SEC-094: at that origin a sign-in whose Origin is another site is refused', async () => {
    const forged = await rawRequest({
      port: studio.port,
      method: 'POST',
      path: '/api/auth/login',
      host: 'studio.example.com',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(OWNER),
    });
    expect(forged.status).toBe(403);
  });
});
