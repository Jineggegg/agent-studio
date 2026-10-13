import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { OWNER, serverCommand, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.12 — Operations (§6.12), the parts reachable as a black box: the health
 * answer, the operator commands (status, setup-token, reset-password, unlock,
 * version, help), password change (AT-SEC-152) and the server side of
 * preference sync (AT-SEC-151). Graceful-restart run recovery (AT-SEC-146) and
 * cross-machine migration (AT-SEC-149) belong to other modules — see the report.
 */

function runOperator(studio: RunningStudio, args: string[], input?: string) {
  const command = serverCommand();
  return spawnSync(process.execPath, [...command.args, ...args], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGENT_STUDIO_DATA_DIR: studio.dataDir,
      AGENT_STUDIO_PORT: String(studio.port), // so `status` probes this server, not the default port
      AGENT_STUDIO_ENV: 'test',
      ...command.env,
    },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

describe('6.12 the operator command line', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-147 (adapted): status reports the data location, state and account count, and no secret', async () => {
    const result = runOperator(studio, ['status']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(studio.dataDir);
    expect(result.stdout).toMatch(/answering|not answering/);
    expect(result.stdout).toMatch(/Accounts:/);
    expect(result.stdout).not.toContain(OWNER.password);
  });

  it('SEC-075: version and help print, and an unknown command exits non-zero pointing at help', async () => {
    expect(runOperator(studio, ['version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = runOperator(studio, ['help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/Usage:/);
    const unknown = runOperator(studio, ['frobnicate']);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stdout).toMatch(/Unknown command/);
  });

  it('SEC-001: the setup token is gone once an account exists', async () => {
    const result = runOperator(studio, ['setup-token']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/no pending setup token/i);
  });

  it('SEC-102/AT-SEC-152: reset-password reads the new password from stdin, signs the account out and lets it back in', async () => {
    const result = runOperator(
      studio,
      ['reset-password', OWNER.username],
      'a brand new passphrase\n',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/signed out everywhere/i);
    // The old password no longer works; the new one does.
    expect((await studio.client().login()).status).toBe(401);
    expect(
      (
        await studio
          .client()
          .login({ username: OWNER.username, password: 'a brand new passphrase' })
      ).status,
    ).toBe(200);
  });
});

describe('6.12 password change in the app', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-152 (new): changing the password revokes other sessions and invalidates the old password', async () => {
    const phone = await studio.owner();
    const laptop = await studio.owner();
    expect((await phone.get('/api/system/info')).status).toBe(200);

    const changed = await laptop.post('/api/auth/password', {
      currentPassword: OWNER.password,
      newPassword: 'a replacement passphrase',
    });
    expect(changed.status).toBe(204);
    // Other sessions are revoked; the changing session keeps working.
    expect((await phone.get('/api/system/info')).status).toBe(401);
    expect((await laptop.get('/api/system/info')).status).toBe(200);
    // The old password no longer signs in; the new one does.
    expect((await studio.client().login()).status).toBe(401);
    expect(
      (
        await studio
          .client()
          .login({ username: OWNER.username, password: 'a replacement passphrase' })
      ).status,
    ).toBe(200);
  });
});

describe('6.12 a wrong current password changes nothing', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-152 (new): a wrong current password is refused, spends the step-up budget, and changes nothing', async () => {
    const session = await studio.owner();
    for (let i = 0; i < 5; i += 1) {
      const attempt = await session.post('/api/auth/password', {
        currentPassword: 'not my password',
        newPassword: 'another passphrase here',
      });
      expect(attempt.status).toBe(401);
    }
    // The sixth wrong attempt is refused by the step-up lock (budget spent), not by a password comparison.
    const locked = await session.post('/api/auth/password', {
      currentPassword: 'not my password',
      newPassword: 'another passphrase here',
    });
    expect(locked.status).toBe(429);
    // The original password still signs in — nothing was changed.
    expect((await studio.client().login()).status).toBe(200);
  });
});

describe('6.12 preference sync (server side of SEC-097)', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it("AT-SEC-151 (adapted): a preference change is merged key-by-key and announced on the account's realtime topic", async () => {
    const phone = await studio.owner();
    const laptop = await studio.owner();

    // The laptop subscribes to the account topic to hear changes.
    const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, {
      headers: { origin: studio.url, cookie: laptop.cookie! },
    });
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>(
      (resolve, reject) => (socket.once('open', () => resolve()), socket.once('error', reject)),
    );
    socket.send(JSON.stringify({ op: 'subscribe', topic: `user:${laptop.userId}` }));
    await waitFor(() => frames.some((f) => f.op === 'subscribed'));

    // The phone sets two preferences; a later patch of a different key must not drop the first.
    await phone.patch('/api/preferences', { values: { 'appearance.theme': 'dark' } });
    await phone.patch('/api/preferences', { values: { 'home.layout': 'grid' } });
    const all = await laptop.get<{ values: Record<string, unknown> }>('/api/preferences');
    expect(all.body.values).toMatchObject({ 'appearance.theme': 'dark', 'home.layout': 'grid' });

    // The change was announced on the realtime topic (so other pages update without a reload).
    await waitFor(() => frames.some((f) => f.op === 'event' && f.type === 'preferences.changed'));
    socket.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before the deadline');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
