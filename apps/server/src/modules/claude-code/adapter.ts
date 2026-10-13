import type { AgentCapabilities, AgentModelOption, AgentStatus, Question } from '@agent-studio/protocol';
import type { ModuleContext, Services } from '../../kernel/module.js';
import type {
  AgentAdapter,
  AgentRunHandle,
  AgentRunHost,
  AgentRunRequest,
  PermissionPrompt,
  PermissionPromptResult,
  UserQuestionAnswer,
} from '../agents/adapter.js';
import { ClaudeCli, type ClaudeCliOptions, DEFAULT_FEATURES } from './cli.js';
import { type ProjectInstructions, readProjectInstructions } from './instructions.js';
import { DEFAULT_MODEL } from './invocation.js';
import { ClaudeRun, type Tap } from './run.js';
import { ASK_USER_TOOL, EXIT_PLAN_TOOL, describeTool, isRecord, parseMcpToolName } from './tools.js';
import type { ModelTotals, UsageLedger } from './translate.js';

export const CLAUDE_CODE_AGENT_ID = 'claude-code';
/** Topic and type of the event that carries what the CLI reports about the account's usage limits. */
export const USAGE_TOPIC = 'internal:usage';
export const RATE_LIMIT_OBSERVED = 'rate-limit.observed';

export interface ClaudeCodeOptions extends ClaudeCliOptions {
  /** For tests and the manual smoke test only. */
  readonly tap?: Tap;
}

/** What `rate-limit.observed` carries. */
export interface RateLimitObserved {
  readonly agentId: string;
  /** Whose run saw it. The limits belong to the account the CLI is signed in to, which every user of this Studio shares. */
  readonly userId: string;
  readonly observedAt: number;
  /** The CLI's `rate_limit_info`, as it printed it. */
  readonly info: Record<string, unknown>;
}

const MODEL_LABELS: Record<string, { label: string; description: string }> = {
  fable: { label: 'Fable', description: 'The newest Fable model.' },
  opus: { label: 'Opus', description: 'The newest Opus model: the most capable, and the most expensive.' },
  sonnet: { label: 'Sonnet', description: 'The newest Sonnet model: a balance of capability and speed.' },
  haiku: { label: 'Haiku', description: 'The newest Haiku model: the fastest and cheapest.' },
};

function modelOption(alias: string, efforts: readonly string[]): AgentModelOption {
  const known = MODEL_LABELS[alias];
  return {
    id: alias,
    label: known?.label ?? alias.charAt(0).toUpperCase() + alias.slice(1),
    description: known?.description ?? `The newest "${alias}" model, as Claude Code resolves the name.`,
    ...(efforts.length > 0 ? { efforts: [...efforts] } : {}),
  };
}

/**
 * What each conversation of the CLI had used when it last reported — the CLI
 * totals a conversation across resumes, so the next run needs this to know
 * what it added. Kept in memory only: after a restart the first turn of a
 * conversation reports no cost, and the ones after it are exact again.
 */
class ConversationLedger implements UsageLedger {
  readonly #entries = new Map<string, ReadonlyMap<string, ModelTotals>>();
  readonly #limit: number;

  constructor(limit = 1000) {
    this.#limit = limit;
  }

  get(conversationId: string): ReadonlyMap<string, ModelTotals> | undefined {
    return this.#entries.get(conversationId);
  }

  set(conversationId: string, totals: ReadonlyMap<string, ModelTotals>): void {
    // Re-inserting keeps the most recently used conversations when the oldest are dropped.
    this.#entries.delete(conversationId);
    this.#entries.set(conversationId, totals);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

const allow = (input: unknown): PermissionPromptResult => ({ behavior: 'allow', updatedInput: isRecord(input) ? input : {} });

/** The CLI's question format → the Studio's. Ids are positions: the CLI has none. */
function toQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions: Question[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.question !== 'string') return;
    const options = Array.isArray(entry.options) ? entry.options : [];
    questions.push({
      id: `q${index + 1}`,
      ...(typeof entry.header === 'string' && entry.header !== '' ? { header: entry.header } : {}),
      question: entry.question,
      options: options
        .filter((option): option is Record<string, unknown> => isRecord(option) && typeof option.label === 'string')
        .map((option) => ({ label: option.label as string, ...(typeof option.description === 'string' ? { description: option.description } : {}) })),
      multiSelect: entry.multiSelect === true,
    });
  });
  return questions;
}

