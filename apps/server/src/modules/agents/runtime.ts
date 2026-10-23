import { requireFastMode } from './fast-mode.js';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_LIMITS,
  type Approval,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResponse,
  type ApprovalKind,
  type ApprovalStatus,
  LIVE_EVENT,
  type MessageReceipt,
  type PermissionMode,
  type PermissionRule,
  type Question,
  type QuestionAnswer,
  type QueuedMessage,
  type Run,
  type RunError,
  type RunOrigin,
  SESSION_EVENT,
  type SendMessageRequest,
  type SendNowResponse,
  type SessionSnapshot,
  type TerminalRunStatus,
  USER_AGENT_EVENT,
} from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentToolResult } from '../../kernel/agent-tools.js';
import { newId, sha256 } from '../../kernel/crypto.js';
import {
  conflict,
  describeError,
  forbidden,
  notFound,
  unprocessable,
} from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { ProjectRecord } from '../projects/projects.service.js';
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentRunHandle,
  type AgentRunHost,
  type AgentRunRequest,
  AgentRunError,
  type HistoryMessage,
  type PermissionDecision,
  type PermissionPrompt,
  type PermissionPromptResult,
  type PermissionRequest,
  type PromptAttachment,
  type StudioToolDescription,
  type UserQuestionAnswer,
  type UserQuestionRequest,
} from './adapter.js';
import type { BridgeTokens } from './bridge.js';
import {
  type EngineRule,
  type PermissionEnvironment,
  type ToolRequest,
  approvalAuthority,
  evaluatePermission,
  suggestRule,
} from './permissions.js';
import {
  type ApprovalDetail,
  RASTER_IMAGE_TYPES,
  attachmentRef,
  boundDiffs,
  boundInput,
  boundOutput,
  cleanProposedTitle,
  clip,
  presentApproval,
  presentRule,
  presentRun,
  titleFromMessage,
} from './present.js';
import type { SessionService } from './sessions.js';
import type {
  AgentStore,
  ApprovalRow,
  AttachmentRow,
  QueueRow,
  ReceiptRow,
  RuleRow,
  RunRow,
  SessionRow,
} from './store.js';

export interface RuntimeOptions {
  /** How long a tool or plan approval waits before it is denied. */
  readonly approvalTtlMs: number;
  /** How long a question waits before it is answered with the agent's own recommendations. 0: for ever. */
  readonly questionTtlMs: number;
  /** How long a stopped agent gets to wind down before the run is ended without it. */
  readonly stopGraceMs: number;
}

export interface SendOptions {
  /** Defaults to `interactive`. */
  readonly origin?: RunOrigin;
  /**
   * For unattended runs (`scheduled`, `automation`): wait for a person when
   * something needs approval, instead of denying it. Off unless the caller
   * that starts the run asks for it.
   */
  readonly waitForApproval?: boolean;
}

interface StreamingBlock {
  kind: 'text' | 'thinking';
  text: string;
  parentToolCallId: string | null;
}

interface ActiveRun {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly projectId: string | null;
  readonly agentId: string;
  readonly unattended: boolean;
  readonly waitForApproval: boolean;
  readonly abort: AbortController;
  readonly streaming: Map<string, StreamingBlock>;
  readonly toolTails: Map<string, string>;
  /** Tool calls the adapter has announced and not yet finished: what a call of a Studio tool is matched against. */
  readonly openTools: Map<string, { name: string; input: unknown; claimed: boolean }>;
  /** Tool calls the Studio itself refused (by a person or by the engine), with the reason. Their result is `denied`. */
  readonly refusedTools: Map<string, string>;
  /** Refusals of a Studio tool whose tool call was not known yet when they happened; matched when the call finishes. */
  readonly pendingRefusals: Array<{ name: string; input: unknown; message: string }>;
  readonly usage: Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }
  >;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  readonly host: AgentRunHost;
  request: AgentRunRequest | null;
  handle: AgentRunHandle | null;
  phase: 'starting' | 'running' | 'finished';
  stopRequested: boolean;
  startedAt: number;
  stopTimer: NodeJS.Timeout | null;
}

interface Resolution {
  readonly status: Exclude<ApprovalStatus, 'pending'>;
  readonly decidedBy: string | null;
  readonly note: string | null;
  readonly answers: QuestionAnswer[] | null;
  /** For a plan that was approved: the permission mode its session continues in. */
  readonly sessionMode?: PermissionMode;
}

interface Waiter {
  readonly approvalId: string;
  readonly run: ActiveRun;
  readonly kind: ApprovalKind;
  /** What the permission engine was asked, so a newly saved rule can be applied to requests already waiting. */
  readonly toolRequest: ToolRequest | null;
  readonly questions: readonly Question[] | null;
  readonly resolve: (resolution: Resolution) => void;
  timer: NodeJS.Timeout | null;
}

const TAIL_CHARS = 8000;
/** How long a call of a Studio tool waits for its adapter to have announced the tool call it belongs to. */
const TOOL_CALL_WAIT_MS = 500;

/**
 * Whether a tool call an adapter announced as `announced` is a call of the Studio tool `name`: under its plain
 * name (an API model calls it directly) or MCP-qualified, as the CLI agents see it (`mcp__studio__memory_write`).
 */
function isStudioToolCall(announced: string, name: string): boolean {
  return announced === name || announced.endsWith(`__${name}`);
}

/** Equal as JSON values, whatever order the keys of an object come in. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  };
  try {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  } catch {
    return false;
  }
}
const HISTORY_MESSAGES = 400;
const ERROR_CHARS = 2000;
const MAX_RULES_PER_USER = 500;
const RECOMMENDED = /\(recommended\)|（推荐）|\(推荐\)/i;

/** What the agent is told when a failed or interrupted run is continued. */
export const CONTINUATION_PREAMBLE =
  'Continue the task below, which was interrupted before it finished. Check the current state of the work first, and do not repeat steps that are already done. The original request was:';

const busy = () => conflict('This session already has a run in progress.', 'session_busy');

function requestHash(sessionId: string, input: SendMessageRequest, origin: RunOrigin): string {
  return sha256(
    JSON.stringify([
      sessionId,
      input.text,
      [...input.attachmentIds].sort(),
      input.quote ?? null,
      input.model ?? null,
      input.effort ?? null,
      input.permissionMode ?? null,
      input.whenBusy,
      origin,
    ]),
  );
}

const withQuote = (text: string, quote: string | null): string =>
  quote === null || quote.trim() === ''
    ? text
    : `${quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n${text}`;

/**
 * Runs: accepting a message, starting the agent, recording what it does,
 * asking for permission, queueing, stopping, and recovering after a restart.
 *
 * A run belongs to the server. Nothing here depends on a browser being
 * connected; clients only watch.
 */
export class RunService {
  readonly #context: ModuleContext;
  readonly #store: AgentStore;
  readonly #sessions: SessionService;
  readonly #tokens: BridgeTokens;
  readonly #options: RuntimeOptions;
  readonly #log: FastifyBaseLogger;
  readonly #attachmentPath: (row: AttachmentRow) => string;
  readonly #adapters = new Map<string, AgentAdapter>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #launching = new Map<string, Promise<void>>();
  readonly #activeBySession = new Map<string, ActiveRun>();
  readonly #waiters = new Map<string, Waiter>();
  /** Requests being worked on right now, so the same id cannot be accepted twice at once. */
  readonly #inFlight = new Set<string>();
  readonly #drainTimers = new Map<string, NodeJS.Immediate>();
  #shuttingDown = false;

  constructor(deps: {
    context: ModuleContext;
    store: AgentStore;
    sessions: SessionService;
    tokens: BridgeTokens;
    options: RuntimeOptions;
    attachmentPath: (row: AttachmentRow) => string;
  }) {
    this.#context = deps.context;
    this.#store = deps.store;
    this.#sessions = deps.sessions;
    this.#tokens = deps.tokens;
    this.#options = deps.options;
    this.#attachmentPath = deps.attachmentPath;
    this.#log = deps.context.log;
  }

  // ---- adapters ------------------------------------------------------------

  registerAdapter(adapter: AgentAdapter): void {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(adapter.id))
      throw new Error(`"${adapter.id}" is not a valid agent id.`);
    if (this.#adapters.has(adapter.id))
      throw new Error(`Agent "${adapter.id}" is already registered.`);
    this.#adapters.set(adapter.id, adapter);
  }

  /**
   * Takes an agent away again (an API provider the owner removed or switched
   * off). Its sessions stay readable; sending to them answers
   * `agent_unavailable`. A run already in progress is not touched — whoever
   * unregisters the adapter stops its runs. False when no such agent was registered.
   */
  unregisterAdapter(id: string): boolean {
    return this.#adapters.delete(id);
  }

  adapter(id: string): AgentAdapter | undefined {
    return this.#adapters.get(id);
  }

  adapters(): AgentAdapter[] {
    return [...this.#adapters.values()];
  }

  // ---- identities ----------------------------------------------------------

  /**
   * The identity server-initiated work runs under (draining a queue, a
   * schedule): the account as it is now, so a disabled user or a changed role
   * takes effect at once. Null when the account is gone or disabled.
   */
  principalFor(userId: string): Principal | null {
    const user = this.#context.services.auth.findUser(userId);
    if (!user || user.disabled) return null;
    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      via: 'token',
      credentialId: 'agent-runtime',
      scopes: ['read', 'write'],
      authenticatedAt: 0,
    };
  }

  #environment(session: SessionRow, project: ProjectRecord | null): PermissionEnvironment {
    return {
      projectDir: project?.rootDir ?? null,
      autoEnabled: this.#sessions.autoModeEnabled(project),
      studioDataDir: resolveExisting(this.#context.config.dataDir),
      homeDir: os.homedir(),
      realpath: resolveExisting,
    };
  }

