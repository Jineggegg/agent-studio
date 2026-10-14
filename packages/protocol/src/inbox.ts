import { z } from 'zod';
import { approvalKindSchema, runStatusSchema } from './agents.js';
import { idSchema, limitQuery, timestampSchema } from './common.js';

/**
 * The task inbox, notifications and Web Push.
 *
 * Three things that are easy to mix up:
 *
 * - The **task inbox** (`GET /api/inbox`) is a live view of the caller's runs:
 *   what waits for an answer, what failed, which results are unread, what is
 *   still running. Nothing is copied: every read asks the agent runtime.
 *   Acknowledging an item marks it read or handled and never approves, runs
 *   or continues anything — that happens in the session.
 * - A **notification** is a stored line saying that something happened, with
 *   a link into the app. It is raised from server events, per user, and only
 *   when that user's switch for the event is on.
 * - **Web Push** is one channel a notification can travel through. What it
 *   carries is deliberately less than what the app shows (see
 *   `showDetails`), because it appears on a lock screen.
 *
 * Live updates arrive on the caller's `user:<id>` topic as {@link InboxEvent}s.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const INBOX_LIMITS = {
  /** A finished result older than this is no longer listed (it stays in its session). */
  resultMaxAgeMs: 72 * 60 * 60 * 1000,
  approvals: 100,
  needsHandling: 100,
  results: 50,
  running: 50,
  /** Run ids one "mark all read" may name. */
  acknowledgeMany: 100,
  titleChars: 90,
  previewChars: 240,
  errorChars: 240,
  toolNameChars: 100,
} as const;

export const NOTIFICATION_LIMITS = {
  titleChars: 80,
  bodyChars: 240,
  /** The optional one-line summary shown in the app, and in a push only when the user asked for details. */
  detailChars: 160,
  /** Same bound as the service worker applies before it opens anything. */
  linkChars: 2000,
  /** Stored notifications kept per user; older ones are removed. */
  perUser: 200,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  listDefault: 30,
  listMax: 100,
  devicesPerUser: 10,
  deviceLabelChars: 40,
  /** The same event for the same session is raised once within this window. */
  dedupeWindowMs: 20_000,
  /** Web Push messages one user may be sent per minute; the excess is dropped, not queued. */
  pushPerMinute: 30,
  /** Test notifications: one per this many milliseconds, and at most `testsPerHour`. */
  testIntervalMs: 10_000,
  testsPerHour: 12,
} as const;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * A character class built from code-point ranges. The characters this file
 * filters out are invisible ones; naming them by number keeps them out of the
 * source text itself.
 */