/**
 * The Studio's answers → what the CLI's question tool expects in its input:
 * `answers`, an object from each question's text to the chosen label (several
 * labels, and free text, joined with ", ").
 */
function toCliAnswers(questions: readonly Question[], answer: UserQuestionAnswer): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const given of answer.answers) {
    const question = questions.find((candidate) => candidate.id === given.questionId);
    if (!question) continue;
    const parts = [...(given.selected ?? []), ...(given.other !== undefined && given.other.trim() !== '' ? [given.other.trim()] : [])];
    if (parts.length > 0) answers[question.question] = parts.join(', ');
  }
  return answers;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = CLAUDE_CODE_AGENT_ID;
  readonly displayName = 'Claude Code';
  readonly kind = 'cli' as const;
  readonly cli: ClaudeCli;

  readonly #context: ModuleContext;
  readonly #runs = new Map<string, ClaudeRun>();
  readonly #ledger = new ConversationLedger();
  /** The problem with a project's instruction file that each session was last told about. */
  readonly #instructionProblems = new Map<string, string>();
  #tap: Tap | undefined;

  constructor(context: ModuleContext, options: ClaudeCodeOptions = {}) {
    this.#context = context;
    this.#tap = options.tap;
    this.cli = new ClaudeCli(context, options);
  }

  /** Forgets what the conversations had used, as a restart of the server does. For tests. */
  forgetUsage(): void {
    this.#ledger.clear();
  }

  /** Lets a test or the manual smoke test see what goes to and comes from the CLI in later runs. Never used in production. */
  observe(tap: Tap | null): void {
    this.#tap = tap ?? undefined;
  }

  async capabilities(): Promise<AgentCapabilities> {
    // What the installed CLI's own help says it accepts; sensible defaults while it is not installed.
    const features = (await this.cli.installation()?.catch(() => null))?.features ?? DEFAULT_FEATURES;
    return {
      models: [
        // The CLI's choice for the signed-in account: no model is named when it is started.
        { id: DEFAULT_MODEL, label: 'Default', description: 'Whichever model Claude Code picks for the signed-in account.', recommended: true, ...(features.efforts.length > 0 ? { efforts: [...features.efforts] } : {}) },
        // Aliases, which the CLI resolves to the newest model of each family. Any full model id may be given instead.
        ...features.modelAliases.filter((alias) => alias !== DEFAULT_MODEL).map((alias) => modelOption(alias, features.efforts)),
      ],
      defaultModel: DEFAULT_MODEL,
      // The engine implements all four; the CLI itself only ever runs in its plan mode or its asking mode.
      permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
      images: true,
      steering: features.replayUserMessages,
      resume: true,
      planMode: true,
      usage: true,
    };
  }

  status(): Promise<AgentStatus> {
    return this.cli.status();
  }

  /** The project's `CLAUDE.md`, unless the session has no project or the project does not hand it to agents. */
  #projectInstructions(request: AgentRunRequest): Promise<ProjectInstructions> {
    const projects = this.#context.services.projects;
    const project = request.projectId === null ? null : projects.find(request.projectId);
    if (!project || !projects.isFeatureEnabled(project, 'instructions')) return Promise.resolve({ kind: 'none' });
    return readProjectInstructions(project.rootDir);
  }

  /** A truncated or unusable instruction file is reported once per session, and again only when the problem changes. */
  #instructionsProblemIsNews(sessionId: string, problem: string | null): boolean {
    const known = this.#instructionProblems.get(sessionId);
    this.#instructionProblems.delete(sessionId);
    if (problem === null) return false;
    this.#instructionProblems.set(sessionId, problem);
    while (this.#instructionProblems.size > 1000) {
      const oldest = this.#instructionProblems.keys().next().value;
      if (oldest === undefined) break;
      this.#instructionProblems.delete(oldest);
    }
    return known !== problem;
  }

  run(request: AgentRunRequest, host: AgentRunHost): AgentRunHandle {
    const run = new ClaudeRun({
      context: this.#context,
      cli: this.cli,
      request,
      host,
      // Two standing texts are appended to the CLI's system prompt and nothing else: the shared-memory
      // conventions (when the memory module is there and assistants may use it) and the project's CLAUDE.md.
      memoryGuide: () => (this.#context.services as Partial<Services>).memory?.agentGuide() ?? null,
      projectInstructions: () => this.#projectInstructions(request),
      instructionsProblemIsNews: (problem) => this.#instructionsProblemIsNews(request.sessionId, problem),
      onRateLimit: (info) => {
        const observed: RateLimitObserved = { agentId: this.id, userId: request.userId, observedAt: Date.now(), info };
        this.#context.bus.publish(USAGE_TOPIC, RATE_LIMIT_OBSERVED, observed);
      },
      ledger: this.#ledger,
      tap: this.#tap,
    });
    this.#runs.set(request.runId, run);
    const done = run.done.finally(() => {
      if (this.#runs.get(request.runId) === run) this.#runs.delete(request.runId);
    });
    return { done, cancel: () => run.cancel(), steer: (message) => run.steer(message) };
  }

  /**
   * A permission prompt of the CLI, arriving through the bridge. The adapter
   * only describes the request; the answer is the engine's or a person's.
   */
  async onPermissionPrompt(prompt: PermissionPrompt, host: AgentRunHost, request: AgentRunRequest): Promise<PermissionPromptResult> {
    const run = this.#runs.get(request.runId);
    const input = isRecord(prompt.input) ? prompt.input : {};
    const toolCallId = prompt.toolCallId;
    const callId = toolCallId === null ? {} : { toolCallId };

    // The Studio's own tools are decided where they are carried out: the bridge applies the
    // permission engine to each call. Asking here as well would ask twice.
    if (parseMcpToolName(prompt.toolName)?.server === request.bridge.serverName) return allow(input);

    if (run && toolCallId !== null) await run.ensureToolStarted(toolCallId, prompt.toolName, input);
    const refuse = (message: string): PermissionPromptResult => {
      if (toolCallId !== null) run?.markDenied(toolCallId);
      return { behavior: 'deny', message };
    };

    if (prompt.toolName === ASK_USER_TOOL) {
      const questions = toQuestions(input);
      if (questions.length === 0) return refuse('The question could not be read. Ask it in your reply instead.');
      const answer = await host.askUser({ questions, ...callId });
      const answers = toCliAnswers(questions, answer);
      if (Object.keys(answers).length > 0) return allow({ ...input, answers });
      switch (answer.status) {
        case 'cancelled':
          return refuse('The run was stopped.');
        case 'unattended':
          return refuse('Nobody is watching this run, so the question was not asked. Use your own judgement and say which choice you made.');
        case 'expired':
          return refuse('Nobody answered in time. Use your own judgement and say which choice you made.');
        default:
          return refuse('The user chose not to answer. Use your own judgement and say which choice you made.');
      }
    }

    if (prompt.toolName === EXIT_PLAN_TOOL) {
      const plan = typeof input.plan === 'string' ? input.plan : '';
      const decision = await host.requestPermission({ approval: 'plan', toolName: prompt.toolName, kind: 'other', title: 'Approve the plan', input, plan, ...callId });
      return decision.behavior === 'allow' ? allow(decision.updatedInput ?? input) : refuse(decision.message);
    }

    const described = describeTool(prompt.toolName, input, request.cwd);
    const decision = await host.requestPermission({
      toolName: prompt.toolName,
      kind: described.kind,
      title: described.title,
      input,
      ...callId,
      ...(described.command === undefined ? {} : { command: described.command }),
      ...(described.paths === undefined ? {} : { paths: described.paths }),
      ...(described.url === undefined ? {} : { url: described.url }),
      ...(described.diff === undefined ? {} : { diff: described.diff }),
    });
    return decision.behavior === 'allow' ? allow(decision.updatedInput ?? input) : refuse(decision.message);
  }
}
