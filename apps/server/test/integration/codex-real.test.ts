import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Approval, Run, SessionEvent } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_BIN } from '../../src/modules/codex/testing/kit.js';
import { type AgentsKit, createAgentsKit, until } from '../../src/testing/agents-kit.js';

/**
 * The smoke test against the REAL Codex CLI. It is skipped unless asked for,
 * because every turn costs the signed-in account real quota:
 *
 *   STUDIO_CODEX_SMOKE=1 npx vitest run --project server-integration apps/server/test/integration/codex-real.test.ts
 *
 * It starts a temporary Studio (data and project under the system's temporary
 * directory), drives the `codex` on PATH through the real adapter with the
 * service account's own sign-in, and runs six short turns: a plain question,
 * a resumed conversation, a file creation that is approved, one that is
 * refused, a call of a Studio tool through the bridge, and a stop in the
 * middle of an answer. What it saw is written, without message text, to
 * `$STUDIO_CODEX_SMOKE_REPORT` (default: `<tmpdir>/codex-smoke-report.json`).
 *
 * Optional:
 *   STUDIO_CODEX_SMOKE_MODEL=<model>     a cheap model to run the turns with (default: the CLI's own default)
 *   STUDIO_CODEX_SMOKE_EFFORT=<effort>   its reasoning effort, e.g. low
 *   STUDIO_CODEX_SMOKE_SANDBOX=off       run without the Studio's sandbox (default: auto, as in production)
 *   STUDIO_CODEX_SMOKE_STEPS=b,c,e       only these steps (a, d, b, c, f, e); "d" needs "a" in the same run
 *   STUDIO_CODEX_SMOKE_HOME=<dir>        a Codex home to use instead of the account's own (for rehearsing against a mock model)
 *
 * See docs/guides/agent-smoke-test.md.
 */

const enabled = Boolean(process.env.STUDIO_CODEX_SMOKE);
const steps = (process.env.STUDIO_CODEX_SMOKE_STEPS ?? 'a,d,b,c,f,e').split(',').map((step) => step.trim());
const wanted = (step: string): boolean => steps.includes(step);
const TURN_TIMEOUT_MS = 180_000;

