import { NOTIFICATION_LIMITS, type NotificationKind, type PushPayload, appLinks, safeAppLink, toOneLine } from '@agent-studio/protocol';
import { redactSecrets } from '../../kernel/redact.js';
import { type Language, PRODUCT_NAME, text } from './texts.js';

/**
 * What notifications say. Everything here is a pure function of its input so
 * that the one rule that matters can be tested exhaustively:
 *
 *   A lock screen shows names and what happened — the session's or project's
 *   name, the assistant, the tool's name — and nothing from the conversation:
 *   no message text, no tool input, no command, no error text.
 *
 * A notification therefore exists in two strengths. `discreet` is what a push
 * carries by default. `title`/`body`/`detail` is what the app's own list
 * shows, and what a push carries only for a user who switched "show details"
 * on — and then only after `redactSecrets`.
 */
export interface NotificationContent {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  /** One line of substance (the request, the failure, the start of the prompt). Already redacted and bounded. */
  readonly detail: string | null;
  readonly discreet: { readonly title: string; readonly body: string };
  /** A path inside the app. */
  readonly link: string;
  /** Replacement key: a newer notification with the same tag takes the place of the older one. */
  readonly tag: string;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly projectId: string | null;
}

/** What is known about the session an event happened in. */
export interface SessionContext {
  readonly language: Language;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly sessionTitle: string;
  /**
   * The title was typed by the user or chosen by the agent: it is a name.
   * False for the placeholder and for a title cut from the first message —
   * that one *is* message text and never goes to a lock screen by default.
   */
  readonly titleIsName: boolean;
  readonly agentName: string;
}

const clip = (value: string, max: number): string => toOneLine(value, max);

/** One bounded line with anything that looks like a credential removed; null when nothing is left. */
export function summaryLine(value: string | null | undefined, max: number = NOTIFICATION_LIMITS.detailChars): string | null {
  if (typeof value !== 'string') return null;
  const line = clip(redactSecrets(value), max);
  return line === '' ? null : line;
}

function titles(context: SessionContext): { title: string; discreet: string } {
  const project = context.projectName === null ? '' : clip(context.projectName, NOTIFICATION_LIMITS.titleChars);
  const title = clip(context.sessionTitle, NOTIFICATION_LIMITS.titleChars) || project || PRODUCT_NAME;
  return { title, discreet: context.titleIsName ? title : project || PRODUCT_NAME };
}

function sessionContent(
  context: SessionContext,
  kind: NotificationKind,
  body: string,
  detail: string | null,
  runId: string | null,
): NotificationContent {
  const { title, discreet } = titles(context);
  const line = clip(body, NOTIFICATION_LIMITS.bodyChars);
  return {
    kind,
    title,
    body: line,
    detail,
    discreet: { title: discreet, body: line },
    link: appLinks.session(context.sessionId, context.projectId),
    tag: `${kind}:${context.sessionId}`,
    sessionId: context.sessionId,
    runId,
    projectId: context.projectId,
  };
}

/** An approval, a plan or a question is waiting. The tool is named; what it was asked to do is detail. */
export function needsYouContent(
  context: SessionContext,
  request: {
    readonly runId: string;
    readonly kind: 'tool' | 'plan' | 'question';
    readonly toolName: string | null;
    /** Set when the notification goes to an instance owner because only an owner may allow the request: whose run it is. */
    readonly onBehalfOf: string | null;
    /** What is being asked, in words (never shown on a lock screen by default). */
    readonly detail: string | null;
  },
): NotificationContent {
  const agent = context.agentName;
  const tool = request.toolName === null ? '' : clip(request.toolName, 60);
  let body: string;
  if (request.kind === 'plan') body = text(context.language, 'needsYou.plan', { agent });
  else if (request.kind === 'question') body = text(context.language, 'needsYou.question', { agent });
  else if (request.onBehalfOf !== null) {
    const person = clip(request.onBehalfOf, 60);
    body = tool === '' ? text(context.language, 'needsYou.owner.toolUnnamed', { agent, person }) : text(context.language, 'needsYou.owner.tool', { agent, tool, person });
  } else {
    body = tool === '' ? text(context.language, 'needsYou.toolUnnamed', { agent }) : text(context.language, 'needsYou.tool', { agent, tool });
  }
  return sessionContent(context, 'needs-you', body, summaryLine(request.detail), request.runId);
}

