import type { AgentCapabilities, AgentModelOption, AgentStatus } from '@agent-studio/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { type ProcessSupervisor, terminate } from '../../kernel/process.js';
import { AppServerClient, RpcRefusal } from './client.js';
import { SIGN_IN_HINT, stderrSummary, tidy } from './errors.js';
import { type CodexLauncher, appServerArguments, savedRuleFiles } from './launch.js';
import { type AccountRead, type CodexModel, accountReadSchema, modelListSchema, modelSchema } from './protocol.js';

/**
 * What the Studio knows about the installed Codex CLI without running a turn:
 * whether it is there, which version, whether it is signed in and as whom, and
 * which models it offers. All of it is asked of the CLI itself —
 * `codex --version`, `codex login status`, and the app-server's
 * `account/read` and `model/list` — and none of it by reading the CLI's files.
 */

const VERSION_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 20_000;
/**
 * How long an answer is reused: every question to the CLI is a process of some
 * hundred megabytes for a second or so, and the status is asked for often. A
 * "not ready" answer is kept only briefly, so that signing in shows up quickly.
 */
const STATUS_TTL_MS = 60_000;
const STATUS_PROBLEM_TTL_MS = 5_000;
const CATALOGUE_TTL_MS = 10 * 60_000;
/** After the account and model list could not be read, how long before the CLI is asked again. */
const CATALOGUE_RETRY_MS = 30_000;

export const CLIENT_INFO = { name: 'agent-studio', title: 'Agent Cloud Studio', version: '2.0.0' } as const;

/** The modes the adapter supports: all of them, because every one is decided by the Studio's engine. */
const PERMISSION_MODES: AgentCapabilities['permissionModes'] = ['plan', 'ask', 'accept-edits', 'auto'];

export interface Catalogue {
  readonly models: AgentModelOption[];
  readonly defaultModel: string | null;
  readonly images: boolean;
}

interface Cached<T> {
  readonly value: T;
  readonly until: number;
}

export function accountLabel(read: AccountRead): string | null {
  const account = read.account;
  if (!account) return null;
  if (account.type === 'chatgpt') return account.email ?? 'ChatGPT account';
  if (account.type === 'apiKey') return 'API key';
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock';
  return account.type;
}

export function modelOption(model: CodexModel): AgentModelOption {
  const efforts = (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort).filter((effort) => effort !== '');
  return {
    id: model.model,
    label: model.displayName && model.displayName.trim() !== '' ? model.displayName : model.model,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { recommended: true } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(model.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort) ? { defaultEffort: model.defaultReasoningEffort } : {}),
  };
}

export class CodexProbe {
  readonly #launcher: CodexLauncher;
  readonly #processes: ProcessSupervisor;
  readonly #log: FastifyBaseLogger;
  #status: Cached<AgentStatus> | null = null;
  #statusInFlight: Promise<AgentStatus> | null = null;
  #catalogue: Cached<Catalogue> | null = null;
  #catalogueInFlight: Promise<Catalogue | null> | null = null;
  #catalogueRetryAt = 0;
  #account: string | null = null;

  constructor(input: { launcher: CodexLauncher; processes: ProcessSupervisor; log: FastifyBaseLogger }) {
    this.#launcher = input.launcher;
    this.#processes = input.processes;
    this.#log = input.log;
  }

