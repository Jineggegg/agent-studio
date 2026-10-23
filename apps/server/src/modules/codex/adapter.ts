import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { AgentCapabilities, AgentStatus, Question } from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import type { EventBus } from '../../kernel/events.js';
import { type ProcessSupervisor, terminate } from '../../kernel/process.js';
import {
  type AgentAdapter,
  type AgentRunHandle,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  AgentRunError,
  type HistoryMessage,
  type PermissionDecision,
  type PromptAttachment,
} from '../agents/adapter.js';
import {
  AppServerClient,
  type ProcessEnded,
  ProtocolError,
  RpcError,
  RpcRefusal,
} from './client.js';
import { isThreadNotFound, runFailure, SIGN_IN_HINT, tidy, turnFailure } from './errors.js';
import {
  type CodexLauncher,
  type IsolationLevel,
  appServerArguments,
  savedRuleFiles,
} from './launch.js';
import {
  type AccountRead,
  type CommandDecision,
  type ConfigRead,
  type ThreadResponse,
  type TurnError,
  accountReadSchema,
  commandApprovalSchema,
  configReadSchema,
  elicitationSchema,
  fileChangeApprovalSchema,
  initializeResultSchema,
  notificationSchemas,
  threadResponseSchema,
  turnStartResultSchema,
  userInputRequestSchema,
} from './protocol.js';
import { CLIENT_INFO, type CodexProbe, RULES_PROBLEM } from './status.js';
import {
  type RateLimitInfo,
  TOOL,
  TurnTranslator,
  displayPath,
  patchPaths,
  patchPreview,
  patchTitle,
  unwrapShellCommand,
} from './translate.js';

/**
 * The Codex adapter: one `codex app-server` process per run, spoken to over
 * its standard input and output.
 *
 * ## Who decides what
 *
 * Every thread and turn is started with
 *
 *   approval policy   on-request     Codex asks before leaving its sandbox
 *   reviewer          user           and it asks this client, not an automatic reviewer
 *   sandbox           read-only      and inside the sandbox nothing can be written and there is no network
 *
 * in all four of the Studio's permission modes. So, by itself, Codex can only
 * read. A command that has to change something, reach the network or leave
 * the sandbox, and every file change, arrives here as an approval request and
 * is put to the Studio's permission engine (`host.requestPermission`): the
 * mode then decides what the engine answers — `plan` refuses, `ask` asks a
 * person, `accept-edits` lets edits inside the project through, `auto` lets
 * everything through but the hard-deny list and deny rules. The adapter never
 * answers an approval by itself, never tells Codex to remember one ("allow for
 * the session" is the engine's business, as a rule), and never grants a wider
 * sandbox: a request for more permissions is answered with none, so that the
 * next command still has to ask.
 *
 * What the engine does not see are commands that run *inside* the read-only
 * sandbox. They change nothing; what they can read is therefore decided by
 * the Studio's sandbox, not by the engine (see `launch.ts`): not the Studio's
 * own data directory, and not the credentials of the account the Studio runs
 * as unless the project's owner allows agents to use them. That is also why
 * Codex does not run without that sandbox unless the operator says so.
 */

type Child = ReturnType<ProcessSupervisor['spawn']>;

/** How long Codex gets to answer a request that is not a turn (starting, reading the configuration, opening a thread). */
const CONTROL_TIMEOUT_MS = 60_000;
/** After an interrupt, how long to wait for Codex to say the turn has ended before the process is stopped anyway. */
const INTERRUPT_GRACE_MS = 1200;
/** How long a process gets to exit by itself once its input is closed. */
const EXIT_GRACE_MS = 500;
const KILL_GRACE_MS = 1000;
const STEER_TIMEOUT_MS = 30_000;
/** Earlier conversation handed to a fresh thread: the newest messages, within this many characters. */
const HISTORY_CHARS = 80_000;
const HISTORY_MESSAGE_CHARS = 20_000;

/**
 * What Codex's model is told about working under the Studio, with the memory
 * conventions, as developer instructions of the thread.
 *
 * It is here because the real CLI needs it. Codex tells its model "the sandbox
 * only permits reading files" and how to ask for an escalated command, and
 * with that alone a model (gpt-6-luna at low effort, codex-cli 0.160.0,
 * 2026-10-13) answered "create a file" in words only: no patch, no escalated
 * command — so there was no request for the Studio to decide, and no file.
 * With this text the same model sent the patch and the approval arrived. The
 * tool and parameter names are the CLI's own (`apply_patch`; `exec_command`
 * with `sandbox_permissions` and `justification`).
 */
