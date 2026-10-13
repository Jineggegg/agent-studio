import path from 'node:path';
import type { FileDiff, TodoItem } from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentEvent } from '../agents/adapter.js';
import { tidy } from './errors.js';
import {
  type CodexItem,
  type FileUpdateChange,
  type NotificationMethod,
  type NotificationParams,
  type RateLimitSnapshot,
  type TokenBreakdown,
  type TurnError,
  isKnownNotification,
  notificationSchemas,
  readItem,
} from './protocol.js';

/**
 * From what the Codex app-server reports to the Studio's event vocabulary.
 *
 * | Codex | Studio |
 * |---|---|
 * | `agentMessage` item, `item/agentMessage/delta` | `text.delta` … `text` |
 * | `reasoning` item, `item/reasoning/summaryTextDelta` | `thinking.delta` … `thinking` |
 * | `commandExecution` item, `…/outputDelta` | tool `shell`, kind `execute`: started / output / finished |
 * | `fileChange` item | tool `apply_patch`, kind `edit`, with per-file diffs |
 * | `mcpToolCall` item | tool `mcp__<server>__<tool>` (the Studio's own tools are `mcp__studio__…`) |
 * | `webSearch` item | tool `web_search`, kind `fetch` |
 * | `collabAgentToolCall` item | tool of kind `agent`; what the sub-agent does is nested under it |
 * | `turn/plan/updated` | `todos` |
 * | `thread/tokenUsage/updated` | `usage` (the figures of the model request just finished) |
 * | `error` with `willRetry`, `warning`, `model/rerouted`, compaction | `notice` |
 * | `thread/name/updated` | `title` |
 *
 * An item type this file does not know is logged at debug level and skipped.
 */

/** The tool names Studio events and permission requests use for Codex's built-in tools. */
export const TOOL = { shell: 'shell', patch: 'apply_patch', webSearch: 'web_search', imageView: 'view_image' } as const;

const SHELL_WRAPPER = /^(?:\S*\/)?(?:bash|zsh|sh|dash|ksh)\s+-l?c\s+([\s\S]+)$/;

/**
 * Reads exactly one shell word — quoted, bare, or pieces of both — and returns
 * what the shell would make of it. Null when the text is more than one word or
 * contains anything the shell would expand: then the literal value is not
 * known, and guessing would mislabel a command.
 */
