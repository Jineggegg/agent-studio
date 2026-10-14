import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { until } from './realtime.js';
import {
  ApiClient,
  startTestStudio,
  type ApiResponse,
  type RunningStudio,
  type StartOptions,
} from './studio.js';

/**
 * Helpers for driving projects, sessions and runs through the public API.
 * They state what a black-box client knows — URLs, bodies, status codes — and
 * nothing of the server's types.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- black-box JSON
export type Json = any;

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** A Studio for tests that run agents: the sandbox on where the machine offers one. */
export function startAgentStudio(options: StartOptions = {}): Promise<RunningStudio> {
  return startTestStudio({
    ...options,
    env: { AGENT_STUDIO_SANDBOX: 'auto', ...(options.env ?? {}) },
  });
}

/** Whether agent processes are sandboxed on this machine (Codex refuses to run without it). */
export async function sandboxIsOn(client: ApiClient): Promise<boolean> {
  const info = await client.get<{ sandbox: { mode: string } }>('/api/system/info');
  return info.body.sandbox.mode === 'bwrap';
}

export const SANDBOX_OFF =
  'skipped: this machine has no working sandbox (bubblewrap), and Codex does not run without it';

function ok<T>(response: ApiResponse<T>, expected: number | number[], what: string): T {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(
      `${what}: expected HTTP ${allowed.join(' or ')}, got ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

export interface Project {
  id: string;
  name: string;
  rootDir: string;
  access: string;
  archived: boolean;
  pinned: boolean;
  lastOpenedAt: number | null;
}

/** Creates a folder inside the harness's workspace and a project in it. */
export async function createProject(
  studio: RunningStudio,
  owner: ApiClient,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<Project> {
  const rootDir = path.join(studio.workspace, name);
  await mkdir(rootDir, { recursive: true });
  return ok(
    await owner.post<Project>('/api/projects', { name, rootDir, ...extra }),
    [200, 201],
    `create project ${name}`,
  );
}

/** Creates a member account and returns a browser signed in as it. */
export async function createMember(
  studio: RunningStudio,
  owner: ApiClient,
  username: string,
): Promise<ApiClient> {
  const password = `${username} passphrase 12`;
  ok(
    await owner.post('/api/users', { username, password, role: 'member' }),
    [200, 201],
    `create member ${username}`,
  );
  return signIn(studio, username);
}

/** A further browser of an existing member (same account, another device). */
export async function signIn(studio: RunningStudio, username: string): Promise<ApiClient> {
  const client = new ApiClient(studio.url);
  ok(
    await client.login({ username, password: `${username} passphrase 12` }),
    200,
    `sign in as ${username}`,
  );
  return client;
}

export async function shareProject(
  owner: ApiClient,
  projectId: string,
  userId: string,
  access: 'read' | 'write' = 'write',
): Promise<void> {
  ok(
    await owner.put(`/api/projects/${projectId}/members/${userId}`, { access }),
    [200, 204],
    'share project',
  );
}

export interface Session {
  id: string;
  projectId: string | null;
  userId: string;
  agentId: string;
  title: string;
  titleSource: string;
  permissionMode: string;
  effectivePermissionMode: string;
  pinned: boolean;
  archived: boolean;
  attention: string;
  activeRunId: string | null;
  resumable: boolean;
  lastSeq: number;
  model: string | null;
  hasDraft: boolean;
  chainId: string | null;
  parentSessionId: string | null;
}

export async function createSession(
  client: ApiClient,
  projectId: string | null,
  agentId = 'claude-code',
  extra: Record<string, unknown> = {},
): Promise<Session> {
  return ok(
    await client.post<Session>('/api/sessions', { projectId, agentId, ...extra }),
    [200, 201],
    `create ${agentId} session`,
  );
}

export interface Receipt {
  requestId: string;
  sessionId: string;
  disposition: 'run' | 'queued' | 'steered';
  runId: string | null;
  queueItemId: string | null;
  duplicate: boolean;
  run: Run | null;
  acceptedAt: number;
}

export interface Run {
  id: string;
  sessionId: string;
  status: string;
  text: string;
  origin: string;
  unattended: boolean;
  permissionMode: string;
  requestId: string;
  error: { code: string; message: string } | null;
  interruptedByRestart: boolean;
  continuesRunId: string | null;
  continuedByRunId: string | null;
  dismissedAt: number | null;
  seenAt: number | null;
}

export const newRequestId = (): string => `req-${randomUUID()}`;

/** Sends a message and returns the raw response (for tests about refusals). */
export function postMessage(
  client: ApiClient,
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<ApiResponse<Json>> {
  return client.post<Json>(`/api/sessions/${sessionId}/messages`, {
    requestId: newRequestId(),
    text,
    ...extra,
  });
}

/** Sends a message that must be accepted, and returns its receipt. */
export async function send(
  client: ApiClient,
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<Receipt> {
  return ok(
    await postMessage(client, sessionId, text, extra),
    [200, 202],
    'send message',
  ) as Receipt;
}

const TERMINAL = ['completed', 'failed', 'stopped', 'interrupted'];

export async function getRun(client: ApiClient, runId: string): Promise<Run> {
  return ok(await client.get<Run>(`/api/runs/${runId}`), 200, 'read run');
}

/** Polls a run until it has ended, and returns it. */
export function runEnded(client: ApiClient, runId: string, timeout = 30_000): Promise<Run> {
  return until(
    async () => {
      const run = await getRun(client, runId);
      return TERMINAL.includes(run.status) ? run : undefined;
    },
    { timeout, what: `run ${runId} to end` },
  );
}

export interface StoredEvent {
  seq: number;
  type: string;
  data: Json;
  at: number;
}

/** The whole stored transcript of a session, oldest first. */
export async function transcript(client: ApiClient, sessionId: string): Promise<StoredEvent[]> {
  const all: StoredEvent[] = [];
  for (;;) {
    const after = all.length === 0 ? 0 : all[all.length - 1]!.seq;
    const page = ok(
      await client.get<{ events: StoredEvent[]; hasMore: boolean }>(
        `/api/sessions/${sessionId}/events?after=${after}&limit=1000`,
      ),
      200,
      'read events',
    );
    all.push(...page.events);
    if (!page.hasMore) return all;
  }
}

/** The assistant's words in a session (or one run of it), joined. */
export async function assistantText(
  client: ApiClient,
  sessionId: string,
  runId?: string,
): Promise<string> {
  const events = await transcript(client, sessionId);
  return events
    .filter(
      (event) =>
        event.type === 'message.assistant' && (runId === undefined || event.data.runId === runId),
    )
    .map((event) => event.data.text as string)
    .join('\n');
}

export interface Approval {
  id: string;
  runId: string;
  sessionId: string;
  kind: string;
  toolName: string | null;
  toolKind: string | null;
  toolCallId: string | null;
  title: string;
  command: string | null;
  paths: string[];
  status: string;
  risk: string;
  requiresOwner: boolean;
  suggestedRule: { tool: string; pattern: string | null } | null;
  decidedBy: string | null;
  note: string | null;
  questions: Json;
  plan: string | null;
  expiresAt: number | null;
}

export async function pendingApprovals(client: ApiClient, sessionId: string): Promise<Approval[]> {
  const body = ok(
    await client.get<{ approvals: Approval[] }>(`/api/approvals?sessionId=${sessionId}`),
    200,
    'list approvals',
  );
  return body.approvals;
}

/** Waits until the session has (at least) `count` approvals waiting for a person. */
export function approvalsWaiting(
  client: ApiClient,
  sessionId: string,
  count = 1,
  timeout = 30_000,
): Promise<Approval[]> {
  return until(
    async () => {
      const pending = await pendingApprovals(client, sessionId);
      return pending.length >= count ? pending : undefined;
    },
    { timeout, what: `${count} pending approval(s) in session ${sessionId}` },
  );
}

export function decide(
  client: ApiClient,
  approvalId: string,
  decision: 'allow' | 'deny',
  extra: Record<string, unknown> = {},
): Promise<ApiResponse<Json>> {
  return client.post<Json>(`/api/approvals/${approvalId}/decision`, { decision, ...extra });
}

/** Sends a message, waits for its run to end, and returns the run. */
export async function runToEnd(
  client: ApiClient,
  sessionId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<Run> {
  const receipt = await send(client, sessionId, text, extra);
  expect(receipt.runId, 'the message should have started a run').not.toBeNull();
  return runEnded(client, receipt.runId!);
}

/** Types in the durable log of one run, in order. */
export function typesOf(events: StoredEvent[], runId?: string): string[] {
  return events
    .filter((event) => runId === undefined || event.data.runId === runId)
    .map((event) => event.type);
}

export { ok as expectStatus };

/** Fetches a URL as bytes, signed in as `client` (the browser-like client only reads text). */
export async function download(
  client: ApiClient,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const send: Record<string, string> = { ...headers };
  if (client.cookie) send.cookie = client.cookie;
  if (client.bearer) send.authorization = `Bearer ${client.bearer}`;
  const response = await fetch(client.baseUrl + url, { headers: send, redirect: 'manual' });
  return {
    status: response.status,
    headers: response.headers,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}