  /** Forget what was learned: the next question asks the CLI again (after a run found it signed out, say). */
  invalidate(): void {
    this.#status = null;
    this.#account = null;
    this.#catalogueRetryAt = 0;
    // The list stays on offer until it has been read again.
    if (this.#catalogue) this.#catalogue = { value: this.#catalogue.value, until: 0 };
  }

  status(): Promise<AgentStatus> {
    if (this.#status && this.#status.until > Date.now()) return Promise.resolve(this.#status.value);
    this.#statusInFlight ??= this.#readStatus()
      .then((value) => {
        this.#status = { value, until: Date.now() + (value.problem === null ? STATUS_TTL_MS : STATUS_PROBLEM_TTL_MS) };
        return value;
      })
      .finally(() => {
        this.#statusInFlight = null;
      });
    return this.#statusInFlight;
  }

  async capabilities(): Promise<AgentCapabilities> {
    let catalogue = this.#catalogue?.value ?? null;
    // Where Codex may not run, nothing is started to ask it for its models.
    if (this.#launcher.unavailable !== null) {
      /* keep what is known, ask nothing */
    } else if (!this.#catalogue) {
      if (Date.now() >= this.#catalogueRetryAt) catalogue = await this.#refreshCatalogue();
    }
    // A stale list is still shown; it is refreshed for the next question.
    else if (this.#catalogue.until <= Date.now()) void this.#refreshCatalogue();
    return {
      // The list is whatever this CLI version offers today. When it cannot be read there is no list:
      // the session then runs with the CLI's own default, and a model name can still be typed in.
      models: catalogue?.models ?? [],
      defaultModel: catalogue?.defaultModel ?? null,
      permissionModes: [...PERMISSION_MODES],
      images: catalogue?.images ?? true,
      steering: true,
      resume: true,
      planMode: true,
      usage: true,
    };
  }

  // ---- status -------------------------------------------------------------------

  async #readStatus(): Promise<AgentStatus> {
    const version = await this.#version();
    if (!version.installed) {
      return {
        installed: false,
        version: null,
        signedIn: false,
        account: null,
        problem: 'The Codex command-line tool is not installed for the account this Studio runs as. Install it (`npm install -g @openai/codex`), then sign in.',
      };
    }
    const login = await this.#login();
    if (login.signedIn !== true) {
      return {
        installed: true,
        version: version.version,
        signedIn: false,
        account: null,
        problem:
          login.signedIn === false
            ? `Codex is not signed in. ${SIGN_IN_HINT}`
            : `The Studio could not find out whether Codex is signed in${login.detail ? ` (${login.detail})` : ''}. ${SIGN_IN_HINT}`,
      };
    }
    // An agent that may not run here needs no account label and no model list.
    if (this.#launcher.unavailable !== null) {
      return { installed: true, version: version.version, signedIn: true, account: null, problem: this.#launcher.unavailable };
    }
    // Who is signed in comes with the model list; neither is needed to call the agent usable, and
    // neither is asked for again while what is known is fresh.
    const stale = !this.#catalogue || this.#catalogue.until <= Date.now();
    if ((stale || this.#account === null) && Date.now() >= this.#catalogueRetryAt) await this.#refreshCatalogue();
    return { installed: true, version: version.version, signedIn: true, account: this.#account, problem: this.#isolationProblem() };
  }

  /**
   * What would make a run fail before it starts: no sandbox and no word from
   * the operator, or — where Codex may run unsandboxed — command rules in its
   * home that cannot be kept out.
   */
  #isolationProblem(): string | null {
    const unavailable = this.#launcher.unavailable;
    if (unavailable !== null) return unavailable;
    if (this.#launcher.isolation === 'hidden') return null;
    return savedRuleFiles(this.#launcher.codexHome).length > 0 ? RULES_PROBLEM : null;
  }

  async #version(): Promise<{ installed: boolean; version: string | null }> {
    const command = this.#launcher.command(['--version']);
    try {
      const result = await this.#processes.run(command.file, command.args, { env: command.env, timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: 16 * 1024 });
      // Under the sandbox it is bubblewrap that fails to find the program.
      if (result.code !== 0 && /execvp|no such file or directory|not found/i.test(result.stderr)) return { installed: false, version: null };
      const text = `${result.stdout}\n${result.stderr}`;
      const match = /codex(?:-cli)?\s+v?(\d[\w.+-]*)/i.exec(text);
      if (!match && result.code !== 0) {
        this.#log.warn({ code: result.code, err: stderrSummary(result.stderr, 200) }, 'codex: --version failed');
        return { installed: false, version: null };
      }
      return { installed: true, version: match ? match[1]! : null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#log.warn({ err: (error as NodeJS.ErrnoException).code ?? 'error' }, 'codex: could not be started');
      return { installed: false, version: null };
    }
  }

  /** `codex login status` exits 0 when signed in and 1 with "Not logged in" when not (it writes to the error stream). */
  async #login(): Promise<{ signedIn: boolean | null; detail: string }> {
    const command = this.#launcher.command(['login', 'status']);
    try {
      const result = await this.#processes.run(command.file, command.args, { env: command.env, timeoutMs: LOGIN_TIMEOUT_MS, maxOutputBytes: 16 * 1024 });
      const text = `${result.stdout}\n${result.stderr}`;
      if (result.timedOut) return { signedIn: null, detail: 'the status command did not answer' };
      if (/not logged in|not signed in|logged out/i.test(text)) return { signedIn: false, detail: '' };
      if (result.code === 0 && /logged in|signed in/i.test(text)) return { signedIn: true, detail: '' };
      return { signedIn: null, detail: stderrSummary(text, 160) };
    } catch {
      return { signedIn: null, detail: 'the status command could not be run' };
    }
  }

  // ---- account and models, from the app-server -------------------------------------

  #refreshCatalogue(): Promise<Catalogue | null> {
    this.#catalogueInFlight ??= this.#askAppServer()
      .then((answer) => {
        if (!answer?.catalogue || answer.account === null) this.#catalogueRetryAt = Date.now() + CATALOGUE_RETRY_MS;
        if (!answer) return this.#catalogue?.value ?? null;
        this.#account = answer.account;
        if (answer.catalogue) this.#catalogue = { value: answer.catalogue, until: Date.now() + CATALOGUE_TTL_MS };
        return this.#catalogue?.value ?? null;
      })
      .finally(() => {
        this.#catalogueInFlight = null;
      });
    return this.#catalogueInFlight;
  }

  /** Starts an app-server just long enough to ask who is signed in and which models there are. */
  async #askAppServer(): Promise<{ account: string | null; catalogue: Catalogue | null } | null> {
    const command = this.#launcher.command(appServerArguments({ bridge: null, cwd: null }));
    let child: ReturnType<ProcessSupervisor['spawn']>;
    try {
      child = this.#processes.spawn(command.file, command.args, { env: command.env, stdin: 'pipe' });
    } catch {
      return null;
    }
    const client = new AppServerClient(
      child,
      {
        notification: () => {},
        request: () => Promise.reject(new RpcRefusal('This connection only asks about the account.')),
        failed: () => {},
      },
      this.#log,
    );
    const timeout = { timeoutMs: PROBE_TIMEOUT_MS };
    try {
      await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, timeout);
      client.notify('initialized');
      const account = accountReadSchema.safeParse(await client.request('account/read', { refreshToken: false }, timeout));
      const models: CodexModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const list = modelListSchema.safeParse(await client.request('model/list', cursor === null ? {} : { cursor }, timeout));
        if (!list.success) break;
        for (const entry of list.data.data) {
          const model = modelSchema.safeParse(entry);
          if (model.success && model.data.hidden !== true) models.push(model.data);
        }
        cursor = list.data.nextCursor ?? null;
        if (cursor === null) break;
      }
      const catalogue: Catalogue | null =
        models.length === 0
          ? null
          : {
              models: models.map(modelOption),
              defaultModel: models.find((model) => model.isDefault)?.model ?? null,
              images: models.some((model) => (model.inputModalities ?? ['text', 'image']).includes('image')),
            };
      return { account: account.success ? accountLabel(account.data) : null, catalogue };
    } catch (error) {
      this.#log.debug({ err: error instanceof Error ? tidy(error.message, 200) : 'error' }, 'codex: the account and model list could not be read');
      return null;
    } finally {
      client.end();
      const gone = await Promise.race([client.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500).unref())]);
      if (!gone) terminate(child, 1000);
    }
  }
}

export const RULES_PROBLEM =
  "Codex has saved command rules (in the rules folder of its home directory) that would let it run those commands without asking the Studio, and the Studio can only keep them out of a run when its sandbox (bubblewrap) is available. Turn the Studio's sandbox on, or move those rule files away.";