function singleShellWord(text: string): string | null {
  let out = '';
  let at = 0;
  if (text === '') return null;
  while (at < text.length) {
    const character = text[at]!;
    if (character === "'") {
      const end = text.indexOf("'", at + 1);
      if (end === -1) return null;
      out += text.slice(at + 1, end);
      at = end + 1;
    } else if (character === '"') {
      at += 1;
      for (;;) {
        if (at >= text.length) return null;
        const inner = text[at]!;
        if (inner === '"') break;
        if (inner === '$' || inner === '`') return null;
        if (inner === '\\') {
          const next = text[at + 1];
          if (next === undefined) return null;
          if (next === '\n') {
            at += 2;
            continue;
          }
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            out += next;
            at += 2;
            continue;
          }
        }
        out += inner;
        at += 1;
      }
      at += 1;
    } else if (character === '\\') {
      const next = text[at + 1];
      if (next === undefined) return null;
      if (next !== '\n') out += next;
      at += 2;
    } else if (/[\s;&|<>()$`*?[\]{}~#!]/.test(character)) {
      return null;
    } else {
      out += character;
      at += 1;
    }
  }
  return out;
}

/**
 * Codex reports a command as the shell invocation it will run
 * (`/bin/bash -lc 'npm test'`). People, and the Studio's rules, mean the
 * script inside. When the wrapper cannot be read with certainty the whole
 * line is returned unchanged.
 */
export function unwrapShellCommand(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim());
  if (!match) return command;
  const script = singleShellWord(match[1]!.trim());
  return script === null || script.trim() === '' ? command : script;
}

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** A path as a person would name it: relative to the project when inside it. */
export function displayPath(file: string, cwd: string | null): string {
  if (cwd === null || !path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
}

const contentLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const looksUnified = (diff: string): boolean => /^(@@ |--- |\+\+\+ |diff )/m.test(diff);

/** One file of a Codex patch as a unified diff with file headers. */
function filePatch(change: FileUpdateChange, cwd: string | null): { patch: string; added: number; removed: number; target: string } {
  const name = displayPath(change.path, cwd);
  const kind = change.kind.type;
  if ((kind === 'add' || kind === 'delete') && !looksUnified(change.diff)) {
    // For a new or removed file Codex gives the content itself.
    const lines = contentLines(change.diff);
    const sign = kind === 'add' ? '+' : '-';
    const range = kind === 'add' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`;
    const header = kind === 'add' ? `--- /dev/null\n+++ b/${name}` : `--- a/${name}\n+++ /dev/null`;
    return {
      patch: `${header}\n${range}\n${lines.map((line) => sign + line).join('\n')}${lines.length > 0 ? '\n' : ''}`,
      added: kind === 'add' ? lines.length : 0,
      removed: kind === 'delete' ? lines.length : 0,
      target: name,
    };
  }
  let added = 0;
  let removed = 0;
  for (const line of change.diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  const moved = change.kind.move_path ? displayPath(change.kind.move_path, cwd) : null;
  const header = /^--- /m.test(change.diff) ? '' : `--- a/${name}\n+++ b/${moved ?? name}\n`;
  return { patch: `${header}${change.diff}${change.diff.endsWith('\n') ? '' : '\n'}`, added, removed, target: moved ?? name };
}

export function fileDiffs(changes: readonly FileUpdateChange[], cwd: string | null): FileDiff[] {
  return changes.map((change) => {
    const { patch, added, removed, target } = filePatch(change, cwd);
    return { path: target, added, removed, patch };
  });
}

/** The whole patch as one unified diff, for the approval a person reads. */
export function patchPreview(changes: readonly FileUpdateChange[], cwd: string | null): string {
  return changes.map((change) => filePatch(change, cwd).patch).join('');
}

/** Every file a patch touches, as absolute paths (a move names both ends). */
export function patchPaths(changes: readonly FileUpdateChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.kind.move_path) paths.add(change.kind.move_path);
  }
  return [...paths];
}

export function patchTitle(changes: readonly FileUpdateChange[], cwd: string | null): string {
  if (changes.length === 0) return 'Change files';
  const verb = (change: FileUpdateChange): string => (change.kind.type === 'add' ? 'Create' : change.kind.type === 'delete' ? 'Delete' : change.kind.move_path ? 'Move' : 'Edit');
  const first = changes[0]!;
  const same = changes.every((change) => verb(change) === verb(first));
  const names = changes.slice(0, 3).map((change) => displayPath(change.path, cwd));
  const more = changes.length > 3 ? ` and ${changes.length - 3} more` : '';
  return clip(`${same ? verb(first) : 'Change'} ${names.join(', ')}${more}`, 200);
}

