// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service worker is plain JavaScript with no build step, so it is tested
 * as it ships: the file is run in a sandbox that stands in for the worker
 * global, and its event handlers are driven by hand.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
const ORIGIN = 'https://studio.example';

type Handler = (event: Record<string, unknown>) => void;

function boot() {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const cacheFor = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const cache = {
      match: async (request: Request | string) =>
        store!.get(typeof request === 'string' ? new URL(request, ORIGIN).href : request.url),
      put: async (request: Request, response: Response) => void store!.set(request.url, response),
      add: async (request: Request) =>
        void store!.set(
          request.url,
          new Response('offline page', { headers: { 'content-type': 'text/html' } }),
        ),
      keys: async () => [...store!.keys()].map((url) => new Request(url)),
      delete: async (request: Request) => store!.delete(request.url),
    };
    return cache;
  };
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const windows: {
    url: string;
    focused: boolean;
    visibilityState: string;
    focus: () => Promise<void>;
    postMessage: (message: unknown) => void;
  }[] = [];

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { scope: `${ORIGIN}/`, showNotification },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined), matchAll: async () => windows, openWindow },
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  // In a worker, a relative address resolves against the worker's own location.
  class WorkerRequest extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init);
    }
  }
  vm.runInNewContext(SOURCE, {
    self,
    caches,
    fetch: fetchMock,
    URL,
    Request: WorkerRequest,
    Response,
    Promise,
    console,
  });

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    handlers.get(type)!({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      respondWith: (response: Promise<Response>) => {
        responded = Promise.resolve(response);
      },
    });
    await Promise.all(waits);
    return responded as Promise<Response> | null;
  };
  const fetchEvent = (path: string, init: { method?: string; mode?: string } = {}) =>
    dispatch('fetch', {
      request: {
        url: path.startsWith('http') ? path : ORIGIN + path,
        method: init.method ?? 'GET',
        mode: init.mode ?? 'cors',
        clone: () => ({}),
      },
    });

  return { dispatch, fetchEvent, fetchMock, stores, showNotification, openWindow, windows, self };
}

let worker: ReturnType<typeof boot>;
beforeEach(() => {
  worker = boot();
});

