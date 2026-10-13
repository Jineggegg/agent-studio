import { z } from 'zod';
import { AGENT_LIMITS, agentEffortSchema, agentModelSchema, permissionModeSchema } from './agents.js';
import { idSchema, limitQuery, timestampSchema } from './common.js';
import { stripControlCharacters, toOneLine } from './inbox.js';
import { agentIdSchema } from './projects.js';

/**
 * Automation: things a project does by itself.
 *
 * - An **automation** belongs to a project and to the person who created it.
 *   It has a trigger (a schedule in a named time zone, or a project event) and
 *   one action: tell its creator something (`notify`), or send a prompt to an
 *   agent (`agent-run`).
 * - An agent run started by an automation is **unattended**: nobody is assumed
 *   to be watching, so whatever would need approval is denied and the outcome
 *   says so. It acts as the automation's creator and is refused when that
 *   person may no longer work in the project.
 * - Every execution is recorded ({@link AutomationExecution}); nothing is
 *   retried by itself.
 * - A **deferred message** is a single message to an existing session, sent
 *   at a chosen instant. It runs like a message typed at that moment — with
 *   the session's ordinary permissions — and waits in the session's queue
 *   when a turn is already running.
 *
 * A create or update payload is exactly what a form holds: no sentence is
 * parsed on the server.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const AUTOMATION_LIMITS = {
  perProject: 20,
  nameChars: 80,
  /** The fixed message of a `notify` action. */
  messageChars: 240,
  /** The prompt of an `agent-run` action. */
  promptChars: 16_000,
  cronChars: 100,
  /** Two occurrences of a cron expression must be at least this far apart. */
  minIntervalMinutes: 5,
  /** Executions kept per automation; older ones are removed. */
  historyPerAutomation: 100,
  historyDefault: 20,
  historyMax: 100,
  summaryChars: 500,
  /** A run that came due while the server was down is made up within this window, and recorded as missed after it. */
  graceMs: 6 * 60 * 60 * 1000,
  /** Occurrences shown by the schedule preview. */
  previewRuns: 5,
  deferredTextChars: AGENT_LIMITS.messageChars,
  /** A deferred message can be at most this far ahead. */
  deferredMaxAheadMs: 365 * 24 * 60 * 60 * 1000,
  /** Deferred messages one user may have waiting. */
  deferredPending: 100,
  deferredListMax: 200,
} as const;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** True for an IANA time zone name this runtime knows ("Europe/Berlin", "Asia/Shanghai", "UTC"). */
export function isTimeZone(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().min(1).max(64).refine(isTimeZone, 'Not a time zone. Use an IANA name such as "Europe/Berlin".');

/** `HH:MM`, 24-hour, both parts two digits. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 08:30.');

/** True for a calendar date that exists: `2027-02-28` yes, `2027-02-30` no. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2200 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const calendarDateSchema = z.string().refine(isCalendarDate, 'Use a real date such as 2027-03-31.');

/** 0 = Sunday … 6 = Saturday. */
export const weekdaySchema = z.number().int().min(0).max(6);

// ---------------------------------------------------------------------------
// Triggers and actions
// ---------------------------------------------------------------------------

/** Project events an automation can wait for. `run-failed`: a run in the project that its creator may see failed or was cut short. */
export const AUTOMATION_EVENTS = ['run-failed'] as const;
export const automationEventSchema = z.enum(AUTOMATION_EVENTS);
export type AutomationEventName = z.infer<typeof automationEventSchema>;

/**
 * When an automation fires. Every clock time is wall-clock time in the
 * automation's `timeZone`; on the day clocks go forward a time that does not
 * exist runs once, an hour later, and on the day they go back a time that
 * occurs twice runs once, the first time.
 *
 * `once`      on one date at one time
 * `hourly`    every hour at a minute
 * `daily`     every day at a time
 * `weekdays`  Monday to Friday at a time
 * `weekly`    on chosen days of the week at a time
 * `cron`      a five-field cron expression (minute hour day-of-month month day-of-week)
 * `event`     when something happens in the project
 */
export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('once'), date: calendarDateSchema, time: timeOfDaySchema }),
  z.strictObject({ type: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.strictObject({ type: z.literal('daily'), time: timeOfDaySchema }),
  z.strictObject({ type: z.literal('weekdays'), time: timeOfDaySchema }),
  z.strictObject({
    type: z.literal('weekly'),
    days: z
      .array(weekdaySchema)
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'A day is listed twice.'),
    time: timeOfDaySchema,
  }),
  z.strictObject({ type: z.literal('cron'), expression: z.string().trim().min(1).max(AUTOMATION_LIMITS.cronChars) }),
  z.strictObject({ type: z.literal('event'), event: automationEventSchema }),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

const oneLine = (max: number, what: string) =>
  z
    .string()
    .max(4000)
    .transform((value) => toOneLine(value, max))
    .refine((value) => value.length > 0, `${what} cannot be empty.`);

const promptSchema = z
  .string()
  .max(AUTOMATION_LIMITS.promptChars)
  .transform((value) => stripControlCharacters(value).trim())
  .refine((value) => value.length > 0, 'The prompt cannot be empty.');

/**
 * What an automation does.
 *
 * `notify`     sends its creator a fixed message through the inbox.
 * `agent-run`  sends `prompt` to an agent in this project, as an unattended
 *              run. `session` says where: always a new session, or one fixed
 *              session of the creator's. `permissionMode` is what the run may
 *              do with nobody there: `plan` reads only; `ask` runs what needs
 *              no approval and denies — never waits for — what would;
 *              `accept-edits` and `auto` are available only where the
 *              project's owner enabled auto mode.
 */
export const automationActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notify'), message: oneLine(AUTOMATION_LIMITS.messageChars, 'The message') }),
  z.strictObject({
    type: z.literal('agent-run'),
    agentId: agentIdSchema,
    prompt: promptSchema,
    session: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('new') }),
      z.strictObject({ type: z.literal('existing'), sessionId: idSchema }),
    ]),
    permissionMode: permissionModeSchema.default('ask'),
    model: agentModelSchema.optional(),
    effort: agentEffortSchema.optional(),
  }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

