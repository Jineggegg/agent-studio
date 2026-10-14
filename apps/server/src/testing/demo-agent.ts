import type { AgentCapabilities, AgentStatus, FileDiff, TodoItem, ToolKind } from '@agent-studio/protocol';
import type { StudioModule } from '../kernel/module.js';
import { AgentRunError, type AgentRunRequest, type PermissionDecision, type PermissionRequest, type UserQuestionAnswer } from '../modules/agents/adapter.js';
import { ScriptedAdapter, type ScriptStep, type ScriptedRun } from './scripted-adapter.js';

/**
 * A stand-in agent for looking at the workbench without a real CLI.
 *
 * It is the scripted test adapter with a script chosen from the prompt: plain
 * text gets a short streamed answer, and markers such as `[[tools]]` or
 * `[[approve]]` play a fixed scene. Every scene is deterministic — the same
 * prompt always produces the same events — so browser tests can assert on
 * what they see.
 *
 * Markers (several may appear in one prompt; they play in the order below):
 *
 *   [[quick]]        no pauses at all (for seeding long transcripts)
 *   [[title]]        proposes a session title
 *   [[code]]         Markdown with long lines, a table, nested lists, shell and code fences
 *   [[tools]]        read, search, a command with live output, an edit with a diff, a failing call
 *   [[todos]]        a checklist that evolves over a few steps
 *   [[subagent]]     a sub-agent whose own steps nest under the call that spawned it
 *   [[approve]]      a command that needs approval; carries on or reports the denial
 *   [[approve-edit]] an edit that needs approval, with a diff to review
 *   [[approve-many]] three requests in a row, two of them alike
 *   [[danger]]       a dangerous command (only the owner may allow it, never remembered)
 *   [[plan]]         submits a plan for approval; revises once when sent back
 *   [[question]]     one single-choice and one multi-choice question
 *   [[notice]]       a compaction, a rate-limit warning and a recoverable error
 *   [[usage]]        reports token use at 82 % of the context window ([[usage:97]] picks the figure)
 *   [[usage-bare]]   reports tokens but no window, as a sparse adapter would
 *   [[long]]         a slow, long answer; takes steered messages while it runs
 *   [[hang]]         works until it is stopped
 *   [[fail]]         fails ([[fail:not_installed]], [[fail:not_signed_in]], [[fail:rate_limited]] pick the reason)
 *
 * Nothing here may be reachable from `main.ts`: the module is added only by
 * `demo-server.ts` and by tests.
 */

const MODEL_LARGE = 'demo-large';
const MODEL_SMALL = 'demo-small';
const CONTEXT_WINDOW = 200_000;

class Halt extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One run's worth of helpers: emit events with believable pacing, stop quietly when the run is stopped. */
class Scene {
  readonly run: ScriptedRun;
  readonly #pace: number;
  #counter = 0;
  #steersSeen = 0;

  constructor(run: ScriptedRun, pace: number) {
    this.run = run;
    this.#pace = pace;
  }

  get model(): string {
    return this.run.request.model ?? MODEL_LARGE;
  }

  id(prefix: string): string {
    return `${prefix}-${(this.#counter += 1)}`;
  }

  check(): void {
    if (this.run.cancelled || this.run.finished || this.run.request.signal.aborted) throw new Halt();
  }

