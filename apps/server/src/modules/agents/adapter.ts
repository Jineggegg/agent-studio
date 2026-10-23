import type {
  AgentCapabilities,
  AgentStatus,
  FileDiff,
  PermissionMode,
  Question,
  QuestionAnswer,
  RunOrigin,
  TodoItem,
  ToolKind,
} from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentToolResult } from '../../kernel/agent-tools.js';

/**
 * The contract between the agent runtime and whatever actually produces
 * answers: a coding-agent CLI (Claude Code, Codex) or a chat model called
 * over HTTPS. One adapter per agent, registered during a module's `setup`:
 *
 *   context.services.agents.registerAdapter(myAdapter);
 *
 * `src/testing/scripted-adapter.ts` is a complete, small implementation to
 * read alongside this file.
 *
 * ## Who does what
 *
 * The adapter translates. It starts the agent, turns what the agent says into
 * {@link AgentEvent}s, and routes the agent's own permission mechanism into
 * `host.requestPermission`. It never decides a permission itself, never
 * writes to the database, and never talks to browsers.
 *
 * The runtime owns everything else: it stores events and numbers them, keeps
 * the partial text for late joiners, bounds oversized tool input and output,
 * guarantees exactly one terminal event per run, runs the permission engine,
 * holds approvals, records usage, and survives restarts.
 *
 * ## Rules an adapter must keep
 *
 * 1. `run` returns (or resolves) quickly with a handle; the work happens
 *    behind `handle.done`.
 * 2. `handle.done` settles exactly once: resolve `{ status: 'completed' }`
 *    when the agent finished its turn, resolve `{ status: 'failed', error }`
 *    or reject with an {@link AgentRunError} when it could not. Only the text
 *    of an `AgentRunError` (or of a resolved `error`) is shown to the user;
 *    anything else that is thrown is logged and shown as a generic failure —
 *    so never put credentials, raw upstream bodies or stack traces in it.
 * 3. When `request.signal` aborts or `handle.cancel()` is called, stop the
 *    agent and settle `done` promptly. Whatever `done` says afterwards, the
 *    run is recorded as stopped. Events emitted after the run has ended are
 *    ignored.
 * 4. Emit text either as deltas followed by the completed block with the same
 *    `messageId`, or as completed blocks alone. Deltas are shown live and not
 *    stored; the completed block is what the transcript keeps. If the run
 *    ends with deltas and no completed block, the runtime stores the partial
 *    text itself.
 * 5. Every `tool.started` needs a `toolCallId` that is unique within the run
 *    and a truthful `kind`; finish it with `tool.finished` and the same id.
 *    Report a tool the permission engine or the user refused as `denied`.
 * 6. Before the agent does anything with a side effect, ask
 *    `host.requestPermission` and obey the answer — unless the agent asks by
 *    itself through the bridge's `permission_prompt` tool, which does exactly
 *    that for you.
 * 7. Never emit the agent's own session id, a credential, or an environment
 *    value in an event meant for the transcript. The native session id goes
 *    in a `session` event, which is kept on the server.
 * 8. CLI agents are spawned through `context.processes` wrapped by
 *    `context.sandbox.wrap(...)`. The sandbox hides the Studio's data
 *    directory, and attachments live there: pass every
 *    `request.prompt.attachments[].path` through `SandboxProfile.expose` so
 *    the agent can read them.
 */
