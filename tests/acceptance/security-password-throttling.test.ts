import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER, serverCommand, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.2 — Password sign-in, throttling and lockout (§6.2).
 *
 * Intended differences (see the brief): throttling is per account (5 free
 * attempts, then doubling waits, persisted across restarts) and per client
 * address, not per "entry-point class"; there is no separate private-network
 * scope. The first lock here is ~30 s and doubles to a 15-minute cap, which
 * differs from the requirement document's recommended defaults; tests assert the observable contract
 * (a 429 with a positive Retry-After) and say "(adapted)" where the magnitude
 * or the entry-class dimension differs.
 *
 * Each test that locks an account for real gets its own server so it cannot
 * poison another.
 */

function runOperator(dataDir: string, args: string[], input?: string) {
  const command = serverCommand();
  return spawnSync(process.execPath, [...command.args, ...args], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGENT_STUDIO_DATA_DIR: dataDir,
      ...command.env,
    },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

describe('6.2 password sign-in (no lock)', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-012: the right password returns a usable, non-cacheable session', async () => {
    const client = studio.client();
    const login = await client.login();
    expect(login.status).toBe(200);
    expect(login.headers.get('cache-control')).toBe('no-store');
    const me = await client.get<{ user: { username: string } }>('/api/auth/state');
    expect(me.body.user.username).toBe(OWNER.username);
  });

  it('AT-SEC-013: a wrong password and an unknown username get the identical refusal', async () => {
    const wrong = await studio
      .client()
      .login({ username: OWNER.username, password: 'definitely not it' });
    const unknown = await studio
      .client()
      .login({ username: 'nobody-here', password: OWNER.password });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect((wrong.body as { error: { code: string } }).error.code).toBe('invalid_credentials');
  });

  it('AT-SEC-026: malformed or oversized sign-ins are refused and count against nothing', async () => {
    for (const body of [
      {},
      { username: 'owner' },
      { username: 5, password: 6 },
      { username: 'owner', password: 'x'.repeat(5000) },
    ]) {
      const response = await studio
        .client()
        .post<{ error: { code: string } }>('/api/auth/login', body);
      expect([400, 413]).toContain(response.status);
    }
    // None of that was counted as a failed attempt: the real password still works immediately.
    expect((await studio.client().login()).status).toBe(200);
  });

  it('AT-SEC-027 (new): a password past the maximum is refused as invalid, not truncated', async () => {
    const tooLong = await studio
      .client()
      .login({ username: OWNER.username, password: 'x'.repeat(257) });
    expect(tooLong.status).toBe(400);
    // The real password (a prefix of nothing) still works — nothing was silently truncated and matched.
    expect((await studio.client().login()).status).toBe(200);
  });
});

describe('6.2 lockout, its persistence and recovery (one intended sequence)', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  // This block runs as a sequence on one server on purpose.
  it('AT-SEC-017 (adapted): five wrong passwords lock the account; the lock is reported with Retry-After', async () => {
    // Five different clients, one wrong password each, for the same account.
    for (let i = 0; i < 5; i += 1) {
      const attempt = await studio
        .client()
        .login({ username: OWNER.username, password: `wrong ${i}` });
      expect(attempt.status).toBe(401);
    }
    const locked = await studio.client().login();
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(
      (locked.body as { error: { details: { retryAfterSeconds: number } } }).error.details
        .retryAfterSeconds,
    ).toBeGreaterThan(0);
  });

  it('AT-SEC-018 (adapted): a session signed in before the lock keeps working (locks never touch live sessions)', async () => {
    // Sign in a browser, then lock the account from other clients.
    const browser = await startStudioSignedIn();
    try {
      for (let i = 0; i < 5; i += 1)
        await browser.studio.client().login({ username: OWNER.username, password: `nope ${i}` });
      expect((await browser.studio.client().login()).status).toBe(429);
      // The already-signed-in browser is unaffected.
      expect((await browser.client.get('/api/system/info')).status).toBe(200);
    } finally {
      await browser.studio.destroy();
    }
  });

  it('AT-SEC-021: the lock survives a restart', async () => {
    expect((await studio.client().login()).status).toBe(429); // still locked from AT-SEC-017
    await studio.restart();
    expect((await studio.client().login()).status).toBe(429);
  });

  it('AT-SEC-015/066 (adapted): the operator unlock command restores sign-in without a password or restart', async () => {
    const result = runOperator(studio.dataDir, ['unlock']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Cleared \d+ lock/);
    expect((await studio.client().login()).status).toBe(200);
  });
});

