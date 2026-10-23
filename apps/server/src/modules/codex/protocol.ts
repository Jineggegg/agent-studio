import { z } from 'zod';

/**
 * The part of the Codex app-server protocol this adapter speaks.
 *
 * The CLI prints the whole protocol on request
 * (`codex app-server generate-json-schema --out <dir>`, or `generate-ts`);
 * these schemas were written from that output for codex-cli 0.160.0 and from
 * messages captured from the same version. Only what the adapter reads is
 * described, every object tolerates fields it does not know, and a message
 * that does not fit is skipped by the caller — never a reason to fail a run.
 *
 * Transport: one JSON object per line on the process's standard input and
 * output. Messages are JSON-RPC shaped without the `jsonrpc` member:
 *
 *   request        { id, method, params }      either direction
 *   response       { id, result } | { id, error: { code, message } }
 *   notification   { method, params }          server → client (and `initialized` the other way)
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type RpcId = string | number;

export type RpcMessage =
  | { readonly kind: 'response'; readonly id: RpcId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: RpcId; readonly code: number; readonly message: string }
  | {
      readonly kind: 'request';
      readonly id: RpcId;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown };

const isId = (value: unknown): value is RpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** Sorts one decoded line into what it is. Null: valid JSON, but not a message. */
export function classifyMessage(value: unknown): RpcMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  const method = typeof message.method === 'string' ? message.method : null;
  if (method !== null) {
    return isId(message.id)
      ? { kind: 'request', id: message.id, method, params: message.params }
      : { kind: 'notification', method, params: message.params };
  }
  if (!isId(message.id)) return null;
  if (message.error !== undefined && message.error !== null) {
    const error = message.error as { code?: unknown; message?: unknown };
    return {
      kind: 'error',
      id: message.id,
      code: typeof error.code === 'number' ? error.code : 0,
      message: typeof error.message === 'string' ? error.message : 'The request failed.',
    };
  }
  return 'result' in message ? { kind: 'response', id: message.id, result: message.result } : null;
}

// ---------------------------------------------------------------------------
// Answers to the adapter's own requests
// ---------------------------------------------------------------------------

export const initializeResultSchema = z.looseObject({
  userAgent: z.string().optional(),
  /** The directory the CLI keeps its configuration, sign-in and conversations in. */
  codexHome: z.string(),
});

export const accountReadSchema = z.looseObject({
  account: z
    .looseObject({
      type: z.string(),
      email: z.string().nullable().optional(),
      planType: z.string().nullable().optional(),
    })
    .nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});
export type AccountRead = z.infer<typeof accountReadSchema>;

export const modelSchema = z.looseObject({
  id: z.string(),
  model: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string() })).optional(),
  defaultReasoningEffort: z.string().optional(),
  inputModalities: z.array(z.string()).optional(),
  serviceTiers: z
    .array(z.object({ id: z.string(), name: z.string(), description: z.string() }))
    .optional(),
});
export type CodexModel = z.infer<typeof modelSchema>;

export const modelListSchema = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullable().optional(),
});

export const configReadSchema = z.looseObject({
  config: z.record(z.string(), z.unknown()),
  layers: z
    .array(
      z.looseObject({
        name: z.looseObject({ type: z.string() }),
        config: z.unknown(),
        disabledReason: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});
export type ConfigRead = z.infer<typeof configReadSchema>;

/** `thread/start` and `thread/resume`: the thread, and the settings the CLI says are in force. */
export const threadResponseSchema = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1) }),
  model: z.string().optional(),
  /** The instruction files Codex loaded for this thread (`AGENTS.md` of its home, of the project, …). */
  instructionSources: z.array(z.string()).optional().catch(undefined),
  approvalPolicy: z.unknown(),
  approvalsReviewer: z.unknown(),
  sandbox: z.unknown(),
});
export type ThreadResponse = z.infer<typeof threadResponseSchema>;

export const turnStartResultSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const optionalText = z.string().nullable().optional();

const commandActionSchema = z.looseObject({ type: z.string(), command: z.string().optional() });

export const fileUpdateChangeSchema = z.looseObject({
  path: z.string(),
  kind: z.looseObject({ type: z.string(), move_path: z.string().nullable().optional() }),
  diff: z.string().catch(''),
});
export type FileUpdateChange = z.infer<typeof fileUpdateChangeSchema>;

const itemSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('agentMessage'), id: z.string(), text: z.string().catch('') }),
  z.looseObject({
    type: z.literal('reasoning'),
    id: z.string(),
    summary: z.array(z.string()).catch([]),
    content: z.array(z.string()).catch([]),
  }),
  z.looseObject({ type: z.literal('plan'), id: z.string(), text: z.string().catch('') }),
  z.looseObject({
    type: z.literal('commandExecution'),
    id: z.string(),
    command: z.string(),
    cwd: optionalText,
    status: z.string().catch('inProgress'),
    commandActions: z.array(commandActionSchema).catch([]),
    aggregatedOutput: optionalText,
    exitCode: z.number().nullable().optional(),
  }),
  z.looseObject({
    type: z.literal('fileChange'),
    id: z.string(),
    changes: z.array(fileUpdateChangeSchema).catch([]),
    status: z.string().catch('inProgress'),
  }),
  z.looseObject({
    type: z.literal('mcpToolCall'),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    status: z.string().catch('inProgress'),
    arguments: z.unknown(),
    result: z
      .looseObject({ content: z.array(z.unknown()).catch([]) })
      .nullable()
      .optional(),
    error: z
      .looseObject({ message: z.string().catch('') })
      .nullable()
      .optional(),
  }),
  z.looseObject({
    type: z.literal('dynamicToolCall'),
    id: z.string(),
    tool: z.string(),
    namespace: optionalText,
    status: z.string().catch('inProgress'),
    arguments: z.unknown(),
    success: z.boolean().nullable().optional(),
  }),
  z.looseObject({
    type: z.literal('collabAgentToolCall'),
    id: z.string(),
    tool: z.string(),
    status: z.string().catch('inProgress'),
    receiverThreadIds: z.array(z.string()).catch([]),
    prompt: optionalText,
    model: optionalText,
  }),
  z.looseObject({
    type: z.literal('webSearch'),
    id: z.string(),
    query: z.string().catch(''),
    action: z
      .looseObject({
        type: z.string(),
        url: optionalText,
        query: optionalText,
        pattern: optionalText,
      })
      .nullable()
      .optional(),
  }),
  z.looseObject({ type: z.literal('imageView'), id: z.string(), path: z.string().catch('') }),
  z.looseObject({ type: z.literal('contextCompaction'), id: z.string() }),
  // Known and of no interest to a transcript: the user's own message, hook prompts, raw tool output, and the like.
  z.looseObject({ type: z.literal('userMessage'), id: z.string() }),
  z.looseObject({ type: z.literal('hookPrompt'), id: z.string() }),
  z.looseObject({ type: z.literal('functionCallOutput'), id: z.string() }),
  z.looseObject({ type: z.literal('subAgentActivity'), id: z.string() }),
  z.looseObject({ type: z.literal('sleep'), id: z.string().optional() }),
  z.looseObject({ type: z.literal('imageGeneration'), id: z.string().optional() }),
  z.looseObject({ type: z.literal('enteredReviewMode'), id: z.string() }),
  z.looseObject({ type: z.literal('exitedReviewMode'), id: z.string() }),
]);
export type CodexItem = z.infer<typeof itemSchema>;
export type CodexItemOf<T extends CodexItem['type']> = Extract<CodexItem, { type: T }>;

