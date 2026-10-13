import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { OWNER, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.3 — Sessions (§6.3).
 *
 * Intended differences: sessions are opaque server-side tokens in an
 * HttpOnly/SameSite=Strict cookie (ADR 0003), not signed JWTs, so the tamper
 * tests below alter the opaque token rather than a payload/signature/algorithm.
 * Lifetime is idle + absolute (configurable), not fixed 7-day half-life
 * renewal, so the half-life-replacement test (AT-SEC-028) does not apply.
 */

function openSocket(
  studio: RunningStudio,
  headers: Record<string, string>,
): Promise<{ result: 'open' | string }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, { headers });
    socket.once('open', () => {
      socket.close();
      resolve({ result: 'open' });
    });
    socket.once('unexpected-response', (_req, res) =>
      resolve({ result: `HTTP ${res.statusCode}` }),
    );
    socket.once('error', () => resolve({ result: 'error' }));
  });
}

describe('6.3 sessions', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-030 (adapted): a tampered or forged opaque session is refused on HTTP and on a realtime connect', async () => {
    const good = await studio.owner();
    const token = good.cookie!.split('=')[1]!;
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const bad of [flipped, 'x'.repeat(40), 'short', `${token}extra`]) {
      const http = studio.client();
      http.cookie = `studio_session=${bad}`;
      expect((await http.get('/api/system/info')).status, bad.slice(0, 6)).toBe(401);
      expect(
        (await openSocket(studio, { origin: studio.url, cookie: `studio_session=${bad}` })).result,
      ).toBe('HTTP 401');
    }
    // The genuine cookie still works, proving the refusals were about the tampering.
    expect((await good.get('/api/system/info')).status).toBe(200);
  });

  it('AT-SEC-031: a session supplied in the URL is ignored and the request is unauthenticated', async () => {
    const owner = await studio.owner();
    const token = owner.cookie!.split('=')[1]!;
    const anonymous = studio.client();
    for (const query of [`studio_session=${token}`, `token=${token}`, `access_token=${token}`]) {
      expect((await anonymous.get(`/api/system/info?${query}`)).status, query.split('=')[0]).toBe(
        401,
      );
    }
  });

  it('AT-SEC-032 (new): a credential replayed after sign-out is refused', async () => {
    const browser = await studio.owner();
    const stolen = browser.cookie!;
    expect((await browser.post('/api/auth/logout')).status).toBe(204);
    const thief = studio.client();
    thief.cookie = stolen;
    expect((await thief.get('/api/system/info')).status).toBe(401);
    expect((await openSocket(studio, { origin: studio.url, cookie: stolen })).result).toBe(
      'HTTP 401',
    );
  });

  it('AT-SEC-033/034: sign-out-everywhere revokes every session, and a later sign-in works', async () => {
    const laptop = await studio.owner();
    const phone = await studio.owner();
    expect((await phone.get('/api/system/info')).status).toBe(200);
    const revoked = await laptop.post('/api/auth/logout-everywhere');
    expect(revoked.status).toBe(204);
    // Both the caller's and the other device's credentials are refused now.
    expect((await laptop.get('/api/system/info')).status).toBe(401);
    expect((await phone.get('/api/system/info')).status).toBe(401);
    // A fresh sign-in afterwards yields a working session.
    const fresh = await studio.owner();
    expect((await fresh.get('/api/system/info')).status).toBe(200);
  });

  it('AT-SEC-033 (adapted): sessions are listed per device and can be revoked individually', async () => {
    const laptop = await studio.owner();
    const phone = await studio.owner();
    const listed = await laptop.get<{ sessions: Array<{ id: string; current: boolean }> }>(
      '/api/auth/sessions',
    );
    expect(listed.body.sessions.length).toBeGreaterThanOrEqual(2);
    const current = listed.body.sessions.find((s) => s.current)!;
    const other = listed.body.sessions.find((s) => !s.current)!;
    expect(current.id).not.toBe(other.id);
    // Revoking the other device ends it but not this one.
    expect((await laptop.delete(`/api/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await laptop.get('/api/system/info')).status).toBe(200);
    // A revoked id (or any unknown id) answers not-found, never leaking existence.
    expect((await laptop.delete(`/api/auth/sessions/${other.id}`)).status).toBe(404);
    void phone;
  });

  it('AT-SEC-037: current user and system info carry no password hash, raw session or secret', async () => {
    const owner = await studio.owner();
    const token = owner.cookie!.split('=')[1]!;
    const state = await owner.get('/api/auth/state');
    const info = await owner.get('/api/system/info');
    for (const payload of [JSON.stringify(state.body), JSON.stringify(info.body)]) {
      expect(payload).not.toContain(token); // the opaque session token is never echoed
      expect(payload).not.toContain(OWNER.password);
      expect(payload).not.toMatch(/password_hash|"scrypt|\$argon|master\.key/i);
    }
  });

  // A request that presents a session the server no longer honours is told so
  // ("session_expired"), distinctly from a request that presents none
  // ("unauthorized"), so the App can explain what happened. Expiry by time cannot be
  // driven from outside (the shortest idle lifetime is a day); a session ended on the
  // server is the same case as far as the client can observe.
  it('AT-SEC-029 (adapted): a session that has ended is refused with a marker distinct from "never signed in"', async () => {
    const owner = await studio.owner();
    const ended = studio.client();
    ended.cookie = owner.cookie;
    expect((await owner.post('/api/auth/logout')).status).toBe(204);
    const stale = await ended.get<{ error: { code: string } }>('/api/system/info');
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('session_expired');
    const anonymous = await studio.client().get<{ error: { code: string } }>('/api/system/info');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('unauthorized');
  });
});
