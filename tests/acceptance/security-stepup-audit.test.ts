import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.5 — Step-up, locks and audit (§6.5).
 *
 * Step-up is POST /api/auth/reauth: a per-session wrong-password budget plus a
 * per-account daily cap (ADR 0003). The requirements' "security overview"
 * is GET /api/auth/locks here, with a sign-in scope and a session step-up
 * scope (no separate private-network scope), so those items are "(adapted)".
 */

const wrong = { password: 'this is not the password' };

describe('6.5 per-session step-up budget', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-056: five wrong step-ups lock that session, while another session still steps up', async () => {
    const sessionA = await studio.owner();
    const sessionB = await studio.owner();
    for (let i = 0; i < 5; i += 1)
      expect((await sessionA.post('/api/auth/reauth', wrong)).status).toBe(401);
    const lockedA = await sessionA.post('/api/auth/reauth', { password: OWNER.password });
    expect(lockedA.status).toBe(429); // even the correct password is refused now
    expect(Number(lockedA.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await sessionB.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(
      200,
    );
  });

  it("AT-SEC-057: a new sign-in is unaffected by another session's step-up lock", async () => {
    const sessionA = await studio.owner();
    for (let i = 0; i < 5; i += 1) await sessionA.post('/api/auth/reauth', wrong);
    expect((await sessionA.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(
      429,
    );
    const sessionC = await studio.owner(); // signing in elsewhere
    expect((await sessionC.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(
      200,
    );
    expect((await sessionA.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(
      429,
    );
  });

  it('AT-SEC-061: while a session is step-up locked, further attempts are not compared (they do not spend the daily cap)', async () => {
    const locked = await studio.owner();
    for (let i = 0; i < 5; i += 1) await locked.post('/api/auth/reauth', wrong);
    expect((await locked.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(429);
    // A burst of attempts against the locked session is refused by the lock, before any comparison.
    for (let i = 0; i < 30; i += 1)
      expect((await locked.post('/api/auth/reauth', wrong)).status).toBe(429);
    // Because none of those were compared, a fresh session still steps up (the daily cap was not spent).
    const fresh = await studio.owner();
    expect((await fresh.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(200);
  });
});

describe('6.5 per-account daily step-up cap (one intended sequence)', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-058 (adapted): 20 compared wrong step-ups across sessions cap every further step-up for the account', async () => {
    // Each session contributes 5 comparisons before its own budget locks it; four sessions reach the daily 20.
    for (let session = 0; session < 4; session += 1) {
      const client = await studio.owner();
      for (let i = 0; i < 5; i += 1) await client.post('/api/auth/reauth', wrong);
    }
    const fresh = await studio.owner();
    const capped = await fresh.post('/api/auth/reauth', { password: OWNER.password });
    expect(capped.status).toBe(429); // a brand-new session with the correct password is still refused
    expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('AT-SEC-059: signing out everywhere clears the daily cap so the correct password works again', async () => {
    const client = await studio.owner();
    expect((await client.post('/api/auth/logout-everywhere')).status).toBe(204);
    const afterReset = await studio.owner();
    expect((await afterReset.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(
      200,
    );
  });
});

describe('6.5 a sign-in lock does not touch step-up, and is shown per scope (one intended sequence)', () => {
  let studio: RunningStudio;
  let session: Awaited<ReturnType<RunningStudio['owner']>>;
  beforeAll(async () => {
    studio = await startTestStudio();
    // A session obtained before the lock — a lock never touches a live session.
    session = await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-060: a signed-in session still steps up while password sign-in is locked', async () => {
    for (let i = 0; i < 5; i += 1)
      await studio.client().login({ username: OWNER.username, password: `wrong ${i}` });
    expect((await studio.client().login()).status).toBe(429); // sign-in now locked
    expect((await session.post('/api/auth/reauth', { password: OWNER.password })).status).toBe(200); // step-up unaffected
  });

  it('AT-SEC-062 (adapted): the locks view shows the sign-in scope locked with an end time, the session scope normal', async () => {
    const locks = await session.get<{
      signInLockedUntil: number | null;
      stepUpLockedUntil: number | null;
    }>('/api/auth/locks');
    expect(locks.body.signInLockedUntil).toBeGreaterThan(Date.now());
    expect(locks.body.stepUpLockedUntil).toBeNull();
  });
});

describe('6.5 audit log', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-064: events mask the client address and carry no password or credential', async () => {
    await studio.client().login({ username: OWNER.username, password: 'a wrong password' }); // a failure to record
    const owner = await studio.owner();
    const events = await owner.get<{ events: Array<{ action: string; address: string | null }> }>(
      '/api/audit?limit=100',
    );
    expect(events.body.events.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(events.body);
    expect(serialised).not.toContain(OWNER.password);
    expect(serialised).not.toContain('a wrong password');
    expect(serialised).not.toContain(owner.cookie!.split('=')[1]!);
    for (const event of events.body.events) {
      if (event.address !== null) {
        // A masked form only: a full dotted IPv4 (four octets) must not appear.
        expect(event.address, event.action).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
    }
  });

  it('AT-SEC-063 (adapted): a flood of failures does not evict a recorded change event (categories retained apart)', async () => {
    const owner = await studio.owner();
    await owner.post('/api/auth/tokens', { name: 'retained', scopes: ['read'] }); // a "change" event
    for (let i = 0; i < 40; i += 1)
      await studio.client().login({ username: `noise-${i}`, password: 'x' }); // "failure" events
    const changes = await owner.get<{ events: Array<{ action: string; subject: string | null }> }>(
      '/api/audit?category=change&limit=100',
    );
    expect(changes.body.events.some((e) => e.action === 'api-token.created')).toBe(true);
    const failures = await owner.get<{ events: unknown[] }>(
      '/api/audit?category=failure&limit=100',
    );
    expect(failures.body.events.length).toBeGreaterThan(0);
  });
});