export interface AgentAdapter {
  /** Stable, lowercase, URL-safe: "claude-code", "codex", "deepseek". */
  readonly id: string;
  readonly displayName: string;
  /** `cli`: a coding agent that runs tools on the host. `api`: a chat model called over HTTPS. */
  readonly kind: 'cli' | 'api';
  capabilities(): AgentCapabilities | Promise<AgentCapabilities>;
  /** Installed? signed in? Never returns a credential. Called often: cache what is slow. */
  status(): AgentStatus | Promise<AgentStatus>;
  run(request: AgentRunRequest, host: AgentRunHost): AgentRunHandle | Promise<AgentRunHandle>;
  /**
   * Called when the agent asks for permission through the bridge's
   * `permission_prompt` tool. Implement it to describe the agent's own tools
   * (which are reads, which run commands, which is "ask the user a question",
   * which is "approve my plan") and call `host.requestPermission` or
   * `host.askUser` accordingly. Without it the runtime treats the request as a
   * tool of unknown kind, taking `command` and file paths from conventional
   * input fields.
   */
  onPermissionPrompt?(
    prompt: PermissionPrompt,
    host: AgentRunHost,
    request: AgentRunRequest,
  ): Promise<PermissionPromptResult>;
  /** Removes the agent's own copy of a conversation when its session is deleted. */
  deleteNativeSession?(input: {
    nativeSessionId: string;
    cwd: string | null;
    accountEnvironment?: Readonly<Record<string, string>>;
    accountDirectory?: string;
  }): Promise<void>;
}

/** A failure whose message is fit to show to the user. */
export class AgentRunError extends Error {
  readonly code: string;

  /** `code` is stable and machine-readable: "not_installed", "not_signed_in", "rate_limited", "agent_error", … */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentRunError';
    this.code = code;
  }
}

export interface PromptAttachment {
  readonly id: string;
  /** The name the user uploaded it with. */
  readonly name: string;
  /** Absolute path of the stored file (inside the Studio's data directory — see rule 8). */
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
  /** A raster image (PNG, JPEG, GIF, WebP) that may be given to the model as an image. */
  readonly isImage: boolean;
}

export interface HistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** What an adapter needs to launch the Studio's MCP bridge as a child of the agent CLI. */
export interface BridgeConnection {
  /** The program to run (the Node.js binary the server itself runs on). */
  readonly command: string;
  readonly args: readonly string[];
  /** Variables the bridge needs. They hold a token for this one run only. */
  readonly env: Readonly<Record<string, string>>;
  /** The name to register the server under; its tools are then `mcp__<serverName>__<tool>` to an MCP client. */
  readonly serverName: string;
  /** The bridge's tool that answers permission prompts. */
  readonly permissionPromptTool: string;
}

export interface AgentRunRequest {
  readonly fastMode?: boolean;
  readonly accountEnvironment?: Readonly<Record<string, string>>;
  readonly accountDirectory?: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly projectId: string | null;
  /** The project's working directory, taken from the server's record of the project. Null outside any project. */
  readonly cwd: string | null;
  readonly prompt: {
    readonly text: string;
    readonly attachments: readonly PromptAttachment[];
    /** Text the user quoted from an earlier message; present it above the prompt. */
    readonly quote: string | null;
  };
  readonly model: string | null;
  readonly effort: string | null;
  /** The mode in force when the run starts (`auto` already reduced to `ask` where the project does not enable it). */
  readonly permissionMode: PermissionMode;
  /** The agent's own conversation to resume, when a previous run reported one. */
  readonly nativeSessionId: string | null;
  /** Earlier user and assistant messages, oldest first, for adapters that keep no conversation of their own. */
  readonly history: readonly HistoryMessage[];
  /** Aborts when the run is stopped or the server shuts down. */
  readonly signal: AbortSignal;
  readonly bridge: BridgeConnection;
  readonly origin: RunOrigin;
  /** Nobody is assumed to be watching (a scheduled or automated run). */
  readonly unattended: boolean;
}

