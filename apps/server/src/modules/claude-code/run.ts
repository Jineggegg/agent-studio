import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeError } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import { OutputTail } from '../../kernel/output-tail.js';
import { type ProcessSupervisor, credentialPaths, terminate } from '../../kernel/process.js';
import {
  AgentRunError,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  type PromptAttachment,
} from '../agents/adapter.js';
import type { ClaudeCli, CliInstallation } from './cli.js';
import {
  type ExitFacts,
  NOT_INSTALLED_MESSAGE,
  errorFromExit,
  errorFromResult,
  isResumeNotFound,
  presentable,
} from './errors.js';
import {
  PROJECT_INSTRUCTIONS_BYTES,
  PROJECT_INSTRUCTIONS_FILE,
  type ProjectInstructions,
} from './instructions.js';
import {
  INLINE_IMAGE_BYTES,
  attachmentDirs,
  buildArgs,
  buildMcpConfig,
  buildSystemPrompt,
  buildUserMessage,
  historyPreamble,
  isValidModel,
} from './invocation.js';
import {
  type CliResult,
  type LineSignal,
  StreamTranslator,
  type UsageLedger,
} from './translate.js';

/**
 * One turn of Claude Code: the process, what is written to it, and when it is
 * over.
 *
 * ## When a turn is over
 *
 * Not at the first `result`. The CLI prints one `result` per turn *it* runs,
 * and it starts further turns by itself: for a message that was steered in
 * while it was answering, and when a sub-agent it left running in the
 * background reports back. So the run ends when the **process** ends. The
 * adapter closes the CLI's input once a `result` has arrived and nothing it
 * wrote is still unread; the CLI then finishes what it has in hand and exits,
 * exactly as it does for `claude -p` with a piped prompt.
 *
 * ## Stopping
 *
 * First the gentle way: an `interrupt` control request on the CLI's input,
 * which makes it stop the model request, record the interruption in its own
 * conversation and print a `result`. Then its input is closed, and if the
 * process has not gone shortly after, its whole process group is terminated
 * and then killed. Text streamed up to that moment stays with the runtime.
 */

type Child = ReturnType<ProcessSupervisor['spawn']>;

/** For tests and the manual smoke test: sees what goes to and comes from the CLI. Never set in production. */
export type Tap = (entry: {
  readonly runId: string;
  readonly stream: 'argv' | 'stdin' | 'stdout' | 'stderr';
  readonly text: string;
}) => void;

export interface ClaudeRunDeps {
  readonly context: ModuleContext;
  readonly cli: ClaudeCli;
  readonly request: AgentRunRequest;
  readonly host: AgentRunHost;
  /** The shared-memory conventions to append to the CLI's system prompt, or null. */
  readonly memoryGuide: () => string | null;
  /** The project's own instruction file, when the project has one and hands it to agents. */
  readonly projectInstructions: () => Promise<ProjectInstructions>;
  /**
   * Whether the user should be told about a problem with that file: true the
   * first time a session meets it, false while it stays the same. Null: there is no problem.
   */
  readonly instructionsProblemIsNews: (problem: string | null) => boolean;
  readonly onRateLimit: (info: Record<string, unknown>) => void;
  /** Remembers what each conversation had used, across runs. */
  readonly ledger?: UsageLedger | undefined;
  readonly tap?: Tap | undefined;
}

type AttemptOutcome =
  | { readonly kind: 'finished'; readonly result: AgentRunResult }
  | { readonly kind: 'resume-not-found' };