interface Observation {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

describe.skipIf(!enabled)('smoke test: the real Codex CLI through the adapter', () => {
  let kit: AgentsKit;
  let root: string;
  const observations: Observation[] = [];
  const savedHome = process.env.CODEX_HOME;
  const savedPath = process.env.PATH;
  const model = process.env.STUDIO_CODEX_SMOKE_MODEL;
  const effort = process.env.STUDIO_CODEX_SMOKE_EFFORT;

  beforeAll(async () => {
    // Every other integration test gets the stand-ins first on PATH (test/setup.ts). This one wants the real program.
    process.env.PATH = (savedPath ?? '')
      .split(path.delimiter)
      .filter((entry) => entry !== '' && path.resolve(entry) !== path.resolve(FIXTURE_BIN))
      .join(path.delimiter);
    if (process.env.STUDIO_CODEX_SMOKE_HOME) process.env.CODEX_HOME = process.env.STUDIO_CODEX_SMOKE_HOME;
    kit = await createAgentsKit({
      config: {
        // Without the sandbox Codex runs only where the operator said so; asking for "off" here says so.
        ...(process.env.STUDIO_CODEX_SMOKE_SANDBOX === 'off' ? { sandbox: 'off' as const, codexWithoutSandbox: true } : { sandbox: 'auto' as const }),
        ...(process.env.STUDIO_CODEX_SMOKE_HOME ? { childEnvPassthrough: ['CODEX_HOME'] } : {}),
      },
    });
    root = kit.project.rootDir;
    // The bridge is a separate process and needs a port to call back on (an ephemeral one, on this machine only).
    await kit.listen();
  }, 60_000);

  afterAll(async () => {
    const report = process.env.STUDIO_CODEX_SMOKE_REPORT ?? path.join(os.tmpdir(), 'codex-smoke-report.json');
    await writeFile(report, `${JSON.stringify({ at: new Date().toISOString(), sandbox: kit?.t.studio.context.sandbox.status, observations }, null, 2)}\n`);
    await kit?.close();
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    process.env.PATH = savedPath;
  }, 60_000);

  const ended = (runId: string): Promise<Run> =>
    until(
      async () => {
        const run = (await kit.owner.get<Run>(`/api/runs/${runId}`)).body;
        return run.status !== 'accepted' && run.status !== 'running' ? run : null;
      },
      { timeoutMs: TURN_TIMEOUT_MS, what: 'the turn to end' },
    );

  /** Sends a message and answers every approval the same way until the turn ends. */
  async function turn(sessionId: string, text: string, answer: 'allow' | 'deny' | null = null): Promise<{ run: Run; approvals: Approval[]; events: SessionEvent[] }> {
    const before = (await kit.events(kit.owner, sessionId)).length;
    const sent = await kit.send(kit.owner, sessionId, text);
    expect(sent.status).toBe(202);
    const approvals: Approval[] = [];
    const run = await until(
      async () => {
        const current = (await kit.owner.get<Run>(`/api/runs/${sent.body.runId}`)).body;
        if (current.status !== 'accepted' && current.status !== 'running') return current;
        for (const approval of (await kit.state(kit.owner, sessionId)).pendingApprovals) {
          approvals.push(approval);
          await kit.owner.post(`/api/approvals/${approval.id}/decision`, { decision: answer ?? 'deny', ...(answer === 'deny' ? { note: 'Not this time: the smoke test refuses this on purpose.' } : {}) });
        }
        return null;
      },
      { timeoutMs: TURN_TIMEOUT_MS, what: 'the turn to end' },
    );
    return { run, approvals, events: (await kit.events(kit.owner, sessionId)).slice(before) };
  }

  const shape = (events: SessionEvent[]): string[] => events.map((event) => (event.type === 'tool.started' ? `tool.started(${event.data.name}:${event.data.kind})` : event.type === 'tool.finished' ? `tool.finished(${event.data.status})` : event.type === 'notice' ? `notice(${event.data.code})` : event.type));
  const said = (events: SessionEvent[]): string => events.filter((event) => event.type === 'message.assistant').map((event) => event.data.text).join('\n');
  const describeApproval = (approval: Approval): Record<string, unknown> => ({ toolName: approval.toolName, toolKind: approval.toolKind, title: approval.title, command: approval.command, paths: approval.paths.map((file) => path.relative(root, file)), hasDiff: approval.diff !== null, risk: approval.risk });
  const note = (step: string, ok: boolean, detail: Record<string, unknown>): void => {
    observations.push({ step, ok, detail });
  };

  /** The app-server processes this Studio started (recognised by the bridge they were given). */
  async function ourProcesses(): Promise<string[]> {
    const result = await kit.t.studio.context.processes.run('ps', ['-eo', 'pid,args']);
    return result.stdout.split('\n').filter((line) => line.includes('app-server') && line.includes('mcp_servers.studio.env_vars=') && !line.includes('ps -eo'));
  }

  let sessionId = '';

  it('status: installed, signed in, and the models the CLI offers', async () => {
    const agent = (await kit.owner.get<Agent>('/api/agents/codex')).body;
    note('status', agent.status.installed && agent.status.problem === null, {
      installed: agent.status.installed,
      version: agent.status.version,
      signedIn: agent.status.signedIn,
      hasAccountLabel: agent.status.account !== null,
      problem: agent.status.problem,
      models: agent.capabilities.models.map((entry) => `${entry.id}${entry.efforts ? ` [${entry.efforts.join(',')}]` : ''}`),
      defaultModel: agent.capabilities.defaultModel,
    });
    expect(agent.status.installed).toBe(true);
    // The real program, not the stand-in the other tests use.
    expect(agent.status.version).not.toMatch(/standin/);
    if (!process.env.STUDIO_CODEX_SMOKE_HOME) expect(agent.status).toMatchObject({ signedIn: true, problem: null });
    const session = await kit.session(kit.owner, { agentId: 'codex', ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    sessionId = session.id;
  }, 120_000);

  it.skipIf(!wanted('a'))('(a) answers a plain question, streaming', async () => {
    const { run, events } = await turn(sessionId, 'Reply with exactly the single word: pong');
    const usage = events.find((event) => event.type === 'usage.reported');
    note('a: plain question', run.status === 'completed' && /pong/i.test(said(events)), { run: run.status, error: run.error, events: shape(events), answer: said(events).slice(0, 80), usage: usage?.data });
    expect(run).toMatchObject({ status: 'completed', error: null });
    expect(said(events)).toMatch(/pong/i);
    expect(usage).toBeDefined();
  }, TURN_TIMEOUT_MS + 30_000);

  it.skipIf(!wanted('d'))('(d) resumes the conversation in a new process', async () => {
    const { run, events } = await turn(sessionId, 'Which single word did you reply with just before? Answer with that word only.');
    note('d: resume', run.status === 'completed' && /pong/i.test(said(events)), { run: run.status, error: run.error, events: shape(events), answer: said(events).slice(0, 80) });
    expect(run.status).toBe('completed');
    expect(said(events)).toMatch(/pong/i);
    expect(events.some((event) => event.type === 'notice' && event.data.code === 'resume_unavailable')).toBe(false);
  }, TURN_TIMEOUT_MS + 30_000);

  it.skipIf(!wanted('b'))('(b) asks before it creates a file, and creates it once allowed', async () => {
    const { run, approvals, events } = await turn(sessionId, 'Create a file named smoke-approved.txt in the current directory containing exactly the word hello. Do nothing else, and then say done.', 'allow');
    const created = existsSync(path.join(root, 'smoke-approved.txt'));
    note('b: approved', run.status === 'completed' && approvals.length > 0 && created, { run: run.status, error: run.error, approvals: approvals.map(describeApproval), events: shape(events), created, content: created ? (await readFile(path.join(root, 'smoke-approved.txt'), 'utf8')).slice(0, 40) : null, answer: said(events).slice(0, 300) });
    expect(run.status).toBe('completed');
    expect(approvals.length).toBeGreaterThan(0);
    expect(created).toBe(true);
  }, TURN_TIMEOUT_MS + 30_000);

  it.skipIf(!wanted('c'))('(c) does not create a file that is refused', async () => {
    const { run, approvals, events } = await turn(sessionId, 'Create a file named smoke-denied.txt in the current directory containing exactly the word no. If you are not allowed to, do not try another way: just say that it was not allowed.', 'deny');
    const created = existsSync(path.join(root, 'smoke-denied.txt'));
    note('c: denied', run.status === 'completed' && approvals.length > 0 && !created, { run: run.status, error: run.error, approvals: approvals.map(describeApproval), events: shape(events), created, answer: said(events).slice(0, 200) });
    expect(run.status).toBe('completed');
    expect(approvals.length).toBeGreaterThan(0);
    expect(created).toBe(false);
    expect(events.some((event) => event.type === 'tool.finished' && event.data.status === 'denied')).toBe(true);
  }, TURN_TIMEOUT_MS + 30_000);

  it.skipIf(!wanted('f'))("(f) calls one of the Studio's tools through the bridge", async () => {
    const { run, events } = await turn(sessionId, 'Call the memory_search tool of the studio MCP server with the query "smoke test" and tell me in one short sentence what it returned.');
    const call = events.find((event) => event.type === 'tool.started' && event.data.name.startsWith('mcp__studio__'));
    const finished = events.find((event) => event.type === 'tool.finished' && call?.type === 'tool.started' && event.data.toolCallId === call.data.toolCallId);
    note('f: studio tool', run.status === 'completed' && call !== undefined, { run: run.status, error: run.error, events: shape(events), tool: call?.type === 'tool.started' ? call.data.name : null, toolStatus: finished?.type === 'tool.finished' ? finished.data.status : null });
    expect(run.status).toBe('completed');
    expect(call).toBeDefined();
    expect(finished).toMatchObject({ data: { status: 'ok' } });
  }, TURN_TIMEOUT_MS + 30_000);

  it.skipIf(!wanted('e'))('(e) stops in the middle of an answer and leaves no process behind', async () => {
    const sent = await kit.send(kit.owner, sessionId, 'Write a story of about 600 words about a lighthouse keeper. Use no tools.');
    const streamed = await until(
      async () => {
        const state = await kit.state(kit.owner, sessionId);
        const text = state.streaming.find((block) => block.kind === 'text')?.text ?? '';
        if (text.length >= 40) return text;
        if (state.run === null) return 'ended-before-stop';
        return null;
      },
      { timeoutMs: TURN_TIMEOUT_MS, what: 'the answer to start streaming' },
    );
    const during = await ourProcesses();
    await kit.owner.post(`/api/sessions/${sessionId}/stop`);
    const run = await ended(sent.body.runId!);
    const events = await kit.events(kit.owner, sessionId);
    const last = events.findLast((event) => event.type === 'message.assistant');
    await until(async () => (await ourProcesses()).length === 0, { timeoutMs: 10_000, what: 'the CLI process to be gone' });
    note('e: stop', run.status === 'stopped', { run: run.status, streamedBeforeStop: streamed.length, processesDuring: during.length, processesAfter: (await ourProcesses()).length, partialKept: last?.type === 'message.assistant' ? { partial: last.data.partial, chars: last.data.text.length } : null, terminalEvents: events.filter((event) => event.type === 'run.finished' && event.data.runId === sent.body.runId).length });
    expect(run.status).toBe('stopped');
    expect(events.filter((event) => event.type === 'run.finished' && event.data.runId === sent.body.runId)).toHaveLength(1);
    expect(await ourProcesses()).toEqual([]);
  }, TURN_TIMEOUT_MS + 60_000);
});
