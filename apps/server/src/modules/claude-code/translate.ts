import type { TodoItem } from '@agent-studio/protocol';
import type { AgentEvent } from '../agents/adapter.js';
import { SUB_AGENT_TOOLS, describeTool, diffsFromResult, isRecord, toolResultText } from './tools.js';

/**
 * Turns the JSON lines Claude Code prints in `--output-format stream-json`
 * into the runtime's normalised events. It holds the state that needs
 * (which block of which message is being streamed, which tool calls are
 * open, the to-do list, running token totals) and nothing else: it starts no
 * process and decides no permission, so it can be tested with plain objects.
 *
 * ## What the CLI prints (Claude Code 2.1, with `--include-partial-messages`)
 *
 * - `system` / `init`: the conversation's id, the model, the tools. Printed
 *   once the first message has been read, and again before a turn the CLI
 *   starts by itself (after a background sub-agent finishes).
 * - `stream_event`: the model API's streaming events for the main thread
 *   (`message_start`, `content_block_start|delta|stop`, `message_delta`,
 *   `message_stop`).
 * - `assistant`: one line per completed content block, carrying the id of
 *   the API message it belongs to. It arrives *before* that block's
 *   `content_block_stop`. A sub-agent's blocks arrive only this way, with
 *   `parent_tool_use_id` naming the call that started the sub-agent.
 * - `user`: tool results (`tool_result` blocks, plus a structured
 *   `tool_use_result` on the main thread), and echoes of what was written to
 *   the CLI's input (`isReplay`).
 * - `rate_limit_event`, further `system` subtypes (`status`, `compact_boundary`,
 *   `api_retry`, `task_started`, `task_progress`, `task_notification`, …) and
 *   one `result` per turn.
 *
 * ## No duplicated text
 *
 * A streamed block is named `<message id>:<block index>`. Its deltas and the
 * completed block from the `assistant` line carry the same name, so the
 * runtime replaces the one with the other. `assistant` lines of one message
 * arrive in block order, which is how a line is matched to its index. A block
 * the CLI marks `aborted` (cut short by an interrupt) is not completed here:
 * its deltas stay what they are, and the runtime stores them as partial.
 *
 * ## Usage
 *
 * A `result` carries two different things. Its `usage` is that turn's, main
 * thread only. Its `modelUsage` and `total_cost_usd` are **totals of the whole
 * conversation**, per model, sub-agents included — and they keep growing
 * across `--resume`. A run must report only what it used itself, so the totals
 * are compared with what the conversation stood at before this process: zero
 * for a new conversation, the last report kept in the {@link UsageLedger} for
 * a resumed one. Where that is not known (the first turn after the server
 * restarted) the run reports the tokens it saw streamed and no cost, rather
 * than a cost that would count earlier turns again.
 */

/** What a line meant for the process that drives the CLI. */
export type LineSignal =
  | { readonly kind: 'init' }
  | { readonly kind: 'result'; readonly result: CliResult }
  /** The CLI took a message from its input (the first prompt or a steered one). */
  | { readonly kind: 'replay' }
  | { readonly kind: 'control_response'; readonly requestId: string | null }
  /** The CLI asks its host something; it waits for an answer. */
  | { readonly kind: 'control_request'; readonly requestId: string | null; readonly subtype: string | null }
  | { readonly kind: 'other' };

export interface CliResult {
  readonly subtype: string;
  readonly isError: boolean;
  /** The final text, or the CLI's own sentence about what went wrong. */
  readonly text: string;
  readonly errors: readonly string[];
  readonly apiErrorStatus: number | null;
  readonly terminalReason: string | null;
}

/** A failure the CLI reports as a made-up assistant message ("Not logged in · Please run /login"). */
export interface ApiErrorMessage {
  /** The CLI's own label: `authentication_failed`, `model_not_found`, `rate_limit`, `billing_error`, … */
  readonly kind: string | null;
  readonly text: string;
}

/** What a conversation has used so far, as the CLI totals it for one model. */
export interface ModelTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number | null;
}

