import { z } from 'zod';
import {
  AGENT_LIMITS,
  agentEffortSchema,
  agentModelSchema,
  messageReceiptSchema,
  modelUsageSchema,
  permissionModeSchema,
  requestIdSchema,
  runErrorSchema,
  runOriginSchema,
  sessionSchema,
} from './agents.js';
import { idSchema, limitQuery, timestampSchema } from './common.js';

/**
 * Wire contracts of working with more than one agent: handing a conversation
 * from one agent to another, giving one task to several agents at once, and
 * seeing everything that runs.
 *
 * ## Handoff
 *
 * `POST /api/sessions/:sessionId/handoff` continues a conversation with
 * another agent. The server creates a new session with that agent in the same
 * project, links it to the source (`parentSessionId`, `chainId` — the agent
 * runtime's own fields) and gives the new agent a **brief**: background the
 * server writes from the record of the source conversation. A client never
 * supplies the brief and cannot change it.
 *
 * The brief is either a **digest** — built by rule from the source's stored
 * events, no model involved — or, when the caller asks for it and names an
 * agent to write it, a **summary** that agent wrote from the digest. A summary
 * that cannot be written (the agent is unavailable, fails, or takes too long)
 * never fails the handoff: the digest is used and {@link handoffSummarySchema}
 * says why.
 *
 * Both sessions get a `notice` in their transcript: `handoff_received` in the
 * new one (its text is the brief, as the new agent was given it), and
 * `handoff_sent` in the source. `GET /api/sessions/:sessionId/handoffs`
 * returns the records behind those notices, with the `seq` of each, so a
 * client can show them as more than a line of text.
 *
 * The new agent receives the brief in front of the first message it gets in
 * the new session, between markers it cannot have written itself, with a
 * statement that it is background and not an instruction. The transcript
 * keeps the person's own words.
 *
 * ## Chains
 *
 * Sessions that continue one another form a chain. `GET
 * /api/sessions/:sessionId/chain` returns it in order, so that a client can
 * show it as one conversation. Only the newest session of a chain can be
 * handed on.
 *
 * ## Multi-agent tasks
 *
 * `POST /api/projects/:projectId/tasks` gives one prompt to two to six agents,
 * each in a session of its own, and tracks them as one task. With `isolation:
 * 'shared'` they all work in the project's folder and therefore only in
 * `plan` mode (reading). With `isolation: 'worktrees'` each gets a Git
 * worktree and branch of its own — which only the instance owner can create —
 * and may use any permission mode. An optional **synthesis** compares the
 * answers once everybody has finished. Nothing is ever merged automatically.
 *
 * Live updates arrive on the caller's `user:<id>` topic as {@link CollabEvent}s.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const COLLAB_LIMITS = {
  /** Characters of the note that goes out with a handoff. */
  noteChars: 4000,
  /** Characters of a handoff brief (digest or summary, with what it carries along), before framing. */
  briefChars: 8000,
  /** Characters of a model-written summary that are kept. */
  summaryChars: 4000,
  taskTitleChars: 120,
  /** Characters of a task's prompt. */
  taskPromptChars: 32_000,
  minParticipants: 2,
  maxParticipants: 6,
  /** Tasks one user may have in progress at a time. */
  runningTasksPerUser: 3,
  /** Characters of a participant's final answer returned with a task. */
  answerChars: 8000,
  /** Changed files listed per worktree. */
  changedFiles: 50,
  taskListDefault: 20,
  taskListMax: 50,
  /** Runs listed by `GET /api/work/running`. */
  runningRuns: 100,
} as const;

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export const handoffRequestSchema = z.strictObject({
  /** Chosen by the client. Sending it again returns the handoff it made the first time. */
  requestId: requestIdSchema,
  /** The agent that continues. It must differ from the source's: changing only the model needs no handoff. */
  agentId: z.string().min(1).max(80),
  model: agentModelSchema.optional(),
  effort: agentEffortSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  /** The person's own words for the new agent: sent as the first message when `start` is true, left as the draft otherwise. */
  note: z.string().max(COLLAB_LIMITS.noteChars).optional(),
  /**
   * True: send the first message at once (the note, or {@link HANDOFF_DEFAULT_MESSAGE} without one).
   * False: create the session with its brief and leave the composer to the person.
   */
  start: z.boolean().default(false),
  /** Ask an agent to write the brief from the digest. Without it the digest itself is the brief. */
  summary: z.strictObject({ agentId: z.string().min(1).max(80), model: agentModelSchema.optional() }).optional(),
});
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;
export type HandoffInput = z.input<typeof handoffRequestSchema>;

