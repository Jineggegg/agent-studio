import type { ServerFrame } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type TestClient, createTestStudio, type TestStudio } from '../../src/testing/harness.js';

let t: TestStudio;
let wsUrl: string;
let origin: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  t = await createTestStudio();
  const address = await t.listen();
  wsUrl = `${address.wsUrl}/api/realtime`;
  origin = address.url;
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await t.close();
});

interface Live {
  socket: WebSocket;
  frames: ServerFrame[];
  next(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  send(frame: unknown): void;
  closed: Promise<number>;
}

function connect(client: TestClient | null, headers: Record<string, string> = {}): Promise<Live> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      headers: { origin, ...(client?.cookie ? { cookie: client.cookie } : {}), ...(client?.bearer ? { authorization: `Bearer ${client.bearer}` } : {}), ...headers },
    });
    sockets.push(socket);
    const frames: ServerFrame[] = [];
    const waiters: Array<{ predicate: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }> = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
    const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
    const live: Live = {
      socket,
      frames,
      closed,
      send: (frame) => socket.send(JSON.stringify(frame)),
      next: (predicate) =>
        new Promise((found, timeout) => {
          const existing = frames.find(predicate);
          if (existing) return found(existing);
          const timer = setTimeout(() => timeout(new Error('timed out waiting for a frame')), 3000);
          waiters.push({ predicate, resolve: (frame) => (clearTimeout(timer), found(frame)) });
        }),
    };
    socket.once('open', () => resolve(live));
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once('error', reject);
  });
}

describe('realtime connection', () => {
  it('refuses visitors who are not signed in', async () => {
    await t.owner();
    await expect(connect(null)).rejects.toThrow('HTTP 401');
  });

  it('refuses a handshake that another website initiated', async () => {
    const owner = await t.owner();
    await expect(connect(owner, { origin: 'https://evil.example' })).rejects.toThrow('HTTP 403');
  });

  it('refuses a cookie handshake with no Origin header', async () => {
    const owner = await t.owner();
    const attempt = new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { cookie: owner.cookie! } });
      sockets.push(socket);
      socket.once('open', () => resolve('open'));
      socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
      socket.once('error', reject);
    });
    await expect(attempt).rejects.toThrow('HTTP 403');
  });

  it('delivers events on a topic the user may see, and only those', async () => {
    const owner = await t.owner();
    const member = await t.member();
    const live = await connect(owner);
    await live.next((frame) => frame.op === 'ready');

    live.send({ op: 'subscribe', topic: `user:${owner.userId}` });
    await live.next((frame) => frame.op === 'subscribed');
    live.send({ op: 'subscribe', topic: `user:${member.userId}` });
    expect(await live.next((frame) => frame.op === 'rejected')).toMatchObject({ topic: `user:${member.userId}`, code: 'forbidden' });
    live.send({ op: 'subscribe', topic: 'nonsense:1' });
    await live.next((frame) => frame.op === 'rejected' && frame.topic === 'nonsense:1');

    t.studio.context.bus.publish(`user:${member.userId}`, 'inbox.item', { secret: 'for the member only' });
    t.studio.context.bus.publish(`user:${owner.userId}`, 'inbox.item', { text: 'hello owner' });
    const event = await live.next((frame) => frame.op === 'event');
    expect(event).toMatchObject({ topic: `user:${owner.userId}`, type: 'inbox.item', data: { text: 'hello owner' } });
    expect(JSON.stringify(live.frames)).not.toContain('for the member only');
  });

  it('replays what a client missed and hands over a snapshot', async () => {
    const owner = await t.owner();
    const log = [1, 2, 3, 4].map((seq) => ({ seq, type: 'log.line', data: { n: seq }, at: Date.now() }));
    t.studio.context.realtime.registerTopic({
      kind: 'demo',
      authorize: (_principal, key) => key === 'open',
      replay: (_key, after) => log.filter((event) => event.seq > after),
      snapshot: () => ({ partial: 'half a sentence' }),
    });
    const live = await connect(owner);
    live.send({ op: 'subscribe', topic: 'demo:open', after: 2 });
    expect(await live.next((frame) => frame.op === 'subscribed')).toMatchObject({ replayed: 2, snapshot: { partial: 'half a sentence' } });
    await live.next((frame) => frame.op === 'event' && frame.seq === 4);
    expect(live.frames.filter((frame) => frame.op === 'event').map((frame) => (frame as { seq: number }).seq)).toEqual([3, 4]);

    live.send({ op: 'subscribe', topic: 'demo:closed' });
    await live.next((frame) => frame.op === 'rejected');
  });

  it('stops delivering after unsubscribe and answers pings', async () => {
    const owner = await t.owner();
    const live = await connect(owner);
    const topic = `user:${owner.userId}`;
    live.send({ op: 'subscribe', topic });
    await live.next((frame) => frame.op === 'subscribed');
    live.send({ op: 'unsubscribe', topic });
    live.send({ op: 'ping', t: 42 });
    expect(await live.next((frame) => frame.op === 'pong')).toMatchObject({ t: 42 });
    t.studio.context.bus.publish(topic, 'inbox.item', {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live.frames.some((frame) => frame.op === 'event')).toBe(false);
  });

  it('closes the connection the moment the session ends', async () => {
    const owner = await t.owner();
    const live = await connect(owner);
    await live.next((frame) => frame.op === 'ready');
    await owner.post('/api/auth/logout');
    expect(await live.closed).toBe(4401);
  });

  it('closes the connection when the account is disabled', async () => {
    const owner = await t.owner();
    const member = await t.member();
    const live = await connect(member);
    await live.next((frame) => frame.op === 'ready');
    await owner.patch(`/api/users/${member.userId}`, { disabled: true });
    expect(await live.closed).toBe(4401);
  });

  it('drops clients that break the protocol', async () => {
    const owner = await t.owner();
    const live = await connect(owner);
    live.socket.send('this is not json');
    expect(await live.closed).toBe(4400);
  });
});