export const PERMISSIONS_GUIDE = [
  '## Permissions in this session (Cloud Harness)',
  '',
  'This session runs inside Cloud Harness. Your sandbox is read-only on purpose: every change is put to the person you are working for, or to the rules they have set, before it happens. That is not a reason to decline work.',
  '',
  '- To create, edit or delete files, use apply_patch as usual.',
  '- To run a command that writes files, needs the network or otherwise cannot run inside the sandbox, run it with `sandbox_permissions: "require_escalated"` and a short `justification`.',
  '',
  'Each such request is approved or refused for you; do not ask for permission in prose first. If a request is refused, do not look for another way to do the same thing: say what was refused and carry on with what is still possible. When the session is in plan mode every change is refused — then read, search and describe the plan instead.',
].join('\n');

const PINNED = { approvalPolicy: 'on-request', approvalsReviewer: 'user' } as const;
const READ_ONLY_POLICY = { type: 'readOnly', networkAccess: false } as const;

/** Thrown inside a run to unwind it after a stop. Never reaches the runtime. */
class Stopped extends Error {}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Whoever waits handles the rejection; nobody waiting must not crash the server.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

const sameDirectory = (a: string, b: string): boolean => {
  const real = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  return real(a) === real(b);
};

/**
 * Ends an app-server: closing its input is how it is told the connection is
 * over; if that is not enough it is terminated. Whatever it started and left
 * behind in its process group goes with it (inside the Studio's sandbox the
 * process namespace already sees to that).
 */
async function stopProcess(client: AppServerClient, child: Child, atOnce = false): Promise<void> {
  if (!client.ended) {
    client.end();
    const gone = atOnce
      ? false
      : await Promise.race([
          client.exited.then(() => true),
          sleep(EXIT_GRACE_MS).then(() => false),
        ]);
    if (!gone) {
      terminate(child, KILL_GRACE_MS);
      await Promise.race([client.exited, sleep(KILL_GRACE_MS + 500)]);
    }
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* nothing is left of the group */
    }
  }
}

/** An answer of the CLI in the shape this adapter was written for — or a protocol error, never a crash. */
function answerOf<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ProtocolError(`Codex answered ${what} in a shape this adapter does not know.`);
  return parsed.data;
}