const eventNeedsNotify = (value: { trigger?: AutomationTrigger | undefined; action?: AutomationAction | undefined }) =>
  !(value.trigger?.type === 'event' && value.action !== undefined && value.action.type !== 'notify');
const EVENT_NEEDS_NOTIFY = { message: 'An event can only trigger a notification.', path: ['action'] };

const automationFields = {
  name: oneLine(AUTOMATION_LIMITS.nameChars, 'The name'),
  enabled: z.boolean(),
  timeZone: timeZoneSchema,
  trigger: automationTriggerSchema,
  action: automationActionSchema,
};

/** There is no field for who the automation acts as: it is always the caller. */
export const createAutomationRequestSchema = z
  .strictObject({ ...automationFields, enabled: z.boolean().default(true) })
  .refine(eventNeedsNotify, EVENT_NEEDS_NOTIFY);
export type CreateAutomationRequest = z.infer<typeof createAutomationRequestSchema>;

/** Only what is sent changes. Changing the trigger, the time zone or the switch plans the next run again. */
export const updateAutomationRequestSchema = z
  .strictObject(automationFields)
  .partial()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: 'Nothing to change.' })
  .refine(eventNeedsNotify, EVENT_NEEDS_NOTIFY);
export type UpdateAutomationRequest = z.infer<typeof updateAutomationRequestSchema>;

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

/**
 * How an execution ended — or, for `started`, that it has not ended yet.
 *
 * `notified`   the message reached the app's list and/or at least one device
 * `quiet`      nothing was sent because the creator has switched it off
 * `started`    an agent run is in progress
 * `completed`  the agent run finished normally
 * `failed`     it could not be started, ended in an error, or was cut short
 * `denied`     a guard rail refused it, or the run needed approvals that nobody was there to give
 * `skipped`    it came due while its previous execution, or its session, was still busy
 * `missed`     it came due while the server was not running, longer ago than the grace window
 */
export const automationOutcomeSchema = z.enum(['notified', 'quiet', 'started', 'completed', 'failed', 'denied', 'skipped', 'missed']);
export type AutomationOutcome = z.infer<typeof automationOutcomeSchema>;

/** A stable code for why. The sentence for people is `summary`. */
export const automationReasonSchema = z.enum([
  // quiet
  'event-off',
  'channels-off',
  // skipped
  'still-running',
  'session-busy',
  // missed
  'server-down',
  // denied
  'automation-off',
  'project-archived',
  'creator-disabled',
  'access-lost',
  'agent-unavailable',
  'agent-not-enabled',
  'mode-not-allowed',
  'mode-not-supported',
  'session-gone',
  'approval-needed',
  // failed
  'run-failed',
  'run-stopped',
  'interrupted',
  'not-delivered',
  'error',
]);
export type AutomationReason = z.infer<typeof automationReasonSchema>;

