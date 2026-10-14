import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathWithout } from './support/gh-standin.js';
import {
  SETUP_TOKEN,
  startTestStudio,
  type ApiClient,
  type RunningStudio,
} from './support/studio.js';
import {
  createMember,
  createProject,
  createSession,
  runToEnd,
  sandboxIsOn,
  SANDBOX_OFF,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.8 — Agents, their models and whether they can be used (requirements 01
 * §6.8, §5.12; AT-WB-083…091, AT-WB-161).
 *
 * `GET /api/agents` is what a model menu is built from: each offered agent,
 * its models and effort levels, the permission modes it supports and whether
 * it is installed and signed in — with a sentence when it is not, and never a
 * credential.
 */
describe('6.8 agents and models', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'agents');
  });
  afterAll(() => studio?.destroy());

  it('AT-WB-083 (adapted): the agent list offers each agent with its models — one marked as recommended — its effort levels, its permission modes and whether it is ready; nothing in it is a credential', async () => {
    const listed = await owner.get<{ agents: Json[] }>('/api/agents');
    expect(listed.status).toBe(200);
    const byId = Object.fromEntries(listed.body.agents.map((agent) => [agent.id, agent]));
    expect(Object.keys(byId).sort()).toEqual(['claude-code', 'codex']);
    // Codex is switched off where agent processes cannot be sandboxed, and says why.
    const sandboxed = await sandboxIsOn(owner);
    for (const agent of listed.body.agents) {
      expect(agent.kind).toBe('cli');
      expect(agent.status).toMatchObject({ installed: true, signedIn: true });
      if (agent.id === 'codex' && !sandboxed) expect(agent.status.problem).toMatch(/sandbox/);
      else expect(agent.status.problem).toBeNull();
      expect(agent.status.version).toMatch(/standin/);
      expect(
        agent.capabilities.models.filter((model: Json) => model.recommended === true),
      ).toHaveLength(1);
      expect(agent.capabilities.models.map((model: Json) => model.id)).toContain(
        agent.capabilities.defaultModel,
      );
      expect(agent.capabilities.permissionModes).toEqual(['plan', 'ask', 'accept-edits', 'auto']); // no "bypass everything"
    }
    expect(
      byId.codex.capabilities.models.map(
        (model: Json) => `${model.id}:${(model.efforts ?? []).join('/')}`,
      ),
    ).toEqual(['standin-large:low/medium/high', 'standin-small:low']);
    expect((await owner.get<Json>('/api/agents/claude-code')).body.displayName).toBe('Claude Code');
    expect((await owner.get('/api/agents/no-such-agent')).status).toBe(404);
    const text = JSON.stringify(listed.body);
    expect(text).not.toContain(SETUP_TOKEN);
    expect(text).not.toMatch(/sk-ant-|oauth|refresh_token|access_token/i);
    // A member sees the same list; a visitor sees none.
    const member = await createMember(studio, owner, 'agentlister');
    expect(
      (await member.get<{ agents: Json[] }>('/api/agents')).body.agents
        .map((agent) => agent.id)
        .sort(),
    ).toEqual(['claude-code', 'codex']);
    expect((await studio.client().get('/api/agents')).status).toBe(401);
  });

  it('WB-090: a session can only be given a permission mode that exists, and a project offers only the agents its owner chose', async () => {
    for (const permissionMode of ['bypass', 'bypassPermissions', 'yolo', 'default', '']) {
      expect(
        (
          await owner.post('/api/sessions', {
            projectId: project.id,
            agentId: 'claude-code',
            permissionMode,
          })
        ).status,
        permissionMode,
      ).toBe(400);
    }
    const session = await createSession(owner, project.id);
    expect(
      (await owner.patch(`/api/sessions/${session.id}`, { permissionMode: 'bypassPermissions' }))
        .status,
    ).toBe(400);
    expect(
      (
        await owner.post(`/api/sessions/${session.id}/messages`, {
          requestId: 'mode-0001',
          text: 'hello',
          permissionMode: 'dontAsk',
        })
      ).status,
    ).toBe(400);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.permissionMode).toBe('ask');

    await owner.patch(`/api/projects/${project.id}`, { agents: ['claude-code'] });
    const refused = await owner.post<ErrorBody>('/api/sessions', {
      projectId: project.id,
      agentId: 'codex',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('agent_not_enabled');
    await owner.patch(`/api/projects/${project.id}`, { agents: null });
  });

  it('WB-086: a model the agent does not have makes the turn fail with a sentence about the model — one failure, and the session can be used again', async () => {
    const session = await createSession(owner, project.id);
    const run = await runToEnd(owner, session.id, 'hello', { model: 'anything-unknown' });
    expect(run.status).toBe('failed');
    expect(run.error!.code).toBe('model_unavailable');
    expect(run.error!.message.toLowerCase()).toContain('model');
    expect(
      (await transcript(owner, session.id)).filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
    await owner.post(`/api/runs/${run.id}/dismiss`);
    expect((await runToEnd(owner, session.id, 'hello again', { model: 'sonnet' })).status).toBe(
      'completed',
    );
  });

  it('AT-WB-087 (adapted): an effort level is passed on only where the agent takes it — otherwise the turn says it was ignored rather than failing or silently pretending', async (context) => {
    const session = await createSession(owner, project.id, 'claude-code', { effort: 'high' });
    const run = await runToEnd(owner, session.id, 'think hard');
    expect(run.status).toBe('completed');
    expect(
      (await transcript(owner, session.id)).find((event) => event.type === 'run.started')!.data
        .effort,
    ).toBe('high');
    const odd = await createSession(owner, project.id, 'claude-code', { effort: 'ludicrous' });
    const ignored = await runToEnd(owner, odd.id, 'think impossibly hard');
    expect(ignored.status).toBe('completed');
    expect(
      (await transcript(owner, odd.id))
        .filter((event) => event.type === 'notice')
        .map((event) => event.data.code),
    ).toContain('effort_ignored');
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const small = await createSession(owner, project.id, 'codex', {
      model: 'standin-small',
      effort: 'low',
    });
    expect((await runToEnd(owner, small.id, 'quick one')).status).toBe('completed');
    expect(
      (await transcript(owner, small.id)).find((event) => event.type === 'run.started')!.data,
    ).toMatchObject({ model: 'standin-small', effort: 'low' });
  });
});

