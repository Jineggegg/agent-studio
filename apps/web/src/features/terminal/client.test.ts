// @vitest-environment node
import { TERMINAL_CLOSE_CODES, type TerminalSession } from '@agent-studio/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_DELAYS_MS, RESTING_PHASES, TerminalClient, type TerminalClientEvents, type TerminalPhase, type TerminalSocket, outcomeOfClose, reconnectDelay } from './client';

const SESSION_ID = '01tttttttttttttttttttttttt';

const session = (overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id: SESSION_ID,
  projectId: '01pppppppppppppppppppppppp',
  title: 'bash',
  launcher: null,
  remoteHostId: null,
  directory: '/srv/demo',
  createdAt: 1,
  lastActivityAt: 2,
  attachedClients: 1,
  alive: true,
  exitCode: null,
  signal: null,
  endReason: null,
  cols: 80,
  rows: 24,
  seq: 0,
  urls: [],
  attachable: true,
  idleExpiresAt: null,
  expiresAt: 9_999_999,
  ...overrides,
});

class FakeSocket implements TerminalSocket {
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  constructor(readonly path: string) {}
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1005;
  }
  // ---- what the server does ----
  open(): void {
    this.onopen?.();
  }
  control(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  bytes(text: string): void {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
  }
  drop(code: number): void {
    this.onclose?.({ code });
  }
  get controls(): Record<string, unknown>[] {
    return this.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
  get binary(): string[] {
    return this.sent.filter((frame): frame is ArrayBuffer => typeof frame !== 'string').map((frame) => new TextDecoder().decode(frame));
  }
}

function attachedFrame(from: number, to: number, mode: 'delta' | 'full' = 'full', truncated = false, limits = { maxInputFrameBytes: 65536, heartbeatMs: 30_000 }) {
  return { type: 'attached', protocol: 1, clientId: 'c1', session: session({ seq: to }), replay: { mode, from, to, truncated }, limits };
}

function harness(options: { probe?: () => Promise<'ok' | 'gone' | 'unavailable' | 'unreachable'> } = {}) {
  const sockets: FakeSocket[] = [];
  const phases: TerminalPhase[] = [];
  const output: string[] = [];
  const resets: boolean[] = [];
  const timers: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  const size = { cols: 100, rows: 30 };
  const events: TerminalClientEvents = {
    onPhase: (phase) => phases.push(phase),
    onData: (bytes) => output.push(new TextDecoder().decode(bytes)),
    onReset: ({ truncated }) => {
      resets.push(truncated);
      output.length = 0;
    },
    onAttached: vi.fn(),
    onSession: vi.fn(),
    onSize: vi.fn(),
    onUrl: vi.fn(),
    onExit: vi.fn(),
  };
  const client = new TerminalClient({
    sessionId: SESSION_ID,
    createSocket: (path) => {
      const socket = new FakeSocket(path);
      sockets.push(socket);
      return socket;
    },
    size: () => size,
    events,
    random: () => 0.5,
    timers: {
      set: (callback, ms) => {
        const timer = { callback, ms, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { cancelled: boolean }).cancelled = true;
      },
    },
    ...(options.probe ? { probe: options.probe } : {}),
  });
  /** Runs the retry timers that are due (heartbeats are left alone unless asked for). */
  const fire = (predicate: (ms: number) => boolean = (ms) => ms < 20_000) => {
    for (const timer of [...timers]) {
      if (timer.cancelled || !predicate(timer.ms)) continue;
      timer.cancelled = true;
      timer.callback();
    }
  };
  const pending = () => timers.filter((timer) => !timer.cancelled && timer.ms < 20_000).map((timer) => timer.ms);
  const last = () => sockets[sockets.length - 1]!;
  /** Brings the client to "live" on a fresh session. */
  const goLive = (from = 0, to = 0) => {
    client.connect();
    last().open();
    last().control(attachedFrame(from, to));
    last().control({ type: 'live', seq: to });
  };
  return { client, sockets, phases, output, resets, events, size, fire, pending, last, goLive, timers };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe('attaching', () => {
  it('opens the session\'s own socket, asks for bytes as buffers, and attaches first with its size', () => {
    h.client.connect();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().path).toBe(`/api/terminal/sessions/${SESSION_ID}/socket`);
    expect(h.last().binaryType).toBe('arraybuffer');
    expect(h.last().sent).toEqual([]);
    h.last().open();
    // The first frame: attach, with the widget's size and no position (this client has seen nothing yet).
    expect(h.last().controls).toEqual([{ type: 'attach', cols: 100, rows: 30 }]);
    expect(h.phases).toEqual(['connecting']);
  });

  it('takes its position from the replay marker and counts every byte of output', () => {
    h.client.connect();
    h.last().open();
    h.last().control(attachedFrame(120, 131));
    expect(h.client.seq).toBe(120);
    expect(h.client.phase).toBe('replaying');
    h.last().bytes('hello ');
    h.last().bytes('world');
    expect(h.client.seq).toBe(131);
    h.last().control({ type: 'live', seq: 131 });
    expect(h.client.phase).toBe('live');
    h.last().bytes('$ ');
    expect(h.client.seq).toBe(133);
    expect(h.output.join('')).toBe('hello world$ ');
  });

  it('passes bytes on as they come, never decoding a character that was split across frames', () => {
    const seen: Uint8Array[] = [];
    h.events.onData = (bytes) => seen.push(bytes);
    h.goLive();
    const euro = new TextEncoder().encode('€'); // three bytes
    h.last().onmessage?.({ data: euro.slice(0, 1).buffer });
    h.last().onmessage?.({ data: euro.slice(1).buffer });
    expect(seen.map((bytes) => [...bytes])).toEqual([[0xe2], [0x82, 0xac]]);
    expect(h.client.seq).toBe(3);
  });

  it('clears the widget for a full replay and says when older output is gone', () => {
    h.client.connect();
    h.last().open();
    h.last().control(attachedFrame(4096, 4100, 'full', true));
    expect(h.resets).toEqual([true]);
  });

  it('appends a delta replay without clearing anything', () => {
    h.goLive(0, 0);
    h.last().bytes('abc');
    h.last().drop(1006);
    h.fire();
    h.last().open();
    h.last().control(attachedFrame(3, 6, 'delta'));
    h.last().bytes('def');
    expect(h.resets).toEqual([false]); // only the very first attach reset the (empty) widget
    expect(h.output.join('')).toBe('abcdef');
    expect(h.events.onAttached).toHaveBeenLastCalledWith(expect.objectContaining({ first: false }));
  });

  it('ignores output that arrives before the server has said where it starts', () => {
    h.client.connect();
    h.last().open();
    h.last().bytes('stray');
    expect(h.output).toEqual([]);
    expect(h.client.seq).toBeNull();
  });

  it('follows the server\'s count when the two disagree at "live"', () => {
    h.client.connect();
    h.last().open();
    h.last().control(attachedFrame(0, 10));
    h.last().bytes('12345');
    h.last().control({ type: 'live', seq: 10 });
    expect(h.client.seq).toBe(10);
  });

  it('ignores frames it does not know, so a newer server does not break it', () => {
    h.goLive();
    h.last().control({ type: 'something-new', value: 1 });
    h.last().onmessage?.({ data: 'not json' });
    expect(h.client.phase).toBe('live');
  });

  it('passes on the session, a new size, and the addresses a program printed', () => {
    h.goLive();
    h.last().control({ type: 'resize', cols: 60, rows: 20 });
    expect(h.events.onSize).toHaveBeenCalledWith({ cols: 60, rows: 20 });
    h.last().control({ type: 'session', session: session({ title: 'server' }) });
    expect(h.events.onSession).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'server' }));
    h.last().control({ type: 'url', url: { url: 'http://localhost:5173', scheme: 'http', host: 'localhost', port: 5173 } });
    expect(h.events.onUrl).toHaveBeenCalledWith(expect.objectContaining({ port: 5173 }));
  });
});

