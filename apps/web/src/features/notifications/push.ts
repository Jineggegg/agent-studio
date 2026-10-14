/**
 * Web Push on this device: what the browser can do, what state the device is
 * in, and the few browser calls that change it. Everything that decides is a
 * pure function of plain facts, so every state can be tested without a browser.
 *
 * The facts come from three places:
 *  - the browser's capabilities (is there a push API at all, is this an
 *    iPhone outside its home-screen app, is the address secure);
 *  - the browser's answers (the permission, and the subscription it holds);
 *  - the server's answers (whether it knows this browser's subscription, and
 *    whether the account's Web Push switch is on).
 */

export type NotificationPermissionState = 'default' | 'granted' | 'denied';

export interface BrowserPush {
  /** A service worker, the push manager and notifications all exist. */
  api: boolean;
  /** Push needs a secure context (https, or localhost). A plain-http address on a LAN has none. */
  secure: boolean;
  /** iPhone, iPad or iPod — including an iPad that presents itself as a Mac. */
  ios: boolean;
  /** Opened from the home screen as an installed app. */
  standalone: boolean;
  permission: NotificationPermissionState;
}

export interface DeviceFacts {
  /** The app's service worker is registered and running: null while still finding out. */
  worker: boolean | null;
  /** This browser holds a push subscription. */
  subscribed: boolean;
}

export interface ServerFacts {
  /** The server lists this browser's subscription among the account's devices. */
  registered: boolean;
  /** The account's Web Push switch. */
  enabled: boolean;
}

/**
 * The one state this device is in, each with at most one fixing action:
 *
 * `unsupported`     no push here (`no-api`: the browser has none; `insecure`: the address is not https;
 *                   `no-worker`: the app's background worker is not running)                  — no action
 * `needs-install`   an iPhone or iPad outside the home-screen app                              — no action, instructions
 * `denied`          the person blocked notifications for this site                             — no action, instructions
 * `not-asked`       permission never asked                                                     — Enable
 * `not-subscribed`  permission given, but this browser is not registered with the account      — Enable on this device
 * `channel-off`     registered, but the account's Web Push switch is off                       — Turn back on
 * `on`              registered and switched on                                                 — Send a test
 * `checking`        the facts are still being read                                             — no action
 */
export type PushState =
  | { kind: 'unsupported'; reason: 'no-api' | 'insecure' | 'no-worker' }
  | { kind: 'needs-install' }
  | { kind: 'denied' }
  | { kind: 'not-asked' }
  | { kind: 'not-subscribed' }
  | { kind: 'channel-off' }
  | { kind: 'on' }
  | { kind: 'checking' };

export type PushAction = 'enable' | 'enable-device' | 'turn-on' | 'test' | null;

/** Decides the device's state. `device` or `server` is null while it is being read. */
export function decidePushState(browser: BrowserPush, device: DeviceFacts | null, server: ServerFacts | null): PushState {
  // Safari on an iPhone has no push API at all outside the installed app: say how to get one, not "unsupported".
  if (browser.ios && !browser.standalone) return { kind: 'needs-install' };
  if (!browser.secure) return { kind: 'unsupported', reason: 'insecure' };
  if (!browser.api) return { kind: 'unsupported', reason: 'no-api' };
  if (browser.permission === 'denied') return { kind: 'denied' };
  if (device === null || device.worker === null) return { kind: 'checking' };
  if (!device.worker) return { kind: 'unsupported', reason: 'no-worker' };
  if (device.subscribed && browser.permission === 'granted') {
    if (server === null) return { kind: 'checking' };
    if (server.registered) return server.enabled ? { kind: 'on' } : { kind: 'channel-off' };
  }
  return browser.permission === 'granted' ? { kind: 'not-subscribed' } : { kind: 'not-asked' };
}

/** The one action a state offers, or null. */
export function pushActionFor(state: PushState): PushAction {
  switch (state.kind) {
    case 'not-asked':
      return 'enable';
    case 'not-subscribed':
      return 'enable-device';
    case 'channel-off':
      return 'turn-on';
    case 'on':
      return 'test';
    default:
      return null;
  }
}

// ---- reading the browser ---------------------------------------------------------------

/** An iPhone, iPad or iPod. iPadOS asks for desktop sites and says "Macintosh", but has a touch screen. */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function detectBrowserPush(): BrowserPush {
  if (typeof window === 'undefined') return { api: false, secure: false, ios: false, standalone: false, permission: 'default' };
  const nav = navigator as Navigator & { standalone?: boolean };
  const api = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
  const permission: NotificationPermissionState = 'Notification' in window ? (Notification.permission as NotificationPermissionState) : 'default';
  return { api, secure: window.isSecureContext === true, ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0), standalone, permission };
}

// ---- small conversions ------------------------------------------------------------------

/** Lower-case hex SHA-256 of a subscription's endpoint: how the server recognises "this device" without the endpoint itself. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The server's application key (base64url, no padding) as the bytes `PushManager.subscribe` wants. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** Whether a subscription was made with this application key. A subscription made with another key cannot be reused. */
export function sameKey(existing: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!existing) return false;
  const wanted = applicationServerKey(publicKey);
  const have = new Uint8Array(existing);
  return have.length === wanted.length && have.every((byte, index) => byte === wanted[index]);
}

// ---- the browser's subscription -----------------------------------------------------------

/** The app's service worker registration, waiting a little for one that is still starting. Null when there is none. */
export async function workerRegistration(waitMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return existing;
    const ready = navigator.serviceWorker.ready;
    const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), waitMs));
    return (await Promise.race([ready, timeout])) ?? existing ?? null;
  } catch {
    return null;
  }
}

export async function currentSubscription(registration: ServiceWorkerRegistration | null): Promise<PushSubscription | null> {
  if (!registration?.pushManager) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** What `PushSubscription.toJSON()` gives, in the shape the server takes. */
export interface SubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export function subscriptionJson(subscription: PushSubscription): SubscriptionJson | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth }, expirationTime: json.expirationTime ?? null };
}

/**
 * Subscribes this browser with the server's key. An existing subscription
 * made with the same key is reused; one made with another key is replaced.
 */
export async function subscribeBrowser(registration: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  const existing = await currentSubscription(registration);
  if (existing && sameKey(existing.options.applicationServerKey, publicKey)) return existing;
  if (existing) await existing.unsubscribe().catch(() => false);
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
}

// ---- whose subscription this browser holds --------------------------------------------------

const OWNER_KEY = 'studio.notifications.pushOwner';

/**
 * The account this browser's subscription was made for. After a sign-out the
 * same person may re-register it silently; somebody else signing in on this
 * browser must turn notifications on themselves.
 */
export function rememberPushOwner(userId: string | null): void {
  try {
    if (userId === null) window.localStorage.removeItem(OWNER_KEY);
    else window.localStorage.setItem(OWNER_KEY, userId);
  } catch {
    /* this browser will simply not re-register by itself */
  }
}

export function pushOwner(): string | null {
  try {
    return window.localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}
