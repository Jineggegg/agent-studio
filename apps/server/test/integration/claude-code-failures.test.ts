import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Attachment, Run, UploadAttachmentsResponse } from '@agent-studio/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeCodeAdapter } from '../../src/modules/claude-code/claude-code.module.js';
import { type ClaudeKit, STANDIN_BIN, createClaudeKit } from '../../src/modules/claude-code/testing/kit.js';
import { until } from '../../src/testing/agents-kit.js';
import { TEST_HOST } from '../../src/testing/harness.js';

/**
 * What the Claude Code adapter does when things go wrong, and what it keeps
 * from the CLI: failures a person can act on, the run's bridge token, the
 * server's environment, and — where bubblewrap works — the Studio's data.
 */

const alive = (pid: number): boolean => existsSync(`/proc/${pid}`);

/** Every process on this machine whose command line contains `needle`. */
function processesMentioning(needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const commandLine = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (commandLine.includes(needle)) found.push(commandLine.replace(/\0/g, ' '));
    } catch {
      /* gone meanwhile, or not ours to read */
    }
  }
  return found;
}

describe('failures of the CLI', () => {
  let c: ClaudeKit;
  beforeAll(async () => {
    c = await createClaudeKit();
  });
  afterAll(async () => {
    await c.close();
  });

  const failed = async (prompt: string, extra: Record<string, unknown> = {}): Promise<{ run: Run; sessionId: string }> => {
    const session = await c.session(extra);
    const run = await c.turn(session.id, prompt);
    expect(run.status).toBe('failed');
    // Whatever went wrong: one terminal event, and a sentence — never a stack trace or raw JSON.
    const events = await c.events(session.id);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'failed', error: run.error } });
    expect(run.error!.message).not.toMatch(/\n|\bat .*\(.*:\d+:\d+\)|^\{/);
    expect(run.error!.message.length).toBeLessThan(900);
    return { run, sessionId: session.id };
  };

  it('"not signed in" names the sign-in launcher as the fix and is not shown as something the model said', async () => {
    const { run, sessionId } = await failed('[[scenario:not-signed-in]]');
    expect(run.error).toEqual({ code: 'not_signed_in', message: expect.stringContaining('claude-login') });
    expect(run.error!.message).toMatch(/not signed in/i);
    expect(await c.texts(sessionId)).toEqual([]);
  });

  it('a signed-out CLI fails the same way, and the status then says so without waiting for its cache', async () => {
    const adapter = c.kit.t.studio.context.services.agents.adapter('claude-code') as ClaudeCodeAdapter;
    expect((await adapter.status()).signedIn).toBe(true);
    c.signedIn(false);
    try {
      const { run } = await failed('hello?');
      expect(run.error!.code).toBe('not_signed_in');
      const status = (await c.owner.get<Agent>('/api/agents/claude-code')).body.status;
      expect(status).toMatchObject({ installed: true, signedIn: false });
      expect(status.problem).toContain('claude-login');
    } finally {
      c.signedIn(true);
      adapter.cli.forget();
    }
  });

  it('"usage limit reached" keeps the CLI\'s sentence about when it resets', async () => {
    const { run, sessionId } = await failed('[[scenario:usage-limit]]');
    expect(run.error!.code).toBe('rate_limited');
    expect(run.error!.message).toMatch(/usage limit has been reached/);
    expect(run.error!.message).toContain('resets 3pm (UTC)');
    expect(await c.eventsOf(sessionId, 'notice')).toEqual([expect.objectContaining({ level: 'error', code: 'rate_limit', text: "Claude's five-hour usage limit has been reached; it resets at 2026-10-14 01:00 UTC." })]);
  });

  it('"model not available" names the model that was asked for', async () => {
    const { run } = await failed('hi', { model: 'no-such-model' });
    expect(run.error!.code).toBe('model_unavailable');
    expect(run.error!.message).toContain('"no-such-model"');
    expect(c.argOf(c.lastInvocation(), '--model')).toBe('no-such-model');
  });

  it('a model name that could be mistaken for an option never reaches the command line', async () => {
    const before = c.invocations().length;
    const { run } = await failed('hi', { model: '--dangerously-skip-permissions' });
    expect(run.error!.code).toBe('model_unavailable');
    expect(c.invocations().length).toBe(before);
  });

  it('an overloaded model service and an error result are told apart', async () => {
    expect((await failed('[[scenario:overloaded]]')).run.error).toEqual({ code: 'overloaded', message: expect.stringMatching(/not answering right now.*Overloaded/) });
    expect((await failed('[[scenario:error-result]]')).run.error).toEqual({ code: 'agent_error', message: 'Claude Code reported a problem: Something went wrong inside the stand-in.' });
  });

  it('a crash keeps what was streamed, quotes the end of the error output, and masks anything secret in it', async () => {
    const logs = c.captureLogs();
    const { run, sessionId } = await failed('[[scenario:crash]]');
    expect(run.error!.code).toBe('agent_crashed');
    expect(run.error!.message).toMatch(/exit code 3/);
    expect(run.error!.message).toContain('the stand-in crashed on purpose');
    expect(run.error!.message).toContain('[redacted]');
    expect(run.error!.message).not.toContain('sk-ant-api03');
    expect(await c.texts(sessionId)).toEqual(['Starting, and then']);
    // The log line about it is masked the same way.
    const logged = JSON.stringify(logs);
    expect(logged).toContain('Claude Code did not finish the turn');
    expect(logged).not.toContain('sk-ant-api03');
  });

  it('output that is not the machine-readable format is reported with the line that could not be read', async () => {
    const { run } = await failed('[[scenario:garbage]]');
    expect(run.error).toEqual({ code: 'agent_protocol', message: expect.stringContaining('Segmentation fault (this is not JSON)') });
  });

  it('a CLI that is killed mid-answer leaves its partial text in the transcript', async () => {
    const { run, sessionId } = await failed('[[scenario:die]]');
    expect(run.error!.code).toBe('agent_crashed');
    expect(run.error!.message).toContain('SIGKILL');
    const stored = await c.eventsOf(sessionId, 'message.assistant');
    expect(stored).toEqual([expect.objectContaining({ text: 'Half an ans', partial: true })]);
  });

  it('a failed turn can be followed by a normal one in the same conversation', async () => {
    const { sessionId } = await failed('[[scenario:overloaded]]');
    // The failed run has to be dealt with before the session takes the next message from a queue; a direct send works at once.
    const next = await c.turn(sessionId, '[[scenario:recall]]');
    expect(next.status).toBe('completed');
    expect(c.argOf(c.lastInvocation(), '--resume')).toBe(await c.nativeId(sessionId));
    expect((await c.texts(sessionId)).at(-1)).toContain('1) [[scenario:overloaded]]');
  });

  it('runs two conversations at once, each with its own process', async () => {
    const [one, two] = [await c.session(), await c.session()];
    const [first, second] = await Promise.all([c.send(one.id, 'alpha [[scenario:long 12]]'), c.send(two.id, 'beta')]);
    const [a, b] = await Promise.all([c.runEnded(first.body.runId!), c.runEnded(second.body.runId!)]);
    expect([a.status, b.status]).toEqual(['completed', 'completed']);
    expect((await c.texts(one.id))[0]).toMatch(/^tick 1 .*tick 12 $/);
    expect((await c.texts(two.id))[0]).toContain('“beta”');
    expect(await c.nativeId(one.id)).not.toBe(await c.nativeId(two.id));
  });
});