/** What is sent as the first message when a handoff starts without a note. */
export const HANDOFF_DEFAULT_MESSAGE = 'Please continue from where the earlier conversation left off.';

/** The `code` of the notices a handoff writes into the two transcripts. */
export const HANDOFF_NOTICE = {
  /** In the new session. Its text is the brief the new agent was given. */
  received: 'handoff_received',
  /** In the source session. */
  sent: 'handoff_sent',
} as const;

/**
 * `not-requested`  the digest was asked for and is the brief.
 * `written`        the named agent wrote the summary; it is the brief.
 * `unavailable`    the agent is not registered, not offered in the project, not signed in, or cannot run read-only.
 * `failed`         its run ended without a usable answer.
 * `timed-out`      it did not answer in time and was stopped.
 * In the last three cases the digest is the brief and `reason` says what happened.
 */
export const handoffSummarySchema = z.object({
  requested: z.boolean(),
  status: z.enum(['not-requested', 'written', 'unavailable', 'failed', 'timed-out']),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  model: z.string().nullable(),
  /** One sentence in English; null for `not-requested` and `written`. */
  reason: z.string().nullable(),
});
export type HandoffSummary = z.infer<typeof handoffSummarySchema>;

const handoffEndSchema = z.object({
  /** Null when the session has been deleted since. */
  sessionId: idSchema.nullable(),
  agentId: z.string(),
  agentName: z.string(),
  model: z.string().nullable(),
  /** The `seq` of the handoff notice in that session's log. */
  noticeSeq: z.number().int().positive().nullable(),
});