/** A run ended normally: a reply the user asked for, or work nobody was watching. */
export function runFinishedContent(context: SessionContext, run: { readonly runId: string; readonly unattended: boolean; readonly detail: string | null }): NotificationContent {
  return run.unattended
    ? sessionContent(context, 'background-finished', text(context.language, 'backgroundFinished', { agent: context.agentName }), summaryLine(run.detail), run.runId)
    : sessionContent(context, 'reply-finished', text(context.language, 'replyFinished', { agent: context.agentName }), summaryLine(run.detail), run.runId);
}

/** A run ended in an error. The error's text is detail. */
export function runFailedContent(context: SessionContext, run: { readonly runId: string; readonly detail: string | null }): NotificationContent {
  return sessionContent(context, 'run-failed', text(context.language, 'runFailed', { agent: context.agentName }), summaryLine(run.detail), run.runId);
}

export function runInterruptedContent(context: SessionContext, run: { readonly runId: string }): NotificationContent {
  return sessionContent(context, 'run-interrupted', text(context.language, 'runInterrupted', { agent: context.agentName }), null, run.runId);
}

/** A device was subscribed: said out loud on every device of the account, so nobody can be added as a silent listener. */
export function deviceAddedContent(language: Language, deviceLabel: string): NotificationContent {
  const title = text(language, 'deviceAdded.title');
  const body = text(language, 'deviceAdded.body', { device: clip(deviceLabel, NOTIFICATION_LIMITS.deviceLabelChars) });
  return {
    kind: 'system',
    title,
    body,
    detail: null,
    discreet: { title, body },
    link: appLinks.notificationSettings(),
    tag: 'system:device-added',
    sessionId: null,
    runId: null,
    projectId: null,
  };
}

/** `settings`: opens the notification settings. `automations`: opens the home screen. */
export function testContent(language: Language, origin: 'settings' | 'automations'): NotificationContent {
  const title = text(language, 'test.title');
  const body = text(language, 'test.body');
  return {
    kind: 'system',
    title,
    body,
    detail: null,
    discreet: { title, body },
    link: origin === 'settings' ? appLinks.notificationSettings() : appLinks.home(),
    tag: 'system:test',
    sessionId: null,
    runId: null,
    projectId: null,
  };
}

/** What a plugin wrote is content: the app shows it, a lock screen by default only says which plugin has news. */
export function pluginContent(
  language: Language,
  event: { readonly pluginId: string; readonly pluginName: string; readonly title: string; readonly body: string; readonly projectId: string | null; readonly projectName: string | null },
): NotificationContent {
  const plugin = clip(event.pluginName, 60) || event.pluginId;
  const title = clip(redactSecrets(event.title), NOTIFICATION_LIMITS.titleChars) || plugin;
  const body = clip(redactSecrets(event.body), NOTIFICATION_LIMITS.bodyChars);
  return {
    kind: 'plugin',
    title,
    body: body || text(language, 'plugin.discreet', { plugin }),
    detail: null,
    discreet: {
      title: event.projectName === null ? PRODUCT_NAME : clip(event.projectName, NOTIFICATION_LIMITS.titleChars) || PRODUCT_NAME,
      body: text(language, 'plugin.discreet', { plugin }),
    },
    link: event.projectId === null ? appLinks.home() : appLinks.project(event.projectId),
    // Each plugin has one slot per project: its newest message replaces its previous one.
    tag: `plugin:${event.pluginId}:${event.projectId ?? 'none'}`,
    sessionId: null,
    runId: null,
    projectId: event.projectId,
  };
}

/** What another module hands in (an automation's reminder, its outcome). Bounded and cleaned here, once. */
export interface CustomNotification {
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly detail?: string | null;
  /** What a lock screen shows by default. Leave out a part to use the full one — only when it holds nothing but names. */
  readonly discreet?: { readonly title?: string; readonly body?: string };
  readonly link: string;
  readonly tag: string;
  readonly sessionId?: string | null;
  readonly runId?: string | null;
  readonly projectId?: string | null;
}