/** True when `file` is `directory` or lies beneath it (symbolic links resolved where the paths exist). */
function isInside(directory: string, file: string): boolean {
  const real = (target: string): string => {
    try {
      return realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  const relative = path.relative(real(directory), real(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export interface CodexAdapterOptions {
  readonly launcher: CodexLauncher;
  readonly probe: CodexProbe;
  readonly processes: ProcessSupervisor;
  readonly bus: EventBus;
  readonly log: FastifyBaseLogger;
  /** Whether agents working in this project may see the account's credentials (the project's `agentCredentials` feature). False outside any project. */
  readonly credentialsAllowed: (projectId: string | null) => boolean;
  /** The conventions for the shared memory, when the memory module offers them. */
  readonly standingInstructions: () => string | null;
}

export const CODEX_AGENT_ID = 'codex';

export class CodexAdapter implements AgentAdapter {
  readonly id = CODEX_AGENT_ID;
  readonly displayName = 'Codex';
  readonly kind = 'cli' as const;
  readonly #options: CodexAdapterOptions;
  constructor(options: CodexAdapterOptions) {
    this.#options = options;
  }

  capabilities(): Promise<AgentCapabilities> {
    return this.#options.probe.capabilities();
  }

  status(): Promise<AgentStatus> {
    return this.#options.probe.status();
  }

  run(request: AgentRunRequest, host: AgentRunHost): AgentRunHandle {
    return new CodexRun(this.#options, request, host).start();
  }

  /** Removes Codex's own copy of a conversation. Codex not knowing it any more is not an error. */
  async deleteNativeSession(input: {
    nativeSessionId: string;
    accountEnvironment?: Readonly<Record<string, string>>;
    accountDirectory?: string;
  }): Promise<void> {
    const { launcher, processes, log } = this.#options;
    const command = launcher.command(appServerArguments({ bridge: null, cwd: null }), {
      ...(input.accountEnvironment ? { env: input.accountEnvironment } : {}),
      ...(input.accountDirectory ? { accountDirectory: input.accountDirectory } : {}),
    });
    const child = processes.spawn(command.file, command.args, { env: command.env, stdin: 'pipe' });
    const client = new AppServerClient(
      child,
      {
        notification: () => {},
        request: () => Promise.reject(new RpcRefusal('Nothing is asked on this connection.')),
        failed: () => {},
      },
      log,
    );
    try {
      await client.request(
        'initialize',
        { clientInfo: CLIENT_INFO, capabilities: null },
        { timeoutMs: 15_000 },
      );
      client.notify('initialized');
      await client.request(
        'thread/delete',
        { threadId: input.nativeSessionId },
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      if (!(error instanceof RpcError))
        throw runFailure(error, {
          stderr: client.stderrTail,
          during: 'while removing a conversation',
        });
    } finally {
      await stopProcess(client, child);
    }
  }
}

interface TurnOutcome {
  readonly status: string;
  readonly error: TurnError | null;
}

class CodexRun {
  readonly #options: CodexAdapterOptions;
  readonly #request: AgentRunRequest;
  readonly #host: AgentRunHost;
  readonly #translator: TurnTranslator;
  readonly #stop = deferred<never>();
  readonly #turnDone = deferred<TurnOutcome>();
  /** Turns that ended before their id was known here. */
  readonly #endedTurns = new Map<string, TurnOutcome>();
  /** Refusals already explained to the agent in this run. */
  readonly #explained = new Set<string>();
  #child: Child | null = null;
  #client: AppServerClient | null = null;
  #isolation: IsolationLevel = 'pinned';
  #codexHome = '';
  /** The account's own Codex settings are in force (possible only without the sandbox). */
  #personalSettings = false;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #turnEnded = false;
  #cancelled = false;
  #broken = false;
  #phase = 'while starting';
  /** Earlier conversation to put in front of the prompt, when it could not be given to the thread itself. */
  #preface = '';

  constructor(options: CodexAdapterOptions, request: AgentRunRequest, host: AgentRunHost) {
    this.#options = options;
    this.#request = request;
    this.#host = host;
    this.#translator = new TurnTranslator({
      emit: (event) => host.emit(event),
      log: host.log,
      cwd: request.cwd,
      model: request.model ?? 'codex',
      bridgeName: request.bridge.serverName,
      onRateLimits: (info) => this.#publishRateLimits(info),
    });
  }

  start(): AgentRunHandle {
    const onAbort = (): void => this.#cancel();
    if (this.#request.signal.aborted) this.#cancel();
    else this.#request.signal.addEventListener('abort', onAbort, { once: true });

    const done = this.#main()
      .catch((error: unknown): AgentRunResult => {
        // Rule 3 of the contract: after a stop, whatever happened is not a failure.
        if (this.#cancelled || error instanceof Stopped) return { status: 'completed' };
        const failure = runFailure(error, {
          stderr: this.#client?.stderrTail ?? '',
          during: this.#phase,
        });
        // What the status said may no longer be true: ask the CLI again next time.
        if (failure.code === 'not_signed_in' || failure.code === 'codex_not_isolated')
          this.#options.probe.invalidate();
        throw failure;
      })
      .finally(async () => {
        this.#request.signal.removeEventListener('abort', onAbort);
        await this.#disconnect();
      });
    return {
      done,
      cancel: () => this.#cancel(),
      steer: (message) => this.#steer(message),
    };
  }

  // ---- the run ------------------------------------------------------------------

  async #main(): Promise<AgentRunResult> {
    const request = this.#request;
    if (request.cwd === null)
      throw new AgentRunError(
        'no_project',
        'Codex works inside a project folder, and this session has none.',
      );
    if (!existsSync(request.cwd))
      throw new AgentRunError('project_missing', 'The folder of this project no longer exists.');
    // Without the Studio's sandbox Codex only runs where the operator said so.
    const unavailable = this.#options.launcher.unavailable;
    if (unavailable !== null) throw new AgentRunError('sandbox_required', unavailable);
    if (this.#cancelled) return { status: 'completed' };

    // Connect; if the user's own configuration defines MCP servers, connect again with them switched off.
    let disable: string[] = [];
    for (let attempt = 0; ; attempt += 1) {
      await this.#connect(disable);
      const more = await this.#checkConfiguration();
      if (more.length === 0) break;
      if (attempt > 0) {
        throw new AgentRunError(
          'codex_not_isolated',
          'Codex keeps offering tools from its own configuration that the Studio could not switch off, so the run was not started.',
        );
      }
      disable = more;
      await this.#disconnect();
    }

    await this.#requireSignIn();
    const threadId = await this.#openThread();
    this.#threadId = threadId;
    this.#translator.setMainThread(threadId);
    this.#host.emit({ type: 'session', nativeSessionId: threadId });

    const tierSupported = (await this.#options.probe.capabilities()).fastMode?.supported === true;
    this.#phase = 'while starting the turn';
    const started = answerOf(
      turnStartResultSchema,
      await this.#ask('turn/start', {
        threadId,
        input: this.#input(this.#promptText(), request.prompt.attachments),
        ...PINNED,
        sandboxPolicy: READ_ONLY_POLICY,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(tierSupported ? { serviceTier: request.fastMode ? 'fast' : 'default' } : {}),
      }),
      'turn/start',
    );
    this.#turnId = started.turn.id;
    this.#phase = 'in the middle of the turn';
    const early = this.#endedTurns.get(started.turn.id);
    if (early) this.#turnDone.resolve(early);

    const outcome = await this.#until(this.#turnDone.promise);
    this.#turnEnded = true;
    if (outcome.status === 'failed')
      throw turnFailure(outcome.error ?? this.#translator.lastError, {
        model: this.#translator.model,
      });
    // `interrupted` is a turn that was stopped — by the user, or by an approval that was cancelled with the run.
    return { status: 'completed' };
  }

  /** Starts the process and says hello. */
  async #connect(disableMcpServers: readonly string[]): Promise<void> {
    if (this.#cancelled) throw new Stopped();
    const request = this.#request;
    const { launcher, processes } = this.#options;
    this.#phase = 'while starting';
    const command = launcher.command(
      appServerArguments({ bridge: request.bridge, cwd: request.cwd, disableMcpServers }),
      {
        env: { ...request.bridge.env, ...request.accountEnvironment },
        ...(request.accountDirectory ? { accountDirectory: request.accountDirectory } : {}),
        // Attachments live in the Studio's data directory, which the sandbox hides.
        expose: request.prompt.attachments.map((attachment) => attachment.path),
        // The account's keys and sign-ins stay out of sight unless this project's owner lets agents use them.
        credentials: this.#options.credentialsAllowed(request.projectId),
      },
    );
    this.#isolation = command.isolation;
    this.#codexHome = command.codexHome;
    const child = processes.spawn(command.file, command.args, {
      cwd: request.cwd ?? undefined,
      env: command.env,
      stdin: 'pipe',
    });
    const client = new AppServerClient(
      child,
      {
        notification: (method, params) => this.#onNotification(method, params),
        request: (method, params) => this.#onRequest(method, params),
        failed: (error) => this.#onBroken(client, error),
      },
      this.#host.log,
    );
    this.#child = child;
    this.#client = client;
    this.#broken = false;

    const hello = answerOf(
      initializeResultSchema,
      await this.#ask('initialize', { clientInfo: CLIENT_INFO, capabilities: null }),
      'initialize',
    );
    client.notify('initialized');
    this.#host.log.debug({ isolation: command.isolation }, 'codex: app-server started');
    // What was hidden is the home the Studio worked out; the CLI must be using that one.
    if (!sameDirectory(hello.codexHome, command.codexHome)) {
      throw new AgentRunError(
        'codex_not_isolated',
        'Codex keeps its settings in a different folder than the Studio expected, so the Studio cannot vouch for them. The run was not started.',
      );
    }
  }

  /**
   * Looks at the configuration Codex says is in force and insists on what the
   * Studio needs: no command rules it could not hide, no project `.codex/`
   * layer, no hooks, and no MCP server but the Studio's own. Returns the
   * names of MCP servers that still have to be switched off.
   */
  async #checkConfiguration(): Promise<string[]> {
    const request = this.#request;
    this.#phase = 'while reading its configuration';
    let read: ConfigRead;
    try {
      read = answerOf(
        configReadSchema,
        await this.#ask('config/read', { includeLayers: true, cwd: request.cwd }),
        'config/read',
      );
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      // An app-server that cannot show its configuration: what could be hidden is hidden, and the
      // rules — the one thing that cannot be overridden — are still checked below.
      this.#host.log.warn(
        { err: tidy(error.message, 200) },
        'codex: the effective configuration could not be read',
      );
      read = { config: {}, layers: null };
    }
    const layers = read.layers ?? [];
    const hasKeys = (value: unknown): boolean => Object.keys(record(value)).length > 0;
    const userSettings = layers.some(
      (layer) => layer.name.type === 'user' && hasKeys(layer.config),
    );
    const hidden = this.#isolation === 'hidden' && !userSettings;

    if (!hidden && savedRuleFiles(this.#codexHome).length > 0)
      throw new AgentRunError('codex_not_isolated', RULES_PROBLEM);
    if (
      layers.some(
        (layer) => layer.name.type === 'project' && !layer.disabledReason && hasKeys(layer.config),
      )
    ) {
      throw new AgentRunError(
        'codex_not_isolated',
        "Codex loaded this project's own .codex settings although the Studio marked the project as untrusted, so the run was not started.",
      );
    }
    const features = record(read.config.features);
    if ('hooks' in features && features.hooks !== false) {
      throw new AgentRunError(
        'codex_not_isolated',
        'Codex did not switch its hooks off when the Studio asked, so the run was not started.',
      );
    }
    this.#personalSettings = userSettings;
    return Object.entries(record(read.config.mcp_servers))
      .filter(
        ([name, server]) => name !== request.bridge.serverName && record(server).enabled !== false,
      )
      .map(([name]) => name);
  }

  /** Fails early, and clearly, when nobody is signed in — instead of after Codex's own half minute of retries. */
  async #requireSignIn(): Promise<void> {
    this.#phase = 'while checking the sign-in';
    let read: AccountRead | null;
    try {
      const parsed = accountReadSchema.safeParse(
        await this.#ask('account/read', { refreshToken: false }),
      );
      read = parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof RpcError) return;
      throw error;
    }
    if (read !== null && read.account === null && read.requiresOpenaiAuth === true) {
      throw new AgentRunError('not_signed_in', `Codex is not signed in. ${SIGN_IN_HINT}`);
    }
  }

  /** Reopens the conversation Codex has, or starts one (seeded with what the Studio remembers) when it has none. */
  async #openThread(): Promise<string> {
    const request = this.#request;
    this.#phase = 'while opening the conversation';
    const memory = this.#options.standingInstructions();
    const settings = {
      cwd: request.cwd,
      ...PINNED,
      sandbox: 'read-only',
      ...(request.model ? { model: request.model } : {}),
      // Given to Codex for this thread; nothing is written into the project or into Codex's home.
      developerInstructions: memory ? `${PERMISSIONS_GUIDE}\n\n${memory}` : PERMISSIONS_GUIDE,
    };

    let response: ThreadResponse | null = null;
    if (request.nativeSessionId !== null) {
      try {
        response = answerOf(
          threadResponseSchema,
          await this.#ask('thread/resume', {
            threadId: request.nativeSessionId,
            excludeTurns: true,
            ...settings,
          }),
          'thread/resume',
        );
      } catch (error) {
        if (!isThreadNotFound(error)) throw error;
        this.#host.emit({
          type: 'notice',
          level: 'warning',
          code: 'resume_unavailable',
          text: 'Codex no longer has its copy of this conversation, so it starts a new one and is given the earlier messages from the Studio.',
        });
      }
    }
    if (response === null) {
      response = answerOf(
        threadResponseSchema,
        await this.#ask('thread/start', settings),
        'thread/start',
      );
      await this.#seed(response.thread.id, request.history);
      // A conversation that starts without the Studio's sandbox says so, once, where the person will read it.
      if (this.#isolation !== 'hidden') {
        this.#host.emit({
          type: 'notice',
          level: 'warning',
          code: 'codex_without_sandbox',
          text: `This Studio runs Codex without its sandbox. The commands Codex runs without asking can read any file the Studio's account can read — files outside the project, credentials and the Studio's own data included. Anything that changes something still needs approval.${
            this.#personalSettings
              ? " That account's own Codex settings and instructions also apply here; approvals, the sandbox, MCP servers, hooks and project trust are still set by the Studio."
              : ''
          }`,
        });
      }
    }

    // In the sandbox the account's own instruction files are hidden: Codex must not report having loaded one.
    if (
      this.#isolation === 'hidden' &&
      (response.instructionSources ?? []).some((source) => isInside(this.#codexHome, source))
    ) {
      throw new AgentRunError(
        'codex_not_isolated',
        "Codex loaded the personal instruction file of the account the Studio runs as, which the Studio's sandbox should have hidden. The run was not started.",
      );
    }

    const sandbox = record(response.sandbox);
    if (
      response.approvalPolicy !== PINNED.approvalPolicy ||
      response.approvalsReviewer !== PINNED.approvalsReviewer ||
      sandbox.type !== READ_ONLY_POLICY.type ||
      sandbox.networkAccess === true
    ) {
      throw new AgentRunError(
        'codex_not_isolated',
        'Codex did not take the approval and sandbox settings the Studio asked for, so the run was not started.',
      );
    }
    if (response.model) this.#translator.model = response.model;
    return response.thread.id;
  }

  /** Gives a fresh thread the earlier conversation, as conversation; as a preface to the prompt if Codex will not take it. */
  async #seed(threadId: string, history: readonly HistoryMessage[]): Promise<void> {
    const kept: HistoryMessage[] = [];
    let budget = HISTORY_CHARS;
    for (let at = history.length - 1; at >= 0 && budget > 0; at -= 1) {
      const message = history[at]!;
      const text =
        message.text.length > HISTORY_MESSAGE_CHARS
          ? `${message.text.slice(0, HISTORY_MESSAGE_CHARS)}…`
          : message.text;
      if (text.trim() === '') continue;
      budget -= text.length;
      kept.unshift({ role: message.role, text });
    }
    if (kept.length === 0) return;
    try {
      await this.#ask('thread/inject_items', {
        threadId,
        items: kept.map((message) => ({
          type: 'message',
          role: message.role,
          content: [
            { type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text },
          ],
        })),
      });
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      this.#preface = `Earlier in this conversation:\n\n${kept.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n\n')}\n\nThe new message:\n\n`;
    }
  }

  #promptText(): string {
    const { text, quote } = this.#request.prompt;
    const quoted =
      quote && quote.trim() !== ''
        ? `${quote
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}\n\n`
        : '';
    return `${this.#preface}${quoted}${text}`;
  }

  /** A message as Codex takes it: the text, images as images, other files named by path. */
  #input(text: string, attachments: readonly PromptAttachment[]): unknown[] {
    const files = attachments.filter((attachment) => !attachment.isImage);
    const listed =
      files.length === 0
        ? ''
        : `\n\nAttached files (read them at these paths):\n${files.map((file) => `- ${file.name}: ${file.path}`).join('\n')}`;
    const body = `${text}${listed}`;
    return [
      ...(body.trim() === '' ? [] : [{ type: 'text', text: body, text_elements: [] }]),
      ...attachments
        .filter((attachment) => attachment.isImage)
        .map((attachment) => ({ type: 'localImage', path: attachment.path })),
    ];
  }

  // ---- talking to the process -----------------------------------------------------

  /** Waits for something, unless the run is stopped first. */
  #until<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.#stop.promise]);
  }

  #ask(method: string, params: unknown): Promise<unknown> {
    const client = this.#client;
    if (!client) return Promise.reject(new Stopped());
    return this.#until(client.request(method, params, { timeoutMs: CONTROL_TIMEOUT_MS }));
  }

  #onBroken(client: AppServerClient, error: ProcessEnded | ProtocolError): void {
    if (client !== this.#client) return;
    this.#broken = true;
    this.#turnDone.reject(error);
  }

  #onNotification(method: string, params: unknown): void {
    if (method === 'turn/completed') {
      const parsed = notificationSchemas['turn/completed'].safeParse(params);
      // Only the turn this run started ends the run; a sub-agent's turns end on their own threads.
      if (parsed.success && (this.#threadId === null || parsed.data.threadId === this.#threadId)) {
        const outcome: TurnOutcome = {
          status: parsed.data.turn.status,
          error: parsed.data.turn.error ?? null,
        };
        if (this.#turnId === null) this.#endedTurns.set(parsed.data.turn.id, outcome);
        else if (parsed.data.turn.id === this.#turnId) this.#turnDone.resolve(outcome);
      }
      return;
    }
    this.#translator.notification(method, params);
  }

  async #disconnect(): Promise<void> {
    const client = this.#client;
    const child = this.#child;
    this.#client = null;
    this.#child = null;
    if (!client || !child) return;
    await stopProcess(client, child, this.#broken);
  }

  // ---- stopping and steering --------------------------------------------------------

  #cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    const client = this.#client;
    if (
      client &&
      this.#threadId !== null &&
      this.#turnId !== null &&
      !this.#turnEnded &&
      !this.#broken
    ) {
      // Ask Codex to stop the turn, so that it records the turn as interrupted; then stop the process regardless.
      client
        .request('turn/interrupt', { threadId: this.#threadId, turnId: this.#turnId })
        .catch(() => {});
      setTimeout(() => this.#stop.reject(new Stopped()), INTERRUPT_GRACE_MS).unref();
      return;
    }
    this.#stop.reject(new Stopped());
  }

  async #steer(message: {
    text: string;
    attachments: readonly PromptAttachment[];
  }): Promise<boolean> {
    const client = this.#client;
    if (
      !client ||
      this.#cancelled ||
      this.#broken ||
      this.#turnEnded ||
      this.#threadId === null ||
      this.#turnId === null
    )
      return false;
    // Files that arrive now were not made visible to this process when it started; they go with the next turn.
    if (message.attachments.length > 0) return false;
    const input = this.#input(message.text, []);
    if (input.length === 0) return false;
    try {
      await client.request(
        'turn/steer',
        { threadId: this.#threadId, expectedTurnId: this.#turnId, input },
        { timeoutMs: STEER_TIMEOUT_MS },
      );
      return true;
    } catch {
      // "no active turn to steer", a turn that cannot take input, or a process that has gone.
      return false;
    }
  }

  // ---- requests from Codex ----------------------------------------------------------

  #onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.#commandApproval(params);
      case 'item/fileChange/requestApproval':
        return this.#fileChangeApproval(params);
      case 'mcpServer/elicitation/request':
        return this.#elicitation(params);
      case 'item/tool/requestUserInput':
        return this.#userInput(params);
      case 'item/permissions/requestApproval':
        // A wider sandbox for the rest of the turn would let later commands run unasked: grant nothing.
        this.#host.log.debug('codex: a request for wider permissions was answered with none');
        return Promise.resolve({ permissions: {}, scope: 'turn' });
      default:
        // Token refresh, attestation, client-side tools, the old approval calls: not something this client does.
        this.#host.log.debug(
          { method },
          'codex: a request this adapter does not serve was refused',
        );
        return Promise.reject(new RpcRefusal(`This client does not handle ${method}.`));
    }
  }

  /** The answer for Codex, and what to remember and say when it is a refusal. */
  #verdict(
    decision: PermissionDecision,
    itemId: string | null,
    what: string,
    threadId: string | undefined,
  ): CommandDecision {
    if (decision.behavior === 'allow') return 'accept';
    // The run is being stopped: end the turn rather than let the agent try something else.
    if (decision.source === 'cancelled') return 'cancel';
    if (itemId !== null) this.#translator.noteDenial(itemId, decision.message);
    this.#explain(what, decision.message, threadId);
    return 'decline';
  }

  /**
   * Codex tells its model only "rejected by user". The reason — plan mode, a
   * rule, the person's note — is put into the turn as a message, once per
   * distinct reason, so that the agent can act on it.
   */
  #explain(what: string, reason: string, threadId: string | undefined): void {
    const client = this.#client;
    if (
      !client ||
      this.#cancelled ||
      this.#threadId === null ||
      this.#turnId === null ||
      this.#turnEnded
    )
      return;
    if (threadId !== undefined && threadId !== this.#threadId) return;
    if (this.#explained.has(reason)) return;
    this.#explained.add(reason);
    const text = `[Cloud Harness] ${what} was not allowed. ${reason}`;
    client
      .request(
        'turn/steer',
        {
          threadId: this.#threadId,
          expectedTurnId: this.#turnId,
          input: [{ type: 'text', text, text_elements: [] }],
        },
        { timeoutMs: STEER_TIMEOUT_MS },
      )
      .catch(() => {});
  }

  async #commandApproval(raw: unknown): Promise<{ decision: CommandDecision }> {
    const parsed = commandApprovalSchema.safeParse(raw);
    // What cannot be read cannot be judged.
    if (!parsed.success) return { decision: 'decline' };
    const ask = parsed.data;
    const reason = ask.reason && ask.reason.trim() !== '' ? ask.reason : null;

    const network = ask.networkApprovalContext;
    if (network) {
      const decision = await this.#host.requestPermission({
        toolCallId: ask.itemId,
        toolName: 'network_access',
        kind: 'fetch',
        title: `Connect to ${network.host}`,
        url: `${network.protocol}://${network.host}`,
        input: { host: network.host, protocol: network.protocol, ...(reason ? { reason } : {}) },
      });
      return {
        decision: this.#verdict(
          decision,
          ask.itemId,
          `The connection to ${network.host}`,
          ask.threadId,
        ),
      };
    }

    const reported = ask.command ?? null;
    const script =
      reported !== null
        ? unwrapShellCommand(reported)
        : (this.#translator.commandOf(ask.itemId) ?? null);
    const cwd = ask.cwd ?? null;
    // A command that runs somewhere else is judged as running there.
    const elsewhere =
      cwd !== null &&
      this.#request.cwd !== null &&
      path.resolve(cwd) !== path.resolve(this.#request.cwd);
    const command =
      script === null ? undefined : elsewhere ? `cd ${shellQuote(cwd)} && ${script}` : script;
    const stdin = ask.kind === 'writeStdin';
    const decision = await this.#host.requestPermission({
      toolCallId: ask.itemId,
      toolName: TOOL.shell,
      kind: 'execute',
      title: script === null ? 'Run a command' : stdin ? `Send input to: ${script}` : script,
      ...(command === undefined ? {} : { command }),
      input: {
        ...(script === null ? {} : { command: script }),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        ...(stdin ? { stdin: true } : {}),
      },
    });
    return {
      decision: this.#verdict(
        decision,
        ask.itemId,
        script === null
          ? 'That command'
          : `The command \`${script.length > 200 ? `${script.slice(0, 199)}…` : script}\``,
        ask.threadId,
      ),
    };
  }

  async #fileChangeApproval(raw: unknown): Promise<{ decision: CommandDecision }> {
    const parsed = fileChangeApprovalSchema.safeParse(raw);
    if (!parsed.success) return { decision: 'decline' };
    const ask = parsed.data;
    // Codex announces the patch as an item first; the request only names it. A patch that was never
    // announced has no files to show, and the engine does not let an edit without a target through.
    const changes = this.#translator.changesOf(ask.itemId) ?? [];
    const cwd = this.#request.cwd;
    const decision = await this.#host.requestPermission({
      toolCallId: ask.itemId,
      toolName: TOOL.patch,
      kind: 'edit',
      title: patchTitle(changes, cwd),
      paths: patchPaths(changes),
      ...(changes.length > 0 ? { diff: patchPreview(changes, cwd) } : {}),
      input: {
        changes: changes.map((change) => ({
          path: displayPath(change.path, cwd),
          kind: change.kind.type,
        })),
        ...(ask.reason ? { reason: ask.reason } : {}),
        ...(ask.grantRoot ? { grantRoot: ask.grantRoot } : {}),
      },
    });
    // Never "for the session", whatever Codex proposes: the next change is asked about again.
    return { decision: this.#verdict(decision, ask.itemId, 'That file change', ask.threadId) };
  }

  async #elicitation(
    raw: unknown,
  ): Promise<{ action: 'accept' | 'decline' | 'cancel'; content: null; _meta: null }> {
    const answer = (action: 'accept' | 'decline' | 'cancel') => ({
      action,
      content: null,
      _meta: null,
    });
    const parsed = elicitationSchema.safeParse(raw);
    if (!parsed.success) return answer('decline');
    const ask = parsed.data;
    // A server asking the user to fill in a form: the Studio has no way to show one.
    if (ask._meta?.codex_approval_kind !== 'mcp_tool_call') return answer('decline');
    // The Studio's own tools are decided by the Studio's engine when the bridge calls back.
    if (ask.serverName === this.#request.bridge.serverName) return answer('accept');

    const call = this.#translator.pendingMcpCall(ask.serverName);
    const tool = call?.tool ?? 'tool';
    const decision = await this.#host.requestPermission({
      ...(call ? { toolCallId: call.itemId } : {}),
      toolName: `mcp__${ask.serverName}__${tool}`,
      kind: 'other',
      title: ask.message.trim() !== '' ? ask.message : `Use ${tool} of ${ask.serverName}`,
      input: ask._meta.tool_params ?? {},
    });
    const verdict = this.#verdict(
      decision,
      call?.itemId ?? null,
      `The tool ${tool} of ${ask.serverName}`,
      ask.threadId,
    );
    return answer(verdict);
  }

  /** Codex's own "ask the user" tool: the questions go to the person, the chosen labels come back. */
  async #userInput(raw: unknown): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const parsed = userInputRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.questions.length === 0) return { answers: {} };
    const questions: Question[] = parsed.data.questions.map((question) => ({
      id: question.id,
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
        // Codex's convention: the recommended option says so in its label.
        ...(/\(recommended\)/i.test(option.label) ? { recommended: true } : {}),
      })),
      multiSelect: false,
    }));
    const reply = await this.#host.askUser({
      ...(parsed.data.itemId ? { toolCallId: parsed.data.itemId } : {}),
      questions,
    });
    const answers: Record<string, { answers: string[] }> = {};
    for (const answer of reply.answers) {
      const chosen = [
        ...answer.selected,
        ...(answer.other && answer.other.trim() !== '' ? [answer.other] : []),
      ];
      if (chosen.length > 0) answers[answer.questionId] = { answers: chosen };
    }
    return { answers };
  }

  #publishRateLimits(info: RateLimitInfo): void {
    this.#options.bus.publish('internal:usage', 'rate-limit.observed', {
      agentId: CODEX_AGENT_ID,
      userId: this.#request.userId,
      observedAt: Date.now(),
      info,
    });
  }
}