export const automationExecutionSchema = z.object({
  id: idSchema,
  automationId: idSchema,
  /** `schedule`: it came due. `manual`: someone pressed "run now". `event`: its project event happened. */
  trigger: z.enum(['schedule', 'manual', 'event']),
  /** The occurrence it was for. Null for manual and event executions. */
  scheduledFor: timestampSchema.nullable(),
  startedAt: timestampSchema,
  /** Null while an agent run is still going. */
  endedAt: timestampSchema.nullable(),
  outcome: automationOutcomeSchema,
  reason: automationReasonSchema.nullable(),
  /** One paragraph saying what happened. */
  summary: z.string(),
  /** The session and run an `agent-run` produced. */
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
});
export type AutomationExecution = z.infer<typeof automationExecutionSchema>;

// ---------------------------------------------------------------------------
// Automations as they are returned
// ---------------------------------------------------------------------------

/**
 * What a permission mode means for a run nobody watches.
 *
 * `read-only`        `plan`: reads and searches only; everything else is refused
 * `deny-and-report`  `ask`: what needs no approval runs; what would need it is denied, and the outcome says so
 * `edits-allowed`    `accept-edits`: as above, and file edits inside the project also run
 * `auto`             everything runs except what a deny rule or the hard-deny list forbids
 */
export const unattendedBehaviourSchema = z.enum(['read-only', 'deny-and-report', 'edits-allowed', 'auto']);
export type UnattendedBehaviour = z.infer<typeof unattendedBehaviourSchema>;

/** Why a mode cannot be used. `auto-mode-off`: the project's owner has not enabled auto mode. `unsupported`: the agent does not have it. */
export const modeRefusalSchema = z.enum(['auto-mode-off', 'unsupported']);

export const automationModeOptionSchema = z.object({
  mode: permissionModeSchema,
  behaviour: unattendedBehaviourSchema,
  allowed: z.boolean(),
  refusal: modeRefusalSchema.nullable(),
});
export type AutomationModeOption = z.infer<typeof automationModeOptionSchema>;

const personSchema = z.object({ id: idSchema, displayName: z.string() });

/** For an `agent-run` action: exactly what applies when it runs. */
export const automationGuardSchema = z.object({
  /** The account the run acts as: the automation's creator. */
  actsAs: personSchema,
  permissionMode: permissionModeSchema,
  behaviour: unattendedBehaviourSchema,
  /**
   * Whether a run would be let through right now. When false, `refusal` says
   * why, and a run that comes due is recorded as denied with that reason.
   */
  allowed: z.boolean(),
  refusal: automationReasonSchema.nullable(),
});
export type AutomationGuard = z.infer<typeof automationGuardSchema>;

export const automationSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string(),
  enabled: z.boolean(),
  timeZone: z.string(),
  trigger: automationTriggerSchema,
  action: automationActionSchema,
  createdBy: personSchema,
  /** The caller may edit, switch, run and delete it: its creator with write access, or the instance owner. */
  canManage: z.boolean(),
  /** Null when it is off, waits for an event, or was a one-off that has run. */
  nextRunAt: timestampSchema.nullable(),
  /** `scheduled`: `nextRunAt` is set. `waiting`: enabled, waits for its event. `off`: disabled. */
  state: z.enum(['scheduled', 'waiting', 'off']),
  /** Set when the server switched it off by itself. `ran-once`: a one-off that has run. `access-lost`: its creator can no longer write in the project. */
  disabledReason: z.enum(['ran-once', 'access-lost']).nullable(),
  /** An execution of it is in progress. */
  running: z.boolean(),
  lastRun: automationExecutionSchema.nullable(),
  /** Null for `notify`. */
  guard: automationGuardSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Automation = z.infer<typeof automationSchema>;

export const automationListSchema = z.object({
  /** In creation order. */
  automations: z.array(automationSchema),
  /** The project's automation switch (`features.automation`). When off nothing can be created or run. */
  enabled: z.boolean(),
  limit: z.number().int().positive(),
});
export type AutomationList = z.infer<typeof automationListSchema>;

/** What a create or edit form needs to offer only what is possible. */
export const automationOptionsSchema = z.object({
  enabled: z.boolean(),
  /** The caller has write access here. */
  canCreate: z.boolean(),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** The project's owner has enabled auto mode. */
  autoMode: z.boolean(),
  /** Who a new automation would act as: the caller. */
  actsAs: personSchema,
  events: z.array(automationEventSchema),
  agents: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      /** False when the agent is not installed or cannot be used right now; `problem` says why. */
      available: z.boolean(),
      problem: z.string().nullable(),
      models: z.array(z.object({ id: z.string(), label: z.string() })),
      defaultModel: z.string().nullable(),
      /** Every mode, with whether an unattended run may use it here. */
      modes: z.array(automationModeOptionSchema),
    }),
  ),
});
export type AutomationOptions = z.infer<typeof automationOptionsSchema>;