describe('typing and resizing', () => {
  it('sends input as bytes, each frame in a buffer of its own', () => {
    h.goLive();
    expect(h.client.send('ls -la\r')).toBe(true);
    expect(h.last().binary).toEqual(['ls -la\r']);
    expect(h.client.send('€')).toBe(true);
    expect(new Uint8Array(h.last().sent[h.last().sent.length - 1] as ArrayBuffer)).toEqual(new Uint8Array([0xe2, 0x82, 0xac]));
  });

  it('splits a large paste into frames no larger than the server allows', () => {
    h.client.connect();
    h.last().open();
    h.last().control(attachedFrame(0, 0, 'full', false, { maxInputFrameBytes: 4, heartbeatMs: 30_000 }));
    h.last().control({ type: 'live', seq: 0 });
    h.client.send('abcdefghij');
    expect(h.last().binary).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('never queues input for later: what cannot be sent now is not typed by surprise afterwards', () => {
    h.client.connect();
    expect(h.client.send('rm -rf x\r')).toBe(false);
    h.last().open();
    expect(h.client.send('too early')).toBe(false);
    h.last().control(attachedFrame(0, 0));
    h.last().control({ type: 'live', seq: 0 });
    expect(h.last().binary).toEqual([]);
    h.last().drop(1006);
    expect(h.client.send('gone')).toBe(false);
  });

  it('tells the server when the widget changes size', () => {
    h.goLive();
    h.client.resize(120, 40);
    expect(h.last().controls[h.last().controls.length - 1]).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });

  it('attaches with whatever size the widget has by then', () => {
    h.client.connect();
    h.size.cols = 132;
    h.size.rows = 43;
    h.last().open();
    expect(h.last().controls[0]).toEqual({ type: 'attach', cols: 132, rows: 43 });
  });
});

describe('why a socket closed decides what happens next', () => {
  it('maps every close code the protocol defines', () => {
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.protocol, false)).toEqual({ next: 'rest', phase: 'failed' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.authEnded, false)).toEqual({ next: 'rest', phase: 'signed-out' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.reauthRequired, false)).toEqual({ next: 'rest', phase: 'needs-identity' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.notFound, false)).toEqual({ next: 'rest', phase: 'gone' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.slowConsumer, false)).toEqual({ next: 'reattach', when: 'now' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.ended, false)).toEqual({ next: 'rest', phase: 'ended' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.tooManyClients, false)).toEqual({ next: 'rest', phase: 'crowded' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.unavailable, false)).toEqual({ next: 'rest', phase: 'unavailable' });
    expect(outcomeOfClose(TERMINAL_CLOSE_CODES.goingAway, false)).toEqual({ next: 'reattach', when: 'backoff' });
    expect(outcomeOfClose(1009, false)).toEqual({ next: 'rest', phase: 'failed' });
    expect(outcomeOfClose(1006, false)).toEqual({ next: 'reattach', when: 'backoff' });
    // Every code in the table leads somewhere known.
    for (const code of Object.values(TERMINAL_CLOSE_CODES)) {
      const outcome = outcomeOfClose(code, false);
      expect(outcome.next === 'reattach' || RESTING_PHASES.includes(outcome.phase), String(code)).toBe(true);
    }
  });

  it('after an exit frame the session is over, whatever code the close carries', () => {
    expect(outcomeOfClose(1006, true)).toEqual({ next: 'rest', phase: 'ended' });
    h.goLive();
    h.last().control({ type: 'exit', exitCode: 0, signal: null, reason: 'exited', seq: 0 });
    h.last().drop(TERMINAL_CLOSE_CODES.ended);
    expect(h.events.onExit).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0, reason: 'exited' }));
    expect(h.client.phase).toBe('ended');
    expect(h.pending()).toEqual([]);
  });

  it.each([
    [TERMINAL_CLOSE_CODES.authEnded, 'signed-out'],
    [TERMINAL_CLOSE_CODES.notFound, 'gone'],
    [TERMINAL_CLOSE_CODES.tooManyClients, 'crowded'],
    [TERMINAL_CLOSE_CODES.unavailable, 'unavailable'],
    [TERMINAL_CLOSE_CODES.protocol, 'failed'],
  ] as const)('rests after %i and does not knock again by itself', (code, phase) => {
    h.goLive();
    h.last().drop(code);
    expect(h.client.phase).toBe(phase);
    expect(h.pending()).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  it('keeps the reason the server gave just before closing', () => {
    const details: unknown[] = [];
    h.events.onPhase = (_phase, detail) => details.push(detail.error);
    h.goLive();
    h.last().control({ type: 'error', code: 'too_many_clients', message: 'Too many browsers are attached.' });
    h.last().drop(TERMINAL_CLOSE_CODES.tooManyClients);
    expect(details[details.length - 1]).toEqual({ code: 'too_many_clients', message: 'Too many browsers are attached.' });
  });

  it('waits for the person to confirm who they are, then attaches again from where it was', () => {
    h.goLive();
    h.last().bytes('prompt$ ');
    h.last().drop(TERMINAL_CLOSE_CODES.reauthRequired);
    expect(h.client.phase).toBe('needs-identity');
    expect(h.pending()).toEqual([]);
    // …the step-up dialog was answered:
    h.client.connect();
    h.last().open();
    expect(h.last().controls[0]).toEqual({ type: 'attach', cols: 100, rows: 30, after: 8 });
  });

  it('a slow consumer attaches again at once with the position it reached', () => {
    h.goLive();
    h.last().bytes('x'.repeat(50));
    h.last().drop(TERMINAL_CLOSE_CODES.slowConsumer);
    expect(h.client.phase).toBe('reconnecting');
    expect(h.pending()).toEqual([0]);
    h.fire();
    h.last().open();
    expect(h.last().controls[0]).toMatchObject({ type: 'attach', after: 50 });
  });
});