describe('a missing or unusable CLI', () => {
  let c: ClaudeKit | null = null;
  let bin: string;
  afterEach(async () => {
    await c?.close();
    c = null;
    rmSync(bin, { recursive: true, force: true });
  });

  const withCli = async (script: string | null): Promise<ClaudeKit> => {
    bin = mkdtempSync(path.join(os.tmpdir(), 'agent-studio-claude-bin-'));
    if (script !== null) {
      writeFileSync(path.join(bin, 'claude'), script);
      chmodSync(path.join(bin, 'claude'), 0o755);
    }
    c = await createClaudeKit({ bin });
    return c;
  };
  const standin = path.join(STANDIN_BIN, 'claude');

  it('disables only this agent, with a status that says what to do', async () => {
    const kit = await withCli(null);
    const agents = (await kit.owner.get<{ agents: Agent[] }>('/api/agents')).body.agents;
    const claude = agents.find((agent) => agent.id === 'claude-code')!;
    expect(claude.status).toMatchObject({ installed: false, version: null, signedIn: false, account: null });
    expect(claude.status.problem).toMatch(/not installed/);
    // Its capabilities are still described, and the other agents are untouched.
    expect(claude.capabilities.models.map((model) => model.id)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(agents.find((agent) => agent.id === 'scripted')!.status.installed).toBe(true);

    const session = await kit.session();
    const run = await kit.turn(session.id, 'anyone there?');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'not_installed', message: expect.stringMatching(/not installed/) } });
    // The scripted agent next to it works.
    const other = await kit.kit.session(kit.owner);
    expect((await kit.kit.turn(kit.owner, other.id, 'hi')).status).toBe('completed');
  });

  it('says that a CLI without the options it needs is too old, and does not start it', async () => {
    const kit = await withCli(`#!/bin/sh
case "$1" in
  --version) echo "0.2.9 (Claude Code)" ;;
  --help) printf 'Usage: claude [options]\\n\\nOptions:\\n  -p, --print        Print response and exit\\n  --model <model>    Model to use\\n' ;;
  *) echo "should never be started for a turn" >&2; exit 64 ;;
esac
`);
    const status = (await kit.owner.get<Agent>('/api/agents/claude-code')).body.status;
    expect(status).toMatchObject({ installed: true, version: '0.2.9', signedIn: false });
    expect(status.problem).toMatch(/too old/);
    const session = await kit.session();
    const run = await kit.turn(session.id, 'hello');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'cli_incompatible', message: expect.stringMatching(/too old.*Update Claude Code/) } });
  });

  it('explains an option the CLI rejects instead of showing its usage error raw', async () => {
    const kit = await withCli(`#!/bin/sh
case "$1" in
  --version|--help|auth) exec "${standin}" "$@" ;;
  *) echo "error: unknown option '--replay-user-messages'" >&2; exit 1 ;;
esac
`);
    expect((await kit.owner.get<Agent>('/api/agents/claude-code')).body.status.problem).toBeNull();
    const session = await kit.session();
    const run = await kit.turn(session.id, 'hello');
    expect(run.status).toBe('failed');
    expect(run.error!.code).toBe('cli_incompatible');
    expect(run.error!.message).toContain("unknown option '--replay-user-messages'");
    expect(run.error!.message).toMatch(/Update Claude Code/);
  });

  it('does not make the list of agents wait for a slow sign-in check', async () => {
    const kit = await withCli(`#!/bin/sh
case "$1" in
  auth) sleep 4; exec "${standin}" "$@" ;;
  *) exec "${standin}" "$@" ;;
esac
`);
    const startedAt = Date.now();
    const first = (await kit.owner.get<Agent>('/api/agents/claude-code')).body.status;
    expect(Date.now() - startedAt).toBeLessThan(3500);
    // Honest in the meantime: installed, version known, sign-in still being checked.
    expect(first).toMatchObject({ installed: true, version: '2.1.283-standin', signedIn: false, account: null });
    expect(first.problem).toMatch(/Still checking/);
    const adapter = kit.kit.t.studio.context.services.agents.adapter('claude-code') as ClaudeCodeAdapter;
    const settled = await adapter.cli.settledStatus();
    expect(settled).toMatchObject({ signedIn: true, account: 'standin@example.test (max)', problem: null });
    expect((await kit.owner.get<Agent>('/api/agents/claude-code')).body.status).toEqual(settled);
  });

  it('admits that it does not know the sign-in state when the CLI gives no readable answer', async () => {
    const kit = await withCli(`#!/bin/sh
case "$1" in
  auth) echo "error: unknown command 'auth'" >&2; exit 1 ;;
  *) exec "${standin}" "$@" ;;
esac
`);
    const status = (await kit.owner.get<Agent>('/api/agents/claude-code')).body.status;
    expect(status).toMatchObject({ installed: true, version: '2.1.283-standin', account: null });
    expect(status.problem).toMatch(/not known whether Claude Code is signed in/);
    expect(status.problem).toContain('claude-login');
    // A turn is still attempted, and works: the status was a statement of ignorance, not a verdict.
    const session = await kit.session();
    expect((await kit.turn(session.id, 'hello')).status).toBe('completed');
  });
});