describe('6.2 lock scope: real vs made-up usernames, and the per-address budget', () => {
  it('AT-SEC-022: a made-up username locks exactly as a real one does (same shape)', async () => {
    const studio = await startTestStudio();
    try {
      await studio.owner();
      const lock = async (username: string) => {
        for (let i = 0; i < 5; i += 1)
          await studio.client().login({ username, password: `wrong ${i}` });
        return studio.client().login({ username, password: 'still wrong' });
      };
      const madeUp = await lock('ghost-account');
      const real = await lock(OWNER.username);
      expect(madeUp.status).toBe(429);
      expect(real.status).toBe(429);
      expect((madeUp.body as { error: { code: string } }).error.code).toBe(
        (real.body as { error: { code: string } }).error.code,
      );
      // Both carry a Retry-After in the same format.
      expect(Number(madeUp.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(real.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await studio.destroy();
    }
  });

  it('AT-SEC-023 (adapted): many made-up username locks do not evict the real account lock', async () => {
    const studio = await startTestStudio();
    try {
      await studio.owner();
      for (let i = 0; i < 5; i += 1)
        await studio.client().login({ username: OWNER.username, password: `wrong ${i}` });
      expect((await studio.client().login()).status).toBe(429); // real account locked
      // A flood of distinct made-up usernames (the per-account store is DB-backed, no eviction).
      for (let n = 0; n < 40; n += 1) {
        await studio.client().login({ username: `flood-${n}`, password: 'x' });
      }
      expect((await studio.client().login()).status).toBe(429); // real account still locked
    } finally {
      await studio.destroy();
    }
  });

  it('AT-SEC-024 (adapted): one address guessing many usernames is throttled by its per-address budget', async () => {
    const studio = await startTestStudio();
    try {
      await studio.owner();
      // Distinct usernames so no single account locks; the per-address budget (20 free) is what bites.
      let throttled = 0;
      for (let n = 0; n < 30; n += 1) {
        const response = await studio.client().login({ username: `addr-${n}`, password: 'wrong' });
        if (response.status === 429) throttled += 1;
      }
      expect(throttled).toBeGreaterThan(0);
    } finally {
      await studio.destroy();
    }
  });

  it("AT-SEC-025: a correct sign-in clears the account's own failure count", async () => {
    const studio = await startTestStudio();
    try {
      await studio.owner();
      for (let i = 0; i < 4; i += 1) {
        expect(
          (await studio.client().login({ username: OWNER.username, password: `wrong ${i}` }))
            .status,
        ).toBe(401);
      }
      expect((await studio.client().login()).status).toBe(200); // success resets the count
      for (let i = 0; i < 4; i += 1) {
        const again = await studio
          .client()
          .login({ username: OWNER.username, password: `wrong again ${i}` });
        expect(again.status, 'the cleared count means these four are not yet throttled').toBe(401);
      }
    } finally {
      await studio.destroy();
    }
  });

  // Attempts are counted before the password is compared, so a parallel burst is
  // bounded exactly like guesses made one after another. (Found by this suite and fixed.)
  it('AT-SEC-016: six parallel wrong passwords — at most five are evaluated, the rest are throttled', async () => {
    const studio = await startTestStudio();
    try {
      await studio.owner();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          studio.client().login({ username: OWNER.username, password: `parallel ${i}` }),
        ),
      );
      expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(1);
      expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    } finally {
      await studio.destroy();
    }
  });
});

/** A server plus a signed-in browser client on it. */
async function startStudioSignedIn(): Promise<{
  studio: RunningStudio;
  client: Awaited<ReturnType<RunningStudio['owner']>>;
}> {
  const studio = await startTestStudio();
  const client = await studio.owner();
  return { studio, client };
}
