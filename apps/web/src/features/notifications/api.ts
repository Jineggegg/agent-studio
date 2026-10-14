import {
  type NotificationChannel,
  type NotificationEvent,
  type UpdateNotificationPreferencesRequest,
  notificationListSchema,
  notificationSettingsSchema,
  notificationsChangedResponseSchema,
  pushKeyResponseSchema,
  pushTestResultSchema,
  unreadCountSchema,
} from '@agent-studio/protocol';
import { api } from '@/data/api';
import type { SubscriptionJson } from './push';

/**
 * Every request about notifications: the account's switches and devices,
 * and the stored list the inbox shows. Each answer is validated against the
 * protocol's schema.
 */
const enc = encodeURIComponent;

export const notificationKeys = {
  all: ['notifications'] as const,
  settings: (device: string | null) => ['notifications', 'settings', device ?? 'none'] as const,
  list: ['notifications', 'list'] as const,
  unread: ['notifications', 'unread'] as const,
};

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export const notificationsApi = {
  settings: (device: string | null, signal?: AbortSignal) =>
    api.get('/api/notifications/settings', { schema: notificationSettingsSchema, query: { device: device ?? undefined }, ...withSignal(signal) }),
  updatePreferences: (patch: UpdateNotificationPreferencesRequest, device: string | null) =>
    api.patch('/api/notifications/preferences', patch, { schema: notificationSettingsSchema, query: { device: device ?? undefined } }),
  publicKey: () => api.get('/api/notifications/push/key', { schema: pushKeyResponseSchema }),
  registerDevice: (subscription: SubscriptionJson, resubscribe: boolean) =>
    api.post('/api/notifications/push/devices', { ...subscription, resubscribe }, { schema: notificationSettingsSchema }),
  removeDevice: (deviceId: string, device: string | null) =>
    api.delete(`/api/notifications/push/devices/${enc(deviceId)}`, { schema: notificationSettingsSchema, query: { device: device ?? undefined } }),
  unsubscribe: (endpoint: string) => api.post('/api/notifications/push/unsubscribe', { endpoint }, { schema: notificationSettingsSchema }),
  test: (origin: 'settings' | 'automations', device: string | null) =>
    api.post('/api/notifications/push/test', { origin, ...(device ? { device } : {}) }, { schema: pushTestResultSchema, timeoutMs: 30_000 }),

  // ---- the stored list -------------------------------------------------------------------
  list: (offset: number, limit: number, signal?: AbortSignal) =>
    api.get('/api/notifications', { schema: notificationListSchema, query: { order: 'unread-first', unread: 'include', limit, offset }, ...withSignal(signal) }),
  unread: (signal?: AbortSignal) => api.get('/api/notifications/unread', { schema: unreadCountSchema, ...withSignal(signal) }),
  markRead: (notificationId: string) => api.post(`/api/notifications/${enc(notificationId)}/read`, {}, { schema: notificationsChangedResponseSchema }),
  markAllRead: () => api.post('/api/notifications/read-all', {}, { schema: notificationsChangedResponseSchema }),
  clear: (scope: 'read' | 'all') => api.post('/api/notifications/clear', { scope }, { schema: notificationsChangedResponseSchema }),
  remove: (notificationId: string) => api.delete(`/api/notifications/${enc(notificationId)}`, { schema: notificationsChangedResponseSchema }),
};

/** One switch, as a patch that names nothing else — so turning one on never moves another. */
export function eventPatch(event: NotificationEvent, on: boolean): UpdateNotificationPreferencesRequest {
  return { events: { [event]: on } };
}

export function channelPatch(channel: NotificationChannel, on: boolean): UpdateNotificationPreferencesRequest {
  return { channels: { [channel]: on } };
}

export function detailsPatch(on: boolean): UpdateNotificationPreferencesRequest {
  return { showDetails: on };
}
