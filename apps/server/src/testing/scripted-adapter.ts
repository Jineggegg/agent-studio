import type { AgentCapabilities, AgentStatus, FileDiff, PermissionMode, ToolKind } from '@agent-studio/protocol';
import type { AgentToolResult } from '../kernel/agent-tools.js';
import type { StudioModule } from '../kernel/module.js';
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentRunHandle,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  AgentRunError,
  type PermissionDecision,
  type PermissionPrompt,
  type PermissionPromptResult,
  type PermissionRequest,
  type UserQuestionAnswer,
  type UserQuestionRequest,
} from '../modules/agents/adapter.js';

/**
 * An agent whose behaviour a test writes down step by step.
 *
 * It is the test double for the agent runtime and, at the same time, the
 * smallest complete example of an {@link AgentAdapter}: read `run()` below to
 * see what a real adapter has to do — start the work, hand back a handle,
 * emit normalised events, ask `host.requestPermission` before anything with a
 * side effect, and settle `done` exactly once, promptly after a cancel.
 *
 * It is never registered by the production module. A test adds it with
 * `scriptedModule(adapter)`:
 *
 *   const agent = new ScriptedAdapter();
 *   const t = await createTestStudio({ modules: [...modules, scriptedModule(agent)] });
 *   agent.script([{ text: 'Hello' }, { gate: 'go' }, { text: 'Done' }]);
 *   …send a message…
 *   await agent.reached('go');   // the run is now waiting at the gate
 *   agent.open('go');            // let it finish
 */

export type ScriptStep =
  /** Emits one event exactly as given. */
  | { readonly emit: AgentEvent }
  /** Prose: streamed as `chunks` deltas, then completed — or left unfinished with `complete: false`. */
  | { readonly text: string; readonly messageId?: string; readonly chunks?: number; readonly complete?: boolean; readonly model?: string }
  | { readonly thinking: string; readonly messageId?: string }
  /** A tool call from start to finish, with no permission asked. */
  | {
      readonly tool: {
        readonly id: string;
        readonly name: string;
        readonly kind: ToolKind;
        readonly title?: string;
        readonly input?: unknown;
        readonly outputChunks?: readonly string[];
        readonly output?: string;
        readonly status?: 'ok' | 'error' | 'denied';
        readonly diffs?: readonly FileDiff[];
      };
    }
  /** Asks for permission and waits. The decision is recorded in `run.decisions`; a tool row is emitted around it. */
  | { readonly permission: PermissionRequest }
  /** Puts questions to the user and waits. The answer is recorded in `run.answers`. */
  | { readonly ask: UserQuestionRequest }
  /** Calls one of the Studio's own tools, as an API-model adapter would. The result is recorded in `run.toolResults`. */
  | { readonly studioTool: { readonly name: string; readonly input: unknown } }
  /** Waits until the test calls `adapter.open(name)`. */
  | { readonly gate: string }
  /** Waits for a steered message and echoes it as prose. */
  | { readonly awaitSteer: true }
  /** Never finishes by itself: runs until it is cancelled. */
  | { readonly hang: true }
  /** Ends the run as failed, with a message fit for the user. */
  | { readonly fail: { readonly code: string; readonly message: string } }
  /** Ends the run by throwing something unexpected (a bug in the adapter). */
  | { readonly crash: string }
  | { readonly sleep: number }
  /** Anything else. */
  | { readonly do: (run: ScriptedRun) => void | Promise<void> };

export interface ScriptedRun {
  readonly request: AgentRunRequest;
  readonly host: AgentRunHost;
  readonly decisions: PermissionDecision[];
  readonly answers: UserQuestionAnswer[];
  readonly toolResults: AgentToolResult[];
  /** Messages steered into this run, in order. */
  readonly steered: string[];
  /** Permission prompts that arrived through the bridge. */
  readonly prompts: PermissionPrompt[];
  cancelled: boolean;
  finished: boolean;
}

export interface ScriptedAdapterOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly kind?: 'cli' | 'api';
  /** Whether a message can be injected into a running turn. Default true. */
  readonly steering?: boolean;
  readonly permissionModes?: readonly PermissionMode[];
  /** Simulates an agent that does not react to being cancelled. */
  readonly ignoreCancel?: boolean;
  /** Reports this as the agent's own conversation id at the start of every run. */
  readonly nativeSessionId?: string;
}

class Cancelled extends Error {}

interface Gate {
  open: boolean;
  readonly waiting: Array<() => void>;
  readonly arrivals: Array<() => void>;
  arrived: number;
}