export const automationHistoryQuerySchema = z.object({
  limit: limitQuery(AUTOMATION_LIMITS.historyDefault, AUTOMATION_LIMITS.historyMax),
  /** The id of the oldest execution already shown. */
  before: idSchema.optional(),
});
export const automationHistorySchema = z.object({
  /** Newest first. */
  runs: z.array(automationExecutionSchema),
  hasMore: z.boolean(),
});
export type AutomationHistory = z.infer<typeof automationHistorySchema>;

export const runAutomationResponseSchema = z.object({
  automation: automationSchema,
  /** Null when nothing was executed because an execution was already in progress. */
  execution: automationExecutionSchema.nullable(),
});
export type RunAutomationResponse = z.infer<typeof runAutomationResponseSchema>;

/** When a schedule would fire next, without saving anything. */
export const schedulePreviewRequestSchema = z.strictObject({ timeZone: timeZoneSchema, trigger: automationTriggerSchema });
export const schedulePreviewSchema = z.object({ runs: z.array(timestampSchema) });
export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;

// ---------------------------------------------------------------------------
// Deferred messages
// ---------------------------------------------------------------------------

/**
 * `pending`      waits for its time
 * `in-progress`  it was handed to the session: it runs, or it waits in the session's queue (`queued`)
 * `sent`         the turn it started finished normally
 * `failed`       it could not be sent, or its turn failed; `reason` and `detail` say why
 * `cancelled`    cancelled before it was sent
 */
export const deferredStateSchema = z.enum(['pending', 'in-progress', 'sent', 'failed', 'cancelled']);
export type DeferredState = z.infer<typeof deferredStateSchema>;

export const deferredReasonSchema = z.enum([
  'session-gone',
  'account-disabled',
  'access-lost',
  'automation-off',
  'agent-unavailable',
  'queue-full',
  'missed',
  'run-failed',
  'run-stopped',
  'interrupted',
  'error',
]);
export type DeferredReason = z.infer<typeof deferredReasonSchema>;

/** An absolute instant: milliseconds since the epoch, or an ISO 8601 date-time with an offset. It never shifts with a device's time zone. */
export const instantSchema = z.union([
  timestampSchema,
  z
    .string()
    .max(40)
    .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'Not a date and time.')
    .transform((value) => Date.parse(value)),
]);

export const createDeferredMessageRequestSchema = z.strictObject({
  sessionId: idSchema,
  text: z.string().trim().min(1).max(AUTOMATION_LIMITS.deferredTextChars),
  sendAt: instantSchema,
  /** What the composer had selected; used when the message is sent. */
  model: agentModelSchema.optional(),
  effort: agentEffortSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
});
export type CreateDeferredMessageRequest = z.infer<typeof createDeferredMessageRequestSchema>;

export const deferredMessageSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  projectId: idSchema.nullable(),
  text: z.string(),
  sendAt: timestampSchema,
  state: deferredStateSchema,
  /** In progress, but still waiting in the session's queue behind a running turn. */
  queued: z.boolean(),
  reason: deferredReasonSchema.nullable(),
  /** The reason in words. */
  detail: z.string().nullable(),
  options: z.object({ model: z.string().nullable(), effort: z.string().nullable(), permissionMode: permissionModeSchema.nullable() }),
  /** The run it started, once there is one. */
  runId: idSchema.nullable(),
  /** A failed message the user has put away. */
  dismissed: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type DeferredMessage = z.infer<typeof deferredMessageSchema>;

export const listDeferredMessagesQuerySchema = z.object({
  /** With a session: everything about it that was not dismissed. Without: the caller's pending messages. */
  sessionId: idSchema.optional(),
  projectId: idSchema.optional(),
  state: deferredStateSchema.optional(),
  limit: limitQuery(100, AUTOMATION_LIMITS.deferredListMax),
});
export type ListDeferredMessagesQuery = z.infer<typeof listDeferredMessagesQuerySchema>;

export const deferredMessageListSchema = z.object({ messages: z.array(deferredMessageSchema) });
export type DeferredMessageList = z.infer<typeof deferredMessageListSchema>;

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

export const AUTOMATION_EVENT = {
  /** On `project:<id>`: an automation was created, changed, removed, or ran. Read the list again. */
  changed: 'automation.changed',
  /** On `user:<id>`: one of the caller's deferred messages changed state. */
  deferredChanged: 'deferred.changed',
} as const;

export const automationChangedSchema = z.object({
  projectId: idSchema,
  automationId: idSchema,
  change: z.enum(['created', 'updated', 'removed', 'ran']),
});
export type AutomationChanged = z.infer<typeof automationChangedSchema>;

export const deferredChangedSchema = z.object({ id: idSchema, sessionId: idSchema, state: deferredStateSchema });
export type DeferredChanged = z.infer<typeof deferredChangedSchema>;
