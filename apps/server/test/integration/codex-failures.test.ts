import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Run } from '@agent-studio/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CodexKit, assistantTexts, createCodexKit, eventsOf, processExists } from '../../src/modules/codex/testing/kit.js';
import { until } from '../../src/testing/agents-kit.js';

/** Every way a Codex run can go wrong ends the run once, with a sentence a person can act on. */
describe('when Codex fails', () => {
  let kit: CodexKit;
  beforeAll(async () => {
    kit = await createCodexKit();
  });
  afterAll(async () => {
    await kit.close();
  });
  afterEach(async () => {
    await kit.control({});
  });

  const failed = async (prompt: string, sessionOverrides: Record<string, unknown> = {}): Promise<{ run: Run; sessionId: string }> => {
    const session = await kit.codexSession(sessionOverrides);
    const run = await kit.turn(kit.owner, session.id, prompt);
    const events = await kit.events(kit.owner, session.id);
    // One terminal event, whatever happened.
    expect(eventsOf(events, 'run.finished')).toHaveLength(1);
    expect(eventsOf(events, 'run.finished')[0]!.data).toMatchObject({ status: run.status, error: run.error });
    return { run, sessionId: session.id };
  };

  it('says so when the sign-in has expired in the middle of a session', async () => {
    const { run } = await failed('[[scenario:not-signed-in]]');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'not_signed_in' } });
    expect(run.error!.message).toBe('Codex is not signed in, or its sign-in has expired. Open a terminal with the "Codex sign-in" launcher (it runs `codex login`) and sign in.');
  });

  it('fails at once, before any turn, when nobody is signed in — and the status says the same', async () => {
    await kit.control({ signedIn: false });
    const turns = async (): Promise<number> => (await kit.records()).filter((record) => record.event === 'turn/start').length;
    const turnsBefore = await turns();
    const before = Date.now();
    const { run } = await failed('hello');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'not_signed_in', message: expect.stringContaining('Codex is not signed in.') } });
    expect(Date.now() - before).toBeLessThan(5000);
    expect(await turns()).toBe(turnsBefore);

    await until(async () => (await kit.owner.get<Agent>('/api/agents/codex')).body.status.signedIn === false, { what: 'the status to notice', timeoutMs: 10_000 });
    expect((await kit.owner.get<Agent>('/api/agents/codex')).body.status).toMatchObject({
      installed: true,
      signedIn: false,
      account: null,
      problem: 'Codex is not signed in. Open a terminal with the "Codex sign-in" launcher (it runs `codex login`) and sign in.',
    });
  });

  it('names the usage limit, with what Codex says about when it lifts', async () => {
    const { run } = await failed('[[scenario:usage-limit]]');
    expect(run.error).toMatchObject({ code: 'usage_limit' });
    expect(run.error!.message).toMatch(/^The usage limit of the Codex account has been reached\. Codex says: You've hit your usage limit\..*try again at Oct 14th, 2026 6:46 PM\.$/);
  });

  it('names a model that cannot be used, without showing the raw answer of the service', async () => {
    const { run } = await failed('hello', { model: 'unknown-model-9' });
    expect(run.error).toEqual({
      code: 'model_unavailable',
      message: 'Codex cannot use the model "unknown-model-9": it does not exist, or this account has no access to it. Choose another model for this session.',
    });
  });

  it('says when the connection to the model was lost for good, or the turn failed for a reason of its own', async () => {
    expect((await failed('[[scenario:stream-lost]]')).run.error).toMatchObject({ code: 'connection_lost' });
    expect((await failed('[[scenario:fail-turn the workspace is on fire]]')).run.error).toEqual({ code: 'agent_error', message: 'Codex stopped with an error: the workspace is on fire' });
  });

  it('reports a crash with the last words of the CLI, minus anything that looks like a credential', async () => {
    const { run, sessionId } = await failed('[[scenario:crash]]');
    expect(run.error!.code).toBe('agent_error');
    expect(run.error!.message).toMatch(/^Codex exited with code 3 in the middle of the turn\. Its last words: ERROR codex_core: thread main panicked at the stand-in api_key=\[redacted\]$/);
    expect(run.error!.message).not.toContain('sk-standin');
    // What it had said so far is kept, marked as cut short.
    const partial = eventsOf(await kit.events(kit.owner, sessionId), 'message.assistant');
    expect(partial).toHaveLength(1);
    expect(partial[0]!.data).toMatchObject({ text: 'I was in the middle of ', partial: true });
  });

  it('reports a CLI that was killed', async () => {
    const { run } = await failed('[[scenario:die]]');
    expect(run.error).toMatchObject({ code: 'agent_error', message: expect.stringMatching(/^Codex was stopped by SIGKILL in the middle of the turn\./) });
  });

  it('stops a CLI that writes something that is not the protocol, and leaves no process behind', async () => {
    const { run } = await failed('[[scenario:garbage]]');
    expect(run.error).toMatchObject({ code: 'protocol_error', message: expect.stringContaining('Codex sent something the Studio could not read') });
    const pid = (await kit.records()).findLast((record) => record.event === 'app-server')!.pid;
    await until(() => !processExists(pid), { what: 'the CLI to be stopped' });
  });

  it('reports a CLI that does not start', async () => {
    await kit.control({ startupError: 'failed to load configuration: bad things in config.toml' });
    const { run } = await failed('hello');
    expect(run.error).toEqual({ code: 'agent_error', message: 'Codex exited with code 1 while starting. Its last words: Error: failed to load configuration: bad things in config.toml' });
  });

  it('runs again normally after any of these', async () => {
    const session = await kit.codexSession();
    expect((await kit.turn(kit.owner, session.id, '[[scenario:fail-turn once]]')).status).toBe('failed');
    const run = await kit.turn(kit.owner, session.id, 'and again');
    expect(run.status).toBe('completed');
    expect(assistantTexts(await kit.events(kit.owner, session.id)).at(-1)).toBe('Hello from the Codex stand-in. You said: and again');
  });
});

describe('when the Codex CLI is not installed', () => {
  let kit: CodexKit;
  let bin: string;
  beforeAll(async () => {
    // A PATH with Node.js on it and no `codex`.
    bin = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-no-codex-'));
    await symlink(process.execPath, path.join(bin, 'node'));
    kit = await createCodexKit({ path: bin });
  });
  afterAll(async () => {
    await kit.close();
    await rm(bin, { recursive: true, force: true });
  });

  it('disables only this agent, and says what to do', async () => {
    const agent = (await kit.owner.get<Agent>('/api/agents/codex')).body;
    expect(agent.status).toEqual({
      installed: false,
      version: null,
      signedIn: false,
      account: null,
      problem: 'The Codex command-line tool is not installed for the account this Studio runs as. Install it (`npm install -g @openai/codex`), then sign in.',
    });
    // Nothing is guessed about models it cannot ask for.
    expect(agent.capabilities).toMatchObject({ models: [], defaultModel: null });
    expect((await kit.owner.get<{ agents: Agent[] }>('/api/agents')).status).toBe(200);
  });

  it('fails a run with the same advice', async () => {
    const session = await kit.codexSession();
    const run = await kit.turn(kit.owner, session.id, 'hello');
    expect(run).toMatchObject({ status: 'failed', error: { code: 'not_installed', message: expect.stringContaining('The Codex command-line tool is not installed') } });
    expect(existsSync(path.join(kit.project.rootDir, 'AGENTS.md'))).toBe(false);
  });
});