  #projectOf(session: SessionRow): ProjectRecord | null {
    return session.project_id === null
      ? null
      : this.#context.services.projects.find(session.project_id);
  }

  // ---- sending -------------------------------------------------------------

  /**
   * Accepts a message. The receipt is durable before the agent does anything,
   * and the same request id never starts a second run.
   */
  async send(
    principal: Principal,
    sessionId: string,
    input: SendMessageRequest,
    options: SendOptions = {},
  ): Promise<MessageReceipt> {
    const { row: session } = this.#sessions.requireSession(principal, sessionId, 'write');
    const origin = options.origin ?? 'interactive';
    const hash = requestHash(sessionId, input, origin);

    const known = this.#store.receipt(principal.userId, input.requestId);
    if (known) return this.#duplicate(known, hash, sessionId);
    const key = `${principal.userId}\n${input.requestId}`;
    if (this.#inFlight.has(key))
      throw conflict('That message is already being processed.', 'request_in_progress');
    this.#inFlight.add(key);
    try {
      this.#context.services.usage?.assertRequestAllowed(session.user_id, session.agent_id);
      const adapter = this.#adapters.get(session.agent_id);
      if (!adapter)
        throw unprocessable(
          'The agent of this session is not available on this Studio.',
          'agent_unavailable',
        );
      if (input.permissionMode !== undefined)
        await this.#sessions.assertModeSupported(adapter, input.permissionMode);
      const attachments = this.#claimAttachments(sessionId, principal.userId, input.attachmentIds);
      const unattended = origin === 'scheduled' || origin === 'automation';
      const expandedText =
        origin === 'interactive'
          ? (this.#context.services.toolLibrary?.expand(
              principal,
              session.project_id,
              input.text,
            ) ?? input.text)
          : input.text;
      const spec = {
        requestId: input.requestId,
        hash,
        text: expandedText,
        attachmentIds: attachments.map((row) => row.id),
        quote: input.quote ?? null,
        origin,
        unattended,
        waitForApproval: unattended && options.waitForApproval === true,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
      };

      if (this.#store.activeRun(sessionId)) {
        if (input.whenBusy === 'reject') throw busy();
        if (input.whenBusy === 'steer') {
          const steered = await this.#steer(sessionId, principal.userId, spec, attachments);
          if (steered) return steered;
        }
      }
      // A steer attempt takes time; the run may have ended meanwhile.
      if (this.#store.activeRun(sessionId)) return this.#enqueue(session, principal.userId, spec);
      return this.#start(session, principal.userId, {
        ...spec,
        promptText: expandedText,
        receipt: 'insert',
        continuesRunId: null,
      });
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** "Did you get request X?" — the caller's own receipt, or nothing. */
  receipt(principal: Principal, sessionId: string, requestId: string): MessageReceipt {
    this.#sessions.requireSession(principal, sessionId, 'view');
    const row = this.#store.receipt(principal.userId, requestId);
    if (!row || row.session_id !== sessionId)
      throw notFound('No message with that request id was received.', 'receipt_not_found');
    return this.#presentReceipt(row, true);
  }

  #duplicate(row: ReceiptRow, hash: string, sessionId: string): MessageReceipt {
    if (row.request_hash !== hash || row.session_id !== sessionId) {
      throw conflict(
        'That request id was already used for a different message.',
        'request_conflict',
      );
    }
    return this.#presentReceipt(row, true);
  }

  #presentReceipt(row: ReceiptRow, duplicate: boolean): MessageReceipt {
    const run = row.run_id === null ? undefined : this.#store.run(row.run_id);
    return {
      requestId: row.request_id,
      sessionId: row.session_id,
      disposition: row.disposition,
      runId: row.run_id,
      queueItemId: row.queue_item_id,
      duplicate,
      run: run ? presentRun(run) : null,
      acceptedAt: row.created_at,
    };
  }

  /** Only files uploaded to this session by this user, not yet sent, may go out with a message. */
  #claimAttachments(sessionId: string, userId: string, ids: readonly string[]): AttachmentRow[] {
    const rows: AttachmentRow[] = [];
    for (const id of new Set(ids)) {
      const row = this.#store.attachment(sessionId, id);
      if (!row || row.user_id !== userId)
        throw unprocessable(
          'An attachment of this message was not found in this session.',
          'attachment_not_found',
        );
      if (row.sent_at !== null)
        throw unprocessable(
          'An attachment of this message was already sent.',
          'attachment_already_sent',
        );
      rows.push(row);
    }
    return rows;
  }

  #start(
    session: SessionRow,
    userId: string,
    spec: {
      requestId: string;
      hash: string;
      text: string;
      promptText: string;
      attachmentIds: string[];
      quote: string | null;
      origin: RunOrigin;
      unattended: boolean;
      waitForApproval: boolean;
      model?: string | undefined;
      effort?: string | undefined;
      permissionMode?: PermissionMode | undefined;
      receipt: 'insert' | 'update';
      continuesRunId: string | null;
    },
  ): MessageReceipt {
    if (this.#shuttingDown) throw conflict('The server is shutting down.', 'shutting_down');
    this.#context.services.usage?.assertRequestAllowed(session.user_id, session.agent_id);
    const runId = newId();
    const now = Date.now();
    const sessionId = session.id;
    const attachments = spec.attachmentIds
      .map((id) => this.#store.attachment(sessionId, id))
      .filter((row): row is AttachmentRow => row !== undefined);
    // Background the session was created with goes out in front of the first message the agent really gets.
    const seed = this.#undeliveredSeed(sessionId);
    const promptText = seed === null ? spec.promptText : `${seed}\n\n${spec.promptText}`;

    try {
      this.#sessions.atomic(() => {
        if (this.#store.activeRun(sessionId)) throw busy();
        if (
          spec.continuesRunId !== null &&
          !this.#store.claimContinuation(spec.continuesRunId, userId, runId)
        ) {
          throw conflict('That run was already continued or dismissed.', 'run_not_available');
        }
        const mode = spec.permissionMode ?? session.permission_mode;
        this.#store.insertRun({
          id: runId,
          session_id: sessionId,
          user_id: session.user_id,
          project_id: session.project_id,
          agent_id: session.agent_id,
          request_id: spec.requestId,
          origin: spec.origin,
          unattended: spec.unattended ? 1 : 0,
          wait_for_approval: spec.waitForApproval ? 1 : 0,
          status: 'accepted',
          source_text: spec.text,
          prompt: JSON.stringify({
            text: promptText,
            attachmentIds: spec.attachmentIds,
            quote: spec.quote,
          }),
          model: spec.model ?? session.model,
          effort: spec.effort ?? session.effort,
          permission_mode: mode,
          error_code: null,
          error_message: null,
          interrupted_by_restart: 0,
          continues_run_id: spec.continuesRunId,
          continued_by_run_id: null,
          dismissed_at: null,
          seen_at: null,
          created_at: now,
          started_at: null,
          finished_at: null,
        });
        if (spec.receipt === 'insert') {
          this.#store.insertReceipt({
            user_id: userId,
            request_id: spec.requestId,
            session_id: sessionId,
            request_hash: spec.hash,
            disposition: 'run',
            run_id: runId,
            queue_item_id: null,
            created_at: now,
          });
        } else {
          this.#store.updateReceipt(userId, spec.requestId, 'run', runId, null);
        }
        this.#store.markAttachmentsSent(sessionId, spec.attachmentIds, now);
        // What a message carries becomes the session's recorded choice; new activity brings an archived session back.
        this.#store.updateSession(
          sessionId,
          {
            model: spec.model,
            effort: spec.effort,
            permissionMode: spec.permissionMode,
            archivedAt: null,
            lastUserMessageAt: now,
            // Sending what was typed empties the composer everywhere; server-initiated turns leave a newer draft alone.
            ...(spec.origin === 'interactive' ? { draft: '', draftUpdatedAt: now } : {}),
          },
          now,
        );
        const title = session.title_source === 'default' ? titleFromMessage(spec.text) : null;
        if (title) this.#sessions.rename(sessionId, title, 'auto');
        this.#sessions.append(sessionId, runId, SESSION_EVENT.messageUser, {
          runId,
          requestId: spec.requestId,
          origin: spec.origin,
          text: spec.text,
          attachments: attachments.map(attachmentRef),
          quote: spec.quote,
          continuesRunId: spec.continuesRunId,
        });
      });
    } catch (error) {
      // The unique index on active runs is the last line of defence against two runs in one session.
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: agent_runs\.session_id/.test(error.message)
      )
        throw busy();
      throw error;
    }

    const run = this.#track(runId, session, spec.unattended, spec.waitForApproval);
    this.#sessions.refreshAttention(sessionId, { announce: true });
    setImmediate(() => {
      const launch = this.#launch(run);
      this.#launching.set(run.id, launch);
      void launch.finally(() => this.#launching.delete(run.id)).catch(() => {});
    });
    return this.#presentReceipt(
      this.#store.receipt(userId, spec.requestId) ??
        this.#syntheticReceipt(userId, spec, sessionId, runId, now),
      false,
    );
  }

  /**
   * The background a session was created with (see `SessionOptions.seed`), as
   * long as the agent has not had it: until the agent has a conversation of
   * its own to resume, or has answered once. A first run that failed before
   * the agent took anything in therefore does not lose it.
   */
  #undeliveredSeed(sessionId: string): string | null {
    const session = this.#store.session(sessionId);
    if (!session || session.seed === null || session.seed === '') return null;
    if (session.native_session_id !== null || this.#store.hasCompletedRun(sessionId)) return null;
    return session.seed;
  }

  #syntheticReceipt(
    userId: string,
    spec: { requestId: string; hash: string },
    sessionId: string,
    runId: string,
    at: number,
  ): ReceiptRow {
    return {
      user_id: userId,
      request_id: spec.requestId,
      session_id: sessionId,
      request_hash: spec.hash,
      disposition: 'run',
      run_id: runId,
      queue_item_id: null,
      created_at: at,
    };
  }

  #enqueue(
    session: SessionRow,
    userId: string,
    spec: {
      requestId: string;
      hash: string;
      text: string;
      attachmentIds: string[];
      quote: string | null;
      model?: string | undefined;
      effort?: string | undefined;
      permissionMode?: PermissionMode | undefined;
    },
  ): MessageReceipt {
    const now = Date.now();
    const itemId = newId();
    this.#sessions.atomic(() => {
      if (this.#store.queueLength(session.id) >= AGENT_LIMITS.queueItems) {
        throw conflict(
          `The queue is full (${AGENT_LIMITS.queueItems} messages). Send or remove one first.`,
          'queue_full',
        );
      }
      this.#store.insertQueueItem({
        id: itemId,
        session_id: session.id,
        user_id: userId,
        request_id: spec.requestId,
        text: spec.text,
        attachment_ids: JSON.stringify(spec.attachmentIds),
        quote: spec.quote,
        created_at: now,
        updated_at: now,
      });
      this.#store.insertReceipt({
        user_id: userId,
        request_id: spec.requestId,
        session_id: session.id,
        request_hash: spec.hash,
        disposition: 'queued',
        run_id: null,
        queue_item_id: itemId,
        created_at: now,
      });
      this.#store.markAttachmentsSent(session.id, spec.attachmentIds, now);
      this.#store.updateSession(
        session.id,
        {
          model: spec.model,
          effort: spec.effort,
          permissionMode: spec.permissionMode,
          archivedAt: null,
          draft: '',
          draftUpdatedAt: now,
        },
        now,
      );
    });
    this.#announceQueue(session.id, null);
    this.#sessions.announceUpdate(session.id);
    return this.#presentReceipt(this.#store.receipt(userId, spec.requestId)!, false);
  }

  /** Offers a message to the turn in progress. Null when it could not be taken. */
  async #steer(
    sessionId: string,
    userId: string,
    spec: {
      requestId: string;
      hash: string;
      text: string;
      attachmentIds: string[];
      quote: string | null;
    },
    attachments: readonly AttachmentRow[],
  ): Promise<MessageReceipt | null> {
    const run = this.#activeBySession.get(sessionId);
    const steer = run?.handle?.steer;
    if (!run || !steer || run.phase !== 'running' || run.stopRequested) return null;
    let taken = false;
    try {
      taken = await Promise.race([
        Promise.resolve(
          steer.call(run.handle, {
            text: withQuote(spec.text, spec.quote),
            attachments: attachments.map((row) => this.#promptAttachment(row)),
          }),
        ),
        run.settled.then(() => false),
      ]);
    } catch (error) {
      this.#log.warn(
        { runId: run.id, err: redactSecrets(describeError(error)) },
        'steering a run failed',
      );
    }
    if (!taken || !this.#store.session(sessionId)) return null;
    const now = Date.now();
    this.#sessions.atomic(() => {
      this.#store.insertReceipt({
        user_id: userId,
        request_id: spec.requestId,
        session_id: sessionId,
        request_hash: spec.hash,
        disposition: 'steered',
        run_id: run.id,
        queue_item_id: null,
        created_at: now,
      });
      this.#store.markAttachmentsSent(sessionId, spec.attachmentIds, now);
      this.#store.updateSession(
        sessionId,
        { lastUserMessageAt: now, draft: '', draftUpdatedAt: now },
        now,
      );
      this.#sessions.append(sessionId, run.id, SESSION_EVENT.messageUser, {
        runId: run.id,
        requestId: spec.requestId,
        origin: 'steer',
        text: spec.text,
        attachments: attachments.map(attachmentRef),
        quote: spec.quote,
        continuesRunId: null,
      });
    });
    this.#sessions.announceUpdate(sessionId);
    return this.#presentReceipt(this.#store.receipt(userId, spec.requestId)!, false);
  }

  // ---- the life of a run ---------------------------------------------------

  #track(
    runId: string,
    session: SessionRow,
    unattended: boolean,
    waitForApproval: boolean,
  ): ActiveRun {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run: ActiveRun = {
      id: runId,
      sessionId: session.id,
      userId: session.user_id,
      projectId: session.project_id,
      agentId: session.agent_id,
      unattended,
      waitForApproval,
      abort: new AbortController(),
      streaming: new Map(),
      toolTails: new Map(),
      openTools: new Map(),
      refusedTools: new Map(),
      pendingRefusals: [],
      usage: new Map(),
      settled,
      settle,
      host: undefined as unknown as AgentRunHost,
      request: null,
      handle: null,
      phase: 'starting',
      stopRequested: false,
      startedAt: Date.now(),
      stopTimer: null,
    };
    (run as { host: AgentRunHost }).host = this.#host(run);
    this.#active.set(runId, run);
    this.#activeBySession.set(session.id, run);
    return run;
  }

  #host(run: ActiveRun): AgentRunHost {
    return {
      emit: (event) => {
        try {
          this.#onEvent(run, event);
        } catch (error) {
          this.#log.error(
            { runId: run.id, err: redactSecrets(describeError(error)) },
            'recording an agent event failed',
          );
        }
      },
      requestPermission: (request) =>
        this.#requestPermission(run, request)
          .then(async (decision) => {
            if (decision.behavior === 'allow' && request.kind === 'edit' && request.paths?.length) {
              await this.#context.services.agents.checkpoints.capture(
                run.sessionId,
                run.id,
                run.userId,
                run.projectId,
                request.paths,
              );
            }
            return decision;
          })
          .catch((error: unknown): PermissionDecision => {
            this.#log.error(
              { runId: run.id, err: redactSecrets(describeError(error)) },
              'deciding a permission request failed',
            );
            return {
              behavior: 'deny',
              message: 'The Studio could not decide this request.',
              source: 'policy',
            };
          }),
      askUser: (question) =>
        this.#askUser(run, question).catch((error: unknown): UserQuestionAnswer => {
          this.#log.error(
            { runId: run.id, err: redactSecrets(describeError(error)) },
            'asking the user failed',
          );
          return { status: 'cancelled', answers: [] };
        }),
      studioTools: {
        list: () => this.studioToolsFor(run.id),
        call: (name, input, options) => this.callStudioTool(run.id, name, input, options),
      },
      log: this.#log.child({ runId: run.id, agent: run.agentId }),
    };
  }

  #promptAttachment(row: AttachmentRow): PromptAttachment {
    return {
      id: row.id,
      name: row.name,
      path: this.#attachmentPath(row),
      mediaType: row.media_type,
      size: row.size,
      isImage: RASTER_IMAGE_TYPES.has(row.media_type),
    };
  }

  async #launch(run: ActiveRun): Promise<void> {
    if (this.#shuttingDown || run.phase !== 'starting') return;
    const row = this.#store.run(run.id);
    const session = this.#store.session(run.sessionId);
    if (!row || !session || row.status !== 'accepted') {
      this.#forget(run);
      return;
    }
    const project = this.#projectOf(session);
    const mode = this.#sessions.effectiveModeOf(session, project);
    run.startedAt = Date.now();
    this.#sessions.atomic(() => {
      this.#store.transitionRun(run.id, ['accepted'], {
        status: 'running',
        startedAt: run.startedAt,
        permissionMode: mode,
      });
      this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.runStarted, {
        runId: run.id,
        agentId: run.agentId,
        model: row.model,
        effort: row.effort,
        permissionMode: mode,
        origin: row.origin,
      });
    });
    const reference = {
      runId: run.id,
      sessionId: run.sessionId,
      projectId: run.projectId,
      agentId: run.agentId,
    };
    this.#sessions.toUser(run.userId, USER_AGENT_EVENT.runStarted, reference);
    this.#sessions.internal('run.started', {
      ...reference,
      userId: run.userId,
      origin: row.origin,
      unattended: run.unattended,
      title: session.title,
    });
    this.#sessions.refreshAttention(run.sessionId, { announce: true });
    if (run.stopRequested) {
      // Stopped before the agent was even started: there is nothing to start.
      this.#finish(run, { status: 'completed', error: null });
      return;
    }

    try {
      const adapter = this.#adapters.get(run.agentId);
      if (!adapter)
        throw new AgentRunError(
          'agent_unavailable',
          'The agent of this session is not available on this Studio.',
        );
      if (session.project_id !== null) {
        if (!project)
          throw new AgentRunError(
            'project_missing',
            'The project of this session no longer exists.',
          );
        if (!this.#context.services.projects.isAgentEnabled(project, run.agentId)) {
          throw new AgentRunError(
            'agent_not_enabled',
            'This agent is no longer offered in this project.',
          );
        }
        // The message may have waited in a queue: the person must still be allowed to work here.
        const principal = this.principalFor(run.userId);
        if (
          !principal ||
          this.#context.services.projects.accessOf(principal, project.id) !== 'write'
        ) {
          throw new AgentRunError(
            'access_revoked',
            'You no longer have write access to this project.',
          );
        }
      }
      if (session.fast_mode === 1)
        requireFastMode(session.agent_id, row.model, await adapter.capabilities());
      const request = await this.#buildRequest(run, row, session, project, mode);
      run.request = request;
      if (run.abort.signal.aborted || (run.phase as ActiveRun['phase']) === 'finished') {
        this.#finish(run, { status: 'completed', error: null });
        return;
      }
      const handle = await adapter.run(request, run.host);
      run.handle = handle;
      if ((run.phase as ActiveRun['phase']) === 'finished') {
        await handle.cancel();
        await handle.done.catch(() => {});
        return;
      }
      run.phase = 'running';
      if (run.stopRequested) this.#cancelHandle(run);
      handle.done.then(
        (result) => this.#finish(run, this.#outcomeOf(result)),
        (error: unknown) => this.#finish(run, this.#failureOf(run, error)),
      );
    } catch (error) {
      this.#finish(run, this.#failureOf(run, error));
    }
  }

  async #buildRequest(
    run: ActiveRun,
    row: RunRow,
    session: SessionRow,
    project: ProjectRecord | null,
    mode: PermissionMode,
  ): Promise<AgentRunRequest> {
    const account =
      session.account_profile_id === null
        ? null
        : await this.#context.services.agents.accounts.environment(
            session.user_id,
            session.account_profile_id,
            session.agent_id,
          );
    const prompt = JSON.parse(row.prompt) as {
      text: string;
      attachmentIds: string[];
      quote: string | null;
    };
    const attachments = prompt.attachmentIds
      .map((id) => this.#store.attachment(session.id, id))
      .filter((attachment): attachment is AttachmentRow => attachment !== undefined)
      .map((attachment) => this.#promptAttachment(attachment));
    const history: HistoryMessage[] = [];
    // Everything before this run's own user message.
    const ownMessage = this.#store
      .eventsTail(session.id, 0, 4)
      .find((event) => event.run_id === run.id && event.type === SESSION_EVENT.messageUser);
    for (const event of this.#store.conversation(
      session.id,
      ownMessage?.seq ?? session.last_seq + 1,
      HISTORY_MESSAGES,
    )) {
      const data = JSON.parse(event.data) as { text: string; parentToolCallId?: string | null };
      if (event.type === SESSION_EVENT.messageAssistant && data.parentToolCallId) continue;
      if (data.text.trim() === '') continue;
      history.push({
        role: event.type === SESSION_EVENT.messageUser ? 'user' : 'assistant',
        text: data.text,
      });
    }
    // The transcript keeps the person's own words, so the background the session began with is not in
    // it. An adapter that is handed the conversation as history finds it where it was said: at the start.
    if (
      session.seed !== null &&
      session.seed !== '' &&
      history.length > 0 &&
      !prompt.text.startsWith(session.seed)
    ) {
      history.unshift({ role: 'user', text: session.seed });
    }
    const token = this.#tokens.mint({
      runId: run.id,
      sessionId: run.sessionId,
      projectId: run.projectId,
      userId: run.userId,
      agentId: run.agentId,
    });
    return {
      runId: run.id,
      sessionId: run.sessionId,
      userId: run.userId,
      projectId: run.projectId,
      cwd: project?.rootDir ?? null,
      prompt: { text: prompt.text, attachments, quote: prompt.quote },
      model: row.model,
      effort: row.effort,
      permissionMode: mode,
      nativeSessionId: session.native_session_id,
      fastMode: session.fast_mode === 1,
      ...(account ? { accountEnvironment: account.env, accountDirectory: account.directory } : {}),
      history,
      signal: run.abort.signal,
      bridge: this.#tokens.connection(token),
      origin: row.origin,
      unattended: run.unattended,
    };
  }

  #outcomeOf(result: unknown): { status: 'completed' | 'failed'; error: RunError | null } {
    const value = (result ?? {}) as {
      status?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (value.status !== 'failed') return { status: 'completed', error: null };
    return {
      status: 'failed',
      error: {
        code: typeof value.error?.code === 'string' ? clip(value.error.code, 80) : 'agent_error',
        message:
          typeof value.error?.message === 'string'
            ? clip(value.error.message, ERROR_CHARS)
            : 'The agent reported a failure.',
      },
    };
  }

  #failureOf(run: ActiveRun, error: unknown): { status: 'failed'; error: RunError } {
    if (error instanceof AgentRunError)
      return {
        status: 'failed',
        error: { code: clip(error.code, 80), message: clip(error.message, ERROR_CHARS) },
      };
    // Anything else may carry paths, upstream bodies or credentials: it goes to the log, redacted, and not to the user.
    if (!run.stopRequested)
      this.#log.error(
        { runId: run.id, agent: run.agentId, err: redactSecrets(describeError(error)) },
        'an agent run failed unexpectedly',
      );
    return {
      status: 'failed',
      error: { code: 'agent_error', message: 'The agent stopped unexpectedly.' },
    };
  }

  #onEvent(run: ActiveRun, event: AgentEvent): void {
    if (run.phase === 'finished' || this.#shuttingDown) return;
    const sessionId = run.sessionId;
    const runId = run.id;
    switch (event.type) {
      case 'session': {
        if (
          typeof event.nativeSessionId === 'string' &&
          event.nativeSessionId !== '' &&
          event.nativeSessionId.length <= 400
        ) {
          const before = this.#store.session(sessionId);
          this.#store.updateSession(
            sessionId,
            { nativeSessionId: event.nativeSessionId },
            Date.now(),
          );
          if (before && before.native_session_id === null) this.#sessions.announceUpdate(sessionId);
        }
        return;
      }
      case 'text.delta':
      case 'thinking.delta': {
        if (typeof event.text !== 'string' || event.text === '') return;
        const kind = event.type === 'text.delta' ? 'text' : 'thinking';
        const messageId = String(event.messageId);
        let block = run.streaming.get(messageId);
        if (!block)
          run.streaming.set(
            messageId,
            (block = { kind, text: '', parentToolCallId: event.parentToolCallId ?? null }),
          );
        const offset = block.text.length;
        block.text += event.text;
        this.#sessions.live(
          sessionId,
          kind === 'text' ? LIVE_EVENT.messageDelta : LIVE_EVENT.thinkingDelta,
          {
            runId,
            messageId,
            offset,
            text: event.text,
            parentToolCallId: block.parentToolCallId,
          },
        );
        return;
      }
      case 'text': {
        const messageId = String(event.messageId);
        run.streaming.delete(messageId);
        this.#sessions.append(sessionId, runId, SESSION_EVENT.messageAssistant, {
          runId,
          messageId,
          text: String(event.text),
          model: event.model ?? null,
          parentToolCallId: event.parentToolCallId ?? null,
          partial: false,
        });
        return;
      }
      case 'thinking': {
        const messageId = String(event.messageId);
        run.streaming.delete(messageId);
        this.#sessions.append(sessionId, runId, SESSION_EVENT.thinking, {
          runId,
          messageId,
          text: String(event.text),
          parentToolCallId: event.parentToolCallId ?? null,
          partial: false,
        });
        return;
      }
      case 'tool.started': {
        const bounded = boundInput(event.input);
        run.openTools.set(String(event.toolCallId), {
          name: String(event.name),
          input: event.input,
          claimed: false,
        });
        this.#sessions.append(sessionId, runId, SESSION_EVENT.toolStarted, {
          runId,
          toolCallId: String(event.toolCallId),
          name: clip(String(event.name), 200),
          kind: event.kind,
          title: clip(String(event.title), 400),
          input: bounded.input,
          inputTruncated: bounded.truncated,
          parentToolCallId: event.parentToolCallId ?? null,
        });
        return;
      }
      case 'tool.output': {
        if (typeof event.text !== 'string' || event.text === '') return;
        const toolCallId = String(event.toolCallId);
        run.toolTails.set(
          toolCallId,
          ((run.toolTails.get(toolCallId) ?? '') + event.text).slice(-TAIL_CHARS),
        );
        this.#sessions.live(sessionId, LIVE_EVENT.toolOutput, {
          runId,
          toolCallId,
          text: clip(event.text, 64_000),
        });
        return;
      }
      case 'tool.finished': {
        const toolCallId = String(event.toolCallId);
        run.toolTails.delete(toolCallId);
        // A Studio tool the Studio itself refused is `denied`, whatever the agent's own program made of the
        // refusal it was handed (to it, a refused tool is just a tool that answered with an error).
        const refusal = event.status === 'error' ? this.#takeRefusal(run, toolCallId) : null;
        run.openTools.delete(toolCallId);
        run.refusedTools.delete(toolCallId);
        const output = boundOutput(
          refusal !== null ? refusal : typeof event.output === 'string' ? event.output : '',
        );
        const diffs = boundDiffs(event.diffs ?? []);
        this.#sessions.append(sessionId, runId, SESSION_EVENT.toolFinished, {
          runId,
          toolCallId,
          status: refusal !== null ? 'denied' : event.status,
          output: output.output,
          outputOmittedChars: output.omitted,
          diffs: diffs.diffs,
          diffsTruncated: diffs.truncated,
        });
        return;
      }
      case 'todos': {
        const items = (event.items ?? [])
          .slice(0, 200)
          .map((item) => ({ text: clip(String(item.text), 1000), status: item.status }));
        this.#sessions.append(sessionId, runId, SESSION_EVENT.todosUpdated, { runId, items });
        return;
      }
      case 'usage':
        this.#recordUsage(run, event);
        return;
      case 'notice':
        this.#sessions.append(sessionId, runId, SESSION_EVENT.notice, {
          runId,
          level: event.level,
          code: clip(String(event.code), 80),
          text: clip(String(event.text), 4000),
        });
        return;
      case 'title': {
        const title = typeof event.title === 'string' ? cleanProposedTitle(event.title) : null;
        if (title && this.#sessions.rename(sessionId, title, 'agent'))
          this.#sessions.announceUpdate(sessionId);
        return;
      }
      default:
        return;
    }
  }

  #recordUsage(run: ActiveRun, event: Extract<AgentEvent, { type: 'usage' }>): void {
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    const model = clip(String(event.model || 'unknown'), 200);
    const previous = event.cumulative ? undefined : run.usage.get(model);
    const cost =
      typeof event.costUsd === 'number' && Number.isFinite(event.costUsd) && event.costUsd >= 0
        ? event.costUsd
        : null;
    const total = {
      input: (previous?.input ?? 0) + count(event.inputTokens),
      output: (previous?.output ?? 0) + count(event.outputTokens),
      cacheRead: (previous?.cacheRead ?? 0) + count(event.cacheReadTokens),
      cacheWrite: (previous?.cacheWrite ?? 0) + count(event.cacheWriteTokens),
      cost: cost === null ? (previous?.cost ?? null) : (previous?.cost ?? 0) + cost,
    };
    run.usage.set(model, total);
    const contextTokens = event.contextTokens === undefined ? null : count(event.contextTokens);
    const contextWindow = count(event.contextWindow) > 0 ? count(event.contextWindow) : null;
    const now = Date.now();
    this.#sessions.atomic(() => {
      const stored = this.#store.usageRow(run.id, model);
      this.#store.upsertUsage({
        run_id: run.id,
        model,
        session_id: run.sessionId,
        user_id: run.userId,
        project_id: run.projectId,
        agent_id: run.agentId,
        input_tokens: total.input,
        output_tokens: total.output,
        cache_read_tokens: total.cacheRead,
        cache_write_tokens: total.cacheWrite,
        cost_usd: total.cost,
        context_tokens: contextTokens ?? stored?.context_tokens ?? null,
        context_window: contextWindow ?? stored?.context_window ?? null,
        at: now,
      });
      this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.usageReported, {
        runId: run.id,
        model,
        inputTokens: total.input,
        outputTokens: total.output,
        cacheReadTokens: total.cacheRead,
        cacheWriteTokens: total.cacheWrite,
        costUsd: total.cost,
        contextTokens,
        contextWindow,
      });
    });
  }

  /** Ends a run: exactly once, whatever raced to get here. */
  #finish(
    run: ActiveRun,
    outcome: { status: 'completed' | 'failed'; error: RunError | null },
  ): void {
    if (run.phase === 'finished') return;
    if (this.#shuttingDown) {
      // The process is going down: the run stays "running" on disk and is marked interrupted at the next start.
      run.phase = 'finished';
      run.settle();
      return;
    }
    run.phase = 'finished';
    if (run.stopTimer) clearTimeout(run.stopTimer);
    const status: TerminalRunStatus = run.stopRequested ? 'stopped' : outcome.status;
    const error = status === 'failed' ? outcome.error : null;
    const now = Date.now();
    const session = this.#store.session(run.sessionId);
    const viewers = this.#sessions.viewers(run.sessionId);
    let recorded = false;

    if (session) {
      this.#sessions.atomic(() => {
        // What was streamed but never completed is kept: a stopped run does not lose its partial answer.
        for (const [messageId, block] of run.streaming) {
          if (block.text === '') continue;
          if (block.kind === 'text') {
            this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.messageAssistant, {
              runId: run.id,
              messageId,
              text: block.text,
              model: null,
              parentToolCallId: block.parentToolCallId,
              partial: true,
            });
          } else {
            this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.thinking, {
              runId: run.id,
              messageId,
              text: block.text,
              parentToolCallId: block.parentToolCallId,
              partial: true,
            });
          }
        }
        for (const approval of this.#store.pendingApprovalsOfRun(run.id))
          this.#resolve(approval.id, {
            status: 'cancelled',
            decidedBy: null,
            note: null,
            answers: null,
          });
        // A finished result counts as seen when its owner is looking at the session; a stop is the owner's own doing.
        const seen =
          status === 'stopped' || (status === 'completed' && viewers.includes(run.userId));
        recorded = this.#store.transitionRun(run.id, ['accepted', 'running'], {
          status,
          finishedAt: now,
          errorCode: error?.code ?? null,
          errorMessage: error?.message ?? null,
          seenAt: seen ? now : null,
        });
        if (recorded) {
          this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.runFinished, {
            runId: run.id,
            status,
            error,
            interruptedByRestart: false,
            durationMs: Math.max(0, now - run.startedAt),
          });
        }
      });
    }
    run.streaming.clear();
    this.#forget(run);

    if (session && recorded) {
      const reference = {
        runId: run.id,
        sessionId: run.sessionId,
        projectId: run.projectId,
        agentId: run.agentId,
      };
      this.#sessions.toUser(run.userId, USER_AGENT_EVENT.runFinished, { ...reference, status });
      this.#sessions.internal('run.finished', {
        ...reference,
        userId: run.userId,
        origin: this.#store.run(run.id)?.origin ?? 'interactive',
        unattended: run.unattended,
        status,
        error,
        title: session.title,
        durationMs: Math.max(0, now - run.startedAt),
        visibleTo: viewers,
      });
      this.#sessions.refreshAttention(run.sessionId, { announce: true });
      this.#scheduleDrain(run.sessionId);
    }
    run.settle();
  }

  #forget(run: ActiveRun): void {
    run.phase = 'finished';
    this.#tokens.revokeRun(run.id);
    this.#active.delete(run.id);
    if (this.#activeBySession.get(run.sessionId) === run)
      this.#activeBySession.delete(run.sessionId);
    for (const [id, waiter] of this.#waiters) {
      if (waiter.run !== run) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#waiters.delete(id);
      waiter.resolve({ status: 'cancelled', decidedBy: null, note: null, answers: null });
    }
    run.settle();
  }

  #cancelHandle(run: ActiveRun): void {
    const handle = run.handle;
    if (!handle) return;
    void Promise.resolve()
      .then(() => handle.cancel())
      .catch((error: unknown) =>
        this.#log.warn(
          { runId: run.id, err: redactSecrets(describeError(error)) },
          'cancelling an agent failed',
        ),
      );
  }

  // ---- stop ----------------------------------------------------------------

  async stop(principal: Principal, sessionId: string): Promise<Run> {
    this.#sessions.requireSession(principal, sessionId, 'control');
    const run = this.#activeBySession.get(sessionId);
    if (!run) throw conflict('This session has no run in progress.', 'no_active_run');
    await this.#stopRun(run);
    return presentRun(this.#store.run(run.id)!);
  }

  async #stopRun(run: ActiveRun): Promise<void> {
    if (!run.stopRequested && run.phase !== 'finished') {
      run.stopRequested = true;
      for (const approval of this.#store.pendingApprovalsOfRun(run.id))
        this.#resolve(approval.id, {
          status: 'cancelled',
          decidedBy: null,
          note: null,
          answers: null,
        });
      run.abort.abort();
      this.#cancelHandle(run);
      // An agent that does not wind down in time is left behind; the run still ends, once.
      run.stopTimer = setTimeout(
        () => this.#finish(run, { status: 'completed', error: null }),
        this.#options.stopGraceMs,
      );
      run.stopTimer.unref();
    }
    await run.settled;
  }

  isRunning(sessionId: string): boolean {
    return this.#activeBySession.has(sessionId);
  }

  // ---- queue ---------------------------------------------------------------

  #presentQueueItem(row: QueueRow): QueuedMessage {
    const ids = JSON.parse(row.attachment_ids) as string[];
    return {
      id: row.id,
      sessionId: row.session_id,
      requestId: row.request_id,
      text: row.text,
      attachments: ids
        .map((id) => this.#store.attachment(row.session_id, id))
        .filter((attachment): attachment is AttachmentRow => attachment !== undefined)
        .map(attachmentRef),
      quote: row.quote,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #queueOf(sessionId: string): QueuedMessage[] {
    return this.#store.queue(sessionId).map((row) => this.#presentQueueItem(row));
  }

  #announceQueue(sessionId: string, taken: { itemId: string; runId: string } | null): void {
    this.#sessions.live(sessionId, LIVE_EVENT.queueChanged, {
      queue: this.#queueOf(sessionId),
      taken,
    });
  }

  queue(principal: Principal, sessionId: string): QueuedMessage[] {
    this.#sessions.requireSession(principal, sessionId, 'view');
    return this.#queueOf(sessionId);
  }

  editQueued(principal: Principal, sessionId: string, itemId: string, text: string): QueuedMessage {
    this.#sessions.requireSession(principal, sessionId, 'write');
    if (!this.#store.updateQueueText(sessionId, itemId, text, Date.now())) throw this.#notQueued();
    this.#announceQueue(sessionId, null);
    return this.#presentQueueItem(this.#store.queueItem(sessionId, itemId)!);
  }

  removeQueued(principal: Principal, sessionId: string, itemId: string): void {
    this.#sessions.requireSession(principal, sessionId, 'write');
    const item = this.#store.queueItem(sessionId, itemId);
    if (!item) throw this.#notQueued();
    this.#sessions.atomic(() => {
      this.#store.deleteQueueItem(sessionId, itemId);
      // Removing it withdraws the message: its request id is free again.
      this.#store.deleteReceipt(item.user_id, item.request_id);
    });
    this.#announceQueue(sessionId, null);
  }

  #notQueued() {
    return conflict(
      'That message is no longer queued — it may already have been sent.',
      'not_queued',
    );
  }

  /** Sends one queued message ahead of the rest: into the running turn if it can take it, otherwise as the very next turn. */
  async sendNow(principal: Principal, sessionId: string, itemId: string): Promise<SendNowResponse> {
    this.#sessions.requireSession(principal, sessionId, 'write');
    const item = this.#store.queueItem(sessionId, itemId);
    if (!item) throw this.#notQueued();
    const run = this.#activeBySession.get(sessionId);

    if (run && run.handle?.steer && run.phase === 'running' && !run.stopRequested) {
      const ids = JSON.parse(item.attachment_ids) as string[];
      const attachments = ids
        .map((id) => this.#store.attachment(sessionId, id))
        .filter((row): row is AttachmentRow => row !== undefined);
      let taken = false;
      try {
        taken = await Promise.race([
          Promise.resolve(
            run.handle.steer({
              text: withQuote(item.text, item.quote),
              attachments: attachments.map((row) => this.#promptAttachment(row)),
            }),
          ),
          run.settled.then(() => false),
        ]);
      } catch (error) {
        this.#log.warn(
          { runId: run.id, err: redactSecrets(describeError(error)) },
          'steering a run failed',
        );
      }
      // The item may have been sent or removed while the agent was deciding.
      if (taken && this.#store.queueItem(sessionId, itemId)) {
        const now = Date.now();
        this.#sessions.atomic(() => {
          this.#store.deleteQueueItem(sessionId, itemId);
          this.#store.updateReceipt(item.user_id, item.request_id, 'steered', run.id, null);
          this.#store.updateSession(sessionId, { lastUserMessageAt: now }, now);
          this.#sessions.append(sessionId, run.id, SESSION_EVENT.messageUser, {
            runId: run.id,
            requestId: item.request_id,
            origin: 'steer',
            text: item.text,
            attachments: attachments.map(attachmentRef),
            quote: item.quote,
            continuesRunId: null,
          });
        });
        this.#announceQueue(sessionId, { itemId, runId: run.id });
        this.#sessions.announceUpdate(sessionId);
        return { outcome: 'steered', runId: run.id };
      }
      if (taken) return { outcome: 'steered', runId: run.id };
    }

    if (!this.#store.queueItem(sessionId, itemId)) throw this.#notQueued();
    this.#store.moveQueueItemToFront(sessionId, itemId);
    this.#announceQueue(sessionId, null);
    const running = this.#activeBySession.get(sessionId);
    if (!running) return { outcome: 'next', runId: this.#drain(sessionId, true) };
    // A turn that can be steered but missed this message is left to finish; the message is first in line.
    if (running.handle?.steer) return { outcome: 'next', runId: null };
    // The turn cannot take a message at all: stop it, then this one goes first.
    await this.#stopRun(running);
    return { outcome: 'interrupted', runId: this.#drain(sessionId, true) };
  }

  #scheduleDrain(sessionId: string): void {
    if (this.#shuttingDown || this.#drainTimers.has(sessionId)) return;
    this.#drainTimers.set(
      sessionId,
      setImmediate(() => {
        this.#drainTimers.delete(sessionId);
        try {
          this.#drain(sessionId, false);
        } catch (error) {
          this.#log.error(
            { sessionId, err: redactSecrets(describeError(error)) },
            'sending a queued message failed',
          );
        }
      }),
    );
  }

  /**
   * Sends the first queued message as a normal run, if the session is free.
   * After a failed or interrupted run the queue waits for the person to deal
   * with it — unless they pressed "send now" (`force`).
   */
  #drain(sessionId: string, force: boolean): string | null {
    if (this.#shuttingDown || this.#store.activeRun(sessionId)) return null;
    const session = this.#store.session(sessionId);
    const item = this.#store.queue(sessionId)[0];
    if (!session || !item) return null;
    if (!force) {
      const latest = this.#store.latestRun(sessionId);
      if (
        latest &&
        (latest.status === 'failed' || latest.status === 'interrupted') &&
        latest.dismissed_at === null &&
        latest.continued_by_run_id === null
      ) {
        return null;
      }
    }
    // The account behind a queued message may have lost its access since; then it simply stays queued.
    const principal = this.principalFor(item.user_id);
    if (!principal) return null;
    if (
      session.project_id !== null &&
      this.#context.services.projects.accessOf(principal, session.project_id) !== 'write'
    )
      return null;

    const receipt = this.#store.receipt(item.user_id, item.request_id);
    let runId: string | null = null;
    this.#sessions.atomic(() => {
      this.#store.deleteQueueItem(sessionId, item.id);
      const started = this.#start(session, item.user_id, {
        requestId: item.request_id,
        hash: receipt?.request_hash ?? '',
        text: item.text,
        promptText: item.text,
        attachmentIds: JSON.parse(item.attachment_ids) as string[],
        quote: item.quote,
        origin: 'queued',
        unattended: false,
        waitForApproval: false,
        receipt: receipt ? 'update' : 'insert',
        continuesRunId: null,
      });
      runId = started.runId;
    });
    if (runId) this.#announceQueue(sessionId, { itemId: item.id, runId });
    return runId;
  }

  // ---- recovery records ----------------------------------------------------

  listRuns(
    principal: Principal,
    query: {
      state: 'unresolved' | 'active' | 'all';
      projectId?: string | undefined;
      sessionId?: string | undefined;
      limit: number;
    },
  ): Run[] {
    if (query.sessionId !== undefined)
      this.#sessions.requireSession(principal, query.sessionId, 'view');
    if (query.projectId !== undefined)
      this.#context.services.projects.requireAccess(principal, query.projectId);
    const visible = new Set(
      this.#context.services.projects
        .list(principal, { includeArchived: true })
        .map((project) => project.id),
    );
    return this.#store
      .listRuns({
        // Without a session the list is the caller's own runs. With one, it is that session's runs: whoever may
        // look at the session — its creator, or the instance owner — sees them, whoever started them.
        userId: query.sessionId === undefined ? principal.userId : null,
        state: query.state,
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
        limit: query.limit,
      })
      .filter((row) => row.project_id === null || visible.has(row.project_id))
      .map(presentRun);
  }

  /** A run the caller may look at: their own, or — for the instance owner — anyone's. */
  #requireRun(principal: Principal, runId: string, need: 'view' | 'control' | 'write'): RunRow {
    const row = this.#store.run(runId);
    if (!row) throw notFound('No such run.', 'run_not_found');
    try {
      this.#sessions.requireSession(principal, row.session_id, need);
    } catch (error) {
      if ((error as { status?: number }).status === 404)
        throw notFound('No such run.', 'run_not_found');
      throw error;
    }
    return row;
  }

  getRun(principal: Principal, runId: string): Run {
    return presentRun(this.#requireRun(principal, runId, 'view'));
  }

  /**
   * Continues a failed or interrupted run: a new run in the same session that
   * resumes the agent's own conversation. Only one continuation can claim a
   * record; it uses the session's current model and permission mode, and no
   * earlier approval carries over.
   */
  async continueRun(
    principal: Principal,
    runId: string,
    requestId: string,
  ): Promise<MessageReceipt> {
    const record = this.#requireRun(principal, runId, 'write');
    const session = this.#store.session(record.session_id)!;
    const hash = sha256(JSON.stringify(['continue', runId]));
    const known = this.#store.receipt(principal.userId, requestId);
    if (known) return this.#duplicate(known, hash, session.id);
    if (record.status !== 'failed' && record.status !== 'interrupted')
      throw conflict('Only a failed or interrupted run can be continued.', 'run_not_continuable');
    if (record.continued_by_run_id !== null || record.dismissed_at !== null)
      throw conflict('That run was already continued or dismissed.', 'run_not_available');
    if (!this.#adapters.has(session.agent_id))
      throw unprocessable(
        'The agent of this session is not available on this Studio.',
        'agent_unavailable',
      );
    const prompt = JSON.parse(record.prompt) as { attachmentIds: string[]; quote: string | null };
    return Promise.resolve(
      this.#start(session, principal.userId, {
        requestId,
        hash,
        // The original request, never a continuation of a continuation.
        text: record.source_text,
        promptText: `${CONTINUATION_PREAMBLE}\n\n${record.source_text}`,
        attachmentIds: prompt.attachmentIds,
        quote: prompt.quote,
        origin: 'continue',
        unattended: false,
        waitForApproval: false,
        receipt: 'insert',
        continuesRunId: runId,
      }),
    );
  }

  /** Marks a failed or interrupted run as dealt with, without running anything. */
  dismissRun(principal: Principal, runId: string): { run: Run; alreadyHandled: boolean } {
    const record = this.#requireRun(principal, runId, 'control');
    if (record.status === 'accepted' || record.status === 'running')
      throw conflict('That run is still in progress.', 'run_in_progress');
    if (record.status !== 'failed' && record.status !== 'interrupted') {
      // A finished result: acknowledging it marks it read.
      this.#sessions.markSeen(record.session_id);
      return { run: presentRun(this.#store.run(runId)!), alreadyHandled: record.seen_at !== null };
    }
    const dismissed = this.#store.dismissRun(runId, Date.now());
    if (dismissed) {
      this.#sessions.refreshAttention(record.session_id, { announce: true });
      this.#scheduleDrain(record.session_id);
    }
    return { run: presentRun(this.#store.run(runId)!), alreadyHandled: !dismissed };
  }

  // ---- snapshot and replay (the realtime topic) -----------------------------

  snapshot(sessionId: string): SessionSnapshot | null {
    const session = this.#store.session(sessionId);
    if (!session) return null;
    const run = this.#activeBySession.get(sessionId);
    const row = this.#store.activeRun(sessionId);
    return {
      sessionId,
      lastSeq: session.last_seq,
      run: row ? presentRun(row) : null,
      streaming: run
        ? [...run.streaming].map(([messageId, block]) => ({
            messageId,
            kind: block.kind,
            text: block.text,
            parentToolCallId: block.parentToolCallId,
          }))
        : [],
      toolOutput: run ? [...run.toolTails].map(([toolCallId, text]) => ({ toolCallId, text })) : [],
      pendingApprovals: this.#store.pendingApprovalsOfSession(sessionId).map(presentApproval),
      queue: this.#queueOf(sessionId),
      unresolvedRuns: this.#store.unresolvedRuns(sessionId).map(presentRun),
    };
  }

  // ---- permissions ---------------------------------------------------------

  #rulesFor(run: { userId: string; projectId: string | null; sessionId: string }): EngineRule[] {
    return this.#store.rulesForRun(run).map((rule) => ({
      id: rule.id,
      scope: rule.scope,
      effect: rule.effect,
      tool: rule.tool,
      pattern: rule.pattern,
    }));
  }

  async #requestPermission(
    run: ActiveRun,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const cancelled: PermissionDecision = {
      behavior: 'deny',
      message: 'The run was stopped.',
      source: 'cancelled',
    };
    if (run.phase === 'finished' || run.stopRequested || this.#shuttingDown) return cancelled;
    const session = this.#store.session(run.sessionId);
    if (!session) return cancelled;
    const project = this.#projectOf(session);
    const env = this.#environment(session, project);
    const toolName = clip(String(request.toolName), 200);
    const command = typeof request.command === 'string' ? request.command : null;
    const paths = (request.paths ?? [])
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, 200);

    if (request.approval === 'plan') {
      if (run.unattended && !run.waitForApproval) {
        this.#notice(
          run,
          'approval_skipped',
          'Nobody is watching this run, so its plan was not put up for approval.',
        );
        return {
          behavior: 'deny',
          message: 'Nobody is available to approve the plan in an unattended run.',
          source: 'unattended',
        };
      }
      const resolution = await this.#ask(run, session, {
        kind: 'plan',
        toolName,
        toolKind: request.kind,
        toolCallId: request.toolCallId ?? null,
        title: request.title ?? 'Approve the plan',
        detail: {
          command: null,
          paths: [],
          diff: null,
          input: boundInput(request.input).input,
          plan: clip(String(request.plan ?? ''), 200_000),
          questions: null,
          suggestedRule: null,
        },
        risk: 'medium',
        categories: [],
        reason: 'The agent has a plan and waits for your approval before it changes anything.',
        toolRequest: null,
        questions: null,
        ttlMs: this.#options.approvalTtlMs,
      });
      return this.#decisionFrom(resolution, request.input, 'Keep revising the plan.');
    }

    const toolRequest: ToolRequest = {
      toolName,
      kind: request.kind,
      command,
      paths,
      url: request.url ?? null,
    };
    const outcome = evaluatePermission({
      request: toolRequest,
      mode: session.permission_mode,
      rules: this.#rulesFor(run),
      env,
    });
    // `requireHuman`: what the mode or a rule would allow is still put to a person, and cannot be remembered.
    const mustAsk = request.requireHuman === true && outcome.decision === 'allow';

    if (outcome.decision === 'allow' && !mustAsk) {
      if (outcome.risk === 'dangerous')
        this.#audit(
          'approval.auto-allowed',
          run.userId,
          request,
          `auto mode · ${outcome.categories.join(', ')}`,
        );
      return {
        behavior: 'allow',
        updatedInput: request.input,
        source: outcome.code === 'allow_rule' ? 'rule' : 'mode',
      };
    }
    if (outcome.decision === 'deny') {
      if (outcome.risk === 'dangerous')
        this.#audit(
          'approval.auto-denied',
          run.userId,
          request,
          `${outcome.code} · ${outcome.categories.join(', ')}`,
          'failure',
        );
      return {
        behavior: 'deny',
        message: outcome.reason,
        source:
          outcome.code === 'deny_rule' ? 'rule' : outcome.code === 'hard_deny' ? 'policy' : 'mode',
      };
    }
    if (run.unattended && !run.waitForApproval) {
      this.#notice(
        run,
        'approval_skipped',
        `Nobody is watching this run, so "${clip(request.title ?? toolName, 200)}" was denied instead of waiting for approval.`,
      );
      return {
        behavior: 'deny',
        message: 'This needs approval, and nobody is watching an unattended run.',
        source: 'unattended',
      };
    }

    const resolution = await this.#ask(run, session, {
      kind: 'tool',
      toolName,
      toolKind: request.kind,
      toolCallId: request.toolCallId ?? null,
      title: request.title ?? defaultTitle(request),
      detail: {
        command: command === null ? null : clip(command, 100_000),
        paths,
        diff:
          typeof request.diff === 'string' ? clip(request.diff, AGENT_LIMITS.toolDiffChars) : null,
        input: boundInput(request.input).input,
        plan: null,
        questions: null,
        suggestedRule: request.requireHuman === true ? null : suggestRule(toolRequest, env),
      },
      risk: outcome.risk,
      categories: outcome.categories,
      reason: mustAsk
        ? 'This is not covered by the permission mode or by saved rules: a person has to approve it each time.'
        : outcome.reason,
      // Without the engine's request a rule saved later cannot answer this one in passing.
      toolRequest: request.requireHuman === true ? null : toolRequest,
      questions: null,
      ttlMs: this.#options.approvalTtlMs,
    });
    if (
      outcome.risk === 'dangerous' &&
      (resolution.status === 'allowed' ||
        resolution.status === 'denied' ||
        resolution.status === 'expired')
    ) {
      this.#audit(
        resolution.status === 'allowed' ? 'approval.allowed' : 'approval.denied',
        resolution.decidedBy ?? run.userId,
        request,
        `${resolution.status} · ${outcome.categories.join(', ')}`,
      );
    }
    return this.#decisionFrom(resolution, request.input, 'The user denied this request.');
  }

  #decisionFrom(resolution: Resolution, input: unknown, denial: string): PermissionDecision {
    switch (resolution.status) {
      case 'allowed':
        return { behavior: 'allow', updatedInput: input, source: 'user' };
      case 'denied':
        return {
          behavior: 'deny',
          message: resolution.note && resolution.note.trim() !== '' ? resolution.note : denial,
          source: 'user',
        };
      case 'expired':
        return {
          behavior: 'deny',
          message: 'Nobody answered in time, so this was denied.',
          source: 'expired',
        };
      default:
        return { behavior: 'deny', message: 'The run was stopped.', source: 'cancelled' };
    }
  }

  async #askUser(run: ActiveRun, question: UserQuestionRequest): Promise<UserQuestionAnswer> {
    if (run.phase === 'finished' || run.stopRequested || this.#shuttingDown)
      return { status: 'cancelled', answers: [] };
    const session = this.#store.session(run.sessionId);
    if (!session) return { status: 'cancelled', answers: [] };
    if (run.unattended && !run.waitForApproval) {
      this.#notice(
        run,
        'question_skipped',
        "Nobody is watching this run, so the agent's question was left for it to decide.",
      );
      return { status: 'unattended', answers: [] };
    }
    const questions: Question[] = (question.questions ?? []).slice(0, 20).map((entry, index) => ({
      id: clip(String(entry.id ?? index + 1), 200),
      ...(entry.header === undefined ? {} : { header: clip(String(entry.header), 200) }),
      question: clip(String(entry.question ?? ''), 4000),
      options: (entry.options ?? []).slice(0, 20).map((option) => ({
        label: clip(String(option.label), 2000),
        ...(option.description === undefined
          ? {}
          : { description: clip(String(option.description), 4000) }),
        ...(option.recommended === true || RECOMMENDED.test(String(option.label))
          ? { recommended: true }
          : {}),
      })),
      multiSelect: entry.multiSelect === true,
    }));
    const resolution = await this.#ask(run, session, {
      kind: 'question',
      toolName: null,
      toolKind: null,
      toolCallId: question.toolCallId ?? null,
      title:
        questions.length === 1
          ? clip(questions[0]!.question, 200)
          : `${questions.length} questions from the agent`,
      detail: {
        command: null,
        paths: [],
        diff: null,
        input: null,
        plan: null,
        questions,
        suggestedRule: null,
      },
      risk: 'low',
      categories: [],
      reason: 'The agent needs an answer from you to continue.',
      toolRequest: null,
      questions,
      ttlMs: this.#options.questionTtlMs,
    });
    switch (resolution.status) {
      case 'allowed':
        return { status: 'answered', answers: resolution.answers ?? [] };
      case 'denied':
        return { status: 'skipped', answers: [] };
      case 'expired':
        return { status: 'expired', answers: resolution.answers ?? [] };
      default:
        return { status: 'cancelled', answers: [] };
    }
  }

  #notice(run: ActiveRun, code: string, text: string): void {
    if (run.phase === 'finished') return;
    this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.notice, {
      runId: run.id,
      level: 'warning',
      code,
      text,
    });
  }

  #audit(
    action: string,
    userId: string,
    request: PermissionRequest,
    detail: string,
    category: 'change' | 'failure' = 'change',
  ): void {
    try {
      this.#context.services.audit.record({
        category,
        action,
        userId,
        subject: clip(String(request.title ?? request.toolName), 180),
        detail: clip(
          `${detail}${typeof request.command === 'string' ? ` · ${request.command}` : ''}`,
          480,
        ),
      });
    } catch (error) {
      this.#log.error({ err: describeError(error) }, 'writing the audit log failed');
    }
  }

  /** Records an approval, tells everyone who can answer it, and waits. */
  #ask(
    run: ActiveRun,
    session: SessionRow,
    spec: {
      kind: ApprovalKind;
      toolName: string | null;
      toolKind: string | null;
      toolCallId: string | null;
      title: string;
      detail: ApprovalDetail;
      risk: ApprovalRow['risk'];
      categories: readonly string[];
      reason: string;
      toolRequest: ToolRequest | null;
      questions: readonly Question[] | null;
      ttlMs: number;
    },
  ): Promise<Resolution> {
    const now = Date.now();
    const row: ApprovalRow = {
      id: newId(),
      run_id: run.id,
      session_id: run.sessionId,
      user_id: run.userId,
      project_id: run.projectId,
      kind: spec.kind,
      tool_name: spec.toolName,
      tool_kind: spec.toolKind,
      tool_call_id: spec.toolCallId === null ? null : clip(spec.toolCallId, 200),
      title: clip(spec.title, 400),
      detail: JSON.stringify(spec.detail),
      risk: spec.risk,
      risk_categories: JSON.stringify(spec.categories),
      reason: clip(spec.reason, 1000),
      status: 'pending',
      decided_by: null,
      decided_at: null,
      note: null,
      answers: null,
      expires_at: spec.ttlMs > 0 ? now + spec.ttlMs : null,
      created_at: now,
    };
    return new Promise<Resolution>((resolve) => {
      const waiter: Waiter = {
        approvalId: row.id,
        run,
        kind: spec.kind,
        toolRequest: spec.toolRequest,
        questions: spec.questions,
        resolve,
        timer: null,
      };
      this.#waiters.set(row.id, waiter);
      const approval = presentApproval(row);
      try {
        this.#sessions.atomic(() => {
          this.#store.insertApproval(row);
          this.#sessions.append(run.sessionId, run.id, SESSION_EVENT.approvalRequested, {
            runId: run.id,
            approval,
          });
        });
      } catch (error) {
        this.#waiters.delete(row.id);
        this.#log.error(
          { runId: run.id, err: redactSecrets(describeError(error)) },
          'recording an approval failed',
        );
        resolve({ status: 'cancelled', decidedBy: null, note: null, answers: null });
        return;
      }
      if (spec.ttlMs > 0) {
        waiter.timer = setTimeout(() => this.#expire(row.id), spec.ttlMs);
        waiter.timer.unref();
      }
      const viewers = this.#sessions.viewers(run.sessionId);
      this.#sessions.toUser(run.userId, USER_AGENT_EVENT.approvalPending, { approval });
      // A member cannot allow a dangerous request: the owners are told too.
      if (approval.requiresOwner) {
        for (const owner of this.#owners()) {
          if (owner !== run.userId)
            this.#sessions.toUser(owner, USER_AGENT_EVENT.approvalPending, { approval });
        }
      }
      this.#sessions.internal('approval.pending', {
        approvalId: row.id,
        runId: run.id,
        sessionId: run.sessionId,
        projectId: run.projectId,
        userId: run.userId,
        agentId: run.agentId,
        kind: spec.kind,
        toolName: spec.toolName,
        title: session.title,
        risk: spec.risk,
        requiresOwner: approval.requiresOwner,
        expiresAt: row.expires_at,
        visibleTo: viewers,
      });
      this.#sessions.refreshAttention(run.sessionId, { announce: true });
    });
  }

  #owners(): string[] {
    return this.#context.services.auth
      .listUsers()
      .filter((user) => user.role === 'owner' && !user.disabled)
      .map((user) => user.id);
  }

  /** Resolves an approval exactly once. False when someone else got there first. */
  #resolve(approvalId: string, resolution: Resolution): boolean {
    const row = this.#store.approval(approvalId);
    if (!row) return false;
    const done = this.#sessions.atomic(() => {
      const won = this.#store.resolveApproval(
        approvalId,
        resolution.status,
        resolution.decidedBy,
        Date.now(),
        resolution.note,
        resolution.answers === null ? null : JSON.stringify(resolution.answers),
      );
      if (won) {
        // An approved plan lets the work start: the session leaves plan mode in the same step, so that
        // whoever hears of the approval — the agent first of all — already finds the new mode in force.
        if (resolution.sessionMode !== undefined)
          this.#store.updateSession(
            row.session_id,
            { permissionMode: resolution.sessionMode },
            Date.now(),
          );
        this.#sessions.append(row.session_id, row.run_id, SESSION_EVENT.approvalResolved, {
          runId: row.run_id,
          approvalId,
          status: resolution.status,
          decidedBy: resolution.decidedBy,
          note: resolution.note,
          answers: resolution.answers,
        });
      }
      return won;
    });
    if (!done) return false;
    const waiter = this.#waiters.get(approvalId);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#waiters.delete(approvalId);
    }
    const summary = {
      approvalId,
      sessionId: row.session_id,
      runId: row.run_id,
      status: resolution.status,
    };
    this.#sessions.toUser(row.user_id, USER_AGENT_EVENT.approvalResolved, summary);
    if (row.risk === 'dangerous') {
      for (const owner of this.#owners()) {
        if (owner !== row.user_id)
          this.#sessions.toUser(owner, USER_AGENT_EVENT.approvalResolved, summary);
      }
    }
    this.#sessions.internal('approval.resolved', {
      ...summary,
      projectId: row.project_id,
      userId: row.user_id,
      decidedBy: resolution.decidedBy,
    });
    this.#sessions.refreshAttention(row.session_id, { announce: true });
    waiter?.resolve(resolution);
    return true;
  }

  #expire(approvalId: string): void {
    if (this.#shuttingDown) return;
    const waiter = this.#waiters.get(approvalId);
    // An unanswered question may only be answered with what the agent itself recommended.
    const answers =
      waiter?.kind === 'question' && waiter.questions
        ? waiter.questions
            .map((question): QuestionAnswer => {
              const recommended = question.options
                .filter((option) => option.recommended === true)
                .map((option) => option.label);
              return {
                questionId: question.id,
                selected: question.multiSelect ? recommended : recommended.slice(0, 1),
              };
            })
            .filter((answer) => answer.selected.length > 0)
        : null;
    this.#resolve(approvalId, { status: 'expired', decidedBy: null, note: null, answers });
  }

  /** An approval the caller may see: one of their own runs, or — for the instance owner — anyone's. */
  #requireApproval(principal: Principal, approvalId: string): ApprovalRow {
    const row = this.#store.approval(approvalId);
    const missing = () => notFound('No such approval.', 'approval_not_found');
    if (!row) throw missing();
    try {
      this.#sessions.requireSession(principal, row.session_id, 'view');
    } catch (error) {
      if ((error as { status?: number }).status === 404) throw missing();
      throw error;
    }
    return row;
  }

  getApproval(principal: Principal, approvalId: string): Approval {
    return presentApproval(this.#requireApproval(principal, approvalId));
  }

  listApprovals(
    principal: Principal,
    query: { status: 'pending' | 'all'; sessionId?: string | undefined; limit: number },
  ): Approval[] {
    if (query.sessionId !== undefined)
      this.#sessions.requireSession(principal, query.sessionId, 'view');
    const visible = new Set(
      this.#context.services.projects
        .list(principal, { includeArchived: true })
        .map((project) => project.id),
    );
    return this.#store
      .listApprovals({
        userId: principal.userId,
        isOwner: principal.role === 'owner',
        status: query.status,
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
        limit: query.limit,
      })
      .filter((row) => row.project_id === null || visible.has(row.project_id))
      .map(presentApproval);
  }

  /**
   * The mode a session continues in once its plan is approved: the one chosen
   * with the approval, or `ask` for a session that was planning. A session
   * that was in another mode (the agent chose to plan by itself) keeps it.
   */
  async #modeAfterPlan(
    row: ApprovalRow,
    chosen: PermissionMode | undefined,
  ): Promise<PermissionMode | undefined> {
    const agentId = this.#store.session(row.session_id)?.agent_id;
    const adapter = agentId === undefined ? undefined : this.#adapters.get(agentId);
    const supported: readonly PermissionMode[] = adapter
      ? (await adapter.capabilities()).permissionModes
      : [];
    // Read after the wait above: the mode may have been changed meanwhile.
    const session = this.#store.session(row.session_id);
    if (!session) return undefined;
    if (chosen === undefined)
      return session.permission_mode === 'plan' && supported.includes('ask') ? 'ask' : undefined;
    if (!supported.includes(chosen))
      throw unprocessable(
        `${adapter?.displayName ?? 'This agent'} does not have that permission mode.`,
        'unsupported_permission_mode',
      );
    if (chosen === 'auto' && !this.#sessions.autoModeEnabled(this.#projectOf(session))) {
      throw unprocessable(
        'Auto mode is not enabled for this project. Its owner can enable it in the project settings.',
        'auto_mode_not_enabled',
      );
    }
    return chosen;
  }

  /** Answers an approval. The first answer wins; later ones are told so. */
  async decide(
    principal: Principal,
    approvalId: string,
    body: ApprovalDecisionRequest,
  ): Promise<ApprovalDecisionResponse> {
    const row = this.#requireApproval(principal, approvalId);
    const resolved = () =>
      conflict('That request has already been answered.', 'approval_resolved', {
        status: this.#store.approval(approvalId)?.status,
      });
    if (row.status !== 'pending') throw resolved();
    if (row.expires_at !== null && Date.now() >= row.expires_at) {
      this.#expire(approvalId);
      throw resolved();
    }
    const remember = body.remember !== undefined;
    const authority = approvalAuthority({
      decision: body.decision,
      risk: row.risk,
      remember,
      deciderRole: principal.role,
      deciderIsRunUser: principal.userId === row.user_id,
    });
    if (!authority.ok) throw forbidden(authority.reason, authority.code);

    const detail = JSON.parse(row.detail) as ApprovalDetail;
    if (remember) {
      if (body.decision !== 'allow' || row.kind !== 'tool' || detail.suggestedRule === null) {
        throw unprocessable('This request cannot be remembered.', 'remember_not_allowed');
      }
      // A rule belongs to the person whose runs it governs.
      if (principal.userId !== row.user_id)
        throw forbidden(
          'Only the person whose run is asking can save a rule for it.',
          'remember_not_allowed',
        );
      if (body.remember === 'project' && row.project_id === null)
        throw unprocessable('This session is not in a project.', 'remember_not_allowed');
    }
    let answers: QuestionAnswer[] | null = null;
    if (row.kind === 'question' && body.decision === 'allow') {
      const known = new Set((detail.questions ?? []).map((question) => question.id));
      answers = (body.answers ?? []).filter((answer) => known.has(answer.questionId));
    }
    const approvesPlan = row.kind === 'plan' && body.decision === 'allow';
    if (body.permissionMode !== undefined && !approvesPlan) {
      throw unprocessable(
        'A permission mode can only be chosen when approving a plan.',
        'mode_not_applicable',
      );
    }
    const sessionMode = approvesPlan
      ? await this.#modeAfterPlan(row, body.permissionMode)
      : undefined;

    const won = this.#resolve(approvalId, {
      status: body.decision === 'allow' ? 'allowed' : 'denied',
      decidedBy: principal.userId,
      note: body.note ?? null,
      answers,
      ...(sessionMode === undefined ? {} : { sessionMode }),
    });
    if (!won) throw resolved();

    let rule: PermissionRule | null = null;
    const alsoResolved: string[] = [];
    if (remember && detail.suggestedRule) {
      const scope = body.remember === 'always' ? 'account' : body.remember!;
      rule = this.#saveRule({
        scope,
        user_id: row.user_id,
        project_id: scope === 'project' ? row.project_id : null,
        session_id: scope === 'session' ? row.session_id : null,
        effect: 'allow',
        tool: detail.suggestedRule.tool,
        pattern: detail.suggestedRule.pattern,
        shared: 0,
      });
      // The same tap answers every other waiting request the new rule covers.
      for (const waiter of [...this.#waiters.values()]) {
        if (waiter.kind !== 'tool' || !waiter.toolRequest || waiter.run.userId !== row.user_id)
          continue;
        const session = this.#store.session(waiter.run.sessionId);
        if (!session) continue;
        const outcome = evaluatePermission({
          request: waiter.toolRequest,
          mode: session.permission_mode,
          rules: this.#rulesFor(waiter.run),
          env: this.#environment(session, this.#projectOf(session)),
        });
        if (
          outcome.decision === 'allow' &&
          this.#resolve(waiter.approvalId, {
            status: 'allowed',
            decidedBy: principal.userId,
            note: null,
            answers: null,
          })
        ) {
          alsoResolved.push(waiter.approvalId);
        }
      }
    }
    return { approval: presentApproval(this.#store.approval(approvalId)!), rule, alsoResolved };
  }

  // ---- permission rules ----------------------------------------------------

  #saveRule(input: Omit<RuleRow, 'id' | 'created_at'>): PermissionRule {
    const existing = this.#store.findRule(input);
    if (existing) return presentRule(existing);
    if (this.#store.countRules(input.user_id) >= MAX_RULES_PER_USER)
      throw conflict('Too many permission rules are saved. Remove some first.', 'too_many_rules');
    const row: RuleRow = { ...input, id: newId(), created_at: Date.now() };
    this.#store.insertRule(row);
    return presentRule(row);
  }

  createRule(
    principal: Principal,
    input: {
      scope: RuleRow['scope'];
      projectId?: string | undefined;
      sessionId?: string | undefined;
      effect: RuleRow['effect'];
      tool: string;
      pattern?: string | undefined;
      shared: boolean;
    },
  ): PermissionRule {
    if ((input.pattern?.match(/\*/g)?.length ?? 0) > 12)
      throw unprocessable('Use fewer wildcards in the pattern.', 'pattern_too_complex');
    let projectId: string | null = null;
    let sessionId: string | null = null;
    if (input.scope === 'project') {
      projectId = this.#context.services.projects.requireAccess(
        principal,
        input.projectId!,
        'write',
      ).id;
    } else if (input.scope === 'session') {
      sessionId = this.#sessions.requireSession(principal, input.sessionId!, 'write').row.id;
    }
    if (input.shared) {
      // A rule for everyone in a project can only tighten, and only the owner may set it.
      if (principal.role !== 'owner')
        throw forbidden(
          'Only the owner of this Studio can set a rule for everyone.',
          'owner_required',
        );
      if (input.scope !== 'project' || input.effect === 'allow')
        throw unprocessable(
          'A rule for everyone must be a project rule that denies or asks.',
          'invalid_shared_rule',
        );
    }
    return this.#saveRule({
      scope: input.scope,
      user_id: principal.userId,
      project_id: projectId,
      session_id: sessionId,
      effect: input.effect,
      tool: input.tool,
      pattern: input.pattern ?? null,
      shared: input.shared ? 1 : 0,
    });
  }

  listRules(
    principal: Principal,
    query: {
      scope?: RuleRow['scope'] | undefined;
      projectId?: string | undefined;
      sessionId?: string | undefined;
    },
  ): PermissionRule[] {
    if (query.projectId !== undefined)
      this.#context.services.projects.requireAccess(principal, query.projectId);
    if (query.sessionId !== undefined)
      this.#sessions.requireSession(principal, query.sessionId, 'view');
    return this.#store
      .listRules({
        userId: principal.userId,
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
        ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
        sharedProjectIds: this.#context.services.projects.visibleProjectIds(principal),
      })
      .map(presentRule);
  }

  deleteRule(principal: Principal, ruleId: string): void {
    const row = this.#store.rule(ruleId);
    // Someone else's rule answers like one that does not exist — except a shared rule, which its project's people can see.
    const mine = row !== undefined && row.user_id === principal.userId;
    const ownerOfShared = row !== undefined && row.shared === 1 && principal.role === 'owner';
    if (!row || (!mine && !ownerOfShared)) throw notFound('No such rule.', 'rule_not_found');
    this.#store.deleteRule(ruleId);
  }

  // ---- the Studio's own tools, for the bridge and for API adapters -----------

  studioTools(): StudioToolDescription[] {
    const registry = this.#context.agentTools;
    return registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: registry.inputJsonSchema(tool),
      effect: tool.effect,
    }));
  }

  /**
   * The tools one run is offered: all of them, except that a run in a helper
   * session gets none — it is there to write one answer from what it was
   * given, not to look things up or to change anything.
   */
  studioToolsFor(runId: string): StudioToolDescription[] {
    const run = this.#active.get(runId);
    if (!run || this.#sessions.isHidden(run.sessionId)) return [];
    return this.studioTools();
  }

  /**
   * Calls a registered tool with the identity of one run. `write` tools go through the permission engine first.
   *
   * A refusal is recorded against the tool call it belongs to, so that the transcript shows that call as
   * `denied` — for every adapter, without anybody reading the refusal's wording. Which tool call that is comes
   * from `options.toolCallId` when the caller knows it (an adapter calling directly; the bridge, when the agent's
   * program names the call), and otherwise from the run's own record of the calls its adapter has announced.
   */
  async callStudioTool(
    runId: string,
    name: string,
    input: unknown,
    options: { toolCallId?: string; signal?: AbortSignal } = {},
  ): Promise<AgentToolResult> {
    const run = this.#active.get(runId);
    if (!run || run.phase === 'finished') return { text: 'This run has ended.', isError: true };
    if (this.#sessions.isHidden(run.sessionId))
      return { text: 'This run has no tools.', isError: true };
    const tool = this.#context.agentTools.get(name);
    if (!tool) return { text: `There is no tool named "${name}".`, isError: true };
    let effective = input;
    if (tool.effect === 'write') {
      const toolCallId = await this.#toolCallOf(run, name, input, options.toolCallId);
      const decision = await run.host.requestPermission({
        toolName: name,
        kind: 'other',
        title: `Use ${name}`,
        input,
        ...(toolCallId === null ? {} : { toolCallId }),
      });
      if (decision.behavior === 'deny') {
        if (toolCallId !== null && run.openTools.has(toolCallId))
          run.refusedTools.set(toolCallId, decision.message);
        else run.pendingRefusals.push({ name, input, message: decision.message });
        return { text: `Not allowed: ${decision.message}`, isError: true, denied: true };
      }
      effective = decision.updatedInput;
    }
    return this.#context.agentTools.call(
      name,
      {
        runId: run.id,
        sessionId: run.sessionId,
        projectId: run.projectId,
        userId: run.userId,
        agentId: run.agentId,
        signal: options.signal
          ? AbortSignal.any([run.abort.signal, options.signal])
          : run.abort.signal,
      },
      effective,
    );
  }

  /**
   * The tool call, as the run's adapter announced it, that a call of a Studio tool belongs to; null when it
   * cannot be told. An adapter announces a call (`tool.started`) on one channel and the call itself arrives on
   * another — the bridge — so the announcement may be a moment behind: it is waited for briefly.
   */
  async #toolCallOf(
    run: ActiveRun,
    name: string,
    input: unknown,
    hint: string | undefined,
  ): Promise<string | null> {
    const find = (): string | null => {
      if (hint !== undefined) {
        const named = run.openTools.get(hint);
        // A hint is the agent program's word: it counts only for a call that is open and is a call of this tool.
        if (named && isStudioToolCall(named.name, name)) return hint;
      }
      const candidates = [...run.openTools].filter(
        ([, call]) => !call.claimed && isStudioToolCall(call.name, name),
      );
      const sameInput = candidates.filter(([, call]) => sameJson(call.input, input));
      const found = sameInput[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
      return found ? found[0] : null;
    };
    const deadline = Date.now() + TOOL_CALL_WAIT_MS;
    let toolCallId = find();
    while (
      toolCallId === null &&
      Date.now() < deadline &&
      run.phase !== 'finished' &&
      !run.abort.signal.aborted
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      toolCallId = find();
    }
    if (toolCallId !== null) run.openTools.get(toolCallId)!.claimed = true;
    return toolCallId;
  }

  /** The reason this tool call was refused by the Studio, if it was; the record is used up. */
  #takeRefusal(run: ActiveRun, toolCallId: string): string | null {
    const known = run.refusedTools.get(toolCallId);
    if (known !== undefined) return known;
    const call = run.openTools.get(toolCallId);
    if (!call || run.pendingRefusals.length === 0) return null;
    // Only the very call that was refused: the same tool with the same input. A later, different call of that
    // tool that fails by itself is a failure.
    const index = run.pendingRefusals.findIndex(
      (refusal) => isStudioToolCall(call.name, refusal.name) && sameJson(call.input, refusal.input),
    );
    if (index < 0) return null;
    return run.pendingRefusals.splice(index, 1)[0]!.message;
  }

  /** The bridge's `permission_prompt` tool: turns an agent's own permission request into the Studio's. */
  async permissionPrompt(runId: string, prompt: PermissionPrompt): Promise<PermissionPromptResult> {
    const run = this.#active.get(runId);
    if (!run || run.phase === 'finished')
      return { behavior: 'deny', message: 'This run has ended.' };
    const adapter = this.#adapters.get(run.agentId);
    if (adapter?.onPermissionPrompt && run.request) {
      try {
        return await adapter.onPermissionPrompt(prompt, run.host, run.request);
      } catch (error) {
        this.#log.error(
          { runId, err: redactSecrets(describeError(error)) },
          'an adapter could not handle a permission prompt',
        );
        return { behavior: 'deny', message: 'The Studio could not decide this request.' };
      }
    }
    // No adapter knowledge of the tool: an unknown kind, with the command and file taken from conventional fields.
    const fields = (
      typeof prompt.input === 'object' && prompt.input !== null ? prompt.input : {}
    ) as Record<string, unknown>;
    const command = [fields.command, fields.cmd].find(
      (value): value is string => typeof value === 'string',
    );
    const paths = [fields.file_path, fields.path, fields.notebook_path].filter(
      (value): value is string => typeof value === 'string',
    );
    const decision = await run.host.requestPermission({
      toolName: prompt.toolName,
      kind: command === undefined ? 'other' : 'execute',
      input: prompt.input,
      ...(prompt.toolCallId === null ? {} : { toolCallId: prompt.toolCallId }),
      ...(command === undefined ? {} : { command }),
      ...(paths.length === 0 ? {} : { paths }),
    });
    return decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: decision.updatedInput }
      : { behavior: 'deny', message: decision.message };
  }

  // ---- removing sessions, projects and accounts ------------------------------

  /** Stops whatever runs in a session, without writing anything: its rows are about to go. */
  abandon(sessionId: string): void {
    const run = this.#activeBySession.get(sessionId);
    if (!run) return;
    run.stopRequested = true;
    run.abort.abort();
    this.#cancelHandle(run);
    if (run.stopTimer) clearTimeout(run.stopTimer);
    this.#forget(run);
  }

  /** Stops everything a deleted account was running. */
  async abandonUser(userId: string): Promise<void> {
    const runs = [...this.#active.values()].filter((run) => run.userId === userId);
    for (const run of runs) this.abandon(run.sessionId);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(
          runs.map(async (run) => {
            await this.#launching.get(run.id);
            if (run.handle) {
              await run.handle.cancel();
              await run.handle.done.catch(() => {});
            }
          }),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Deleted account processes have not stopped.')),
            15_000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stopForRemoval(sessionId: string): Promise<void> {
    const run = this.#activeBySession.get(sessionId);
    if (run) await this.#stopRun(run);
  }

  // ---- start-up and shutdown -------------------------------------------------

  /**
   * Runs once before the server accepts connections. Whatever was in flight
   * when the previous process ended becomes "interrupted"; nothing is run
   * again by itself, and no approval survives.
   */
  recover(): void {
    // Only what a previous process left behind: a run this process is driving is not an orphan.
    const interrupted = this.#store.runsInFlight().filter((row) => !this.#active.has(row.id));
    const sessionsTouched = new Set<string>();
    for (const row of interrupted) {
      const session = this.#store.session(row.session_id);
      if (!session) continue;
      const now = Date.now();
      this.#sessions.atomic(() => {
        for (const approval of this.#store.pendingApprovalsOfRun(row.id)) {
          if (this.#store.resolveApproval(approval.id, 'cancelled', null, now, null, null)) {
            this.#sessions.append(row.session_id, row.id, SESSION_EVENT.approvalResolved, {
              runId: row.id,
              approvalId: approval.id,
              status: 'cancelled',
              decidedBy: null,
              note: null,
              answers: null,
            });
          }
        }
        const error = {
          code: 'server_restart',
          message:
            'The server restarted while this run was in progress. Part of the work may already have been done.',
        };
        if (
          this.#store.transitionRun(row.id, ['accepted', 'running'], {
            status: 'interrupted',
            finishedAt: now,
            errorCode: error.code,
            errorMessage: error.message,
            interruptedByRestart: 1,
          })
        ) {
          this.#sessions.append(row.session_id, row.id, SESSION_EVENT.runFinished, {
            runId: row.id,
            status: 'interrupted',
            error,
            interruptedByRestart: true,
            durationMs: Math.max(0, now - (row.started_at ?? row.created_at)),
          });
        }
      });
      sessionsTouched.add(row.session_id);
      this.#sessions.internal('run.interrupted', {
        runId: row.id,
        sessionId: row.session_id,
        projectId: row.project_id,
        userId: row.user_id,
        agentId: row.agent_id,
        origin: row.origin,
        title: session.title,
        reason: 'restart',
        visibleTo: [],
      });
    }
    // An approval is only ever answered by the process that asked: anything still pending is void.
    const now = Date.now();
    for (const approval of this.#store.allPendingApprovals()) {
      if (this.#waiters.has(approval.id)) continue;
      if (this.#store.resolveApproval(approval.id, 'cancelled', null, now, null, null))
        sessionsTouched.add(approval.session_id);
    }
    for (const sessionId of sessionsTouched) this.#sessions.refreshAttention(sessionId);
    this.#store.removeOrphanedIndex();
    // Messages that were queued and never taken were never run, so they still go out in order.
    for (const sessionId of this.#store.sessionsWithQueue()) this.#scheduleDrain(sessionId);
    if (interrupted.length > 0)
      this.#log.warn(
        { runs: interrupted.length },
        'runs that were in progress at the last shutdown were marked interrupted',
      );
  }

  /** Stops every agent without recording an outcome: the next start reports those runs as interrupted. */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const timer of this.#drainTimers.values()) clearImmediate(timer);
    this.#drainTimers.clear();
    const runs = [...this.#active.values()];
    for (const waiter of this.#waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ status: 'cancelled', decidedBy: null, note: null, answers: null });
    }
    this.#waiters.clear();
    const settling: Promise<unknown>[] = [];
    for (const run of runs) {
      run.stopRequested = true;
      run.abort.abort();
      if (run.stopTimer) clearTimeout(run.stopTimer);
      const handle = run.handle;
      if (handle) {
        settling.push(
          Promise.resolve()
            .then(() => handle.cancel())
            .then(() => handle.done)
            .catch(() => {}),
        );
      }
    }
    await Promise.race([
      Promise.all(settling),
      new Promise((resolve) => setTimeout(resolve, 1500).unref()),
    ]);
    for (const run of runs) {
      run.phase = 'finished';
      this.#tokens.revokeRun(run.id);
      run.settle();
    }
    this.#active.clear();
    this.#activeBySession.clear();
  }
}

function defaultTitle(request: PermissionRequest): string {
  const target = request.paths?.[0];
  switch (request.kind) {
    case 'execute':
      return 'Run a command';
    case 'edit':
      return target ? `Change ${path.basename(target)}` : 'Change a file';
    case 'read':
      return target ? `Read ${path.basename(target)}` : 'Read a file';
    case 'search':
      return 'Search';
    case 'fetch':
      return 'Access the network';
    case 'agent':
      return 'Start a sub-task';
    default:
      return `Use ${request.toolName}`;
  }
}

/**
 * Follows symbolic links for the permission engine. A path that does not
 * exist yet is resolved through its deepest existing ancestor, so a link in
 * the middle of a new file's path is still followed.
 */
export function resolveExisting(absolute: string): string {
  let current = absolute;
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}