export class ScriptedAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'cli' | 'api';
  /** Every run this adapter was asked to do, oldest first. */
  readonly runs: ScriptedRun[] = [];
  /** How many times the agent's own transcript was asked to be removed. */
  readonly deletedNativeSessions: string[] = [];
  /** Set to false to make `steer` report that the turn could not take the message. */
  acceptSteer = true;
  /** What `status()` reports. */
  currentStatus: AgentStatus = { installed: true, version: '1.0.0-scripted', signedIn: true, account: 'scripted@example.test', problem: null };

  readonly #options: ScriptedAdapterOptions;
  readonly #queue: Array<readonly ScriptStep[]> = [];
  readonly #gates = new Map<string, Gate>();
  #fallback: (request: AgentRunRequest) => readonly ScriptStep[] = () => [{ text: 'ok' }];

  constructor(options: ScriptedAdapterOptions = {}) {
    this.#options = options;
    this.id = options.id ?? 'scripted';
    this.displayName = options.displayName ?? 'Scripted agent';
    this.kind = options.kind ?? 'cli';
  }

  // ---- what a test controls --------------------------------------------------

  /** The script of the next run that has none yet. Call again to line up further runs. */
  script(steps: readonly ScriptStep[]): this {
    this.#queue.push(steps);
    return this;
  }

  /** The script of every run that was not given one with `script`. */
  otherwise(make: (request: AgentRunRequest) => readonly ScriptStep[]): this {
    this.#fallback = make;
    return this;
  }

  #gate(name: string): Gate {
    let gate = this.#gates.get(name);
    if (!gate) this.#gates.set(name, (gate = { open: false, waiting: [], arrivals: [], arrived: 0 }));
    return gate;
  }

  /** Lets runs waiting at a gate continue (and lets later ones straight through). */
  open(name: string): void {
    const gate = this.#gate(name);
    gate.open = true;
    for (const resume of gate.waiting.splice(0)) resume();
  }

  /** Resolves once a run is waiting at the gate. */
  reached(name: string, timeoutMs = 5000): Promise<void> {
    const gate = this.#gate(name);
    if (gate.arrived > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No run reached the gate "${name}" in time.`)), timeoutMs);
      gate.arrivals.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get lastRun(): ScriptedRun {
    const run = this.runs[this.runs.length - 1];
    if (!run) throw new Error('The scripted agent has not been run.');
    return run;
  }

  // ---- the adapter contract --------------------------------------------------

  capabilities(): AgentCapabilities {
    return {
      models: [
        { id: 'scripted-large', label: 'Scripted Large', recommended: true, contextWindow: 200_000, efforts: ['low', 'high'], defaultEffort: 'low' },
        { id: 'scripted-small', label: 'Scripted Small', contextWindow: 100_000 },
      ],
      defaultModel: 'scripted-large',
      permissionModes: [...(this.#options.permissionModes ?? (['plan', 'ask', 'accept-edits', 'auto'] as const))],
      images: true,
      steering: this.#options.steering !== false,
      resume: true,
      planMode: true,
      usage: true,
    };
  }

  status(): AgentStatus {
    return this.currentStatus;
  }

  run(request: AgentRunRequest, host: AgentRunHost): AgentRunHandle {
    const run: ScriptedRun = { request, host, decisions: [], answers: [], toolResults: [], steered: [], prompts: [], cancelled: false, finished: false };
    this.runs.push(run);
    const steps = this.#queue.shift() ?? this.#fallback(request);

    // Everything that waits can be interrupted by a cancel.
    let interrupt: (reason: Cancelled) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = reject;
    });
    interrupted.catch(() => {});
    const steerWaiters: Array<(text: string) => void> = [];
    const cancel = (): void => {
      if (run.cancelled || this.#options.ignoreCancel) return;
      run.cancelled = true;
      interrupt(new Cancelled());
    };
    // Rule 3 of the contract: stop when the signal aborts, as well as when cancel() is called.
    if (request.signal.aborted) cancel();
    else request.signal.addEventListener('abort', cancel, { once: true });

    const waitFor = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interrupted]);

    const play = async (): Promise<AgentRunResult> => {
      if (this.#options.nativeSessionId) host.emit({ type: 'session', nativeSessionId: this.#options.nativeSessionId });
      let counter = 0;
      const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
      for (const step of steps) {
        if (run.cancelled) throw new Cancelled();
        if ('emit' in step) {
          host.emit(step.emit);
        } else if ('text' in step) {
          const messageId = step.messageId ?? nextId('msg');
          const chunks = Math.max(1, step.chunks ?? 1);
          const size = Math.ceil(step.text.length / chunks);
          for (let at = 0; at < step.text.length; at += size) host.emit({ type: 'text.delta', messageId, text: step.text.slice(at, at + size) });
          if (step.complete !== false) host.emit({ type: 'text', messageId, text: step.text, ...(step.model ? { model: step.model } : {}) });
        } else if ('thinking' in step) {
          const messageId = step.messageId ?? nextId('think');
          host.emit({ type: 'thinking.delta', messageId, text: step.thinking });
          host.emit({ type: 'thinking', messageId, text: step.thinking });
        } else if ('tool' in step) {
          const tool = step.tool;
          host.emit({ type: 'tool.started', toolCallId: tool.id, name: tool.name, kind: tool.kind, title: tool.title ?? tool.name, input: tool.input ?? {} });
          for (const chunk of tool.outputChunks ?? []) host.emit({ type: 'tool.output', toolCallId: tool.id, text: chunk });
          host.emit({
            type: 'tool.finished',
            toolCallId: tool.id,
            status: tool.status ?? 'ok',
            output: tool.output ?? (tool.outputChunks ?? []).join(''),
            ...(tool.diffs ? { diffs: tool.diffs } : {}),
          });
        } else if ('permission' in step) {
          const ask = step.permission;
          const toolCallId = ask.toolCallId ?? nextId('call');
          host.emit({ type: 'tool.started', toolCallId, name: ask.toolName, kind: ask.kind, title: ask.title ?? ask.toolName, input: ask.input });
          // Rule 6: nothing with a side effect happens before the Studio has decided.
          const decision = await waitFor(host.requestPermission({ ...ask, toolCallId }));
          run.decisions.push(decision);
          host.emit(
            decision.behavior === 'allow'
              ? { type: 'tool.finished', toolCallId, status: 'ok', output: 'done' }
              : { type: 'tool.finished', toolCallId, status: 'denied', output: decision.message },
          );
        } else if ('ask' in step) {
          run.answers.push(await waitFor(host.askUser(step.ask)));
        } else if ('studioTool' in step) {
          run.toolResults.push(await waitFor(host.studioTools.call(step.studioTool.name, step.studioTool.input)));
        } else if ('gate' in step) {
          const gate = this.#gate(step.gate);
          gate.arrived += 1;
          for (const notify of gate.arrivals.splice(0)) notify();
          if (!gate.open) await waitFor(new Promise<void>((resolve) => gate.waiting.push(resolve)));
        } else if ('awaitSteer' in step) {
          const text = run.steered.length > 0 ? run.steered[run.steered.length - 1]! : await waitFor(new Promise<string>((resolve) => steerWaiters.push(resolve)));
          host.emit({ type: 'text', messageId: nextId('msg'), text: `steered: ${text}` });
        } else if ('hang' in step) {
          await waitFor(new Promise<never>(() => {}));
        } else if ('fail' in step) {
          throw new AgentRunError(step.fail.code, step.fail.message);
        } else if ('crash' in step) {
          throw new Error(step.crash);
        } else if ('sleep' in step) {
          await waitFor(new Promise<void>((resolve) => setTimeout(resolve, step.sleep)));
        } else {
          await waitFor(Promise.resolve(step.do(run)));
        }
      }
      return { status: 'completed' };
    };

    // Rule 2: `done` settles exactly once. A cancel is not a failure — the runtime records the stop.
    const done = play()
      .catch((error: unknown): AgentRunResult => {
        if (error instanceof Cancelled) return { status: 'completed' };
        throw error;
      })
      .finally(() => {
        run.finished = true;
        request.signal.removeEventListener('abort', cancel);
      });

    const handle: AgentRunHandle = { done, cancel };
    if (this.#options.steering !== false) {
      handle.steer = (message) => {
        // A message can only be taken by a turn that is still going.
        if (run.finished || run.cancelled || !this.acceptSteer) return false;
        run.steered.push(message.text);
        for (const resume of steerWaiters.splice(0)) resume(message.text);
        return true;
      };
    }
    return handle;
  }

  /** How a real adapter maps its agent's tools: here, a tool named "Bash" runs a command and "AskUserQuestion" asks. */
  async onPermissionPrompt(prompt: PermissionPrompt, host: AgentRunHost, request: AgentRunRequest): Promise<PermissionPromptResult> {
    this.runs.find((run) => run.request.runId === request.runId)?.prompts.push(prompt);
    const input = (prompt.input ?? {}) as Record<string, unknown>;
    if (prompt.toolName === 'AskUserQuestion') {
      const answer = await host.askUser({ questions: (input.questions ?? []) as UserQuestionRequest['questions'] });
      return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
    }
    const command = typeof input.command === 'string' ? input.command : undefined;
    const decision = await host.requestPermission({
      toolName: prompt.toolName,
      kind: prompt.toolName === 'Bash' ? 'execute' : 'other',
      input: prompt.input,
      ...(prompt.toolCallId === null ? {} : { toolCallId: prompt.toolCallId }),
      ...(command === undefined ? {} : { command }),
    });
    return decision.behavior === 'allow' ? { behavior: 'allow', updatedInput: decision.updatedInput } : { behavior: 'deny', message: decision.message };
  }

  deleteNativeSession(input: { nativeSessionId: string }): Promise<void> {
    this.deletedNativeSessions.push(input.nativeSessionId);
    return Promise.resolve();
  }
}

/** A module that registers scripted agents. For tests only. */
export function scriptedModule(...adapters: ScriptedAdapter[]): StudioModule {
  return {
    name: 'testing.scripted-agents',
    setup(context) {
      for (const adapter of adapters) context.services.agents.registerAdapter(adapter);
    },
  };
}