describe('6.8 an agent that is not signed in', () => {
  let studio: RunningStudio;
  let owner: ApiClient;

  beforeAll(async () => {
    studio = await startAgentStudio();
    // The stand-in Codex reads its installation from its home; this one has nobody signed in.
    const codexHome = path.join(studio.dataDir, '..', 'home', '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'standin.json'), JSON.stringify({ signedIn: false }));
    owner = await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-WB-089: its entry says it is installed but not connected, with the reason; the other agent is unaffected; a message to it ends in one readable failure', async (context) => {
    const agents = (await owner.get<{ agents: Json[] }>('/api/agents')).body.agents;
    const codex = agents.find((agent) => agent.id === 'codex');
    expect(codex.status).toMatchObject({ installed: true, signedIn: false, account: null });
    expect(codex.status.problem.length).toBeGreaterThan(10);
    expect(agents.find((agent) => agent.id === 'claude-code').status).toMatchObject({
      installed: true,
      signedIn: true,
      problem: null,
    });

    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const project = await createProject(studio, owner, 'signed-out');
    const session = await createSession(owner, project.id, 'codex');
    const run = await runToEnd(owner, session.id, 'hello?');
    expect(run.status).toBe('failed');
    expect(run.error!.code).toBe('not_signed_in');
    expect(run.error!.message.length).toBeGreaterThan(10);
    expect(
      (await transcript(owner, session.id)).filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.activeRunId).toBeNull();
  });
});

describe('6.8 an agent whose command-line tool is not installed', () => {
  let studio: RunningStudio | null = null;
  let owner: ApiClient;
  let safe = false;

  beforeAll(async () => {
    // A PATH of system folders only: no stand-in, and no real agent CLI installed for whoever runs the tests.
    const withoutClaude = pathWithout('claude');
    const withoutCodex = pathWithout('codex');
    if (withoutClaude === null || withoutCodex === null) return;
    safe = true;
    studio = await startTestStudio({ env: { PATH: withoutClaude, AGENT_STUDIO_SANDBOX: 'auto' } });
    owner = await studio.owner();
  });
  afterAll(() => studio?.destroy());

  it('AT-WB-161: the agent is listed as not installed, with a sentence; a message to it ends with one failed terminal event that says so, and the session is idle', async (context) => {
    if (!safe)
      return context.skip(
        'skipped: this machine has an agent CLI in a system folder, and this test must not start a real one',
      );
    const agents = (await owner.get<{ agents: Json[] }>('/api/agents')).body.agents;
    for (const id of ['claude-code', 'codex']) {
      const agent = agents.find((entry) => entry.id === id);
      expect(agent.status, id).toMatchObject({ installed: false, signedIn: false, version: null });
      expect(agent.status.problem.length, id).toBeGreaterThan(10);
    }
    const project = await createProject(studio!, owner, 'no-cli');
    const created = await owner.post<Json>('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const run = await runToEnd(owner, created.body.id, 'is anyone there?');
    expect(run.status).toBe('failed');
    expect(run.error!.code).toBe('not_installed');
    expect(run.error!.message.toLowerCase()).toContain('not installed');
    const events = await transcript(owner, created.body.id);
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(events.at(-1)!.data).toMatchObject({
      status: 'failed',
      error: { code: 'not_installed' },
    });
    expect((await owner.get<Json>(`/api/sessions/${created.body.id}`)).body.activeRunId).toBeNull();
  });
});