describe('the service worker: caching', () => {
  it('never touches data requests or the live connection', async () => {
    for (const path of ['/api/projects', '/api/realtime', '/api/auth/state', '/api']) {
      expect(await worker.fetchEvent(path), path).toBeNull();
    }
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it('leaves writes, other origins and unversioned files to the network', async () => {
    expect(await worker.fetchEvent('/assets/app-abc123.js', { method: 'POST' })).toBeNull();
    expect(await worker.fetchEvent('https://elsewhere.example/assets/x.js')).toBeNull();
    for (const path of [
      '/version.json',
      '/manifest.webmanifest',
      '/sw.js',
      '/boot.js',
      '/icons/icon-192.png',
    ]) {
      expect(await worker.fetchEvent(path), path).toBeNull();
    }
  });

  it('always takes pages from the network, so a new build is seen at once', async () => {
    worker.fetchMock
      .mockResolvedValueOnce(new Response('build 1'))
      .mockResolvedValueOnce(new Response('build 2'));
    const first = await (await worker.fetchEvent('/', { mode: 'navigate' }))!;
    const second = await (await worker.fetchEvent('/', { mode: 'navigate' }))!;
    expect(await first.text()).toBe('build 1');
    expect(await second.text()).toBe('build 2');
    expect(worker.fetchMock).toHaveBeenCalledTimes(2);
    // nothing about the page was stored
    expect([...worker.stores.values()].flatMap((store) => [...store.keys()])).toEqual([]);
  });

  it('shows a minimal offline notice when a navigation has no network', async () => {
    await worker.dispatch('install', {});
    worker.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const response = await (await worker.fetchEvent('/settings/account', { mode: 'navigate' }))!;
    expect(await response.text()).toBe('offline page');
  });

  it('serves a versioned file from cache after its first successful load', async () => {
    const response = new Response('console.log(1)', { status: 200 });
    Object.defineProperty(response, 'type', { value: 'basic' });
    worker.fetchMock.mockResolvedValueOnce(response);
    await (await worker.fetchEvent('/assets/app-abc123.js'))!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const again = await (await worker.fetchEvent('/assets/app-abc123.js'))!;
    expect(await again.text()).toBe('console.log(1)');
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never stores an error response, so a later fetch goes to the network again', async () => {
    const failure = new Response('nope', { status: 503 });
    Object.defineProperty(failure, 'type', { value: 'basic' });
    const success = new Response('ok now', { status: 200 });
    Object.defineProperty(success, 'type', { value: 'basic' });
    worker.fetchMock.mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
    expect((await (await worker.fetchEvent('/assets/chunk-1.js'))!).status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await (await worker.fetchEvent('/assets/chunk-1.js'))!).text()).toBe('ok now');
    expect(worker.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('takes over at once, removes caches of older versions, and clears everything when asked', async () => {
    worker.stores.set('studio-assets-v0', new Map());
    worker.stores.set('unrelated-cache', new Map());
    await worker.dispatch('install', {});
    expect(worker.self.skipWaiting).toHaveBeenCalled();
    await worker.dispatch('activate', {});
    expect(worker.self.clients.claim).toHaveBeenCalled();
    expect([...worker.stores.keys()].sort()).toEqual(['studio-offline-v1', 'unrelated-cache']);

    const reply = vi.fn();
    await worker.dispatch('message', {
      origin: 'https://elsewhere.example',
      data: { type: 'clear-caches' },
      ports: [{ postMessage: reply }],
    });
    expect(worker.stores.size).toBe(2); // not from one of our pages: ignored
    await worker.dispatch('message', {
      origin: ORIGIN,
      data: { type: 'clear-caches' },
      ports: [{ postMessage: reply }],
    });
    expect([...worker.stores.keys()]).toEqual([]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ type: 'caches-cleared', removed: 2 });
  });
});

describe('the service worker: notifications', () => {
  const push = (payload: unknown) =>
    worker.dispatch('push', { data: { json: () => payload, text: () => String(payload) } });
  const click = (url: unknown) =>
    worker.dispatch('notificationclick', { notification: { close: vi.fn(), data: { url } } });

  it('shows a notification from the JSON payload; the same tag replaces the earlier one', async () => {
    await push({
      title: 'Run finished',
      body: 'agent-studio · tests pass',
      tag: 'session:abc',
      url: '/workbench/abc',
    });
    expect(worker.showNotification).toHaveBeenCalledWith(
      'Run finished',
      expect.objectContaining({
        body: 'agent-studio · tests pass',
        tag: 'session:abc',
        renotify: true,
        data: { url: '/workbench/abc' },
      }),
    );
  });

  it('copes with a payload that is missing, malformed or hostile', async () => {
    await worker.dispatch('push', { data: null });
    expect(worker.showNotification).toHaveBeenLastCalledWith(
      'Cloud Harness',
      expect.objectContaining({ body: '', data: { url: '/' } }),
    );

    await worker.dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('not json');
        },
        text: () => 'plain text',
      },
    });
    expect(worker.showNotification).toHaveBeenLastCalledWith(
      'Cloud Harness',
      expect.objectContaining({ body: 'plain text' }),
    );

    await push({ title: 'a\u0000b\nc', body: 42, url: 'https://evil.example/phish' });
    expect(worker.showNotification).toHaveBeenLastCalledWith(
      'a b c',
      expect.objectContaining({ body: '', data: { url: '/' } }),
    );
  });

  it('shows what the server sends exactly, within its limits, and never splits a character', async () => {
    // The server sends at most 80 characters of title and 240 of body (NOTIFICATION_LIMITS): with emoji
    // that is up to 160 and 480 UTF-16 units, which must still be shown whole.
    const title = '🚀'.repeat(80);
    const body = `${'进度'.repeat(100)}${'✅'.repeat(40)}`;
    await push({
      title,
      body,
      tag: 'reply-finished:01jabcdefghjkmnpqrstvwxyz0',
      url: '/projects/01jabcdefghjkmnpqrstvwxyz1/sessions/01jabcdefghjkmnpqrstvwxyz2',
    });
    expect(worker.showNotification).toHaveBeenLastCalledWith(
      title,
      expect.objectContaining({
        body,
        tag: 'reply-finished:01jabcdefghjkmnpqrstvwxyz0',
        data: { url: '/projects/01jabcdefghjkmnpqrstvwxyz1/sessions/01jabcdefghjkmnpqrstvwxyz2' },
      }),
    );

    // Something longer than any server sends is cut by characters: no half of a surrogate pair is left behind.
    await push({ title: '😀'.repeat(200), body: 'x' });
    const shown = (worker.showNotification.mock.calls.at(-1) as unknown[])[0] as string;
    expect(Array.from(shown)).toHaveLength(120);
    expect(shown).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('opens only same-origin paths; anything else opens the root', async () => {
    const cases: [unknown, string][] = [
      ['/inbox', '/inbox'],
      ['/projects/p1/chat?session=s1#latest', '/projects/p1/chat?session=s1#latest'],
      ['https://evil.example/phish', '/'],
      ['https://studio.example/inbox', '/'], // even our own origin must come as a path
      ['//evil.example/x', '/'],
      ['/\\evil.example', '/'],
      ['javascript:alert(1)', '/'],
      ['inbox', '/'],
      ['/a\nb', '/'],
      [undefined, '/'],
      [{ href: '/inbox' }, '/'],
    ];
    for (const [given, expected] of cases) {
      worker.openWindow.mockClear();
      await click(given);
      expect(worker.openWindow, String(given)).toHaveBeenCalledWith(expected);
    }
  });

  it('focuses an open window and navigates it in place instead of opening another', async () => {
    const focus = vi.fn(async () => undefined);
    const postMessage = vi.fn();
    worker.windows.push({
      url: `${ORIGIN}/settings`,
      focused: false,
      visibilityState: 'visible',
      focus,
      postMessage,
    });
    await click('/inbox');
    expect(focus).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'navigate', url: '/inbox' });
    expect(worker.openWindow).not.toHaveBeenCalled();

    await click('https://evil.example');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'navigate', url: '/' });
  });
});
