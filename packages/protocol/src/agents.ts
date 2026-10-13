import { z } from 'zod';
import { idSchema, limitQuery, timestampSchema } from './common.js';

/**
 * Wire contracts of the agent runtime: agents, sessions, runs, the session
 * event log, approvals, permission rules, attachments and usage.
 *
 * ## The model
 *
 * A **session** is one conversation with one agent, inside one project. It
 * belongs to the user who created it; the instance owner can also see it. Its
 * id is issued by the server before the first message and never changes.
 *
 * A **run** is one execution of the agent for one user message. A session has
 * at most one run in progress. Runs belong to the server: they keep going
 * with no client connected, and what they produce is recorded whether or not
 * anyone is watching. A run moves `accepted → running →` exactly one of
 * `completed | failed | stopped | interrupted`.
 *
 * Everything that happens in a session is an **event** in that session's
 * append-only log. Each durable event has a sequence number (`seq`) that
 * starts at 1 and grows by 1 per session — across runs, so one number orders
 * the whole conversation.
 *
 * ## Durable and live events
 *
 * - *Durable* events ({@link SessionEvent}) are stored, numbered, and are the
 *   transcript: user messages, completed assistant text, tool calls and their
 *   results, to-do lists, usage, notices, approvals, run start and the single
 *   `run.finished` that ends each run.
 * - *Live* events ({@link LiveSessionEvent}) are sent to whoever is watching
 *   and are **not** stored and carry no `seq`: text and thinking deltas, tool
 *   output as it is produced, queue and session changes. Losing them loses
 *   nothing: a completed `message.assistant` supersedes its deltas, and the
 *   snapshot carries the text streamed so far.
 *
 * ## Reducing the log into a transcript
 *
 * Fold durable events in `seq` order:
 *
 * - `message.user` → a user turn (`origin` says whether it was typed, taken
 *   from the queue, steered into a running turn, or a continuation).
 * - `message.assistant` / `thinking` → a block; `parentToolCallId` nests it
 *   under a sub-agent's tool call. `partial: true` marks text cut short by a
 *   stop or failure.
 * - `tool.started` + `tool.finished` pair up by `toolCallId`. A call with no
 *   `tool.finished` belongs to a run that ended first: show it as not
 *   completed once that run's `run.finished` arrives.
 * - `todos.updated` replaces the run's checklist. `usage.reported` updates the
 *   context figure. `notice` is a row of its own.
 * - `approval.requested` opens a prompt, `approval.resolved` (same
 *   `approvalId`) closes it on every device.
 * - `run.started` … `run.finished` bracket a run; everything between carries
 *   the same `runId`.
 *
 * While a run is in progress, add the live deltas on top: append
 * `message.delta.text` to the block named by `messageId` when its `offset`
 * equals the length you already hold (ignore it otherwise — a duplicate), and
 * drop that live block when the durable event with the same `messageId`
 * arrives.
 *
 * ## Watching a session, and resuming after a gap
 *
 * Subscribe to `session:<id>` on the realtime channel. The `subscribed` frame
 * carries a {@link SessionSnapshot}: the run in progress, the text streamed so
 * far, pending approvals, the queue, unresolved interrupted or failed runs,
 * and `lastSeq`.
 *
 * - First open: read the newest page with `GET /api/sessions/:id/events`
 *   (it pages backwards with `before`), subscribe without `after`, and apply
 *   live events with `seq > snapshot.lastSeq`.
 * - Reconnect: subscribe with `after` = the last `seq` you applied. The server
 *   replays what you missed, oldest first, then continues live. Drop any event
 *   whose `seq` you already have. If the first replayed `seq` is not
 *   `after + 1` you were further behind than the replay window
 *   ({@link AGENT_LIMITS.replayEvents}): fetch the gap with
 *   `GET /api/sessions/:id/events?after=…` until `hasMore` is false.
 * - Replace your pending approvals, queue and streaming text with the
 *   snapshot's every time you (re)subscribe; they are authoritative.
 *
 * List-level changes (a session created, renamed, removed; attention marks;
 * runs starting and ending; approvals) arrive on the caller's own
 * `user:<id>` topic as {@link UserAgentEvent}s so lists and badges stay
 * current on every device.
 *
 * ## Sending
 *
 * `POST /api/sessions/:id/messages` carries a client-generated `requestId`.
 * The server records the message durably and answers with a
 * {@link MessageReceipt} before the agent does any work. Sending the same
 * `requestId` with the same content again returns the original receipt with
 * `duplicate: true` and never starts a second run; the same id with different
 * content is refused (`request_conflict`). When a send's fate is unknown, ask
 * `GET /api/sessions/:id/messages/:requestId`: 404 means the server never
 * accepted it, and only then may the original be sent again.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const AGENT_LIMITS = {
  /** Characters in one message, queued message or draft. */
  messageChars: 100_000,
  quoteChars: 20_000,
  attachmentsPerMessage: 10,
  attachmentBytes: 10 * 1024 * 1024,
  queueItems: 20,
  /** Session ids one presence report may name. */
  presenceSessions: 32,
  titleChars: 200,
  requestIdChars: 200,
  /** Durable events replayed on subscribe; older gaps are read over REST. */
  replayEvents: 2000,
  /** Characters of tool output kept in a stored event. */
  toolOutputChars: 40_000,
  /** Characters of tool input (as JSON) kept in a stored event. */
  toolInputChars: 16_000,
  /** Characters of file diffs kept in one stored tool result. */
  toolDiffChars: 60_000,
} as const;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * `plan`          read and search only; everything else is refused.
 * `ask`           reads inside the project run; anything with a side effect asks.
 * `accept-edits`  as `ask`, and file edits inside the project also run.
 * `auto`          everything runs except what a deny rule or the hard-deny
 *                 list forbids. Works only in projects where the owner enabled
 *                 it; elsewhere the session behaves as `ask`.
 */
