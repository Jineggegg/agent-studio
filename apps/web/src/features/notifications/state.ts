import { INBOX_EVENT, type NotificationSettings, type PushTestResult, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOnReconnect, useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { notificationKeys, notificationsApi } from './api';
import {
  type BrowserPush,
  type PushState,
  currentSubscription,
  decidePushState,
  detectBrowserPush,
  endpointHash,
  rememberPushOwner,
  subscribeBrowser,
  subscriptionJson,
  workerRegistration,
} from './push';

/** What this browser holds, read from the browser itself. */
export interface PushDevice {
  browser: BrowserPush;
  /** The app's service worker is running; null until known. */
  worker: boolean | null;
  endpoint: string | null;
  /** SHA-256 of the endpoint, as the server expects it to recognise "this device". */
  hash: string | null;
  /** Everything above has been read at least once. */
  read: boolean;
}

const INITIAL: PushDevice = { browser: detectBrowserPush(), worker: null, endpoint: null, hash: null, read: false };

async function readDevice(): Promise<PushDevice> {
  const browser = detectBrowserPush();
  if (!browser.api || !browser.secure || (browser.ios && !browser.standalone)) return { browser, worker: false, endpoint: null, hash: null, read: true };
  const registration = await workerRegistration(2500);
  const subscription = await currentSubscription(registration);
  const endpoint = subscription?.endpoint ?? null;
  const hash = endpoint ? await endpointHash(endpoint).catch(() => null) : null;
  return { browser, worker: registration !== null, endpoint, hash, read: true };
}

/**
 * The browser's side of push for this device, read on arrival and again
 * whenever the page comes back to the front — the permission may have been
 * changed in the browser's or the system's settings meanwhile.
 */
export function usePushDevice(): { device: PushDevice; refresh: () => Promise<PushDevice> } {
  const [device, setDevice] = useState<PushDevice>(INITIAL);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const next = await readDevice();
    if (alive.current) setDevice(next);
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // Where the browser can say so, a permission changed elsewhere is noticed at once.
    let status: PermissionStatus | null = null;
    const onPermission = () => void refresh();
    navigator.permissions
      ?.query({ name: 'notifications' as PermissionName })
      .then((result) => {
        status = result;
        result.addEventListener('change', onPermission);
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      status?.removeEventListener('change', onPermission);
    };
  }, [refresh]);

  return { device, refresh };
}

/** Whether the server lists this browser's subscription. */
export function isRegistered(settings: NotificationSettings | undefined, hash: string | null): boolean {
  if (!settings || !hash) return false;
  return settings.push.devices.some((device) => device.current || (device.fingerprint.length >= 8 && device.fingerprint === hash.slice(0, device.fingerprint.length)));
}

export type EnableOutcome =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'dismissed' | 'no-worker' | 'subscribe-failed' | 'register-failed'; error?: unknown };

/**
 * Everything a screen needs to show and change push for this device: the
 * account's settings, the device's one state, and the actions that state
 * offers. Shared by the notification settings page and the automations tab.
 */
export function usePushSetup() {
  const user = useUser();
  const queryClient = useQueryClient();
  const { device, refresh } = usePushDevice();
  const settings = useQuery({
    queryKey: notificationKeys.settings(device.hash),
    queryFn: ({ signal }) => notificationsApi.settings(device.hash, signal),
    enabled: device.read,
    meta: { live: true },
  });

  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type === INBOX_EVENT.settingsChanged) void queryClient.invalidateQueries({ queryKey: ['notifications', 'settings'] });
  });
  useOnReconnect(() => void refresh());

  const registered = isRegistered(settings.data, device.hash);
  const state: PushState = useMemo(
    () =>
      decidePushState(
        device.browser,
        device.read ? { worker: device.worker, subscribed: device.endpoint !== null } : null,
        settings.data ? { registered, enabled: settings.data.push.enabled } : null,
      ),
    [device, settings.data, registered],
  );

  const store = useCallback(
    (next: NotificationSettings, hash: string | null) => {
      queryClient.setQueryData(notificationKeys.settings(hash), next);
    },
    [queryClient],
  );

  /** Asks for permission (straight from the tap), subscribes this browser and registers it with the account. */
  const enable = useCallback(async (): Promise<EnableOutcome> => {
    let permission = 'Notification' in window ? Notification.permission : 'denied';
    if (permission !== 'granted') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = Notification.permission;
      }
    }
    if (permission !== 'granted') {
      await refresh();
      return { ok: false, reason: permission === 'denied' ? 'denied' : 'dismissed' };
    }
    const registration = await workerRegistration();
    if (!registration) {
      await refresh();
      return { ok: false, reason: 'no-worker' };
    }
    let subscription: PushSubscription;
    try {
      const publicKey = settings.data?.push.publicKey ?? (await notificationsApi.publicKey()).publicKey;
      subscription = await subscribeBrowser(registration, publicKey);
    } catch (error) {
      await refresh();
      return { ok: false, reason: 'subscribe-failed', error };
    }
    const json = subscriptionJson(subscription);
    if (!json) return { ok: false, reason: 'subscribe-failed' };
    try {
      const answer = await notificationsApi.registerDevice(json, false);
      rememberPushOwner(user?.id ?? null);
      const next = await refresh();
      store(answer, next.hash);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'register-failed', error };
    }
  }, [refresh, settings.data, store, user?.id]);

  const turnOn = useCallback(async () => {
    store(await notificationsApi.updatePreferences({ channels: { webPush: true } }, device.hash), device.hash);
  }, [device.hash, store]);

  const test = useCallback(async (origin: 'settings' | 'automations'): Promise<PushTestResult> => {
    const result = await notificationsApi.test(origin, device.hash);
    void queryClient.invalidateQueries({ queryKey: ['notifications', 'settings'] });
    return result;
  }, [device.hash, queryClient]);

  /** Removes a device. Removing this one also ends the browser's subscription, so it does not come back by itself. */
  const removeDevice = useCallback(
    async (deviceId: string, current: boolean) => {
      const answer = await notificationsApi.removeDevice(deviceId, device.hash);
      if (current) {
        const registration = await workerRegistration(1000);
        const subscription = await currentSubscription(registration);
        await subscription?.unsubscribe().catch(() => false);
        rememberPushOwner(null);
      }
      const next = await refresh();
      store(answer, next.hash);
    },
    [device.hash, refresh, store],
  );

  return { device, settings, state, registered, enable, turnOn, test, removeDevice, refresh };
}

export type PushSetup = ReturnType<typeof usePushSetup>;

/**
 * After a sign-in: a browser that still holds the subscription it made for
 * this same account registers it again, silently (the server neither
 * announces it nor touches the Web Push switch). A subscription made for
 * somebody else is left alone — that person turns notifications on themselves.
 */
export async function reRegisterThisBrowser(userId: string, owner: string | null): Promise<void> {
  if (owner !== userId) return;
  const registration = await workerRegistration(6000);
  const subscription = await currentSubscription(registration);
  if (!subscription) return;
  const json = subscriptionJson(subscription);
  if (!json) return;
  const hash = await endpointHash(json.endpoint);
  const settings = await notificationsApi.settings(hash);
  if (isRegistered(settings, hash)) return;
  await notificationsApi.registerDevice(json, true);
}
