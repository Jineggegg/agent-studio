import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RealtimeEvent, RealtimeClient, type SocketLike } from './realtime';

/** A socket the test drives by hand. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  /** Answer pings like a healthy server would. */
  autoPong = false;

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.op === 'ping' && this.autoPong) this.receive({ op: 'pong', t: frame.t });
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  // ---- what the server does ----
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
    this.receive({ op: 'ready', connectionId: 'c1', serverTime: 1 });
  }
  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  event(topic: string, type: string, seq?: number, data: unknown = null): void {
    this.receive({ op: 'event', topic, type, data, at: 1, ...(seq === undefined ? {} : { seq }) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** Frames of one kind sent so far. */
  frames(op: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.op === op);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const onAuthEnded = vi.fn();
  const client = new RealtimeClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    url: () => 'ws://studio.test/api/realtime',
    onAuthEnded,
    random: () => 0.5,
  });
  return { client, sockets, onAuthEnded, last: () => sockets[sockets.length - 1]! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the realtime client', () => {
  it('opens one socket and subscribes once the server has greeted it', () => {
    const { client, sockets, last } = setup();
    const handler = vi.fn();
    client.subscribe('session:a', handler);
    client.start();
    client.start(); // idempotent
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe('ws://studio.test/api/realtime');
    expect(client.state.status).toBe('connecting');
    expect(last().sent).toEqual([]); // nothing before the greeting

    last().open();
    expect(client.state.status).toBe('open');
    expect(last().frames('subscribe')).toEqual([{ op: 'subscribe', topic: 'session:a' }]);
  });

  it('passes `after` so the server replays what the caller is missing', () => {
    const { client, last } = setup();
    client.start();
    last().open();
    client.subscribe('session:a', vi.fn(), { after: 41 });
    expect(last().frames('subscribe')).toEqual([{ op: 'subscribe', topic: 'session:a', after: 41 }]);
  });

  it('delivers events, snapshots and rejections to the right subscriber', () => {
    const { client, last } = setup();
    const events: RealtimeEvent[] = [];
    const onSnapshot = vi.fn();
    const onSubscribed = vi.fn();
    const onRejected = vi.fn();
    client.subscribe('session:a', (event) => events.push(event), { onSnapshot, onSubscribed });
    client.subscribe('project:secret', vi.fn(), { onRejected });
    client.start();
    last().open();

    last().receive({ op: 'subscribed', topic: 'session:a', replayed: 0, snapshot: { partial: 'Hel' } });
    last().receive({ op: 'rejected', topic: 'project:secret', code: 'forbidden' });
    last().event('session:a', 'message.delta', undefined, { text: 'lo' });
    last().event('session:other', 'message.delta'); // not ours

    expect(onSubscribed).toHaveBeenCalledWith({ replayed: 0, resumed: false });
    expect(onSnapshot).toHaveBeenCalledWith({ partial: 'Hel' });
    expect(onRejected).toHaveBeenCalledWith('forbidden');
    expect(events).toEqual([{ topic: 'session:a', type: 'message.delta', data: { text: 'lo' }, seq: undefined, at: 1 }]);
  });

  it('drops events whose sequence number it has already delivered', () => {
    const { client, last } = setup();
    const seen: (number | undefined)[] = [];
    client.subscribe('session:a', (event) => seen.push(event.seq));
    client.start();
    last().open();

    last().event('session:a', 'm', 1);
    last().event('session:a', 'm', 2);
    last().event('session:a', 'm', 2); // duplicate
    last().event('session:a', 'm', 1); // stale
    last().event('session:a', 'm', 3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('reconnects after a drop, with back-off and jitter, and never gives up', () => {
    const { client, sockets, last } = setup();
    client.start();
    last().open();
    last().drop();
    expect(client.state.status).toBe('waiting');
    expect(sockets).toHaveLength(1);

    // first retry: ceiling 500 ms, equal jitter with random()=0.5 → 375 ms
    vi.advanceTimersByTime(374);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(sockets).toHaveLength(2);

    // every further failure waits longer, up to the cap, for ever
    let previousDelay = 375;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const before = sockets.length;
      last().drop();
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(25);
        waited += 25;
        if (waited > 60_000) throw new Error('gave up reconnecting');
      }
      expect(waited).toBeGreaterThanOrEqual(Math.min(previousDelay, 22_500) - 25);
      expect(waited).toBeLessThanOrEqual(30_000);
      previousDelay = waited;
    }
    expect(previousDelay).toBeGreaterThan(20_000); // capped near 30 s, not growing without bound
  });

  it('re-subscribes after reconnecting with the last sequence number seen, and replays without duplicates', () => {
    const { client, sockets, last } = setup();
    const seen: number[] = [];
    const onSubscribed = vi.fn();
    client.subscribe('session:a', (event) => seen.push(event.seq!), { onSubscribed });
    client.subscribe('user:u1', vi.fn());
    client.start();
    last().open();
    last().receive({ op: 'subscribed', topic: 'session:a', replayed: 0 });
    last().event('session:a', 'm', 7);
    last().event('session:a', 'm', 8);

    last().drop();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    last().open();

    // the durable topic asks for what came after 8; the other has no numbers to resume from
    expect(last().frames('subscribe')).toEqual([
      { op: 'subscribe', topic: 'session:a', after: 8 },
      { op: 'subscribe', topic: 'user:u1' },
    ]);

    // the server replays 8 (overlap), 9 and 10, then a live 10 arrives again
    last().receive({ op: 'subscribed', topic: 'session:a', replayed: 3 });
    last().event('session:a', 'm', 8);
    last().event('session:a', 'm', 9);
    last().event('session:a', 'm', 10);
    last().event('session:a', 'm', 10);
    expect(seen).toEqual([7, 8, 9, 10]);
    expect(onSubscribed).toHaveBeenLastCalledWith({ replayed: 3, resumed: true });
  });

  it('tells listeners when the connection has come back after a gap', () => {
    const { client, last } = setup();
    const onReady = vi.fn();
    client.onReady(onReady);
    client.start();
    last().open();
    expect(onReady).toHaveBeenLastCalledWith({ reconnected: false });
    last().drop();
    vi.advanceTimersByTime(1_000);
    last().open();
    expect(onReady).toHaveBeenLastCalledWith({ reconnected: true });
  });

  it('stops for good when the server says the session ended (4401)', () => {
    const { client, sockets, last, onAuthEnded } = setup();
    client.subscribe('session:a', vi.fn());
    client.start();
    last().open();
    last().drop(4401);

    expect(client.state.status).toBe('ended');
    expect(onAuthEnded).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1); // no reconnection attempts

    // a new session starts it again, and the subscription is still there
    client.start();
    expect(sockets).toHaveLength(2);
    last().open();
    expect(last().frames('subscribe')).toEqual([{ op: 'subscribe', topic: 'session:a' }]);
  });

  it('comes straight back after being dropped as a slow consumer (4408) and waits longer after a protocol error (4400)', () => {
    const { client, sockets, last } = setup();
    client.start();
    last().open();
    // let the back-off grow first
    last().drop();
    vi.advanceTimersByTime(400);
    last().drop();
    vi.advanceTimersByTime(800);
    last().open();
    const before = sockets.length;

    last().drop(4408);
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(before + 1);

    last().open();
    last().drop(4400);
    vi.advanceTimersByTime(1_500);
    expect(sockets).toHaveLength(before + 1); // not yet
    vi.advanceTimersByTime(3_000);
    expect(sockets).toHaveLength(before + 2);
  });

  it('pings, and treats silence as a dead connection', () => {
    const { client, sockets, last } = setup();
    client.start();
    last().open();
    vi.advanceTimersByTime(25_000);
    expect(last().frames('ping')).toHaveLength(1);

    // an answer keeps it alive
    last().receive({ op: 'pong', t: 1 });
    vi.advanceTimersByTime(15_000);
    expect(client.state.status).toBe('open');

    // the next ping goes unanswered
    vi.advanceTimersByTime(10_000);
    expect(last().frames('ping')).toHaveLength(2);
    vi.advanceTimersByTime(10_001);
    expect(client.state.status).toBe('waiting');
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('unsubscribes when the last listener of a topic leaves, and only then', () => {
    const { client, last } = setup();
    client.start();
    last().open();
    const first = client.subscribe('session:a', vi.fn());
    const second = client.subscribe('session:a', vi.fn());
    last().receive({ op: 'subscribed', topic: 'session:a', replayed: 0 });

    first();
    expect(last().frames('unsubscribe')).toEqual([]);
    second();
    second(); // calling it twice is harmless
    expect(last().frames('unsubscribe')).toEqual([{ op: 'unsubscribe', topic: 'session:a' }]);
  });

  it('gives a late subscriber only what comes after it joined', () => {
    const { client, last } = setup();
    client.start();
    last().open();
    const early: number[] = [];
    const late: number[] = [];
    client.subscribe('session:a', (event) => early.push(event.seq!));
    last().event('session:a', 'm', 1);
    client.subscribe('session:a', (event) => late.push(event.seq!));
    last().event('session:a', 'm', 1); // a replay overlap must not reach the late joiner as "new"
    last().event('session:a', 'm', 2);
    expect(early).toEqual([1, 2]);
    expect(late).toEqual([2]);
  });

  it("stays under the server's frame budget when many topics subscribe at once", () => {
    const { client, last } = setup();
    for (let index = 0; index < 120; index += 1) client.subscribe(`project:p${index}`, vi.fn());
    client.start();
    last().autoPong = true;
    last().open();
    const socket = last();
    expect(socket.sent.length).toBeLessThanOrEqual(45);
    // In no 30-second stretch may more than 45 frames go out, whatever the phase of the server's counter.
    const sentAt: number[] = socket.sent.map(() => 0);
    for (let elapsed = 100; elapsed <= 120_000; elapsed += 100) {
      const before = socket.sent.length;
      vi.advanceTimersByTime(100);
      for (let index = before; index < socket.sent.length; index += 1) sentAt.push(elapsed);
    }
    for (const start of sentAt) expect(sentAt.filter((time) => time >= start && time < start + 30_000).length).toBeLessThanOrEqual(45);
    expect(last()).toBe(socket); // the connection survived: pings were never starved
    expect(socket.frames('subscribe')).toHaveLength(120);
    expect(socket.frames('ping').length).toBeGreaterThanOrEqual(4);
  });

  it('survives a subscriber that throws, and ignores frames it cannot understand', async () => {
    const { client, last } = setup();
    const good = vi.fn();
    client.subscribe('session:a', () => {
      throw new Error('feature bug');
    });
    client.subscribe('session:a', good);
    client.start();
    last().open();
    const rethrown = vi.fn();
    process.once('uncaughtException', rethrown);
    last().event('session:a', 'm', 1);
    last().onmessage?.({ data: 'not json' });
    last().receive({ op: 'mystery' });
    expect(good).toHaveBeenCalledTimes(1);
    expect(client.state.status).toBe('open');
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('uncaughtException', rethrown);
  });

  it('stop() closes the socket and stays closed', () => {
    const { client, sockets, last } = setup();
    client.start();
    last().open();
    client.stop();
    expect(last().closedWith).toBe(1000);
    expect(client.state.status).toBe('idle');
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('wake() reconnects at once instead of waiting out the back-off', () => {
    const { client, sockets, last } = setup();
    client.start();
    last().open();
    for (let index = 0; index < 6; index += 1) {
      last().drop();
      vi.advanceTimersByTime(40_000);
    }
    last().drop();
    const before = sockets.length;
    client.wake();
    expect(sockets).toHaveLength(before + 1);
  });
});
