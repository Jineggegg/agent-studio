import type { Run, RunningRun, Session } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollabWorlds, nextRequestId, until } from '../../src/modules/collab/testing/kit.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createCollabWorlds();
afterEach(() => worlds.closeAll());

async function start() {
  // Whatever is not scripted keeps working until it is stopped.
  const alpha = new ScriptedAdapter({ id: 'alpha', displayName: 'Alpha' }).otherwise(() => [{ hang: true }]);
  const beta = new ScriptedAdapter({ id: 'beta', displayName: 'Beta' }).otherwise(() => [{ hang: true }]);
  const judge = new ScriptedAdapter({ id: 'judge', displayName: 'Judge' }).otherwise(() => [{ hang: true }]);
  const world = await worlds.start({ kit: { adapters: [alpha, beta, judge] } });
  return { world, alpha, beta, judge };
}

describe('everything that runs, at a glance', () => {
  it('lists the caller\'s runs with where they came from, whether they wait, and whether anybody is watching', async () => {
    const { world, alpha, beta } = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(owner.userId!)!;
    const member = await kit.t.member();
    await kit.share(project, member, 'write');
    expect(await world.running(owner)).toMatchObject({ runs: [], tasks: [], counts: { runs: 0, waiting: 0, background: 0, tasks: 0 }, truncated: false });

    // A reply the person asked for and is looking at.
    const typed = await kit.session(owner, { title: 'Typed by hand' });
    const typedRun = (await kit.send(owner, typed.id, 'work on this')).body.runId!;
    await kit.looksAt(owner, [typed.id]);
    // Work that was started for the person: a scheduled message and an automation's run.
    const scheduled = await kit.session(owner, { title: 'Sent later' });
    const scheduledRun = (await agents.sendMessage(principal, scheduled.id, { requestId: nextRequestId(), text: 'the nightly check' }, { origin: 'scheduled', waitForApproval: true })).runId!;
    const automated = await kit.session(owner, { title: 'By an automation' });
    const automatedRun = (await agents.sendMessage(principal, automated.id, { requestId: nextRequestId(), text: 'tidy up' }, { origin: 'automation' })).runId!;
    await until(() => alpha.runs.length === 3);
    // A run that waits for an answer.
    const asking = await kit.session(owner, { title: 'Wants to deploy' });
    alpha.script([{ permission: { toolName: 'Bash', kind: 'execute', title: 'Run npm run deploy', input: { command: 'npm run deploy' }, command: 'npm run deploy' } }, { hang: true }]);
    const askingRun = (await kit.send(owner, asking.id, 'deploy it')).body.runId!;
    await until(async () => (await kit.state(owner, asking.id)).pendingApprovals.length === 1);
    // Two agents on one task.
    const task = await world.startTask(owner, project.id, { title: 'Compare designs', prompt: 'Design it.', participants: [{ agentId: 'alpha' }, { agentId: 'beta' }] });
    await world.taskWhen(owner, task.id, (current) => current.participants.every((entry) => entry.state === 'running'));
    // Somebody else's work is somebody else's.
    const theirs = await kit.session(member, { title: 'The member is busy' });
    await kit.send(member, theirs.id, 'private work');
    await until(() => alpha.runs.length === 6);
    const published = kit.published.length;

    const running = await world.running(owner);
    const byRun = new Map(running.runs.map((run) => [run.runId, run]));
    const taskNow = await world.task(owner, task.id);
    const [first, second] = taskNow.participants;
    expect(running.runs).toHaveLength(6);
    // Newest first.
    expect(running.runs.map((run) => run.createdAt)).toEqual([...running.runs.map((run) => run.createdAt)].sort((a, b) => b - a));

    expect(byRun.get(typedRun)).toEqual<RunningRun>({
      runId: typedRun,
      sessionId: typed.id,
      projectId: project.id,
      projectName: 'demo',
      agentId: 'alpha',
      agentName: 'Alpha',
      title: 'Typed by hand',
      origin: 'interactive',
      taskId: null,
      state: 'running',
      pendingApprovals: 0,
      unattended: false,
      watching: true,
      createdAt: byRun.get(typedRun)!.createdAt,
      startedAt: byRun.get(typedRun)!.startedAt,
      link: `/projects/${project.id}/sessions/${typed.id}`,
      stop: { method: 'POST', url: `/api/sessions/${typed.id}/stop` },
    });
    expect(byRun.get(typedRun)!.startedAt).not.toBeNull();
    expect(byRun.get(scheduledRun)).toMatchObject({ origin: 'scheduled', unattended: true, watching: false, taskId: null, state: 'running', title: 'Sent later' });
    expect(byRun.get(automatedRun)).toMatchObject({ origin: 'automation', unattended: true, watching: false, taskId: null, title: 'By an automation' });
    expect(byRun.get(askingRun)).toMatchObject({ origin: 'interactive', state: 'waiting', pendingApprovals: 1, watching: false, title: 'Wants to deploy' });
    expect(byRun.get(first!.runId!)).toMatchObject({ origin: 'task-participant', taskId: task.id, sessionId: first!.sessionId, agentId: 'alpha', title: 'Compare designs · Alpha', unattended: false, state: 'running' });
    expect(byRun.get(second!.runId!)).toMatchObject({ origin: 'task-participant', taskId: task.id, agentId: 'beta', title: 'Compare designs · Beta' });

    expect(running.tasks).toHaveLength(1);
    expect(running.tasks[0]).toMatchObject({ task: { id: task.id, state: 'running', title: 'Compare designs' }, watching: false, stop: { method: 'POST', url: `/api/tasks/${task.id}/stop` } });
    expect(running.counts).toEqual({ runs: 6, waiting: 1, background: 5, tasks: 1 });
    expect(running.truncated).toBe(false);
    expect(JSON.stringify(running)).not.toContain('The member is busy');
    // Reading it changes nothing and tells nobody anything.
    expect(kit.published.slice(published)).toEqual([]);

    // The member sees their own run, and nothing of the owner's.
    const members = await world.running(member);
    expect(members.runs.map((run) => [run.title, run.origin])).toEqual([['The member is busy', 'interactive']]);
    expect(members.tasks).toEqual([]);

    // Looking at a participant's session is watching the task.
    await kit.looksAt(owner, [second!.sessionId!], 'tab-0000-other');
    const watched = await world.running(owner);
    expect(watched.tasks[0]!.watching).toBe(true);
    expect(watched.runs.find((run) => run.runId === second!.runId)!.watching).toBe(true);
    expect(watched.counts.background).toBe(4);

    // Stopping is the existing routes' business: the entries say which.
    expect((await owner.post<{ run: Run }>(byRun.get(scheduledRun)!.stop.url)).body.run.status).toBe('stopped');
    expect((await owner.post(running.tasks[0]!.stop.url)).status).toBe(200);
    const after = await world.running(owner);
    expect(after.runs.map((run) => run.runId).sort()).toEqual([typedRun, automatedRun, askingRun].sort());
    expect(after.tasks).toEqual([]);
    expect(after.counts).toEqual({ runs: 3, waiting: 1, background: 2, tasks: 0 });
    expect(beta.lastRun.cancelled).toBe(true);
  });

  it('says when a run is the comparison of a task, and keeps a task that needs attention on the list', async () => {
    const { world, alpha, beta, judge } = await start();
    const { owner, project } = world.kit;
    alpha.script([{ text: 'Alpha answered.' }]);
    beta.script([{ fail: { code: 'agent_error', message: 'Beta broke.' } }]);
    const task = await world.startTask(owner, project.id, { title: 'With a judge', prompt: 'Design it.', participants: [{ agentId: 'alpha' }, { agentId: 'beta' }], synthesis: { agentId: 'judge' } });
    let current = await world.taskWhen(owner, task.id, (seen) => seen.state === 'needs-attention');
    // Nothing runs, but the task is not over: it is still on the list.
    let running = await world.running(owner);
    expect(running.runs).toEqual([]);
    expect(running.tasks.map((entry) => [entry.task.id, entry.task.state])).toEqual([[task.id, 'needs-attention']]);

    await owner.post(`/api/runs/${current.participants[1]!.runId}/dismiss`);
    await until(() => judge.runs.length === 1);
    current = await world.taskWhen(owner, task.id, (seen) => seen.synthesis?.state === 'running');
    running = await world.running(owner);
    expect(running.runs.map((run) => [run.runId, run.origin, run.taskId, run.agentId, run.title])).toEqual([[current.synthesis!.runId, 'task-synthesis', task.id, 'judge', 'With a judge · comparison']]);
    expect(running.tasks.map((entry) => entry.task.state)).toEqual(['running']);

    // A later message of the person in a participant's session is an ordinary run, not the task's.
    const session = (await owner.get<Session>(`/api/sessions/${current.participants[0]!.sessionId}`)).body;
    const sent = await world.kit.send(owner, session.id, 'one more thing');
    await until(() => alpha.runs.length === 2);
    const later = (await world.running(owner)).runs.find((run) => run.runId === sent.body.runId)!;
    expect(later).toMatchObject({ origin: 'interactive', taskId: null, title: 'With a judge · Alpha' });
  });
});
