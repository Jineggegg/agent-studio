import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * 6.7 — Real-time connections (§6.7). One WebSocket per tab at /api/realtime,
 * authenticated by the session cookie and an Origin check (ADR 0006). The
 * per-account open-connection cap is 24 (kernel/realtime.ts
 * MAX_CONNECTIONS_PER_USER); the server closes excess connections with 4429 and
 * a revoked/expired credential with 4401. The message cap is 1 MiB here, below
 * the 16 MiB of §5.1 (a deliberately smaller bound); an oversize frame is
 * closed with the standard 1009 "message too big".
 */

interface Conn {
  socket: WebSocket;
  readonly ready: Promise<void>;
  nextFrame(): Promise<Record<string, unknown>>;
  closed(): Promise<number>;
}

function connect(studio: RunningStudio, headers: Record<string, string>): Conn {
  const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, { headers });
  const frames: Record<string, unknown>[] = [];
  let resolveFrame: (() => void) | null = null;
  socket.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
    resolveFrame?.();
    resolveFrame = null;
  });
  return {
    socket,
    ready: new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
      socket.once('error', reject);
    }),
    async nextFrame() {
      if (frames.length === 0) await new Promise<void>((resolve) => (resolveFrame = resolve));
      return frames.shift()!;
    },
    closed() {
      return new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    },
  };
}

/** Attempts a handshake and reports only how it ended. */
function handshake(studio: RunningStudio, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, { headers });
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
    socket.once('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
    socket.once('error', () => resolve('error'));
  });
}

describe('6.7 real-time connections', () => {
  let studio: RunningStudio;
  beforeAll(async () => {
    studio = await startTestStudio();
    await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-SEC-075 (adapted): a connect with no, tampered or revoked credential is refused, with no data frame', async () => {
    const owner = await studio.owner();
    const token = owner.cookie!.split('=')[1]!;
    expect(await handshake(studio, { origin: studio.url })).toBe('HTTP 401'); // none
    expect(
      await handshake(studio, {
        origin: studio.url,
        cookie: `studio_session=${token.slice(0, -1)}Z`,
      }),
    ).toBe('HTTP 401'); // tampered
    expect(await handshake(studio, { origin: 'https://evil.example', cookie: owner.cookie! })).toBe(
      'HTTP 403',
    ); // foreign origin
    // Revoke, then the once-valid cookie no longer opens a socket.
    await owner.post('/api/auth/logout');
    expect(await handshake(studio, { origin: studio.url, cookie: owner.cookie! })).toBe('HTTP 401');
  });

  it("AT-SEC-075/SEC-033: a user may subscribe to its own topic; another user's and unknown topics look identical", async () => {
    const owner = await studio.owner();
    const conn = connect(studio, { origin: studio.url, cookie: owner.cookie! });
    await conn.ready;
    expect((await conn.nextFrame()).op).toBe('ready');
    conn.socket.send(JSON.stringify({ op: 'subscribe', topic: `user:${owner.userId}` }));
    expect((await conn.nextFrame()).op).toBe('subscribed');
    conn.socket.send(JSON.stringify({ op: 'subscribe', topic: 'user:someone-else' }));
    const foreign = await conn.nextFrame();
    conn.socket.send(JSON.stringify({ op: 'subscribe', topic: 'no-such-kind:key' }));
    const unknown = await conn.nextFrame();
    expect(foreign).toEqual({ op: 'rejected', topic: 'user:someone-else', code: 'forbidden' });
    expect(unknown).toEqual({ op: 'rejected', topic: 'no-such-kind:key', code: 'forbidden' });
    conn.socket.close();
  });

  it('AT-SEC-075: a malformed frame closes the connection with the protocol code', async () => {
    const owner = await studio.owner();
    const conn = connect(studio, { origin: studio.url, cookie: owner.cookie! });
    await conn.ready;
    const closed = conn.closed();
    conn.socket.send('this is not a JSON frame');
    expect(await closed).toBe(4400);
  });

  it('AT-SEC-076: sign-out-everywhere closes live connections within a second; the old credential will not reconnect', async () => {
    const phone = await studio.owner();
    const a = connect(studio, { origin: studio.url, cookie: phone.cookie! });
    const b = connect(studio, { origin: studio.url, cookie: phone.cookie! });
    await Promise.all([a.ready, b.ready]);
    const bothClosed = Promise.all([a.closed(), b.closed()]);

    const laptop = await studio.owner();
    expect((await laptop.post('/api/auth/logout-everywhere')).status).toBe(204);
    const codes = await withTimeout(bothClosed, 1000, 'connections were not closed within 1 s');
    expect(codes).toEqual([4401, 4401]);
    expect(await handshake(studio, { origin: studio.url, cookie: phone.cookie! })).toBe('HTTP 401');
  });

  it('AT-SEC-077 (new): a connection does not outlive the session that opened it (individual sign-out)', async () => {
    const browser = await studio.owner();
    const conn = connect(studio, { origin: studio.url, cookie: browser.cookie! });
    await conn.ready;
    const closed = conn.closed();
    expect((await browser.post('/api/auth/logout')).status).toBe(204);
    expect(await withTimeout(closed, 1000, 'the connection was not closed after sign-out')).toBe(
      4401,
    );
  });

  it('AT-SEC-078: connections past the per-account cap (24) are refused with 4429, and freeing one makes room', async () => {
    const owner = await studio.owner();
    const open: WebSocket[] = [];
    let accepted = 0;
    let refusedCode: number | null = null;
    for (let i = 0; i < 30; i += 1) {
      const outcome = await new Promise<{ ok: boolean; code?: number; socket?: WebSocket }>(
        (resolve) => {
          const socket = new WebSocket(`${studio.wsUrl}/api/realtime`, {
            headers: { origin: studio.url, cookie: owner.cookie! },
          });
          let settled = false;
          const settle = (value: { ok: boolean; code?: number; socket?: WebSocket }) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          socket.once('message', () => settle({ ok: true, socket })); // the 'ready' frame means accepted
          socket.once('close', (code) => settle({ ok: false, code }));
          socket.once('error', () => {});
        },
      );
      if (outcome.ok) {
        accepted += 1;
        open.push(outcome.socket!);
      } else {
        refusedCode = outcome.code ?? null;
      }
    }
    expect(accepted).toBe(24);
    expect(refusedCode).toBe(4429);
    // Free one slot, and a new connection is accepted.
    open[0]!.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(await handshake(studio, { origin: studio.url, cookie: owner.cookie! })).toBe('open');
    for (const socket of open) socket.close();
  });

  it('AT-SEC-080 (adapted): an oversize message closes the connection and the server stays healthy', async () => {
    const owner = await studio.owner();
    const conn = connect(studio, { origin: studio.url, cookie: owner.cookie! });
    await conn.ready;
    const closed = conn.closed();
    conn.socket.send(JSON.stringify({ op: 'subscribe', topic: 'x'.repeat(2 * 1024 * 1024) }));
    expect(await closed).toBe(1009); // the standard "message too big" close
    expect((await studio.client().get('/api/health')).status).toBe(200);
  });

  it('AT-SEC-083: a realtime connect carrying a credential leaves no credential in the server output', async () => {
    const owner = await studio.owner();
    const token = owner.cookie!.split('=')[1]!;
    const conn = connect(studio, { origin: studio.url, cookie: owner.cookie! });
    await conn.ready;
    conn.socket.close();
    expect(studio.output()).not.toContain(token);
  });
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
