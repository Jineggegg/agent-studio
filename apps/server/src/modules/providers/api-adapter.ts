import { promises as fs } from 'node:fs';
import { type AgentCapabilities, type AgentStatus, PROVIDER_NOTICE, type ProviderCheck, type ProviderModel, providerAgentId } from '@agent-studio/protocol';
import type { AgentToolContext } from '../../kernel/agent-tools.js';
import { describeError } from '../../kernel/errors.js';
import type { ModuleContext, Services } from '../../kernel/module.js';
import { redactSecrets } from '../../kernel/redact.js';
import {
  type AgentAdapter,
  type AgentRunHandle,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  AgentRunError,
  type StudioToolDescription,
} from '../agents/adapter.js';
import { defaultModelOf, resolveModel, visibleModels } from './catalogue.js';
import { buildInstructions, fitConversation, historyMessages, inputBudget, promptText } from './conversation.js';
import { type ApiAgentLimits, MAX_IMAGES_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from './limits.js';
import type { ChatMessage, TokenUsage, ToolDeclaration } from './openai-client.js';
import type { ProviderRecord } from './providers.store.js';
import { PROJECT_TOOL_NAMES, projectTools } from './tools/project-tools.js';
import { type ModelTool, type PreparedCall, ToolRefusal, type ToolOutcome, boundResult, clipText, oneLine } from './tools/tool.js';
import { type ProviderFailure, type ProviderTarget, describeFailure, wireFor } from './wire.js';

/**
 * An API model as an agent.
 *
 * One adapter stands for one provider record. It keeps no copy of the record:
 * every status poll, capability listing and model request reads the record
 * as it is at that moment through {@link ProviderAccess}, so what the owner
 * changes — a new key, another address, a provider switched off — takes
 * effect on the very next request.
 *
 * A turn is a loop: send the conversation, stream the answer, and while the
 * model asks for tools, carry them out and send the results back. Every tool
 * call is put to the Studio's permission engine before it runs; nothing here
 * decides a permission. The loop has hard limits (`limits.ts`); reaching one
 * ends the turn with a notice, after one last request in which the model may
 * only answer in words.
 */

export interface ProviderAccess {
  /** The record as it is now; null once the provider was removed. */
  record(): ProviderRecord | null;
  /** Where a request goes, with the key — or why none can be sent. */
  target(record: ProviderRecord): { readonly ok: true; readonly target: ProviderTarget } | { readonly ok: false; readonly failure: ProviderFailure };
  /** Why no request can be sent (no key saved, a key that cannot be read any more), or null. Does not hand out the key. */
  blocked(record: ProviderRecord): ProviderFailure | null;
  /** How the newest request to the provider went, if any was made since the server started. */
  lastCheck(): ProviderCheck | null;
  /** Remembers how a request went, for `status()`. */
  report(outcome: { readonly ok: boolean; readonly code: string; readonly message: string }): void;
}

/** Codes after which the provider counts as "not signed in" until a request succeeds again. */
const KEY_PROBLEMS = new Set(['provider_not_configured', 'provider_key_unreadable', 'provider_auth_failed']);

class Stopped extends Error {}
class TimeUp extends Error {}

interface RequestedCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

interface Answer {
  readonly text: string;
  readonly reasoning: string;
  readonly calls: readonly RequestedCall[];
  readonly finishReason: string | null;
}

const sameJson = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * A call as it is sent back to the provider in the next request. Providers
 * check what they are sent, so a name or arguments the model garbled are
 * replaced by something well-formed; the tool result says what was wrong.
 */
function echoed(call: RequestedCall): { name: string; arguments: string } {
  let args = '{}';
  try {
    JSON.parse(call.arguments);
    args = call.arguments;
  } catch {
    // not JSON: keep the empty object
  }
  return { name: /^[a-zA-Z0-9_-]{1,64}$/.test(call.name) ? call.name : 'unknown_tool', arguments: args };
}

const minutes = (ms: number): string => (ms >= 90_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`);

/** A registered Studio tool, as something the model can call. Write tools are put to the permission engine by the runtime itself. */
function studioTool(description: StudioToolDescription, host: AgentRunHost): ModelTool {
  const { $schema: _dialect, ...parameters } = description.inputSchema;
  const kind = description.effect === 'read' ? 'read' : 'other';
  return {
    kind,
    declaration: { name: description.name, description: clipText(description.description, 1024), parameters },
    prepare(args) {
      const call: PreparedCall = {
        kind,
        title: description.name.replace(/_/g, ' '),
        input: args,
        permissions: [],
        waitsForPeople: description.effect === 'write',
        async run(io) {
          // Naming the call ties its approval — and a refusal — to the tool row the transcript already shows.
          const result = await host.studioTools.call(description.name, args, io.toolCallId === undefined ? {} : { toolCallId: io.toolCallId });
          // The runtime says so when it refused the call; its wording is for the model, not something to parse.
          if (result.denied === true) return { status: 'denied', text: `Denied: ${result.text.replace(/^Not allowed: /, '')}` };
          return { status: result.isError ? 'error' : 'ok', text: result.text };
        },
      };
      return Promise.resolve(call);
    },
  };
}

export class ApiModelAdapter implements AgentAdapter {
  readonly id: string;
  readonly kind = 'api' as const;
  readonly providerId: string;
  readonly #context: ModuleContext;
  readonly #access: ProviderAccess;
  readonly #limits: ApiAgentLimits;
  readonly #turns = new Set<Turn>();
  #lastName: string;

  constructor(deps: { providerId: string; name: string; context: ModuleContext; access: ProviderAccess; limits: ApiAgentLimits }) {
    this.providerId = deps.providerId;
    this.id = providerAgentId(deps.providerId);
    this.#context = deps.context;
    this.#access = deps.access;
    this.#limits = deps.limits;
    this.#lastName = deps.name;
  }

  get displayName(): string {
    const record = this.#access.record();
    if (record) this.#lastName = record.name;
    return this.#lastName;
  }

  capabilities(): AgentCapabilities {
    const record = this.#access.record();
    const offered = record ? visibleModels(record) : [];
    const preferred = record ? defaultModelOf(record) : null;
    return {
      models: offered.map((model) => ({
        id: model.id,
        label: model.name,
        ...(model.id === preferred ? { recommended: true } : {}),
        ...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
      })),
      defaultModel: preferred,
      // The modes are the Studio's own: its permission engine applies them to every tool call of the model.
      permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
      images: offered.some((model) => model.images),
      steering: false,
      resume: false,
      planMode: true,
      usage: true,
    };
  }

  /** From what is stored and remembered: no request is made to the provider here. */
  status(): AgentStatus {
    const record = this.#access.record();
    if (!record || !record.enabled) {
      return { installed: false, version: null, signedIn: false, account: null, problem: 'This provider is no longer offered on this Studio.' };
    }
    const blocked = this.#access.blocked(record);
    if (blocked) return { installed: true, version: null, signedIn: false, account: null, problem: blocked.message };
    if (visibleModels(record).length === 0) {
      return { installed: true, version: null, signedIn: true, account: null, problem: `${record.name} offers no model yet. The owner can add one in the provider settings.` };
    }
    const last = this.#access.lastCheck();
    if (last && !last.ok) return { installed: true, version: null, signedIn: !KEY_PROBLEMS.has(last.code), account: null, problem: last.message };
    return { installed: true, version: null, signedIn: true, account: null, problem: null };
  }

  run(request: AgentRunRequest, host: AgentRunHost): AgentRunHandle {
    const turn = new Turn({ adapterId: this.id, context: this.#context, access: this.#access, limits: this.#limits, request, host });
    this.#turns.add(turn);
    // Rule 2 of the contract: `done` settles exactly once — here, by construction.
    const done = turn.play().finally(() => this.#turns.delete(turn));
    // A failure is the runtime's to handle; should it ever have let go of the handle, the rejection must not go unhandled.
    done.catch(() => {});
    return { done, cancel: () => turn.stop() };
  }

  /** Ends every turn in progress: the provider was removed or switched off. */
  stopAll(): void {
    for (const turn of this.#turns) turn.stop('provider_removed');
  }

  get activeTurns(): number {
    return this.#turns.size;
  }
}

class Turn {
  readonly #adapterId: string;
  readonly #context: ModuleContext;
  readonly #access: ProviderAccess;
  readonly #limits: ApiAgentLimits;
  readonly #request: AgentRunRequest;
  readonly #host: AgentRunHost;
  /** Aborts the HTTP stream and any command at once. */
  readonly #abort = new AbortController();
  readonly #noticed = new Set<string>();
  #withdrawn = false;
  #workedMs = 0;
  #blocks = 0;
  #calls = 0;

  constructor(deps: { adapterId: string; context: ModuleContext; access: ProviderAccess; limits: ApiAgentLimits; request: AgentRunRequest; host: AgentRunHost }) {
    this.#adapterId = deps.adapterId;
    this.#context = deps.context;
    this.#access = deps.access;
    this.#limits = deps.limits;
    this.#request = deps.request;
    this.#host = deps.host;
  }

  stop(reason?: 'provider_removed'): void {
    if (reason === 'provider_removed') this.#withdrawn = true;
    this.#abort.abort();
  }

  async play(): Promise<AgentRunResult> {
    const signal = this.#request.signal;
    const onAbort = (): void => this.#abort.abort();
    // Rule 3: stop when the run's signal aborts as well as when cancel() is called.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.#converse();
      return { status: 'completed' };
    } catch (error) {
      if (error instanceof TimeUp) {
        this.#notice('warning', PROVIDER_NOTICE.timeLimit, `The Studio ended this turn: it had been working for ${minutes(this.#limits.maxTurnMs)}, the most one turn may take. Send a message to continue.`);
        return { status: 'completed' };
      }
      if (error instanceof Stopped || this.#abort.signal.aborted) {
        if (this.#withdrawn && !signal.aborted) throw new AgentRunError('provider_removed', 'The provider was removed or switched off while this run was in progress.');
        // A stop is not a failure: the runtime records it as stopped.
        return { status: 'completed' };
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ---- small helpers ---------------------------------------------------------

  #notice(level: 'info' | 'warning', code: string, text: string): void {
    if (this.#noticed.has(code)) return;
    this.#noticed.add(code);
    this.#host.emit({ type: 'notice', level, code, text });
  }

  #checkStopped(): void {
    if (this.#abort.signal.aborted) throw new Stopped();
  }

  /**
   * Runs a piece of work that counts towards the turn's time: a model
   * request, a tool. Its signal aborts when the run is stopped or the time is
   * up; afterwards the turn ends if either happened.
   */
  async #work<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#checkStopped();
    const left = this.#limits.maxTurnMs - this.#workedMs;
    if (left <= 0) throw new TimeUp();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), left);
    const started = Date.now();
    try {
      return await task(AbortSignal.any([this.#abort.signal, deadline.signal]));
    } catch (error) {
      if (this.#abort.signal.aborted) throw new Stopped();
      if (deadline.signal.aborted) throw new TimeUp();
      throw error;
    } finally {
      clearTimeout(timer);
      this.#workedMs += Date.now() - started;
    }
  }

  // ---- the conversation ------------------------------------------------------

  async #converse(): Promise<void> {
    const request = this.#request;
    const record = this.#currentRecord();
    const { model, replaced } = resolveModel(record, request.model);
    if (!model) throw new AgentRunError('provider_no_model', `${record.name} has no model to answer with. The owner can add one in the provider settings.`);
    if (replaced !== null) {
      this.#notice('info', PROVIDER_NOTICE.modelFallback, `The model "${oneLine(replaced, 80)}" is no longer in the catalogue of ${record.name}; ${model.name} answers instead.`);
    }
    // Fail before any work when no request could be sent anyway.
    this.#target(record);

    const services = this.#context.services as Partial<Services>;
    const project = request.projectId === null || request.cwd === null ? null : (services.projects?.find(request.projectId) ?? null);
    const principal = services.agents?.principalFor(request.userId) ?? null;
    const projectAccess = project && principal ? (services.projects?.accessOf(principal, project.id) ?? null) : null;
    const sandboxed = this.#context.sandbox.status.mode === 'bwrap';

    // The tools of this turn: the project's first, then the Studio's own.
    const tools = new Map<string, ModelTool>();
    let fileTools = false;
    let studioTools = false;
    if (model.tools) {
      if (project && request.cwd !== null && projectAccess !== null) {
        for (const tool of projectTools({
          root: request.cwd,
          dataDir: this.#context.config.dataDir,
          write: projectAccess === 'write',
          limits: this.#limits,
          processes: this.#context.processes,
          sandbox: this.#context.sandbox,
        })) {
          tools.set(tool.declaration.name, tool);
        }
        fileTools = true;
      }
      for (const description of this.#host.studioTools.list()) {
        if (tools.size >= this.#limits.maxDeclaredTools) break;
        // A project tool's name is never given away to a tool registered later.
        if (tools.has(description.name) || (PROJECT_TOOL_NAMES as readonly string[]).includes(description.name)) continue;
        tools.set(description.name, studioTool(description, this.#host));
        studioTools = true;
      }
    }
    const declarations: ToolDeclaration[] = [...tools.values()].map((tool) => tool.declaration);

    // Background from shared memory. `contextFor` never throws and is time-boxed; without the memory module there is none.
    const identity: AgentToolContext = { runId: request.runId, sessionId: request.sessionId, projectId: request.projectId, userId: request.userId, agentId: this.#adapterId };
    const memory = services.memory;
    const background = memory ? await memory.contextFor(identity, request.prompt.text, { signal: this.#abort.signal }) : null;
    this.#checkStopped();
    const memoryTools = [...tools.keys()].some((name) => name.startsWith('memory_'));

    const system: ChatMessage = {
      role: 'system',
      content: buildInstructions({
        providerName: record.name,
        modelName: model.name,
        project: project && request.cwd !== null ? { name: project.name, cwd: request.cwd } : null,
        tools: { files: fileTools, changes: fileTools && projectAccess === 'write', studio: studioTools },
        toolCapable: model.tools,
        permissionMode: request.permissionMode,
        sandboxed,
        unattended: request.unattended,
        memoryGuide: memory && memoryTools ? memory.agentGuide() : null,
        memoryContext: background?.state === 'attached' ? background.text : null,
      }),
    };

    const earlier = historyMessages(request.history);
    const latest = await this.#userMessage(model, earlier.unanswered);
    this.#checkStopped();

    const turn: ChatMessage[] = [];
    let rounds = 0;
    let fedBytes = 0;
    /** Set once a limit was reached: one more request follows, in which the model may only answer. */
    let closing = false;

    for (;;) {
      const fitted = fitConversation({ system, history: earlier.messages, latest, turn, budgetTokens: inputBudget(model.contextWindow, declarations) });
      if (fitted.dropped > 0) {
        this.#notice(
          'info',
          PROVIDER_NOTICE.historyTruncated,
          `This conversation is longer than ${model.name} can take in at once: the oldest ${fitted.dropped === 1 ? 'message was' : `${fitted.dropped} messages were`} left out of what the model sees. Nothing was deleted.`,
        );
      }
      if (!fitted.fits && turn.length > 0) {
        this.#notice('warning', PROVIDER_NOTICE.contextFull, `The Studio ended this turn: the tool results no longer fit into the context window of ${model.name}. Send a message to continue.`);
        return;
      }

      const answer = await this.#ask(model, fitted.messages, declarations, closing);
      if (answer.finishReason === 'length') {
        this.#notice('warning', PROVIDER_NOTICE.answerTruncated, `The answer was cut off: ${model.name} reached the most it may write in one answer.`);
      } else if (answer.finishReason === 'content_filter') {
        this.#notice('warning', PROVIDER_NOTICE.answerFiltered, `${record.name} withheld part of the answer (its content filter).`);
      }
      if (closing || answer.calls.length === 0) {
        if (!closing && answer.text.trim() === '' && answer.finishReason !== 'content_filter') {
          throw new AgentRunError('provider_empty_answer', `${record.name} returned an empty answer.`);
        }
        return;
      }

      rounds += 1;
      turn.push({
        role: 'assistant',
        content: answer.text === '' ? null : answer.text,
        tool_calls: answer.calls.map((call) => ({ id: call.id, type: 'function', function: echoed(call) })),
        ...(answer.reasoning === '' ? {} : { reasoning_content: answer.reasoning }),
      });

      let limit: string | null = null;
      for (const call of answer.calls) {
        let result: string;
        if (limit !== null) {
          result = `Not run: ${limit}.`;
        } else if (this.#calls >= this.#limits.maxToolCalls) {
          limit = `the limit of ${this.#limits.maxToolCalls} tool calls in one turn was reached`;
          result = `Not run: ${limit}.`;
        } else {
          this.#calls += 1;
          result = boundResult(await this.#call(tools, call), this.#limits.maxResultBytes).text;
          fedBytes += Buffer.byteLength(result);
          if (fedBytes > this.#limits.maxTurnResultBytes) limit = `the tool results of this turn add up to more than ${this.#limits.maxTurnResultBytes} bytes`;
        }
        turn.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (limit === null && rounds >= this.#limits.maxToolRounds) limit = `the limit of ${this.#limits.maxToolRounds} rounds of tool calls in one turn was reached`;
      if (limit !== null) {
        closing = true;
        this.#notice('warning', PROVIDER_NOTICE.toolLimit, `The Studio ended this turn's tool use: ${limit}. The model was asked to answer with what it has; send a message to continue.`);
        const last = turn[turn.length - 1]!;
        turn[turn.length - 1] = {
          ...last,
          content: `${typeof last.content === 'string' ? last.content : ''}\n\n[Agent Studio: ${limit}. No more tools can be called in this turn. Answer the user now with what you have, and say what is left to do.]`,
        };
      }
    }
  }

  #currentRecord(): ProviderRecord {
    const record = this.#access.record();
    if (!record || !record.enabled) throw new AgentRunError('provider_removed', 'This provider is no longer offered on this Studio.');
    return record;
  }

  #target(record: ProviderRecord): ProviderTarget {
    const access = this.#access.target(record);
    if (!access.ok) throw new AgentRunError(access.failure.code, access.failure.message);
    return access.target;
  }

  /** The new message: the text (what was quoted above it), text attachments inline, images as data URLs for a model that takes them. */
  async #userMessage(model: ProviderModel, unanswered: string | null): Promise<ChatMessage> {
    const { prompt } = this.#request;
    const sections: string[] = [];
    if (unanswered !== null) sections.push(unanswered);
    sections.push(promptText(prompt.text, prompt.quote));

    const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    const unseen: string[] = [];
    const skipped: string[] = [];
    let imageBytes = 0;
    for (const attachment of prompt.attachments) {
      const name = oneLine(attachment.name, 80);
      if (attachment.isImage) {
        if (!model.images) {
          unseen.push(name);
          continue;
        }
        if (attachment.size > MAX_IMAGE_BYTES || imageBytes + attachment.size > MAX_IMAGES_BYTES) {
          skipped.push(`${name} (too large)`);
          continue;
        }
        const data = await fs.readFile(attachment.path).catch(() => null);
        if (!data) {
          skipped.push(`${name} (could not be read)`);
          continue;
        }
        imageBytes += data.length;
        images.push({ type: 'image_url', image_url: { url: `data:${attachment.mediaType};base64,${data.toString('base64')}` } });
        continue;
      }
      const data = attachment.size <= MAX_TEXT_ATTACHMENT_BYTES ? await fs.readFile(attachment.path).catch(() => null) : null;
      const text = data && !data.subarray(0, 8192).includes(0) ? data.toString('utf8') : null;
      if (text === null || text.includes('�')) {
        skipped.push(`${name} (${attachment.size > MAX_TEXT_ATTACHMENT_BYTES ? 'too large' : 'not a text file'})`);
        continue;
      }
      sections.push(`Attached file "${name}":\n<attached-file>\n${text}\n</attached-file>`);
    }
    if (unseen.length > 0) {
      this.#notice(
        'warning',
        PROVIDER_NOTICE.imagesNotSupported,
        `${model.name} cannot look at images, so ${unseen.length === 1 ? `the attached image ${unseen[0]} was` : `${unseen.length} attached images (${unseen.join(', ')}) were`} not given to it.`,
      );
    }
    if (skipped.length > 0) {
      this.#notice('warning', PROVIDER_NOTICE.attachmentSkipped, `Not given to the model: ${skipped.join(', ')}. An API model gets images and small text files only.`);
    }
    const text = sections.join('\n\n');
    return images.length === 0 ? { role: 'user', content: text } : { role: 'user', content: [{ type: 'text', text }, ...images] };
  }

  /** One request to the model, streamed into the transcript. */
  async #ask(model: ProviderModel, messages: readonly ChatMessage[], tools: readonly ToolDeclaration[], closing: boolean): Promise<Answer> {
    // Read again for every request: a key or an address the owner changed applies at once.
    const record = this.#currentRecord();
    const target = this.#target(record);
    const wire = wireFor(record.kind);
    const host = this.#host;
    this.#blocks += 1;
    const textId = `${this.#request.runId}-t${this.#blocks}`;
    const thinkingId = `${this.#request.runId}-r${this.#blocks}`;

    let text = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    let stalled = false;
    const pieces = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      await this.#work(async (signal) => {
        const idle = new AbortController();
        const timer = setTimeout(() => {
          stalled = true;
          idle.abort();
        }, this.#limits.streamIdleMs);
        try {
          const stream = wire.chat(target, {
            model: model.id,
            messages,
            ...(tools.length > 0 ? { tools, toolChoice: closing ? ('none' as const) : ('auto' as const) } : {}),
            signal: AbortSignal.any([signal, idle.signal]),
            timeoutMs: this.#limits.responseStartMs,
          });
          for await (const delta of stream) {
            timer.refresh();
            switch (delta.type) {
              case 'text':
                text += delta.text;
                host.emit({ type: 'text.delta', messageId: textId, text: delta.text });
                break;
              case 'reasoning':
                reasoning += delta.text;
                host.emit({ type: 'thinking.delta', messageId: thinkingId, text: delta.text });
                break;
              case 'tool-call': {
                let piece = pieces.get(delta.index);
                if (!piece) pieces.set(delta.index, (piece = { id: '', name: '', arguments: '' }));
                if (delta.id) piece.id = delta.id;
                // A name normally arrives once; some servers send it in pieces, others repeat it with every piece.
                if (delta.name && delta.name !== piece.name) piece.name += delta.name;
                if (delta.argumentsDelta) piece.arguments += delta.argumentsDelta;
                break;
              }
              case 'usage':
                usage = delta.usage;
                break;
              case 'finish':
                finishReason = delta.reason;
                break;
            }
          }
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (error instanceof Stopped || error instanceof TimeUp) throw error;
      // Whatever was streamed stays in the transcript: the runtime keeps blocks that were never completed.
      if (usage !== null) this.#usage(model, usage);
      const failure: ProviderFailure = stalled
        ? { code: 'provider_timeout', message: `${record.name} stopped sending its answer.` }
        : describeFailure(error, { name: record.name, model: model.id });
      this.#access.report({ ok: false, ...failure });
      if (failure.code === 'provider_error') {
        const detail = redactSecrets(describeError(error));
        host.log.error({ provider: record.id, err: target.apiKey ? detail.split(target.apiKey).join('[redacted]') : detail }, 'a request to a model provider failed unexpectedly');
      } else {
        host.log.warn({ provider: record.id, code: failure.code }, 'a request to a model provider failed');
      }
      throw new AgentRunError(failure.code, failure.message);
    }

    this.#access.report({ ok: true, code: 'ok', message: `${record.name} answered.` });
    if (reasoning !== '') host.emit({ type: 'thinking', messageId: thinkingId, text: reasoning });
    if (text !== '') host.emit({ type: 'text', messageId: textId, text, model: model.id });
    if (usage !== null) this.#usage(model, usage);

    const calls: RequestedCall[] = [...pieces.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, piece]) => ({ id: piece.id || `call_${this.#blocks}_${index}`, name: piece.name, arguments: piece.arguments }));
    return { text, reasoning, calls, finishReason };
  }

  #usage(model: ProviderModel, usage: TokenUsage): void {
    const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const fresh = usage.inputTokens - cached;
    const prices = model.prices;
    const cost = prices === null ? undefined : (fresh * prices.input + cached * (prices.cachedInput ?? prices.input) + usage.outputTokens * prices.output) / 1_000_000;
    this.#host.emit({
      type: 'usage',
      model: model.id,
      inputTokens: fresh,
      outputTokens: usage.outputTokens,
      cacheReadTokens: cached,
      ...(cost === undefined ? {} : { costUsd: cost }),
      contextTokens: usage.inputTokens + usage.outputTokens,
      // Never guessed: without a figure in the catalogue there is none.
      ...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
    });
  }

  // ---- one tool call ---------------------------------------------------------

  /** Carries out one call the model asked for and returns what the model is told. Never throws for something the model did wrong. */
  async #call(tools: ReadonlyMap<string, ModelTool>, call: RequestedCall): Promise<string> {
    const host = this.#host;
    const toolCallId = `${this.#request.runId}-c${this.#calls}`;
    const name = oneLine(call.name || '(no name)', 80);
    const tool = tools.get(call.name);
    const failed = (kind: ModelTool['kind'], title: string, input: unknown, message: string): string => {
      host.emit({ type: 'tool.started', toolCallId, name, kind, title, input });
      host.emit({ type: 'tool.finished', toolCallId, status: 'error', output: message });
      return `Error: ${message}`;
    };

    let args: unknown;
    try {
      args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    } catch {
      args = undefined;
    }
    if (args === undefined || typeof args !== 'object' || args === null || Array.isArray(args)) {
      // Malformed JSON from the model is the model's mistake: it is told, and the turn goes on.
      return failed(tool?.kind ?? 'other', name, { arguments: clipText(call.arguments, 2000) }, 'The arguments of this call are not a JSON object. Send the call again with valid JSON.');
    }
    if (!tool) return failed('other', name, args, `There is no tool named "${name}".`);

    let prepared: PreparedCall;
    try {
      prepared = await tool.prepare(args);
    } catch (error) {
      return failed(tool.kind, name, args, this.#toolProblem(error, name));
    }
    host.emit({ type: 'tool.started', toolCallId, name, kind: prepared.kind, title: prepared.title, input: prepared.input });

    const finish = (outcome: ToolOutcome): string => {
      host.emit({ type: 'tool.finished', toolCallId, status: outcome.status, output: outcome.text, ...(outcome.diffs ? { diffs: outcome.diffs } : {}) });
      return outcome.text;
    };

    // Nothing with a side effect happens before the Studio has decided (rule 6 of the adapter contract).
    for (let index = 0; index < prepared.permissions.length; index += 1) {
      const ask = prepared.permissions[index]!;
      const decision = await host.requestPermission({ ...ask, toolCallId, input: prepared.input });
      if (decision.behavior === 'deny') {
        const text = `Denied: ${decision.message}`;
        host.emit({ type: 'tool.finished', toolCallId, status: 'denied', output: decision.message });
        this.#checkStopped();
        return `${text} Do not send this call again; continue another way, or tell the user what you would need.`;
      }
      // A person may have changed the input while approving: what runs is what was approved.
      if (!sameJson(decision.updatedInput, prepared.input)) {
        try {
          prepared = await tool.prepare(decision.updatedInput);
        } catch (error) {
          return `Error: ${finish({ status: 'error', text: this.#toolProblem(error, name) })}`;
        }
      }
    }
    this.#checkStopped();

    const current = prepared;
    const io = {
      toolCallId,
      output: (text: string): void => host.emit({ type: 'tool.output', toolCallId, text }),
      notice: (level: 'info' | 'warning', code: string, text: string): void => this.#notice(level, code, text),
    };
    try {
      const outcome = current.waitsForPeople ? await current.run({ ...io, signal: this.#abort.signal }) : await this.#work((signal) => current.run({ ...io, signal }));
      this.#checkStopped();
      return finish(outcome);
    } catch (error) {
      if (error instanceof Stopped || error instanceof TimeUp || this.#abort.signal.aborted) {
        host.emit({ type: 'tool.finished', toolCallId, status: 'error', output: 'Stopped.' });
        throw error instanceof TimeUp ? error : new Stopped();
      }
      return `Error: ${finish({ status: 'error', text: this.#toolProblem(error, name) })}`;
    }
  }

  #toolProblem(error: unknown, name: string): string {
    if (error instanceof ToolRefusal) return error.message;
    // Anything else is a fault of the Studio, not of the model: the detail goes to the log only.
    this.#host.log.error({ tool: name, err: redactSecrets(describeError(error)) }, 'a tool of an API model failed unexpectedly');
    return 'The tool failed unexpectedly.';
  }
}