export const permissionModeSchema = z.enum(['plan', 'ask', 'accept-edits', 'auto']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const toolKindSchema = z.enum(['read', 'search', 'edit', 'execute', 'fetch', 'agent', 'other']);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const riskClassSchema = z.enum(['low', 'medium', 'dangerous']);
export type RiskClass = z.infer<typeof riskClassSchema>;

/** Why a request was classed as dangerous. */
export const riskCategorySchema = z.enum([
  'destructive',
  'privilege',
  'download-exec',
  'outside-project',
  'credentials',
  'recursive-permissions',
  'obfuscated',
  'studio-data',
  'catastrophic',
]);
export type RiskCategory = z.infer<typeof riskCategorySchema>;

export const runStatusSchema = z.enum(['accepted', 'running', 'completed', 'failed', 'stopped', 'interrupted']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const terminalRunStatusSchema = z.enum(['completed', 'failed', 'stopped', 'interrupted']);
export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>;

/**
 * Where a run came from. `scheduled` and `automation` runs are unattended:
 * nobody is assumed to be watching, so what would need approval is denied
 * unless the caller that started the run opted in to waiting.
 */
export const runOriginSchema = z.enum(['interactive', 'queued', 'continue', 'scheduled', 'automation']);
export type RunOrigin = z.infer<typeof runOriginSchema>;

/**
 * `running`    a run is in progress.
 * `needs-you`  an approval, plan or question is waiting, or a failed or
 *              interrupted run has not been continued or dismissed.
 * `unseen`     a run finished while the session was not on screen.
 */
export const attentionSchema = z.enum(['none', 'running', 'needs-you', 'unseen']);
export type Attention = z.infer<typeof attentionSchema>;

export const agentModelSchema = z.string().trim().min(1).max(200);
export const agentEffortSchema = z.string().trim().min(1).max(40);

// ---------------------------------------------------------------------------
// Agents (adapters)
// ---------------------------------------------------------------------------

export const agentModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  /** Context window in tokens, when the adapter knows it. */
  contextWindow: z.number().int().positive().optional(),
  /** Effort levels this model accepts, weakest first. Empty or absent: none. */
  efforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
});
export type AgentModelOption = z.infer<typeof agentModelOptionSchema>;

export const agentCapabilitiesSchema = z.object({
  models: z.array(agentModelOptionSchema),
  defaultModel: z.string().nullable(),
  permissionModes: z.array(permissionModeSchema),
  /** Raster images can be given to the agent as images (other files are always passed as paths). */
  images: z.boolean(),
  /** A message can be injected into a run in progress. */
  steering: z.boolean(),
  /** A later run continues the agent's own conversation instead of replaying history. */
  resume: z.boolean(),
  planMode: z.boolean(),
  /** The agent reports token usage. */
  usage: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  signedIn: z.boolean(),
  /** A label for the signed-in account (never a credential). */
  account: z.string().nullable(),
  /** One readable sentence when the agent cannot be used. */
  problem: z.string().nullable(),
});
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  /** `cli`: a coding agent that runs tools on the host. `api`: a chat model called over HTTPS. */
  kind: z.enum(['cli', 'api']),
  capabilities: agentCapabilitiesSchema,
  status: agentStatusSchema,
});
export type Agent = z.infer<typeof agentSchema>;