/** How long the CLI gets to answer an interrupt before its process group is signalled. */
const INTERRUPT_GRACE_MS = 1500;
/** How long it gets to exit once it has printed the result of the interrupted turn. */
const EXIT_GRACE_MS = 1000;
/** How long the process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 1200;
/** A steered message the CLI has not taken this long after a turn ended is no longer waited for. */
const STEER_IDLE_MS = 15_000;
const STDERR_CHARS = 16_384;
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const NATIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class ClaudeRun {
  readonly done: Promise<AgentRunResult>;

  readonly #deps: ClaudeRunDeps;
  #translator: StreamTranslator | null = null;
  #installation: CliInstallation | null = null;
  #child: Child | null = null;
  #inputOpen = false;
  #stopping = false;
  /** Folders the running CLI may read attachments from. */
  #readableDirs = new Set<string>();
  /** Steered messages the CLI has not echoed yet, oldest first. */
  #pendingSteers: Array<Record<string, unknown>> = [];
  #replays = 0;
  #killTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  /** What this turn appends to the CLI's system prompt. */
  #systemPrompt: string | null = null;

  constructor(deps: ClaudeRunDeps) {
    this.#deps = deps;
    const onAbort = (): void => this.cancel();
    deps.request.signal.addEventListener('abort', onAbort, { once: true });
    this.done = this.#main().finally(() => {
      deps.request.signal.removeEventListener('abort', onAbort);
      this.#clearTimers();
    });
    if (deps.request.signal.aborted) this.cancel();
  }

  // ---- what the adapter and the runtime call --------------------------------

  cancel(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (this.#inputOpen) {
      this.#write({
        type: 'control_request',
        request_id: `stop-${this.#deps.request.runId}`,
        request: { subtype: 'interrupt' },
      });
      this.#armKill(INTERRUPT_GRACE_MS);
    } else {
      this.#kill();
    }
  }

  /** Writes a further message to the running CLI. True only when it was written to an input the CLI still reads. */
  async steer(message: {
    text: string;
    attachments: readonly PromptAttachment[];
  }): Promise<boolean> {
    if (!this.#canSteer()) return false;
    // A file the CLI was not told about when it started cannot be read by it: such a message waits its turn.
    for (const attachment of message.attachments) {
      const inline = attachment.isImage && attachment.size <= INLINE_IMAGE_BYTES;
      if (!inline && !this.#readableDirs.has(path.dirname(attachment.path))) return false;
    }
    const line = await buildUserMessage({ text: message.text, attachments: message.attachments });
    if (!this.#canSteer()) return false;
    this.#pendingSteers.push(line);
    this.#write(line);
    return true;
  }

  /** Makes sure a tool call is in the transcript before its permission prompt is put to anyone. */
  async ensureToolStarted(toolCallId: string, name: string, input: unknown): Promise<void> {
    const translator = this.#translator;
    if (!translator) return;
    // The line announcing the call normally arrives first; it also says whether a sub-agent made it.
    await translator.waitForTool(toolCallId, 400);
    translator.startTool(toolCallId, name, input);
  }

  markDenied(toolCallId: string): void {
    this.#translator?.markDenied(toolCallId);
  }

  // ---- the turn ---------------------------------------------------------------

  #canSteer(): boolean {
    const child = this.#child;
    return (
      this.#installation?.features.replayUserMessages === true &&
      this.#inputOpen &&
      !this.#stopping &&
      child !== null &&
      child.exitCode === null &&
      child.signalCode === null
    );
  }

  async #main(): Promise<AgentRunResult> {
    const { request, host, cli } = this.#deps;
    if (this.#stopping) return { status: 'completed' };
    if (request.cwd === null)
      throw new AgentRunError(
        'no_project',
        'Claude Code works inside a project folder, and this conversation has none.',
      );
    if (request.model !== null && !isValidModel(request.model)) {
      throw new AgentRunError(
        'model_unavailable',
        `"${presentable(request.model, 80)}" is not a model name Claude Code can be given. Choose another model.`,
      );
    }
    const pending = cli.installation();
    if (!pending) throw new AgentRunError('not_installed', NOT_INSTALLED_MESSAGE);
    const installation = await pending;
    this.#installation = installation;
    if (installation.features.missing.length > 0) {
      throw new AgentRunError(
        'cli_incompatible',
        `The installed Claude Code${installation.version ? ` (${installation.version})` : ''} is too old for the Studio. Update Claude Code and try again.`,
      );
    }
    if (request.effort !== null && !installation.features.efforts.includes(request.effort)) {
      host.emit({
        type: 'notice',
        level: 'info',
        code: 'effort_ignored',
        text: `This Claude Code does not have an effort level "${presentable(request.effort, 40)}", so its default was used.`,
      });
    }

    this.#systemPrompt = await this.#standingInstructions();
    if (this.#stopping) return { status: 'completed' };

    const resume =
      request.nativeSessionId !== null && NATIVE_ID_PATTERN.test(request.nativeSessionId)
        ? request.nativeSessionId
        : null;
    let outcome = await this.#attempt(
      installation,
      resume,
      resume === null ? historyPreamble(request.history) : '',
    );
    if (outcome.kind === 'resume-not-found') {
      host.emit({
        type: 'notice',
        level: 'warning',
        code: 'conversation_restarted',
        text: 'Claude Code no longer has its own record of this conversation, so it started a new one. The recent messages were passed along as context; details from earlier tool calls may be missing.',
      });
      outcome = await this.#attempt(installation, null, historyPreamble(request.history));
    }
    if (outcome.kind === 'resume-not-found')
      throw new AgentRunError(
        'agent_error',
        'Claude Code could not open a conversation for this session.',
      );
    return outcome.result;
  }

  /** The memory conventions and the project's `CLAUDE.md`; says so in the transcript when the file could not be used whole. */
  async #standingInstructions(): Promise<string | null> {
    const { host } = this.#deps;
    let instructions: ProjectInstructions;
    try {
      instructions = await this.#deps.projectInstructions();
    } catch (error) {
      host.log.warn(
        { err: presentable(describeError(error), 200) },
        "reading the project's instruction file failed",
      );
      instructions = { kind: 'unreadable', reason: 'it could not be read' };
    }
    const kib = Math.round(PROJECT_INSTRUCTIONS_BYTES / 1024);
    const problem =
      instructions.kind === 'unreadable'
        ? {
            code: 'project_instructions_unreadable',
            text: `${PROJECT_INSTRUCTIONS_FILE} in the project folder was not given to Claude Code: ${instructions.reason}.`,
          }
        : instructions.kind === 'loaded' && instructions.truncated
          ? {
              code: 'project_instructions_truncated',
              text: `${PROJECT_INSTRUCTIONS_FILE} in the project folder is larger than ${kib} KiB, so Claude Code was given only its first ${kib} KiB.`,
            }
          : null;
    if (
      this.#deps.instructionsProblemIsNews(
        problem === null ? null : `${problem.code}:${problem.text}`,
      ) &&
      problem !== null
    ) {
      host.emit({ type: 'notice', level: 'warning', code: problem.code, text: problem.text });
    }
    return buildSystemPrompt({
      memoryGuide: this.#deps.memoryGuide(),
      projectInstructions:
        instructions.kind === 'loaded'
          ? { text: instructions.text, truncated: instructions.truncated }
          : null,
    });
  }

  async #attempt(
    installation: CliInstallation,
    resume: string | null,
    preamble: string,
  ): Promise<AttemptOutcome> {
    const { context, request, host, cli } = this.#deps;
    if (this.#stopping) return { kind: 'finished', result: { status: 'completed' } };
    const cwd = request.cwd!;
    const translator = new StreamTranslator({
      cwd,
      emit: (event) => host.emit(event),
      log: host.log,
      onRateLimit: this.#deps.onRateLimit,
      resumed: resume !== null,
      ...(this.#deps.ledger ? { ledger: this.#deps.ledger } : {}),
    });
    this.#translator = translator;
    this.#replays = 0;

    const first = await buildUserMessage({
      text: request.prompt.text,
      quote: request.prompt.quote,
      attachments: request.prompt.attachments,
      preamble,
    });
    // The bridge's configuration holds this run's token: it goes into a file only this account can
    // read, never onto the command line, and the file is gone when the CLI is.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-claude-'));
    try {
      const mcpConfigPath = path.join(directory, 'mcp.json');
      await writeFile(mcpConfigPath, buildMcpConfig(request.bridge), { mode: 0o600, flag: 'wx' });
      const folders = attachmentDirs(request.prompt.attachments);
      this.#readableDirs = new Set(folders);
      const args = buildArgs({
        features: installation.features,
        bridge: request.bridge,
        mcpConfigPath,
        permissionMode: request.permissionMode,
        model: request.model,
        effort: request.effort,
        fastMode: request.fastMode ?? false,
        resume,
        appendSystemPrompt: this.#systemPrompt,
        addDirs: folders,
      });
      // The credentials of the account the Studio runs as (SSH keys, cloud sign-ins, the GitHub CLI's
      // token, the other agent's sign-in, …) are hidden from the CLI unless the project's owner lets
      // agents use them — all but Claude Code's own configuration, which holds its sign-in. A session
      // outside any project never sees them.
      const projects = context.services.projects;
      const project = request.projectId === null ? null : projects.find(request.projectId);
      const credentialsVisible =
        project !== null && projects.isFeatureEnabled(project, 'agentCredentials');
      const home = os.homedir();
      const ownConfiguration = new Set(
        request.accountDirectory
          ? []
          : [path.join(home, '.claude'), path.join(home, '.claude.json')],
      );
      // Attachments live in the Studio's data directory, which the sandbox hides: let exactly these back in.
      const wrapped = context.sandbox.wrap(installation.executable, args, {
        kind: 'mask',
        hide: credentialsVisible
          ? []
          : credentialPaths(home).filter((location) => !ownConfiguration.has(location)),
        expose: [...folders, ...request.prompt.attachments.map((attachment) => attachment.path)],
        ...(request.accountDirectory ? { writableExpose: [request.accountDirectory] } : {}),
      });
      this.#deps.tap?.({
        runId: request.runId,
        stream: 'argv',
        text: JSON.stringify({ file: wrapped.file, args: wrapped.args }),
      });
      if (this.#stopping) return { kind: 'finished', result: { status: 'completed' } };

      const exit = await this.#drive(wrapped.file, wrapped.args, cwd, translator, [
        first,
        ...this.#pendingSteers,
      ]);
      if (this.#stopping) return { kind: 'finished', result: { status: 'completed' } };

      const result = translator.lastResult;
      if (resume !== null && !translator.producedOutput && isResumeNotFound(result, exit.stderr))
        return { kind: 'resume-not-found' };
      if (result && !result.isError) {
        if (!request.accountDirectory) cli.noteSignIn(true);
        return { kind: 'finished', result: { status: 'completed' } };
      }
      const error = result
        ? errorFromResult(result, translator.apiError, { model: request.model })
        : errorFromExit(exit);
      if (error.code === 'not_signed_in' && !request.accountDirectory) cli.noteSignIn(false);
      // exit.stderr was redacted as a whole before it was cut, so cutting it again leaves no fragment of a secret.
      host.log.warn(
        {
          code: error.code,
          exitCode: exit.code,
          signal: exit.signal,
          stderr: presentable(exit.stderr.slice(-2000), 800),
        },
        'Claude Code did not finish the turn',
      );
      throw error;
    } finally {
      this.#child = null;
      this.#inputOpen = false;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Runs the process to its end. Resolves — never rejects — with how it ended. */
  #drive(
    file: string,
    args: readonly string[],
    cwd: string,
    translator: StreamTranslator,
    messages: ReadonlyArray<Record<string, unknown>>,
  ): Promise<ExitFacts> {
    const { context, request, host, cli, tap } = this.#deps;
    return new Promise<ExitFacts>((resolve) => {
      let child: Child;
      try {
        child = context.processes.spawn(file, args, {
          cwd,
          env: { ...cli.env(), ...request.accountEnvironment },
          stdin: 'pipe',
        });
      } catch (error) {
        resolve({
          code: null,
          signal: null,
          stderr: '',
          strayLine: null,
          spawnError: describeError(error),
        });
        return;
      }
      this.#child = child;
      this.#inputOpen = true;
      const stderr = new OutputTail(STDERR_CHARS);
      let buffer = '';
      let strayLine: string | null = null;
      let ended = false;
      const finish = (facts: Omit<ExitFacts, 'stderr' | 'strayLine'>): void => {
        if (ended) return;
        ended = true;
        this.#inputOpen = false;
        this.#clearTimers();
        resolve({ ...facts, stderr: stderr.text(), strayLine });
      };

      const onLine = (raw: string): void => {
        const line = raw.trim();
        if (line === '') return;
        tap?.({ runId: request.runId, stream: 'stdout', text: line });
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          strayLine ??= line.slice(0, 2000);
          host.log.debug({ chars: line.length }, 'Claude Code printed a line that is not JSON');
          return;
        }
        try {
          this.#react(translator.handle(parsed));
        } catch (error) {
          host.log.warn(
            { err: presentable(describeError(error), 300) },
            'an event from Claude Code could not be translated',
          );
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          onLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
        if (buffer.length > MAX_LINE_CHARS) {
          strayLine ??= 'a line longer than the Studio accepts';
          buffer = '';
        }
        if (this.#idleTimer) this.#armIdle();
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        tap?.({ runId: request.runId, stream: 'stderr', text: chunk });
        stderr.append(chunk);
      });
      child.stdin?.on('error', () => {
        // The CLI closed its input (it exited, or is about to): nothing more can be written.
        this.#inputOpen = false;
      });
      child.once('error', (error) =>
        finish({ code: null, signal: null, spawnError: describeError(error) }),
      );
      child.once('close', (code, signal) => {
        if (buffer.trim() !== '') onLine(buffer);
        finish({ code, signal, spawnError: null });
      });

      for (const message of messages) this.#write(message);
      // Stopped between the decision to start and the start itself.
      if (this.#stopping) this.#kill();
    });
  }

  #react(signal: LineSignal): void {
    switch (signal.kind) {
      case 'replay':
        // Echoes come in the order the messages were written: the first is the prompt, the rest were steered in.
        this.#replays += 1;
        if (this.#replays > 1) this.#pendingSteers.shift();
        return;
      case 'result':
        this.#onResult(signal.result);
        return;
      case 'control_request':
        // Permission prompts go through the bridge. If the CLI asks its host instead, the answer is no:
        // a request the Studio's engine has not seen is never allowed.
        if (signal.requestId === null) return;
        if (signal.subtype === 'can_use_tool') {
          this.#write({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: signal.requestId,
              response: {
                behavior: 'deny',
                message: 'The Studio could not be asked for permission, so this was refused.',
              },
            },
          });
        } else {
          this.#write({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: signal.requestId,
              error: 'The Studio does not answer this kind of request.',
            },
          });
        }
        return;
      default:
        return;
    }
  }

  #onResult(result: CliResult): void {
    if (this.#stopping) {
      this.#endInput();
      this.#armKill(EXIT_GRACE_MS);
      return;
    }
    if (result.isError || this.#pendingSteers.length === 0) {
      this.#endInput();
      return;
    }
    // A steered message is still unread: the CLI takes it as its next turn. Wait for that — but not for ever.
    this.#armIdle();
  }

  #write(message: Record<string, unknown>): void {
    const child = this.#child;
    if (!child?.stdin || !this.#inputOpen) return;
    const line = JSON.stringify(message);
    this.#deps.tap?.({ runId: this.#deps.request.runId, stream: 'stdin', text: line });
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      this.#inputOpen = false;
    }
  }

  #endInput(): void {
    const child = this.#child;
    if (!child?.stdin || !this.#inputOpen) return;
    this.#inputOpen = false;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
  }

  #armKill(afterMs: number): void {
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#killTimer = setTimeout(() => this.#kill(), afterMs);
    this.#killTimer.unref();
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.#endInput();
    }, STEER_IDLE_MS);
    this.#idleTimer.unref();
  }

  #kill(): void {
    const child = this.#child;
    this.#endInput();
    if (child) terminate(child, KILL_GRACE_MS);
  }

  #clearTimers(): void {
    if (this.#killTimer) clearTimeout(this.#killTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#killTimer = null;
    this.#idleTimer = null;
  }
}