export const handoffSchema = z.object({
  id: idSchema,
  projectId: idSchema.nullable(),
  /** Who handed over, and when. */
  by: z.object({ userId: idSchema, displayName: z.string() }),
  at: timestampSchema,
  source: handoffEndSchema.extend({ title: z.string() }),
  target: handoffEndSchema,
  brief: z.object({
    /** What the brief is made of. */
    kind: z.enum(['digest', 'summary']),
    /** The brief as the new agent was given it, without the markers around it. Markdown; credentials removed. */
    text: z.string(),
  }),
  summary: handoffSummarySchema,
  /** The person's note, as it was sent or left in the composer. */
  note: z.string().nullable(),
  /** Whether the first message was sent with the handoff. */
  started: z.boolean(),
  /** The run that first message started. */
  firstRunId: idSchema.nullable(),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const handoffResponseSchema = z.object({
  handoff: handoffSchema,
  /** The new session. */
  session: sessionSchema,
  /** The receipt of the first message, when `start` was true. */
  receipt: messageReceiptSchema.nullable(),
  /** True when this request id had made the handoff before; nothing was done again. */
  duplicate: z.boolean(),
  /**
   * Set when `start` was asked for and the first message could not be sent:
   * the session exists with its brief, and the note waits in its composer.
   */
  startProblem: z.string().nullable(),
});
export type HandoffResponse = z.infer<typeof handoffResponseSchema>;

/** The handoffs a session took part in. */
export const sessionHandoffsSchema = z.object({
  /** The handoff this session began with, if it continues another. */
  incoming: handoffSchema.nullable(),
  /** The handoffs that continued this session elsewhere, oldest first. */
  outgoing: z.array(handoffSchema),
});
export type SessionHandoffs = z.infer<typeof sessionHandoffsSchema>;

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export const chainEntrySchema = z.object({
  /** The session: its agent, model, title, attention mark and run in progress. */
  session: sessionSchema,
  agentName: z.string(),
  /** The session the chain was asked for. */
  current: z.boolean(),
  /** The newest session of the chain: the only one that can be handed on. */
  latest: z.boolean(),
  /** The session before it among those that still exist. */
  previousSessionId: idSchema.nullable(),
  /** The session it was handed over from has been deleted: something is missing in front of it. */
  gapBefore: z.boolean(),
  /** The handoff that began it. Null for the first session and for one created without a brief. */
  handoff: z
    .object({
      id: idSchema,
      at: timestampSchema,
      by: z.object({ userId: idSchema, displayName: z.string() }),
      briefKind: z.enum(['digest', 'summary']),
      noticeSeq: z.number().int().positive().nullable(),
    })
    .nullable(),
});
export type ChainEntry = z.infer<typeof chainEntrySchema>;

export const chainSchema = z.object({
  /** The id the sessions share: that of the session the chain started from (which may be gone). */
  chainId: idSchema,
  /** Oldest first. A session that was never handed over is a chain of one. */
  sessions: z.array(chainEntrySchema),
  /** A run is in progress somewhere in the chain. */
  running: z.boolean(),
});
export type Chain = z.infer<typeof chainSchema>;

// ---------------------------------------------------------------------------
// Multi-agent tasks
// ---------------------------------------------------------------------------

/** `shared`: everybody works in the project's folder, reading only. `worktrees`: each in a Git worktree of its own. */
export const taskIsolationSchema = z.enum(['shared', 'worktrees']);
export type TaskIsolation = z.infer<typeof taskIsolationSchema>;

export const taskParticipantInputSchema = z.strictObject({
  agentId: z.string().min(1).max(80),
  model: agentModelSchema.optional(),
  effort: agentEffortSchema.optional(),
  /**
   * With `shared` isolation only `plan` is accepted (and is the default):
   * several agents editing one folder at once would overwrite each other.
   * With `worktrees` any mode the agent has; its usual default when absent.
   */
  permissionMode: permissionModeSchema.optional(),
});
export type TaskParticipantInput = z.infer<typeof taskParticipantInputSchema>;

export const createTaskRequestSchema = z.strictObject({
  /** Chosen by the client. Sending it again returns the task it made the first time. */
  requestId: requestIdSchema,
  /** A name for the task; taken from the prompt when absent. */
  title: z.string().trim().min(1).max(COLLAB_LIMITS.taskTitleChars).optional(),
  prompt: z
    .string()
    .max(COLLAB_LIMITS.taskPromptChars)
    .refine((value) => value.trim().length > 0, 'A task needs a prompt.'),
  /**
   * Files the caller uploaded to one of their sessions and has not sent yet.
   * Every participant gets a copy of its own; the originals stay where they are.
   */
  attachmentIds: z.array(idSchema).max(AGENT_LIMITS.attachmentsPerMessage).default([]),
  participants: z.array(taskParticipantInputSchema).min(COLLAB_LIMITS.minParticipants).max(COLLAB_LIMITS.maxParticipants),
  isolation: taskIsolationSchema.default('shared'),
  /** One more agent that compares the answers when all participants have finished. It runs in `plan` mode. */
  synthesis: z.strictObject({ agentId: z.string().min(1).max(80), model: agentModelSchema.optional() }).optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type CreateTaskInput = z.input<typeof createTaskRequestSchema>;

/**
 * `running`          somebody is working and nothing waits for the person.
 * `needs-attention`  a participant waits for an approval, or one failed or was
 *                    interrupted and that has neither been continued nor
 *                    dismissed (in its session, or in the inbox).
 * `completed`        everybody has finished and no failure is left unresolved.
 * `stopped`          the task was stopped, or every participant was.
 */
export const taskStateSchema = z.enum(['running', 'needs-attention', 'completed', 'stopped']);
export type TaskState = z.infer<typeof taskStateSchema>;

/**
 * `starting`          its session exists; its run has not begun.
 * `running`           its run is in progress.
 * `waiting-approval`  its run waits for a person (a tool, a plan, a question).
 * `completed` | `failed` | `stopped` | `interrupted`  how its run ended.
 *                     `interrupted`: the server restarted during the run; nothing is run again by itself.
 */
export const participantStateSchema = z.enum(['starting', 'running', 'waiting-approval', 'completed', 'failed', 'stopped', 'interrupted']);
export type ParticipantState = z.infer<typeof participantStateSchema>;

export const taskAnswerSchema = z.object({
  /** The last thing the agent said in its run. */
  text: z.string(),
  /** It was longer than {@link COLLAB_LIMITS.answerChars} and has been cut. */
  truncated: z.boolean(),
  /** The run ended before the agent had finished saying it. */
  partial: z.boolean(),
});
export type TaskAnswer = z.infer<typeof taskAnswerSchema>;

export const taskWorktreeSchema = z.object({
  branch: z.string(),
  /** The project the worktree is registered as: where the participant's session lives. */
  projectId: idSchema,
  /**
   * What differs from the commit the worktree started at — committed or not.
   * Only on `GET /api/tasks/:taskId`; null in lists, and when it could not be read (`changesError` says why).
   */
  changes: z
    .object({
      files: z.array(z.object({ path: z.string(), status: z.string(), additions: z.number().int().nullable(), deletions: z.number().int().nullable() })),
      /** Files changed in all; `files` lists at most {@link COLLAB_LIMITS.changedFiles}. */
      total: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .nullable(),
  changesError: z.string().nullable(),
});
export type TaskWorktree = z.infer<typeof taskWorktreeSchema>;

export const taskParticipantSchema = z.object({
  /** 1-based, in the order the request named them. */
  position: z.number().int().positive(),
  agentId: z.string(),
  agentName: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: permissionModeSchema,
  /** Null once the session has been deleted. */
  sessionId: idSchema.nullable(),
  /** The project its session lives in: the task's, or the worktree's. */
  sessionProjectId: idSchema.nullable(),
  /** The participant's run; after a continuation, the newest one. */
  runId: idSchema.nullable(),
  /** Where the session opens in the app. */
  link: z.string().nullable(),
  state: participantStateSchema,
  /** A failed or interrupted run that was dismissed: it no longer asks for attention. */
  acknowledged: z.boolean(),
  error: runErrorSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Only on `GET /api/tasks/:taskId`; null in lists and until the run has ended. */
  answer: taskAnswerSchema.nullable(),
  /** What its session used, per model. Only on `GET /api/tasks/:taskId`. */
  usage: z.array(modelUsageSchema).nullable(),
  worktree: taskWorktreeSchema.nullable(),
});
export type TaskParticipant = z.infer<typeof taskParticipantSchema>;

/**
 * `pending`  waits for the participants to finish.
 * `skipped`  was not started: `note` says why (nobody produced an answer, the task was stopped, the server restarted).
 * The other states are a participant's. A synthesis that fails does not fail the task.
 */
export const synthesisStateSchema = z.enum(['pending', 'skipped', ...participantStateSchema.options]);
export type SynthesisState = z.infer<typeof synthesisStateSchema>;

export const taskSynthesisSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  model: z.string().nullable(),
  state: synthesisStateSchema,
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  link: z.string().nullable(),
  error: runErrorSchema.nullable(),
  /** Why it was skipped or could not start. */
  note: z.string().nullable(),
  /** The comparison and recommendation. Only on `GET /api/tasks/:taskId`. */
  answer: taskAnswerSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
});
export type TaskSynthesis = z.infer<typeof taskSynthesisSchema>;

export const taskSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  /** Who created it. */
  userId: idSchema,
  title: z.string(),
  /** The whole prompt on `GET /api/tasks/:taskId`; its first 240 characters in lists and events. */
  prompt: z.string(),
  promptTruncated: z.boolean(),
  isolation: taskIsolationSchema,
  state: taskStateSchema,
  participants: z.array(taskParticipantSchema),
  synthesis: taskSynthesisSchema.nullable(),
  /** When "stop" was pressed. */
  stoppedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** When it reached `completed` or `stopped`. */
  finishedAt: timestampSchema.nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const createTaskResponseSchema = z.object({
  task: taskSchema,
  /** True when this request id had created the task before; nothing was started again. */
  duplicate: z.boolean(),
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

export const listTasksQuerySchema = z.object({
  state: z.enum(['open', 'all']).default('all'),
  /** `all` lets the instance owner list every user's tasks; members always get their own. */
  scope: z.enum(['mine', 'all']).default('mine'),
  limit: limitQuery(COLLAB_LIMITS.taskListDefault, COLLAB_LIMITS.taskListMax),
  /** The id of the last task of the previous page. */
  before: idSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const taskListSchema = z.object({
  /** Newest first. */
  tasks: z.array(taskSchema),
  hasMore: z.boolean(),
});
export type TaskList = z.infer<typeof taskListSchema>;

export const deleteTaskResponseSchema = z.object({
  deleted: z.literal(true),
  /** The task's sessions are not deleted with it: these still exist. */
  sessionsKept: z.array(idSchema),
});
export type DeleteTaskResponse = z.infer<typeof deleteTaskResponseSchema>;

// ---------------------------------------------------------------------------
// Running work at a glance
// ---------------------------------------------------------------------------

/**
 * Where a run in progress came from: the runtime's own origins, except that a
 * run started for a multi-agent task says so.
 */
export const workOriginSchema = z.enum([...runOriginSchema.options, 'task-participant', 'task-synthesis']);
export type WorkOrigin = z.infer<typeof workOriginSchema>;

/** How to stop something: an existing route. `GET /api/work/running` itself changes nothing. */
const stopActionSchema = z.object({ method: z.literal('POST'), url: z.string() });

export const runningRunSchema = z.object({
  runId: idSchema,
  sessionId: idSchema,
  projectId: idSchema.nullable(),
  projectName: z.string().nullable(),
  agentId: z.string(),
  agentName: z.string(),
  /** The session's name. */
  title: z.string(),
  origin: workOriginSchema,
  /** The task it belongs to, for the two task origins. */
  taskId: idSchema.nullable(),
  /** `waiting`: an approval, a plan or a question waits for a person. */
  state: z.enum(['starting', 'running', 'waiting']),
  pendingApprovals: z.number().int().nonnegative(),
  /** Nobody is assumed to be watching (a scheduled or automated run). */
  unattended: z.boolean(),
  /** The caller has its session visibly on screen on some device right now. */
  watching: z.boolean(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  link: z.string(),
  stop: stopActionSchema,
});
export type RunningRun = z.infer<typeof runningRunSchema>;

export const runningWorkSchema = z.object({
  /** The caller's own runs in progress, newest first. */
  runs: z.array(runningRunSchema),
  /** The caller's own tasks that are `running` or `needs-attention`, newest first. */
  tasks: z.array(z.object({ task: taskSchema, watching: z.boolean(), stop: stopActionSchema })),
  counts: z.object({
    runs: z.number().int().nonnegative(),
    /** Runs waiting for a person. */
    waiting: z.number().int().nonnegative(),
    /** Runs nobody is watching. */
    background: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  }),
  /** More runs are in progress than are listed. */
  truncated: z.boolean(),
  checkedAt: timestampSchema,
});
export type RunningWork = z.infer<typeof runningWorkSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** On the `user:<id>` topic of the person who handed over or created the task. */
export const COLLAB_EVENT = {
  handoffCreated: 'handoff.created',
  taskCreated: 'task.created',
  /** A participant changed state, the synthesis moved on, or the task as a whole did. */
  taskUpdated: 'task.updated',
  taskRemoved: 'task.removed',
} as const;

export const collabEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(COLLAB_EVENT.handoffCreated),
    data: z.object({ handoffId: idSchema, chainId: idSchema, sourceSessionId: idSchema, targetSessionId: idSchema, projectId: idSchema.nullable() }),
  }),
  /** Tasks in events are as in lists: no answers, no usage, no change summaries. */
  z.object({ type: z.literal(COLLAB_EVENT.taskCreated), data: z.object({ task: taskSchema }) }),
  z.object({ type: z.literal(COLLAB_EVENT.taskUpdated), data: z.object({ task: taskSchema }) }),
  z.object({ type: z.literal(COLLAB_EVENT.taskRemoved), data: z.object({ taskId: idSchema, projectId: idSchema }) }),
]);
export type CollabEvent = z.infer<typeof collabEventSchema>;