/** Null for an item of a type this adapter does not know, or one that does not have the expected shape. */
export function readItem(value: unknown): CodexItem | null {
  const parsed = itemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const turnErrorSchema = z.looseObject({
  message: z.string().catch(''),
  codexErrorInfo: z.unknown().optional(),
  additionalDetails: optionalText,
});
export type TurnError = z.infer<typeof turnErrorSchema>;

const tokenBreakdownSchema = z.looseObject({
  totalTokens: z.number().catch(0),
  inputTokens: z.number().catch(0),
  cachedInputTokens: z.number().catch(0),
  cacheWriteInputTokens: z.number().catch(0),
  outputTokens: z.number().catch(0),
  reasoningOutputTokens: z.number().catch(0),
});
export type TokenBreakdown = z.infer<typeof tokenBreakdownSchema>;

const rateLimitWindowSchema = z
  .looseObject({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable().optional(),
    resetsAt: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

export const rateLimitSnapshotSchema = z.looseObject({
  limitId: optionalText,
  limitName: optionalText,
  primary: rateLimitWindowSchema,
  secondary: rateLimitWindowSchema,
  credits: z
    .looseObject({
      hasCredits: z.boolean().catch(false),
      unlimited: z.boolean().catch(false),
      balance: optionalText,
    })
    .nullable()
    .optional(),
  planType: optionalText,
  rateLimitReachedType: optionalText,
});
export type RateLimitSnapshot = z.infer<typeof rateLimitSnapshotSchema>;

const scoped = { threadId: z.string(), turnId: z.string().optional() };

/** Parameters of the notifications the adapter acts on, by method. */
export const notificationSchemas = {
  'thread/started': z.looseObject({ thread: z.looseObject({ id: z.string() }) }),
  'thread/name/updated': z.looseObject({ threadId: z.string(), threadName: z.string().optional() }),
  'thread/tokenUsage/updated': z.looseObject({
    ...scoped,
    tokenUsage: z.looseObject({
      total: tokenBreakdownSchema,
      last: tokenBreakdownSchema,
      modelContextWindow: z.number().nullable().optional(),
    }),
  }),
  'thread/compacted': z.looseObject({ ...scoped }),
  'turn/started': z.looseObject({ threadId: z.string(), turn: z.looseObject({ id: z.string() }) }),
  'turn/completed': z.looseObject({
    threadId: z.string(),
    turn: z.looseObject({
      id: z.string(),
      status: z.string(),
      error: turnErrorSchema.nullable().optional(),
    }),
  }),
  'turn/plan/updated': z.looseObject({
    ...scoped,
    explanation: optionalText,
    plan: z.array(z.looseObject({ step: z.string(), status: z.string() })),
  }),
  'item/started': z.looseObject({ ...scoped, item: z.unknown() }),
  'item/completed': z.looseObject({ ...scoped, item: z.unknown() }),
  'item/agentMessage/delta': z.looseObject({ ...scoped, itemId: z.string(), delta: z.string() }),
  'item/reasoning/summaryTextDelta': z.looseObject({
    ...scoped,
    itemId: z.string(),
    delta: z.string(),
    summaryIndex: z.number().catch(0),
  }),
  'item/reasoning/summaryPartAdded': z.looseObject({
    ...scoped,
    itemId: z.string(),
    summaryIndex: z.number().catch(0),
  }),
  'item/reasoning/textDelta': z.looseObject({ ...scoped, itemId: z.string(), delta: z.string() }),
  'item/commandExecution/outputDelta': z.looseObject({
    ...scoped,
    itemId: z.string(),
    delta: z.string(),
  }),
  'item/mcpToolCall/progress': z.looseObject({
    ...scoped,
    itemId: z.string(),
    message: z.string(),
  }),
  'item/fileChange/patchUpdated': z.looseObject({
    ...scoped,
    itemId: z.string(),
    changes: z.array(fileUpdateChangeSchema).catch([]),
  }),
  'account/rateLimits/updated': z.looseObject({ rateLimits: rateLimitSnapshotSchema }),
  'mcpServer/startupStatus/updated': z.looseObject({
    name: z.string(),
    status: z.string(),
    error: optionalText,
  }),
  'model/rerouted': z.looseObject({ ...scoped, fromModel: z.string(), toModel: z.string() }),
  error: z.looseObject({
    error: turnErrorSchema,
    willRetry: z.boolean().catch(false),
    threadId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  warning: z.looseObject({ threadId: z.string().nullable().optional(), message: z.string() }),
  configWarning: z.looseObject({ summary: z.string(), details: optionalText }),
} as const;

export type NotificationMethod = keyof typeof notificationSchemas;
export type NotificationParams<M extends NotificationMethod> = z.infer<
  (typeof notificationSchemas)[M]
>;

export const isKnownNotification = (method: string): method is NotificationMethod =>
  Object.hasOwn(notificationSchemas, method);

// ---------------------------------------------------------------------------
// Requests the server sends to the client
// ---------------------------------------------------------------------------

export const commandApprovalSchema = z.looseObject({
  /** `command` (the default), or `writeStdin`: input for a command that is already running. */
  kind: z.string().optional(),
  threadId: z.string(),
  turnId: z.string().optional(),
  itemId: z.string(),
  /** Why the agent wants it (its justification for leaving the sandbox). */
  reason: optionalText,
  command: optionalText,
  cwd: optionalText,
  commandActions: z.array(commandActionSchema).nullable().optional(),
  /** Set when the request is for a network connection rather than a command. */
  networkApprovalContext: z
    .looseObject({ host: z.string(), protocol: z.string().catch('https') })
    .nullable()
    .optional(),
});
export type CommandApproval = z.infer<typeof commandApprovalSchema>;

export const fileChangeApprovalSchema = z.looseObject({
  threadId: z.string(),
  turnId: z.string().optional(),
  itemId: z.string(),
  reason: optionalText,
  grantRoot: optionalText,
});
export type FileChangeApproval = z.infer<typeof fileChangeApprovalSchema>;

/**
 * Codex asks about an MCP tool call through the MCP "elicitation" request,
 * marked with `_meta.codex_approval_kind = "mcp_tool_call"`. The same request
 * also carries real elicitations (a server asking the user for input).
 */
export const elicitationSchema = z.looseObject({
  threadId: z.string().optional(),
  serverName: z.string(),
  mode: z.string().optional(),
  message: z.string().catch(''),
  _meta: z
    .looseObject({
      codex_approval_kind: z.string().optional(),
      tool_params: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});
export type Elicitation = z.infer<typeof elicitationSchema>;

export const userInputRequestSchema = z.looseObject({
  threadId: z.string().optional(),
  itemId: z.string().optional(),
  questions: z.array(
    z.looseObject({
      id: z.string(),
      header: z.string().catch(''),
      question: z.string(),
      options: z
        .array(z.looseObject({ label: z.string(), description: z.string().catch('') }))
        .nullable()
        .optional(),
    }),
  ),
});
export type UserInputRequest = z.infer<typeof userInputRequestSchema>;

/** What the adapter answers a command approval with. `cancel` also ends the turn. */
export type CommandDecision = 'accept' | 'decline' | 'cancel';
