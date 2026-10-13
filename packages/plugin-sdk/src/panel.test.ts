import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PANEL_CHANNEL, PANEL_PROTOCOL_VERSION, PanelError, connectPanel } from './panel.js';

type Posted = { message: Record<string, unknown>; targetOrigin: string };
type Listener = (event: { source: unknown; origin: string; data: unknown }) => void;

const STUDIO = 'https://studio.example';

/** Just enough of a browser window for the panel helper: a parent to post to and a way to deliver messages. */
function fakeBrowser() {
  const posted: Posted[] = [];
  const listeners = new Set<Listener>();
  const parent = {
    postMessage: (message: Record<string, unknown>, targetOrigin: string) => posted.push({ message, targetOrigin }),
  };
  const window = {
    parent: parent as unknown,
    location: { origin: STUDIO },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (timer: NodeJS.Timeout) => clearInterval(timer),
  };
  const deliver = (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
    for (const listener of [...listeners]) listener({ source: from.source ?? parent, origin: from.origin ?? STUDIO, data });
  };
  const envelope = (body: Record<string, unknown>) => ({ channel: PANEL_CHANNEL, v: PANEL_PROTOCOL_VERSION, ...body });
  return { window, parent, posted, listeners, deliver, envelope };
}

const context = {
  pluginId: 'demo',
  panelId: 'main',
  slot: 'home-tile',
  theme: 'dark',
  locale: 'en',
  project: null,
  user: { displayName: 'Alice' },
};

let browser: ReturnType<typeof fakeBrowser>;
const globals = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  browser = fakeBrowser();
  globals.window = browser.window;
  globals.document = { documentElement: { scrollHeight: 123.4 } };
});
afterEach(() => {
  delete globals.window;
  delete globals.document;
  delete globals.ResizeObserver;
});

async function connected() {
  const pending = connectPanel();
  browser.deliver(browser.envelope({ type: 'init', context }));
  return pending;
}

describe('panel helper', () => {
  it('refuses to run outside a frame', async () => {
    browser.window.parent = browser.window;
    await expect(connectPanel()).rejects.toMatchObject({ code: 'not_embedded' });
  });

  it('greets the embedding page at the origin it was loaded from and resolves with the context', async () => {
    const studio = await connected();
    expect(browser.posted[0]).toEqual({ message: { channel: 'agent-studio-panel', v: 1, type: 'ready' }, targetOrigin: STUDIO });
    expect(studio.context).toEqual(context);
    expect(Object.isFrozen(studio.context)).toBe(true);
  });

  it('keeps greeting until it is answered, then stops', async () => {
    const pending = connectPanel();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const greetings = browser.posted.filter((entry) => entry.message.type === 'ready').length;
    expect(greetings).toBeGreaterThanOrEqual(2);
    browser.deliver(browser.envelope({ type: 'init', context }));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(browser.posted.filter((entry) => entry.message.type === 'ready').length).toBe(greetings);
  });

  it('ignores anything that is not from the embedding page at the right origin on the right channel', async () => {
    const pending = connectPanel({ timeoutMs: 150 });
    browser.deliver(browser.envelope({ type: 'init', context }), { source: { other: 'window' } });
    browser.deliver(browser.envelope({ type: 'init', context }), { origin: 'https://evil.example' });
    browser.deliver(browser.envelope({ type: 'init', context }), { origin: 'null' });
    browser.deliver({ channel: 'something-else', v: 1, type: 'init', context });
    browser.deliver({ channel: PANEL_CHANNEL, v: 2, type: 'init', context });
    browser.deliver(browser.envelope({ type: 'init' }));
    browser.deliver('init');
    browser.deliver(null);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(browser.listeners.size).toBe(0);
  });

  it('matches responses to requests by id', async () => {
    const studio = await connected();
    const first = studio.request<{ n: number }>('summary', { page: 1 });
    const second = studio.request('other');
    const [a, b] = browser.posted.filter((entry) => entry.message.type === 'request').map((entry) => entry.message);
    expect(a).toMatchObject({ channel: PANEL_CHANNEL, v: 1, type: 'request', method: 'summary', params: { page: 1 } });
    expect(b).not.toHaveProperty('params');
    expect(a!.id).not.toBe(b!.id);
    expect(String(a!.id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    browser.deliver(browser.envelope({ type: 'response', id: b!.id, ok: false, error: { code: 'permission_denied', message: 'No.' } }));
    browser.deliver(browser.envelope({ type: 'response', id: a!.id, ok: true, result: { n: 7 } }));
    await expect(first).resolves.toEqual({ n: 7 });
    const failure = await second.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PanelError);
    expect(failure).toMatchObject({ code: 'permission_denied', message: 'No.' });
  });

  it('does not accept a response from anyone but the embedding page', async () => {
    const studio = await connected();
    const request = studio.request('summary', undefined, { timeoutMs: 100 });
    const id = browser.posted.at(-1)!.message.id;
    browser.deliver(browser.envelope({ type: 'response', id, ok: true, result: 'forged' }), { source: {} });
    browser.deliver(browser.envelope({ type: 'response', id, ok: true, result: 'forged' }), { origin: 'https://evil.example' });
    await expect(request).rejects.toMatchObject({ code: 'timeout' });
    // A late answer to a request that already timed out is ignored.
    browser.deliver(browser.envelope({ type: 'response', id, ok: true, result: 'late' }));
  });

  it('refuses requests that are too large, not JSON, or too many at once — without posting them', async () => {
    const studio = await connected();
    const before = browser.posted.length;
    await expect(studio.request('big', { text: 'x'.repeat(300 * 1024) })).rejects.toMatchObject({ code: 'too_large' });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await expect(studio.request('loop', loop)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(browser.posted.length).toBe(before);

    const waiting = Array.from({ length: 32 }, () => studio.request('slow').catch(() => {}));
    await expect(studio.request('one-too-many')).rejects.toMatchObject({ code: 'too_many_requests' });
    studio.close();
    await Promise.all(waiting);
  });

  it('tells listeners about context changes until they unsubscribe', async () => {
    const studio = await connected();
    const seen: string[] = [];
    const stop = studio.onContextChange((next) => seen.push(next.theme));
    browser.deliver(browser.envelope({ type: 'context', context: { ...context, theme: 'light' } }));
    expect(studio.context.theme).toBe('light');
    stop();
    browser.deliver(browser.envelope({ type: 'context', context: { ...context, theme: 'dark' } }));
    expect(seen).toEqual(['light']);
    expect(studio.context.theme).toBe('dark');
  });

  it('reports its height once, or keeps reporting it', async () => {
    const studio = await connected();
    studio.resize(99.2);
    studio.resize(-5);
    studio.resize(1e9);
    const heights = () => browser.posted.filter((entry) => entry.message.type === 'resize').map((entry) => entry.message.height);
    expect(heights()).toEqual([100, 0, 20000]);

    let observed: (() => void) | null = null;
    let disconnected = false;
    globals.ResizeObserver = class {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    };
    const stop = studio.resize();
    expect(heights().at(-1)).toBe(124);
    (globals.document as { documentElement: { scrollHeight: number } }).documentElement.scrollHeight = 300;
    observed!();
    expect(heights().at(-1)).toBe(300);
    stop();
    expect(disconnected).toBe(true);
  });

  it('rejects what is still waiting when it is closed', async () => {
    const studio = await connected();
    const request = studio.request('slow');
    studio.close();
    await expect(request).rejects.toMatchObject({ code: 'closed' });
    await expect(studio.request('after')).rejects.toMatchObject({ code: 'closed' });
    expect(browser.listeners.size).toBe(0);
  });
});