export function customContent(input: CustomNotification): NotificationContent {
  const title = clip(input.title, NOTIFICATION_LIMITS.titleChars) || PRODUCT_NAME;
  const body = clip(input.body, NOTIFICATION_LIMITS.bodyChars);
  return {
    kind: input.kind,
    title,
    body,
    detail: summaryLine(input.detail ?? null),
    discreet: {
      title: input.discreet?.title === undefined ? title : clip(input.discreet.title, NOTIFICATION_LIMITS.titleChars) || PRODUCT_NAME,
      body: input.discreet?.body === undefined ? body : clip(input.discreet.body, NOTIFICATION_LIMITS.bodyChars),
    },
    link: safeAppLink(input.link),
    tag: clip(input.tag, 120) || `${input.kind}:untagged`,
    sessionId: input.sessionId ?? null,
    runId: input.runId ?? null,
    projectId: input.projectId ?? null,
  };
}

/**
 * The JSON a push message carries — exactly the four fields the service
 * worker reads. Without `showDetails` only the discreet strength is used;
 * with it, the full title and body plus the detail line. Either way the text
 * passes `redactSecrets`, and the link is reduced to a path inside the app.
 */
export function buildPushPayload(content: NotificationContent, options: { readonly showDetails: boolean }): PushPayload {
  const title = options.showDetails ? content.title : content.discreet.title;
  const base = options.showDetails ? content.body : content.discreet.body;
  const body = options.showDetails && content.detail !== null ? (base === '' ? content.detail : `${base} — ${content.detail}`) : base;
  return {
    title: clip(redactSecrets(title), NOTIFICATION_LIMITS.titleChars) || PRODUCT_NAME,
    body: clip(redactSecrets(body), NOTIFICATION_LIMITS.bodyChars),
    tag: content.tag,
    url: safeAppLink(content.link),
  };
}

export interface PushDelivery {
  /** How long a push service may hold the message for a device that is offline. */
  readonly ttlSeconds: number;
  readonly urgency: 'very-low' | 'low' | 'normal' | 'high';
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * How urgently, and for how long, a push service should try. A request that
 * waits for the user is worth waking a phone for, but not after it has
 * expired; finished background work can wait for the device to wake by itself.
 */
export function pushDelivery(kind: NotificationKind, options: { readonly expiresInMs?: number | null; readonly test?: boolean } = {}): PushDelivery {
  if (options.test) return { ttlSeconds: 10 * MINUTE, urgency: 'high' };
  switch (kind) {
    case 'needs-you': {
      const untilExpiry = options.expiresInMs == null ? 30 * MINUTE : Math.ceil(options.expiresInMs / 1000);
      return { ttlSeconds: Math.min(24 * HOUR, Math.max(MINUTE, untilExpiry)), urgency: 'high' };
    }
    case 'reply-finished':
      return { ttlSeconds: 12 * HOUR, urgency: 'normal' };
    case 'background-finished':
      return { ttlSeconds: 24 * HOUR, urgency: 'low' };
    case 'run-failed':
    case 'run-interrupted':
      return { ttlSeconds: 24 * HOUR, urgency: 'normal' };
    case 'automation':
      return { ttlSeconds: 12 * HOUR, urgency: 'normal' };
    case 'plugin':
      return { ttlSeconds: 12 * HOUR, urgency: 'low' };
    case 'system':
      return { ttlSeconds: HOUR, urgency: 'normal' };
  }
}

/**
 * The identity of an event for duplicate suppression: the same event for the
 * same session is raised once within a short window. Genuinely different
 * events keep different identities — another tool, another error, another run.
 */
export const dedupeKeys = {
  needsYou: (userId: string, sessionId: string, kind: string, toolName: string | null): string => `needs-you|${userId}|${sessionId}|${kind}|${toolName ?? ''}`,
  runFinished: (userId: string, sessionId: string, runId: string): string => `finished|${userId}|${sessionId}|${runId}`,
  runFailed: (userId: string, sessionId: string, errorCode: string | null): string => `failed|${userId}|${sessionId}|${errorCode ?? ''}`,
} as const;
