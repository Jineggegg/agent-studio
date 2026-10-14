import { type HostToPanelMessage, PLUGIN_LIMITS, type PanelContext, type PluginPanelRpcResponse } from '@agent-studio/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/http';
import { type IncomingMessage, PanelRelay, jsonBytes, panelError } from './relay';

const GRANT = 'grant-0123456789abcdefghijklmnopqrstuvwxyz';
const CSRF = 'csrf-token-that-must-never-leave';

const context: PanelContext = {
  pluginId: 'notes-counter',
  panelId: 'notes',
  slot: 'project-tab',
  theme: 'dark',
  locale: 'en',
  project: { id: '01jabcdefghjkmnpqrstvwxyz0', name: 'Shop' },
  user: { displayName: 'Ada' },
};

function setup(options: { call?: (method: string, params: unknown) => Promise<PluginPanelRpcResponse> } = {}) {
  const frame = { name: 'the panel frame' } as unknown as MessageEventSource;
  const other = { name: 'some other window' } as unknown as MessageEventSource;
  const posted: HostToPanelMessage[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const onExpired = vi.fn();
  const onResize = vi.fn();
  const onReady = vi.fn();
  const call =
    options.call ??
    ((method: string, params: unknown) => {
      // The host's own call closes over the grant and the session; the relay never sees either.
      void GRANT;
      void CSRF;
      return Promise.resolve<PluginPanelRpcResponse>({ ok: true, result: { method, params } });
    });
  const relay = new PanelRelay({
    frameWindow: () => frame,
    context: () => context,
    call: (method, params) => {
      calls.push({ method, params });
      return call(method, params);
    },
    onExpired,
    onResize,
    onReady,
    post: (target, message) => {
      expect(target).toBe(frame);
      posted.push(message);
    },
  });
  const from = (data: unknown, overrides: Partial<IncomingMessage> = {}): void => relay.handle({ source: frame, origin: 'null', data, ...overrides });
  return { relay, frame, other, posted, calls, onExpired, onResize, onReady, from };
}

const envelope = { channel: 'agent-studio-panel', v: 1 } as const;
const request = (id: string, method = 'summary', params?: unknown) => ({ ...envelope, type: 'request', id, method, ...(params === undefined ? {} : { params }) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the panel relay: who may speak', () => {
  it('answers only its own frame, and only from an opaque origin', () => {
    const { from, other, posted } = setup();
    from({ ...envelope, type: 'ready' }, { source: other });
    from({ ...envelope, type: 'ready' }, { origin: 'http://127.0.0.1:7610' });
    from({ ...envelope, type: 'ready' }, { origin: 'https://evil.example' });
    from({ ...envelope, type: 'ready' }, { source: null });
    expect(posted).toEqual([]);
    from({ ...envelope, type: 'ready' });
    expect(posted).toHaveLength(1);
  });

  it('drops anything that does not parse with the protocol schema, without answering', () => {
    const { from, posted, calls } = setup();
    const refused: unknown[] = [
      null,
      'ready',
      42,
      { type: 'ready' },
      { ...envelope, v: 2, type: 'ready' },
      { channel: 'another-channel', v: 1, type: 'ready' },
      { ...envelope, type: 'ready', extra: true },
      { ...envelope, type: 'hello' },
      { ...envelope, type: 'request', id: 'has space', method: 'summary' },
      { ...envelope, type: 'request', id: 'x'.repeat(65), method: 'summary' },
      { ...envelope, type: 'request', id: '', method: 'summary' },
      { ...envelope, type: 'request', id: 'r1', method: '../escape' },
      { ...envelope, type: 'request', id: 'r1' },
      { ...envelope, type: 'resize', height: -1 },
      { ...envelope, type: 'resize', height: 1.5 },
      { ...envelope, type: 'resize', height: 20_001 },
    ];
    for (const data of refused) from(data);
    expect(posted).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a frame that does not exist yet is never answered', () => {
    const relay = new PanelRelay({ frameWindow: () => null, context: () => context, call: vi.fn(), onExpired: vi.fn(), post: vi.fn() });
    relay.handle({ source: null, origin: 'null', data: { ...envelope, type: 'ready' } });
    expect(relay.pending).toBe(0);
  });
});

describe('the panel relay: the conversation', () => {
  it('answers every ready with init and the context, and says once that the panel is up', () => {
    const { from, posted, onReady } = setup();
    from({ ...envelope, type: 'ready' });
    from({ ...envelope, type: 'ready' });
    expect(posted).toEqual([
      { ...envelope, type: 'init', context },
      { ...envelope, type: 'init', context },
    ]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('sends a changed context only to a panel that has said it is ready', () => {
    const { relay, from, posted } = setup();
    relay.sendContext();
    expect(posted).toEqual([]);
    from({ ...envelope, type: 'ready' });
    relay.sendContext();
    expect(posted.at(-1)).toEqual({ ...envelope, type: 'context', context });
  });

  it('relays a request and echoes its id with the answer', async () => {
    const { from, posted, calls } = setup();
    from(request('r1-abc', 'add', { text: 'hello' }));
    await settle();
    expect(calls).toEqual([{ method: 'add', params: { text: 'hello' } }]);
    expect(posted).toEqual([{ ...envelope, type: 'response', id: 'r1-abc', ok: true, result: { method: 'add', params: { text: 'hello' } } }]);
  });

  it('passes on a failure the plugin reports, and the code and message of a failed call — nothing else', async () => {
    const answers: (PluginPanelRpcResponse | Error)[] = [
      { ok: false, error: { code: 'not_found', message: 'No such note.' } },
      new ApiError(503, 'plugin_unavailable', 'The plugin is not running.', { secretDetail: CSRF }),
    ];
    const { from, posted } = setup({
      call: () => {
        const next = answers.shift()!;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    });
    from(request('a'));
    await settle();
    from(request('b'));
    await settle();
    expect(posted).toEqual([
      { ...envelope, type: 'response', id: 'a', ok: false, error: { code: 'not_found', message: 'No such note.' } },
      { ...envelope, type: 'response', id: 'b', ok: false, error: { code: 'plugin_unavailable', message: 'The plugin is not running.' } },
    ]);
  });

  it('clamps a requested height and hands it to the host', () => {
    const { from, onResize, posted } = setup();
    from({ ...envelope, type: 'resize', height: 480 });
    from({ ...envelope, type: 'resize', height: 20_000 });
    expect(onResize.mock.calls).toEqual([[480], [20_000]]);
    expect(posted).toEqual([]);
  });
});

describe('the panel relay: limits', () => {
  it('refuses a request larger than the limit without calling the server', async () => {
    const { from, posted, calls } = setup();
    const big = 'x'.repeat(PLUGIN_LIMITS.maxPanelMessageBytes);
    from(request('big', 'add', { text: big }));
    await settle();
    expect(calls).toEqual([]);
    expect(posted).toEqual([{ ...envelope, type: 'response', id: 'big', ok: false, error: { code: 'too_large', message: 'That request is too large.' } }]);
  });

  it('counts bytes, not characters', () => {
    expect(jsonBytes({ text: '进度' })).toBe(new TextEncoder().encode('{"text":"进度"}').length);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonBytes(cyclic)).toBeNull();
  });

  it(`refuses more than ${PLUGIN_LIMITS.maxPanelPendingRequests} requests in flight without calling the server`, async () => {
    const waiting: ((value: PluginPanelRpcResponse) => void)[] = [];
    const { relay, from, posted, calls } = setup({ call: () => new Promise((resolve) => waiting.push(resolve)) });
    for (let index = 0; index < PLUGIN_LIMITS.maxPanelPendingRequests; index += 1) from(request(`r${index}`));
    expect(relay.pending).toBe(PLUGIN_LIMITS.maxPanelPendingRequests);
    from(request('one-too-many'));
    expect(calls).toHaveLength(PLUGIN_LIMITS.maxPanelPendingRequests);
    expect(posted).toEqual([{ ...envelope, type: 'response', id: 'one-too-many', ok: false, error: { code: 'too_many_requests', message: 'Too many requests are waiting for an answer.' } }]);

    // Once one is answered there is room again.
    waiting[0]!({ ok: true, result: 1 });
    await settle();
    from(request('now-there-is-room'));
    expect(calls).toHaveLength(PLUGIN_LIMITS.maxPanelPendingRequests + 1);
  });

  it('never answers two requests with one id', async () => {
    const waiting: ((value: PluginPanelRpcResponse) => void)[] = [];
    const { from, posted, calls } = setup({ call: () => new Promise((resolve) => waiting.push(resolve)) });
    from(request('same'));
    from(request('same'));
    expect(calls).toHaveLength(1);
    waiting[0]!({ ok: true, result: 'first' });
    await settle();
    expect(posted).toEqual([{ ...envelope, type: 'response', id: 'same', ok: true, result: 'first' }]);
  });
});

describe('the panel relay: an expired grant', () => {
  it('answers with panel_expired, asks the host once to open the panel again, and calls nothing more', async () => {
    const { from, posted, calls, onExpired } = setup({ call: () => Promise.reject(new ApiError(410, 'panel_expired', 'This panel is no longer open. Open it again.')) });
    from(request('x1'));
    from(request('x2'));
    await settle();
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(posted.map((message) => (message.type === 'response' ? [message.id, message.error?.code] : null))).toEqual([
      ['x1', 'panel_expired'],
      ['x2', 'panel_expired'],
    ]);
    from(request('x3'));
    expect(calls).toHaveLength(2);
    expect(posted.at(-1)).toMatchObject({ id: 'x3', ok: false, error: { code: 'panel_expired' } });
  });
});

describe('the panel relay: nothing secret leaves the page', () => {
  it('posts only the context and answers — never the grant, a token or error details', async () => {
    const { relay, from, posted } = setup({
      call: (method) =>
        method === 'boom' ? Promise.reject(new ApiError(500, 'internal_error', 'Something failed.', { grant: GRANT, csrf: CSRF })) : Promise.resolve({ ok: true, result: 'fine' }),
    });
    from({ ...envelope, type: 'ready' });
    from(request('ok'));
    from(request('bad', 'boom'));
    relay.sendContext();
    await settle();
    const text = JSON.stringify(posted);
    expect(text).not.toContain(GRANT);
    expect(text).not.toContain(CSRF);
    for (const message of posted) {
      expect(Object.keys(message).sort()).toEqual(
        message.type === 'response' ? (message.ok ? ['channel', 'id', 'ok', 'result', 'type', 'v'] : ['channel', 'error', 'id', 'ok', 'type', 'v']) : ['channel', 'context', 'type', 'v'],
      );
    }
  });

  it('stops answering once the frame is disposed', async () => {
    const waiting: ((value: PluginPanelRpcResponse) => void)[] = [];
    const { relay, from, posted } = setup({ call: () => new Promise((resolve) => waiting.push(resolve)) });
    from(request('late'));
    relay.dispose();
    waiting[0]!({ ok: true, result: 'too late' });
    await settle();
    from({ ...envelope, type: 'ready' });
    expect(posted).toEqual([]);
  });

  it('keeps error text within the protocol’s bounds', () => {
    const error = panelError('c'.repeat(100), 'm'.repeat(900));
    expect(error.code).toHaveLength(64);
    expect(error.message).toHaveLength(500);
    expect(panelError('', '')).toEqual({ code: 'failed', message: 'The request failed.' });
  });
});
