import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Approval, MessageReceipt, Run, Session, SessionEvent, SessionEventData, SessionEventType } from '@agent-studio/protocol';
import type { ConfigOverrides } from '../../../kernel/config.js';
import type { StudioEvent } from '../../../kernel/events.js';
import type { StudioModule } from '../../../kernel/module.js';
import { type AgentsKit, createAgentsKit, nextRequestId, until } from '../../../testing/agents-kit.js';
import type { TestClient, TestResponse } from '../../../testing/harness.js';
import type { AgentsModuleOptions } from '../../agents/agents.module.js';
import { CLAUDE_CODE_AGENT_ID, USAGE_TOPIC } from '../adapter.js';

/**
 * Test support for the Claude Code adapter: a whole Studio whose `claude` is
 * the stand-in from `tests/fixtures/bin`, with a throw-away HOME so that
 * nothing in a test can reach the machine's real Claude Code or its sign-in.
 *
 * The server under test builds its child environments from this process's
 * PATH and HOME, so putting the stand-in first on PATH is all it takes — the
 * same mechanism the Git and GitHub tests use for their stand-ins.
 */

export const STANDIN_BIN = fileURLToPath(new URL('../../../../../../tests/fixtures/bin', import.meta.url));

/** What the stand-in recorded about one conversation it was started for. */
export interface StandinInvocation {
  readonly pid: number;
  readonly ppid: number;
  readonly at: number;
  readonly cwd: string;
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly mcpConfig: Array<{ file?: string; text?: string; inline?: string }>;
}

export interface ClaudeKitOptions {
  readonly config?: ConfigOverrides;
  readonly agents?: AgentsModuleOptions;
  readonly extraModules?: readonly StudioModule[];
  /** Put this directory first on PATH instead of the stand-in's (to test a missing or odd CLI). */
  readonly bin?: string;
}

/** One line the server logged while a kit was capturing. */
export interface LoggedLine {
  readonly level: string;
  readonly fields: unknown;
  readonly message: string;
}

export interface ClaudeKit {
  readonly kit: AgentsKit;
  readonly owner: TestClient;
  /** The HOME the CLI sees. */
  readonly home: string;
  /** Where the stand-in keeps its conversations and its record of invocations. */
  readonly stateDir: string;
  /** Events published on `internal:usage` since the kit was created. */
  readonly usageEvents: StudioEvent[];
  session(overrides?: Record<string, unknown>, client?: TestClient): Promise<Session>;
  send(sessionId: string, text: string, extra?: Record<string, unknown>, client?: TestClient): Promise<TestResponse<MessageReceipt>>;
  /** Sends a message and waits for the run it starts to end. */
  turn(sessionId: string, text: string, extra?: Record<string, unknown>, client?: TestClient): Promise<Run>;
  runEnded(runId: string, timeoutMs?: number): Promise<Run>;
  events(sessionId: string): Promise<SessionEvent[]>;
  /** The data of every stored event of one type, oldest first. */
  eventsOf<T extends SessionEventType>(sessionId: string, type: T): Promise<Array<SessionEventData<T>>>;
  /** The completed prose of the session's main thread, oldest first. */
  texts(sessionId: string): Promise<string[]>;
  pendingApproval(sessionId: string, timeoutMs?: number): Promise<Approval>;
  decide(approvalId: string, body: Record<string, unknown>, client?: TestClient): Promise<TestResponse>;
  invocations(): StandinInvocation[];
  lastInvocation(): StandinInvocation;
  /** The value given after an option on the stand-in's command line. */
  argOf(invocation: StandinInvocation, option: string): string | undefined;
  nativeId(sessionId: string): Promise<string | null>;
  /** Makes the stand-in behave as after `claude auth logout` (or back). */
  signedIn(value: boolean): void;
  /** Removes the stand-in's own copy of every conversation, as if the CLI had lost them. */
  forgetConversations(): void;
  /** Everything the server logs from now on (the test Studio's logger is otherwise silent). */
  captureLogs(): LoggedLine[];
  close(): Promise<void>;
}

/** The stand-in's state directory for a HOME (the formula is in `tests/fixtures/bin/claude`). */
export function standinStateDir(home: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `claude-standin-${uid}`, createHash('sha256').update(home).digest('hex').slice(0, 16));
}

/** PATH without any folder that holds a `claude`: a test must never reach the machine's real CLI. */
function pathWithoutClaude(searchPath: string): string {
  return searchPath
    .split(path.delimiter)
    .filter((directory) => {
      if (directory === '') return false;
      try {
        return !statSync(path.join(directory, 'claude')).isFile();
      } catch {
        return true;
      }
    })
    .join(path.delimiter);
}

