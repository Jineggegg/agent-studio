import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  approvalsWaiting,
  assistantText,
  createMember,
  createProject,
  createSession,
  decide,
  pendingApprovals,
  runEnded,
  sandboxIsOn,
  SANDBOX_OFF,
  send,
  shareProject,
  startAgentStudio,
  transcript,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.5 — Approvals, plans and questions (requirements 01 §6.5, §5.6, §7.2).
 *
 * Deliberate differences this file is written for:
 *  - an approval is a durable record that waits for a person — thirty minutes
 *    by default, not under a minute — and can be answered from any device;
 *  - every agent can ask (Codex too);
 *  - there is no "bypass everything" mode: the widest is `auto`, which works
 *    only in a project where the owner switched it on, and even then a short
 *    hard-deny list is refused;
 *  - a dangerous request can be allowed only by the owner, once, never
 *    remembered.
 */
describe('6.5 approvals, plans, questions', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'approvals');
  });
  afterAll(() => studio?.destroy());

  const toolResults = async (sessionId: string, client: ApiClient = owner) =>
    (await transcript(client, sessionId))
      .filter((event) => event.type === 'tool.finished')
      .map((event) => event.data.status as string);
  const asked = async (sessionId: string, client: ApiClient = owner) =>
    (await transcript(client, sessionId)).filter((event) => event.type === 'approval.requested')
      .length;

  it('AT-WB-055: in "ask" mode a command waits for a person, shows exactly what would run, and runs once a second device allows it', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const laptop = await Realtime.open(studio, owner);
    await laptop.subscribe(topic);
    const phone = await studio.owner();
    const phoneLive = await Realtime.open(studio, phone);
    await phoneLive.subscribe(`user:${phone.userId}`);

    const receipt = await send(owner, session.id, 'run the tests [[scenario:bash npm test]]');
    // The phone, which is not looking at the session, is told an approval is waiting.
    const pending = await phoneLive.event(`user:${phone.userId}`, 'approval.pending');
    expect(pending.data.approval).toMatchObject({
      sessionId: session.id,
      runId: receipt.runId,
      kind: 'tool',
      toolName: 'Bash',
      toolKind: 'execute',
      command: 'npm test',
      title: 'Run npm test',
      status: 'pending',
      requiresOwner: false,
    });
    expect(pending.data.approval.reason.length).toBeGreaterThan(5);
    // Nothing has run yet.
    expect(await toolResults(session.id)).toEqual([]);
    expect((await owner.get<Json>(`/api/runs/${receipt.runId}`)).body.status).toBe('running');

    const allowed = await decide(phone, pending.data.approval.id, 'allow');
    expect(allowed.status).toBe(200);
    expect(allowed.body.approval).toMatchObject({ status: 'allowed', decidedBy: phone.userId });
    // The laptop's prompt closes: the session's stream says who answered.
    const resolved = await laptop.event(topic, 'approval.resolved');
    expect(resolved.data).toMatchObject({
      approvalId: pending.data.approval.id,
      status: 'allowed',
      decidedBy: owner.userId,
    });
    expect((await runEnded(owner, receipt.runId!)).status).toBe('completed');
    expect(await toolResults(session.id)).toEqual(['ok']);
    expect(await pendingApprovals(owner, session.id)).toEqual([]);
    await Promise.all([laptop.close(), phoneLive.close()]);
  });

  it('AT-WB-055/056 (Codex): the other agent asks too — an allowed command really runs in the project, a denied one never does', async (context) => {
    if (!(await sandboxIsOn(owner))) return context.skip(SANDBOX_OFF);
    const session = await createSession(owner, project.id, 'codex');
    const yes = await send(
      owner,
      session.id,
      'do it [[scenario:run-command touch approved-by-a-person.txt]]',
    );
    const [first] = await approvalsWaiting(owner, session.id);
    expect(first).toMatchObject({
      kind: 'tool',
      toolKind: 'execute',
      command: 'touch approved-by-a-person.txt',
    });
    expect(existsSync(path.join(project.rootDir, 'approved-by-a-person.txt'))).toBe(false); // not before the answer
    expect((await decide(owner, first!.id, 'allow')).status).toBe(200);
    expect((await runEnded(owner, yes.runId!)).status).toBe('completed');
    expect(existsSync(path.join(project.rootDir, 'approved-by-a-person.txt'))).toBe(true);

    const no = await send(
      owner,
      session.id,
      'do it [[scenario:run-command touch refused-by-a-person.txt]]',
    );
    const [second] = await approvalsWaiting(owner, session.id);
    expect((await decide(owner, second!.id, 'deny', { note: 'not this one' })).status).toBe(200);
    expect((await runEnded(owner, no.runId!)).status).toBe('completed');
    expect(existsSync(path.join(project.rootDir, 'refused-by-a-person.txt'))).toBe(false);
    expect(await toolResults(session.id)).toEqual(['ok', 'denied']);
  });

  it('AT-WB-056: a denial is recorded as "denied" (not as an error), its reason reaches the agent, and the run continues to its end', async () => {
    const session = await createSession(owner, project.id);
    const receipt = await send(
      owner,
      session.id,
      'run the tests [[scenario:bash npm test]] [[scenario:bash ls]]',
    );
    const [approval] = await approvalsWaiting(owner, session.id);
    const denied = await decide(owner, approval!.id, 'deny', { note: 'not on a Friday' });
    expect(denied.status).toBe(200);
    expect(denied.body.approval).toMatchObject({ status: 'denied', note: 'not on a Friday' });
    const run = await runEnded(owner, receipt.runId!);
    expect(run.status).toBe('completed'); // the run went on after the refusal
    const events = await transcript(owner, session.id);
    const results = events.filter((event) => event.type === 'tool.finished');
    expect(results.map((event) => event.data.status)).toEqual(['denied', 'ok']);
    expect(results[0]!.data.output).toBe('not on a Friday');
    expect(await assistantText(owner, session.id)).toContain(
      'I could not run that: not on a Friday',
    );
    expect(events.find((event) => event.type === 'approval.resolved')!.data).toMatchObject({
      status: 'denied',
      note: 'not on a Friday',
      decidedBy: owner.userId,
    });
  });

  it('AT-WB-057 (adapted): "always allow" answers every waiting request it covers, leaves the others waiting, is listed as a rule, and the same command is not asked again', async () => {
    const gitA = await createSession(owner, project.id);
    const gitB = await createSession(owner, project.id);
    const remove = await createSession(owner, project.id);
    const runA = await send(owner, gitA.id, 'status [[scenario:bash git status]]');
    const runB = await send(owner, gitB.id, 'status [[scenario:bash git status]]');
    const runC = await send(owner, remove.id, 'clean [[scenario:bash rm -rf build-output]]');
    const [first] = await approvalsWaiting(owner, gitA.id);
    const [second] = await approvalsWaiting(owner, gitB.id);
    const [third] = await approvalsWaiting(owner, remove.id);
    expect(first!.suggestedRule).toEqual({ tool: 'Bash', pattern: 'git status *' });

    const always = await decide(owner, first!.id, 'allow', { remember: 'always' });
    expect(always.status).toBe(200);
    expect(always.body.rule).toMatchObject({
      scope: 'account',
      effect: 'allow',
      tool: 'Bash',
      pattern: 'git status *',
      createdBy: owner.userId,
    });
    expect(always.body.alsoResolved).toEqual([second!.id]);
    expect((await runEnded(owner, runA.runId!)).status).toBe('completed');
    expect((await runEnded(owner, runB.runId!)).status).toBe('completed');
    expect(await toolResults(gitB.id)).toEqual(['ok']);

    // The removal is a different request: still waiting.
    const stillWaiting = await owner.get<{ approvals: Array<{ id: string }> }>('/api/approvals');
    expect(stillWaiting.body.approvals.map((approval) => approval.id)).toEqual([third!.id]);
    const rules = await owner.get<{ rules: Array<{ id: string; tool: string; pattern: string }> }>(
      '/api/permission-rules',
    );
    expect(rules.body.rules.map((rule) => `${rule.tool}:${rule.pattern}`)).toContain(
      'Bash:git status *',
    );

    // A later `git status`, in a new run of another session, is not asked.
    expect((await decide(owner, third!.id, 'deny')).status).toBe(200);
    await runEnded(owner, runC.runId!);
    const later = await send(owner, remove.id, 'status again [[scenario:bash git status -s]]');
    expect((await runEnded(owner, later.runId!)).status).toBe('completed');
    expect(await asked(remove.id)).toBe(1); // only the removal was ever asked here
    expect(await toolResults(remove.id)).toEqual(['denied', 'ok']);

    // Taking the rule back makes the command ask again.
    const ruleId = always.body.rule.id as string;
    expect((await owner.delete(`/api/permission-rules/${ruleId}`)).status).toBeLessThan(300);
    const again = await send(owner, remove.id, 'status once more [[scenario:bash git status]]');
    const [fourth] = await approvalsWaiting(owner, remove.id);
    expect(fourth!.command).toBe('git status');
    await decide(owner, fourth!.id, 'deny');
    await runEnded(owner, again.runId!);
  });

  it('WB-073: "allow for this session" is not asked again in that session, and is still asked in another', async () => {
    const here = await createSession(owner, project.id);
    const there = await createSession(owner, project.id);
    const first = await send(owner, here.id, 'build [[scenario:bash make build]]');
    const [approval] = await approvalsWaiting(owner, here.id);
    const remembered = await decide(owner, approval!.id, 'allow', { remember: 'session' });
    expect(remembered.body.rule).toMatchObject({
      scope: 'session',
      sessionId: here.id,
      effect: 'allow',
    });
    await runEnded(owner, first.runId!);
    const second = await send(owner, here.id, 'build again [[scenario:bash make build]]');
    expect((await runEnded(owner, second.runId!)).status).toBe('completed');
    expect(await asked(here.id)).toBe(1);
    expect(await toolResults(here.id)).toEqual(['ok', 'ok']);

    const elsewhere = await send(owner, there.id, 'build [[scenario:bash make build]]');
    const [other] = await approvalsWaiting(owner, there.id);
    expect(other!.command).toBe('make build');
    await decide(owner, other!.id, 'deny');
    await runEnded(owner, elsewhere.runId!);
  });

  it('AT-WB-058: when a blocking rule and an allowing rule both match, the command is refused without asking anyone', async () => {
    const allow = await owner.post<Json>('/api/permission-rules', {
      scope: 'account',
      effect: 'allow',
      tool: 'Bash',
      pattern: 'npm publish *',
    });
    const deny = await owner.post<Json>('/api/permission-rules', {
      scope: 'account',
      effect: 'deny',
      tool: 'Bash',
      pattern: 'npm publish *',
    });
    expect([allow.status, deny.status].every((status) => status === 200 || status === 201)).toBe(
      true,
    );
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'ship it [[scenario:bash npm publish]]');
    expect((await runEnded(owner, run.runId!)).status).toBe('completed');
    expect(await asked(session.id)).toBe(0);
    expect(await toolResults(session.id)).toEqual(['denied']);
    for (const rule of [allow.body, deny.body])
      await owner.delete(`/api/permission-rules/${rule.id}`);
  });

  it('AT-WB-059 (adapted): an unanswered request keeps waiting — its record says when it will lapse, thirty minutes out by default, not under a minute', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'wait for me [[scenario:bash npm test]]');
    const [approval] = await approvalsWaiting(owner, session.id);
    const record = (await owner.get<Json>(`/api/approvals/${approval!.id}`)).body;
    expect(record.status).toBe('pending');
    expect(record.expiresAt - record.createdAt).toBe(30 * 60 * 1000);
    await decide(owner, approval!.id, 'deny');
    await runEnded(owner, run.runId!);
  });

  it('AT-WB-060/061: a waiting request reappears after a reload and on a second device; once answered it disappears from both and does not come back', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const run = await send(
      owner,
      session.id,
      'careful [[scenario:bash npm test]] [[scenario:long 20]]',
    );
    const [approval] = await approvalsWaiting(owner, session.id);

    // "Reload": a brand-new connection learns of the request from the subscription's snapshot.
    const deviceA = await Realtime.open(studio, owner);
    const snapshotA = (await deviceA.subscribe(topic)).snapshot;
    expect(snapshotA.pendingApprovals.map((item: Json) => item.id)).toEqual([approval!.id]);
    expect(snapshotA.pendingApprovals[0]).toMatchObject({ command: 'npm test', status: 'pending' });
    const tablet = await studio.owner();
    const deviceB = await Realtime.open(studio, tablet);
    expect(
      (await deviceB.subscribe(topic)).snapshot.pendingApprovals.map((item: Json) => item.id),
    ).toEqual([approval!.id]);

    // A answers; B's prompt closes.
    expect((await decide(owner, approval!.id, 'allow')).status).toBe(200);
    const closedOnB = await deviceB.event(topic, 'approval.resolved');
    expect(closedOnB.data).toMatchObject({ approvalId: approval!.id, status: 'allowed' });

    // A reloads mid-run: the answered request is not shown again.
    const reloaded = await Realtime.open(studio, owner);
    const snapshot = (await reloaded.subscribe(topic)).snapshot;
    expect(snapshot.pendingApprovals).toEqual([]);
    expect(snapshot.run, 'the run is still in progress at the reload').not.toBeNull();
    await runEnded(owner, run.runId!);
    await Promise.all([deviceA.close(), deviceB.close(), reloaded.close()]);
  });

  it('WB-072: one request answered from two devices at the same moment has exactly one answer — the other device is told it was already resolved', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'race [[scenario:bash npm test]]');
    const [approval] = await approvalsWaiting(owner, session.id);
    const phone = await studio.owner();
    const [fromLaptop, fromPhone] = await Promise.all([
      decide(owner, approval!.id, 'allow'),
      decide(phone, approval!.id, 'deny'),
    ]);
    expect([fromLaptop.status, fromPhone.status].sort()).toEqual([200, 409]);
    const loser = fromLaptop.status === 409 ? fromLaptop : fromPhone;
    expect((loser.body as ErrorBody).error.code).toBe('approval_resolved');
    const winner = fromLaptop.status === 200 ? 'allowed' : 'denied';
    expect((await owner.get<Json>(`/api/approvals/${approval!.id}`)).body.status).toBe(winner);
    await runEnded(owner, run.runId!);
    // The tool saw the winner's answer, once.
    expect(await toolResults(session.id)).toEqual([winner === 'allowed' ? 'ok' : 'denied']);
    expect(
      (await transcript(owner, session.id)).filter((event) => event.type === 'approval.resolved'),
    ).toHaveLength(1);
    // Answering again later changes nothing.
    const late = await decide(owner, approval!.id, winner === 'allowed' ? 'deny' : 'allow');
    expect(late.status).toBe(409);
    expect((await owner.get<Json>(`/api/approvals/${approval!.id}`)).body.status).toBe(winner);
  });

  it('AT-WB-063 (adapted): "accept edits" lets a file edit through and still asks for a command', async () => {
    const session = await createSession(owner, project.id, 'claude-code', {
      permissionMode: 'accept-edits',
    });
    const run = await send(
      owner,
      session.id,
      'edit then run [[scenario:edit-file accepted-edit.txt]] [[scenario:bash npm test]]',
    );
    const [approval] = await approvalsWaiting(owner, session.id);
    expect(approval).toMatchObject({ toolKind: 'execute', command: 'npm test' });
    // The edit had already gone through, unasked, by the time the command asked.
    expect(existsSync(path.join(project.rootDir, 'accepted-edit.txt'))).toBe(true);
    await decide(owner, approval!.id, 'deny');
    await runEnded(owner, run.runId!);
    expect(await asked(session.id)).toBe(1);
    expect(await toolResults(session.id)).toEqual(['ok', 'denied']);
  });

  it('AT-WB-063 (adapted): "auto" asks nothing only where the owner enabled it for the project; elsewhere the session behaves as "ask" and says so', async () => {
    // Not enabled (the default): the chosen mode is kept, the effective one is "ask", and the command asks.
    expect((await owner.get<Json>(`/api/agents/projects/${project.id}/settings`)).body).toEqual({
      autoMode: false,
    });
    const guarded = await createSession(owner, project.id, 'claude-code', {
      permissionMode: 'auto',
    });
    expect(guarded).toMatchObject({ permissionMode: 'auto', effectivePermissionMode: 'ask' });
    const first = await send(owner, guarded.id, 'go [[scenario:bash npm test]]');
    const [approval] = await approvalsWaiting(owner, guarded.id);
    expect(approval!.command).toBe('npm test');
    await decide(owner, approval!.id, 'deny');
    await runEnded(owner, first.runId!);
    expect(
      (await transcript(owner, guarded.id)).find((event) => event.type === 'run.started')!.data
        .permissionMode,
    ).toBe('ask');

    // Enabled by the owner for another project: the same command runs unasked.
    const trusted = await createProject(studio, owner, 'auto-enabled');
    expect(
      (await owner.put<Json>(`/api/agents/projects/${trusted.id}/settings`, { autoMode: true }))
        .body,
    ).toEqual({ autoMode: true });
    const free = await createSession(owner, trusted.id, 'claude-code', { permissionMode: 'auto' });
    expect(free.effectivePermissionMode).toBe('auto');
    const second = await send(
      owner,
      free.id,
      'go [[scenario:bash npm test]] [[scenario:edit-file auto-edit.txt]]',
    );
    expect((await runEnded(owner, second.runId!)).status).toBe('completed');
    expect(await asked(free.id)).toBe(0);
    expect(await toolResults(free.id)).toEqual(['ok', 'ok']);

    // Even there, what is on the hard-deny list is refused — without a prompt that could be clicked through.
    const third = await send(owner, free.id, 'wipe [[scenario:bash rm -rf /]]');
    expect((await runEnded(owner, third.runId!)).status).toBe('completed');
    expect(await asked(free.id)).toBe(0);
    expect(await toolResults(free.id)).toEqual(['ok', 'ok', 'denied']);
    // Switching it off again takes effect for the next run.
    await owner.put(`/api/agents/projects/${trusted.id}/settings`, { autoMode: false });
    expect((await owner.get<Json>(`/api/sessions/${free.id}`)).body.effectivePermissionMode).toBe(
      'ask',
    );
  });

  it('WB-074: plan mode only reads — a write is refused without asking and nothing is changed', async () => {
    const session = await createSession(owner, project.id, 'claude-code', {
      permissionMode: 'plan',
    });
    const run = await send(
      owner,
      session.id,
      'just do it [[scenario:edit-file written-in-plan-mode.txt]] [[scenario:bash npm test]] [[scenario:bash ls]]',
    );
    expect((await runEnded(owner, run.runId!)).status).toBe('completed');
    expect(await asked(session.id)).toBe(0);
    expect(await toolResults(session.id)).toEqual(['denied', 'denied', 'ok']); // the read-only listing is fine
    expect(existsSync(path.join(project.rootDir, 'written-in-plan-mode.txt'))).toBe(false);
    const refusal = (await transcript(owner, session.id)).find(
      (event) => event.type === 'tool.finished',
    )!;
    expect(refusal.data.output).toContain('Plan mode');
  });

  it('AT-WB-064: a plan waits for approval; "keep revising" hands the note to the agent as the reason and the run continues; approving lets the work start', async () => {
    const session = await createSession(owner, project.id, 'claude-code', {
      permissionMode: 'plan',
    });
    const revise = await send(owner, session.id, 'plan it [[scenario:plan]]');
    const [plan] = await approvalsWaiting(owner, session.id);
    expect(plan).toMatchObject({ kind: 'plan', title: 'Approve the plan', status: 'pending' });
    expect(plan!.plan).toContain('Create plan-output.txt');
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.attention).toBe('needs-you');
    const revised = await decide(owner, plan!.id, 'deny', { note: 'only touch the frontend' });
    expect(revised.status).toBe(200);
    expect((await runEnded(owner, revise.runId!)).status).toBe('completed');
    expect(await assistantText(owner, session.id, revise.runId!)).toContain(
      'The plan was not approved: only touch the frontend',
    );
    expect(existsSync(path.join(project.rootDir, 'plan-output.txt'))).toBe(false);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.permissionMode).toBe('plan'); // a revision changes nothing

    // Second attempt: approve. The session leaves plan mode, so the work can begin — and each change is still asked.
    const go = await send(owner, session.id, 'plan it again [[scenario:plan]]');
    const [again] = await approvalsWaiting(owner, session.id);
    // A mode may be chosen with the approval, but not one the project does not allow.
    const tooWide = await decide(owner, again!.id, 'allow', { permissionMode: 'auto' });
    expect(tooWide.status).toBe(422);
    expect((tooWide.body as ErrorBody).error.code).toBe('auto_mode_not_enabled');
    expect((await decide(owner, again!.id, 'allow')).status).toBe(200);
    const [write] = await approvalsWaiting(owner, session.id);
    expect(write).toMatchObject({ kind: 'tool', toolKind: 'edit', title: 'Write plan-output.txt' });
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.permissionMode).toBe('ask');
    await decide(owner, write!.id, 'allow');
    expect((await runEnded(owner, go.runId!)).status).toBe('completed');
    expect(existsSync(path.join(project.rootDir, 'plan-output.txt'))).toBe(true);
  });

  it('AT-WB-065: two questions from the agent (one single-choice, one multi-choice) are answered together and the agent receives each answer', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'ask me [[scenario:ask-user]]');
    const [question] = await approvalsWaiting(owner, session.id);
    expect(question).toMatchObject({ kind: 'question', title: '2 questions from the agent' });
    const questions = question!.questions as Array<{
      id: string;
      question: string;
      multiSelect: boolean;
      options: Array<{ label: string; recommended?: boolean }>;
    }>;
    expect(questions.map((item) => item.multiSelect)).toEqual([false, true]);
    expect(questions[0]!.options.find((option) => option.recommended)?.label).toBe(
      'Blue (Recommended)',
    );

    const answers = [
      { questionId: questions[0]!.id, selected: ['Red'] },
      { questionId: questions[1]!.id, selected: ['Home', 'Settings'], other: 'x' },
    ];
    const answered = await decide(owner, question!.id, 'allow', { answers });
    expect(answered.status).toBe(200);
    expect((await runEnded(owner, run.runId!)).status).toBe('completed');
    // The agent received them …
    const reply = await assistantText(owner, session.id);
    expect(reply).toContain('"Which colour should the button be?":"Red"');
    expect(reply).toContain('"Which pages need it?":"Home, Settings, x"');
    // … and the transcript shows them.
    const resolved = (await transcript(owner, session.id)).find(
      (event) => event.type === 'approval.resolved',
    )!;
    expect(resolved.data).toMatchObject({ status: 'allowed', answers });
  });

  it('AT-WB-066: skipping a question gives the agent no answers; it carries on, and the transcript shows it was not answered', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'ask me [[scenario:ask-user]]');
    const [question] = await approvalsWaiting(owner, session.id);
    expect((await decide(owner, question!.id, 'deny')).status).toBe(200);
    expect((await runEnded(owner, run.runId!)).status).toBe('completed');
    const events = await transcript(owner, session.id);
    expect(events.find((event) => event.type === 'approval.resolved')!.data).toMatchObject({
      status: 'denied',
      answers: null,
    });
    expect(await assistantText(owner, session.id)).toContain('The user chose not to answer');
  });

  it('AT-WB-067 (adapted): a question says which option is the agent’s recommendation and when it would be taken by default', async () => {
    const session = await createSession(owner, project.id);
    const run = await send(owner, session.id, 'ask me [[scenario:ask-user]]');
    const [question] = await approvalsWaiting(owner, session.id);
    const record = (await owner.get<Json>(`/api/approvals/${question!.id}`)).body;
    expect(record.expiresAt - record.createdAt).toBe(30 * 60 * 1000);
    expect(
      record.questions[0].options.filter((option: Json) => option.recommended === true),
    ).toHaveLength(1);
    expect(record.questions[1].options.some((option: Json) => option.recommended === true)).toBe(
      false,
    );
    await decide(owner, question!.id, 'deny');
    await runEnded(owner, run.runId!);
  });

  it('AT-WB-045 (adapted): refusing the request lets the run go on; stopping the run instead withdraws the request and ends the run', async () => {
    const session = await createSession(owner, project.id);
    const topic = `session:${session.id}`;
    const live = await Realtime.open(studio, owner);
    await live.subscribe(topic);
    const run = await send(owner, session.id, 'careful [[scenario:bash npm test]]');
    const [approval] = await approvalsWaiting(owner, session.id);
    expect((await owner.post(`/api/sessions/${session.id}/stop`)).status).toBe(200);
    const finished = await live.event(topic, 'run.finished');
    expect(finished.data.status).toBe('stopped');
    const withdrawn = live.durable(topic).find((frame) => frame.type === 'approval.resolved')!;
    expect(withdrawn.data).toMatchObject({
      approvalId: approval!.id,
      status: 'cancelled',
      decidedBy: null,
    });
    expect(await pendingApprovals(owner, session.id)).toEqual([]);
    // Nobody can answer it any more.
    expect((await decide(owner, approval!.id, 'allow')).status).toBe(409);
    expect((await runEnded(owner, run.runId!)).status).toBe('stopped');
    expect(await toolResults(session.id)).not.toContain('ok');
    await live.close();
  });

  it('AT-WB-070/135 (adapted): a session waiting for an approval is marked "needs you" in the list and in the project’s activity summary until it is answered', async () => {
    const quiet = await createProject(studio, owner, 'attention');
    const session = await createSession(owner, quiet.id);
    const run = await send(
      owner,
      session.id,
      'careful [[scenario:bash npm test]] [[scenario:long 15]]',
    );
    const [approval] = await approvalsWaiting(owner, session.id);
    expect((await owner.get<Json>(`/api/sessions/${session.id}`)).body.attention).toBe('needs-you');
    const waiting = (
      await owner.get<{ projects: Json[] }>('/api/sessions/activity')
    ).body.projects.find((entry) => entry.projectId === quiet.id);
    expect(waiting).toMatchObject({
      running: 1,
      runningAgents: ['claude-code'],
      attention: [session.id],
      unseen: [],
    });

    await decide(owner, approval!.id, 'allow');
    // Answered: running again, no longer asking for anyone.
    const running = (
      await owner.get<{ projects: Json[] }>('/api/sessions/activity')
    ).body.projects.find((entry) => entry.projectId === quiet.id);
    expect(running).toMatchObject({ running: 1, attention: [] });
    await runEnded(owner, run.runId!);
    // Finished while nobody had it on screen: unseen …
    const unseen = (
      await owner.get<{ projects: Json[] }>('/api/sessions/activity')
    ).body.projects.find((entry) => entry.projectId === quiet.id);
    expect(unseen).toMatchObject({ running: 0, attention: [], unseen: [session.id] });
    // … and once viewed, the idle project is left out altogether.
    await owner.post(`/api/sessions/${session.id}/seen`);
    expect(
      (await owner.get<{ projects: Json[] }>('/api/sessions/activity')).body.projects.find(
        (entry) => entry.projectId === quiet.id,
      ),
    ).toBeUndefined();
  });

  it('§7.2: a dangerous request needs the owner — a member cannot allow it in their own session, the owner is told and can, and it can never be remembered', async () => {
    const member = await createMember(studio, owner, 'approver');
    await shareProject(owner, project.id, member.userId!, 'write');
    const ownerLive = await Realtime.open(studio, owner);
    await ownerLive.subscribe(`user:${owner.userId}`);
    const session = await createSession(member, project.id);
    const run = await send(member, session.id, 'clean up [[scenario:bash rm -rf old-builds]]');
    const [approval] = await approvalsWaiting(member, session.id);
    expect(approval).toMatchObject({
      risk: 'dangerous',
      requiresOwner: true,
      suggestedRule: null,
      command: 'rm -rf old-builds',
    });

    const byMember = await decide(member, approval!.id, 'allow');
    expect(byMember.status).toBe(403);
    expect((byMember.body as ErrorBody).error.code).toBe('owner_required');
    expect((await member.get<Json>(`/api/approvals/${approval!.id}`)).body.status).toBe('pending');

    // The owner hears of it without watching the member's session.
    const told = await ownerLive.event(`user:${owner.userId}`, 'approval.pending', {
      where: (frame) => frame.data.approval.id === approval!.id,
    });
    expect(told.data.approval.userId).toBe(member.userId);
    const remembered = await decide(owner, approval!.id, 'allow', { remember: 'always' });
    expect(remembered.status).toBe(403);
    expect((remembered.body as ErrorBody).error.code).toBe('remember_not_allowed');
    expect((await decide(owner, approval!.id, 'allow')).status).toBe(200);
    expect((await runEnded(member, run.runId!)).status).toBe('completed');
    expect(await toolResults(session.id, member)).toEqual(['ok']);
    // A member may of course refuse their own dangerous request.
    const second = await send(
      member,
      session.id,
      'clean more [[scenario:bash rm -rf older-builds]]',
    );
    const [next] = await approvalsWaiting(member, session.id);
    expect((await decide(member, next!.id, 'deny')).status).toBe(200);
    await runEnded(member, second.runId!);
    await ownerLive.close();
  });
});