describe('what the CLI is and is not given', () => {
  let c: ClaudeKit;
  const planted = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'planted-oauth-token-0123456789', ANTHROPIC_API_KEY: 'sk-ant-api03-planted0123456789abcdefghij', AGENT_STUDIO_PLANTED: 'server-secret-0123456789', STUDIO_TEST_HARMLESS: 'harmless-value' };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const [name, value] of Object.entries(planted)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
    // Even an operator who lists them cannot hand the CLI an API key or a surrounding session's markers.
    c = await createClaudeKit({ config: { childEnvPassthrough: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'STUDIO_TEST_HARMLESS'] } });
  });
  afterAll(async () => {
    await c.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('gets a scrubbed environment: nothing of the server\'s, no API key, no trace of a surrounding Claude Code session', async () => {
    const session = await c.session();
    await c.turn(session.id, '[[scenario:inspect]]');
    const report = JSON.parse((await c.texts(session.id))[0]!) as { envNames: string[]; cwd: string };
    expect(report.cwd).toBe(c.kit.project.rootDir);
    expect(report.envNames).toEqual(expect.arrayContaining(['HOME', 'PATH', 'STUDIO_TEST_HARMLESS']));
    expect(report.envNames.filter((name) => /^(AGENT_STUDIO_|CLAUDECODE$|CLAUDE_|ANTHROPIC_|STUDIO_BRIDGE_)/.test(name))).toEqual([]);
    const { env } = c.lastInvocation();
    expect(env.STUDIO_TEST_HARMLESS).toBe('harmless-value');
    const values = Object.values(env).join('\n');
    for (const secret of [planted.CLAUDE_CODE_OAUTH_TOKEN, planted.ANTHROPIC_API_KEY, planted.AGENT_STUDIO_PLANTED]) expect(values).not.toContain(secret);
    // The status command runs in the same environment, in a neutral directory.
    expect((await c.owner.get<Agent>('/api/agents/claude-code')).body.status.signedIn).toBe(true);
  });

  it('never shows the bridge token: not on a command line, not in an event, not in a log, and not after the run', async () => {
    const logs = c.captureLogs();
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:unknown-event]] [[scenario:edit-file token-check.txt]]');
    const approval = await c.pendingApproval(session.id);
    const invocation = c.lastInvocation();
    const source = invocation.mcpConfig[0]!;
    const config = JSON.parse(source.text!) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(['studio']);
    const token = config.mcpServers.studio!.env.STUDIO_BRIDGE_TOKEN!;
    expect(token.length).toBeGreaterThanOrEqual(40);

    // The configuration reached the CLI as a file only this account can read, in a folder of its own…
    expect(source.file).toBe(c.argOf(invocation, '--mcp-config'));
    expect(statSync(source.file!).mode & 0o077).toBe(0);
    expect(statSync(path.dirname(source.file!)).mode & 0o077).toBe(0);
    // …so neither the CLI's command line nor its environment holds the token, and no process list shows it.
    expect(invocation.argv.join('\n')).not.toContain(token);
    expect(Object.values(invocation.env).join('\n')).not.toContain(token);
    expect(readFileSync(`/proc/${invocation.pid}/cmdline`, 'utf8')).not.toContain(token);
    expect(readFileSync(`/proc/${invocation.pid}/environ`, 'utf8')).not.toContain(token);
    expect(processesMentioning(token)).toEqual([]);
    // The token is live while the run is.
    const call = (bearer: string) => c.kit.t.studio.app.inject({ method: 'POST', url: '/api/bridge/tools/list', headers: { host: TEST_HOST, 'content-type': 'application/json', 'x-studio-bridge-token': bearer }, payload: {} });
    expect((await call(token)).statusCode).toBe(200);

    await c.decide(approval.id, { decision: 'allow' });
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');

    // Nothing a client can read, and nothing stored, contains it.
    const visible = JSON.stringify([await c.events(session.id), await c.kit.state(c.owner, session.id), run, (await c.owner.get('/api/approvals?status=all')).body]);
    expect(visible).not.toContain(token);
    const db = c.kit.t.studio.context.db;
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      expect(JSON.stringify(db.all(`SELECT * FROM "${name}"`)), `table ${name}`).not.toContain(token);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(token);
    // And when the run is over the file is gone and the token is worthless.
    expect(existsSync(source.file!)).toBe(false);
    expect(existsSync(path.dirname(source.file!))).toBe(false);
    expect((await call(token)).statusCode).toBe(401);
    await until(() => !alive(invocation.pid), { what: 'the CLI process to be gone', timeoutMs: 5000 });
  });

  it('is stopped with the server: no process outlives it', async () => {
    const other = await createClaudeKit();
    let pid = 0;
    try {
      const session = await other.session();
      await other.send(session.id, '[[scenario:long 400]]');
      await until(async () => (await other.kit.state(other.owner, session.id)).streaming.length > 0, { what: 'the answer to start streaming', timeoutMs: 20_000 });
      pid = other.lastInvocation().pid;
      expect(alive(pid)).toBe(true);
    } finally {
      await other.close();
    }
    await until(() => !alive(pid), { what: 'the CLI process to end with the server', timeoutMs: 5000 });
  });
});