export type AgentEvent =
  /** The agent's own id for this conversation, to resume it later. Kept on the server; never shown. */
  | { readonly type: 'session'; readonly nativeSessionId: string }
  | {
      readonly type: 'text.delta';
      readonly messageId: string;
      readonly text: string;
      readonly parentToolCallId?: string;
    }
  /** A completed block of prose. Replaces the deltas sent under the same `messageId`. */
  | {
      readonly type: 'text';
      readonly messageId: string;
      readonly text: string;
      readonly model?: string;
      readonly parentToolCallId?: string;
    }
  | {
      readonly type: 'thinking.delta';
      readonly messageId: string;
      readonly text: string;
      readonly parentToolCallId?: string;
    }
  | {
      readonly type: 'thinking';
      readonly messageId: string;
      readonly text: string;
      readonly parentToolCallId?: string;
    }
  | {
      readonly type: 'tool.started';
      readonly toolCallId: string;
      /** The tool's name as the agent calls it. */
      readonly name: string;
      readonly kind: ToolKind;
      /** A short human description: "Run npm test", "Edit src/app.ts". */
      readonly title: string;
      readonly input: unknown;
      /** For a call made by a sub-agent: the call that spawned it. */
      readonly parentToolCallId?: string;
    }
  /** Output as it is produced (shown live, not stored). */
  | { readonly type: 'tool.output'; readonly toolCallId: string; readonly text: string }
  | {
      readonly type: 'tool.finished';
      readonly toolCallId: string;
      readonly status: 'ok' | 'error' | 'denied';
      readonly output?: string;
      readonly diffs?: readonly FileDiff[];
    }
  /** The agent's whole to-do list, every time it changes. */
  | { readonly type: 'todos'; readonly items: readonly TodoItem[] }
  | {
      readonly type: 'usage';
      readonly model: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      /** For the tokens in this event, when the agent reports cost. */
      readonly costUsd?: number;
      /** How much of the context window the conversation fills after this request. */
      readonly contextTokens?: number;
      /** The window's size; omit when unknown — never guess. */
      readonly contextWindow?: number;
      /**
       * False or absent: the figures are for one model request and are added
       * to the run's totals. True: they are the run's totals so far for this
       * model and replace what was added before.
       */
      readonly cumulative?: boolean;
    }
  /** Something the user should see that is not prose: a compaction, a rate limit, a recoverable error. */
  | {
      readonly type: 'notice';
      readonly level: 'info' | 'warning' | 'error';
      readonly code: string;
      readonly text: string;
    }
  /** A better name for the session. Never replaces a name the user typed. */
  | { readonly type: 'title'; readonly title: string };

export interface PermissionRequest {
  /**
   * `tool` (default): the agent wants to use a tool; the permission engine decides, and asks a person when it must.
   * `plan`: the agent asks the user to approve a plan; always put to a person.
   * Approving it also moves a session that was in `plan` mode on — to `ask`,
   * or to the mode the person chose with the approval — so the requests that
   * follow in the same run are decided under the new mode.
   */
  readonly approval?: 'tool' | 'plan';
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly kind: ToolKind;
  /** What is being asked, in words. A default is derived when absent. */
  readonly title?: string;
  /** The tool's full input. Returned (possibly unchanged) as `updatedInput` when allowed. */
  readonly input: unknown;
  /** The exact command line, for tools that run one. Give it whenever there is one: the risk classifier reads it. */
  readonly command?: string;
  /** Files or folders the tool reads or changes, absolute or relative to `cwd`. */
  readonly paths?: readonly string[];
  /** The address, for tools that fetch from the network. */
  readonly url?: string;
  /** A preview of the change, for edits (unified diff). */
  readonly diff?: string;
  /** The plan text, for `approval: 'plan'`. */
  readonly plan?: string;
  /**
   * Put this to a person even where the permission mode or a saved rule would
   * allow it. Deny rules, plan mode and the hard-deny list still refuse without
   * asking; an unattended run is denied; the answer cannot be remembered as a
   * rule. For the rare action the usual safeguards do not cover — a shell
   * command line on a server that has no sandbox, say.
   */
  readonly requireHuman?: boolean;
}

