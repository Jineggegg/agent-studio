import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Approval, ApprovalDecisionResponse, Session, SessionEvent, UploadAttachmentsResponse } from '@agent-studio/protocol';
import { type AgentsKit, type KitOptions, createAgentsKit, until } from '../../../testing/agents-kit.js';
import type { TestClient, TestResponse } from '../../../testing/harness.js';

/**
 * Test support for the Codex adapter: a Studio whose `codex` is the stand-in
 * from `tests/fixtures/bin`, with a throw-away HOME so that neither the
 * machine's own Codex configuration nor its sign-in is anywhere near.
 *
 * The server under test builds its child environments from the test process's
 * HOME and PATH, so the adapter sees exactly this world.
 */

/** The stand-in executables. First on PATH while a kit is alive. */
export const FIXTURE_BIN = fileURLToPath(new URL('../../../../../../tests/fixtures/bin', import.meta.url));

export interface StandinRecord {
  readonly event: 'app-server' | 'thread/start' | 'thread/resume' | 'turn/start';
  readonly pid: number;
  readonly argv?: string[];
  readonly cwd?: string;
  readonly environment?: string[];
  readonly params?: Record<string, unknown>;
}

/** What the stand-in's `[[scenario:inspect]]` reports. */
export interface Inspection {
  readonly cwd: string;
  readonly argv: string[];
  readonly environment: string[];
  readonly tokenInArguments: boolean;
  readonly model: string;
  readonly effort: string | null;
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: unknown;
  readonly sandbox: string;
  readonly developerInstructions: string | null;
  readonly mcpServers: Record<string, { command: string | null; args: string[] | null; enabled: boolean }>;
  readonly features: Record<string, unknown>;
  readonly home: { configBytes: number | null; hooksBytes: number | null; rules: string[] };
  readonly images: Array<{ path: string; bytes: number | null }>;
  readonly readable: Record<string, boolean>;
}

export interface CodexKit extends AgentsKit {
  /** The throw-away HOME. */
  readonly home: string;
  /** `<home>/.codex`: where a test puts `standin.json`, `config.toml` or `rules/`. */
  readonly codexHome: string;
  /** Where the stand-in keeps its conversations and its record of how it was called. */
  readonly standinState: string;
  /** Describes the installation to the stand-in (`standin.json`); `{}` is "installed and signed in". */
  control(state: Record<string, unknown>): Promise<void>;
  /** Writes files into the Codex home, creating folders. */
  writeHome(files: Record<string, string>): Promise<void>;
  /** Everything the stand-in recorded so far. */
  records(): Promise<StandinRecord[]>;
  /** A session with the Codex agent. */
  codexSession(overrides?: Record<string, unknown>, client?: TestClient): Promise<Session>;
  /** Waits until the session has `count` approvals waiting. */
  pending(sessionId: string, count?: number): Promise<Approval[]>;
  decide(approvalId: string, body: Record<string, unknown>): Promise<TestResponse<ApprovalDecisionResponse>>;
  /** Uploads files to attach to the next message; returns their ids. */
  upload(sessionId: string, files: Array<{ name: string; content: Buffer | string; type?: string }>): Promise<string[]>;
  /** Stops the Studio and puts HOME and PATH back. */
  close(): Promise<void>;
}

export interface CodexKitOptions extends KitOptions {
  /** PATH for the Studio's children; the stand-in directory first by default. */
  readonly path?: string;
}

export const assistantTexts = (events: readonly SessionEvent[]): string[] =>
  events.filter((event): event is Extract<SessionEvent, { type: 'message.assistant' }> => event.type === 'message.assistant').map((event) => event.data.text);

export const eventsOf = <T extends SessionEvent['type']>(events: readonly SessionEvent[], type: T): Array<Extract<SessionEvent, { type: T }>> =>
  events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);

/** The JSON the stand-in's `inspect` scenario answered with. */
export function inspection(events: readonly SessionEvent[]): Inspection {
  const text = assistantTexts(events).find((candidate) => candidate.startsWith('{"cwd"'));
  if (!text) throw new Error(`The stand-in did not report an inspection. It said: ${JSON.stringify(assistantTexts(events))}`);
  return JSON.parse(text) as Inspection;
}

export async function createCodexKit(options: CodexKitOptions = {}): Promise<CodexKit> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-codex-home-'));
  const codexHome = path.join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  // Marks the home as one a test prepared: the stand-in reads `config.toml` and `rules/` only in such a home.
  await writeFile(path.join(codexHome, 'standin.json'), '{}');
  const standinState = path.join(os.tmpdir(), `codex-standin-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, createHash('sha256').update(home).digest('hex').slice(0, 16));

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home;
  process.env.PATH = options.path ?? `${FIXTURE_BIN}${path.delimiter}${saved.PATH ?? ''}`;
  delete process.env.CODEX_HOME;
  const restore = (): void => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  let base: AgentsKit;
  try {
    base = await createAgentsKit(options);
  } catch (error) {
    restore();
    await rm(home, { recursive: true, force: true });
    throw error;
  }

  const kit: CodexKit = {
    ...base,
    home,
    codexHome,
    standinState,
    control: (state) => writeFile(path.join(codexHome, 'standin.json'), JSON.stringify(state)),
    async writeHome(files) {
      for (const [name, content] of Object.entries(files)) {
        const target = path.join(codexHome, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    },
    async records() {
      const text = await readFile(path.join(standinState, 'invocations.jsonl'), 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as StandinRecord);
    },
    codexSession: (overrides = {}, client = base.owner) => base.session(client, { agentId: 'codex', ...overrides }),
    pending: (sessionId, count = 1) =>
      until(
        async () => {
          const approvals = (await base.state(base.owner, sessionId)).pendingApprovals;
          return approvals.length >= count ? approvals : null;
        },
        { what: `${count} pending approval(s)`, timeoutMs: 15_000 },
      ),
    decide: (approvalId, body) => base.owner.post<ApprovalDecisionResponse>(`/api/approvals/${approvalId}/decision`, body),
    async upload(sessionId, files) {
      const boundary = `----codex-kit-${Math.random().toString(16).slice(2)}`;
      const chunks: Buffer[] = [];
      for (const file of files) {
        chunks.push(
          Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="${file.name}"\r\ncontent-type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`),
          typeof file.content === 'string' ? Buffer.from(file.content) : file.content,
          Buffer.from('\r\n'),
        );
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const response = await base.owner.request<UploadAttachmentsResponse>('POST', `/api/sessions/${sessionId}/attachments`, Buffer.concat(chunks), { 'content-type': `multipart/form-data; boundary=${boundary}` });
      if (response.status !== 201 && response.status !== 200) throw new Error(`The upload failed: ${JSON.stringify(response.body)}`);
      return response.body.attachments.map((attachment) => attachment.id);
    },
    async close() {
      try {
        await base.close();
      } finally {
        restore();
        await rm(home, { recursive: true, force: true });
        await rm(standinState, { recursive: true, force: true });
      }
    },
  };
  return kit;
}

/** True while a process with this id exists. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