export function characterClass(ranges: ReadonlyArray<readonly [number, number]>, flags = ''): RegExp {
  const hex = (point: number) => `\\u{${point.toString(16)}}`;
  return new RegExp(`[${ranges.map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`)).join('')}]`, `u${flags}`);
}

/** C0 and C1 controls, DEL, and the two Unicode line separators. */
const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
];
/** Embeddings, overrides, isolates and marks that change the direction of the text around them. */
const DIRECTION_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0x200e, 0x200f],
  [0x061c, 0x061c],
];

/** Controls, any white space, and the backslash: none of them belongs in a link. */
const UNSAFE_LINK_CHARACTERS = characterClass([...CONTROL_RANGES, [0x20, 0x20], [0xa0, 0xa0], [0x5c, 0x5c]]);

/**
 * The only thing a notification may open: a path inside the app. Returns the
 * value when it is one, and `/` (the home screen) for anything else — a
 * scheme, another host, a protocol-relative address, a backslash, a control
 * character, a path that only becomes one of those once dot segments are
 * resolved, anything over-long, anything that is not a string.
 *
 * The same rule is applied where a notification is built (server), where it
 * is tapped (service worker) and where the app navigates.
 */
export function safeAppLink(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > NOTIFICATION_LIMITS.linkChars) return '/';
  if (value[0] !== '/' || value[1] === '/') return '/';
  if (UNSAFE_LINK_CHARACTERS.test(value)) return '/';
  const path = value.split(/[?#]/, 1)[0] ?? '';
  for (const segment of path.split('/').slice(1, path.endsWith('/') ? -1 : undefined)) {
    // An empty segment is a second slash; a dot segment (also when percent-encoded) moves the path about.
    const decoded = segment.replace(/%2e/gi, '.');
    if (segment === '' || decoded === '.' || decoded === '..') return '/';
  }
  return value;
}

/**
 * Where things live in the app. Every link in a notification or an inbox item
 * is built here, so the server and the client agree on the addresses.
 */
export const appLinks = {
  home: (): string => '/',
  inbox: (): string => '/inbox',
  notificationSettings: (): string => '/settings/notifications',
  project: (projectId: string): string => `/projects/${projectId}`,
  automations: (projectId: string): string => `/projects/${projectId}/automations`,
  /** A session's page in its project's workbench; a conversation outside any project has a page of its own. */
  session: (sessionId: string, projectId: string | null): string =>
    projectId === null ? `/sessions/${sessionId}` : `/projects/${projectId}/sessions/${sessionId}`,
} as const;

// ---------------------------------------------------------------------------
// Text that people typed and that ends up in a list or a notification
// ---------------------------------------------------------------------------

const LINE_BREAKS_AND_CONTROLS = new RegExp(`${characterClass(CONTROL_RANGES).source}+`, 'gu');
/** Characters that re-order the text around them; they can make a line read as something else. */
const DIRECTION_OVERRIDES = characterClass(DIRECTION_RANGES, 'g');

const MULTILINE_CONTROLS = characterClass(
  [
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x2028, 0x2029],
    ...DIRECTION_RANGES,
  ],
  'g',
);

/**
 * Removes what must never be stored from text that keeps its line breaks (a
 * prompt): control characters other than tab and line feed, and direction
 * overrides. Carriage returns go too, so line ends are uniform.
 */
export function stripControlCharacters(text: string): string {
  return text.replace(MULTILINE_CONTROLS, '');
}

/** One line of plain text: no control or direction-override characters, white space collapsed, cut to `max` code points. */
export function toOneLine(text: string, max: number): string {
  const line = text.replace(DIRECTION_OVERRIDES, '').replace(LINE_BREAKS_AND_CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(line);
  return points.length <= max ? line : points.slice(0, max).join('').trimEnd();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * What a notification is about.
 *
 * `needs-you`            an approval, a plan to confirm or a question is waiting
 * `reply-finished`       a turn the user started ended normally
 * `background-finished`  work nobody was watching (a deferred message, an automation's run) ended normally
 * `run-failed`           a run ended in an error, or could not start
 * `run-interrupted`      a run was cut short by a restart of the server
 * `automation`           an automation fired (its reminder, or what became of it)
 * `plugin`               a plugin asked to tell the user something
 * `system`               about notifications themselves: a device was added, a test
 */
export const notificationKindSchema = z.enum([
  'needs-you',
  'reply-finished',
  'background-finished',
  'run-failed',
  'run-interrupted',
  'automation',
  'plugin',
  'system',
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** The switches a user has. An event that is off is sent through no channel and is not stored. */
export const NOTIFICATION_EVENTS = ['needsYou', 'replyFinished', 'backgroundFinished', 'failure', 'automation', 'plugin'] as const;
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/** Which switch governs a kind. `system` has none: a new device always announces itself. */
export const NOTIFICATION_EVENT_OF_KIND: Readonly<Record<NotificationKind, NotificationEvent | null>> = {
  'needs-you': 'needsYou',
  'reply-finished': 'replyFinished',
  'background-finished': 'backgroundFinished',
  'run-failed': 'failure',
  'run-interrupted': 'failure',
  automation: 'automation',
  plugin: 'plugin',
  system: null,
};

/** `inApp`: the list inside the app. `webPush`: the user's subscribed devices. */
export const NOTIFICATION_CHANNELS = ['inApp', 'webPush'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

const eventSwitchesSchema = z.object({
  needsYou: z.boolean(),
  replyFinished: z.boolean(),
  backgroundFinished: z.boolean(),
  failure: z.boolean(),
  automation: z.boolean(),
  plugin: z.boolean(),
});
const channelSwitchesSchema = z.object({ inApp: z.boolean(), webPush: z.boolean() });

export const notificationPreferencesSchema = z.object({
  events: eventSwitchesSchema,
  channels: channelSwitchesSchema,
  /**
   * Off (the default): a push names the session or project and says which
   * assistant did what — nothing from the conversation. On: a push may add one
   * line of detail (the tool's request, the failure, the start of the prompt),
   * with anything that looks like a credential removed.
   */
  showDetails: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/**
 * A new account: every event on; the in-app list on; Web Push off until a
 * device subscribes; no details on the lock screen. The switches are
 * independent: each has its own default and none follows another.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  events: { needsYou: true, replyFinished: true, backgroundFinished: true, failure: true, automation: true, plugin: true },
  channels: { inApp: true, webPush: false },
  showDetails: false,
};

/**
 * Where the switches are kept in the account's preferences
 * (`GET /api/preferences`). Read and change them through
 * `/api/notifications/…`, which validates them and applies the rules about
 * devices; a value written directly that is not a boolean is ignored.
 */
export const NOTIFICATION_PREFERENCE_KEYS = {
  events: 'notifications.events',
  channels: 'notifications.channels',
  showDetails: 'notifications.showDetails',
  /** The language notifications are written in when `appearance.language` is not set: the browser's, noted when a device subscribes. */
  language: 'notifications.language',
} as const;

/** A partial update: only the switches sent are changed. */
export const updateNotificationPreferencesRequestSchema = z
  .strictObject({
    events: z.strictObject(eventSwitchesSchema.shape).partial().optional(),
    channels: z.strictObject(channelSwitchesSchema.shape).partial().optional(),
    showDetails: z.boolean().optional(),
  })
  .refine((value) => value.events !== undefined || value.channels !== undefined || value.showDetails !== undefined, {
    message: 'Nothing to change.',
  });
export type UpdateNotificationPreferencesRequest = z.infer<typeof updateNotificationPreferencesRequestSchema>;

export const notificationSchema = z.object({
  id: idSchema,
  kind: notificationKindSchema,
  title: z.string(),
  body: z.string(),
  /** One more line for the app's own list. Null when there is nothing to add. */
  detail: z.string().nullable(),
  /** A path inside the app, always starting with a single `/`. `/` when the target is gone. */
  link: z.string(),
  /** False when the session or project it was about can no longer be opened by the caller. */
  targetAvailable: z.boolean(),
  /** A newer notification with the same tag replaced any older one. */
  tag: z.string(),
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  projectId: idSchema.nullable(),
  createdAt: timestampSchema,
  readAt: timestampSchema.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const listNotificationsQuerySchema = z.object({
  /** `unread-first`: unread ones, newest first, then the rest. `newest`: by time only. */
  order: z.enum(['unread-first', 'newest']).default('unread-first'),
  unread: z.enum(['only', 'include']).default('include'),
  limit: limitQuery(NOTIFICATION_LIMITS.listDefault, NOTIFICATION_LIMITS.listMax),
  offset: z.coerce.number().int().min(0).max(NOTIFICATION_LIMITS.perUser).default(0),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationListSchema = z.object({
  notifications: z.array(notificationSchema),
  hasMore: z.boolean(),
  /** Unread notifications of the caller, whatever the page shows. */
  unread: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const unreadCountSchema = z.object({ unread: z.number().int().nonnegative() });
export type UnreadCount = z.infer<typeof unreadCountSchema>;

/** Everything, or only what is about one session. */
export const markNotificationsReadRequestSchema = z.strictObject({ sessionId: idSchema.optional() });
/** `read`: forget what has been read. `all`: forget everything. */
export const clearNotificationsRequestSchema = z.strictObject({ scope: z.enum(['read', 'all']).default('read') });
export const notificationsChangedResponseSchema = z.object({ changed: z.number().int().nonnegative(), unread: z.number().int().nonnegative() });
export type NotificationsChangedResponse = z.infer<typeof notificationsChangedResponseSchema>;

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

/** SHA-256 of a subscription's endpoint address, lower-case hex. The endpoint itself is never returned to a page. */
export const pushEndpointHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Not an endpoint hash.');

/** What a browser's `PushSubscription.toJSON()` gives, plus what the Studio wants to know. */
export const pushSubscribeRequestSchema = z.strictObject({
  endpoint: z.string().min(12).max(2000),
  keys: z.strictObject({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  /** Sent by browsers; not used. */
  expirationTime: z.number().nullable().optional(),
  /** A name for the device. Without one it is derived from the browser. */
  label: z.string().max(200).optional(),
  /**
   * The browser already had this subscription and registers it again after
   * signing in. If the endpoint is known for the account, nothing is announced
   * and no switch is touched; if it is not, it is treated as a new device.
   */
  resubscribe: z.boolean().default(false),
});
export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequestSchema>;

export const pushUnsubscribeRequestSchema = z.strictObject({ endpoint: z.string().min(12).max(2000) });

export const pushDeviceSchema = z.object({
  id: idSchema,
  label: z.string(),
  /** The first 16 characters of the endpoint hash, so a page can recognise its own row. */
  fingerprint: z.string(),
  /** True for the device whose endpoint hash the caller passed as `device`. */
  current: z.boolean(),
  createdAt: timestampSchema,
  /** When a push service last accepted a message for it. */
  lastDeliveredAt: timestampSchema.nullable(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

export const pushKeyResponseSchema = z.object({
  /** The application-server key to subscribe with (uncompressed P-256 point, base64url). Stable for the installation. */
  publicKey: z.string(),
});

export const notificationSettingsQuerySchema = z.object({ device: pushEndpointHashSchema.optional() });

export const notificationSettingsSchema = z.object({
  preferences: notificationPreferencesSchema,
  push: z.object({
    publicKey: z.string(),
    /** The Web Push switch as stored. */
    enabled: z.boolean(),
    /** The switch is on and at least one device is subscribed: pushes are really sent. */
    active: z.boolean(),
    devices: z.array(pushDeviceSchema),
    maxDevices: z.number().int().positive(),
  }),
  /** Per channel: whether it is set up (it has somewhere to deliver to) and whether it is switched on. */
  channels: z.array(z.object({ id: notificationChannelSchema, configured: z.boolean(), enabled: z.boolean() })),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/**
 * `sent`         the push service accepted the message
 * `gone`         the push service says the subscription no longer exists; it was removed
 * `rejected`     the push service refused the message (`httpStatus`)
 * `unreachable`  the push service could not be contacted
 * `signed-out`   the browser that subscribed is no longer signed in; the subscription was removed
 */
export const pushDeliveryOutcomeSchema = z.enum(['sent', 'gone', 'rejected', 'unreachable', 'signed-out']);
export type PushDeliveryOutcome = z.infer<typeof pushDeliveryOutcomeSchema>;

export const pushTestRequestSchema = z.strictObject({
  /** Where the test was started; decides what tapping it opens. */
  origin: z.enum(['settings', 'automations']).default('settings'),
  device: pushEndpointHashSchema.optional(),
});

export const pushTestResultSchema = z.object({
  /** At least one device's push service accepted the message. */
  ok: z.boolean(),
  /** The Web Push switch. A test is sent whether or not it is on. */
  enabled: z.boolean(),
  devices: z.array(
    z.object({
      id: idSchema,
      label: z.string(),
      current: z.boolean(),
      outcome: pushDeliveryOutcomeSchema,
      httpStatus: z.number().int().optional(),
      /** The subscription was deleted as a result. */
      removed: z.boolean(),
    }),
  ),
  sent: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type PushTestResult = z.infer<typeof pushTestResultSchema>;

/** The JSON a push message carries; exactly what the service worker reads. */
export const pushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  url: z.string(),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

// ---------------------------------------------------------------------------
// The task inbox
// ---------------------------------------------------------------------------

/**
 * `approval`        a live request waits for a decision — made in the session, never here
 * `needs-handling`  a failed or interrupted run that was neither continued nor dismissed
 * `result`          a finished run whose result has not been seen
 * `running`         a run in progress with nothing waiting
 */
export const inboxItemKindSchema = z.enum(['approval', 'needs-handling', 'result', 'running']);
export type InboxItemKind = z.infer<typeof inboxItemKindSchema>;

export const inboxItemSchema = z.object({
  /** Unique within one inbox. */
  id: z.string(),
  kind: inboxItemKindSchema,
  runId: idSchema,
  sessionId: idSchema,
  projectId: idSchema.nullable(),
  projectName: z.string().nullable(),
  /** Whose run it is. The caller's own, except for an approval only an owner may give. */
  userId: idSchema,
  agentId: z.string(),
  agentName: z.string(),
  /** The session's name. */
  title: z.string(),
  /** The start of the request that started the run. */
  preview: z.string(),
  runStatus: runStatusSchema,
  updatedAt: timestampSchema,
  /** The session's page. */
  link: z.string(),
  /** Set for `approval` items. The tool is named; what it was asked to do is shown only in the session. */
  approval: z
    .object({
      id: idSchema,
      kind: approvalKindSchema,
      toolName: z.string().nullable(),
      /** Only an instance owner may allow it. */
      requiresOwner: z.boolean(),
      expiresAt: timestampSchema.nullable(),
    })
    .nullable(),
  /** A shortened reason, for `needs-handling` items. */
  error: z.string().nullable(),
  interruptedByRestart: z.boolean(),
  /** Whether `POST /api/inbox/acknowledge` applies: results and needs-handling items only. */
  acknowledgeable: z.boolean(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxCountsSchema = z.object({
  approvals: z.number().int().nonnegative(),
  needsHandling: z.number().int().nonnegative(),
  results: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type InboxCounts = z.infer<typeof inboxCountsSchema>;

export const inboxSchema = z.object({
  /** Newest first within a group. Show the groups in this order. */
  groups: z.object({
    approvals: z.array(inboxItemSchema),
    needsHandling: z.array(inboxItemSchema),
    results: z.array(inboxItemSchema),
    running: z.array(inboxItemSchema),
  }),
  counts: inboxCountsSchema,
  /** A bound was hit: older entries exist beyond what is listed. */
  truncated: z.boolean(),
  checkedAt: timestampSchema,
});
export type Inbox = z.infer<typeof inboxSchema>;

/**
 * For a home tile. `status` is the one line to show: items waiting (approvals
 * and runs that need handling), else new results, else what is running, else
 * nothing. `line` is that sentence in the account's language.
 */
export const inboxSummarySchema = z.object({
  counts: inboxCountsSchema,
  waiting: z.number().int().nonnegative(),
  status: z.object({ code: z.enum(['waiting', 'results', 'running', 'clear']), count: z.number().int().nonnegative() }),
  line: z.string(),
  unreadNotifications: z.number().int().nonnegative(),
  truncated: z.boolean(),
  checkedAt: timestampSchema,
});
export type InboxSummary = z.infer<typeof inboxSummarySchema>;

export const acknowledgeRequestSchema = z.strictObject({ runId: idSchema });
export const acknowledgeResponseSchema = z.object({
  acknowledged: z.literal(true),
  /** It had been read, dismissed or continued before — perhaps on another device. */
  alreadyHandled: z.boolean(),
});
export type AcknowledgeResponse = z.infer<typeof acknowledgeResponseSchema>;

export const acknowledgeResultsRequestSchema = z.strictObject({
  runIds: z
    .array(idSchema)
    .min(1)
    .max(INBOX_LIMITS.acknowledgeMany)
    .refine((ids) => new Set(ids).size === ids.length, 'A run is named twice.'),
});
/** How many unread results were marked read. Failed, waiting and running runs are never touched. */
export const acknowledgeResultsResponseSchema = z.object({ acknowledged: z.number().int().nonnegative() });
export type AcknowledgeResultsResponse = z.infer<typeof acknowledgeResultsResponseSchema>;

// ---------------------------------------------------------------------------
// Live updates on `user:<id>`
// ---------------------------------------------------------------------------

export const INBOX_EVENT = {
  /** The task inbox may look different now: read it again. */
  inboxChanged: 'inbox.changed',
  /** The stored notifications changed. Carries the new unread count, and the notification when one was added. */
  notificationsChanged: 'notifications.changed',
  /** A device was added or removed, or a switch changed: read the settings again. */
  settingsChanged: 'notifications.settings.changed',
} as const;

export const inboxEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(INBOX_EVENT.inboxChanged), data: z.object({ reason: z.enum(['run', 'approval', 'acknowledged', 'attention']) }) }),
  z.object({
    type: z.literal(INBOX_EVENT.notificationsChanged),
    data: z.object({
      unread: z.number().int().nonnegative(),
      reason: z.enum(['added', 'read', 'removed']),
      notification: notificationSchema.optional(),
    }),
  }),
  z.object({ type: z.literal(INBOX_EVENT.settingsChanged), data: z.object({ reason: z.enum(['device-added', 'device-removed', 'preferences']) }) }),
]);
export type InboxEvent = z.infer<typeof inboxEventSchema>;