export async function createClaudeKit(options: ClaudeKitOptions = {}): Promise<ClaudeKit> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-studio-claude-kit-'));
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.PATH = `${options.bin ?? STANDIN_BIN}${path.delimiter}${pathWithoutClaude(saved.PATH ?? '')}`;
  const stateDir = standinStateDir(home);

  const restore = (): void => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  };

  let kit: AgentsKit;
  try {
    kit = await createAgentsKit({
      ...(options.config ? { config: options.config } : {}),
      ...(options.agents ? { agents: options.agents } : {}),
      ...(options.extraModules ? { extraModules: options.extraModules } : {}),
    });
    // The bridge is a separate process that calls back over HTTP: the server has to listen.
    await kit.listen();
  } catch (error) {
    restore();
    throw error;
  }
  const { owner } = kit;
  const usageEvents: StudioEvent[] = [];
  kit.t.studio.context.bus.onTopic(USAGE_TOPIC, (event) => usageEvents.push(event));

  const invocations = (): StandinInvocation[] => {
    const file = path.join(stateDir, 'invocations.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as StandinInvocation);
  };

  const runEnded = (runId: string, timeoutMs = 20_000): Promise<Run> =>
    until(
      async () => {
        const run = (await owner.get<Run>(`/api/runs/${runId}`)).body;
        return run.status !== 'accepted' && run.status !== 'running' ? run : null;
      },
      { what: `run ${runId} to end`, timeoutMs },
    );

  const self: ClaudeKit = {
    kit,
    owner,
    home,
    stateDir,
    usageEvents,
    session: (overrides = {}, client = owner) => kit.session(client, { agentId: CLAUDE_CODE_AGENT_ID, ...overrides }),
    send: (sessionId, text, extra = {}, client = owner) => client.post<MessageReceipt>(`/api/sessions/${sessionId}/messages`, { requestId: nextRequestId(), text, ...extra }),
    async turn(sessionId, text, extra = {}, client = owner) {
      const receipt = await self.send(sessionId, text, extra, client);
      if (receipt.status !== 202 || !receipt.body.runId) throw new Error(`The message did not start a run: ${JSON.stringify(receipt.body)}`);
      return runEnded(receipt.body.runId);
    },
    runEnded,
    events: (sessionId) => kit.events(owner, sessionId),
    async eventsOf(sessionId, type) {
      const events = await kit.events(owner, sessionId);
      return events.filter((event) => event.type === type).map((event) => event.data as SessionEventData<typeof type>);
    },
    async texts(sessionId) {
      const messages = await self.eventsOf(sessionId, 'message.assistant');
      return messages.filter((message) => message.parentToolCallId === null).map((message) => message.text);
    },
    pendingApproval: (sessionId, timeoutMs = 20_000) => until(async () => (await kit.state(owner, sessionId)).pendingApprovals[0], { what: 'an approval to be asked for', timeoutMs }),
    decide: (approvalId, body, client = owner) => client.post(`/api/approvals/${approvalId}/decision`, body),
    invocations,
    lastInvocation() {
      const all = invocations();
      const last = all[all.length - 1];
      if (!last) throw new Error('The stand-in CLI has not been started.');
      return last;
    },
    argOf(invocation, option) {
      const at = invocation.argv.indexOf(option);
      return at === -1 ? undefined : invocation.argv[at + 1];
    },
    async nativeId(sessionId) {
      const response = await owner.get<{ nativeSessionId: string }>(`/api/sessions/${sessionId}/native-id`);
      return response.status === 200 ? response.body.nativeSessionId : null;
    },
    signedIn(value) {
      mkdirSync(stateDir, { recursive: true });
      const marker = path.join(stateDir, 'signed-out');
      if (value) rmSync(marker, { force: true });
      else writeFileSync(marker, '');
    },
    forgetConversations() {
      const directory = path.join(stateDir, 'sessions');
      if (!existsSync(directory)) return;
      for (const name of readdirSync(directory)) rmSync(path.join(directory, name), { force: true });
    },
    captureLogs() {
      const lines: LoggedLine[] = [];
      // What the kernel's logger would write: requests and responses are reduced by its serializers
      // (method and path, status), errors to their message; everything else is logged as given.
      const serialise = (fields: unknown): unknown => {
        if (typeof fields !== 'object' || fields === null) return fields;
        const plain: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
          const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
          if (key === 'req') plain.req = { method: record.method, path: String(record.url ?? '').split('?')[0] };
          else if (key === 'res') plain.res = { statusCode: record.statusCode };
          else if (value instanceof Error) plain[key] = value.message;
          else plain[key] = value;
        }
        try {
          return JSON.parse(JSON.stringify(plain)) as unknown;
        } catch {
          return Object.keys(plain);
        }
      };
      const record =
        (level: string) =>
        (...args: unknown[]): void => {
          const [first, second] = args;
          lines.push(typeof first === 'string' ? { level, fields: {}, message: first } : { level, fields: serialise(first), message: typeof second === 'string' ? second : '' });
        };
      const recorder: Record<string, unknown> = { level: 'trace', silent: () => {} };
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) recorder[level] = record(level);
      recorder.child = () => recorder;
      // The runtime keeps this very object and asks it for a child logger per run.
      Object.assign(kit.t.studio.context.log, recorder);
      return lines;
    },
    async close() {
      try {
        await kit.close();
      } finally {
        restore();
      }
    },
  };
  return self;
}