/** The readable part of an MCP tool result. */
function mcpText(content: readonly unknown[]): string {
  return content
    .map((block) => {
      if (block !== null && typeof block === 'object') {
        const typed = block as { type?: unknown; text?: unknown };
        if (typeof typed.text === 'string') return typed.text;
        return `[${typeof typed.type === 'string' ? typed.type : 'content'}]`;
      }
      return typeof block === 'string' ? block : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

const COLLAB_TITLES: Record<string, string> = {
  spawnAgent: 'Start a sub-agent',
  sendInput: 'Message a sub-agent',
  sendMessage: 'Message a sub-agent',
  followupTask: 'Give a sub-agent another task',
  resumeAgent: 'Resume a sub-agent',
  wait: 'Wait for a sub-agent',
  closeAgent: 'Close a sub-agent',
  interruptAgent: 'Interrupt a sub-agent',
  listAgents: 'List sub-agents',
};

/** A rate-limit observation as published on the bus (see `codex.module.ts`). */
export interface RateLimitInfo {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly planType: string | null;
  readonly primary: RateLimitWindowInfo | null;
  readonly secondary: RateLimitWindowInfo | null;
  readonly credits: { readonly hasCredits: boolean; readonly unlimited: boolean; readonly balance: string | null } | null;
  /** Set when a limit has been hit: `rate_limit_reached`, `workspace_member_usage_limit_reached`, … */
  readonly reached: string | null;
}

export interface RateLimitWindowInfo {
  readonly usedPercent: number;
  /** Length of the window in minutes (300 = five hours, 10080 = a week); null when Codex does not say. */
  readonly windowMinutes: number | null;
  /** When the window starts again, in milliseconds since the epoch; null when Codex does not say. */
  readonly resetsAt: number | null;
}

export function rateLimitInfo(snapshot: RateLimitSnapshot): RateLimitInfo | null {
  const window = (value: RateLimitSnapshot['primary']): RateLimitWindowInfo | null =>
    value ? { usedPercent: value.usedPercent, windowMinutes: value.windowDurationMins ?? null, resetsAt: typeof value.resetsAt === 'number' ? value.resetsAt * 1000 : null } : null;
  const info: RateLimitInfo = {
    limitId: snapshot.limitId ?? null,
    limitName: snapshot.limitName ?? null,
    planType: snapshot.planType ?? null,
    primary: window(snapshot.primary),
    secondary: window(snapshot.secondary),
    credits: snapshot.credits ? { hasCredits: snapshot.credits.hasCredits, unlimited: snapshot.credits.unlimited, balance: snapshot.credits.balance ?? null } : null,
    reached: snapshot.rateLimitReachedType ?? null,
  };
  // A provider that reports no limits sends a snapshot with nothing in it.
  return info.primary || info.secondary || info.credits || info.reached ? info : null;
}

export interface TranslatorOptions {
  readonly emit: (event: AgentEvent) => void;
  readonly log: FastifyBaseLogger;
  /** The project directory, to show paths relative to it. */
  readonly cwd: string | null;
  /** The model the thread started with; used to label text and usage. */
  readonly model: string;
  /** The name the Studio's MCP bridge is registered under. */
  readonly bridgeName: string;
  readonly onRateLimits?: (info: RateLimitInfo) => void;
}

interface OpenTool {
  readonly name: string;
  finished: boolean;
}

/** The state of one run's stream of notifications. */
export class TurnTranslator {
  readonly #options: TranslatorOptions;
  readonly #tools = new Map<string, OpenTool>();
  readonly #fileChanges = new Map<string, FileUpdateChange[]>();
  readonly #commands = new Map<string, string>();
  readonly #mcpCalls = new Map<string, { server: string; tool: string; finished: boolean }>();
  readonly #reasoningIndex = new Map<string, number>();
  readonly #denials = new Map<string, string>();
  /** Thread of a sub-agent → the tool call that started it. */
  readonly #subAgents = new Map<string, string>();
  readonly #usageSeen = new Map<string, number>();
  /** Turns that began while this run was watching (the main one and any sub-agent's). */
  readonly #turnsStarted = new Set<string>();
  #mainThread: string | null = null;
  #model: string;
  #retrying = false;
  #compactionNoted = false;
  /** The last error Codex reported without promising to retry: the reason of a failed turn. */
  lastError: TurnError | null = null;

  constructor(options: TranslatorOptions) {
    this.#options = options;
    this.#model = options.model;
  }

  get model(): string {
    return this.#model;
  }

  set model(value: string) {
    if (value.trim() !== '') this.#model = value;
  }

  /** Events of any other thread belong to a sub-agent. */
  setMainThread(threadId: string): void {
    this.#mainThread = threadId;
  }

  /** The files of a patch Codex announced, for the approval that follows. */
  changesOf(itemId: string): readonly FileUpdateChange[] | undefined {
    return this.#fileChanges.get(itemId);
  }

  /** The command of an item Codex announced (already unwrapped). */
  commandOf(itemId: string): string | undefined {
    return this.#commands.get(itemId);
  }

  /** The MCP call of a server that is waiting to run (Codex asks about it without naming the item). */
  pendingMcpCall(server: string): { itemId: string; tool: string } | undefined {
    let found: { itemId: string; tool: string } | undefined;
    for (const [itemId, call] of this.#mcpCalls) {
      if (call.server === server && !call.finished) found = { itemId, tool: call.tool };
    }
    return found;
  }

  /** What the Studio said when it refused an item; shown as the result of the tool call. */
  noteDenial(itemId: string, message: string): void {
    this.#denials.set(itemId, message);
  }

  /** The parameters of a notification, or null (logged) when they are not what this version of the protocol says. */
  #params<M extends NotificationMethod>(method: M, raw: unknown): NotificationParams<M> | null {
    const parsed = notificationSchemas[method].safeParse(raw);
    if (parsed.success) return parsed.data as NotificationParams<M>;
    this.#options.log.debug({ method }, 'codex: a notification with an unexpected shape, skipped');
    return null;
  }

  notification(method: string, raw: unknown): void {
    if (!isKnownNotification(method)) {
      this.#options.log.debug({ method }, 'codex: a notification this adapter does not use');
      return;
    }
    const on = <M extends NotificationMethod>(name: M, handle: (params: NotificationParams<M>) => void): void => {
      const params = this.#params(name, raw);
      if (params !== null) handle(params);
    };
    switch (method) {
      case 'item/started':
        return on(method, (params) => this.#itemStarted(params));
      case 'item/completed':
        return on(method, (params) => this.#itemCompleted(params));
      case 'item/agentMessage/delta':
        return on(method, (params) => this.#textDelta(params));
      case 'item/reasoning/summaryPartAdded':
        return on(method, (params) => this.#reasoningPart(params));
      case 'item/reasoning/summaryTextDelta':
        return on(method, (params) => this.#reasoningDelta(params, params.summaryIndex));
      case 'item/reasoning/textDelta':
        return on(method, (params) => this.#reasoningDelta(params, null));
      case 'item/commandExecution/outputDelta':
        return on(method, (params) => this.#toolOutput(params));
      case 'item/mcpToolCall/progress':
        return on(method, (params) => this.#mcpProgress(params));
      case 'item/fileChange/patchUpdated':
        return on(method, (params) => this.#patchUpdated(params));
      case 'turn/plan/updated':
        return on(method, (params) => this.#plan(params));
      case 'thread/tokenUsage/updated':
        return on(method, (params) => this.#usage(params.threadId, params.turnId, params.tokenUsage));
      case 'account/rateLimits/updated':
        return on(method, (params) => this.#rateLimits(params.rateLimits));
      case 'thread/name/updated':
        return on(method, (params) => this.#named(params));
      case 'thread/compacted':
        return this.#compacted();
      case 'model/rerouted':
        return on(method, (params) => this.#rerouted(params));
      case 'mcpServer/startupStatus/updated':
        return on(method, (params) => this.#mcpStartup(params));
      case 'error':
        return on(method, (params) => this.#error(params));
      case 'warning':
        return on(method, (params) => this.#warning(params));
      case 'configWarning':
        return on(method, (params) => this.#configWarning(params));
      case 'turn/started':
        return on(method, (params) => {
          this.#turnsStarted.add(params.turn.id);
        });
      // The run itself follows these; there is nothing to translate.
      case 'thread/started':
      case 'turn/completed':
        return;
    }
  }

  // ---- items ------------------------------------------------------------------

  #parent(threadId: string): { parentToolCallId?: string } {
    if (this.#mainThread === null || threadId === this.#mainThread) return {};
    const parent = this.#subAgents.get(threadId);
    return parent === undefined ? {} : { parentToolCallId: parent };
  }

  #progress(): void {
    this.#retrying = false;
  }

  #read(method: string, value: unknown): CodexItem | null {
    const item = readItem(value);
    if (!item) {
      const type = (value as { type?: unknown } | null)?.type;
      this.#options.log.debug({ method, itemType: typeof type === 'string' ? type : null }, 'codex: an item this adapter does not know, skipped');
    }
    return item;
  }

  #itemStarted(params: { threadId: string; item: unknown }): void {
    const item = this.#read('item/started', params.item);
    if (!item) return;
    this.#progress();
    this.#startTool(item, params.threadId);
  }

  /** Emits `tool.started` for an item that is a tool call. Idempotent. */
  #startTool(item: CodexItem, threadId: string): void {
    const id = 'id' in item && typeof item.id === 'string' ? item.id : null;
    if (id === null || this.#tools.has(id)) return;
    const parent = this.#parent(threadId);
    const start = (name: string, kind: Extract<AgentEvent, { type: 'tool.started' }>['kind'], title: string, input: unknown): void => {
      this.#tools.set(id, { name, finished: false });
      this.#options.emit({ type: 'tool.started', toolCallId: id, name, kind, title: clip(title, 300), input, ...parent });
    };
    switch (item.type) {
      case 'commandExecution': {
        const command = unwrapShellCommand(item.command);
        this.#commands.set(id, command);
        start(TOOL.shell, 'execute', command, { command, ...(item.cwd ? { cwd: item.cwd } : {}) });
        return;
      }
      case 'fileChange': {
        this.#fileChanges.set(id, item.changes);
        start(TOOL.patch, 'edit', patchTitle(item.changes, this.#options.cwd), {
          changes: item.changes.map((change) => ({
            path: displayPath(change.path, this.#options.cwd),
            kind: change.kind.type,
            ...(change.kind.move_path ? { movePath: displayPath(change.kind.move_path, this.#options.cwd) } : {}),
          })),
        });
        return;
      }
      case 'mcpToolCall': {
        this.#mcpCalls.set(id, { server: item.server, tool: item.tool, finished: false });
        const own = item.server === this.#options.bridgeName;
        start(`mcp__${item.server}__${item.tool}`, 'other', own ? item.tool : `${item.tool} (${item.server})`, item.arguments ?? {});
        return;
      }
      case 'dynamicToolCall':
        start(item.namespace ? `${item.namespace}.${item.tool}` : item.tool, 'other', item.tool, item.arguments ?? {});
        return;
      case 'webSearch':
        start(TOOL.webSearch, 'fetch', item.query ? `Search the web: ${item.query}` : 'Search the web', { query: item.query });
        return;
      case 'imageView':
        start(TOOL.imageView, 'read', `Look at ${displayPath(item.path, this.#options.cwd)}`, { path: item.path });
        return;
      case 'collabAgentToolCall': {
        const what = COLLAB_TITLES[item.tool] ?? item.tool;
        start(item.tool, 'agent', item.prompt ? `${what}: ${clip(item.prompt.replace(/\s+/g, ' '), 120)}` : what, {
          ...(item.prompt ? { prompt: item.prompt } : {}),
          ...(item.model ? { model: item.model } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  #finishTool(id: string, status: 'ok' | 'error' | 'denied', output: string, diffs?: FileDiff[]): void {
    const tool = this.#tools.get(id);
    if (!tool || tool.finished) return;
    tool.finished = true;
    this.#options.emit({ type: 'tool.finished', toolCallId: id, status, output, ...(diffs ? { diffs } : {}) });
  }

  #itemCompleted(params: { threadId: string; item: unknown }): void {
    const item = this.#read('item/completed', params.item);
    if (!item) return;
    this.#progress();
    const parent = this.#parent(params.threadId);
    switch (item.type) {
      case 'agentMessage':
        if (item.text !== '') this.#options.emit({ type: 'text', messageId: item.id, text: item.text, model: this.#model, ...parent });
        return;
      case 'plan':
        if (item.text.trim() !== '') this.#options.emit({ type: 'text', messageId: item.id, text: item.text, model: this.#model, ...parent });
        return;
      case 'reasoning': {
        const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n').trim();
        if (text !== '') this.#options.emit({ type: 'thinking', messageId: item.id, text, ...parent });
        return;
      }
      case 'commandExecution': {
        this.#startTool(item, params.threadId);
        const output = item.aggregatedOutput ?? '';
        if (item.status === 'declined') {
          this.#finishTool(item.id, 'denied', this.#denials.get(item.id) ?? 'This command was not allowed.');
        } else if (item.status === 'completed' && (item.exitCode ?? 0) === 0) {
          this.#finishTool(item.id, 'ok', output);
        } else {
          const code = typeof item.exitCode === 'number' ? `[exit code ${item.exitCode}]` : '[the command did not finish]';
          this.#finishTool(item.id, 'error', output === '' ? code : `${output}${output.endsWith('\n') ? '' : '\n'}${code}`);
        }
        return;
      }
      case 'fileChange': {
        this.#startTool(item, params.threadId);
        const changes = item.changes.length > 0 ? item.changes : (this.#fileChanges.get(item.id) ?? []);
        const diffs = fileDiffs(changes, this.#options.cwd);
        if (item.status === 'declined') this.#finishTool(item.id, 'denied', this.#denials.get(item.id) ?? 'This change was not allowed.', diffs);
        else if (item.status === 'completed') this.#finishTool(item.id, 'ok', `Changed ${diffs.map((diff) => diff.path).join(', ')}`, diffs);
        else this.#finishTool(item.id, 'error', 'The change could not be applied.', diffs);
        return;
      }
      case 'mcpToolCall': {
        this.#startTool(item, params.threadId);
        const call = this.#mcpCalls.get(item.id);
        if (call) call.finished = true;
        const denied = this.#denials.get(item.id);
        if (denied !== undefined) this.#finishTool(item.id, 'denied', denied);
        else if (item.status === 'completed' && !item.error) this.#finishTool(item.id, 'ok', mcpText(item.result?.content ?? []));
        else this.#finishTool(item.id, 'error', item.error?.message || mcpText(item.result?.content ?? []) || 'The tool call failed.');
        return;
      }
      case 'dynamicToolCall':
        this.#startTool(item, params.threadId);
        this.#finishTool(item.id, item.status === 'completed' && item.success !== false ? 'ok' : 'error', '');
        return;
      case 'webSearch': {
        this.#startTool(item, params.threadId);
        const action = item.action;
        const detail = action?.url ? `Opened ${action.url}` : (action?.query ?? item.query) ? `Searched for: ${action?.query ?? item.query}` : '';
        this.#finishTool(item.id, 'ok', detail);
        return;
      }
      case 'imageView':
        this.#startTool(item, params.threadId);
        this.#finishTool(item.id, 'ok', '');
        return;
      case 'collabAgentToolCall': {
        this.#startTool(item, params.threadId);
        // What the new agent does arrives under its own thread id; nest it under this call.
        if (item.tool === 'spawnAgent') for (const thread of item.receiverThreadIds) this.#subAgents.set(thread, item.id);
        this.#finishTool(item.id, item.status === 'completed' ? 'ok' : 'error', '');
        return;
      }
      case 'contextCompaction':
        return this.#compacted();
      default:
        return;
    }
  }

  // ---- streaming --------------------------------------------------------------

  #textDelta(params: { threadId: string; itemId: string; delta: string }): void {
    if (params.delta === '') return;
    this.#progress();
    this.#options.emit({ type: 'text.delta', messageId: params.itemId, text: params.delta, ...this.#parent(params.threadId) });
  }

  #reasoningPart(params: { itemId: string; summaryIndex: number }): void {
    if (!this.#reasoningIndex.has(params.itemId)) this.#reasoningIndex.set(params.itemId, -1);
  }

  /** `summaryIndex` is null for raw reasoning text, which has no parts. */
  #reasoningDelta(params: { threadId: string; itemId: string; delta: string }, summaryIndex: number | null): void {
    if (params.delta === '') return;
    this.#progress();
    const parent = this.#parent(params.threadId);
    if (summaryIndex !== null) {
      // A summary comes in parts; in the finished block they are paragraphs.
      const index = summaryIndex;
      const previous = this.#reasoningIndex.get(params.itemId) ?? -1;
      if (previous >= 0 && index > previous) this.#options.emit({ type: 'thinking.delta', messageId: params.itemId, text: '\n\n', ...parent });
      if (index > previous) this.#reasoningIndex.set(params.itemId, index);
    }
    this.#options.emit({ type: 'thinking.delta', messageId: params.itemId, text: params.delta, ...parent });
  }

  #toolOutput(params: { itemId: string; delta: string }): void {
    if (params.delta === '' || !this.#tools.has(params.itemId)) return;
    this.#options.emit({ type: 'tool.output', toolCallId: params.itemId, text: params.delta });
  }

  #mcpProgress(params: { itemId: string; message: string }): void {
    if (params.message === '' || !this.#tools.has(params.itemId)) return;
    this.#options.emit({ type: 'tool.output', toolCallId: params.itemId, text: `${params.message}\n` });
  }

  #patchUpdated(params: { itemId: string; changes: FileUpdateChange[] }): void {
    if (params.changes.length > 0) this.#fileChanges.set(params.itemId, params.changes);
  }

  // ---- everything else --------------------------------------------------------

  #plan(params: { plan: Array<{ step: string; status: string }> }): void {
    const items: TodoItem[] = params.plan
      .filter((step) => step.step.trim() !== '')
      .map((step) => ({ text: step.step, status: step.status === 'completed' ? 'completed' : step.status === 'inProgress' ? 'in_progress' : 'pending' }));
    this.#options.emit({ type: 'todos', items });
  }

  #usage(threadId: string, turnId: string | undefined, usage: { total: TokenBreakdown; last: TokenBreakdown; modelContextWindow?: number | null }): void {
    const { total, last, modelContextWindow } = usage;
    // The same totals again are not new usage.
    if (this.#usageSeen.get(threadId) === total.totalTokens) return;
    this.#usageSeen.set(threadId, total.totalTokens);
    // When a conversation is reopened, Codex first reports the figures of its previous turn once more
    // (seen with codex-cli 0.160.0). Those were counted by the run they belong to.
    if (turnId !== undefined && !this.#turnsStarted.has(turnId)) return;
    if (last.totalTokens <= 0) return;
    // Codex counts cached and cache-writing tokens inside the input; the Studio keeps them apart.
    const cached = Math.max(0, Math.min(last.cachedInputTokens, last.inputTokens));
    const written = Math.max(0, Math.min(last.cacheWriteInputTokens, last.inputTokens - cached));
    const isMain = this.#mainThread === null || threadId === this.#mainThread;
    this.#options.emit({
      type: 'usage',
      model: this.#model,
      inputTokens: Math.max(0, last.inputTokens - cached - written),
      outputTokens: Math.max(0, last.outputTokens),
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      // Only the main conversation says how full the session's context is.
      ...(isMain ? { contextTokens: Math.max(0, last.totalTokens) } : {}),
      ...(isMain && typeof modelContextWindow === 'number' && modelContextWindow > 0 ? { contextWindow: modelContextWindow } : {}),
    });
  }

  #rateLimits(snapshot: RateLimitSnapshot): void {
    const info = rateLimitInfo(snapshot);
    if (info) this.#options.onRateLimits?.(info);
  }

  #named(params: { threadId: string; threadName?: string }): void {
    const name = params.threadName?.trim();
    if (name && (this.#mainThread === null || params.threadId === this.#mainThread)) this.#options.emit({ type: 'title', title: clip(name, 200) });
  }

  #compacted(): void {
    if (this.#compactionNoted) return;
    this.#compactionNoted = true;
    this.#options.emit({ type: 'notice', level: 'info', code: 'compaction', text: 'Codex summarised the earlier conversation to make room in its context.' });
  }

  #rerouted(params: { fromModel: string; toModel: string }): void {
    this.model = params.toModel;
    this.#options.emit({ type: 'notice', level: 'info', code: 'model_rerouted', text: `Codex answered with ${params.toModel} instead of ${params.fromModel}.` });
  }

  #mcpStartup(params: { name: string; status: string; error?: string | null }): void {
    if (params.status !== 'failed' || params.name !== this.#options.bridgeName) return;
    this.#options.emit({ type: 'notice', level: 'warning', code: 'studio_tools_unavailable', text: "Codex could not start the Studio's own tools (shared memory and plugin tools) for this run." });
    this.#options.log.warn({ err: tidy(params.error ?? '', 300) }, 'codex: the Studio bridge did not start');
  }

  #error(params: { error: TurnError; willRetry: boolean }): void {
    if (!params.willRetry) {
      this.lastError = params.error;
      return;
    }
    // Codex reports every attempt ("Reconnecting... 3/5"); one line per interruption is enough.
    if (this.#retrying) return;
    this.#retrying = true;
    this.#options.emit({ type: 'notice', level: 'warning', code: 'codex_retry', text: 'Codex lost its connection to the model and is trying again.' });
  }

  #warning(params: { message: string }): void {
    const text = tidy(params.message, 400);
    if (text !== '') this.#options.emit({ type: 'notice', level: 'warning', code: 'codex_warning', text });
  }

  #configWarning(params: { summary: string; details?: string | null }): void {
    const text = tidy(params.summary, 300);
    if (text !== '') this.#options.emit({ type: 'notice', level: 'warning', code: 'codex_config_warning', text });
  }
}
