import { type Approval, type ApprovalDecisionResponse, type ServerFrame, type Session, sessionTopic, userTopic } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../src/modules/agents/adapter.js';
import { type AgentsKit, createAgentsKit, until } from '../../src/testing/agents-kit.js';
import type { TestClient, TestResponse } from '../../src/testing/harness.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

/**
 * Approving a plan lets the work start: the session leaves plan mode in the
 * same step as the approval is recorded, so the agent's next request is
 * decided under the new mode. Nothing else about approvals changes.
 */

const plan: PermissionRequest = { approval: 'plan', toolName: 'ExitPlanMode', kind: 'other', input: { plan: '1. Fix the bug' }, plan: '1. Fix the bug' };
const edit = (file: string): PermissionRequest => ({ toolName: 'Edit', kind: 'edit', input: { file_path: file }, paths: [file], diff: `--- a/${file}\n+++ b/${file}\n+new line` });
const bash = (command: string): PermissionRequest => ({ toolName: 'Bash', kind: 'execute', title: `Run ${command}`, input: { command }, command });

describe('approving a plan', () => {
  let kit: AgentsKit;
  // An agent that cannot work in accept-edits or auto.
  const limited = new ScriptedAdapter({ id: 'limited', displayName: 'Limited agent', permissionModes: ['plan', 'ask'] });
  beforeAll(async () => {
    kit = await createAgentsKit({ adapters: [new ScriptedAdapter(), limited] });
  });
  afterAll(async () => {
    await kit.close();
  });

  const decide = (client: TestClient, approvalId: string, body: Record<string, unknown>): Promise<TestResponse<ApprovalDecisionResponse & { error?: { code: string } }>> =>
    client.post(`/api/approvals/${approvalId}/decision`, body);
  const pending = (sessionId: string, client: TestClient = kit.owner): Promise<Approval> =>
    until(async () => (await kit.state(client, sessionId)).pendingApprovals[0], { what: 'a pending approval' });
  const sessionOf = async (sessionId: string, client: TestClient = kit.owner): Promise<Session> => (await client.get<Session>(`/api/sessions/${sessionId}`)).body;

  it('moves a planning session to "ask", so the next change is put to the user instead of being refused', async () => {
    const { owner, agent } = kit;
    const session = await kit.session(owner, { permissionMode: 'plan' });
    const live = await kit.connect(owner);
    await live.subscribe(sessionTopic(session.id));
    await live.subscribe(userTopic(owner.userId!));

    let modeWhenTheAgentHeard: string | null = null;
    agent.script([
      { permission: plan },
      {
        do: async () => {
          modeWhenTheAgentHeard = (await sessionOf(session.id)).permissionMode;
        },
      },
      { permission: edit('src/app.ts') },
      { text: 'Fixed.' },
    ]);
    const sent = await kit.send(owner, session.id, 'plan the fix');
    const planApproval = await pending(session.id);
    expect(planApproval.kind).toBe('plan');
    expect((await sessionOf(session.id)).permissionMode).toBe('plan');

    const answered = await decide(owner, planApproval.id, { decision: 'allow' });
    expect(answered.status).toBe(200);
    expect(answered.body.approval).toMatchObject({ status: 'allowed', kind: 'plan' });

    // The edit that follows is asked about — in plan mode it would have been refused outright.
    const editApproval = await until(async () => (await kit.state(owner, session.id)).pendingApprovals.find((approval) => approval.kind === 'tool'), { what: 'the edit to be asked about' });
    expect(editApproval).toMatchObject({ toolName: 'Edit', paths: ['src/app.ts'] });
    await decide(owner, editApproval.id, { decision: 'allow' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([
      ['allow', 'user'],
      ['allow', 'user'],
    ]);
    // By the time the agent learnt of the approval the new mode was in force…
    expect(modeWhenTheAgentHeard).toBe('ask');
    expect(await sessionOf(session.id)).toMatchObject({ permissionMode: 'ask', effectivePermissionMode: 'ask' });

    // …and every device was told: on the session's topic and on the user's.
    const modeOf = (frame: Extract<ServerFrame, { op: 'event' }>): string => (frame.data as { session: Session }).session.permissionMode;
    const updates = (topic: string) => live.events(topic).filter((frame) => frame.type === 'session.updated');
    await until(() => updates(sessionTopic(session.id)).some((frame) => modeOf(frame) === 'ask') && updates(userTopic(owner.userId!)).some((frame) => modeOf(frame) === 'ask'), { what: 'session.updated with the new mode' });
    // On the session's topic the resolution and the new mode arrive together: no update after the
    // resolution still shows the old mode.
    const frames = live.events(sessionTopic(session.id));
    const resolvedAt = frames.findIndex((frame) => frame.type === 'approval.resolved' && (frame.data as { approvalId: string }).approvalId === planApproval.id);
    expect(resolvedAt).toBeGreaterThanOrEqual(0);
    expect(frames.slice(resolvedAt).filter((frame) => frame.type === 'session.updated').map(modeOf)).not.toContain('plan');
    // The run itself keeps the record of the mode it started in.
    expect((await owner.get<{ permissionMode: string }>(`/api/runs/${sent.body.runId}`)).body.permissionMode).toBe('plan');
    live.close();
  });

  it('continues in the mode chosen with the approval', async () => {
    const { owner, agent } = kit;
    const session = await kit.session(owner, { permissionMode: 'plan' });
    agent.script([{ permission: plan }, { permission: edit('src/app.ts') }, { permission: bash('npm test') }, { text: 'Fixed.' }]);
    const sent = await kit.send(owner, session.id, 'plan the fix');
    const planApproval = await pending(session.id);
    expect((await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'accept-edits' })).status).toBe(200);
    // The edit inside the project runs without a question; the command still asks.
    const command = await until(async () => (await kit.state(owner, session.id)).pendingApprovals.find((approval) => approval.kind === 'tool'), { what: 'the command to be asked about' });
    expect(command.toolName).toBe('Bash');
    await decide(owner, command.id, { decision: 'allow' });
    await kit.runEnded(owner, sent.body.runId!);
    expect(agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([
      ['allow', 'user'],
      ['allow', 'mode'],
      ['allow', 'user'],
    ]);
    expect((await sessionOf(session.id)).permissionMode).toBe('accept-edits');
  });

  it('accepts "auto" only where the project allows it', async () => {
    const { owner, agent } = kit;
    const project = await kit.makeProject('automatic');
    const session = await kit.session(owner, { projectId: project.id, permissionMode: 'plan' });
    agent.script([{ permission: plan }, { permission: bash('npm run build') }, { text: 'Built.' }]);
    const sent = await kit.send(owner, session.id, 'plan the build');
    const planApproval = await pending(session.id);

    const refused = await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'auto' });
    expect(refused.status).toBe(422);
    expect(refused.body.error!.code).toBe('auto_mode_not_enabled');
    // Refusing the choice decided nothing: the plan still waits, the session still plans.
    expect((await owner.get<Approval>(`/api/approvals/${planApproval.id}`)).body.status).toBe('pending');
    expect((await sessionOf(session.id)).permissionMode).toBe('plan');

    expect((await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true })).status).toBe(200);
    expect((await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'auto' })).status).toBe(200);
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([
      ['allow', 'user'],
      ['allow', 'mode'],
    ]);
    expect(await sessionOf(session.id)).toMatchObject({ permissionMode: 'auto', effectivePermissionMode: 'auto' });
  });

  it('leaves the session planning when the plan is sent back, expires, or the run is stopped', async () => {
    const { owner, agent } = kit;
    const session = await kit.session(owner, { permissionMode: 'plan' });
    agent.script([{ permission: plan }, { permission: edit('src/app.ts') }, { text: 'I will revise the plan.' }]);
    const sent = await kit.send(owner, session.id, 'plan the fix');
    const first = await pending(session.id);
    expect((await decide(owner, first.id, { decision: 'deny', note: 'smaller, please' })).status).toBe(200);
    await kit.runEnded(owner, sent.body.runId!);
    expect((await sessionOf(session.id)).permissionMode).toBe('plan');
    // Still planning: the change that followed was refused by the mode, not asked about.
    expect(agent.lastRun.decisions.map((decision) => [decision.behavior, decision.source])).toEqual([
      ['deny', 'user'],
      ['deny', 'mode'],
    ]);

    agent.script([{ permission: plan }, { text: 'never reached' }]);
    await kit.send(owner, session.id, 'plan again');
    await pending(session.id);
    await owner.post(`/api/sessions/${session.id}/stop`);
    await kit.idle(owner, session.id);
    expect((await sessionOf(session.id)).permissionMode).toBe('plan');
  });

  it('keeps the mode of a session that was not planning, unless one is chosen', async () => {
    const { owner, agent } = kit;
    // The agent decided to present a plan by itself, in a session that accepts edits.
    const session = await kit.session(owner, { permissionMode: 'accept-edits' });
    agent.script([{ permission: plan }, { permission: edit('src/app.ts') }, { text: 'Done.' }]);
    const sent = await kit.send(owner, session.id, 'do it');
    await decide(owner, (await pending(session.id)).id, { decision: 'allow' });
    await kit.runEnded(owner, sent.body.runId!);
    expect((await sessionOf(session.id)).permissionMode).toBe('accept-edits');
    expect(agent.lastRun.decisions.map((decision) => decision.source)).toEqual(['user', 'mode']);

    agent.script([{ permission: plan }, { permission: edit('src/app.ts') }, { text: 'Done.' }]);
    const again = await kit.send(owner, session.id, 'and once more, carefully');
    await decide(owner, (await pending(session.id)).id, { decision: 'allow', permissionMode: 'ask' });
    const asked = await until(async () => (await kit.state(owner, session.id)).pendingApprovals.find((approval) => approval.kind === 'tool'), { what: 'the edit to be asked about' });
    await decide(owner, asked.id, { decision: 'allow' });
    await kit.runEnded(owner, again.body.runId!);
    expect((await sessionOf(session.id)).permissionMode).toBe('ask');
  });

  it('refuses a mode with anything that is not the approval of a plan', async () => {
    const { owner, agent } = kit;
    const session = await kit.session(owner, { permissionMode: 'plan' });
    agent.script([
      { permission: plan },
      { ask: { questions: [{ id: 'q', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } },
      { permission: bash('npm test') },
      { text: 'Done.' },
    ]);
    const sent = await kit.send(owner, session.id, 'plan, ask, run');
    const planApproval = await pending(session.id);
    // Sending the plan back with a mode, or a mode that is no continuation at all.
    const withDenial = await decide(owner, planApproval.id, { decision: 'deny', permissionMode: 'ask' });
    expect([withDenial.status, withDenial.body.error!.code]).toEqual([422, 'mode_not_applicable']);
    expect((await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'plan' })).status).toBe(400);
    expect((await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'yolo' })).status).toBe(400);
    expect((await owner.get<Approval>(`/api/approvals/${planApproval.id}`)).body.status).toBe('pending');
    expect((await decide(owner, planApproval.id, { decision: 'allow' })).status).toBe(200);

    const question = await until(async () => (await kit.state(owner, session.id)).pendingApprovals.find((approval) => approval.kind === 'question'), { what: 'the question' });
    const onQuestion = await decide(owner, question.id, { decision: 'allow', answers: [{ questionId: 'q', selected: ['A'] }], permissionMode: 'accept-edits' });
    expect([onQuestion.status, onQuestion.body.error!.code]).toEqual([422, 'mode_not_applicable']);
    await decide(owner, question.id, { decision: 'allow', answers: [{ questionId: 'q', selected: ['A'] }] });

    const tool = await until(async () => (await kit.state(owner, session.id)).pendingApprovals.find((approval) => approval.kind === 'tool'), { what: 'the command' });
    const onTool = await decide(owner, tool.id, { decision: 'allow', permissionMode: 'auto' });
    expect([onTool.status, onTool.body.error!.code]).toEqual([422, 'mode_not_applicable']);
    await decide(owner, tool.id, { decision: 'allow' });
    await kit.runEnded(owner, sent.body.runId!);
    // The one thing that changed the mode was approving the plan.
    expect((await sessionOf(session.id)).permissionMode).toBe('ask');
  });

  it('refuses a mode the agent does not have', async () => {
    const { owner } = kit;
    const session = await kit.session(owner, { agentId: limited.id, permissionMode: 'plan' });
    limited.script([{ permission: plan }, { text: 'Going ahead.' }]);
    const sent = await kit.send(owner, session.id, 'plan it');
    const planApproval = await pending(session.id);
    const refused = await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'accept-edits' });
    expect([refused.status, refused.body.error!.code]).toEqual([422, 'unsupported_permission_mode']);
    expect((await decide(owner, planApproval.id, { decision: 'allow' })).status).toBe(200);
    await kit.runEnded(owner, sent.body.runId!);
    expect((await sessionOf(session.id)).permissionMode).toBe('ask');
  });

  it('lets the owner approve a member\'s plan, and tells the member\'s devices about the new mode', async () => {
    const { owner, agent } = kit;
    const member = await kit.t.member();
    await kit.share(kit.project, member);
    const session = await kit.session(member, { permissionMode: 'plan' });
    const live = await kit.connect(member);
    await live.subscribe(userTopic(member.userId!));
    agent.script([{ permission: plan }, { text: 'Going ahead.' }]);
    const sent = await kit.send(member, session.id, 'plan it');
    const planApproval = await pending(session.id, member);
    expect((await decide(owner, planApproval.id, { decision: 'allow', permissionMode: 'accept-edits' })).status).toBe(200);
    await kit.runEnded(member, sent.body.runId!);
    expect((await sessionOf(session.id, member)).permissionMode).toBe('accept-edits');
    await until(() => live.events(userTopic(member.userId!)).some((frame) => frame.type === 'session.updated' && (frame.data as { session: Session }).session.permissionMode === 'accept-edits'), {
      what: 'the member to be told',
    });
    // Someone who could not see the session could not have decided it.
    const stranger = await kit.t.member();
    agent.script([{ permission: plan }, { text: 'Again.' }]);
    const again = await kit.send(member, session.id, 'plan once more');
    const second = await pending(session.id, member);
    expect((await decide(stranger, second.id, { decision: 'allow', permissionMode: 'ask' })).status).toBe(404);
    expect((await sessionOf(session.id, member)).permissionMode).toBe('accept-edits');
    await decide(member, second.id, { decision: 'allow' });
    await kit.runEnded(member, again.body.runId!);
    live.close();
  });
});
