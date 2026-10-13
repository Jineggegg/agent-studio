import { safeInternalPath } from '@/shell/guard';

/**
 * The service worker: offline notice, cached static files, notifications.
 * Registered only in production builds — in development it would get in the
 * way of hot reloading and serve stale code.
 */
export function registerServiceWorker(navigateTo: (path: string) => void): void {
  if (!('serviceWorker' in navigator)) return;

  // A notification was tapped: the worker asks the open page to go there, in place.
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (!data || data.type !== 'navigate') return;
    navigateTo(safeNotificationPath(data.url));
  });

  if (!import.meta.env.PROD) return;
  const register = () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: 'none' }).catch(() => {
      /* no worker: the app works the same, minus the offline notice and notifications */
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** Where a notification may send the page: a path of this app, or its root. */
export function safeNotificationPath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\\')) return '/';
  if (value === '/') return '/';
  return safeInternalPath(value) ?? '/';
}

/**
 * Remove every file the browser has cached for the app (the worker's caches).
 * Resolves with how many caches were removed. Nothing on the server changes
 * and the session is untouched.
 */
export async function clearCachedFiles(): Promise<number> {
  if (!('caches' in window)) return 0;
  const names = await window.caches.keys();
  let removed = 0;
  for (const name of names) if (await window.caches.delete(name)) removed += 1;
  return removed;
}