export type PermissionDecision =
  | {
      readonly behavior: 'allow';
      /** The input to run the tool with. */
      readonly updatedInput: unknown;
      /** `mode` and `rule`: decided without asking. `user`: a person allowed it. */
      readonly source: 'mode' | 'rule' | 'user';
    }
  | {
      readonly behavior: 'deny';
      /** Tell the agent this: the reason, or the user's note. */
      readonly message: string;
      /**
       * `policy`: the hard-deny list. `unattended`: nobody is watching this run, so it was not asked.
       * `expired`: nobody answered in time. `cancelled`: the run was stopped.
       */
      readonly source: 'mode' | 'rule' | 'policy' | 'user' | 'expired' | 'cancelled' | 'unattended';
    };

export interface UserQuestionRequest {
  readonly toolCallId?: string;
  /** One or more questions, shown one at a time. Give each a stable `id`. */
  readonly questions: readonly Question[];
}

export interface UserQuestionAnswer {
  /**
   * `answered`: see `answers`. `skipped`: the user left it to the agent.
   * `expired`: nobody answered in time; `answers` holds the options the agent
   * itself marked as recommended, if any. `cancelled`: the run was stopped.
   * `unattended`: nobody is watching this run, so it was not asked.
   */
  readonly status: 'answered' | 'skipped' | 'expired' | 'cancelled' | 'unattended';
  /** One entry per question that got an answer. */
  readonly answers: readonly QuestionAnswer[];
}

/** A tool the Studio offers to agents, as presented to a model. */
export interface StudioToolDescription {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 7) of the input. */
  readonly inputSchema: Record<string, unknown>;
  readonly effect: 'read' | 'write';
}

export interface AgentRunHost {
  /** Hands an event to the runtime. Never throws; events after the run has ended are dropped. */
  emit(event: AgentEvent): void;
  /** Runs the permission engine and, when it says so, waits for a person. Always resolves. */
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** Puts structured questions to the user and waits. Always resolves. */
  askUser(question: UserQuestionRequest): Promise<UserQuestionAnswer>;
  /**
   * The Studio's own tools (shared memory, plugin tools, …) for adapters whose
   * model calls functions directly. CLI agents reach the same tools through
   * the bridge. `call` applies the permission engine to `write` tools itself.
   */
  readonly studioTools: {
    list(): StudioToolDescription[];
    /**
     * `toolCallId` is the id the adapter gave this call in `tool.started`, when it has one: an approval the call
     * needs then names it. A refusal comes back with `denied: true` and is recorded as `denied` for that call.
     */
    call(
      name: string,
      input: unknown,
      options?: { toolCallId?: string; signal?: AbortSignal },
    ): Promise<AgentToolResult>;
  };
  /** Structured logging, already tagged with the run. Never log message text or credentials. */
  readonly log: FastifyBaseLogger;
}

export interface AgentRunResult {
  readonly status: 'completed' | 'failed';
  /** For `failed`: shown to the user as written. */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AgentRunHandle {
  /** Settles when the agent's turn is over. See rule 2. */
  readonly done: Promise<AgentRunResult>;
  /** Stops the agent. `done` must settle soon after. */
  cancel(): void | Promise<void>;
  /**
   * Injects a message into the turn in progress. Resolve `true` when the
   * agent took it, `false` when it could not (the runtime then queues the
   * message as the next turn). Must settle promptly and must not report
   * `false` for a message the agent did take. Omit when the agent cannot be
   * steered.
   */
  steer?(message: {
    text: string;
    attachments: readonly PromptAttachment[];
  }): boolean | Promise<boolean>;
}

/** What the bridge's `permission_prompt` tool was called with. */
export interface PermissionPrompt {
  readonly toolName: string;
  readonly input: unknown;
  readonly toolCallId: string | null;
}

/**
 * What the `permission_prompt` tool answers, as JSON text — the shape Claude
 * Code expects from the tool named by `--permission-prompt-tool`.
 */
export type PermissionPromptResult =
  | { readonly behavior: 'allow'; readonly updatedInput: unknown }
  | { readonly behavior: 'deny'; readonly message: string };
