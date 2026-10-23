import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Approval, PermissionRule, Run } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CodexKit,
  assistantTexts,
  createCodexKit,
  eventsOf,
} from '../../src/modules/codex/testing/kit.js';
import { nextRequestId, until } from '../../src/testing/agents-kit.js';

/**
 * Codex's approval requests, end to end: the stand-in asks exactly as the real
 * CLI asks, the Studio's permission engine decides, a person answers over the
 * API, and the stand-in then really runs the command or really writes the file
 * — or does not.
 */
describe('Codex asks the Studio before it changes anything', () => {
  let kit: CodexKit;
  let root: string;
  beforeAll(async () => {
    kit = await createCodexKit();
    root = kit.project.rootDir;
  });
  afterAll(async () => {
    await kit.close();
  });

  const inProject = (name: string): string => path.join(root, name);

  it('puts a command to a person, and runs it once it is allowed', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const sent = await kit.send(owner, session.id, '[[scenario:run-command touch allowed.txt]]');
    const [approval] = await kit.pending(session.id);
    expect(approval).toMatchObject({
      kind: 'tool',
      status: 'pending',
      toolName: 'shell',
      toolKind: 'execute',
      // The command as a person means it, not the `/bin/bash -lc '…'` Codex wraps it in.
      title: 'touch allowed.txt',
      command: 'touch allowed.txt',
      risk: 'medium',
      requiresOwner: false,
      suggestedRule: { tool: 'shell', pattern: 'touch *' },
      runId: sent.body.runId,
    });
    expect(approval!.input).toMatchObject({
      command: 'touch allowed.txt',
      cwd: root,
      reason: 'The stand-in wants to run this outside its sandbox.',
    });
    // Nothing has happened yet.
    expect(existsSync(inProject('allowed.txt'))).toBe(false);

    expect((await kit.decide(approval!.id, { decision: 'allow' })).status).toBe(200);
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(existsSync(inProject('allowed.txt'))).toBe(true);

    const events = await kit.events(owner, session.id);
    expect(events.map((event) => event.type)).toEqual([
      'message.user',
      'run.started',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.finished',
      'message.assistant',
      'usage.reported',
      'run.finished',
    ]);
    const started = eventsOf(events, 'tool.started')[0]!.data;
    expect(started).toMatchObject({
      name: 'shell',
      kind: 'execute',
      title: 'touch allowed.txt',
      input: { command: 'touch allowed.txt', cwd: root },
    });
    // The approval belongs to that very tool call.
    expect(approval!.toolCallId).toBe(started.toolCallId);
    expect(eventsOf(events, 'tool.finished')[0]!.data).toMatchObject({
      toolCallId: started.toolCallId,
      status: 'ok',
    });
    expect(assistantTexts(events)).toEqual(['The command finished. Process exited with code 0.']);
  });

  it('does not run a command that is refused, and tells Codex why', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const sent = await kit.send(
      owner,
      session.id,
      '[[scenario:run-command touch refused.txt]] [[scenario:recall]]',
    );
    const [approval] = await kit.pending(session.id);
    await kit.decide(approval!.id, { decision: 'deny', note: 'Not in this folder, please.' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    expect(existsSync(inProject('refused.txt'))).toBe(false);

    const events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'tool.finished')[0]!.data).toMatchObject({
      status: 'denied',
      output: 'Not in this folder, please.',
    });
    const texts = assistantTexts(events);
    expect(texts[0]).toBe('The command was not allowed, so I did not run it.');
    // Codex itself tells its model only "rejected by user"; the person's reason reached the turn as a message.
    expect(texts[1]).toContain(
      'user: [Cloud Harness] The command `touch refused.txt` was not allowed. Not in this folder, please.',
    );
  });

  it('remembers "always allow" as a rule of the Studio, not of Codex', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const first = await kit.send(
      owner,
      session.id,
      '[[scenario:run-command touch remembered-1.txt]]',
    );
    const [approval] = await kit.pending(session.id);
    const answer = await kit.decide(approval!.id, { decision: 'allow', remember: 'session' });
    expect(answer.body.rule).toMatchObject({
      scope: 'session',
      effect: 'allow',
      tool: 'shell',
      pattern: 'touch *',
    });
    await kit.runEnded(owner, first.body.runId!);

    // The same kind of command again: Codex asks again (it was told nothing to remember), the engine answers by the rule.
    const second = await kit.turn(
      owner,
      session.id,
      '[[scenario:run-command touch remembered-2.txt]]',
    );
    expect(second.status).toBe('completed');
    expect(existsSync(inProject('remembered-2.txt'))).toBe(true);
    const events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'approval.requested')).toHaveLength(1);
    expect(
      (
        await owner.get<{ rules: PermissionRule[] }>(
          `/api/permission-rules?scope=session&sessionId=${session.id}`,
        )
      ).body.rules,
    ).toHaveLength(1);
    // Nothing was written into Codex's own rules.
    expect(existsSync(path.join(kit.codexHome, 'rules'))).toBe(false);

    // A different command is still asked about.
    const third = await kit.send(owner, session.id, '[[scenario:run-command mkdir made-dir]]');
    const [other] = await kit.pending(session.id);
    expect(other!.command).toBe('mkdir made-dir');
    await kit.decide(other!.id, { decision: 'deny' });
    await kit.runEnded(owner, third.body.runId!);
    expect(existsSync(inProject('made-dir'))).toBe(false);
  });

  it('shows a file change as a diff, and writes the file only when it is allowed', async () => {
    const { owner } = kit;
    await writeFile(inProject('notes.md'), 'old text\n');
    const session = await kit.codexSession();
    const sent = await kit.send(
      owner,
      session.id,
      '[[scenario:file-change notes.md new text]] [[scenario:file-change brand-new.md hello]]',
    );

    const [edit] = await kit.pending(session.id);
    expect(edit).toMatchObject({
      toolName: 'apply_patch',
      toolKind: 'edit',
      title: 'Edit notes.md',
      paths: [inProject('notes.md')],
      suggestedRule: expect.anything(),
    });
    expect(edit!.diff).toBe(
      '--- a/notes.md\n+++ b/notes.md\n@@ -1,1 +1,1 @@\n-old text\n+new text\n',
    );
    await kit.decide(edit!.id, { decision: 'allow' });

    const [create] = await until(async () => {
      const waiting = (await kit.state(owner, session.id)).pendingApprovals;
      return waiting.length === 1 && waiting[0]!.id !== edit!.id ? waiting : null;
    });
    expect(create).toMatchObject({
      title: 'Create brand-new.md',
      paths: [inProject('brand-new.md')],
    });
    expect(create!.diff).toBe('--- /dev/null\n+++ b/brand-new.md\n@@ -0,0 +1,1 @@\n+hello\n');
    await kit.decide(create!.id, { decision: 'deny', note: 'No new files.' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');

    expect(await readFile(inProject('notes.md'), 'utf8')).toBe('new text\n');
    expect(existsSync(inProject('brand-new.md'))).toBe(false);

    const events = await kit.events(owner, session.id);
    const tools = eventsOf(events, 'tool.started').map((event) => event.data);
    expect(tools.map((tool) => [tool.name, tool.kind, tool.title])).toEqual([
      ['apply_patch', 'edit', 'Edit notes.md'],
      ['apply_patch', 'edit', 'Create brand-new.md'],
    ]);
    const finished = eventsOf(events, 'tool.finished').map((event) => event.data);
    expect(finished[0]).toMatchObject({
      status: 'ok',
      diffs: [
        {
          path: 'notes.md',
          added: 1,
          removed: 1,
          patch: '--- a/notes.md\n+++ b/notes.md\n@@ -1,1 +1,1 @@\n-old text\n+new text\n',
        },
      ],
    });
    expect(finished[1]).toMatchObject({
      status: 'denied',
      output: 'No new files.',
      diffs: [{ path: 'brand-new.md', added: 1, removed: 0 }],
    });
  });

  it('in accept-edits mode lets an edit inside the project through, and still asks about a command', async () => {
    const { owner } = kit;
    const session = await kit.codexSession({ permissionMode: 'accept-edits' });
    const sent = await kit.send(
      owner,
      session.id,
      '[[scenario:file-change accepted.md fine]] [[scenario:run-command touch asked-anyway.txt]]',
    );
    const [approval] = await kit.pending(session.id);
    // By the time the command is asked about, the edit has gone through unasked.
    expect(approval!.command).toBe('touch asked-anyway.txt');
    expect(await readFile(inProject('accepted.md'), 'utf8')).toBe('fine\n');
    await kit.decide(approval!.id, { decision: 'deny' });
    await kit.runEnded(owner, sent.body.runId!);
    expect(eventsOf(await kit.events(owner, session.id), 'approval.requested')).toHaveLength(1);
    expect(existsSync(inProject('asked-anyway.txt'))).toBe(false);
  });

  it('in plan mode only reads: commands and edits are refused without anybody being asked', async () => {
    const { owner } = kit;
    const session = await kit.codexSession({ permissionMode: 'plan' });
    const run = await kit.turn(
      owner,
      session.id,
      '[[scenario:read-command ls]] [[scenario:run-command touch planned.txt]] [[scenario:file-change planned.md nope]] [[scenario:read-command touch sneaky.txt]] [[scenario:recall]]',
    );
    expect(run.status).toBe('completed');
    for (const name of ['planned.txt', 'planned.md', 'sneaky.txt'])
      expect(existsSync(inProject(name))).toBe(false);

    const events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'approval.requested')).toHaveLength(0);
    const finished = eventsOf(events, 'tool.finished').map((event) => event.data);
    // The read ran inside Codex's read-only sandbox; the other two were refused by the mode.
    expect(finished.map((tool) => tool.status)).toEqual(['ok', 'denied', 'denied']);
    expect(finished[1]!.output).toMatch(/Plan mode only reads/);
    const texts = assistantTexts(events);
    expect(texts.slice(0, 4)).toEqual([
      'I ran it. Process exited with code 0.',
      'The command was not allowed, so I did not run it.',
      'The change was not allowed, so the file is untouched.',
      'The sandbox did not let that command run.',
    ]);
    // The reason was given to the agent once, not once per refusal.
    expect(texts[4]!.match(/\[Cloud Harness\]/g)).toHaveLength(1);
  });

  it('in auto mode runs what it is asked without a person — except what the Studio never allows', async () => {
    const { owner, project } = kit;
    expect(
      (await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true })).status,
    ).toBe(200);
    try {
      const session = await kit.codexSession({ permissionMode: 'auto' });
      const run = await kit.turn(
        owner,
        session.id,
        `[[scenario:run-command touch automatic.txt]] [[scenario:run-command cat ${kit.t.dataDir}/studio.db]]`,
      );
      expect(run.status).toBe('completed');
      expect(existsSync(inProject('automatic.txt'))).toBe(true);
      const events = await kit.events(owner, session.id);
      expect(eventsOf(events, 'approval.requested')).toHaveLength(0);
      expect(eventsOf(events, 'tool.finished').map((event) => event.data.status)).toEqual([
        'ok',
        'denied',
      ]);
    } finally {
      await owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: false });
    }
  });

  it('refuses instead of waiting when nobody is watching', async () => {
    const { owner } = kit;
    const agents = kit.t.studio.context.services.agents;
    const session = await kit.codexSession();
    const receipt = await agents.sendMessage(
      agents.principalFor(owner.userId!)!,
      session.id,
      {
        requestId: nextRequestId(),
        text: '[[scenario:run-command touch nightly.txt]] [[scenario:file-change nightly.md x]]',
      },
      { origin: 'scheduled' },
    );
    const run = await kit.runEnded(owner, receipt.runId!);
    expect(run).toMatchObject({ status: 'completed', unattended: true });
    expect(existsSync(inProject('nightly.txt'))).toBe(false);
    expect(existsSync(inProject('nightly.md'))).toBe(false);
    const events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'approval.requested')).toHaveLength(0);
    expect(eventsOf(events, 'tool.finished').map((event) => event.data.status)).toEqual([
      'denied',
      'denied',
    ]);
  });

  it('cancels a waiting approval when the run is stopped, and nothing runs', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const sent = await kit.send(owner, session.id, '[[scenario:run-command touch never.txt]]');
    const [approval] = await kit.pending(session.id);
    await owner.post<{ run: Run }>(`/api/sessions/${session.id}/stop`);
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('stopped');
    expect((await owner.get<Approval>(`/api/approvals/${approval!.id}`)).body.status).toBe(
      'cancelled',
    );
    expect(existsSync(inProject('never.txt'))).toBe(false);
    expect(eventsOf(await kit.events(owner, session.id), 'run.finished')).toHaveLength(1);
  });

  it("calls the Studio's own tools through the bridge, as a real MCP client", async () => {
    const { owner } = kit;
    // The bridge is a separate process: it needs a port to call back on.
    await kit.listen();
    const session = await kit.codexSession();
    const run = await kit.turn(
      owner,
      session.id,
      '[[scenario:studio-tool memory_search {"query":"deploy checklist"}]] [[scenario:studio-tool permission_prompt {"tool_name":"x","input":{}}]]',
    );
    expect(run.status).toBe('completed');
    const events = await kit.events(owner, session.id);
    const tools = eventsOf(events, 'tool.started').map((event) => event.data);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'mcp__studio__memory_search',
      kind: 'other',
      title: 'memory_search',
      input: { query: 'deploy checklist' },
    });
    expect(eventsOf(events, 'tool.finished')[0]!.data).toMatchObject({
      toolCallId: tools[0]!.toolCallId,
      status: 'ok',
    });
    // Codex did not ask about the Studio's own tool: the Studio's engine is asked when the bridge calls back.
    expect(eventsOf(events, 'approval.requested')).toHaveLength(0);
    const texts = assistantTexts(events);
    expect(texts[0]).toMatch(/^The Studio tool memory_search answered: /);
    // The tool that answers Claude Code's permission prompts is not offered to Codex.
    expect(texts[1]).toBe(
      'The Studio tool permission_prompt answered: the tool permission_prompt is not offered by studio',
    );
  });

  it('records a Studio tool the user refuses as denied, on the tool call its approval was for', async () => {
    const { owner } = kit;
    await kit.listen();
    const session = await kit.codexSession();
    const sent = await kit.send(
      owner,
      session.id,
      '[[scenario:studio-tool memory_write {"title":"Refused","content":"not wanted","scope":"project"}]]',
    );
    const [approval] = await kit.pending(session.id);
    expect(approval).toMatchObject({ kind: 'tool', toolName: 'memory_write' });
    await kit.decide(approval!.id, { decision: 'deny', note: 'not this time' });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');
    const events = await kit.events(owner, session.id);
    const started = eventsOf(events, 'tool.started').map((event) => event.data);
    expect(started).toEqual([expect.objectContaining({ name: 'mcp__studio__memory_write' })]);
    // Codex says nothing about which call a bridge request belongs to: the Studio ties them together itself.
    expect(approval!.toolCallId).toBe(started[0]!.toolCallId);
    // To Codex the refusal is a failed tool call; the transcript records what it was.
    expect(eventsOf(events, 'tool.finished').map((event) => event.data)).toEqual([
      expect.objectContaining({
        toolCallId: started[0]!.toolCallId,
        status: 'denied',
        output: 'not this time',
      }),
    ]);
  });

  it("asks the Studio about another MCP server's tool, grants no wider sandbox, and passes Codex's questions on", async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const sent = await kit.send(
      owner,
      session.id,
      '[[scenario:mcp-elicit tracker close_issue]] [[scenario:permissions]] [[scenario:ask-user]]',
    );

    const [tool] = await kit.pending(session.id);
    expect(tool).toMatchObject({
      kind: 'tool',
      toolName: 'mcp__tracker__close_issue',
      toolKind: 'other',
      title: 'Allow the tracker MCP server to run tool "close_issue"?',
      input: { target: 'x' },
    });
    await kit.decide(tool!.id, { decision: 'deny', note: 'Leave the tracker alone.' });

    const [question] = await until(async () => {
      const waiting = (await kit.state(owner, session.id)).pendingApprovals;
      return waiting.length === 1 && waiting[0]!.kind === 'question' ? waiting : null;
    });
    expect(question!.questions).toEqual([
      {
        id: 'database',
        header: 'Database',
        question: 'Which database should I use?',
        options: [
          { label: 'SQLite (Recommended)', description: 'Simple and local.', recommended: true },
          { label: 'Postgres', description: 'A server.' },
        ],
        multiSelect: false,
      },
    ]);
    await kit.decide(question!.id, {
      decision: 'allow',
      answers: [{ questionId: 'database', selected: ['Postgres'] }],
    });
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('completed');

    const events = await kit.events(owner, session.id);
    expect(assistantTexts(events)).toEqual([
      'The tool close_issue was not allowed.',
      'No wider permissions were granted.',
      'You chose: Postgres.',
    ]);
    expect(eventsOf(events, 'tool.finished')[0]!.data).toMatchObject({
      status: 'denied',
      output: 'Leave the tracker alone.',
    });
  });
});