export const agentListSchema = z.object({ agents: z.array(agentSchema) });

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const attachmentSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  /** The name the file was uploaded with (display only; it is stored under a generated name). */
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  /** A raster image the client may show inline; everything else is a download. */
  isImage: z.boolean(),
  /** Where to fetch it back (authenticated). */
  url: z.string(),
  /** False once it has gone out with a message. */
  pending: z.boolean(),
  createdAt: timestampSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const rejectedAttachmentSchema = z.object({
  name: z.string(),
  /** `attachment_too_large` | `too_many_attachments` | `attachment_empty` */
  code: z.string(),
  message: z.string(),
});
export type RejectedAttachment = z.infer<typeof rejectedAttachmentSchema>;

export const uploadAttachmentsResponseSchema = z.object({
  attachments: z.array(attachmentSchema),
  rejected: z.array(rejectedAttachmentSchema),
});
export type UploadAttachmentsResponse = z.infer<typeof uploadAttachmentsResponseSchema>;

/** How a message refers to its attachments in the transcript. */
export const attachmentRefSchema = attachmentSchema.pick({ id: true, name: true, mediaType: true, size: true, isImage: true, url: true });
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const titleSourceSchema = z.enum(['default', 'auto', 'agent', 'manual']);
export type TitleSource = z.infer<typeof titleSourceSchema>;