describe('inside the sandbox', () => {
  let c: ClaudeKit;
  let sandboxed = false;
  beforeAll(async () => {
    c = await createClaudeKit({ config: { sandbox: 'auto' } });
    sandboxed = c.kit.t.studio.context.sandbox.status.mode === 'bwrap';
  });
  afterAll(async () => {
    await c.close();
  });

  const upload = async (sessionId: string, name: string, content: string): Promise<Attachment> => {
    const boundary = `----claude-sandbox-${Math.random().toString(16).slice(2)}`;
    const body = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="${name}"\r\ncontent-type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`);
    const response = await c.owner.request<UploadAttachmentsResponse>('POST', `/api/sessions/${sessionId}/attachments`, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    return response.body.attachments[0]!;
  };

  it('the CLI cannot read the Studio\'s data directory, yet works, reaches the bridge and reads its attachments', async ({ skip }) => {
    skip(!sandboxed, 'bubblewrap is not usable on this machine, so there is no sandbox to test');
    const dataDir = c.kit.t.dataDir;
    const database = path.join(dataDir, 'studio.db');
    expect(existsSync(database)).toBe(true);

    const session = await c.session();
    const run = await c.turn(session.id, `[[scenario:inspect ${database} ${dataDir} ${c.kit.project.rootDir}]]`);
    expect(run.status).toBe('completed');
    const report = JSON.parse((await c.texts(session.id))[0]!) as { canRead: Record<string, boolean | number> };
    // The database is not there for the CLI, and the directory it lives in looks empty.
    expect(report.canRead[database]).toBe(false);
    expect(report.canRead[dataDir]).toBe(0);
    expect(typeof report.canRead[c.kit.project.rootDir]).toBe('number');

    // A permission prompt travels out of the sandbox to the Studio and back.
    const sent = await c.send(session.id, '[[scenario:edit-file from-the-sandbox.txt]]');
    const approval = await c.pendingApproval(session.id);
    await c.decide(approval.id, { decision: 'allow' });
    expect((await c.runEnded(sent.body.runId!)).status).toBe('completed');
    expect(readFileSync(path.join(c.kit.project.rootDir, 'from-the-sandbox.txt'), 'utf8')).toBe('written by the stand-in\n');

    // Attachments are let back in — read-only, and nothing else of the data directory with them.
    const notes = await upload(session.id, 'notes.txt', 'visible inside the sandbox');
    const folder = path.join(dataDir, 'attachments', session.id);
    const third = await c.turn(session.id, `[[scenario:read-attachment]] [[scenario:inspect ${database} ${folder}]]`, { attachmentIds: [notes.id] });
    expect(third.status).toBe('completed');
    const texts = await c.texts(session.id);
    expect(texts.at(-2)).toContain('says: visible inside the sandbox');
    const again = JSON.parse(texts.at(-1)!) as { canRead: Record<string, boolean | number> };
    expect(again.canRead[database]).toBe(false);
    expect(again.canRead[folder]).toBe(1);
  });

  it('stopping reaches through the sandbox: nothing is left running', async ({ skip }) => {
    skip(!sandboxed, 'bubblewrap is not usable on this machine, so there is no sandbox to test');
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:long 400]]');
    await until(async () => (await c.kit.state(c.owner, session.id)).streaming.length > 0, { what: 'the answer to start streaming', timeoutMs: 20_000 });
    // Inside its own process namespace the CLI's pid means nothing here: find it by its configuration file.
    const configFile = c.argOf(c.lastInvocation(), '--mcp-config')!;
    expect(processesMentioning(configFile).length).toBeGreaterThanOrEqual(2);
    expect(processesMentioning(configFile).some((commandLine) => commandLine.startsWith('bwrap '))).toBe(true);
    await c.owner.post(`/api/sessions/${session.id}/stop`);
    expect((await c.runEnded(sent.body.runId!)).status).toBe('stopped');
    await until(() => processesMentioning(configFile).length === 0, { what: 'the sandboxed CLI to be gone', timeoutMs: 5000 });
  });
});
