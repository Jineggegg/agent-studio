import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentCapabilities, GitWorktrees, Project, Run, Session, Task } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CollabWorld, createCollabWorlds, errorOf } from '../../src/modules/collab/testing/kit.js';
import { type GitSandbox, createGitSandbox } from '../../src/modules/git/testing/fixtures.js';
import { ScriptedAdapter } from '../../src/testing/scripted-adapter.js';

const worlds = createCollabWorlds();
let sandbox: GitSandbox;
// The sandbox first: the server builds the environment of `git` from the test process's HOME and PATH.
beforeEach(async () => {
  sandbox = await createGitSandbox();
});
afterEach(async () => {
  await worlds.closeAll();
  await sandbox.restore();
});

/** An agent whose capabilities cannot be read any more once it is armed and has been asked once. */
class Flaky extends ScriptedAdapter {
  armed = false;
  #asked = 0;

  override capabilities(): AgentCapabilities {
    if (this.armed && (this.#asked += 1) > 1) throw new Error('the agent went away');
    return super.capabilities();
  }
}

interface Cast {
  world: CollabWorld;
  alpha: ScriptedAdapter;
  beta: ScriptedAdapter;
  flaky: Flaky;
  judge: ScriptedAdapter;
  /** A project whose folder is a Git repository with one commit on `main`. */
  repo: Project;
}

async function start(): Promise<Cast> {
  const alpha = new ScriptedAdapter({ id: 'alpha', displayName: 'Alpha' });
  const beta = new ScriptedAdapter({ id: 'beta', displayName: 'Beta' });
  const flaky = new Flaky({ id: 'flaky', displayName: 'Flaky' });
  const judge = new ScriptedAdapter({ id: 'judge', displayName: 'Judge' });
  const world = await worlds.start({ kit: { adapters: [alpha, beta, flaky, judge] } });
  const dir = path.join(world.kit.t.workspace, 'repo');
  await sandbox.repo(dir, { 'README.md': '# repo\n', 'src/app.ts': 'export {};\n' });
  const created = await world.kit.owner.post<Project>('/api/projects', { name: 'repo', rootDir: dir });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { world, alpha, beta, flaky, judge, repo: created.body };
}

const PROMPT = 'Add a health endpoint.';
const worktreesOf = async (world: CollabWorld, repo: Project): Promise<GitWorktrees> => (await world.kit.owner.get<GitWorktrees>(`/api/projects/${repo.id}/git/worktrees`)).body;
const participant = (task: Task, agentId: string) => task.participants.find((entry) => entry.agentId === agentId)!;
const ended = (task: Task): boolean => task.state === 'completed' || task.state === 'stopped';

describe('a task in worktrees', () => {
  it('gives every participant a worktree and a branch of its own, and says what each changed', async () => {
    const { world, alpha, beta, repo } = await start();
    const { kit } = world;
    const { owner } = kit;
    alpha.script([
      {
        do: async (run) => {
          await writeFile(path.join(run.request.cwd!, 'health.ts'), 'export const ok = true;\n');
          await writeFile(path.join(run.request.cwd!, 'README.md'), '# repo\n\nNow with a health endpoint.\n');
        },
      },
      { text: 'Alpha added health.ts and documented it.' },
    ]);
    beta.script([{ text: 'Beta only looked.' }]);

    const created = await world.startTask(owner, repo.id, { title: 'Health', prompt: PROMPT, isolation: 'worktrees', participants: [{ agentId: 'alpha', permissionMode: 'accept-edits' }, { agentId: 'beta' }] });
    expect(created).toMatchObject({ isolation: 'worktrees', projectId: repo.id });
    const tag = created.id.slice(-8);
    expect(created.participants.map((entry) => [entry.agentId, entry.permissionMode, entry.worktree?.branch])).toEqual([
      ['alpha', 'accept-edits', `task-${tag}/1-alpha`],
      ['beta', 'ask', `task-${tag}/2-beta`],
    ]);
    const task = await world.taskWhen(owner, created.id, ended);
    expect(task.state).toBe('completed');

    // Each works in a folder of its own, next to the repository, registered as a project of its own.
    const location = path.join(kit.t.workspace, 'repo-worktrees');
    const alphaDir = path.join(location, `task-${tag}-1-alpha`);
    const betaDir = path.join(location, `task-${tag}-2-beta`);
    expect(alpha.runs[0]!.request).toMatchObject({ cwd: alphaDir, permissionMode: 'accept-edits', origin: 'interactive', unattended: false });
    expect(beta.runs[0]!.request).toMatchObject({ cwd: betaDir, permissionMode: 'ask' });
    for (const entry of task.participants) {
      expect(entry.worktree!.projectId).not.toBe(repo.id);
      expect(entry.sessionProjectId).toBe(entry.worktree!.projectId);
      expect(entry.link).toBe(`/projects/${entry.worktree!.projectId}/sessions/${entry.sessionId}`);
      expect((await owner.get<Session>(`/api/sessions/${entry.sessionId}`)).body).toMatchObject({ projectId: entry.worktree!.projectId, title: `Health · ${entry.agentName}` });
    }
    const listed = await worktreesOf(world, repo);
    expect(listed.worktrees.map((worktree) => [worktree.branch, worktree.path, worktree.main])).toEqual([
      ['main', repo.rootDir, true],
      [`task-${tag}/1-alpha`, alphaDir, false],
      [`task-${tag}/2-beta`, betaDir, false],
    ]);
    expect(listed.worktrees.map((worktree) => worktree.projectId)).toEqual([repo.id, participant(task, 'alpha').worktree!.projectId, participant(task, 'beta').worktree!.projectId]);

    // What each changed against where it started — read through the Git module, committed or not.
    const changes = participant(task, 'alpha').worktree!;
    expect(changes.changesError).toBeNull();
    expect(changes.changes).toMatchObject({ total: 2, truncated: false });
    expect(changes.changes!.files.map((file) => [file.path, file.status]).sort()).toEqual([['README.md', 'M'], ['health.ts', 'U']]);
    expect(changes.changes!.additions).toBeGreaterThanOrEqual(2);
    expect(participant(task, 'beta').worktree).toMatchObject({ changes: { files: [], total: 0, additions: 0, deletions: 0, truncated: false }, changesError: null });
    // Lists and events name the branch and leave the comparison to the page that shows the task.
    expect((await world.tasks(owner)).tasks[0]!.participants[0]!.worktree).toEqual({ branch: `task-${tag}/1-alpha`, projectId: changes.projectId, changes: null, changesError: null });

    // The repository's own checkout was not touched, and nothing was merged.
    expect(readFileSync(path.join(repo.rootDir, 'README.md'), 'utf8')).toBe('# repo\n');
    expect(existsSync(path.join(repo.rootDir, 'health.ts'))).toBe(false);
    expect((await sandbox.git(repo.rootDir, 'log', '--oneline', '--all')).trim().split('\n')).toHaveLength(1);
    // Clients that show the repository are told to read again.
    expect(kit.published.filter((event) => event.topic === `project:${repo.id}` && event.type === 'git.changed').map((event) => event.data)).toEqual([{ projectId: repo.id, reason: 'worktree-created' }]);

    // A worktree that was removed since says so instead of a comparison.
    expect((await owner.post(`/api/projects/${repo.id}/git/worktrees/remove`, { path: betaDir, deleteBranch: true })).status).toBe(200);
    expect(participant(await world.task(owner, created.id), 'beta').worktree).toMatchObject({ changes: null, changesError: 'The worktree is no longer there.' });
  });

  it('is the instance owner\'s to start, and needs a repository', async () => {
    const { world, alpha, repo } = await start();
    const { kit } = world;
    const { owner, project } = kit;
    const member = await kit.t.member();
    await kit.share(repo, member, 'write');
    const body = { prompt: PROMPT, isolation: 'worktrees', participants: [{ agentId: 'alpha', permissionMode: 'accept-edits' }, { agentId: 'beta' }] };

    // Worktrees make project folders: a member may not, whatever their access to the project.
    const refused = await world.createTask(member, repo.id, body);
    expect(errorOf(refused)).toEqual([403, 'owner_required']);
    expect((refused.body as unknown as { error: { message: string } }).error.message).toContain('only the owner of this Studio can create worktrees');
    // In the shared folder the member may take part like anybody.
    expect((await world.createTask(member, repo.id, { prompt: PROMPT, participants: [{ agentId: 'alpha' }, { agentId: 'beta' }] })).status).toBe(201);

    // A project whose folder is not a repository cannot provide worktrees.
    const plain = await world.createTask(owner, project.id, body);
    expect(errorOf(plain)).toEqual([409, 'task_needs_repository']);
    expect((plain.body as unknown as { error: { message: string; details: { state: string } } }).error).toMatchObject({ details: { state: 'none' } });
    expect((plain.body as unknown as { error: { message: string } }).error.message).toContain('Each participant needs a Git worktree of its own');

    expect((await worktreesOf(world, repo)).worktrees).toHaveLength(1);
    expect(existsSync(path.join(kit.t.workspace, 'repo-worktrees'))).toBe(false);
    expect((await world.tasks(owner, 'scope=all')).tasks).toHaveLength(1);
    expect(alpha.runs).toHaveLength(1);
  });

  it('takes away the worktrees, branches, projects and sessions it made when the task cannot start', async () => {
    const { world, alpha, flaky, repo } = await start();
    const { kit } = world;
    const { owner } = kit;
    const projects = kit.t.studio.context.services.projects;
    const principal = kit.t.studio.context.services.agents.principalFor(owner.userId!)!;
    const projectsBefore = projects.list(principal, { includeArchived: true }).map((project) => project.id).sort();

    // The second participant's session cannot be created — after its worktree, and the first one's, already exist.
    flaky.armed = true;
    const response = await world.createTask(owner, repo.id, { prompt: PROMPT, isolation: 'worktrees', participants: [{ agentId: 'alpha', permissionMode: 'accept-edits' }, { agentId: 'flaky' }] });
    expect(response.status).toBe(500);
    flaky.armed = false;

    expect((await worktreesOf(world, repo)).worktrees.map((worktree) => worktree.branch)).toEqual(['main']);
    expect((await sandbox.git(repo.rootDir, 'branch', '--list', '--format=%(refname:short)')).trim().split('\n')).toEqual(['main']);
    const location = path.join(kit.t.workspace, 'repo-worktrees');
    expect(existsSync(location) ? readdirSync(location) : []).toEqual([]);
    expect(projects.list(principal, { includeArchived: true }).map((project) => project.id).sort()).toEqual(projectsBefore);
    expect(await world.sessions(owner, 'archived=include&scope=all')).toEqual([]);
    expect((await world.tasks(owner)).tasks).toEqual([]);
    expect(alpha.runs).toHaveLength(0);
    expect(kit.userEvents(owner.userId).filter((event) => event.type.startsWith('task.'))).toEqual([]);
    expect(kit.published.filter((event) => event.topic === `project:${repo.id}` && event.type === 'git.changed').map((event) => (event.data as { reason: string }).reason)).toEqual(['worktree-removed']);

    // Nothing is in the way of trying again.
    const again = await world.startTask(owner, repo.id, { prompt: PROMPT, isolation: 'worktrees', participants: [{ agentId: 'alpha' }, { agentId: 'flaky' }] });
    expect((await world.taskWhen(owner, again.id, ended)).state).toBe('completed');
    expect((await worktreesOf(world, repo)).worktrees).toHaveLength(3);
  });
});

describe('after a restart', () => {
  /** Stops the server the way a deploy or a crash does — the data directory stays — and starts a new one on it. */
  async function restart(before: Cast): Promise<Cast> {
    await before.world.kit.t.studio.stop();
    const alpha = new ScriptedAdapter({ id: 'alpha', displayName: 'Alpha' });
    const beta = new ScriptedAdapter({ id: 'beta', displayName: 'Beta' });
    const flaky = new Flaky({ id: 'flaky', displayName: 'Flaky' });
    const judge = new ScriptedAdapter({ id: 'judge', displayName: 'Judge' });
    const world = await worlds.start({ kit: { restartOf: before.world.kit, adapters: [alpha, beta, flaky, judge] } });
    // Start-up work (recovery, reconciliation) runs before the server accepts connections.
    await world.kit.listen();
    return { world, alpha, beta, flaky, judge, repo: before.repo };
  }

  it('shows a participant that was cut short as interrupted, and starts nothing again by itself', async () => {
    const before = await start();
    await before.world.kit.listen();
    const { project } = before.world.kit;
    before.alpha.script([{ text: 'Alpha was in the middle of' }, { hang: true }]);
    before.beta.script([{ text: 'Beta finished before the restart.' }]);
    const created = await before.world.startTask(before.world.kit.owner, project.id, { prompt: PROMPT, participants: [{ agentId: 'alpha' }, { agentId: 'beta' }], synthesis: { agentId: 'judge' } });
    await before.world.taskWhen(before.world.kit.owner, created.id, (task) => task.participants.map((entry) => entry.state).join() === 'running,completed');

    const after = await restart(before);
    const { world, alpha, beta, judge } = after;
    const owner = world.kit.owner;
    let task = await world.task(owner, created.id);
    expect(task.participants.map((entry) => entry.state)).toEqual(['interrupted', 'completed']);
    expect(participant(task, 'alpha')).toMatchObject({ error: { code: 'server_restart' }, acknowledged: false, answer: { text: 'Alpha was in the middle of' } });
    expect(participant(task, 'alpha').finishedAt).not.toBeNull();
    expect(participant(task, 'beta').answer?.text).toBe('Beta finished before the restart.');
    expect(task.state).toBe('needs-attention');
    expect(task.synthesis).toMatchObject({ state: 'pending' });
    // The run is the runtime's interrupted run, there to be continued or dismissed by a person.
    expect((await owner.get<Run>(`/api/runs/${participant(task, 'alpha').runId}`)).body).toMatchObject({ status: 'interrupted', interruptedByRestart: true });
    expect((await world.inbox(owner)).groups.needsHandling.map((item) => item.runId)).toEqual([participant(task, 'alpha').runId]);
    expect([alpha.runs.length, beta.runs.length, judge.runs.length]).toEqual([0, 0, 0]);
    expect((await world.running(owner)).tasks.map((entry) => [entry.task.id, entry.task.state])).toEqual([[created.id, 'needs-attention']]);

    // The person deals with the interruption; only then does the comparison go ahead.
    judge.script([{ text: 'Beta has the only complete answer.' }]);
    expect((await owner.post(`/api/runs/${participant(task, 'alpha').runId}/dismiss`)).status).toBe(200);
    task = await world.taskWhen(owner, created.id, ended);
    expect(task).toMatchObject({ state: 'completed', synthesis: { state: 'completed', answer: { text: 'Beta has the only complete answer.' } } });
    expect(participant(task, 'alpha')).toMatchObject({ state: 'interrupted', acknowledged: true });
    // The judge is told that the first answer is that of a run that did not finish.
    expect(judge.runs[0]!.request.prompt.text).toContain('<<<PARTICIPANT_ANSWER n="1" agent="Alpha · scripted-large" note="its run was interrupted">>>\nAlpha was in the middle of\n<<<END_PARTICIPANT_ANSWER>>>');
    expect(alpha.runs).toHaveLength(0);
  });

  it('skips a comparison that was due, and fails a participant whose run never began', async () => {
    const before = await start();
    await before.world.kit.listen();
    const { owner, project } = before.world.kit;
    const db = before.world.kit.t.studio.context.db;
    before.judge.script([{ hang: true }]);
    const due = await before.world.startTask(owner, project.id, { title: 'Due', prompt: PROMPT, participants: [{ agentId: 'alpha' }, { agentId: 'beta' }], synthesis: { agentId: 'judge' } });
    await before.world.taskWhen(owner, due.id, (task) => task.synthesis?.state === 'running');
    const unborn = await before.world.startTask(owner, project.id, { title: 'Unborn', prompt: PROMPT, participants: [{ agentId: 'alpha' }, { agentId: 'beta' }] });
    await before.world.taskWhen(owner, unborn.id, ended);
    const pending = await before.world.startTask(owner, project.id, { title: 'Pending', prompt: PROMPT, participants: [{ agentId: 'alpha' }, { agentId: 'beta' }], synthesis: { agentId: 'flaky' } });
    await before.world.taskWhen(owner, pending.id, ended);

    // What a crash at the wrong moment leaves behind: a participant recorded before its run was,
    // and a comparison that was due and had not been started.
    db.run("UPDATE collab_task_participants SET state = 'starting', run_id = NULL, started_at = NULL, finished_at = NULL, answer = NULL WHERE task_id = ? AND position = 1", unborn.id);
    db.run("UPDATE collab_tasks SET state = 'running', finished_at = NULL WHERE id = ?", unborn.id);
    db.run("UPDATE collab_task_participants SET state = 'pending', session_id = NULL, run_id = NULL, started_at = NULL, finished_at = NULL, answer = NULL WHERE task_id = ? AND position = 0", pending.id);
    db.run("UPDATE collab_tasks SET state = 'running', finished_at = NULL WHERE id = ?", pending.id);

    const after = await restart(before);
    const { world, flaky, judge } = after;
    const again = world.kit.owner;

    // A comparison that was running is an interrupted run: noted, and the task is done all the same.
    const first = await world.task(again, due.id);
    expect(first).toMatchObject({ state: 'completed', synthesis: { state: 'interrupted', error: { code: 'server_restart' } } });
    // A participant whose run never began did not run.
    const second = await world.task(again, unborn.id);
    expect(second.participants.map((entry) => [entry.state, entry.error?.code ?? null])).toEqual([['failed', 'not_started'], ['completed', null]]);
    expect(second.state).toBe('needs-attention');
    // A comparison that was due is not started by a restart.
    const third = await world.task(again, pending.id);
    expect(third).toMatchObject({ state: 'completed', synthesis: { state: 'skipped', note: 'The server restarted before the comparison could start. Nothing is started again by itself.' } });
    expect([flaky.runs.length, judge.runs.length]).toEqual([0, 0]);
    expect((await world.tasks(again, 'state=open')).tasks.map((task) => task.id)).toEqual([unborn.id]);
  });
});
