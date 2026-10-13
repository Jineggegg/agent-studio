/*
 * Agent Studio service worker. Plain JavaScript, no build step; served with
 * `cache-control: no-cache` so a new version is picked up on the next visit.
 *
 * What it does, and — more importantly — what it never does:
 *
 *  - Pages (navigations) always come from the network. When there is none, a
 *    small offline notice is shown instead of the browser's error page.
 *  - Anything under /api/ — data and the live connection — is never touched:
 *    no signed-in content is ever stored in a cache.
 *  - Fingerprinted static files (/assets/…, unique name per build) are
 *    served cache-first and stored only after a complete, successful,
 *    same-origin response. An error response is never stored.
 *  - Push messages become notifications; tapping one focuses an open window
 *    (or opens one) on a same-origin path — never on anything else.
 */

const VERSION = 'v1';
const ASSET_CACHE = `studio-assets-${VERSION}`;
const OFFLINE_CACHE = `studio-offline-${VERSION}`;
const KEEP = new Set([ASSET_CACHE, OFFLINE_CACHE]);
const MAX_ASSETS = 300;

/** The app's base path ("/" unless it is served under a prefix). */
const BASE = new URL(self.registration.scope).pathname;
const OFFLINE_URL = `${BASE}offline.html`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .catch(() => undefined)
      // Activate at once: there is no old logic worth keeping alive.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('studio-') && !KEEP.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  // Insertion order: the oldest entries are first.
  for (let index = 0; index < keys.length - MAX_ASSETS; index += 1) await cache.delete(keys[index]);
}

async function assetFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Only a whole, successful, same-origin answer is worth keeping.
  if (response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    cache
      .put(request, copy)
      .then(() => trim(cache))
      .catch(() => undefined);
  }
  return response;
}

async function pageFromNetwork(request) {
  try {
    return await fetch(request);
  } catch (_error) {
    const cache = await caches.open(OFFLINE_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    return (
      offline ||
      new Response('Offline. Check your connection and try again.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;
  const path = `/${url.pathname.slice(BASE.length)}`;

  // Data and live connections are none of this worker's business.
  if (path === '/api' || path.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(pageFromNetwork(request));
    return;
  }
  if (path.startsWith('/assets/')) {
    event.respondWith(assetFirst(request));
    return;
  }
  // Everything else (icons, the manifest, version.json, this file) goes to the network untouched.
});

// ---- notifications -----------------------------------------------------------

/** One line of plain text: no control characters, bounded length. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/**
 * The only thing a notification may open: a path on this origin. Anything
 * else — another site, a scheme, a protocol-relative address — opens the app's
 * root instead.
 */
function safePath(value) {
  if (typeof value !== 'string' || value.length > 2000) return BASE;
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return BASE;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return BASE;
    return url.pathname + url.search + url.hash;
  } catch (_error) {
    return BASE;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = { body: event.data ? event.data.text() : '' };
  }
  if (payload === null || typeof payload !== 'object') payload = {};
  const title = clean(payload.title, 120) || 'Agent Studio';
  const tag = clean(payload.tag, 120);
  event.waitUntil(
    self.registration.showNotification(title, {
      body: clean(payload.body, 400),
      // A later notification with the same tag replaces the earlier one.
      ...(tag ? { tag, renotify: true } : {}),
      data: { url: safePath(payload.url) },
      icon: `${BASE}icons/icon-192.png`,
      badge: `${BASE}icons/badge-96.png`,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const inScope = windows.filter((client) => new URL(client.url).pathname.startsWith(BASE));
      const client = inScope.find((item) => item.focused) || inScope.find((item) => item.visibilityState === 'visible') || inScope[0];
      if (client) {
        try {
          await client.focus();
        } catch (_error) {
          /* focusing can be refused; navigating still helps */
        }
        // The page moves there itself, in place, without reloading.
        client.postMessage({ type: 'navigate', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// ---- messages from the page ----------------------------------------------------

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'clear-caches') {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        let removed = 0;
        for (const name of names) if (await caches.delete(name)) removed += 1;
        const reply = { type: 'caches-cleared', removed };
        if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
        else if (event.source) event.source.postMessage(reply);
      })(),
    );
  } else if (data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});
