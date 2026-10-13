import {
  INBOX_EVENT,
  NOTIFICATION_LIMITS,
  type NotificationSettings,
  acknowledgeRequestSchema,
  acknowledgeResultsRequestSchema,
  clearNotificationsRequestSchema,
  idSchema,
  listNotificationsQuerySchema,
  markNotificationsReadRequestSchema,
  notificationSettingsQuerySchema,
  pushSubscribeRequestSchema,
  pushTestRequestSchema,
  pushUnsubscribeRequestSchema,
  updateNotificationPreferencesRequestSchema,
  userTopic,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { conflict } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { NotificationCenter } from './center.js';
import { deviceAddedContent } from './content.js';
import type { RunEventNotifier } from './events.js';
import type { NotificationSwitches } from './preferences.js';
import type { PushChannel } from './push.js';
import type { TaskInbox } from './tasks.js';

const notificationParams = z.object({ notificationId: idSchema });
const deviceParams = z.object({ deviceId: idSchema });
const empty = z.strictObject({});

export function registerInboxRoutes(
  context: ModuleContext,
  deps: { center: NotificationCenter; push: PushChannel; tasks: TaskInbox; switches: NotificationSwitches; notifier: RunEventNotifier },
): void {
  const { http } = context;
  const { center, push, tasks, switches, notifier } = deps;

  const settings = (userId: string, currentHash: string | null): NotificationSettings => {
    const preferences = switches.read(userId);
    const devices = push.list(userId, currentHash);
    return {
      preferences,
      push: {
        publicKey: push.publicKey(),
        enabled: preferences.channels.webPush,
        active: preferences.channels.webPush && devices.length > 0,
        devices,
        maxDevices: NOTIFICATION_LIMITS.devicesPerUser,
      },
      channels: [
        { id: 'inApp', configured: true, enabled: preferences.channels.inApp },
        { id: 'webPush', configured: devices.length > 0, enabled: preferences.channels.webPush },
      ],
    };
  };

  // ---- the task inbox ---------------------------------------------------------

  http.route({ method: 'GET', url: '/api/inbox', access: 'user', handler: ({ user }) => tasks.read(user) });
  http.route({ method: 'GET', url: '/api/inbox/summary', access: 'user', handler: ({ user }) => tasks.summary(user) });

  http.route({
    method: 'POST',
    url: '/api/inbox/acknowledge',
    access: 'user',
    body: acknowledgeRequestSchema,
    handler: ({ user, body }) => {
      const result = tasks.acknowledge(user, body.runId);
      notifier.acknowledged(user.userId);
      return result;
    },
  });

  http.route({
    method: 'POST',
    url: '/api/inbox/acknowledge-results',
    access: 'user',
    body: acknowledgeResultsRequestSchema,
    handler: ({ user, body }) => {
      const acknowledged = tasks.acknowledgeResults(user, body.runIds);
      if (acknowledged > 0) notifier.acknowledged(user.userId);
      return { acknowledged };
    },
  });

  // ---- stored notifications ---------------------------------------------------

  http.route({
    method: 'GET',
    url: '/api/notifications',
    access: 'user',
    query: listNotificationsQuerySchema,
    handler: ({ user, query }) => center.list(user, query),
  });

  http.route({ method: 'GET', url: '/api/notifications/unread', access: 'user', handler: ({ user }) => ({ unread: center.unread(user.userId) }) });

  http.route({
    method: 'POST',
    url: '/api/notifications/read-all',
    access: 'user',
    body: markNotificationsReadRequestSchema,
    handler: ({ user, body }) => center.markAllRead(user.userId, body.sessionId),
  });

  http.route({
    method: 'POST',
    url: '/api/notifications/clear',
    access: 'user',
    body: clearNotificationsRequestSchema,
    handler: ({ user, body }) => center.clear(user.userId, body.scope),
  });

  http.route({
    method: 'POST',
    url: '/api/notifications/:notificationId/read',
    access: 'user',
    params: notificationParams,
    body: empty,
    handler: ({ user, params }) => center.markRead(user, params.notificationId),
  });

  http.route({
    method: 'DELETE',
    url: '/api/notifications/:notificationId',
    access: 'user',
    params: notificationParams,
    handler: ({ user, params }) => center.remove(user, params.notificationId),
  });

  // ---- settings: switches and devices ------------------------------------------

  http.route({
    method: 'GET',
    url: '/api/notifications/settings',
    access: 'user',
    query: notificationSettingsQuerySchema,
    handler: ({ user, query }) => settings(user.userId, query.device ?? null),
  });

  http.route({
    method: 'PATCH',
    url: '/api/notifications/preferences',
    access: 'user',
    query: notificationSettingsQuerySchema,
    body: updateNotificationPreferencesRequestSchema,
    handler: ({ user, body, query, request }) => {
      // The Web Push switch means something only with a device to push to.
      if (body.channels?.webPush === true && push.devices.count(user.userId) === 0) {
        throw conflict('Enable notifications on a device first.', 'no_devices');
      }
      switches.update(user.userId, body);
      switches.noteBrowserLanguage(user.userId, request.headers['accept-language']);
      context.bus.publish(userTopic(user.userId), INBOX_EVENT.settingsChanged, { reason: 'preferences' });
      return settings(user.userId, query.device ?? null);
    },
  });

  // The key a browser subscribes with. The private half never leaves the server.
  http.route({ method: 'GET', url: '/api/notifications/push/key', access: 'user', handler: () => ({ publicKey: push.publicKey() }) });

  http.route({
    method: 'POST',
    url: '/api/notifications/push/devices',
    access: 'user',
    // A subscription belongs to a browser sign-in and ends with it; an API token has no browser.
    sessionOnly: true,
    body: pushSubscribeRequestSchema,
    bodyLimit: 16 * 1024,
    handler: ({ user, body, request }) => {
      switches.noteBrowserLanguage(user.userId, request.headers['accept-language']);
      const { device, announce } = push.subscribe(user, body, { userAgent: request.headers['user-agent'] ?? null, ip: request.ip });
      if (announce) {
        // Said on every device of the account, the new one included: nobody is added as a silent listener.
        const raised = center.raise(user.userId, deviceAddedContent(switches.language(user.userId), device.label));
        if (raised.push) void raised.push.catch(() => undefined);
      }
      return settings(user.userId, device.endpoint_hash);
    },
  });

  http.route({
    method: 'DELETE',
    url: '/api/notifications/push/devices/:deviceId',
    access: 'user',
    params: deviceParams,
    query: notificationSettingsQuerySchema,
    handler: ({ user, params, query }) => {
      push.remove(user.userId, params.deviceId);
      return settings(user.userId, query.device ?? null);
    },
  });

  // The browser unsubscribed itself and says so by endpoint. Somebody else's endpoint changes nothing.
  http.route({
    method: 'POST',
    url: '/api/notifications/push/unsubscribe',
    access: 'user',
    sessionOnly: true,
    body: pushUnsubscribeRequestSchema,
    bodyLimit: 16 * 1024,
    handler: ({ user, body }) => {
      push.unsubscribe(user.userId, body.endpoint);
      return settings(user.userId, null);
    },
  });

  http.route({
    method: 'POST',
    url: '/api/notifications/push/test',
    access: 'user',
    body: pushTestRequestSchema,
    handler: ({ user, body }) => push.test(user, body.origin, body.device ?? null),
  });
}