/** Remembers, per conversation of the CLI, the totals of its last result. */
export interface UsageLedger {
  get(conversationId: string): ReadonlyMap<string, ModelTotals> | undefined;
  set(conversationId: string, totals: ReadonlyMap<string, ModelTotals>): void;
}

export interface TranslatorLog {
  debug(fields: Record<string, unknown>, message: string): void;
}

export interface TranslatorOptions {
  readonly cwd: string | null;
  readonly emit: (event: AgentEvent) => void;
  readonly log: TranslatorLog;
  /** Called with the content of every `rate_limit_event`. */
  readonly onRateLimit?: (info: Record<string, unknown>) => void;
  /** This process continues an existing conversation, whose totals include earlier turns. */
  readonly resumed?: boolean;
  readonly ledger?: UsageLedger;
}

interface MessageState {
  readonly model: string | null;
  /** Block types by index, as the stream announced them. */
  readonly types: Map<number, string>;
  /** How many blocks of this message `assistant` lines have delivered. */
  delivered: number;
}

interface ToolState {
  readonly name: string;
  readonly input: unknown;
  readonly kind: ReturnType<typeof describeTool>['kind'];
  finished: boolean;
  /** A sub-agent that runs in the background: its result comes with a later notification. */
  background: boolean;
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const OUTPUT_CHARS = 400_000;
const MAX_MESSAGES = 16;
const MAX_RETRY_NOTICES = 5;
const MAIN = '';

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
const string = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function boundOutput(value: string): string {
  if (value.length <= OUTPUT_CHARS) return value;
  const half = Math.floor(OUTPUT_CHARS / 2);
  return `${value.slice(0, half)}\n… ${value.length - 2 * half} characters left out …\n${value.slice(-half)}`;
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  overage: 'extra-usage',
};

/** "2026-10-13 23:00 UTC" from seconds since the epoch. */
function utcTime(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed']);
const todoStatus = (value: unknown): TodoItem['status'] | null => (TODO_STATUSES.has(value as TodoItem['status']) ? (value as TodoItem['status']) : null);

export class StreamTranslator {
  /** The CLI's id for the conversation, once it has said it. */
  sessionId: string | null = null;
  /** The model the CLI resolved the session's choice to. */
  model: string | null = null;
  lastResult: CliResult | null = null;
  /** Set when the CLI reported an API failure as an assistant message. */
  apiError: ApiErrorMessage | null = null;
  /** True once the model produced anything in this process. */
  producedOutput = false;

  readonly #options: TranslatorOptions;
  readonly #messages = new Map<string, MessageState>();
  /** The message being streamed, per thread (the main thread is `''`). */
  readonly #current = new Map<string, string>();
  readonly #tools = new Map<string, ToolState>();
  readonly #toolWaiters = new Map<string, Array<() => void>>();
  readonly #denied = new Set<string>();
  readonly #todos = new Map<string, TodoItem>();
  readonly #totals = new Map<string, Totals>();
  readonly #costs = new Map<string, number>();
  readonly #windows = new Map<string, number>();
  /** How full the context is after the newest request of the main thread. */
  #context: { model: string; tokens: number } | null = null;
  /** What the conversation had used before this process. Undefined: not looked up yet. Null: not known. */
  #baseline: ReadonlyMap<string, ModelTotals> | null | undefined;
  /** Blocks for which deltas were emitted and no completed block yet. */
  readonly #streamed = new Set<string>();
  #rateNotice: string | null = null;
  #retryNotices = 0;
  #compacting = false;

  constructor(options: TranslatorOptions) {
    this.#options = options;
  }

  // ---- what the adapter tells the translator ---------------------------------

  /** A tool call the Studio refused: its result is then reported as `denied`, whatever the CLI calls it. */
  markDenied(toolCallId: string): void {
    this.#denied.add(toolCallId);
  }

  hasTool(toolCallId: string): boolean {
    return this.#tools.has(toolCallId);
  }

  /** Resolves when the call has been announced, or after `timeoutMs` — whichever comes first. */
  waitForTool(toolCallId: string, timeoutMs: number): Promise<void> {
    if (this.#tools.has(toolCallId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#toolWaiters.get(toolCallId) ?? [];
      this.#toolWaiters.set(toolCallId, waiters);
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      waiters.push(done);
    });
  }

  /**
   * Announces a tool call unless it already was. The permission prompt for a
   * call can reach the Studio before the line that announces it has been read.
   */
  startTool(toolCallId: string, name: string, input: unknown, parent: string | null = null): void {
    if (this.#tools.has(toolCallId)) return;
    const description = describeTool(name, input, this.#options.cwd);
    this.#tools.set(toolCallId, { name, input, kind: description.kind, finished: false, background: false });
    this.#options.emit({
      type: 'tool.started',
      toolCallId,
      name,
      kind: description.kind,
      title: description.title,
      input: input ?? {},
      ...(parent === null ? {} : { parentToolCallId: parent }),
    });
    // The older to-do tool sends the whole list with every call.
    if (name === 'TodoWrite' && isRecord(input) && Array.isArray(input.todos)) {
      this.#todos.clear();
      input.todos.forEach((entry, index) => {
        if (!isRecord(entry)) return;
        const label = string(entry.content) ?? string(entry.subject);
        const status = todoStatus(entry.status);
        if (label && status) this.#todos.set(String(index), { text: label, status });
      });
      this.#emitTodos();
    }
    for (const resume of this.#toolWaiters.get(toolCallId) ?? []) resume();
    this.#toolWaiters.delete(toolCallId);
  }

  // ---- the lines ---------------------------------------------------------------

  handle(line: unknown): LineSignal {
    if (!isRecord(line) || typeof line.type !== 'string') {
      this.#options.log.debug({}, 'ignored a line from Claude Code that is not an event');
      return { kind: 'other' };
    }
    switch (line.type) {
      case 'system':
        return this.#system(line);
      case 'stream_event':
        this.#streamEvent(line);
        return { kind: 'other' };
      case 'assistant':
        this.#assistant(line);
        return { kind: 'other' };
      case 'user':
        return this.#user(line);
      case 'rate_limit_event':
        this.#rateLimit(line);
        return { kind: 'other' };
      case 'result':
        return { kind: 'result', result: this.#result(line) };
      case 'control_response': {
        const response = isRecord(line.response) ? line.response : {};
        return { kind: 'control_response', requestId: string(response.request_id) };
      }
      case 'control_request': {
        const request = isRecord(line.request) ? line.request : {};
        return { kind: 'control_request', requestId: string(line.request_id), subtype: string(request.subtype) };
      }
      default:
        this.#options.log.debug({ type: line.type }, 'ignored an event type from Claude Code that the Studio does not know');
        return { kind: 'other' };
    }
  }

  #thread(line: Record<string, unknown>): string {
    return string(line.parent_tool_use_id) ?? MAIN;
  }

  #message(id: string, model: string | null): MessageState {
    let state = this.#messages.get(id);
    if (!state) {
      state = { model, types: new Map(), delivered: 0 };
      this.#messages.set(id, state);
      // Only the newest few messages can still receive lines.
      if (this.#messages.size > MAX_MESSAGES) {
        const oldest = this.#messages.keys().next().value;
        if (oldest !== undefined) this.#messages.delete(oldest);
      }
    }
    return state;
  }

  #system(line: Record<string, unknown>): LineSignal {
    const { emit } = this.#options;
    switch (line.subtype) {
      case 'init': {
        const sessionId = string(line.session_id);
        this.model = string(line.model) ?? this.model;
        if (sessionId && sessionId !== this.sessionId) {
          this.sessionId = sessionId;
          emit({ type: 'session', nativeSessionId: sessionId });
        }
        return { kind: 'init' };
      }
      case 'status':
        if (line.status === 'compacting') this.#compaction(null);
        return { kind: 'other' };
      case 'compact_boundary': {
        const metadata = isRecord(line.compact_metadata) ? line.compact_metadata : {};
        this.#compaction(count(metadata.pre_tokens) || null);
        this.#compacting = false;
        return { kind: 'other' };
      }
      case 'api_retry': {
        if (this.#retryNotices >= MAX_RETRY_NOTICES) return { kind: 'other' };
        this.#retryNotices += 1;
        const status = count(line.error_status);
        const attempt = count(line.attempt);
        const max = count(line.max_retries);
        const progress = attempt > 0 ? ` (attempt ${attempt}${max > 0 ? ` of ${max}` : ''})` : '';
        emit({
          type: 'notice',
          level: 'warning',
          code: 'api_retry',
          text: `The model service did not answer${status > 0 ? ` (HTTP ${status})` : ''}; Claude Code is trying again${progress}.`,
        });
        return { kind: 'other' };
      }
      case 'task_started':
      case 'task_progress': {
        // A background sub-agent says what it is doing: shown live under the call that started it.
        const toolCallId = string(line.tool_use_id);
        const description = string(line.description);
        const tool = toolCallId ? this.#tools.get(toolCallId) : undefined;
        if (toolCallId && description && tool && !tool.finished && line.subtype === 'task_progress') {
          emit({ type: 'tool.output', toolCallId, text: `${description}\n` });
        }
        return { kind: 'other' };
      }
      case 'task_notification': {
        const toolCallId = string(line.tool_use_id);
        const tool = toolCallId ? this.#tools.get(toolCallId) : undefined;
        if (toolCallId && tool && tool.background && !tool.finished) {
          tool.finished = true;
          emit({
            type: 'tool.finished',
            toolCallId,
            status: line.status === 'completed' ? 'ok' : 'error',
            output: boundOutput(string(line.summary) ?? (line.status === 'completed' ? '' : `The sub-agent ended as "${String(line.status)}".`)),
          });
        }
        return { kind: 'other' };
      }
      case 'thinking_tokens':
      case 'background_tasks_changed':
      case 'task_updated':
        return { kind: 'other' };
      default:
        this.#options.log.debug({ type: 'system', subtype: string(line.subtype) }, 'ignored a system event from Claude Code that the Studio does not know');
        return { kind: 'other' };
    }
  }

  #compaction(tokensBefore: number | null): void {
    if (this.#compacting) return;
    this.#compacting = true;
    this.#options.emit({
      type: 'notice',
      level: 'info',
      code: 'compaction',
      text:
        tokensBefore === null
          ? 'Claude Code is summarising the earlier conversation to make room in its context.'
          : `Claude Code summarised the earlier conversation to make room in its context (it had grown to about ${tokensBefore.toLocaleString('en-US')} tokens).`,
    });
  }

  #streamEvent(line: Record<string, unknown>): void {
    const event = isRecord(line.event) ? line.event : null;
    if (!event) return;
    const thread = this.#thread(line);
    const parent = thread === MAIN ? {} : { parentToolCallId: thread };

    if (event.type === 'message_start') {
      const message = isRecord(event.message) ? event.message : {};
      const id = string(message.id);
      if (!id) return;
      this.#message(id, string(message.model));
      this.#current.set(thread, id);
      this.#compacting = false;
      return;
    }
    const messageId = this.#current.get(thread);
    if (!messageId) return;
    const message = this.#message(messageId, null);
    const index = typeof event.index === 'number' ? event.index : 0;

    switch (event.type) {
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : {};
        if (typeof block.type === 'string') message.types.set(index, block.type);
        this.producedOutput = true;
        return;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
          this.#streamed.add(`${messageId}:${index}`);
          this.#options.emit({ type: 'text.delta', messageId: `${messageId}:${index}`, text: delta.text, ...parent });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
          this.#streamed.add(`${messageId}:${index}`);
          this.#options.emit({ type: 'thinking.delta', messageId: `${messageId}:${index}`, text: delta.thinking, ...parent });
        }
        return;
      }
      case 'message_delta': {
        if (isRecord(event.usage)) this.#requestUsage(message.model, event.usage, thread === MAIN);
        return;
      }
      default:
        return;
    }
  }

  /** The usage of one finished model request: added to the running totals of its model. */
  #requestUsage(model: string | null, usage: Record<string, unknown>, mainThread: boolean): void {
    const name = model ?? this.model;
    if (!name) return;
    const totals = this.#totals.get(name) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.#totals.set(name, totals);
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    // What the conversation occupies after this request: everything sent plus what came back.
    if (mainThread) this.#context = { model: name, tokens: input + cacheRead + cacheWrite + output };
    this.#emitUsage(name, totals);
  }

  #emitUsage(model: string, totals: Totals): void {
    const cost = this.#costs.get(model);
    const window = this.#windows.get(model);
    this.#options.emit({
      type: 'usage',
      model,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(this.#context?.model === model ? { contextTokens: this.#context.tokens } : {}),
      ...(window === undefined ? {} : { contextWindow: window }),
      // The translator keeps the totals itself, so every report replaces the one before.
      cumulative: true,
    });
  }

  #assistant(line: Record<string, unknown>): void {
    const message = isRecord(line.message) ? line.message : null;
    if (!message) return;
    const content = Array.isArray(message.content) ? message.content : [];
    const model = string(message.model);

    // The CLI reports an API failure as an assistant message it wrote itself. That is the
    // reason the turn failed, not something the model said: it goes into the error.
    if (line.is_api_error_message === true || string(line.error) !== null) {
      const sentence = content.map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : '')).join('').trim();
      this.apiError = { kind: string(line.error), text: sentence };
      return;
    }

    const thread = this.#thread(line);
    const parent = thread === MAIN ? {} : { parentToolCallId: thread };
    const id = string(message.id) ?? `message-${this.#messages.size + 1}`;
    const state = this.#message(id, model);
    this.producedOutput = true;

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== 'string') continue;
      // Lines of one message arrive in block order. Where the stream announced the blocks,
      // skip over any the CLI left out so that the completed block replaces its own deltas.
      let index = state.delivered;
      while (state.types.has(index) && state.types.get(index) !== block.type && state.types.has(index + 1)) index += 1;
      state.delivered = index + 1;
      const messageId = `${id}:${index}`;
      // Cut short by an interrupt: what was streamed stays as it is, to be stored as a partial block.
      const cutShort = line.aborted === true && this.#streamed.has(messageId);
      if (cutShort) continue;
      this.#streamed.delete(messageId);

      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text !== '') {
          this.#options.emit({ type: 'text', messageId, text: block.text, ...(model && model !== '<synthetic>' ? { model } : {}), ...parent });
        }
      } else if (block.type === 'thinking') {
        // Models that keep their reasoning to themselves send an empty block; nothing to show then.
        if (typeof block.thinking === 'string' && block.thinking.trim() !== '') {
          this.#options.emit({ type: 'thinking', messageId, text: block.thinking, ...parent });
        }
      } else if (block.type === 'tool_use') {
        const toolCallId = string(block.id);
        if (toolCallId) this.startTool(toolCallId, string(block.name) ?? 'tool', block.input, thread === MAIN ? null : thread);
      }
    }
  }

  #user(line: Record<string, unknown>): LineSignal {
    if (line.isReplay === true) return { kind: 'replay' };
    const message = isRecord(line.message) ? line.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const meta = Array.isArray(line.tool_result_meta) ? line.tool_result_meta : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const toolCallId = string(block.tool_use_id);
      if (!toolCallId) continue;
      const refusedByPermission = meta.some(
        (entry) => isRecord(entry) && entry.id === toolCallId && typeof entry.non_execution_kind === 'string' && entry.non_execution_kind.startsWith('permission'),
      );
      this.#finishTool(toolCallId, block, line.tool_use_result, refusedByPermission);
    }
    return { kind: 'other' };
  }

  #finishTool(toolCallId: string, block: Record<string, unknown>, structured: unknown, refusedByPermission: boolean): void {
    const tool = this.#tools.get(toolCallId);
    if (!tool) {
      this.#options.log.debug({}, 'ignored the result of a tool call that was never announced');
      return;
    }
    if (tool.finished) return;
    const failed = block.is_error === true;
    const status = this.#denied.has(toolCallId) || (failed && refusedByPermission) ? 'denied' : failed ? 'error' : 'ok';
    const output = toolResultText(block.content);

    // A sub-agent started in the background answers at once with "launched"; its real result
    // comes later as a notification, and until then the call is still running.
    if (status === 'ok' && SUB_AGENT_TOOLS.has(tool.name) && isRecord(structured) && structured.isAsync === true) {
      tool.background = true;
      return;
    }

    tool.finished = true;
    if (status === 'ok') this.#trackTodo(tool, output, structured);
    const diffs = status === 'ok' && tool.kind === 'edit' ? diffsFromResult(structured, this.#options.cwd) : [];
    this.#options.emit({
      type: 'tool.finished',
      toolCallId,
      status,
      output: boundOutput(output),
      ...(diffs.length > 0 ? { diffs } : {}),
    });
  }

  /** The newer to-do tools change one item per call; the list is kept here and reported whole. */
  #trackTodo(tool: ToolState, output: string, structured: unknown): void {
    const input = isRecord(tool.input) ? tool.input : {};
    const result = isRecord(structured) ? structured : {};
    if (tool.name === 'TaskCreate') {
      const created = isRecord(result.task) ? result.task : {};
      const id = string(created.id) ?? /Task #(\S+) created/.exec(output)?.[1] ?? null;
      const label = string(input.subject) ?? string(created.subject);
      if (!id || !label) return;
      this.#todos.set(id, { text: label, status: 'pending' });
      this.#emitTodos();
    } else if (tool.name === 'TaskUpdate') {
      const id = string(input.taskId) ?? string(result.taskId);
      if (!id) return;
      if (input.status === 'deleted') {
        if (this.#todos.delete(id)) this.#emitTodos();
        return;
      }
      const known = this.#todos.get(id);
      const next: TodoItem = {
        text: string(input.subject) ?? known?.text ?? `To-do #${id}`,
        status: todoStatus(input.status) ?? known?.status ?? 'pending',
      };
      if (known && known.text === next.text && known.status === next.status) return;
      this.#todos.set(id, next);
      this.#emitTodos();
    } else if (tool.name === 'TaskList' && Array.isArray(result.tasks)) {
      const listed = new Map<string, TodoItem>();
      for (const entry of result.tasks) {
        if (!isRecord(entry)) continue;
        const id = string(entry.id);
        const label = string(entry.subject);
        const status = todoStatus(entry.status);
        if (id && label && status) listed.set(id, { text: label, status });
      }
      if (listed.size === 0) return;
      this.#todos.clear();
      for (const [id, item] of listed) this.#todos.set(id, item);
      this.#emitTodos();
    }
  }

  #emitTodos(): void {
    this.#options.emit({ type: 'todos', items: [...this.#todos.values()] });
  }

  #rateLimit(line: Record<string, unknown>): void {
    const info = isRecord(line.rate_limit_info) ? line.rate_limit_info : null;
    if (!info) return;
    this.#options.onRateLimit?.(info);
    const status = string(info.status);
    if (!status || status === 'allowed') {
      this.#rateNotice = null;
      return;
    }
    const type = string(info.rateLimitType) ?? 'usage';
    const key = `${status}:${type}`;
    if (this.#rateNotice === key) return;
    this.#rateNotice = key;
    const window = WINDOW_NAMES[type] ?? type.replace(/_/g, ' ');
    const resets = utcTime(info.resetsAt);
    const when = resets ? `; it resets at ${resets}` : '';
    const rejected = status === 'rejected';
    this.#options.emit({
      type: 'notice',
      level: rejected ? 'error' : 'warning',
      code: rejected ? 'rate_limit' : 'rate_limit_warning',
      text: rejected ? `Claude's ${window} usage limit has been reached${when}.` : `Claude's ${window} usage limit is close${when}.`,
    });
  }

  #result(line: Record<string, unknown>): CliResult {
    const result: CliResult = {
      subtype: string(line.subtype) ?? 'unknown',
      isError: line.is_error === true,
      text: typeof line.result === 'string' ? line.result : '',
      errors: Array.isArray(line.errors) ? line.errors.filter((entry): entry is string => typeof entry === 'string') : [],
      apiErrorStatus: typeof line.api_error_status === 'number' ? line.api_error_status : null,
      terminalReason: string(line.terminal_reason),
    };
    this.lastResult = result;
    const sessionId = string(line.session_id);
    if (sessionId && this.sessionId === null && !result.isError) {
      this.sessionId = sessionId;
      this.#options.emit({ type: 'session', nativeSessionId: sessionId });
    }

    this.#conversationUsage(sessionId, isRecord(line.modelUsage) ? line.modelUsage : {});
    return result;
  }

  /** The conversation's totals from a result: what this run added to them replaces the running figures. */
  #conversationUsage(conversationId: string | null, reported: Record<string, unknown>): void {
    const names = Object.keys(reported).filter((name) => isRecord(reported[name]));
    if (names.length === 0) return;
    const totals = new Map<string, ModelTotals>();
    for (const name of names) {
      const usage = reported[name] as Record<string, unknown>;
      totals.set(name, {
        input: count(usage.inputTokens),
        output: count(usage.outputTokens),
        cacheRead: count(usage.cacheReadInputTokens),
        cacheWrite: count(usage.cacheCreationInputTokens),
        cost: typeof usage.costUSD === 'number' && Number.isFinite(usage.costUSD) && usage.costUSD >= 0 ? usage.costUSD : null,
      });
      if (count(usage.contextWindow) > 0) this.#windows.set(name, count(usage.contextWindow));
    }
    if (this.#baseline === undefined) {
      this.#baseline = this.#options.resumed ? ((conversationId ? this.#options.ledger?.get(conversationId) : undefined) ?? null) : new Map();
    }
    if (conversationId) this.#options.ledger?.set(conversationId, totals);

    const baseline = this.#baseline;
    if (baseline === null) {
      // Where the conversation stood before is not known: keep what was seen streamed, add the window just learnt.
      for (const [name, running] of this.#totals) {
        if (this.#windows.has(name)) this.#emitUsage(name, running);
      }
      return;
    }

    // A model counted under another name while streaming would otherwise be counted twice.
    for (const [name, running] of this.#totals) {
      if (names.includes(name)) continue;
      running.input = running.output = running.cacheRead = running.cacheWrite = 0;
      this.#emitUsage(name, running);
      this.#totals.delete(name);
    }
    const context = this.#context;
    if (context && !names.includes(context.model)) {
      const fallback = names.length === 1 ? names[0]! : this.model && names.includes(this.model) ? this.model : null;
      this.#context = fallback ? { model: fallback, tokens: context.tokens } : null;
    }
    // The model whose context is reported goes last, so that it is the newest figure.
    names.sort((a, b) => Number(a === this.#context?.model) - Number(b === this.#context?.model));
    for (const name of names) {
      const now = totals.get(name)!;
      const before = baseline.get(name);
      const added: Totals = {
        input: now.input - (before?.input ?? 0),
        output: now.output - (before?.output ?? 0),
        cacheRead: now.cacheRead - (before?.cacheRead ?? 0),
        cacheWrite: now.cacheWrite - (before?.cacheWrite ?? 0),
      };
      if (added.input < 0 || added.output < 0 || added.cacheRead < 0 || added.cacheWrite < 0) {
        this.#options.log.debug({}, "a conversation's usage totals went down; keeping the figures seen while streaming");
        continue;
      }
      const used = added.input + added.output + added.cacheRead + added.cacheWrite > 0;
      // A model the conversation used earlier and this run did not.
      if (!used && !this.#totals.has(name) && this.#context?.model !== name) continue;
      this.#totals.set(name, added);
      if (now.cost !== null && (before === undefined || before.cost !== null)) {
        this.#costs.set(name, Math.max(0, Number((now.cost - (before?.cost ?? 0)).toFixed(8))));
      }
      this.#emitUsage(name, added);
    }
  }
}