export const sessionSchema = z.object({
  id: idSchema,
  /** Null only for conversations with an API model outside any project. */
  projectId: idSchema.nullable(),
  userId: idSchema,
  agentId: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /** The mode the user chose. */
  permissionMode: permissionModeSchema,
  /** The mode runs actually use: `auto` becomes `ask` where the project has not enabled it. */
  effectivePermissionMode: permissionModeSchema,
  title: z.string(),
  /** `manual` titles were typed by the user and are never replaced automatically. */
  titleSource: titleSourceSchema,
  pinned: z.boolean(),
  archived: z.boolean(),
  /** Sessions handed from one agent to another share a chain. */
  chainId: idSchema.nullable(),
  parentSessionId: idSchema.nullable(),
  attention: attentionSchema,
  /** The run in progress, if any. */
  activeRunId: idSchema.nullable(),
  hasDraft: z.boolean(),
  /** Whether the agent has a conversation of its own to resume (its id is never sent to clients). */
  resumable: z.boolean(),
  /** Number of the newest durable event. */
  lastSeq: z.number().int().nonnegative(),
  lastActivityAt: timestampSchema,
  /** What lists sort by: agent output does not reorder them. */
  lastUserMessageAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionTitleSchema = z.string().trim().min(1).max(AGENT_LIMITS.titleChars);

export const createSessionRequestSchema = z.object({
  /** Omit only for an API-model conversation outside any project. */
  projectId: idSchema.nullable().default(null),
  agentId: z.string().min(1).max(80),
  model: agentModelSchema.optional(),
  effort: agentEffortSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  title: sessionTitleSchema.optional(),
  /** The session this one continues after a handoff to another agent. */
  parentSessionId: idSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const updateSessionRequestSchema = z
  .object({
    title: sessionTitleSchema,
    pinned: z.boolean(),
    archived: z.boolean(),
    model: agentModelSchema.nullable(),
    effort: agentEffortSchema.nullable(),
    permissionMode: permissionModeSchema,
  })
  .partial();
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const listSessionsQuerySchema = z.object({
  projectId: idSchema.optional(),
  /** Words that must all appear in the title. */
  q: z.string().trim().max(200).optional(),
  archived: z.enum(['exclude', 'only', 'include']).default('exclude'),
  /** `all` lets the instance owner list every user's sessions; members always get their own. */
  scope: z.enum(['mine', 'all']).default('mine'),
  limit: limitQuery(50, 200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const sessionListSchema = z.object({
  /** Running first, then pinned, then by the time of the last user message. */
  sessions: z.array(sessionSchema),
  hasMore: z.boolean(),
});
export type SessionList = z.infer<typeof sessionListSchema>;

export const draftSchema = z.object({ sessionId: idSchema, text: z.string(), updatedAt: timestampSchema.nullable() });
export type Draft = z.infer<typeof draftSchema>;
export const saveDraftRequestSchema = z.object({ text: z.string().max(AGENT_LIMITS.messageChars) });

export const nativeSessionIdResponseSchema = z.object({ nativeSessionId: z.string() });

/** Which sessions are visibly on screen in one browser tab. Each report replaces the tab's previous one. */
export const presenceRequestSchema = z.object({
  /** Chosen by the client; identifies the tab. */
  clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** Empty when the page is hidden. */
  visible: z.array(idSchema).max(AGENT_LIMITS.presenceSessions),
});
export type PresenceRequest = z.infer<typeof presenceRequestSchema>;

export const projectActivitySchema = z.object({
  projectId: idSchema.nullable(),
  running: z.number().int().nonnegative(),
  runningAgents: z.array(z.string()),
  /** Sessions with `needs-you` attention. */
  attention: z.array(idSchema),
  /** Sessions with `unseen` attention. */
  unseen: z.array(idSchema),
});
export type ProjectActivity = z.infer<typeof projectActivitySchema>;
/** Idle projects are omitted. */
export const activitySummarySchema = z.object({ projects: z.array(projectActivitySchema) });
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

export const searchMessagesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  projectId: idSchema.optional(),
  limit: limitQuery(30, 100),
});
export const messageSearchHitSchema = z.object({
  sessionId: idSchema,
  projectId: idSchema.nullable(),
  title: z.string(),
  /** The event to jump to. */
  seq: z.number().int().positive(),
  role: z.enum(['user', 'assistant']),
  snippet: z.string(),
  /** Where the match sits inside `snippet`; -1 when it could not be located. */
  matchStart: z.number().int(),
  matchLength: z.number().int().nonnegative(),
  at: timestampSchema,
});
export type MessageSearchHit = z.infer<typeof messageSearchHitSchema>;
export const messageSearchResponseSchema = z.object({ hits: z.array(messageSearchHitSchema) });

// ---------------------------------------------------------------------------
// Runs, sending, queue
// ---------------------------------------------------------------------------

export const runErrorSchema = z.object({ code: z.string(), message: z.string() });
export type RunError = z.infer<typeof runErrorSchema>;

export const runSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  projectId: idSchema.nullable(),
  userId: idSchema,
  agentId: z.string(),
  requestId: z.string(),
  origin: runOriginSchema,
  unattended: z.boolean(),
  status: runStatusSchema,
  /** The user's request, as typed. */
  text: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: permissionModeSchema,
  error: runErrorSchema.nullable(),
  /** The server stopped while this run was in progress. Part of the work may have been done. */
  interruptedByRestart: z.boolean(),
  /** The failed or interrupted run this one continues. */
  continuesRunId: idSchema.nullable(),
  /** Set once on a failed or interrupted run when it has been continued. */
  continuedByRunId: idSchema.nullable(),
  /** When a failed or interrupted run was dismissed. */
  dismissedAt: timestampSchema.nullable(),
  /** When a finished run's result was seen (never set automatically for failed or interrupted runs). */
  seenAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const requestIdSchema = z.string().min(1).max(AGENT_LIMITS.requestIdChars);

/**
 * What to do when the session already has a run in progress:
 * `queue`  hold the message on the server and send it as the next turn (default);
 * `steer`  inject it into the running turn if the agent can take it, otherwise queue it;
 * `reject` refuse with `session_busy` and record nothing.
 */
export const whenBusySchema = z.enum(['queue', 'steer', 'reject']);
export type WhenBusy = z.infer<typeof whenBusySchema>;

export const sendMessageRequestSchema = z
  .object({
    requestId: requestIdSchema,
    text: z.string().max(AGENT_LIMITS.messageChars).default(''),
    attachmentIds: z.array(idSchema).max(AGENT_LIMITS.attachmentsPerMessage).default([]),
    /** Text the user selected in an earlier message; goes out above this message. */
    quote: z.string().max(AGENT_LIMITS.quoteChars).optional(),
    /** These become the session's recorded choice. */
    model: agentModelSchema.optional(),
    effort: agentEffortSchema.optional(),
    permissionMode: permissionModeSchema.optional(),
    whenBusy: whenBusySchema.default('queue'),
  })
  .refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0, {
    message: 'A message needs text or an attachment.',
    path: ['text'],
  });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const messageReceiptSchema = z.object({
  requestId: z.string(),
  sessionId: idSchema,
  /** `run`: it started a run. `queued`: it waits its turn. `steered`: the running turn took it. */
  disposition: z.enum(['run', 'queued', 'steered']),
  /** The run it started or was steered into; for a queued message, set once it is sent. */
  runId: idSchema.nullable(),
  /** Set while the message is still in the queue. */
  queueItemId: idSchema.nullable(),
  /** True when this request id had been accepted before; nothing was executed again. */
  duplicate: z.boolean(),
  /** The current state of `runId`. */
  run: runSchema.nullable(),
  acceptedAt: timestampSchema,
});
export type MessageReceipt = z.infer<typeof messageReceiptSchema>;

export const queuedMessageSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  requestId: z.string(),
  text: z.string(),
  attachments: z.array(attachmentRefSchema),
  quote: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/** In send order. */
export const queueSchema = z.object({ queue: z.array(queuedMessageSchema) });
export const editQueuedMessageRequestSchema = z.object({ text: z.string().trim().min(1).max(AGENT_LIMITS.messageChars) });

/**
 * `steered`      the running turn took the message;
 * `interrupted`  the running turn was stopped and this message is the next turn;
 * `next`         the message is first in line: sent at once when nothing was running (`runId` is set),
 *                or as soon as a turn that could not take it ends (`runId` is null).
 */
export const sendNowResponseSchema = z.object({
  outcome: z.enum(['steered', 'interrupted', 'next']),
  runId: idSchema.nullable(),
});
export type SendNowResponse = z.infer<typeof sendNowResponseSchema>;

export const stopRunResponseSchema = z.object({ run: runSchema });

export const listRunsQuerySchema = z.object({
  /** `unresolved`: failed or interrupted runs that were neither continued nor dismissed (the recovery list). */
  state: z.enum(['unresolved', 'active', 'all']).default('unresolved'),
  projectId: idSchema.optional(),
  sessionId: idSchema.optional(),
  limit: limitQuery(50, 100),
});
export const runListSchema = z.object({ runs: z.array(runSchema) });

export const continueRunRequestSchema = z.object({ requestId: requestIdSchema });
export const dismissRunResponseSchema = z.object({ run: runSchema, alreadyHandled: z.boolean() });

// ---------------------------------------------------------------------------
// Approvals and permission rules
// ---------------------------------------------------------------------------

export const approvalKindSchema = z.enum(['tool', 'plan', 'question']);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const approvalStatusSchema = z.enum(['pending', 'allowed', 'denied', 'expired', 'cancelled']);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  /** The agent's own recommendation; the only thing an automatic answer may pick. */
  recommended: z.boolean().optional(),
});
export const questionSchema = z.object({
  id: z.string(),
  /** A short topic label. */
  header: z.string().optional(),
  question: z.string(),
  options: z.array(questionOptionSchema),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionAnswerSchema = z.object({
  questionId: z.string().max(200),
  /** Labels of the chosen options. */
  selected: z.array(z.string().max(2000)).max(50).default([]),
  /** Free text typed under "Other". */
  other: z.string().max(10_000).optional(),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export const ruleScopeSchema = z.enum(['account', 'project', 'session']);
export type RuleScope = z.infer<typeof ruleScopeSchema>;
export const ruleEffectSchema = z.enum(['allow', 'deny', 'ask']);
export type RuleEffect = z.infer<typeof ruleEffectSchema>;

/** `*` matches any run of characters. Tool names are case-sensitive. */
export const ruleToolSchema = z.string().trim().min(1).max(200);
/**
 * A glob over what the tool acts on. For commands, `*` matches any text and a
 * trailing ` *` also matches no arguments at all (`git status *` covers
 * `git status` and `git status -s`, not `git statusx`). For files, `*` stays
 * within one path segment, `**` crosses segments, and a pattern without a
 * slash is matched against the file name. Omit to match every use of the tool.
 */
export const rulePatternSchema = z.string().trim().min(1).max(2000);

export const permissionRuleSchema = z.object({
  id: idSchema,
  scope: ruleScopeSchema,
  projectId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  effect: ruleEffectSchema,
  tool: z.string(),
  pattern: z.string().nullable(),
  /** A project `deny` or `ask` rule set by the owner for everyone working in the project. */
  shared: z.boolean(),
  createdBy: idSchema,
  createdAt: timestampSchema,
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const createPermissionRuleRequestSchema = z
  .object({
    scope: ruleScopeSchema,
    projectId: idSchema.optional(),
    sessionId: idSchema.optional(),
    effect: ruleEffectSchema,
    tool: ruleToolSchema,
    pattern: rulePatternSchema.optional(),
    shared: z.boolean().default(false),
  })
  .refine((value) => value.scope !== 'project' || value.projectId !== undefined, {
    message: 'A project rule needs a projectId.',
    path: ['projectId'],
  })
  .refine((value) => value.scope !== 'session' || value.sessionId !== undefined, {
    message: 'A session rule needs a sessionId.',
    path: ['sessionId'],
  });
export type CreatePermissionRuleRequest = z.infer<typeof createPermissionRuleRequestSchema>;

export const listPermissionRulesQuerySchema = z.object({
  scope: ruleScopeSchema.optional(),
  projectId: idSchema.optional(),
  sessionId: idSchema.optional(),
});
export const permissionRuleListSchema = z.object({ rules: z.array(permissionRuleSchema) });

export const approvalSchema = z.object({
  id: idSchema,
  runId: idSchema,
  sessionId: idSchema,
  projectId: idSchema.nullable(),
  /** Whose run is asking. */
  userId: idSchema,
  kind: approvalKindSchema,
  toolName: z.string().nullable(),
  toolKind: toolKindSchema.nullable(),
  toolCallId: z.string().nullable(),
  /** What is being asked, in words. */
  title: z.string(),
  /** The exact command, for tools that run one. */
  command: z.string().nullable(),
  /** Files the tool reads or changes. */
  paths: z.array(z.string()),
  /** A preview of the change, for edits. */
  diff: z.string().nullable(),
  /** The tool's arguments (bounded). */
  input: z.unknown(),
  /** The plan to approve (`kind: 'plan'`). */
  plan: z.string().nullable(),
  /** The questions to answer (`kind: 'question'`). */
  questions: z.array(questionSchema).nullable(),
  risk: riskClassSchema,
  riskCategories: z.array(riskCategorySchema),
  /** Why the server is asking. */
  reason: z.string(),
  /** A dangerous request: only the instance owner may allow it. */
  requiresOwner: z.boolean(),
  /** The rule "allow and remember" would save; null when remembering is not offered. */
  suggestedRule: z.object({ tool: z.string(), pattern: z.string().nullable() }).nullable(),
  status: approvalStatusSchema,
  decidedBy: idSchema.nullable(),
  decidedAt: timestampSchema.nullable(),
  /** The decider's note (the reason given to the agent on a denial; the revision note for a plan). */
  note: z.string().nullable(),
  /** The answers given to a question. */
  answers: z.array(questionAnswerSchema).nullable(),
  /** When the server will resolve it by itself (deny; for a question, the recommended options). Null: never. */
  expiresAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Approval = z.infer<typeof approvalSchema>;

export const approvalDecisionRequestSchema = z.object({
  /** For a question, `allow` submits `answers` and `deny` skips it. */
  decision: z.enum(['allow', 'deny']),
  note: z.string().max(4000).optional(),
  /** Also save a rule so the same request is not asked again: for this session, this project, or always. */
  remember: z.enum(['session', 'project', 'always']).optional(),
  answers: z.array(questionAnswerSchema).max(20).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

export const approvalDecisionResponseSchema = z.object({
  approval: approvalSchema,
  /** The rule that was saved, when `remember` was given. */
  rule: permissionRuleSchema.nullable(),
  /** Other pending approvals the saved rule answered at the same time. */
  alsoResolved: z.array(idSchema),
});
export type ApprovalDecisionResponse = z.infer<typeof approvalDecisionResponseSchema>;

export const listApprovalsQuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  sessionId: idSchema.optional(),
  limit: limitQuery(50, 200),
});
export const approvalListSchema = z.object({ approvals: z.array(approvalSchema) });

/** Per-project switches of the agent runtime. Only the instance owner may change them. */
export const agentProjectSettingsSchema = z.object({
  /** Whether sessions in this project may really use the `auto` permission mode. */
  autoMode: z.boolean(),
});
export type AgentProjectSettings = z.infer<typeof agentProjectSettingsSchema>;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const modelUsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Null when the agent does not report cost. */
  costUsd: z.number().nonnegative().nullable(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const sessionUsageSchema = z.object({
  /** How full the context window is after the newest reported request. Null until the agent reports it. */
  context: z
    .object({
      tokens: z.number().int().nonnegative(),
      /** Null when the window is not known — never guessed. */
      window: z.number().int().positive().nullable(),
      model: z.string(),
      at: timestampSchema,
    })
    .nullable(),
  /** Everything this session has used, per model. */
  totals: z.array(modelUsageSchema),
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;

// ---------------------------------------------------------------------------
// Durable session events (stored, numbered)
// ---------------------------------------------------------------------------

export const fileDiffSchema = z.object({
  path: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Unified diff text, when the agent provides one. */
  patch: z.string().optional(),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

export const todoItemSchema = z.object({
  text: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const messageUserDataSchema = z.object({
  runId: idSchema,
  requestId: z.string(),
  /** `steer`: taken into a turn that was already running. */
  origin: z.enum(['interactive', 'queued', 'steer', 'continue', 'scheduled', 'automation']),
  text: z.string(),
  attachments: z.array(attachmentRefSchema),
  quote: z.string().nullable(),
  /** For a continuation: the failed or interrupted run it continues. */
  continuesRunId: idSchema.nullable(),
});
export const runStartedDataSchema = z.object({
  runId: idSchema,
  agentId: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  /** The mode the run actually uses. */
  permissionMode: permissionModeSchema,
  origin: runOriginSchema,
});
export const messageAssistantDataSchema = z.object({
  runId: idSchema,
  messageId: z.string(),
  text: z.string(),
  /** The model that answered, when known. */
  model: z.string().nullable(),
  /** Set for text produced by a sub-agent: the tool call that spawned it. */
  parentToolCallId: z.string().nullable(),
  /** The run ended before this block was complete. */
  partial: z.boolean(),
});
export const thinkingDataSchema = z.object({
  runId: idSchema,
  messageId: z.string(),
  text: z.string(),
  parentToolCallId: z.string().nullable(),
  partial: z.boolean(),
});
export const toolStartedDataSchema = z.object({
  runId: idSchema,
  toolCallId: z.string(),
  name: z.string(),
  kind: toolKindSchema,
  /** A short human description, e.g. "Run npm test" or "Edit src/app.ts". */
  title: z.string(),
  input: z.unknown(),
  /** The input was too large and has been shortened. */
  inputTruncated: z.boolean(),
  parentToolCallId: z.string().nullable(),
});
export const toolFinishedDataSchema = z.object({
  runId: idSchema,
  toolCallId: z.string(),
  /** `denied` is a refusal by the permission engine or a person, distinct from a tool that failed. */
  status: z.enum(['ok', 'error', 'denied']),
  output: z.string(),
  /** Characters removed from the middle of `output` to keep it bounded; 0 when it is complete. */
  outputOmittedChars: z.number().int().nonnegative(),
  diffs: z.array(fileDiffSchema),
  /** Diff text was dropped to keep the event bounded (the counts are intact). */
  diffsTruncated: z.boolean(),
});
export const todosUpdatedDataSchema = z.object({ runId: idSchema, items: z.array(todoItemSchema) });
export const usageReportedDataSchema = z.object({
  runId: idSchema,
  model: z.string(),
  /** The run's totals for this model so far. */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  contextTokens: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive().nullable(),
});
export const noticeDataSchema = z.object({
  runId: idSchema.nullable(),
  level: z.enum(['info', 'warning', 'error']),
  /** Stable and machine-readable, e.g. `compaction`, `rate_limit`, `approval_skipped`. */
  code: z.string(),
  text: z.string(),
});
export const approvalRequestedDataSchema = z.object({ runId: idSchema, approval: approvalSchema });
export const approvalResolvedDataSchema = z.object({
  runId: idSchema,
  approvalId: idSchema,
  status: approvalStatusSchema,
  decidedBy: idSchema.nullable(),
  note: z.string().nullable(),
  answers: z.array(questionAnswerSchema).nullable(),
});
export const runFinishedDataSchema = z.object({
  runId: idSchema,
  status: terminalRunStatusSchema,
  error: runErrorSchema.nullable(),
  interruptedByRestart: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export const SESSION_EVENT = {
  messageUser: 'message.user',
  runStarted: 'run.started',
  messageAssistant: 'message.assistant',
  thinking: 'thinking',
  toolStarted: 'tool.started',
  toolFinished: 'tool.finished',
  todosUpdated: 'todos.updated',
  usageReported: 'usage.reported',
  notice: 'notice',
  approvalRequested: 'approval.requested',
  approvalResolved: 'approval.resolved',
  runFinished: 'run.finished',
} as const;

const durable = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ seq: z.number().int().positive(), type: z.literal(type), data, at: timestampSchema });

/** One entry of a session's log. `run.finished` is the only terminal event and occurs exactly once per run. */
export const sessionEventSchema = z.discriminatedUnion('type', [
  durable(SESSION_EVENT.messageUser, messageUserDataSchema),
  durable(SESSION_EVENT.runStarted, runStartedDataSchema),
  durable(SESSION_EVENT.messageAssistant, messageAssistantDataSchema),
  durable(SESSION_EVENT.thinking, thinkingDataSchema),
  durable(SESSION_EVENT.toolStarted, toolStartedDataSchema),
  durable(SESSION_EVENT.toolFinished, toolFinishedDataSchema),
  durable(SESSION_EVENT.todosUpdated, todosUpdatedDataSchema),
  durable(SESSION_EVENT.usageReported, usageReportedDataSchema),
  durable(SESSION_EVENT.notice, noticeDataSchema),
  durable(SESSION_EVENT.approvalRequested, approvalRequestedDataSchema),
  durable(SESSION_EVENT.approvalResolved, approvalResolvedDataSchema),
  durable(SESSION_EVENT.runFinished, runFinishedDataSchema),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
export type SessionEventData<T extends SessionEventType> = Extract<SessionEvent, { type: T }>['data'];

export const listEventsQuerySchema = z
  .object({
    /** Events with a greater `seq`, oldest first (catching up). */
    after: z.coerce.number().int().min(0).optional(),
    /** Events with a smaller `seq`: the page just before it, returned oldest first (paging back). */
    before: z.coerce.number().int().min(1).optional(),
    limit: limitQuery(200, 1000),
  })
  .refine((value) => value.after === undefined || value.before === undefined, { message: 'Use after or before, not both.' });

export const eventPageSchema = z.object({
  /** Always oldest first. */
  events: z.array(sessionEventSchema),
  /** More events exist in the direction that was asked for. */
  hasMore: z.boolean(),
  /** The newest `seq` in the session at the time of the read. */
  lastSeq: z.number().int().nonnegative(),
});
export type EventPage = z.infer<typeof eventPageSchema>;

// ---------------------------------------------------------------------------
// Live session events (not stored, no seq) and the snapshot
// ---------------------------------------------------------------------------

export const LIVE_EVENT = {
  messageDelta: 'message.delta',
  thinkingDelta: 'thinking.delta',
  toolOutput: 'tool.output',
  queueChanged: 'queue.changed',
  sessionUpdated: 'session.updated',
} as const;

export const textDeltaDataSchema = z.object({
  runId: idSchema,
  messageId: z.string(),
  /** Length of the block before this delta: apply the delta only if it equals what you hold. */
  offset: z.number().int().nonnegative(),
  text: z.string(),
  parentToolCallId: z.string().nullable(),
});
export const toolOutputDataSchema = z.object({ runId: idSchema, toolCallId: z.string(), text: z.string() });
export const queueChangedDataSchema = z.object({
  queue: z.array(queuedMessageSchema),
  /** Set when the change is the server taking an item to send it. */
  taken: z.object({ itemId: idSchema, runId: idSchema }).nullable(),
});
export const sessionUpdatedDataSchema = z.object({ session: sessionSchema });

const live = <T extends string, D extends z.ZodType>(type: T, data: D) => z.object({ type: z.literal(type), data });
export const liveSessionEventSchema = z.discriminatedUnion('type', [
  live(LIVE_EVENT.messageDelta, textDeltaDataSchema),
  live(LIVE_EVENT.thinkingDelta, textDeltaDataSchema),
  live(LIVE_EVENT.toolOutput, toolOutputDataSchema),
  live(LIVE_EVENT.queueChanged, queueChangedDataSchema),
  live(LIVE_EVENT.sessionUpdated, sessionUpdatedDataSchema),
]);
export type LiveSessionEvent = z.infer<typeof liveSessionEventSchema>;

/** Handed to every new subscriber of `session:<id>`, and readable at `GET /api/sessions/:id/state`. */
export const sessionSnapshotSchema = z.object({
  sessionId: idSchema,
  /** Durable events up to here exist; live events you receive after the snapshot have a greater `seq`. */
  lastSeq: z.number().int().nonnegative(),
  /** The run in progress. */
  run: runSchema.nullable(),
  /** Blocks being streamed that are not durable yet, with the text so far. */
  streaming: z.array(
    z.object({
      messageId: z.string(),
      kind: z.enum(['text', 'thinking']),
      text: z.string(),
      parentToolCallId: z.string().nullable(),
    }),
  ),
  /** The newest output of tools still running (a bounded tail). */
  toolOutput: z.array(z.object({ toolCallId: z.string(), text: z.string() })),
  pendingApprovals: z.array(approvalSchema),
  queue: z.array(queuedMessageSchema),
  /** Failed or interrupted runs of this session that were neither continued nor dismissed. */
  unresolvedRuns: z.array(runSchema),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Events on the caller's own `user:<id>` topic
// ---------------------------------------------------------------------------

export const USER_AGENT_EVENT = {
  sessionCreated: 'session.created',
  sessionUpdated: 'session.updated',
  sessionRemoved: 'session.removed',
  draftChanged: 'session.draft',
  runStarted: 'run.started',
  runFinished: 'run.finished',
  approvalPending: 'approval.pending',
  approvalResolved: 'approval.resolved',
} as const;

const runRefSchema = z.object({ runId: idSchema, sessionId: idSchema, projectId: idSchema.nullable(), agentId: z.string() });

export const userAgentEventSchema = z.discriminatedUnion('type', [
  live(USER_AGENT_EVENT.sessionCreated, z.object({ session: sessionSchema })),
  /** Renamed (also automatically), pinned, archived, attention mark changed, model or mode changed. */
  live(USER_AGENT_EVENT.sessionUpdated, z.object({ session: sessionSchema })),
  live(USER_AGENT_EVENT.sessionRemoved, z.object({ sessionId: idSchema, projectId: idSchema.nullable() })),
  live(USER_AGENT_EVENT.draftChanged, draftSchema),
  live(USER_AGENT_EVENT.runStarted, runRefSchema),
  live(USER_AGENT_EVENT.runFinished, runRefSchema.extend({ status: terminalRunStatusSchema })),
  /** Also sent to instance owners when a member's request needs an owner. */
  live(USER_AGENT_EVENT.approvalPending, z.object({ approval: approvalSchema })),
  live(
    USER_AGENT_EVENT.approvalResolved,
    z.object({ approvalId: idSchema, sessionId: idSchema, runId: idSchema, status: approvalStatusSchema }),
  ),
]);
export type UserAgentEvent = z.infer<typeof userAgentEventSchema>;

export const sessionTopic = (sessionId: string) => `session:${sessionId}`;