describe('reconnecting', () => {
  it('tries again after a dropped connection, with the offset it had reached', () => {
    h.goLive();
    h.last().bytes('1234567');
    h.last().drop(1006);
    expect(h.client.phase).toBe('reconnecting');
    expect(h.pending()).toEqual([RECONNECT_DELAYS_MS[0]]);
    h.fire();
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    expect(h.last().controls[0]).toEqual({ type: 'attach', cols: 100, rows: 30, after: 7 });
  });

  it('backs off, never gives up, and starts over once it is attached again', () => {
    h.goLive();
    h.last().drop(1006);
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      waits.push(h.pending()[0]!);
      h.fire();
      h.last().drop(1006);
    }
    expect(waits).toEqual([400, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    // Attached again: the next gap starts from the short wait.
    h.fire();
    h.last().open();
    h.last().control(attachedFrame(0, 0, 'delta'));
    h.last().control({ type: 'live', seq: 0 });
    h.last().drop(1001);
    expect(h.pending()).toEqual([400]);
  });

  it('spreads its attempts a little, within a fifth either way', () => {
    expect(reconnectDelay(1, () => 0)).toBe(320);
    expect(reconnectDelay(1, () => 1)).toBe(480);
    expect(reconnectDelay(99, () => 0.5)).toBe(15_000);
  });

  it('does not sit out a back-off when the page comes back to the foreground', () => {
    h.goLive();
    h.last().drop(1006);
    h.fire();
    h.last().drop(1006);
    expect(h.sockets).toHaveLength(2);
    h.client.wake();
    expect(h.sockets).toHaveLength(3);
    expect(h.pending()).toEqual([]);
    // Waking while connected, or while resting, does nothing.
    h.last().open();
    h.last().control(attachedFrame(0, 0, 'delta'));
    h.client.wake();
    expect(h.sockets).toHaveLength(3);
  });

  it('asks why when the socket will not even open, and stops for a session that is gone', async () => {
    const probe = vi.fn(async () => 'gone' as const);
    h = harness({ probe });
    h.client.connect();
    h.last().drop(1006);
    expect(probe).not.toHaveBeenCalled();
    h.fire();
    h.last().drop(1006);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.client.phase).toBe('gone'));
    expect(h.pending()).toEqual([]);
  });

  it('keeps trying when the server is merely unreachable', async () => {
    const probe = vi.fn(async () => 'unreachable' as const);
    h = harness({ probe });
    h.client.connect();
    h.last().drop(1006);
    h.fire();
    h.last().drop(1006);
    await vi.waitFor(() => expect(h.pending()).toHaveLength(1));
    expect(h.client.phase).toBe('reconnecting');
  });

  it('attaching afresh forgets the position, so the server replays all it keeps', () => {
    h.goLive();
    h.last().bytes('garbled');
    h.client.reattachFresh();
    expect(h.sockets[0]!.closedWith).toBe(1000);
    h.last().open();
    expect(h.last().controls[0]).toEqual({ type: 'attach', cols: 100, rows: 30 });
  });

  it('notices a connection that has gone silent and replaces it', () => {
    h.goLive();
    const beat = () => h.fire((ms) => ms >= 20_000);
    beat(); // first beat: heard since attaching; sends a ping
    expect(h.last().controls.some((frame) => frame.type === 'ping')).toBe(true);
    h.last().control({ type: 'pong' });
    beat(); // heard the pong
    expect(h.client.phase).toBe('live');
    beat(); // silent once
    beat(); // silent twice: dead
    expect(h.client.phase).toBe('reconnecting');
    expect(h.sockets[0]!.closedWith).toBe(1000);
  });
});

describe('leaving', () => {
  it('closes the socket, stops every timer, and stays stopped', () => {
    h.goLive();
    h.last().drop(1006);
    h.client.dispose();
    expect(h.client.phase).toBe('closed');
    expect(h.pending()).toEqual([]);
    h.client.connect();
    h.client.wake();
    expect(h.sockets).toHaveLength(1);
  });

  it('a socket that was replaced can no longer speak for the session', () => {
    h.goLive();
    const first = h.last();
    h.client.dispose();
    expect(first.closedWith).toBe(1000);
    expect(first.onmessage).toBeNull();
    expect(first.onclose).toBeNull();
  });
});