  async pause(ms: number): Promise<void> {
    this.check();
    if (this.#pace > 0) await sleep(ms * this.#pace);
    this.check();
  }

  /** Prose, streamed a few words at a time and then completed. */
  async say(text: string, options: { parent?: string; chunkMs?: number } = {}): Promise<void> {
    const messageId = this.id('msg');
    const parent = options.parent === undefined ? {} : { parentToolCallId: options.parent };
    const pieces = text.match(/\S+\s*|\s+/g) ?? [text];
    for (let at = 0; at < pieces.length; at += 3) {
      this.check();
      this.run.host.emit({ type: 'text.delta', messageId, text: pieces.slice(at, at + 3).join(''), ...parent });
      if (this.#pace > 0) await sleep((options.chunkMs ?? 28) * this.#pace);
    }
    this.check();
    this.run.host.emit({ type: 'text', messageId, text, model: this.model, ...parent });
  }

  async think(text: string, options: { parent?: string } = {}): Promise<void> {
    const messageId = this.id('think');
    const parent = options.parent === undefined ? {} : { parentToolCallId: options.parent };
    const pieces = text.match(/\S+\s*|\s+/g) ?? [text];
    for (let at = 0; at < pieces.length; at += 4) {
      this.check();
      this.run.host.emit({ type: 'thinking.delta', messageId, text: pieces.slice(at, at + 4).join(''), ...parent });
      if (this.#pace > 0) await sleep(24 * this.#pace);
    }
    this.check();
    this.run.host.emit({ type: 'thinking', messageId, text, ...parent });
  }

  /** A tool call from start to finish, with its output arriving in pieces. */
  async tool(spec: {
    name: string;
    kind: ToolKind;
    title: string;
    input?: unknown;
    output?: readonly string[];
    status?: 'ok' | 'error' | 'denied';
    diffs?: readonly FileDiff[];
    parent?: string;
    ms?: number;
    id?: string;
  }): Promise<string> {
    const toolCallId = spec.id ?? this.id('call');
    this.check();
    this.run.host.emit({
      type: 'tool.started',
      toolCallId,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      input: spec.input ?? {},
      ...(spec.parent === undefined ? {} : { parentToolCallId: spec.parent }),
    });
    await this.pause(spec.ms ?? 260);
    for (const chunk of spec.output ?? []) {
      this.run.host.emit({ type: 'tool.output', toolCallId, text: chunk });
      await this.pause(140);
    }
    this.run.host.emit({
      type: 'tool.finished',
      toolCallId,
      status: spec.status ?? 'ok',
      output: (spec.output ?? []).join(''),
      ...(spec.diffs ? { diffs: spec.diffs } : {}),
    });
    return toolCallId;
  }

  /** Asks before a tool runs, then runs it or records the refusal. Returns the decision. */
  async permit(
    request: PermissionRequest & { title: string },
    onAllowed: { output?: readonly string[]; diffs?: readonly FileDiff[] } = {},
  ): Promise<PermissionDecision> {
    const toolCallId = this.id('call');
    this.check();
    this.run.host.emit({ type: 'tool.started', toolCallId, name: request.toolName, kind: request.kind, title: request.title, input: request.input });
    const decision = await this.run.host.requestPermission({ ...request, toolCallId });
    this.run.decisions.push(decision);
    this.check();
    if (decision.behavior === 'allow') {
      for (const chunk of onAllowed.output ?? []) {
        this.run.host.emit({ type: 'tool.output', toolCallId, text: chunk });
        await this.pause(140);
      }
      this.run.host.emit({
        type: 'tool.finished',
        toolCallId,
        status: 'ok',
        output: (onAllowed.output ?? []).join(''),
        ...(onAllowed.diffs ? { diffs: onAllowed.diffs } : {}),
      });
    } else {
      this.run.host.emit({ type: 'tool.finished', toolCallId, status: 'denied', output: decision.message });
    }
    return decision;
  }

  todos(items: readonly TodoItem[]): void {
    this.check();
    this.run.host.emit({ type: 'todos', items });
  }

  notice(level: 'info' | 'warning' | 'error', code: string, text: string): void {
    this.check();
    this.run.host.emit({ type: 'notice', level, code, text });
  }

  usage(contextTokens: number | null, extra: { window?: number | null; cost?: number | null } = {}): void {
    this.check();
    const window = extra.window === undefined ? CONTEXT_WINDOW : extra.window;
    this.run.host.emit({
      type: 'usage',
      model: this.model,
      inputTokens: 1840,
      outputTokens: 412,
      cacheReadTokens: 9200,
      cacheWriteTokens: 640,
      ...(extra.cost === null ? {} : { costUsd: extra.cost ?? 0.0123 }),
      ...(contextTokens === null ? {} : { contextTokens }),
      ...(window === null ? {} : { contextWindow: window }),
    });
  }

  /** Messages steered into the turn since the last look. */
  takeSteers(): string[] {
    const fresh = this.run.steered.slice(this.#steersSeen);
    this.#steersSeen = this.run.steered.length;
    return fresh;
  }
}

// ---- fixed material ---------------------------------------------------------------

const APP_DIFF = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -12,9 +12,11 @@ export function createApp(config: AppConfig) {',
  '   const router = createRouter();',
  '   router.use(logger());',
  '-  router.get("/health", () => "ok");',
  '+  router.get("/health", () => ({ status: "ok", uptime: process.uptime() }));',
  '+  router.get("/version", () => ({ version: config.version }));',
  '   router.use(errors());',
  '+  router.use(notFound());',
  '   return router;',
  ' }',
  '@@ -40,3 +42,3 @@ export function start(app: App) {',
  '-  app.listen(3000);',
  '+  app.listen(config.port ?? 3000);',
  ' }',
  '',
].join('\n');

const LOGIN_DIFF = [
  '--- a/src/auth/login.ts',
  '+++ b/src/auth/login.ts',
  '@@ -21,7 +21,8 @@ export async function login(form: LoginForm) {',
  '   const user = await users.findByName(form.username);',
  '-  if (!user) return fail("unknown user");',
  '-  if (user.password !== form.password) return fail("wrong password");',
  '+  // The same answer either way, so a caller cannot learn which names exist.',
  '+  const ok = user !== null && (await verify(user.passwordHash, form.password));',
  '+  if (!ok) return fail("That username or password is not correct.");',
  '   return succeed(user);',
  ' }',
  '',
].join('\n');

const CODE_SAMPLE = `Here is what the pieces look like.

## A table

| Route | Method | Handler | Notes |
| --- | --- | --- | --- |
| \`/health\` | GET | \`health()\` | Answers without touching the database |
| \`/version\` | GET | \`version()\` | Reads the version baked into the build |
| \`/api/sessions/:sessionId/messages\` | POST | \`sendMessage()\` | Idempotent: the same request id never starts a second run |

## Nested lists

1. Read the configuration
   - from the environment
   - then from the file, when there is one
     1. JSON first
     2. then TOML
2. Start the server
   - bind the port
   - announce the address

## Commands

\`\`\`bash
npm install
npm run build -- --mode production
\`\`\`

## A long line

\`\`\`ts
export const veryLongLine = createSomethingWithAnUnreasonablyLongName({ firstOption: true, secondOption: 'a value that goes on for a while', thirdOption: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], fourthOption: { nested: { deeper: { deepest: 'here' } } } });
\`\`\`

An address that cannot wrap: https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces/until/it/finally/ends?with=a&query=string

> A quotation, to see how block quotes sit next to prose.

Inline \`code\`, **bold**, *emphasis*, a [link](https://example.com/docs) and a file: [src/app.ts](src/app.ts#L12).`;

const LONG_PARAGRAPHS = [
  'A long answer gives the transcript something to follow. Each paragraph arrives a few words at a time, the way a model writes, so the view has to keep its place at the bottom without jumping.',
  'While it runs you can scroll up: nothing should pull you back down, and a control should offer the way to the newest line. Type a message and it can either wait its turn in the queue or be handed to this turn directly.',
  'Stopping is the other thing to try. Whatever has been written by then stays in the transcript, marked as cut short, and the run ends exactly once.',
];

// ---- scenes -----------------------------------------------------------------------

type SceneFn = (scene: Scene, argument: string | null) => Promise<void>;

const scenes: Array<{ marker: string; play: SceneFn }> = [
  {
    marker: 'title',
    play: async (scene) => {
      scene.run.host.emit({ type: 'title', title: 'Checkout redesign' });
    },
  },
  {
    marker: 'code',
    play: async (scene) => {
      await scene.say(CODE_SAMPLE);
    },
  },
  {
    marker: 'tools',
    play: async (scene) => {
      await scene.think('The health route is the place to start. I will read the app file, look for other callers, run the tests, then make the change.');
      await scene.say('I will look at how the routes are set up first.');
      await scene.tool({
        name: 'Read',
        kind: 'read',
        title: 'Read src/app.ts',
        input: { file_path: 'src/app.ts', offset: 1, limit: 60 },
        output: ['import { createRouter } from "./router";\nimport { logger, errors } from "./middleware";\n\nexport function createApp(config: AppConfig) {\n  const router = createRouter();\n  router.use(logger());\n  router.get("/health", () => "ok");\n  router.use(errors());\n  return router;\n}\n'],
      });
      await scene.tool({
        name: 'Grep',
        kind: 'search',
        title: 'Search for "/health"',
        input: { pattern: '/health', path: 'src' },
        output: ['src/app.ts:18\nsrc/monitor/probe.ts:7\ntest/app.test.ts:31\n'],
      });
      await scene.tool({
        name: 'Bash',
        kind: 'execute',
        title: 'Run npm test',
        input: { command: 'npm test -- --reporter=dot', description: 'Run the test suite' },
        output: ['\n> demo@1.0.0 test\n> vitest run --reporter=dot\n\n', ' ✓ test/app.test.ts (4 tests) 21ms\n', ' ✓ test/router.test.ts (9 tests) 34ms\n', '\n Test Files  2 passed (2)\n      Tests  13 passed (13)\n   Duration  1.31s\n'],
        ms: 420,
      });
      await scene.tool({
        name: 'Edit',
        kind: 'edit',
        title: 'Edit src/app.ts',
        input: { file_path: 'src/app.ts' },
        output: ['Applied 2 changes to src/app.ts\n'],
        diffs: [{ path: 'src/app.ts', added: 4, removed: 2, patch: APP_DIFF }],
      });
      await scene.tool({
        name: 'Bash',
        kind: 'execute',
        title: 'Run npm run lint',
        input: { command: 'npm run lint' },
        output: ['src/app.ts\n  22:3  error  "notFound" is not defined  no-undef\n\n✖ 1 problem (1 error, 0 warnings)\n'],
        status: 'error',
      });
      await scene.tool({
        name: 'WebFetch',
        kind: 'fetch',
        title: 'Fetch https://example.com/docs/routing',
        input: { url: 'https://example.com/docs/routing' },
        output: ['# Routing\n\nMiddleware runs in the order it is registered.\n'],
      });
      await scene.say('The health route now reports uptime and there is a version route. Lint still fails because `notFound` is not imported — that is the next thing to fix.');
    },
  },
  {
    marker: 'todos',
    play: async (scene) => {
      const steps = ['Read the failing test', 'Fix the off-by-one in the pager', 'Run the suite again'];
      const list = (done: number, active: number | null): TodoItem[] =>
        steps.map((text, index) => ({ text, status: index < done ? 'completed' : index === active ? 'in_progress' : 'pending' }));
      await scene.say('Three steps should do it.');
      scene.todos(list(0, 0));
      await scene.tool({ name: 'Read', kind: 'read', title: 'Read test/pager.test.ts', input: { file_path: 'test/pager.test.ts' }, output: ['it("returns the last page", () => { … })\n'] });
      scene.todos(list(1, 1));
      await scene.tool({
        name: 'Edit',
        kind: 'edit',
        title: 'Edit src/pager.ts',
        input: { file_path: 'src/pager.ts' },
        diffs: [{ path: 'src/pager.ts', added: 1, removed: 1, patch: '--- a/src/pager.ts\n+++ b/src/pager.ts\n@@ -8,3 +8,3 @@\n   const start = page * size;\n-  const end = start + size - 1;\n+  const end = start + size;\n   return items.slice(start, end);\n' }],
      });
      scene.todos(list(2, 2));
      await scene.tool({ name: 'Bash', kind: 'execute', title: 'Run npm test', input: { command: 'npm test' }, output: [' Test Files  3 passed (3)\n'] });
      scene.todos(list(3, null));
      await scene.say('All three steps are done and the suite passes.');
    },
  },
  {
    marker: 'subagent',
    play: async (scene) => {
      await scene.say('This is worth a closer look, so I will hand the research to a sub-agent.');
      const parent = scene.id('agent');
      scene.check();
      scene.run.host.emit({
        type: 'tool.started',
        toolCallId: parent,
        name: 'Task',
        kind: 'agent',
        title: 'Research how sessions are stored',
        input: { description: 'Research how sessions are stored', subagent_type: 'explorer' },
      });
      await scene.think('Start with the schema, then the store.', { parent });
      await scene.tool({ name: 'Glob', kind: 'search', title: 'Find **/*session*.ts', input: { pattern: '**/*session*.ts' }, output: ['src/sessions/store.ts\nsrc/sessions/schema.ts\n'], parent });
      await scene.tool({ name: 'Read', kind: 'read', title: 'Read src/sessions/schema.ts', input: { file_path: 'src/sessions/schema.ts' }, output: ['CREATE TABLE sessions (id TEXT PRIMARY KEY, …)\n'], parent });
      await scene.say('Sessions live in one table keyed by id; events hang off it in a second table ordered by sequence number.', { parent });
      scene.check();
      scene.run.host.emit({ type: 'tool.finished', toolCallId: parent, status: 'ok', output: 'Sessions are rows in `sessions`; their events are in `session_events`, ordered by `seq`.' });
      await scene.say('The sub-agent found that sessions and their events are two tables joined by the session id.');
    },
  },
  {
    marker: 'approve',
    play: async (scene) => {
      await scene.say('I would like to run the tests before going further.');
      const decision = await scene.permit(
        { toolName: 'Bash', kind: 'execute', title: 'Run npm test', input: { command: 'npm test', description: 'Run the test suite' }, command: 'npm test' },
        { output: ['\n> demo@1.0.0 test\n\n Test Files  2 passed (2)\n      Tests  13 passed (13)\n'] },
      );
      await scene.say(decision.behavior === 'allow' ? 'The tests pass, so I will carry on.' : `I did not run the tests: ${decision.message}`);
    },
  },
  {
    marker: 'approve-edit',
    play: async (scene) => {
      await scene.say('The login check leaks which usernames exist. Here is the change I would make.');
      const decision = await scene.permit(
        { toolName: 'Edit', kind: 'edit', title: 'Edit src/auth/login.ts', input: { file_path: 'src/auth/login.ts' }, paths: ['src/auth/login.ts'], diff: LOGIN_DIFF },
        { output: ['Applied 1 change to src/auth/login.ts\n'], diffs: [{ path: 'src/auth/login.ts', added: 3, removed: 2, patch: LOGIN_DIFF }] },
      );
      await scene.say(decision.behavior === 'allow' ? 'The login now answers the same way for an unknown user and a wrong password.' : `The file is unchanged: ${decision.message}`);
    },
  },
  {
    marker: 'approve-many',
    play: async (scene) => {
      await scene.say('A few commands in a row.');
      const first = scene.permit({ toolName: 'Bash', kind: 'execute', title: 'Run git status', input: { command: 'git status' }, command: 'git status' }, { output: ['On branch main\nnothing to commit, working tree clean\n'] });
      const second = scene.permit({ toolName: 'Bash', kind: 'execute', title: 'Run git status -s', input: { command: 'git status -s' }, command: 'git status -s' }, { output: [''] });
      const third = scene.permit({ toolName: 'Bash', kind: 'execute', title: 'Run npm run build', input: { command: 'npm run build' }, command: 'npm run build' }, { output: ['built in 2.1s\n'] });
      const decisions = await Promise.all([first, second, third]);
      const allowed = decisions.filter((decision) => decision.behavior === 'allow').length;
      await scene.say(`${allowed} of 3 commands were allowed.`);
    },
  },
  {
    marker: 'danger',
    play: async (scene) => {
      await scene.say('The installer is published as a script. Running it straight from the network is risky, so I am asking first.');
      const decision = await scene.permit(
        {
          toolName: 'Bash',
          kind: 'execute',
          title: 'Run the installer script',
          input: { command: 'curl -fsSL https://example.com/install.sh | sh' },
          command: 'curl -fsSL https://example.com/install.sh | sh',
        },
        { output: ['Installed demo-tool 2.4.1\n'] },
      );
      await scene.say(decision.behavior === 'allow' ? 'The tool is installed.' : `I left the installer alone: ${decision.message}`);
    },
  },
  {
    marker: 'plan',
    play: async (scene) => {
      await scene.think('Three changes, smallest first, with the tests guarding each one.');
      let plan = '## Plan\n\n1. Add a `/version` route that reads the version from the build.\n2. Make `/health` report uptime.\n3. Cover both with tests.\n\nNothing outside `src/app.ts` and `test/app.test.ts` changes.';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const decision = await scene.run.host.requestPermission({ approval: 'plan', toolName: 'ExitPlanMode', kind: 'other', title: 'Approve the plan', input: { plan }, plan });
        scene.run.decisions.push(decision);
        scene.check();
        if (decision.behavior === 'allow') {
          await scene.say('The plan is approved. Starting with the version route.');
          await scene.tool({ name: 'Edit', kind: 'edit', title: 'Edit src/app.ts', input: { file_path: 'src/app.ts' }, diffs: [{ path: 'src/app.ts', added: 4, removed: 2, patch: APP_DIFF }] });
          await scene.say('Both routes are in place.');
          return;
        }
        await scene.say(`Revising the plan: ${decision.message}`);
        plan = `## Plan (revised)\n\n1. Add a \`/version\` route.\n2. Cover it with a test.\n\nYour note: ${decision.message}`;
      }
      await scene.say('I will wait for a clearer direction before changing anything.');
    },
  },
  {
    marker: 'question',
    play: async (scene) => {
      await scene.say('Two things I should not guess.');
      const answer: UserQuestionAnswer = await scene.run.host.askUser({
        questions: [
          {
            id: 'runner',
            header: 'Test runner',
            question: 'Which test runner should the new tests use?',
            options: [
              { label: 'Vitest', description: 'Already used by the web client.', recommended: true },
              { label: 'Jest', description: 'Used by the legacy package.' },
              { label: 'Node test runner', description: 'No dependency at all.' },
            ],
            multiSelect: false,
          },
          {
            id: 'targets',
            header: 'Platforms',
            question: 'Which platforms need to be covered?',
            options: [{ label: 'Linux' }, { label: 'macOS' }, { label: 'Windows', description: 'Slowest runner; adds about four minutes.' }],
            multiSelect: true,
          },
        ],
      });
      scene.run.answers.push(answer);
      scene.check();
      if (answer.status === 'answered' || answer.status === 'expired') {
        const lines = answer.answers.map((entry) => `- **${entry.questionId}**: ${[...entry.selected, ...(entry.other ? [`Other: ${entry.other}`] : [])].join(', ') || 'no answer'}`);
        await scene.say(lines.length > 0 ? `Thanks. I will go with:\n\n${lines.join('\n')}` : 'No answers came back, so I will use my own judgement.');
      } else {
        await scene.say('You left it to me, so I will use Vitest on Linux.');
      }
    },
  },
  {
    marker: 'notice',
    play: async (scene) => {
      await scene.say('Working through a long history.');
      scene.notice('info', 'compaction', '725K → 41K tokens. Older messages were summarised to make room.');
      await scene.pause(200);
      scene.notice('warning', 'rate_limit', 'The provider is rate limiting this account. Requests continue more slowly for the next few minutes.');
      await scene.pause(200);
      scene.notice('error', 'tool_error', 'The language server stopped answering and was restarted.');
      await scene.say('Those were hiccups; the work itself went through.');
    },
  },
  {
    marker: 'usage',
    play: async (scene, argument) => {
      const percent = Math.min(100, Math.max(1, Number(argument ?? '82') || 82));
      scene.usage(Math.round((CONTEXT_WINDOW * percent) / 100));
      await scene.say(`The context window is now about ${percent} % full.`);
    },
  },
  {
    marker: 'usage-bare',
    play: async (scene) => {
      scene.usage(null, { window: null, cost: null });
      await scene.say('This adapter reported tokens, but neither a cost nor the size of its context window.');
    },
  },
  {
    marker: 'long',
    play: async (scene) => {
      await scene.think('This will take a while; I will write it out in parts.');
      for (let part = 1; part <= 14; part += 1) {
        const body = LONG_PARAGRAPHS[(part - 1) % LONG_PARAGRAPHS.length]!;
        await scene.say(`**Part ${part} of 14.** ${body}`, { chunkMs: 70 });
        for (const steered of scene.takeSteers()) await scene.say(`> Noted while working: ${steered}`);
        if (part % 4 === 0) {
          await scene.tool({ name: 'Bash', kind: 'execute', title: `Run step ${part / 4} of the build`, input: { command: `npm run build:step-${part / 4}` }, output: ['compiling…\n', 'done\n'], ms: 500 });
        }
        await scene.pause(260);
      }
      await scene.say('That was the whole of it.');
    },
  },
  {
    marker: 'hang',
    play: async (scene) => {
      await scene.say('I will keep working until I am stopped.');
      const toolCallId = scene.id('call');
      scene.run.host.emit({ type: 'tool.started', toolCallId, name: 'Bash', kind: 'execute', title: 'Run npm run dev', input: { command: 'npm run dev' } });
      for (let tick = 1; ; tick += 1) {
        scene.check();
        scene.run.host.emit({ type: 'tool.output', toolCallId, text: `[${String(tick).padStart(3, '0')}] watching for changes…\n` });
        for (const steered of scene.takeSteers()) scene.run.host.emit({ type: 'tool.output', toolCallId, text: `steered: ${steered}\n` });
        await sleep(700);
      }
    },
  },
  {
    marker: 'fail',
    play: async (scene, argument) => {
      await scene.say('Starting on it.');
      await scene.tool({ name: 'Read', kind: 'read', title: 'Read package.json', input: { file_path: 'package.json' }, output: ['{ "name": "demo" }\n'] });
      switch (argument) {
        case 'not_installed':
          throw new AgentRunError('not_installed', 'The demo CLI is not installed on this server.');
        case 'not_signed_in':
          throw new AgentRunError('not_signed_in', 'The demo CLI is not signed in. Sign in on the server and try again.');
        case 'rate_limited':
          throw new AgentRunError('rate_limited', 'The usage limit for this account was reached. It resets at 18:00.');
        default:
          throw new AgentRunError('agent_error', 'The demo agent failed on purpose.');
      }
    },
  },
];

const MARKER = /\[\[([a-z-]+)(?::([a-z0-9_-]+))?\]\]/gi;

function readMarkers(text: string): Map<string, string | null> {
  const found = new Map<string, string | null>();
  for (const match of text.matchAll(MARKER)) found.set(match[1]!.toLowerCase(), match[2]?.toLowerCase() ?? null);
  return found;
}

/** The script of one run, chosen from what the user wrote. */
export function demoScript(request: AgentRunRequest): readonly ScriptStep[] {
  const text = request.prompt.text;
  const markers = readMarkers(text);
  const quick = markers.has('quick');
  const chosen = scenes.filter((scene) => markers.has(scene.marker));

  return [
    {
      do: async (run) => {
        const scene = new Scene(run, quick ? 0 : 1);
        try {
          if (chosen.length === 0) {
            const plain = text.replace(MARKER, '').trim();
            const attachments = request.prompt.attachments.length;
            const quoted = request.prompt.quote ? `\n\n> ${request.prompt.quote.split('\n').join('\n> ')}\n\nThat is the passage you quoted.` : '';
            if (!quick) await scene.pause(180);
            await scene.tool({ name: 'Read', kind: 'read', title: 'Read README.md', input: { file_path: 'README.md' }, output: ['# Demo project\n'], ms: quick ? 0 : 160 });
            await scene.say(
              `You said: **${plain === '' ? '(nothing but a marker)' : plain.slice(0, 400)}**${attachments > 0 ? `\n\nYou attached ${attachments} file${attachments === 1 ? '' : 's'}: ${request.prompt.attachments.map((file) => `\`${file.name}\``).join(', ')}.` : ''}${quoted}\n\nThis is the demo agent. It answers every message the same way, and plays a scene when the message contains a marker such as \`[[tools]]\` or \`[[approve]]\`.`,
            );
          }
          for (const entry of chosen) await entry.play(scene, markers.get(entry.marker) ?? null);
          // Every turn reports what it used, the way a real agent does; the figure grows with the conversation.
          if (!markers.has('usage') && !markers.has('usage-bare')) scene.usage(Math.min(CONTEXT_WINDOW - 2000, 6200 + request.history.length * 900));
        } catch (error) {
          if (error instanceof Halt) return;
          throw error;
        }
      },
    },
  ];
}

class DemoAdapter extends ScriptedAdapter {
  readonly #steering: boolean;

  constructor(options: { id: string; displayName: string; steering: boolean; status?: AgentStatus }) {
    super({ id: options.id, displayName: options.displayName, steering: options.steering });
    this.#steering = options.steering;
    this.currentStatus = options.status ?? { installed: true, version: '1.0.0-demo', signedIn: true, account: 'demo@example.test', problem: null };
    this.otherwise(demoScript);
  }

  override capabilities(): AgentCapabilities {
    return {
      models: [
        {
          id: MODEL_LARGE,
          label: 'Demo Large',
          description: 'Slower, more thorough.',
          recommended: true,
          contextWindow: CONTEXT_WINDOW,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        { id: MODEL_SMALL, label: 'Demo Small', description: 'Quick answers.', contextWindow: 100_000 },
      ],
      defaultModel: MODEL_LARGE,
      permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
      images: true,
      steering: this.#steering,
      resume: true,
      planMode: true,
      usage: true,
    };
  }
}

/** The demo agents: one that can be steered, one that cannot, and two that are unavailable for different reasons. */
export function createDemoAdapters(): ScriptedAdapter[] {
  return [
    new DemoAdapter({ id: 'demo', displayName: 'Demo agent', steering: true }),
    new DemoAdapter({ id: 'demo-queue', displayName: 'Demo agent (queue only)', steering: false }),
    new DemoAdapter({
      id: 'demo-missing',
      displayName: 'Demo agent (not installed)',
      steering: false,
      status: { installed: false, version: null, signedIn: false, account: null, problem: 'The demo CLI was not found on this server.' },
    }),
    new DemoAdapter({
      id: 'demo-signed-out',
      displayName: 'Demo agent (signed out)',
      steering: false,
      status: { installed: true, version: '1.0.0-demo', signedIn: false, account: null, problem: 'The demo CLI is installed but not signed in.' },
    }),
  ];
}

/** Registers the demo agents. For `demo-server.ts` and tests only — never part of the production module list. */
export function demoAgentModule(adapters: readonly ScriptedAdapter[] = createDemoAdapters()): StudioModule {
  return {
    name: 'testing.demo-agents',
    setup(context) {
      for (const adapter of adapters) context.services.agents.registerAdapter(adapter);
    },
  };
}
